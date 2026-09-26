/**
 * Изолированный графический рендерер временной оси на HTML5 Canvas 2D.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистый слой представления: рендерер не владеет состоянием, не выполняет расчет
 *    компоновки и принимает готовые слепки viewportState и layout.
 * 2. Послойный конвейер отрисовки (Z-Index order):
 *    Фон -> Горизонтальная ось -> Деления сетки и подписи дат ->
 *    -> Многодорожечные маркеры исторических событий и бейджи -> Маркер текущего времени («Сейчас»).
 * 3. Двухпроходная отрисовка маркеров:
 *    Проход 1 — пакетная заливка геометрии маркеров по категориям и фоновых подложек бейджей;
 *    Проход 2 — отрисовка текстовых счетчиков, круговых обводок агрегатов и рамки выделения.
 * 4. Адаптивность к HiDPI / Retina: физический размер буфера масштабируется
 *    на window.devicePixelRatio с компенсацией трансформации контекста.
 * 5. Субпиксельная резкость: однопиксельные линии сетки и оси смещаются на 0.5px,
 *    исключая размытие границ растеризатором Canvas.
 * 6. Кэширование стилей темы: палитра вычисляется при инициализации и смене темы,
 *    исключая синхронные reflow-пересчеты внутри анимационного цикла.
 * 7. Безопасное управление памятью: метод destroy освобождает графический контекст,
 *    отменяет кадры анимации и очищает ссылки на отложенные состояния.
 */

import {
    AGGREGATE_BADGE_MAX_LABEL_COUNT,
    AGGREGATE_BADGE_RADIUS_PX,
    AXIS_POSITION_RATIO,
    MARKER_POINT_RADIUS,
    MIN_MAJOR_LABEL_GAP_PX,
    OVERFLOW_BADGE_WIDTH_PX,
    SELECTION_HIGHLIGHT_WIDTH_PX,
} from './constants.js';
import {
    timestampToScreenX,
    zoomIndexToSecondsPerPixel,
} from './scale.js';
import { generateTicks } from './ticks.js';
import { formatTickLabel } from './format.js';

/**
 * Пиксельный буфер отсечения экранных координат интервальных полос.
 * Предотвращает передачу сверхшироких координат в растеризатор Canvas при масштабировании.
 */
export const MARKER_RENDER_BOUND_BUFFER_PX = 50;

/**
 * Динамическое извлечение цветовой палитры темы оформления из вычисленных стилей элемента.
 *
 * @param {HTMLCanvasElement} canvasElement Элемент холста Canvas.
 * @returns {Record<string, string>} Объект разрешенных цветов темы и категорий.
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
 * Фабрика создания изолированного графического рендерера таймлайна.
 *
 * @param {HTMLCanvasElement} canvasElement Элемент Canvas для отрисовки.
 * @returns {{
 *   render: (viewportState: Object, layout?: Object | null) => void,
 *   requestRender: (viewportState: Object, layout?: Object | null) => void,
 *   setSelection: (eventId: number | null) => void,
 *   updateThemePalette: () => void,
 *   destroy: () => void
 * }} Интерфейс управления рендерером.
 */
export function createTimelineRenderer(canvasElement) {
    let ctx = canvasElement.getContext('2d');
    let animationFrameId = null;
    let pendingState = null;
    let pendingLayout = null;
    let currentDpr = 1;
    let lastRenderedWidth = 0;
    let lastRenderedHeight = 0;

    // Идентификатор выбранного исторического события для подсветки активного маркера
    let selectedEventId = null;

    // Первичное кэширование палитры темы для предотвращения синхронного reflow на каждом кадре
    let palette = resolveThemePalette(canvasElement);

    /**
     * Конфигурация физического и логического разрешения холста с учетом Retina/HiDPI.
     *
     * @param {number} widthPx Логическая ширина холста.
     * @param {number} heightPx Логическая высота холста.
     */
    function setupCanvasResolution(widthPx, heightPx) {
        if (!canvasElement || !ctx) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        currentDpr = dpr;
        lastRenderedWidth = widthPx;
        lastRenderedHeight = heightPx;

        // Физический размер растрового буфера
        canvasElement.width = Math.floor(widthPx * dpr);
        canvasElement.height = Math.floor(heightPx * dpr);

        // Логический размер отображения в CSS-пикселях
        canvasElement.style.width = `${widthPx}px`;
        canvasElement.style.height = `${heightPx}px`;

        // Сброс матрицы трансформации и масштабирование под плотность пикселей экрана
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Непосредственное выполнение команд послойной отрисовки кадра по переданному состоянию.
     *
     * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} viewportState
     * @param {Object|null} [layout=null] Готовый слепок пространственной компоновки дорожек.
     */
    function renderImmediate(viewportState, layout = null) {
        if (!ctx || !canvasElement) {
            return;
        }

        const { widthPx, heightPx, originTimestamp, zoomIndex } = viewportState;

        if (widthPx <= 0 || heightPx <= 0) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;

        // Обновление физических размеров буфера при изменении геометрии или плотности экрана
        if (
            widthPx !== lastRenderedWidth ||
            heightPx !== lastRenderedHeight ||
            dpr !== currentDpr
        ) {
            setupCanvasResolution(widthPx, heightPx);
        }

        // 1. Очистка рабочей области цветом основного фона темы из кэшированной палитры
        ctx.fillStyle = palette.bgPrimary;
        ctx.fillRect(0, 0, widthPx, heightPx);

        // 2. Расчет базовой горизонтальной линии оси с использованием нормативной константы
        const axisY = Math.floor(heightPx * AXIS_POSITION_RATIO);

        // 3. Отрисовка основной горизонтальной оси
        ctx.beginPath();
        ctx.strokeStyle = palette.borderColor;
        ctx.lineWidth = 1;
        ctx.moveTo(0, axisY + 0.5);
        ctx.lineTo(widthPx, axisY + 0.5);
        ctx.stroke();

        // 4. Генерация делений сетки на основе текущего масштаба и границ
        const ticks = generateTicks(viewportState);

        // Настройка типографики для подписей делений
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Правая граница последней успешно отрисованной крупной текстовой подписи
        let lastMajorLabelRight = -Infinity;

        // 5. Отрисовка вертикальных делений сетки и текстовых подписей с контролем коллизий
        for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i];
            const x = Math.floor(tick.screenX) + 0.5;

            // Пропуск отметок, выходящих за экранные пределы видимости
            if (x < -50 || x > widthPx + 50) {
                continue;
            }

            if (tick.isMajor) {
                // Крупное деление: штрих 16px вверх от оси отрисовывается безусловно
                ctx.save();
                ctx.beginPath();
                ctx.strokeStyle = palette.borderColor;
                ctx.lineWidth = 1;
                ctx.moveTo(x, axisY - 16);
                ctx.lineTo(x, axisY);
                ctx.stroke();

                // Формирование текстовой подписи с передачей физического шага деления
                const label = formatTickLabel(tick.timestamp, tick.unit, tick.step);
                const textWidth = ctx.measureText(label).width;

                // Расчет левой границы центрированного текста подписи
                const labelLeft = x - textWidth / 2;

                // Проверка условия отсутствия коллизии с учетом минимального экранного зазора
                if (labelLeft >= lastMajorLabelRight + MIN_MAJOR_LABEL_GAP_PX) {
                    ctx.fillStyle = palette.textSecondary;
                    ctx.globalAlpha = tick.opacity;
                    ctx.fillText(label, x, axisY + 6);

                    // Фиксация правой границы для следующей подписи
                    lastMajorLabelRight = x + textWidth / 2;
                }

                ctx.restore();
            } else {
                // Мелкое деление: штрих 8px вверх от оси с учетом прозрачности перехода
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

        // 6. Отрисовка маркеров исторических событий по переданной пространственной компоновке
        if (layout) {
            const hasPlaced = layout.placedMarkers && layout.placedMarkers.length > 0;
            const hasOverflow = layout.overflowMarkers && layout.overflowMarkers.length > 0;
            const hasAggregate = layout.aggregateMarkers && layout.aggregateMarkers.length > 0;

            if (hasPlaced || hasOverflow || hasAggregate) {
                // --- ПРОХОД 1: Заливка геометрии маркеров и подложек бейджей ---
                ctx.save();

                // 6.1. Заливка размещенных маркеров с группировкой по категориям
                if (hasPlaced) {
                    const markerGroups = new Map();
                    for (let i = 0; i < layout.placedMarkers.length; i++) {
                        const marker = layout.placedMarkers[i];
                        let group = markerGroups.get(marker.themeVariable);
                        if (!group) {
                            group = [];
                            markerGroups.set(marker.themeVariable, group);
                        }
                        group.push(marker);
                    }

                    for (const [themeVariable, groupMarkers] of markerGroups.entries()) {
                        const markerColor =
                            palette[themeVariable] ||
                            palette['--color-category-other'] ||
                            palette.colorAccent;

                        ctx.fillStyle = markerColor;

                        for (let j = 0; j < groupMarkers.length; j++) {
                            const marker = groupMarkers[j];
                            const centerY = marker.laneY + marker.laneHeight / 2;

                            if (marker.isPoint) {
                                // Точечное событие: центрированный круг на середине дорожки
                                ctx.beginPath();
                                ctx.arc(marker.screenX, centerY, MARKER_POINT_RADIUS, 0, Math.PI * 2);
                                ctx.fill();
                            } else {
                                // Интервальное событие: отсечение экранных границ полосы
                                const left = Math.max(marker.screenX, -MARKER_RENDER_BOUND_BUFFER_PX);
                                const right = Math.min(
                                    marker.screenX + marker.widthPx,
                                    widthPx + MARKER_RENDER_BOUND_BUFFER_PX
                                );
                                const clampedWidth = right - left;

                                if (clampedWidth > 0) {
                                    ctx.fillRect(left, marker.laneY, clampedWidth, marker.laneHeight);
                                }
                            }
                        }
                    }
                }

                // 6.2. Отрисовка фоновых подложек плашек переполнения
                if (hasOverflow) {
                    ctx.fillStyle = palette['--color-category-other'] || '#64748b';
                    for (let i = 0; i < layout.overflowMarkers.length; i++) {
                        const marker = layout.overflowMarkers[i];
                        const badgeWidth = marker.widthPx || OVERFLOW_BADGE_WIDTH_PX;
                        const halfWidth = badgeWidth / 2;
                        ctx.fillRect(
                            marker.screenX - halfWidth,
                            marker.laneY,
                            badgeWidth,
                            marker.laneHeight
                        );
                    }
                }

                // 6.3. Отрисовка фоновых подложек круговых бейджей агрегатов
                if (hasAggregate) {
                    ctx.fillStyle = palette.bgSecondary || '#1a1a1e';
                    for (let i = 0; i < layout.aggregateMarkers.length; i++) {
                        const marker = layout.aggregateMarkers[i];
                        const centerY = marker.laneY + marker.laneHeight / 2;
                        ctx.beginPath();
                        ctx.arc(marker.screenX, centerY, AGGREGATE_BADGE_RADIUS_PX, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }

                ctx.restore();

                // --- ПРОХОД 2: Типографика бейджей и контуры выделения ---
                ctx.save();

                // 6.4. Обводка и нанесение счетчиков на бейджи агрегатов
                if (hasAggregate) {
                    ctx.strokeStyle = palette.colorAccent;
                    ctx.lineWidth = 1.5;
                    ctx.fillStyle = palette.textPrimary;
                    ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';

                    for (let i = 0; i < layout.aggregateMarkers.length; i++) {
                        const marker = layout.aggregateMarkers[i];
                        const centerY = marker.laneY + marker.laneHeight / 2;

                        ctx.beginPath();
                        ctx.arc(marker.screenX, centerY, AGGREGATE_BADGE_RADIUS_PX, 0, Math.PI * 2);
                        ctx.stroke();

                        const badgeText =
                            marker.count > AGGREGATE_BADGE_MAX_LABEL_COUNT
                                ? '99+'
                                : String(marker.count);
                        ctx.fillText(badgeText, marker.screenX, centerY);
                    }
                }

                // 6.5. Нанесение текстовых счетчиков на плашки переполнения
                if (hasOverflow) {
                    ctx.fillStyle = palette.textPrimary;
                    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';

                    for (let i = 0; i < layout.overflowMarkers.length; i++) {
                        const marker = layout.overflowMarkers[i];
                        const centerY = marker.laneY + marker.laneHeight / 2;
                        ctx.fillText('+' + marker.count, marker.screenX, centerY);
                    }
                }

                // 6.6. Отрисовка контура активного выделения
                if (selectedEventId !== null && hasPlaced) {
                    const selectedMarker = layout.placedMarkers.find(
                        (m) => m.event && m.event.id === selectedEventId
                    );

                    if (selectedMarker) {
                        ctx.strokeStyle = palette.colorAccent;
                        ctx.lineWidth = SELECTION_HIGHLIGHT_WIDTH_PX;

                        const centerY = selectedMarker.laneY + selectedMarker.laneHeight / 2;

                        if (selectedMarker.isPoint) {
                            ctx.beginPath();
                            ctx.arc(
                                selectedMarker.screenX,
                                centerY,
                                MARKER_POINT_RADIUS + 2,
                                0,
                                Math.PI * 2
                            );
                            ctx.stroke();
                        } else {
                            const left = Math.max(
                                selectedMarker.screenX,
                                -MARKER_RENDER_BOUND_BUFFER_PX
                            );
                            const right = Math.min(
                                selectedMarker.screenX + selectedMarker.widthPx,
                                widthPx + MARKER_RENDER_BOUND_BUFFER_PX
                            );
                            const clampedWidth = right - left;

                            if (clampedWidth > 0) {
                                ctx.strokeRect(
                                    left - 1,
                                    selectedMarker.laneY - 1,
                                    clampedWidth + 2,
                                    selectedMarker.laneHeight + 2
                                );
                            }
                        }
                    }
                }

                ctx.restore();
            }
        }

        // 7. Отрисовка маркера текущего момента времени («Сейчас») поверх всех слоев
        const nowTs = Math.floor(Date.now() / 1000);
        const spp = zoomIndexToSecondsPerPixel(zoomIndex);
        const nowX = timestampToScreenX(nowTs, originTimestamp, spp);

        if (nowX >= -20 && nowX <= widthPx + 20) {
            const markerX = Math.floor(nowX) + 0.5;

            ctx.save();

            // Вертикальная акцентная линия текущего времени
            ctx.beginPath();
            ctx.strokeStyle = palette.colorAccent;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.8;
            ctx.moveTo(markerX, 0);
            ctx.lineTo(markerX, heightPx);
            ctx.stroke();

            // Информационный бейдж «Сейчас» в верхней части холста
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

    return {
        /**
         * Запрос асинхронной перерисовки в следующем кадре анимации.
         * Выполняет батчинг частых вызовов в пределах одного кадра requestAnimationFrame.
         *
         * @param {Object} viewportState Слепок состояния области просмотра.
         * @param {Object|null} [layout=null] Готовый слепок пространственной компоновки.
         */
        requestRender(viewportState, layout = null) {
            pendingState = viewportState;
            pendingLayout = layout;

            if (animationFrameId !== null) {
                return;
            }

            animationFrameId = requestAnimationFrame(() => {
                animationFrameId = null;
                if (pendingState) {
                    renderImmediate(pendingState, pendingLayout);
                }
            });
        },

        /**
         * Немедленная синхронная перерисовка холста с отменой отложенного кадра.
         *
         * @param {Object} viewportState Слепок состояния области просмотра.
         * @param {Object|null} [layout=null] Готовый слепок пространственной компоновки.
         */
        render(viewportState, layout = null) {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            renderImmediate(viewportState, layout);
        },

        /**
         * Установка идентификатора выбранного события для отображения контура активного выделения.
         *
         * @param {number|null} eventId Идентификатор выбранного события либо null для сброса.
         */
        setSelection(eventId) {
            selectedEventId = eventId;
        },

        /**
         * Принудительное обновление кэшированной цветовой палитры темы оформления
         * (вызывается при динамическом переключении тем оформления приложения).
         */
        updateThemePalette() {
            if (canvasElement) {
                palette = resolveThemePalette(canvasElement);
            }
        },

        /**
         * Полная утилизация рендерера и освобождение системных ресурсов.
         */
        destroy() {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            selectedEventId = null;
            canvasElement = null;
            ctx = null;
            pendingState = null;
            pendingLayout = null;
        },
    };
}
