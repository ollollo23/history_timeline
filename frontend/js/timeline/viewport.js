/**
 * Модель неизменяемого состояния (Viewport State) виртуальной камеры таймлайна.
 * Предоставляет чистые математические функции панорамирования, масштабирования к курсору
 * и адаптации геометрии без обращения к DOM-дереву и без глобальных мутаций.
 *
 * КАНОНИЧЕСКАЯ СТРУКТУРА СОСТОЯНИЯ:
 * - originTimestamp: вещественная метка в секундах Unix на левом крае видимой области (X = 0).
 *   Отказ от округления до целых секунд обусловлен физикой масштабирования: на масштабе 0.02 с/пкс
 *   округление опорной точки вносит погрешность до 25 пикселей и полностью подавляет смещения
 *   короче 0.5 секунды, вызывая дефект «мертвого панорамирования».
 * - zoomIndex: логарифмический индекс масштаба (log2 от секунд на пиксель).
 * - widthPx: ширина видимой области в логических пикселях.
 * - heightPx: высота видимой области в логических пикселях.
 */

import { SECONDS_PER_YEAR_AVG } from './constants.js';
import {
    calculateVisibleDuration,
    clampOriginTimestamp,
    screenXToTimestamp,
    secondsPerPixelToZoomIndex,
    zoomIndexToSecondsPerPixel,
} from './scale.js';

/**
 * Фабрика создания валидированного и защищенного от мутаций объекта состояния области просмотра.
 * Сохраняет опорную метку времени в виде вещественного числа без квантования до целых секунд.
 *
 * @param {number} originTimestamp Опорная метка времени левого края в секундах Unix (вещественное число).
 * @param {number} zoomIndex Вещественный логарифмический индекс масштаба.
 * @param {number} widthPx Ширина области в логических пикселях.
 * @param {number} heightPx Высота области в логических пикселях.
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function createViewportState(originTimestamp, zoomIndex, widthPx, heightPx) {
    // Безопасная нормализация геометрических размеров для защиты от деления на ноль
    const safeWidth = Math.max(1, widthPx);
    const safeHeight = Math.max(1, heightPx);

    // Вычисление текущего физического масштаба (секунд на пиксель)
    const secondsPerPixel = zoomIndexToSecondsPerPixel(zoomIndex);

    // Ограничение опорной метки левого края без округления строго по трем физическим параметрам
    const clampedOrigin = clampOriginTimestamp(
        originTimestamp,
        safeWidth,
        secondsPerPixel
    );

    // Возврат замороженного объекта для гарантии неизменяемости состояния
    return Object.freeze({
        originTimestamp: clampedOrigin,
        zoomIndex,
        widthPx: safeWidth,
        heightPx: safeHeight,
    });
}

/**
 * Генерация исходного состояния области просмотра по умолчанию.
 * Центрирует видимую область на текущем моменте времени и задает интервал обзора в 200 лет.
 *
 * @param {number} [widthPx=1000] Исходная ширина контейнера в логических пикселях.
 * @param {number} [heightPx=300] Исходная высота контейнера в логических пикселях.
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function getDefaultViewportState(widthPx = 1000, heightPx = 300) {
    // Получение текущего времени Unix в секундах (безопасное использование Date для текущего века)
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Целевая длительность интервала по умолчанию: 200 средних лет
    const targetDuration = 200 * SECONDS_PER_YEAR_AVG;

    // Расчет требуемого масштаба и соответствующего логарифмического индекса
    const targetSpp = targetDuration / Math.max(1, widthPx);
    const zoomIndex = secondsPerPixelToZoomIndex(targetSpp);

    // Фактический масштаб с учетом граничных лимитов платформы
    const spp = zoomIndexToSecondsPerPixel(zoomIndex);
    const visibleDuration = calculateVisibleDuration(widthPx, spp);

    // Расчет точной вещественной метки левого края для центрирования текущего момента времени
    const originTimestamp = nowSeconds - visibleDuration / 2;

    return createViewportState(originTimestamp, zoomIndex, widthPx, heightPx);
}

/**
 * Чистая операция панорамирования (горизонтального сдвига) области просмотра.
 * Перемещение рассчитывается в вещественных числах без потери долей пикселей и секунд.
 *
 * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
 * @param {number} deltaPx Смещение указателя в пикселях (положительное при движении вправо).
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function panViewport(state, deltaPx) {
    if (deltaPx === 0) {
        return state;
    }

    const spp = zoomIndexToSecondsPerPixel(state.zoomIndex);

    // При движении вправо временная шкала смещается вправо, открывая более раннее время (минус дельта)
    const newOrigin = state.originTimestamp - deltaPx * spp;

    return createViewportState(newOrigin, state.zoomIndex, state.widthPx, state.heightPx);
}

/**
 * Чистая операция масштабирования относительно произвольной экранной точки привязки (курсора мыши).
 *
 * Математический инвариант:
 * Временная метка anchorTimestamp под экранной координатой anchorScreenX обязана остаться
 * ровно под той же пиксельной координатой после применения нового масштаба.
 *
 * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
 * @param {number} anchorScreenX Координата X точки привязки относительно левого края области.
 * @param {number} zoomDelta Приращение логарифмического индекса масштаба.
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function zoomViewport(state, anchorScreenX, zoomDelta) {
    if (zoomDelta === 0) {
        return state;
    }

    const currentSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);

    // Получение точной вещественной метки времени под курсором (roundToInteger = false по умолчанию)
    const anchorTimestamp = screenXToTimestamp(
        anchorScreenX,
        state.originTimestamp,
        currentSpp
    );

    // Расчет нового индекса зума и ограниченного физического масштаба
    const targetZoomIndex = state.zoomIndex + zoomDelta;
    const newSpp = zoomIndexToSecondsPerPixel(targetZoomIndex);
    const effectiveZoomIndex = secondsPerPixelToZoomIndex(newSpp);

    // Восстановление опорной метки левого края из инварианта: anchorX = (anchorT - origin) / newSpp
    const newOrigin = anchorTimestamp - anchorScreenX * newSpp;

    return createViewportState(newOrigin, effectiveZoomIndex, state.widthPx, state.heightPx);
}

/**
 * Чистая операция обновления геометрических размеров контейнера при ресайзе окна.
 * Сохраняет опорную метку левого края неизменной во избежание визуальных скачков сетки.
 *
 * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
 * @param {number} newWidthPx Новая ширина контейнера в логических пикселях.
 * @param {number} newHeightPx Новая высота контейнера в логических пикселях.
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function resizeViewport(state, newWidthPx, newHeightPx) {
    if (state.widthPx === newWidthPx && state.heightPx === newHeightPx) {
        return state;
    }

    return createViewportState(state.originTimestamp, state.zoomIndex, newWidthPx, newHeightPx);
}

/**
 * Чистая операция автоматического позиционирования области просмотра под заданный интервал времени.
 *
 * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
 * @param {number} startTimestamp Начало целевого диапазона в секундах.
 * @param {number} endTimestamp Конец целевого диапазона в секундах.
 * @returns {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>}
 */
export function fitInterval(state, startTimestamp, endTimestamp) {
    const duration = Math.max(1, endTimestamp - startTimestamp);
    const targetSpp = duration / Math.max(1, state.widthPx);
    const targetZoomIndex = secondsPerPixelToZoomIndex(targetSpp);

    return createViewportState(startTimestamp, targetZoomIndex, state.widthPx, state.heightPx);
}
