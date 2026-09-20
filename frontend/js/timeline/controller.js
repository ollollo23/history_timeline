/**
 * Контроллер интерактивного взаимодействия с временной осью таймлайна.
 * Связывает чистую модель состояния (viewport.js), графический конвейер (renderer.js),
 * хранилище событий (eventStore.js) и подсистему обработки пользовательского ввода
 * (Pointer Events, Wheel, Keyboard, ResizeObserver)[cite: 16].
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Изоляция ответственности: контроллер не выполняет самостоятельных геометрических вычислений,
 *    делегируя трансформации чистым функциям panViewport, zoomViewport, resizeViewport[cite: 16].
 * 2. Двухконтурная модель данных: состояние виртуальной камеры синхронно управляет
 *    отрисовкой координатной сетки, а хранилище событий асинхронно буферизирует маркеры
 *    с подавлением сетевого дребезга и защитой от гонки ответов[cite: 16].
 * 3. Оптимизация сборщика мусора (GC Pressure): слепок состояния хранилища кэшируется
 *    в замыкании (lastStoreState), предотвращая повторное клонирование массива событий
 *    на каждый пиксель перемещения при панорамировании.
 * 4. Картографическая конвенция зума: прокрутка от себя (deltaY < 0) приближает масштаб,
 *    снижая secondsPerPixel за счет отрицательного приращения индекса zoomIndex[cite: 16].
 * 5. Безопасное управление памятью: в методе destroy строго соблюдается порядок очистки
 *    (хранилище -> ссылка кэша -> рендерер -> слушатели ввода -> наблюдатель размеров)[cite: 16].
 */

import { ZOOM_STEP_PER_WHEEL_NOTCH } from './constants.js';
import {
    getDefaultViewportState,
    panViewport,
    resizeViewport,
    zoomViewport,
} from './viewport.js';
import { createTimelineRenderer } from './renderer.js';
import { createEventStore } from './eventStore.js';
import { fetchEventsInRange } from '../services/api.js';
import { getActiveLadderLevel } from './ticks.js';
import { getRanksForUnit } from './rankMapping.js';

/**
 * Вычисление дискретного приращения логарифмического индекса масштаба по направлению прокрутки колеса мыши.
 * Реализует стандартную конвенцию: прокрутка вверх / от себя (deltaY < 0) приближает (уменьшает zoomIndex и spp),
 * прокрутка вниз / на себя (deltaY > 0) отдаляет (увеличивает zoomIndex и spp)[cite: 16].
 *
 * @param {number} deltaY Вертикальное смещение прокрутки колеса мыши.
 * @returns {number} Приращение логарифмического индекса масштаба (-ZOOM_STEP, 0 или +ZOOM_STEP)[cite: 16].
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
 * и обрабатывает жесты сведения пальцев на тачпаде (Pinch-to-zoom)[cite: 16].
 *
 * @param {WheelEvent} event Событие колеса мыши.
 * @returns {number} Нормализованное значение смещения в диапазоне [-100, 100][cite: 16].
 */
export function normalizeWheelDelta(event) {
    let deltaY = event.deltaY;

    // Режим строк (DOM_DELTA_LINE = 1, типично для Mozilla Firefox)[cite: 16]
    if (event.deltaMode === 1) {
        deltaY *= 33.33;
    }
    // Режим страниц (DOM_DELTA_PAGE = 2)[cite: 16]
    else if (event.deltaMode === 2) {
        deltaY *= 800;
    }

    // Распознавание трекпадного pinch-to-zoom (в Chromium/Safari маскируется под wheel с зажатым ctrlKey)[cite: 16]
    if (event.ctrlKey) {
        deltaY *= 2.5;
    }

    // Ограничение максимального всплеска дельты за единичный тик события[cite: 16]
    return Math.max(-100, Math.min(100, deltaY));
}

/**
 * Фабрика создания контроллера интерактивной оси таймлайна.
 *
 * @param {HTMLCanvasElement} canvasElement DOM-элемент холста Canvas.
 * @param {HTMLElement} containerElement Родительский контейнер для отслеживания габаритов.
 * @param {((viewportState: Object, storeState: Object) => void)|null} [onStateChange=null]
 *        Колбэк уведомления об изменении состояния камеры и сетевого хранилища[cite: 16].
 * @param {{
 *   fetchFn?: Function,
 *   categories?: string[],
 *   storeOptions?: Object
 * }} [options={}] Дополнительные параметры инициализации сетевого контура[cite: 16].
 * @returns {{
 *   getState: () => Object,
 *   getStoreState: () => Object,
 *   getStore: () => Object,
 *   setState: (newState: Object) => void,
 *   pan: (deltaPx: number) => void,
 *   zoom: (anchorX: number, delta: number) => void,
 *   reset: () => void,
 *   destroy: () => void,
 *   unmount: () => void
 * }} Публичный интерфейс управления таймлайном[cite: 16].
 */
export function createTimelineController(
    canvasElement,
    containerElement,
    onStateChange = null,
    options = {}
) {
    // 1. Инициализация геометрии и начального состояния виртуальной камеры[cite: 16]
    const initialWidth = containerElement.clientWidth || 1000;
    const initialHeight = containerElement.clientHeight || 320;
    let state = getDefaultViewportState(initialWidth, initialHeight);

    // 2. Инициализация изолированного рендерера Canvas 2D[cite: 16]
    const renderer = createTimelineRenderer(canvasElement);

    // 3. Подготовка конфигурации и адаптеров сетевого хранилища событий[cite: 16]
    const categories = Array.isArray(options.categories) ? options.categories : [];
    const fetchFn = options.fetchFn || fetchEventsInRange;
    const storeOptions = options.storeOptions || {};

    // Кэшированный снимок состояния хранилища для предотвращения повторного клонирования массива событий при панорамировании
    let lastStoreState = null;

    /**
     * Обработчик асинхронного обновления данных в хранилище событий.
     * Сохраняет полученный слепок в замыкании, передает события в рендерер,
     * запрашивает перерисовку и уведомляет внешнего подписчика[cite: 16].
     *
     * @param {Object} storeState Актуальный слепок состояния хранилища[cite: 16].
     */
    function handleStoreChange(storeState) {
        lastStoreState = storeState;
        renderer.setEvents(storeState.events);
        renderer.requestRender(state);
        if (typeof onStateChange === 'function') {
            onStateChange(state, storeState);
        }
    }

    // Инициализация экземпляра хранилища событий[cite: 16]
    const store = createEventStore(fetchFn, handleStoreChange, storeOptions);

    // Первичное сохранение слепка состояния хранилища после инициализации
    lastStoreState = store.getState();

    /**
     * Вычисляет активный уровень лестницы сетки, определяет набор запрашиваемых рангов
     * и передает задачу загрузки данных в хранилище[cite: 16].
     */
    function requestEventsForCurrentState() {
        const activeLevel = getActiveLadderLevel(state);
        const activeRanks = getRanksForUnit(activeLevel.unit);
        store.requestWindow(state, activeRanks, categories);
    }

    // Первичная отрисовка координатной сетки и запрос событий для начального экрана[cite: 16]
    renderer.requestRender(state);
    requestEventsForCurrentState();

    // 4. Структуры данных для отслеживания мультитач-жестов[cite: 16]
    const activePointers = new Map();
    let initialPinchDistance = null;
    let initialPinchZoomIndex = null;

    /**
     * Централизованное обновление состояния камеры с перерисовкой и запросом данных.
     * Использует закэшированный слепок lastStoreState без вызова store.getState(),
     * устраняя выделение памяти под копию массива на каждый кадр движения[cite: 16].
     *
     * @param {Object} newState Новый замороженный слепок состояния ViewportState[cite: 16].
     */
    function updateState(newState) {
        if (state !== newState) {
            state = newState;
            renderer.requestRender(state);
            requestEventsForCurrentState();
            if (typeof onStateChange === 'function') {
                onStateChange(state, lastStoreState);
            }
        }
    }

    // ==========================================================================
    // ОБРАБОТЧИКИ СОБЫТИЙ МЫШИ, ТРЕКПАДА И ЖЕСТОВ
    // ==========================================================================

    /**
     * Обработка масштабирования колесом мыши относительно курсора.
     * Использует функцию computeWheelZoomDelta для соблюдения конвенции направления зума[cite: 16].
     *
     * @param {WheelEvent} e
     */
    function handleWheel(e) {
        // Гарантированная отмена вертикальной прокрутки страницы[cite: 16]
        e.preventDefault();

        // Вычисление приращения логарифмического индекса зума[cite: 16]
        const zoomDelta = computeWheelZoomDelta(e.deltaY);
        if (zoomDelta === 0) {
            return;
        }

        // Вычисление экранной координаты курсора относительно левой границы холста[cite: 16]
        const rect = canvasElement.getBoundingClientRect();
        const anchorX = e.clientX - rect.left;

        // Применение масштабирования с сохранением точки под курсором[cite: 16]
        updateState(zoomViewport(state, anchorX, zoomDelta));
    }

    /**
     * Начало взаимодействия указателем (мышь, стилус, сенсорный палец)[cite: 16].
     *
     * @param {PointerEvent} e
     */
    function handlePointerDown(e) {
        // Захват указателя для непрерывного отслеживания перемещения за пределами холста[cite: 16]
        try {
            canvasElement.setPointerCapture(e.pointerId);
        } catch {
            // Защита от редких сбоев браузера при мгновенной отмене касания[cite: 16]
        }

        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Одиночный указатель: переключение курсора в режим активного захвата[cite: 16]
        if (activePointers.size === 1) {
            canvasElement.style.cursor = 'grabbing';
        }
        // Появление второго указателя: сброс параметров для нового pinch-to-zoom жеста[cite: 16]
        else if (activePointers.size === 2) {
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        }
    }

    /**
     * Перемещение указателя (панорамирование или мультитач-зум)[cite: 16].
     *
     * @param {PointerEvent} e
     */
    function handlePointerMove(e) {
        if (!activePointers.has(e.pointerId)) {
            return;
        }

        // Сценарий 1: Одиночный указатель — линейное панорамирование[cite: 16]
        if (activePointers.size === 1) {
            const prev = activePointers.get(e.pointerId);
            const deltaX = e.clientX - prev.x;

            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (deltaX !== 0) {
                updateState(panViewport(state, deltaX));
            }
        }
        // Сценарий 2: Два указателя — масштабирование двумя пальцами (Pinch-to-zoom)[cite: 16]
        else if (activePointers.size === 2) {
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            const [p1, p2] = Array.from(activePointers.values());
            const currentDistance = Math.hypot(p1.x - p2.x, p1.y - p2.y);

            const rect = canvasElement.getBoundingClientRect();
            const midX = (p1.x + p2.x) / 2 - rect.left;

            // Фиксация опорного расстояния при старте жеста сведения пальцев[cite: 16]
            if (initialPinchDistance === null || initialPinchDistance === 0) {
                initialPinchDistance = currentDistance;
                initialPinchZoomIndex = state.zoomIndex;
            } else if (currentDistance > 0) {
                // Расчет приращения зума из логарифмического отношения дистанций[cite: 16]
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
     * Завершение взаимодействия указателем (отпускание клавиши мыши или пальца)[cite: 16].
     *
     * @param {PointerEvent} e
     */
    function handlePointerUp(e) {
        activePointers.delete(e.pointerId);

        try {
            canvasElement.releasePointerCapture(e.pointerId);
        } catch {
            // Безопасный перехват при автоматическом освобождении захвата браузером[cite: 16]
        }

        if (activePointers.size === 0) {
            canvasElement.style.cursor = 'grab';
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        } else if (activePointers.size === 1) {
            // Сброс параметров пинча при переходе обратно к режиму панорамирования одним пальцем[cite: 16]
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        }
    }

    /**
     * Аварийная отмена события указателя (потеря фокуса, системное прерывание)[cite: 16].
     *
     * @param {PointerEvent} e
     */
    function handlePointerCancel(e) {
        handlePointerUp(e);
    }

    /**
     * Клавиатурная навигация и стандарты доступности (WCAG)[cite: 16].
     *
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
        // Обработка клавиш только при активном фокусе на холсте[cite: 16]
        if (document.activeElement !== canvasElement) {
            return;
        }

        switch (e.key) {
            case 'ArrowLeft':
                // Сдвиг вправо (в прошлое) на 10% ширины видимой области[cite: 16]
                e.preventDefault();
                updateState(panViewport(state, state.widthPx * 0.1));
                break;

            case 'ArrowRight':
                // Сдвиг влево (в будущее) на 10% ширины видимой области[cite: 16]
                e.preventDefault();
                updateState(panViewport(state, -state.widthPx * 0.1));
                break;

            case '+':
            case '=':
                // Приближение относительно центра экрана (уменьшение zoomIndex снижает secondsPerPixel)[cite: 16]
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
                // Отдаление относительно центра экрана (увеличение zoomIndex увеличивает secondsPerPixel)[cite: 16]
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
                // Возврат к стандартному обзору эпохи по умолчанию[cite: 16]
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

    // Настройка доступности (Accessibility) холста[cite: 16]
    canvasElement.tabIndex = 0;
    canvasElement.setAttribute('role', 'region');
    canvasElement.setAttribute(
        'aria-label',
        'Интерактивная шкала времени. Используйте стрелки влево и вправо для навигации, ' +
            'клавиши плюс и минус для масштабирования, клавишу Home для сброса.'
    );
    canvasElement.style.outline = 'none';
    canvasElement.style.cursor = 'grab';

    // Регистрация слушателя колеса с отключением пассивного режима (passive: false)[cite: 16]
    canvasElement.addEventListener('wheel', handleWheel, { passive: false });

    // Регистрация событий унифицированного указателя Pointer Events[cite: 16]
    canvasElement.addEventListener('pointerdown', handlePointerDown);
    canvasElement.addEventListener('pointermove', handlePointerMove);
    canvasElement.addEventListener('pointerup', handlePointerUp);
    canvasElement.addEventListener('pointercancel', handlePointerCancel);

    // Регистрация слушателя клавиатуры[cite: 16]
    canvasElement.addEventListener('keydown', handleKeyDown);

    // Отслеживание адаптивного изменения геометрических размеров контейнера[cite: 16]
    const resizeObserver = new ResizeObserver((entries) => {
        if (!entries || entries.length === 0) {
            return;
        }

        const entry = entries[0];
        const newWidth = Math.round(entry.contentRect.width) || containerElement.clientWidth;
        const newHeight = Math.round(entry.contentRect.height) || containerElement.clientHeight;

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
     * Полная остановка контроллера, снятие слушателей и освобождение памяти[cite: 16].
     */
    function destroy() {
        // 1. Остановка хранилища событий (отмена таймеров debounce и прерывание сетевых запросов)[cite: 16]
        store.destroy();

        // 2. Обнуление кэшированной ссылки на состояние хранилища для исключения утечек памяти
        lastStoreState = null;

        // 3. Уничтожение подсистемы рендеринга и освобождение буфера[cite: 16]
        renderer.destroy();

        // 4. Снятие слушателей ввода[cite: 16]
        canvasElement.removeEventListener('wheel', handleWheel);
        canvasElement.removeEventListener('pointerdown', handlePointerDown);
        canvasElement.removeEventListener('pointermove', handlePointerMove);
        canvasElement.removeEventListener('pointerup', handlePointerUp);
        canvasElement.removeEventListener('pointercancel', handlePointerCancel);
        canvasElement.removeEventListener('keydown', handleKeyDown);

        // 5. Остановка наблюдателя размеров[cite: 16]
        resizeObserver.disconnect();

        // 6. Очистка активных указателей[cite: 16]
        activePointers.clear();
    }

    return {
        /**
         * Получение текущего замороженного состояния ViewportState[cite: 16].
         * @returns {Object}
         */
        getState: () => state,

        /**
         * Получение актуального слепка состояния хранилища событий.
         * @returns {Object}
         */
        getStoreState: () => lastStoreState || store.getState(),

        /**
         * Получение прямого доступа к экземпляру хранилища событий[cite: 16].
         * @returns {Object}
         */
        getStore: () => store,

        /**
         * Программное обновление состояния[cite: 16].
         * @param {Object} newState
         */
        setState: updateState,

        /**
         * Программное панорамирование на заданное количество пикселей[cite: 16].
         * @param {number} deltaPx
         */
        pan: (deltaPx) => updateState(panViewport(state, deltaPx)),

        /**
         * Программное масштабирование относительно точки привязки[cite: 16].
         * @param {number} anchorX
         * @param {number} delta
         */
        zoom: (anchorX, delta) => updateState(zoomViewport(state, anchorX, delta)),

        /**
         * Сброс масштаба и положения к состоянию по умолчанию[cite: 16].
         */
        reset: () => updateState(getDefaultViewportState(state.widthPx, state.heightPx)),

        /**
         * Уничтожение контроллера (совместимо с контрактом unmount роутера)[cite: 16].
         */
        destroy,
        unmount: destroy,
    };
}
