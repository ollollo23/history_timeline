/**
 * Модуль пространственной детекции попадания курсора (Hit-Testing) на временной шкале.
 * Реализует чистое математическое сопоставление координат указателя мыши или касания
 * с экранными маркерами исторических событий, бейджами агрегатов и маркерами переполнения.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистая функциональная модель: модуль не зависит от DOM-дерева, глобального состояния
 *    и Canvas API, выполняя геометрические проверки исключительно над объектом layout.
 * 2. Допуск взаимодействия (Tolerance): координаты расширяются на величину HIT_TEST_TOLERANCE_PX
 *    для надежного захвата мелких элементов курсором и на сенсорных экранах.
 * 3. Разрешение наложений (Disambiguation): при клике в точку пересечения нескольких маркеров
 *    приоритет отдается маркеру с минимальной площадью (мелкий поверх крупного).
 * 4. Приоритет интерактивных слоев: проверка цели выполняется в строгом порядке:
 *    агрегаты потомков -> маркеры переполнения -> маркеры событий.
 */

import {
    AGGREGATE_BADGE_RADIUS_PX,
    HIT_TEST_TOLERANCE_PX,
    MARKER_POINT_RADIUS,
    OVERFLOW_BADGE_WIDTH_PX,
} from './constants.js';

/**
 * Таблица весовых приоритетов рангов для детерминированного разрешения коллизий.
 * @type {Readonly<Record<string, number>>}
 */
const RANK_PRIORITY_INDEX = Object.freeze({
    century: 0,
    decade: 1,
    year: 2,
    month: 3,
    day: 4,
    hour: 5,
    minute: 6,
    second: 7,
});

/**
 * Определение маркера события под заданной экранной точкой с учетом допуска и площади.
 *
 * @param {Object} layout Результат работы функции computeTimelineLayout.
 * @param {number} x Горизонтальная координата курсора относительно холста.
 * @param {number} y Вертикальная координата курсора относительно холста.
 * @param {number} [tolerance=HIT_TEST_TOLERANCE_PX] Допуск попадания в пикселях.
 * @returns {Object|null} Дескриптор найденного маркера события или null.
 */
export function findMarkerAtPoint(layout, x, y, tolerance = HIT_TEST_TOLERANCE_PX) {
    if (!layout || !Array.isArray(layout.placedMarkers) || layout.placedMarkers.length === 0) {
        return null;
    }

    const candidates = [];

    for (let i = 0; i < layout.placedMarkers.length; i++) {
        const marker = layout.placedMarkers[i];

        if (marker.isPoint === true) {
            // Точечный маркер: проверка вхождения в окружность радиуса с допуском
            const centerX = marker.screenX;
            const centerY = marker.laneY + marker.laneHeight / 2;
            const r = MARKER_POINT_RADIUS + tolerance;

            if (Math.hypot(x - centerX, y - centerY) <= r) {
                const area = Math.PI * MARKER_POINT_RADIUS * MARKER_POINT_RADIUS;
                candidates.push({ marker, area });
            }
        } else {
            // Интервальный маркер: проверка вхождения в прямоугольник полосы с допуском
            const left = marker.screenX - tolerance;
            const right = marker.screenX + (marker.widthPx || 0) + tolerance;
            const top = marker.laneY - tolerance;
            const bottom = marker.laneY + marker.laneHeight + tolerance;

            if (x >= left && x <= right && y >= top && y <= bottom) {
                const area = Math.max(1, marker.widthPx || 1) * marker.laneHeight;
                candidates.push({ marker, area });
            }
        }
    }

    if (candidates.length === 0) {
        return null;
    }

    if (candidates.length === 1) {
        return candidates[0].marker;
    }

    // Разрешение неоднозначности при наложении: меньшая площадь имеет преимущество (мелкий поверх крупного)
    candidates.sort((a, b) => {
        if (Math.abs(a.area - b.area) > 1e-6) {
            return a.area - b.area;
        }

        // При равенстве площадей преимущество имеет более крупный ранг детализации
        const rankA = RANK_PRIORITY_INDEX[a.marker.event?.rank] ?? 99;
        const rankB = RANK_PRIORITY_INDEX[b.marker.event?.rank] ?? 99;
        if (rankA !== rankB) {
            return rankA - rankB;
        }

        // Детерминированный фоллбэк по идентификатору
        const idA = a.marker.event?.id ?? 0;
        const idB = b.marker.event?.id ?? 0;
        return idA - idB;
    });

    return candidates[0].marker;
}

/**
 * Определение маркера переполнения (Overflow Badge) под заданной экранной точкой.
 *
 * @param {Object} layout Результат работы функции computeTimelineLayout.
 * @param {number} x Горизонтальная координата курсора относительно холста.
 * @param {number} y Вертикальная координата курсора относительно холста.
 * @param {number} [tolerance=HIT_TEST_TOLERANCE_PX] Допуск попадания в пикселях.
 * @returns {Object|null} Дескриптор маркера переполнения или null.
 */
export function findOverflowAtPoint(layout, x, y, tolerance = HIT_TEST_TOLERANCE_PX) {
    if (!layout || !Array.isArray(layout.overflowMarkers) || layout.overflowMarkers.length === 0) {
        return null;
    }

    for (let i = 0; i < layout.overflowMarkers.length; i++) {
        const marker = layout.overflowMarkers[i];
        const halfWidth = (marker.widthPx || OVERFLOW_BADGE_WIDTH_PX) / 2;

        const left = marker.screenX - halfWidth - tolerance;
        const right = marker.screenX + halfWidth + tolerance;
        const top = marker.laneY - tolerance;
        const bottom = marker.laneY + marker.laneHeight + tolerance;

        if (x >= left && x <= right && y >= top && y <= bottom) {
            return marker;
        }
    }

    return null;
}

/**
 * Определение кругового бейджа агрегата потомков под заданной экранной точкой.
 *
 * @param {Object} layout Результат работы функции computeTimelineLayout.
 * @param {number} x Горизонтальная координата курсора относительно холста.
 * @param {number} y Вертикальная координата курсора относительно холста.
 * @param {number} [tolerance=HIT_TEST_TOLERANCE_PX] Допуск попадания в пикселях.
 * @returns {Object|null} Дескриптор агрегата потомков или null.
 */
export function findAggregateAtPoint(layout, x, y, tolerance = HIT_TEST_TOLERANCE_PX) {
    if (!layout || !Array.isArray(layout.aggregateMarkers) || layout.aggregateMarkers.length === 0) {
        return null;
    }

    for (let i = 0; i < layout.aggregateMarkers.length; i++) {
        const marker = layout.aggregateMarkers[i];
        const centerX = marker.screenX;
        const centerY = marker.laneY + marker.laneHeight / 2;
        const r = AGGREGATE_BADGE_RADIUS_PX + tolerance;

        if (Math.hypot(x - centerX, y - centerY) <= r) {
            return marker;
        }
    }

    return null;
}

/**
 * Комплексное определение интерактивной цели под курсором с соблюдением приоритета слоев.
 * Порядок проверки: агрегаты потомков -> маркеры переполнения -> маркеры событий.
 *
 * @param {Object} layout Результат работы функции computeTimelineLayout.
 * @param {number} x Горизонтальная координата курсора относительно холста.
 * @param {number} y Вертикальная координата курсора относительно холста.
 * @param {number} [tolerance=HIT_TEST_TOLERANCE_PX] Допуск попадания в пикселях.
 * @returns {Object|null} Интерактивный дескриптор цели или null при промахе.
 */
export function resolveCursorTarget(layout, x, y, tolerance = HIT_TEST_TOLERANCE_PX) {
    // 1. Проверка попадания в бейдж агрегата потомков (рисуется поверх родителя)
    const aggregate = findAggregateAtPoint(layout, x, y, tolerance);
    if (aggregate !== null) {
        return aggregate;
    }

    // 2. Проверка попадания в плашку переполнения скрытых событий
    const overflow = findOverflowAtPoint(layout, x, y, tolerance);
    if (overflow !== null) {
        return overflow;
    }

    // 3. Проверка попадания в маркер исторического события
    const marker = findMarkerAtPoint(layout, x, y, tolerance);
    if (marker !== null) {
        return marker;
    }

    return null;
}
