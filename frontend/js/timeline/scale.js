/**
 * Функциональное математическое ядро проекции и масштабирования координат таймлайна.
 * Обеспечивает прямое и обратное проецирование временных меток в пиксельные координаты,
 * логарифмический пересчет коэффициентов масштабирования и соблюдение граничных инвариантов.
 *
 * МОДУЛЬ НЕ СОДЕРЖИТ СОСТОЯНИЯ И ЗАВИСИМОСТЕЙ ОТ DOM/CANVAS.
 */

import {
    MAX_SECONDS_PER_PIXEL,
    MIN_SECONDS_PER_PIXEL,
    TIMELINE_MAX_TIMESTAMP,
    TIMELINE_MIN_TIMESTAMP,
} from './constants.js';

/**
 * Прямое проецирование временной метки в горизонтальную экранную координату.
 *
 * @param {number} timestamp Временная метка в секундах Unix (вещественное или целое число).
 * @param {number} originTimestamp Метка времени на левом крае видимой области (X = 0).
 * @param {number} secondsPerPixel Текущий масштаб (количество секунд в одном логическом пикселе).
 * @returns {number} Экранная координата X в логических пикселях (вещественное число).
 */
export function timestampToScreenX(timestamp, originTimestamp, secondsPerPixel) {
    return (timestamp - originTimestamp) / secondsPerPixel;
}

/**
 * Обратное проецирование экранной координаты во временную метку.
 * По умолчанию сохраняет вещественную точность для непрерывных математических вычислений.
 *
 * @param {number} screenX Горизонтальная координата X в логических пикселях.
 * @param {number} originTimestamp Метка времени на левом крае видимой области (X = 0).
 * @param {number} secondsPerPixel Текущий масштаб (количество секунд в одном логическом пикселе).
 * @param {boolean} [roundToInteger=false] Флаг принудительного округления до целой секунды.
 * @returns {number} Временная метка в секундах Unix (вещественное или целое число).
 */
export function screenXToTimestamp(screenX, originTimestamp, secondsPerPixel, roundToInteger = false) {
    const rawTimestamp = originTimestamp + screenX * secondsPerPixel;
    return roundToInteger ? Math.round(rawTimestamp) : rawTimestamp;
}

/**
 * Вычисление значения секунд на пиксель из логарифмического индекса масштаба (log2).
 * Устраняет артефакты машинной точности стандарта IEEE 754 и строго
 * ограничивает результат диапазоном [MIN_SECONDS_PER_PIXEL, MAX_SECONDS_PER_PIXEL].
 *
 * @param {number} zoomIndex Вещественный логарифмический индекс масштаба.
 * @returns {number} Масштаб в секундах на пиксель.
 */
export function zoomIndexToSecondsPerPixel(zoomIndex) {
    const rawSecondsPerPixel = Math.pow(2, zoomIndex);

    // Устранение машинной погрешности на нижней границе масштаба (0.02 с/пкс)
    if (
        rawSecondsPerPixel <= MIN_SECONDS_PER_PIXEL ||
        Math.abs(rawSecondsPerPixel - MIN_SECONDS_PER_PIXEL) < 1e-12
    ) {
        return MIN_SECONDS_PER_PIXEL;
    }

    // Устранение машинной погрешности на верхней границе масштаба (2.1e10 с/пкс)
    if (
        rawSecondsPerPixel >= MAX_SECONDS_PER_PIXEL ||
        Math.abs(rawSecondsPerPixel - MAX_SECONDS_PER_PIXEL) < 1e-5
    ) {
        return MAX_SECONDS_PER_PIXEL;
    }

    return rawSecondsPerPixel;
}

/**
 * Вычисление логарифмического индекса масштаба (log2) из значения секунд на пиксель.
 * Обеспечивает равномерный шаг колеса мыши во всем диапазоне масштабирования.
 *
 * @param {number} secondsPerPixel Масштаб в секундах на пиксель.
 * @returns {number} Логарифмический индекс масштаба zoomIndex.
 */
export function secondsPerPixelToZoomIndex(secondsPerPixel) {
    const clampedSecondsPerPixel = Math.min(
        Math.max(secondsPerPixel, MIN_SECONDS_PER_PIXEL),
        MAX_SECONDS_PER_PIXEL
    );
    return Math.log2(clampedSecondsPerPixel);
}

/**
 * Расчет длительности временного отрезка, отображаемого в области заданной пиксельной ширины.
 *
 * @param {number} widthPx Ширина области отображения в логических пикселях.
 * @param {number} secondsPerPixel Текущий масштаб в секундах на пиксель.
 * @returns {number} Длительность видимого интервала в секундах.
 */
export function calculateVisibleDuration(widthPx, secondsPerPixel) {
    return widthPx * secondsPerPixel;
}

/**
 * Расчет длины временного интервала в экранных пикселях при заданном масштабе.
 *
 * @param {number} durationSeconds Продолжительность события или интервала в секундах.
 * @param {number} secondsPerPixel Текущий масштаб в секундах на пиксель.
 * @returns {number} Длина интервала в пикселях.
 */
export function calculatePixelWidth(durationSeconds, secondsPerPixel) {
    return durationSeconds / secondsPerPixel;
}

/**
 * Ограничение и центрирование опорной временной метки левого края (originTimestamp)
 * с гарантией нахождения видимого окна в пределах физических границ шкалы платформы.
 * Работает строго с вещественными числами без неявного округления до целых секунд.
 *
 * @param {number} originTimestamp Запрошенная опорная метка левого края в секундах.
 * @param {number} widthPx Ширина области просмотра в логических пикселях.
 * @param {number} secondsPerPixel Текущий масштаб в секундах на пиксель.
 * @returns {number} Скорректированная опорная метка левого края originTimestamp.
 */
export function clampOriginTimestamp(originTimestamp, widthPx, secondsPerPixel) {
    // Точный расчет видимой длительности окна на основе ширины и текущего масштаба
    const visibleDuration = widthPx * secondsPerPixel;
    const totalTimelineDuration = TIMELINE_MAX_TIMESTAMP - TIMELINE_MIN_TIMESTAMP;

    // Случай полного отдаления: видимый интервал превышает всю историческую шкалу платформы
    if (visibleDuration >= totalTimelineDuration) {
        return TIMELINE_MIN_TIMESTAMP + (totalTimelineDuration - visibleDuration) / 2;
    }

    // Случай локального просмотра: строгий упор в физические границы платформы
    const minOrigin = TIMELINE_MIN_TIMESTAMP;
    const maxOrigin = TIMELINE_MAX_TIMESTAMP - visibleDuration;

    return Math.min(Math.max(originTimestamp, minOrigin), maxOrigin);
}
