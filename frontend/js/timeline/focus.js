/**
 * Модуль позиционирования камеры и фокусировки на историческом событии.
 * Обеспечивает центрирование области отображения на временных координатах события
 * и адаптивный подбор масштаба детализации (zoomIndex) для гарантированной видимости ранга.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистая математическая модель: функции модуля не производят побочных эффектов,
 *    не имеют внутреннего состояния и не обращаются к DOM-дереву.
 * 2. Асимметрия зума: камера только приближает (уменьшает zoomIndex) или сохраняет
 *    текущий масштаб, если ранг уже виден. Отдаление камеры при фокусировке запрещено.
 * 3. Центрирование интервалов: для точечного события центром становится start_date,
 *    для интервального — математическая середина между start_date и end_date.
 * 4. Защита границ: вызов createViewportState гарантирует соблюдение физических
 *    хронологических пределов платформы.
 */

import {
    MIN_SECONDS_PER_PIXEL,
    ZOOM_STEP_PER_WHEEL_NOTCH,
} from './constants.js';
import {
    calculateVisibleDuration,
    secondsPerPixelToZoomIndex,
    zoomIndexToSecondsPerPixel,
} from './scale.js';
import { getActiveLadderLevel } from './ticks.js';
import { getRanksForUnit } from './rankMapping.js';
import { createViewportState } from './viewport.js';

/**
 * Набор допустимых доменных рангов детализации событий History Timeline.
 * @type {ReadonlySet<string>}
 */
const KNOWN_RANKS = new Set([
    'century',
    'decade',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
]);

/**
 * Определение оптимального масштаба детализации zoomIndex для видимости заданного ранга.
 * Выполняет пошаговое дискретное приближение до первого уровня лестницы делений,
 * отображающего целевой ранг, либо возвращает текущий зум, если ранг уже видим.
 *
 * @param {string} rank Доменный ранг детализации события.
 * @param {number} currentZoomIndex Текущий логарифмический индекс масштаба камеры.
 * @returns {number} Целевой индекс масштаба zoomIndex (меньше или равен currentZoomIndex).
 */
export function findZoomIndexForRank(rank, currentZoomIndex) {
    // 1. Валидация входных аргументов
    if (
        typeof rank !== 'string' ||
        !KNOWN_RANKS.has(rank) ||
        typeof currentZoomIndex !== 'number' ||
        !Number.isFinite(currentZoomIndex)
    ) {
        return currentZoomIndex;
    }

    // 2. Проверка видимости ранга на текущем активном делении сетки
    const currentLevel = getActiveLadderLevel({ zoomIndex: currentZoomIndex });
    const currentRanks = getRanksForUnit(currentLevel.unit);

    if (Array.isArray(currentRanks) && currentRanks.includes(rank)) {
        return currentZoomIndex;
    }

    // 3. Вычисление физического предела максимального приближения
    const minZoomIndex = secondsPerPixelToZoomIndex(MIN_SECONDS_PER_PIXEL);

    // 4. Пошаговое приближение (уменьшение индекса zoomIndex с шагом колеса мыши)
    let zoom = currentZoomIndex;
    while (zoom > minZoomIndex) {
        zoom = Math.max(minZoomIndex, zoom - ZOOM_STEP_PER_WHEEL_NOTCH);
        const level = getActiveLadderLevel({ zoomIndex: zoom });
        const visibleRanks = getRanksForUnit(level.unit);

        if (Array.isArray(visibleRanks) && visibleRanks.includes(rank)) {
            return zoom;
        }
    }

    // 5. Предельное значение зума, если ранг не включился ранее
    return zoom;
}

/**
 * Расчет нового состояния виртуальной камеры для центрирования на историческом событии.
 *
 * @param {{ originTimestamp: number, zoomIndex: number, widthPx: number }} state
 *        Текущее валидное состояние виртуальной камеры.
 * @param {{ start_date: number, end_date?: number | null, rank?: string }} event
 *        Историческое событие, на котором выполняется фокусировка.
 * @returns {{ originTimestamp: number, zoomIndex: number, widthPx: number }}
 *          Новое иммутабельное состояние камеры.
 */
export function computeFocusViewport(state, event) {
    // 1. Защитная валидация входных параметров
    if (
        !state ||
        typeof state !== 'object' ||
        typeof state.zoomIndex !== 'number' ||
        typeof state.widthPx !== 'number' ||
        !event ||
        typeof event !== 'object' ||
        typeof event.start_date !== 'number' ||
        !Number.isFinite(event.start_date)
    ) {
        return state;
    }

    // 2. Определение целевого хронологического центра события
    let centerTimestamp;
    if (
        typeof event.end_date === 'number' &&
        Number.isFinite(event.end_date) &&
        event.end_date > event.start_date
    ) {
        centerTimestamp = event.start_date + (event.end_date - event.start_date) / 2;
    } else {
        centerTimestamp = event.start_date;
    }

    // 3. Подбор масштаба: только приближение или сохранение текущего
    const targetZoomIndex = findZoomIndexForRank(event.rank, state.zoomIndex);

    // 4. Расчет экранных проекций и левой границы окна
    const spp = zoomIndexToSecondsPerPixel(targetZoomIndex);
    const visibleDuration = calculateVisibleDuration(state.widthPx, spp);
    const originTimestamp = centerTimestamp - visibleDuration / 2;

    // 5. Формирование нового нормализованного состояния камеры
    return createViewportState(originTimestamp, targetZoomIndex, state.widthPx);
}
