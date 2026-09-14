/**
 * Контроллер интерактивного взаимодействия с временной осью таймлайна.
 * Связывает чистую модель состояния (viewport.js), графический конвейер (renderer.js)
 * и подсистему обработки пользовательского ввода (Pointer Events, Wheel, Keyboard, ResizeObserver).
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Изоляция ответственности: контроллер не выполняет самостоятельных геометрических вычислений,
 *    делегируя трансформации чистым функциям panViewport, zoomViewport, resizeViewport.
 * 2. Картографическая конвенция зума: прокрутка от себя (deltaY < 0) приближает масштаб,
 *    снижая secondsPerPixel за счет отрицательного приращения индекса zoomIndex.
 * 3. Унификация жестов: сенсорный ввод, стилус и мышь обрабатываются через Pointer Events
 *    с захватом указателя (setPointerCapture) для непрерывного удержания за пределами холста.
 * 4. Управление памятью: методы destroy и unmount гарантированно снимают все слушатели событий,
 *    отключают ResizeObserver и освобождают графические ресурсы подсистемы рендеринга.
 */

import { ZOOM_STEP_PER_WHEEL_NOTCH } from './constants.js';
import {
    getDefaultViewportState,
    panViewport,
    resizeViewport,
    zoomViewport,
} from './viewport.js';
import { createTimelineRenderer } from './renderer.js';

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
 * @param {((state: Object) => void)|null} [onStateChange=null] Колбэк уведомления об изменении состояния.
 * @returns {{
 *   getState: () => Object,
 *   setState: (newState: Object) => void,
 *   pan: (deltaPx: number) => void,
 *   zoom: (anchorX: number, delta: number) => void,
 *   reset: () => void,
 *   destroy: () => void,
 *   unmount: () => void
 * }} Публичный интерфейс управления таймлайном.
 */
export function createTimelineController(canvasElement, containerElement, onStateChange = null) {
    // 1. Инициализация геометрии и начального состояния виртуальной камеры
    const initialWidth = containerElement.clientWidth || 1000;
    const initialHeight = containerElement.clientHeight || 320;
    let state = getDefaultViewportState(initialWidth, initialHeight);

    // 2. Инициализация изолированного рендерера Canvas 2D
    const renderer = createTimelineRenderer(canvasElement);
    renderer.requestRender(state);

    // 3. Структуры данных для отслеживания мультитач-жестов
    const activePointers = new Map();
    let initialPinchDistance = null;
    let initialPinchZoomIndex = null;

    /**
     * Централизованное обновление состояния с запросом перерисовки кадра.
     *
     * @param {Object} newState Новый замороженный слепок состояния ViewportState.
     */
    function updateState(newState) {
        if (state !== newState) {
            state = newState;
            renderer.requestRender(state);
            if (typeof onStateChange === 'function') {
                onStateChange(state);
            }
        }
    }

    // ==========================================================================
    // ОБРАБОТЧИКИ СОБЫТИЙ МЫШИ, ТРЕКПАДА И ЖЕСТОВ
    // ==========================================================================

    /**
     * Обработка масштабирования колесом мыши относительно курсора.
     * Использует функцию computeWheelZoomDelta для соблюдения конвенции направления зума.
     *
     * @param {WheelEvent} e
     */
    function handleWheel(e) {
        // Гарантированная отмена вертикальной прокрутки страницы
        e.preventDefault();

        // Вычисление приращения логарифмического индекса зума
        const zoomDelta = computeWheelZoomDelta(e.deltaY);
        if (zoomDelta === 0) {
            return;
        }

        // Вычисление экранной координаты курсора относительно левой границы холста
        const rect = canvasElement.getBoundingClientRect();
        const anchorX = e.clientX - rect.left;

        // Применение масштабирования с сохранением точки под курсором
        updateState(zoomViewport(state, anchorX, zoomDelta));
    }

    /**
     * Начало взаимодействия указателем (мышь, стилус, сенсорный палец).
     *
     * @param {PointerEvent} e
     */
    function handlePointerDown(e) {
        // Захват указателя для непрерывного отслеживания перемещения за пределами холста
        try {
            canvasElement.setPointerCapture(e.pointerId);
        } catch {
            // Защита от редких сбоев браузера при мгновенной отмене касания
        }

        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // Одиночный указатель: переключение курсора в режим активного захвата
        if (activePointers.size === 1) {
            canvasElement.style.cursor = 'grabbing';
        }
        // Появление второго указателя: сброс параметров для нового pinch-to-zoom жеста
        else if (activePointers.size === 2) {
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

            // Фиксация опорного расстояния при старте жеста сведения пальцев
            if (initialPinchDistance === null || initialPinchDistance === 0) {
                initialPinchDistance = currentDistance;
                initialPinchZoomIndex = state.zoomIndex;
            } else if (currentDistance > 0) {
                // Расчет приращения зума из логарифмического отношения дистанций
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
            canvasElement.style.cursor = 'grab';
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        } else if (activePointers.size === 1) {
            // Сброс параметров пинча при переходе обратно к режиму панорамирования одним пальцем
            initialPinchDistance = null;
            initialPinchZoomIndex = null;
        }
    }

    /**
     * Аварийная отмена события указателя (потеря фокуса, системное прерывание).
     *
     * @param {PointerEvent} e
     */
    function handlePointerCancel(e) {
        handlePointerUp(e);
    }

    /**
     * Клавиатурная навигация и стандарты доступности (WCAG).
     *
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
        // Обработка клавиш только при активном фокусе на холсте
        if (document.activeElement !== canvasElement) {
            return;
        }

        switch (e.key) {
            case 'ArrowLeft':
                // Сдвиг вправо (в прошлое) на 10% ширины видимой области
                e.preventDefault();
                updateState(panViewport(state, state.widthPx * 0.1));
                break;

            case 'ArrowRight':
                // Сдвиг влево (в будущее) на 10% ширины видимой области
                e.preventDefault();
                updateState(panViewport(state, -state.widthPx * 0.1));
                break;

            case '+':
            case '=':
                // Приближение относительно центра экрана (уменьшение zoomIndex снижает secondsPerPixel)
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
                // Отдаление относительно центра экрана (увеличение zoomIndex увеличивает secondsPerPixel)
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
                // Возврат к стандартному обзору эпохи по умолчанию
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

    // Настройка доступности (Accessibility) холста
    canvasElement.tabIndex = 0;
    canvasElement.setAttribute('role', 'region');
    canvasElement.setAttribute(
        'aria-label',
        'Интерактивная шкала времени. Используйте стрелки влево и вправо для навигации, ' +
            'клавиши плюс и минус для масштабирования, клавишу Home для сброса.'
    );
    canvasElement.style.outline = 'none';
    canvasElement.style.cursor = 'grab';

    // Регистрация слушателя колеса с отключением пассивного режима (passive: false)
    canvasElement.addEventListener('wheel', handleWheel, { passive: false });

    // Регистрация событий унифицированного указателя Pointer Events
    canvasElement.addEventListener('pointerdown', handlePointerDown);
    canvasElement.addEventListener('pointermove', handlePointerMove);
    canvasElement.addEventListener('pointerup', handlePointerUp);
    canvasElement.addEventListener('pointercancel', handlePointerCancel);

    // Регистрация слушателя клавиатуры
    canvasElement.addEventListener('keydown', handleKeyDown);

    // Отслеживание адаптивного изменения геометрических размеров контейнера
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
     * Полная остановка контроллера, снятие слушателей и освобождение памяти.
     */
    function destroy() {
        // Снятие слушателей ввода
        canvasElement.removeEventListener('wheel', handleWheel);
        canvasElement.removeEventListener('pointerdown', handlePointerDown);
        canvasElement.removeEventListener('pointermove', handlePointerMove);
        canvasElement.removeEventListener('pointerup', handlePointerUp);
        canvasElement.removeEventListener('pointercancel', handlePointerCancel);
        canvasElement.removeEventListener('keydown', handleKeyDown);

        // Остановка наблюдателя размеров
        resizeObserver.disconnect();

        // Очистка активных указателей
        activePointers.clear();

        // Уничтожение подсистемы рендеринга
        renderer.destroy();
    }

    return {
        /**
         * Получение текущего замороженного состояния ViewportState.
         * @returns {Object}
         */
        getState: () => state,

        /**
         * Программное обновление состояния.
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
