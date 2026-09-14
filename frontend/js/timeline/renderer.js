/**
 * Изолированный графический рендерер временной оси на HTML5 Canvas 2D.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистый слой представления: рендерер не владеет состоянием, не слушает события
 *    пользовательского ввода и получает готовый слепок viewportState[cite: 22].
 * 2. Адаптивность к HiDPI / Retina: физический размер буфера масштабируется
 *    на window.devicePixelRatio с компенсацией трансформации контекста[cite: 22].
 * 3. Субпиксельная резкость: все однопиксельные линии сетки и оси смещаются на 0.5px,
 *    что исключает размытие границ растеризатором Canvas[cite: 22].
 * 4. Кэширование стилей темы: палитра вычисляется один раз при инициализации фабрики,
 *    исключая до 360 синхронных reflow-пересчетов стилей в секунду внутри анимационного цикла[cite: 22].
 * 5. Разрешение коллизий подписей: горизонтальные габариты крупных меток контролируются
 *    через MIN_MAJOR_LABEL_GAP_PX, предотвращая взаимное наложение текста дат[cite: 17, 22].
 * 6. Пакетная перерисовка (Frame Batching): вызовы requestRender объединяются
 *    в пределах одного кадра анимации requestAnimationFrame[cite: 22].
 */

import { MIN_MAJOR_LABEL_GAP_PX } from './constants.js';
import {
    timestampToScreenX,
    zoomIndexToSecondsPerPixel,
} from './scale.js';
import { generateTicks } from './ticks.js';
import { formatTickLabel } from './format.js';

/**
 * Динамическое извлечение цветовой палитры темы оформления из вычисленных стилей элемента.
 *
 * @param {HTMLCanvasElement} canvasElement Элемент холста Canvas.
 * @returns {{
 *   bgPrimary: string,
 *   bgSecondary: string,
 *   textPrimary: string,
 *   textSecondary: string,
 *   colorAccent: string,
 *   borderColor: string
 * }} Объект разрешенных цветов темы.
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
    };
}

/**
 * Фабрика создания изолированного графического рендерера таймлайна.
 *
 * @param {HTMLCanvasElement} canvasElement Элемент Canvas для отрисовки.
 * @returns {{
 *   render: (viewportState: Object) => void,
 *   requestRender: (viewportState: Object) => void,
 *   updateThemePalette: () => void,
 *   destroy: () => void
 * }} Интерфейс управления рендерером.
 */
export function createTimelineRenderer(canvasElement) {
    let ctx = canvasElement.getContext('2d');
    let animationFrameId = null;
    let pendingState = null;
    let currentDpr = 1;
    let lastRenderedWidth = 0;
    let lastRenderedHeight = 0;

    // Первичное кэширование палитры темы в замыкании для предотвращения синхронного reflow на каждом кадре
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
     * Непосредственное выполнение команд отрисовки кадра по переданному состоянию.
     * Использует кэшированную цветовую палитру и контролирует коллизии подписей делений.
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

        // 2. Расчет базовой горизонтальной линии оси (65% высоты холста)
        const axisY = Math.floor(heightPx * 0.65);

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

        // 6. Отрисовка маркера текущего момента времени («Сейчас»)
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
         * Немедленная синхронная перерисовка холста с отменой отложенного кадра.
         *
         * @param {Object} viewportState Слепок состояния области просмотра.
         */
        render(viewportState) {
            if (animationFrameId !== null) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            renderImmediate(viewportState);
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
            canvasElement = null;
            ctx = null;
            pendingState = null;
        },
    };
}
