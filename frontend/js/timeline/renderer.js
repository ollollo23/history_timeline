/**
 * Изолированный графический рендерер временной оси на HTML5 Canvas 2D.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистый слой представления: рендерер не владеет состоянием, не слушает события
 *    пользовательского ввода и получает готовый слепок viewportState[cite: 17].
 * 2. Послойный конвейер отрисовки (Z-Index order):
 *    Фон -> Горизонтальная ось -> Деления сетки и подписи дат ->
 *    -> Маркеры исторических событий -> Маркер текущего времени («Сейчас»)[cite: 17].
 * 3. Адаптивность к HiDPI / Retina: физический размер буфера масштабируется
 *    на window.devicePixelRatio с компенсацией трансформации контекста[cite: 17].
 * 4. Субпиксельная резкость: однопиксельные линии сетки и оси смещаются на 0.5px,
 *    исключая размытие границ растеризатором Canvas[cite: 17].
 * 5. Кэширование стилей темы: палитра вычисляется при инициализации и смене темы,
 *    исключая синхронные reflow-пересчеты внутри анимационного цикла[cite: 17].
 * 6. Оптимизация растеризации маркеров: маркеры группируются по цвету категории
 *    с установкой fillStyle один раз на группу и ограничением экранных координат
 *    интервалов буфером MARKER_RENDER_BOUND_BUFFER_PX.
 * 7. Разрешение коллизий подписей: горизонтальные габариты меток контролируются
 *    через MIN_MAJOR_LABEL_GAP_PX, предотвращая наложение текста дат[cite: 17].
 * 8. Безопасное управление памятью: метод destroy освобождает графический контекст,
 *    отменяет кадры анимации и очищает массив событий[cite: 17].
 */

import { MIN_MAJOR_LABEL_GAP_PX } from './constants.js';
import {
    timestampToScreenX,
    zoomIndexToSecondsPerPixel,
} from './scale.js';
import { generateTicks } from './ticks.js';
import { formatTickLabel } from './format.js';
import { prepareEventMarkers } from './markers.js';

/** Радиус заполненного круга точечного маркера события в пикселях[cite: 17] */
const MARKER_POINT_RADIUS = 4;

/** Высота прямоугольной полосы интервального события в пикселях[cite: 17] */
const MARKER_BAR_HEIGHT = 8;

/** Вертикальное смещение базовой линии полосы маркеров вверх от горизонтальной оси[cite: 17] */
const MARKER_OFFSET_FROM_AXIS = 28;

/**
 * Пиксельный буфер отсечения экранных координат интервальных полос.
 * Предотвращает передачу сверхшироких координат в растеризатор Canvas при масштабировании.
 */
export const MARKER_RENDER_BOUND_BUFFER_PX = 50;

/**
 * Динамическое извлечение цветовой палитры темы оформления из вычисленных стилей элемента[cite: 17].
 *
 * @param {HTMLCanvasElement} canvasElement Элемент холста Canvas[cite: 17].
 * @returns {Record<string, string>} Объект разрешенных цветов темы и категорий[cite: 17].
 */
export function resolveThemePalette(canvasElement) {
    const computed = window.getComputedStyle(canvasElement);

    const getVar = (name, fallback) => {
        const val = computed.getPropertyValue(name);
        return val && val.trim() ? val.trim() : fallback;
    };

    return {
        bgPrimary: getVar('--bg-primary', '#121214'),
        bgSecondary: getVar('--bg-secondary', '#1a1a1e'),
        textPrimary: getVar('--text-primary', '#f4f4f5'),
        textSecondary: getVar('--text-secondary', '#a1a1aa'),
        colorAccent: getVar('--color-accent', '#3b82f6'),
        borderColor: getVar('--border-color', '#2e2e33'),
        '--color-category-culture': getVar('--color-category-culture', '#a855f7'),
        '--color-category-politics': getVar('--color-category-politics', '#ef4444'),
        '--color-category-economy': getVar('--color-category-economy', '#eab308'),
        '--color-category-science': getVar('--color-category-science', '#06b6d4'),
        '--color-category-other': getVar('--color-category-other', '#64748b'),
    };
}

/**
 * Фабрика создания изолированного графического рендерера таймлайна[cite: 17].
 *
 * @param {HTMLCanvasElement} canvasElement Элемент Canvas для отрисовки[cite: 17].
 * @returns {{
 *   render: (viewportState: Object) => void,
 *   requestRender: (viewportState: Object) => void,
 *   setEvents: (events: Array<Object>) => void,
 *   updateThemePalette: () => void,
 *   destroy: () => void
 * }} Интерфейс управления рендерером[cite: 17].
 */
export function createTimelineRenderer(canvasElement) {
    let ctx = canvasElement.getContext('2d');
    let animationFrameId = null;
    let pendingState = null;
    let currentDpr = 1;
    let lastRenderedWidth = 0;
    let lastRenderedHeight = 0;

    // Массив загруженных исторических событий, сохраняемый в замыкании для отрисовки[cite: 17]
    let currentEvents = [];

    // Первичное кэширование палитры темы для предотвращения синхронного reflow на каждом кадре[cite: 17]
    let palette = resolveThemePalette(canvasElement);

    /**
     * Конфигурация физического и логического разрешения холста с учетом Retina/HiDPI[cite: 17].
     *
     * @param {number} widthPx Логическая ширина холста[cite: 17].
     * @param {number} heightPx Логическая высота холста[cite: 17].
     */
    function setupCanvasResolution(widthPx, heightPx) {
        if (!canvasElement || !ctx) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        currentDpr = dpr;
        lastRenderedWidth = widthPx;
        lastRenderedHeight = heightPx;

        // Физический размер растрового буфера[cite: 17]
        canvasElement.width = Math.floor(widthPx * dpr);
        canvasElement.height = Math.floor(heightPx * dpr);

        // Логический размер отображения в CSS-пикселях[cite: 17]
        canvasElement.style.width = `${widthPx}px`;
        canvasElement.style.height = `${heightPx}px`;

        // Сброс матрицы трансформации и масштабирование под плотность пикселей экрана[cite: 17]
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Непосредственное выполнение команд послойной отрисовки кадра по переданному состоянию[cite: 17].
     *
     * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} viewportState
     */
    function renderImmediate(viewportState) {
        if (!ctx || !canvasElement) {
            return;
        }

        const { widthPx, heightPx, originTimestamp, zoomIndex } = viewportState;

        if (widthPx <= 0 || heightPx <= 0) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;

        // Обновление физических размеров буфера при изменении геометрии или плотности экрана[cite: 17]
        if (
            widthPx !== lastRenderedWidth ||
            heightPx !== lastRenderedHeight ||
            dpr !== currentDpr
        ) {
            setupCanvasResolution(widthPx, heightPx);
        }

        // 1. Очистка рабочей области цветом основного фона темы из кэшированной палитры[cite: 17]
        ctx.fillStyle = palette.bgPrimary;
        ctx.fillRect(0, 0, widthPx, heightPx);

        // 2. Расчет базовой горизонтальной линии оси (65% высоты холста)[cite: 17]
        const axisY = Math.floor(heightPx * 0.65);

        // 3. Отрисовка основной горизонтальной оси[cite: 17]
        ctx.beginPath();
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.moveTo(0, axisY + 0.5);
        ctx.lineTo(widthPx, axisY + 0.5);
        ctx.stroke();

        // 4. Генерация делений сетки на основе текущего масштаба и границ[cite: 17]
        const ticks = generateTicks(viewportState);

        // Настройка типографики для подписей делений[cite: 17]
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Правая граница последней успешно отрисованной крупной текстовой подписи[cite: 17]
        let lastMajorLabelRight = -Infinity;

        // 5. Отрисовка вертикальных делений сетки и текстовых подписей с контролем коллизий[cite: 17]
        for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i];
            const x = Math.floor(tick.screenX) + 0.5;

            // Пропуск отметок, выходящих за экранные пределы видимости[cite: 17]
            if (x < -50 || x > widthPx + 50) {
                continue;
            }

            if (tick.isMajor) {
                // Крупное деление: штрих 16px вверх от оси отрисовывается безусловно[cite: 17]
                ctx.save();
                ctx.beginPath();
                ctx.strokeStyle = palette.borderColor;
                ctx.lineWidth = 1;
                ctx.moveTo(x, axisY - 16);
                ctx.lineTo(x, axisY);
                ctx.stroke();

                // Формирование текстовой подписи с передачей физического шага деления[cite: 17]
                const label = formatTickLabel(tick.timestamp, tick.unit, tick.step);
                const textWidth = ctx.measureText(label).width;

                // Расчет левой границы центрированного текста подписи[cite: 17]
                const labelLeft = x - textWidth / 2;

                // Проверка условия отсутствия коллизии с учетом минимального экранного зазора[cite: 17]
                if (labelLeft >= lastMajorLabelRight + MIN_MAJOR_LABEL_GAP_PX) {
                    ctx.fillStyle = palette.textSecondary;
                    ctx.globalAlpha = tick.opacity;
                    ctx.fillText(label, x, axisY + 6);

                    // Фиксация правой границы для следующей подписи[cite: 17]
                    lastMajorLabelRight = x + textWidth / 2;
                }

                ctx.restore();
            } else {
                // Мелкое деление: штрих 8px вверх от оси с учетом прозрачности перехода[cite: 17]
                ctx.save();
                ctx.beginPath();
                ctx.strokeStyle = palette.borderColor;
                ctx.lineWidth = 1;
                ctx.globalAlpha = tick.opacity;
                ctx.moveTo(x, axisY - 8);
                ctx.lineTo(x, axisY);
                ctx.stroke();
                ctx.restore();
            }
        }

        // 6. Отрисовка маркеров исторических событий (поверх сетки делений)[cite: 17]
        if (currentEvents.length > 0) {
            const spp = zoomIndexToSecondsPerPixel(zoomIndex);
            const markers = prepareEventMarkers(currentEvents, originTimestamp, spp, widthPx);
            const markerY = axisY - MARKER_OFFSET_FROM_AXIS;

            if (markers.length > 0) {
                // Группировка маркеров по переменной темы оформления для минимизации переключений контекста
                const markerGroups = new Map();
                for (let i = 0; i < markers.length; i++) {
                    const marker = markers[i];
                    let group = markerGroups.get(marker.themeVariable);
                    if (!group) {
                        group = [];
                        markerGroups.set(marker.themeVariable, group);
                    }
                    group.push(marker);
                }

                // Единое сохранение состояния графического контекста для всей фазы отрисовки маркеров
                ctx.save();

                // Примечание: порядок наложения перекрывающихся маркеров становится цветовым,
                // а не строго хронологическим; вертикальное стекирование и разрешение
                // пространственных коллизий относятся к шагу 3 дорожной карты.
                for (const [themeVariable, groupMarkers] of markerGroups.entries()) {
                    // Разрешение цвета категории один раз для всей группы
                    const markerColor =
                        palette[themeVariable] ||
                        palette['--color-category-other'] ||
                        palette.colorAccent;

                    ctx.fillStyle = markerColor;

                    for (let j = 0; j < groupMarkers.length; j++) {
                        const marker = groupMarkers[j];

                        if (marker.isPoint) {
                            // Точечное событие или вырожденный интервал: заполненный круг
                            ctx.beginPath();
                            ctx.arc(marker.screenX, markerY, MARKER_POINT_RADIUS, 0, Math.PI * 2);
                            ctx.fill();
                        } else {
                            // Интервальное событие: отсечение экранных границ полосы для разгрузки растеризатора
                            const left = Math.max(marker.screenX, -MARKER_RENDER_BOUND_BUFFER_PX);
                            const right = Math.min(
                                marker.screenX + marker.widthPx,
                                widthPx + MARKER_RENDER_BOUND_BUFFER_PX
                            );
                            const clampedWidth = right - left;

                            // Пропуск отрисовки полосы с нулевой или отрицательной протяженностью
                            if (clampedWidth > 0) {
                                const barY = markerY - MARKER_BAR_HEIGHT / 2;
                                ctx.fillRect(left, barY, clampedWidth, MARKER_BAR_HEIGHT);
                            }
                        }
                    }
                }

                // Восстановление исходного состояния графического контекста
                ctx.restore();
            }
        }

        // 7. Отрисовка маркера текущего момента времени («Сейчас») поверх всех слоев[cite: 17]
        const nowTs = Math.floor(Date.now() / 1000);
        const spp = zoomIndexToSecondsPerPixel(zoomIndex);
        const nowX = timestampToScreenX(nowTs, originTimestamp, spp);

        if (nowX >= -20 && nowX <= widthPx + 20) {
            const markerX = Math.floor(nowX) + 0.5;

            ctx.save();

            // Вертикальная акцентная линия текущего времени[cite: 17]
            ctx.beginPath();
            ctx.strokeStyle = palette.colorAccent;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.8;
            ctx.moveTo(markerX, 0);
            ctx.lineTo(markerX, heightPx);
            ctx.stroke();

            // Информационный бейдж «Сейчас» в верхней части холста[cite: 17]
            const badgeText = 'Сейчас';
            const badgeWidth = 44;
            const badgeHeight = 16;
            const badgeX = Math.floor(nowX - badgeWidth / 2);
            const badgeY = 4;

            ctx.globalAlpha = 0.9;
            ctx.fillStyle = palette.colorAccent;
            ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);

            ctx.globalAlpha = 1.0;
            ctx.fillStyle = palette.textPrimary;
            ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(badgeText, nowX, badgeY + badgeHeight / 2);

            ctx.restore();
        }
    }

    /**
     * Обновляет локальный массив исторических событий для отрисовки[cite: 17].
     * Не вызывает немедленного рендеринга; обновление кадра инициируется через render или requestRender[cite: 17].
     *
     * @param {Array<Object>} events Массив загруженных доменных объектов событий[cite: 17].
     */
    function setEvents(events) {
        currentEvents = Array.isArray(events) ? events : [];
    }

    return {
        /**
         * Запрос асинхронной перерисовки в следующем кадре анимации[cite: 17].
         * Выполняет батчинг частых вызовов в пределах одного кадра requestAnimationFrame[cite: 17].
         *
         * @param {Object} viewportState Слепок состояния области просмотра[cite: 17].
         */
        requestRender(viewportState) {
            pendingState = viewportState;

            if (animationFrameId !== null) {
                return;
            }

            animationFrameId = requestAnimationFrame(() => {
                animationFrameId = null;
                if (pendingState) {
                    renderImmediate(pendingState);
                }
            });
        },

        /**
         * Немедленная синхронная перерисовка холста с отменой отложенного кадра[cite: 17].
         *
         * @param {Object} viewportState Слепок состояния области просмотра[cite: 17].
         */
        render(viewportState) {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            renderImmediate(viewportState);
        },

        /**
         * Установка массива событий для последующей отрисовки[cite: 17].
         */
        setEvents,

        /**
         * Принудительное обновление кэшированной цветовой палитры темы оформления
         * (вызывается при динамическом переключении тем оформления приложения)[cite: 17].
         */
        updateThemePalette() {
            if (canvasElement) {
                palette = resolveThemePalette(canvasElement);
            }
        },

        /**
         * Полная утилизация рендерера и освобождение системных ресурсов[cite: 17].
         */
        destroy() {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            currentEvents = [];
            canvasElement = null;
            ctx = null;
            pendingState = null;
        },
    };
}
