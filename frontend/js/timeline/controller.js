/**
 * Контроллер интерактивного взаимодействия с временной осью таймлайна.
 * Связывает чистую модель состояния камеры (viewport.js), графический конвейер (renderer.js),
 * хранилище событий (eventStore.js), хранилище выбора (selection.js), расчет раскладки (layout.js),
 * геометрический хит-тест (hitTest.js), фокусировку камеры (focus.js) и обработку пользовательского ввода.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Изоляция ответственности: контроллер не выполняет самостоятельных геометрических вычислений,
 *    делегируя трансформации чистым функциям panViewport, zoomViewport, resizeViewport.
 * 2. Централизованный расчет раскладки: структура дорожек вычисляется один раз при изменении
 *    камеры или данных и сохраняется в currentLayout для совместного использования рендерером и хит-тестом.
 * 3. Разделение клика и перетаскивания: замер смещения указателя с порогом 5 пикселей предотвращает
 *    случайное открытие боковой панели детализации при панорамировании холста.
 * 4. Двухконтурное уведомление: внешний подписчик onStateChange получает согласованный слепок
 *    из трех компонентов: состояние камеры, состояние хранилища событий и состояние выбора.
 * 5. Безопасное управление памятью: в методе destroy строго соблюдается регламентированный порядок
 *    утилизации хранилищ, очистки ссылок, остановки рендерера и снятия слушателей событий.
 */

import {
    HIT_TEST_TOLERANCE_PX,
    MIN_EVENT_BAR_WIDTH_PX,
    TIMELINE_CANVAS_HEIGHT_PX,
    ZOOM_STEP_PER_WHEEL_NOTCH,
} from './constants.js';
import {
    getDefaultViewportState,
    panViewport,
    resizeViewport,
    zoomViewport,
} from './viewport.js';
import { zoomIndexToSecondsPerPixel } from './scale.js';
import { createTimelineRenderer } from './renderer.js';
import { createEventStore } from './eventStore.js';
import {
    fetchEventsInRange,
    fetchEventById,
    fetchEventChildren,
} from '../services/api.js';
import { getActiveLadderLevel } from './ticks.js';
import { getRanksForUnit } from './rankMapping.js';
import { prepareEventMarkers } from './markers.js';
import { computeTimelineLayout } from './layout.js';
import { resolveCursorTarget } from './hitTest.js';
import { createSelectionStore } from './selection.js';
import { computeFocusViewport } from './focus.js';

/**
 * Вычисление дискретного приращения логарифмического индекса масштаба по направлению прокрутки колеса мыши.
 * Реализует стандартную конвенцию: прокрутка вверх / от себя (deltaY < 0) приближает (уменьшает zoomIndex и spp),
 * прокрутка вниз / на себя (deltaY > 0) отдаляет (увеличивает zoomIndex и spp).
 *
 * @param {number} deltaY Вертикальное смещение прокрутки колеса мыши.
 * @returns {number} Приращение логарифмического индекса масштаба (-ZOOM_STEP, 0 или +ZOOM_STEP).
 */
export function computeWheelZoomDelta(deltaY) {
    if (!deltaY || deltaY === 0) {
        return 0;
    }
    return Math.sign(deltaY) * ZOOM_STEP_PER_WHEEL_NOTCH;
}

/**
 * Нормализация дельты события прокрутки колеса мыши и трекпада.
 * Приводит различные режимы дельты (пиксели, строки, страницы) к единой шкале
 * и обрабатывает жесты сведения пальцев на тачпаде (Pinch-to-zoom).
 *
 * @param {WheelEvent} event Событие колеса мыши.
 * @returns {number} Нормализованное значение смещения в диапазоне [-100, 100].
 */
export function normalizeWheelDelta(event) {
    let deltaY = event.deltaY;

    // Режим строк (DOM_DELTA_LINE = 1, типично для Mozilla Firefox)
    if (event.deltaMode === 1) {
        deltaY *= 33.33;
    }
    // Режим страниц (DOM_DELTA_PAGE = 2)
    else if (event.deltaMode === 2) {
        deltaY *= 800;
    }

    // Распознавание трекпадного pinch-to-zoom (в Chromium/Safari маскируется под wheel с зажатым ctrlKey)
    if (event.ctrlKey) {
        deltaY *= 2.5;
    }

    // Ограничение максимального всплеска дельты за единичный тик события
    return Math.max(-100, Math.min(100, deltaY));
}

/**
 * Фабрика создания контроллера интерактивной оси таймлайна.
 *
 * @param {HTMLCanvasElement} canvasElement DOM-элемент холста Canvas.
 * @param {HTMLElement} containerElement Родительский контейнер для отслеживания габаритов.
 * @param {((viewportState: Object, storeState: Object, selectionState: Object) => void)|null} [onStateChange=null]
 *        Колбэк уведомления об изменении состояния камеры, сетевого хранилища и выбора.
 * @param {{
 *   fetchFn?: Function,
 *   fetchEventByIdFn?: Function,
 *   fetchChildrenFn?: Function,
 *   categories?: string[],
 *   storeOptions?: Object,
 *   selectionOptions?: Object,
 *   hitTolerance?: number
 * }} [options={}] Дополнительные параметры инициализации контроллера.
 * @returns {{
 *   getState: () => Object,
 *   getStoreState: () => Object,
 *   getStore: () => Object,
 *   getSelectionStore: () => Object,
 *   getSelectionState: () => Object,
 *   getLayout: () => Object | null,
 *   selectEvent: (id: number) => Promise<void>,
 *   clearSelection: () => void,
 *   focusEvent: (event: Object) => void,
 *   setState: (newState: Object) => void,
 *   pan: (deltaPx: number) => void,
 *   zoom: (anchorX: number, delta: number) => void,
 *   reset: () => void,
 *   destroy: () => void,
 *   unmount: () => void
 * }} Публичный интерфейс управления таймлайном.
 */
export function createTimelineController(
    canvasElement,
    containerElement,
    onStateChange = null,
    options = {}
) {
    // 1. Инициализация геометрии и начального состояния виртуальной камеры
    const initialWidth = containerElement.clientWidth || 1000;
    const initialHeight = containerElement.clientHeight || TIMELINE_CANVAS_HEIGHT_PX;
    let state = getDefaultViewportState(initialWidth, initialHeight);

    // 2. Инициализация изолированного рендерера Canvas 2D
    const renderer = createTimelineRenderer(canvasElement);

    // 3. Подготовка конфигурации и адаптеров сетевого хранилища событий
    const categories = Array.isArray(options.categories) ? options.categories : [];
    const fetchFn = options.fetchFn || fetchEventsInRange;
    const storeOptions = options.storeOptions || {};

    const fetchEventByIdFn = options.fetchEventByIdFn || fetchEventById;
    const fetchChildrenFn = options.fetchChildrenFn || fetchEventChildren;
    const hitTolerance = options.hitTolerance ?? HIT_TEST_TOLERANCE_PX;

    // Кэшированные слепки состояния хранилищ и раскладки
    let lastStoreState = null;
    let lastSelectionState = null;
    let currentLayout = null;

    // Переменные для фильтрации жестов перетаскивания и кликов
    let pointerDownPos = null;
    let isDragGesture = false;

    // Кэширование состояния CSS-курсора для предотвращения избыточных reflow-записей в DOM
    let currentCursor = 'grab';

    /**
     * Оптимизированная установка формы курсора манипулятора.
     *
     * @param {string} cursorStyle Желаемый стиль курсора.
     */
    function setCursor(cursorStyle) {
        if (currentCursor !== cursorStyle) {
            currentCursor = cursorStyle;
            if (canvasElement) {
                canvasElement.style.cursor = cursorStyle;
            }
        }
    }

    /**
     * Централизованный пересчет вертикальной раскладки дорожек.
     * Проецирует маркеры событий и вычисляет координаты с сохранением закрепления дорожек.
     */
    function updateCurrentLayout() {
        const spp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const events =
            lastStoreState && Array.isArray(lastStoreState.events)
                ? lastStoreState.events
                : [];
        const markers = prepareEventMarkers(
            events,
            state.originTimestamp,
            spp,
            state.widthPx,
            { minBarWidth: MIN_EVENT_BAR_WIDTH_PX }
        );
        const previousLaneAssignments = currentLayout?.laneAssignments || null;
        currentLayout = computeTimelineLayout(
            markers,
            state.widthPx,
            state.heightPx,
            { previousLaneAssignments }
        );
    }

    /**
     * Обработчик реактивного изменения состояния выбора исторического события.
     *
     * @param {Object} selectionState Актуальный слепок состояния SelectionState.
     */
    function handleSelectionChange(selectionState) {
        lastSelectionState = selectionState;
        renderer.setSelection(selectionState.selectedId);
        renderer.requestRender(state, currentLayout);
        if (typeof onStateChange === 'function') {
            onStateChange(state, lastStoreState, lastSelectionState);
        }
    }

    // Инициализация хранилища выбора события
    const selectionStore = createSelectionStore(
        fetchEventByIdFn,
        fetchChildrenFn,
        handleSelectionChange,
        options.selectionOptions || {}
    );
    lastSelectionState = selectionStore.getState();

    /**
     * Обработчик асинхронного обновления данных в хранилище событий.
     *
     * @param {Object} storeState Актуальный слепок состояния хранилища.
     */
    function handleStoreChange(storeState) {
        lastStoreState = storeState;
        updateCurrentLayout();
        renderer.requestRender(state, currentLayout);
        if (typeof onStateChange === 'function') {
            onStateChange(state, lastStoreState, lastSelectionState);
        }
    }

    // Инициализация экземпляра хранилища событий
    const store = createEventStore(fetchFn, handleStoreChange, storeOptions);
    lastStoreState = store.getState();

    /**
     * Вычисляет активный уровень лестницы сетки, определяет набор запрашиваемых рангов
     * и передает задачу загрузки данных в хранилище.
     */
    function requestEventsForCurrentState() {
        const activeLevel = getActiveLadderLevel(state);
        const activeRanks = getRanksForUnit(activeLevel.unit);
        store.requestWindow(state, activeRanks, categories);
    }

    // Первичный расчет раскладки, отрисовка координатной сетки и запрос событий
    updateCurrentLayout();
    renderer.requestRender(state, currentLayout);
    requestEventsForCurrentState();

    // 4. Структуры данных для отслеживания мультитач-жестов
    const activePointers = new Map();
    let initialPinchDistance = null;
    let initialPinchZoomIndex = null;

    /**
     * Централизованное обновление состояния камеры с перерисовкой и запросом данных.
     *
     * @param {Object} newState Новый замороженный слепок состояния ViewportState.
     */
    function updateState(newState) {
        if (state !== newState) {
            state = newState;
            updateCurrentLayout();
            renderer.requestRender(state, currentLayout);
            requestEventsForCurrentState();
            if (typeof onStateChange === 'function') {
                onStateChange(state, lastStoreState, lastSelectionState);
            }
        }
    }

    /**
     * Фокусировка виртуальной камеры на историческом событии с подбором оптимального масштаба.
     *
     * @param {Object} event Доменный объект исторического события.
     */
    function focusEvent(event) {
        if (
            !event ||
            typeof event !== 'object' ||
            typeof event.start_date !== 'number' ||
            !Number.isFinite(event.start_date)
        ) {
            return;
        }

        const nextState = computeFocusViewport(state, event);
        updateState(nextState);

        if (event.id !== undefined && event.id !== null) {
            selectionStore.select(event.id);
        }
    }

    // ==========================================================================
    // ОБРАБОТЧИКИ СОБЫТИЙ МЫШИ, ТРЕКПАДА И ЖЕСТОВ
    // ==========================================================================

    /**
     * Обработка масштабирования колесом мыши относительно курсора.
     *
     * @param {WheelEvent} e
     */
    function handleWheel(e) {
        e.preventDefault();

        const zoomDelta = computeWheelZoomDelta(e.deltaY);
        if (zoomDelta === 0) {
            return;
        }

        const rect = canvasElement.getBoundingClientRect();
        const anchorX = e.clientX - rect.left;

        updateState(zoomViewport(state, anchorX, zoomDelta));
    }

    /**
     * Начало взаимодействия указателем (мышь, стилус, сенсорный палец).
     *
     * @param {PointerEvent} e
     */
    function handlePointerDown(e) {
        try {
            canvasElement.setPointerCapture(e.pointerId);
        } catch {
            // Защита от редких сбоев браузера при мгновенной отмене касания
        }

        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Сохранение начальной точки нажатия для детекции жеста перетаскивания
        if (activePointers.size === 1) {
            pointerDownPos = { x: e.clientX, y: e.clientY };
            isDragGesture = false;
            setCursor('grabbing');
        } else if (activePointers.size === 2) {
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        }
    }

    /**
     * Перемещение указателя (панорамирование или мультитач-зум).
     *
     * @param {PointerEvent} e
     */
    function handlePointerMove(e) {
        if (!activePointers.has(e.pointerId)) {
            return;
        }

        // Проверка превышения порога перемещения для разделения клика и сдвига
        if (pointerDownPos) {
            const dragDistance = Math.hypot(
                e.clientX - pointerDownPos.x,
                e.clientY - pointerDownPos.y
            );
            if (dragDistance > 5) {
                isDragGesture = true;
            }
        }

        // Сценарий 1: Одиночный указатель — линейное панорамирование
        if (activePointers.size === 1) {
            const prev = activePointers.get(e.pointerId);
            const deltaX = e.clientX - prev.x;

            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (deltaX !== 0) {
                updateState(panViewport(state, deltaX));
            }
        }
        // Сценарий 2: Два указателя — масштабирование двумя пальцами (Pinch-to-zoom)
        else if (activePointers.size === 2) {
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            const [p1, p2] = Array.from(activePointers.values());
            const currentDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);

            const rect = canvasElement.getBoundingClientRect();
            const midX = (p1.x + p2.x) / 2 - rect.left;

            if (initialPinchDistance === null || initialPinchDistance === 0) {
                initialPinchDistance = currentDistance;
                initialPinchZoomIndex = state.zoomIndex;
            } else if (currentDistance > 0) {
                const zoomDelta = Math.log2(currentDistance / initialPinchDistance);
                const targetZoom = initialPinchZoomIndex + zoomDelta;
                const deltaToApply = targetZoom - state.zoomIndex;

                if (deltaToApply !== 0) {
                    updateState(zoomViewport(state, midX, deltaToApply));
                }
            }
        }
    }

    /**
     * Завершение взаимодействия указателем (отпускание клавиши мыши или пальца).
     *
     * @param {PointerEvent} e
     */
    function handlePointerUp(e) {
        activePointers.delete(e.pointerId);

        try {
            canvasElement.releasePointerCapture(e.pointerId);
        } catch {
            // Безопасный перехват при автоматическом освобождении захвата браузером
        }

        if (activePointers.size === 0) {
            setCursor('grab');
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        } else if (activePointers.size === 1) {
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        }
    }

    /**
     * Аварийная отмена события указателя.
     *
     * @param {PointerEvent} e
     */
    function handlePointerCancel(e) {
        isDragGesture = false;
        pointerDownPos = null;
        handlePointerUp(e);
    }

    /**
     * Обработка клика по холсту с определением цели под курсором.
     *
     * @param {MouseEvent} e
     */
    function handleClick(e) {
        // Если указатель сместился более чем на 5px, клик не обрабатывается
        if (isDragGesture) {
            isDragGesture = false;
            pointerDownPos = null;
            return;
        }
        pointerDownPos = null;

        const rect = canvasElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (!currentLayout) {
            updateCurrentLayout();
        }

        const target = resolveCursorTarget(currentLayout, x, y, hitTolerance);

        if (target) {
            if (target.type === 'aggregate') {
                // Клик по бейджу агрегата: выбор родителя для просмотра списка потомков
                selectionStore.select(target.parentId);
            } else if (target.type === 'overflow') {
                // Клик по маркеру переполнения: плавное приближение к области скрытых событий
                updateState(
                    zoomViewport(
                        state,
                        target.screenX,
                        -ZOOM_STEP_PER_WHEEL_NOTCH * 2
                    )
                );
            } else if (target.event && target.event.id !== undefined) {
                // Клик по маркеру события: открытие карточки детализации
                selectionStore.select(target.event.id);
            }
        } else {
            // Клик в пустое пространство: сброс активного выбора
            selectionStore.clear();
        }
    }

    /**
     * Обработка перемещения курсора без зажатых кнопок для динамической смены указателя.
     *
     * @param {PointerEvent} e
     */
    function handlePointerHover(e) {
        if (activePointers.size > 0) {
            return;
        }

        const rect = canvasElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (!currentLayout) {
            updateCurrentLayout();
        }

        const target = resolveCursorTarget(currentLayout, x, y, hitTolerance);

        setCursor(target ? 'pointer' : 'grab');
    }

    /**
     * Клавиатурная навигация и стандарты доступности (WCAG).
     *
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
        if (document.activeElement !== canvasElement) {
            return;
        }

        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                updateState(panViewport(state, state.widthPx * 0.1));
                break;

            case 'ArrowRight':
                e.preventDefault();
                updateState(panViewport(state, -state.widthPx * 0.1));
                break;

            case '+':
            case '=':
                e.preventDefault();
                updateState(
                    zoomViewport(
                        state,
                        state.widthPx / 2,
                        -ZOOM_STEP_PER_WHEEL_NOTCH
                    )
                );
                break;

            case '-':
            case '_':
                e.preventDefault();
                updateState(
                    zoomViewport(
                        state,
                        state.widthPx / 2,
                        ZOOM_STEP_PER_WHEEL_NOTCH
                    )
                );
                break;

            case 'Home':
                e.preventDefault();
                updateState(getDefaultViewportState(state.widthPx, state.heightPx));
                break;

            default:
                break;
        }
    }

    // ==========================================================================
    // ИНИЦИАЛИЗАЦИЯ И РЕГИСТРАЦИЯ СЛУШАТЕЛЕЙ
    // ==========================================================================

    canvasElement.tabIndex = 0;
    canvasElement.setAttribute('role', 'region');
    canvasElement.setAttribute(
        'aria-label',
        'Интерактивная шкала времени. Используйте стрелки влево и вправо для навигации, ' +
            'клавиши плюс и минус для масштабирования, клавишу Home для сброса.'
    );
    canvasElement.style.outline = 'none';
    setCursor('grab');

    // Регистрация слушателей колеса и клавиатуры
    canvasElement.addEventListener('wheel', handleWheel, { passive: false });
    canvasElement.addEventListener('keydown', handleKeyDown);

    // Регистрация слушателей указателя
    canvasElement.addEventListener('pointerdown', handlePointerDown);
    canvasElement.addEventListener('pointermove', handlePointerMove);
    canvasElement.addEventListener('pointerup', handlePointerUp);
    canvasElement.addEventListener('pointercancel', handlePointerCancel);

    // Регистрация интерактивных слушателей клика и наведения
    canvasElement.addEventListener('click', handleClick);
    canvasElement.addEventListener('pointermove', handlePointerHover);

    // Отслеживание адаптивного изменения геометрических размеров контейнера
    const resizeObserver = new ResizeObserver((entries) => {
        if (!entries || entries.length === 0) {
            return;
        }

        const entry = entries[0];
        const newWidth = Math.round(entry.contentRect.width) || containerElement.clientWidth;
        const newHeight =
            Math.round(entry.contentRect.height) ||
            containerElement.clientHeight ||
            TIMELINE_CANVAS_HEIGHT_PX;

        if (
            newWidth > 0 &&
            newHeight > 0 &&
            (newWidth !== state.widthPx || newHeight !== state.heightPx)
        ) {
            updateState(resizeViewport(state, newWidth, newHeight));
        }
    });

    resizeObserver.observe(containerElement);

    // ==========================================================================
    // УТИЛИЗАЦИЯ И ОСВОБОЖДЕНИЕ РЕСУРСОВ (UNMOUNT)
    // ==========================================================================

    /**
     * Полная остановка контроллера, снятие слушателей и освобождение памяти.
     */
    function destroy() {
        // 1. Остановка хранилища событий
        store.destroy();

        // 2. Остановка хранилища выбора
        selectionStore.destroy();

        // 3. Обнуление кэшированных ссылок состояния
        lastStoreState = null;
        lastSelectionState = null;
        currentLayout = null;
        pointerDownPos = null;

        // 4. Уничтожение подсистемы рендеринга
        renderer.destroy();

        // 5. Снятие всех слушателей с DOM-элемента холста
        canvasElement.removeEventListener('wheel', handleWheel);
        canvasElement.removeEventListener('keydown', handleKeyDown);
        canvasElement.removeEventListener('pointerdown', handlePointerDown);
        canvasElement.removeEventListener('pointermove', handlePointerMove);
        canvasElement.removeEventListener('pointerup', handlePointerUp);
        canvasElement.removeEventListener('pointercancel', handlePointerCancel);
        canvasElement.removeEventListener('click', handleClick);
        canvasElement.removeEventListener('pointermove', handlePointerHover);

        // 6. Остановка наблюдателя размеров
        resizeObserver.disconnect();

        // 7. Очистка активных указателей
        activePointers.clear();
    }

    return {
        /**
         * Получение текущего замороженного состояния ViewportState.
         * @returns {Object}
         */
        getState: () => state,

        /**
         * Получение актуального слепка состояния хранилища событий.
         * @returns {Object}
         */
        getStoreState: () => lastStoreState || store.getState(),

        /**
         * Получение прямого доступа к экземпляру хранилища событий.
         * @returns {Object}
         */
        getStore: () => store,

        /**
         * Получение прямого доступа к хранилищу выбора.
         * @returns {Object}
         */
        getSelectionStore: () => selectionStore,

        /**
         * Получение актуального слепка состояния выбора.
         * @returns {Object}
         */
        getSelectionState: () => lastSelectionState || selectionStore.getState(),

        /**
         * Получение последнего рассчитанного слепка компоновки дорожек.
         * @returns {Object|null}
         */
        getLayout: () => currentLayout,

        /**
         * Программный выбор события по его идентификатору.
         * @param {number} id Идентификатор события.
         * @returns {Promise<void>}
         */
        selectEvent: (id) => selectionStore.select(id),

        /**
         * Программный сброс активного выбора.
         */
        clearSelection: () => selectionStore.clear(),

        /**
         * Программная фокусировка камеры на событии.
         * @param {Object} event Доменный объект события.
         */
        focusEvent,

        /**
         * Программное обновление состояния камеры.
         * @param {Object} newState
         */
        setState: updateState,

        /**
         * Программное панорамирование на заданное количество пикселей.
         * @param {number} deltaPx
         */
        pan: (deltaPx) => updateState(panViewport(state, deltaPx)),

        /**
         * Программное масштабирование относительно точки привязки.
         * @param {number} anchorX
         * @param {number} delta
         */
        zoom: (anchorX, delta) => updateState(zoomViewport(state, anchorX, delta)),

        /**
         * Сброс масштаба и положения к состоянию по умолчанию.
         */
        reset: () => updateState(getDefaultViewportState(state.widthPx, state.heightPx)),

        /**
         * Уничтожение контроллера (совместимо с контрактом unmount роутера).
         */
        destroy,
        unmount: destroy,
    };
}
