/**
 * Модуль математического ядра вертикальной компоновки временной шкалы (Layout Engine).
 * Реализует расчет вместимости и высоты дорожек, позиционирование бейджей скрытых потомков,
 * жадное распределение маркеров со стабилизацией по дорожкам между кадрами,
 * учет приоритета слоев категорий и формирование бейджей переполнения.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистая функциональная модель: модуль не содержит глобального состояния,
 *    не производит побочных эффектов и не обращается к DOM-дереву или Canvas API.
 * 2. Серверная агрегация: иерархические агрегаты не отфильтровываются на клиенте;
 *    бейдж рисуется на основе серверного атрибута collapsed_children_count,
 *    а все загруженные потомки компонуются независимо.
 * 3. Резервирование дорожки переполнения: при maxLanes >= 2 верхняя дорожка выделяется
 *    под бейджи переполнения вытесненных маркеров.
 * 4. Стабилизация дорожек (stickiness): переданный Map previousLaneAssignments
 *    закрепляет дорожку за событием между кадрами панорамирования, если она свободна.
 * 5. Приоритет слоев: внутри одного ранга детализации события более приоритетного слоя
 *    размещаются ближе к оси времени и вытесняются последними.
 * 6. Немутабельность: все возвращаемые коллекции и дескрипторы глубоко замораживаются.
 */

import {
    AGGREGATE_BADGE_EDGE_PADDING_PX,
    AGGREGATE_BADGE_RADIUS_PX,
    AXIS_POSITION_RATIO,
    LANE_HORIZONTAL_GAP_PX,
    LANE_MAX_HEIGHT_PX,
    LANE_MIN_HEIGHT_PX,
    LANE_VERTICAL_GAP_PX,
    MARKER_LANES_TOP_PADDING_PX,
    MARKER_OFFSET_FROM_AXIS,
    MARKER_POINT_RADIUS,
    MIN_CHILDREN_FOR_AGGREGATE,
    MIN_EVENT_BAR_WIDTH_PX,
    OVERFLOW_BADGE_WIDTH_PX,
    TIMELINE_CANVAS_HEIGHT_PX,
} from './constants.js';
import { normalizeCategoryId } from './categories.js';

/**
 * Упорядоченный список рангов деталей исторических событий по глубине детализации.
 * Используется для расчета приоритета при распределении по дорожкам.
 * @type {ReadonlyArray<string>}
 */
export const EVENT_RANKS_ORDERED = Object.freeze([
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
 * Таблица весовых коэффициентов приоритета рангов (0 — наивысший приоритет century).
 * @type {Readonly<Record<string, number>>}
 */
const RANK_PRIORITY_INDEX = Object.freeze(
    EVENT_RANKS_ORDERED.reduce((acc, rank, index) => {
        acc[rank] = index;
        return acc;
    }, {})
);

/**
 * Фабрика создания функции сравнения маркеров с опциональным учетом приоритета слоев категорий.
 *
 * @param {Map<string, number>|null} [layerPriority=null] Карта приоритетов слоев (0 — наивысший приоритет).
 * @returns {(markerA: Object, markerB: Object) => number} Компаратор для сортировки маркеров.
 */
export function createMarkerPriorityComparator(layerPriority = null) {
    const hasLayerPriority = layerPriority instanceof Map;
    const fallbackPriority = hasLayerPriority ? layerPriority.size : 0;

    return function compareMarkers(markerA, markerB) {
        // 1. Приоритет ранга детализации: крупный ранг имеет меньший индекс (0 для century)
        const rankA = RANK_PRIORITY_INDEX[markerA.event?.rank] ?? 99;
        const rankB = RANK_PRIORITY_INDEX[markerB.event?.rank] ?? 99;
        if (rankA !== rankB) {
            return rankA - rankB;
        }

        // 2. Индекс приоритета слоя внутри одного ранга детализации
        if (hasLayerPriority) {
            const catA = normalizeCategoryId(markerA.event?.category);
            const catB = normalizeCategoryId(markerB.event?.category);
            const priorityA = catA && layerPriority.has(catA) ? layerPriority.get(catA) : fallbackPriority;
            const priorityB = catB && layerPriority.has(catB) ? layerPriority.get(catB) : fallbackPriority;
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
        }

        // 3. Экранная ширина габарита: более протяженные события имеют преимущество
        const widthA = markerA.widthPx || 0;
        const widthB = markerB.widthPx || 0;
        if (widthA !== widthB) {
            return widthB - widthA;
        }

        // 4. Хронологическое начало: более ранние события размещаются первыми
        const startA = markerA.event?.start_date ?? 0;
        const startB = markerB.event?.start_date ?? 0;
        if (startA !== startB) {
            return startA - startB;
        }

        // 5. Идентификатор сущности: обеспечивает строгую детерминированность сортировки
        const idA = markerA.event?.id ?? 0;
        const idB = markerB.event?.id ?? 0;
        return idA - idB;
    };
}

/**
 * Сравнение приоритета двух маркеров по умолчанию без учета приоритета слоев.
 * Экспортируется для сохранения обратной совместимости интерфейса модуля.
 *
 * @param {Object} markerA Первый маркер.
 * @param {Object} markerB Второй маркер.
 * @returns {number} Отрицательное число, если маркер A приоритетнее B.
 */
export const compareMarkersByPriority = createMarkerPriorityComparator(null);

/**
 * Расчет геометрической вместимости и параметров вертикальных дорожек маркеров.
 * Базовая линия дорожек (baseY) отсчитывается вверх от оси времени.
 *
 * @param {number} canvasHeightPx Полная высота холста Canvas в логических пикселях.
 * @returns {Readonly<{
 *   axisY: number,
 *   baseY: number,
 *   availableHeight: number,
 *   maxLanes: number,
 *   topPadding: number
 * }>} Замороженный объект геометрических лимитов области компоновки.
 */
export function calculateMarkerLanesCapacity(canvasHeightPx) {
    const safeHeight = typeof canvasHeightPx === 'number' && canvasHeightPx > 0
        ? canvasHeightPx
        : TIMELINE_CANVAS_HEIGHT_PX;

    // Базовая линия горизонтальной оси времени (65% высоты холста)
    const axisY = Math.floor(safeHeight * AXIS_POSITION_RATIO);

    // Опорная координата нижней границы полосы дорожек над осью
    const baseY = axisY - MARKER_OFFSET_FROM_AXIS;

    // Доступная вертикальная высота для размещения полос дорожек маркеров
    const availableHeight = Math.max(0, baseY - MARKER_LANES_TOP_PADDING_PX);

    // Максимально допустимое число дорожек с учетом минимальной высоты и зазоров
    const maxLanes = Math.max(
        1,
        Math.floor((availableHeight + LANE_VERTICAL_GAP_PX) / (LANE_MIN_HEIGHT_PX + LANE_VERTICAL_GAP_PX))
    );

    return Object.freeze({
        axisY,
        baseY,
        availableHeight,
        maxLanes,
        topPadding: MARKER_LANES_TOP_PADDING_PX,
    });
}

/**
 * Расчет динамической высоты дорожки на основе фактически занятых дорожек и доступной высоты.
 *
 * @param {number} usedLaneCount Количество занятых дорожек.
 * @param {number} availableHeight Доступная высота для размещения полосы.
 * @returns {number} Высота дорожки в пикселях, ограниченная диапазоном [LANE_MIN_HEIGHT_PX, LANE_MAX_HEIGHT_PX].
 */
export function calculateLaneHeight(usedLaneCount, availableHeight) {
    if (!usedLaneCount || usedLaneCount <= 0) {
        return LANE_MAX_HEIGHT_PX;
    }

    const rawHeight = Math.floor(
        (availableHeight - (usedLaneCount - 1) * LANE_VERTICAL_GAP_PX) / usedLaneCount
    );

    return Math.min(LANE_MAX_HEIGHT_PX, Math.max(LANE_MIN_HEIGHT_PX, rawHeight));
}

/**
 * Вычисление верхней координаты Y дорожки.
 * Дорожка с индексом 0 расположена ближе всего к оси, остальные поднимаются вверх.
 *
 * @param {number} laneIndex Индекс дорожки (0 — нижняя дорожка над осью).
 * @param {number} laneHeight Высота дорожки в пикселях.
 * @param {number} baseY Опорная базовая координата над осью.
 * @returns {number} Экранная координата Y верхней границы дорожки.
 */
export function computeLaneY(laneIndex, laneHeight, baseY) {
    return baseY - (laneIndex + 1) * laneHeight - laneIndex * LANE_VERTICAL_GAP_PX;
}

/**
 * Расчет координаты центра кругового бейджа агрегации скрытых потомков.
 *
 * @param {Object} marker Дескриптор маркера.
 * @param {number} canvasWidthPx Ширина холста в пикселях.
 * @returns {number|null} Горизонтальный центр бейджа в пикселях или null при отсутствии агрегата.
 */
export function computeAggregateBadgeCenterX(marker, canvasWidthPx) {
    const count = marker.event?.collapsed_children_count;
    if (typeof count !== 'number' || count < MIN_CHILDREN_FOR_AGGREGATE) {
        return null;
    }

    const isInterval = marker.isPoint !== true && typeof marker.widthPx === 'number' && marker.widthPx > 0;
    let centerX;

    if (isInterval) {
        // Определение видимого среза интервальной полосы на экране
        const visibleLeft = Math.max(0, marker.screenX);
        const visibleRight = Math.min(canvasWidthPx, marker.screenX + marker.widthPx);
        const visibleWidth = visibleRight - visibleLeft;

        if (visibleWidth > (2 * AGGREGATE_BADGE_RADIUS_PX + 4)) {
            // Если полоса достаточно широка, бейдж размещается внутри полосы у правого края
            centerX = visibleRight - AGGREGATE_BADGE_RADIUS_PX - 2;
        } else {
            // Если полоса узкая, бейдж выносится вправо наружу с отступом
            centerX = (marker.screenX + marker.widthPx) + AGGREGATE_BADGE_EDGE_PADDING_PX + AGGREGATE_BADGE_RADIUS_PX;
        }
    } else {
        // Для точечного маркера бейдж позиционируется справа от точки
        centerX = marker.screenX + MARKER_POINT_RADIUS + AGGREGATE_BADGE_EDGE_PADDING_PX + AGGREGATE_BADGE_RADIUS_PX;
    }

    // Ограничение координат центра в пределах видимой области холста
    centerX = Math.max(
        AGGREGATE_BADGE_RADIUS_PX,
        Math.min(canvasWidthPx - AGGREGATE_BADGE_RADIUS_PX, centerX)
    );

    return Math.round(centerX);
}

/**
 * Вычисление горизонтальных экранных габаритов маркера с учетом бейджа агрегата и зазоров безопасности.
 *
 * @param {Object} marker Дескриптор маркера.
 * @param {number} [canvasWidthPx=1000] Логическая ширина холста.
 * @returns {{ left: number, right: number, width: number }} Границы габарита для упаковки.
 */
export function computeMarkerLayoutBounds(marker, canvasWidthPx = 1000) {
    const isPoint = marker.isPoint === true || !marker.widthPx || marker.widthPx <= 0;
    let markerLeft;
    let markerRight;

    if (isPoint) {
        markerLeft = marker.screenX - MIN_EVENT_BAR_WIDTH_PX / 2;
        markerRight = marker.screenX + MIN_EVENT_BAR_WIDTH_PX / 2;
    } else {
        markerLeft = marker.screenX;
        markerRight = marker.screenX + marker.widthPx;
    }

    const badgeCenterX = computeAggregateBadgeCenterX(marker, canvasWidthPx);
    if (badgeCenterX !== null) {
        const badgeLeft = badgeCenterX - AGGREGATE_BADGE_RADIUS_PX;
        const badgeRight = badgeCenterX + AGGREGATE_BADGE_RADIUS_PX;
        const left = Math.min(markerLeft, badgeLeft);
        const right = Math.max(markerRight, badgeRight) + LANE_HORIZONTAL_GAP_PX;
        return { left, right, width: right - left };
    }

    const left = markerLeft;
    const right = markerRight + LANE_HORIZONTAL_GAP_PX;
    return { left, right, width: right - left };
}

/**
 * Головная функция расчета вертикальной компоновки маркеров таймлайна.
 *
 * @param {Array<Object>} markers Массив подготовленных проекций от prepareEventMarkers.
 * @param {number} canvasWidthPx Полная ширина холста Canvas в пикселях.
 * @param {number} canvasHeightPx Полная высота холста Canvas в пикселях.
 * @param {{
 *   previousLaneAssignments?: Map<number, number>,
 *   layerPriority?: Map<string, number>
 * }} [options={}] Дополнительные параметры компоновки.
 * @returns {Readonly<{
 *   placedMarkers: ReadonlyArray<Object>,
 *   overflowMarkers: ReadonlyArray<Object>,
 *   aggregateMarkers: ReadonlyArray<Object>,
 *   laneCount: number,
 *   laneHeight: number,
 *   evictedCount: number,
 *   laneAssignments: Map<number, number>
 * }>} Замороженный результат пространственной раскладки.
 */
export function computeTimelineLayout(markers, canvasWidthPx, canvasHeightPx, options = {}) {
    const safeWidth = typeof canvasWidthPx === 'number' && canvasWidthPx > 0
        ? canvasWidthPx
        : 1000;

    if (!Array.isArray(markers) || markers.length === 0) {
        return Object.freeze({
            placedMarkers: Object.freeze([]),
            overflowMarkers: Object.freeze([]),
            aggregateMarkers: Object.freeze([]),
            laneCount: 0,
            laneHeight: LANE_MAX_HEIGHT_PX,
            evictedCount: 0,
            laneAssignments: new Map(),
        });
    }

    // 1. Определение геометрической вместимости полосы дорожек
    const capacity = calculateMarkerLanesCapacity(canvasHeightPx);
    const { baseY, availableHeight, maxLanes } = capacity;

    // 2. Резервирование дорожек: при maxLanes >= 2 верхняя дорожка резервируется под переполнение
    const allowedLanesForMarkers = maxLanes >= 2 ? maxLanes - 1 : maxLanes;
    const overflowLaneIndex = maxLanes >= 2 ? maxLanes - 1 : 0;

    // 3. Сортировка маркеров по приоритету с учетом переданных весов слоев
    const comparator = createMarkerPriorityComparator(
        options.layerPriority instanceof Map ? options.layerPriority : null
    );
    const sortedCandidates = [...markers].sort(comparator);

    // 4. Жадное распределение по дорожкам с учетом закрепления дорожек между кадрами
    const lanes = Array.from({ length: allowedLanesForMarkers }, () => []);
    const previousAssignments = options.previousLaneAssignments instanceof Map
        ? options.previousLaneAssignments
        : null;

    const placedMarkersData = [];
    const evictedMarkers = [];

    function canPlaceInLane(lIdx, bounds) {
        const laneItems = lanes[lIdx];
        for (let j = 0; j < laneItems.length; j++) {
            const placedBounds = laneItems[j].bounds;
            if (bounds.left < placedBounds.right && bounds.right > placedBounds.left) {
                return false;
            }
        }
        return true;
    }

    for (let i = 0; i < sortedCandidates.length; i++) {
        const candidate = sortedCandidates[i];
        const candBounds = computeMarkerLayoutBounds(candidate, safeWidth);

        let targetLane = -1;

        // Попытка закрепить маркер за дорожкой из предыдущего кадра
        if (candidate.event?.id !== undefined && previousAssignments?.has(candidate.event.id)) {
            const prev = previousAssignments.get(candidate.event.id);
            if (prev >= 0 && prev < allowedLanesForMarkers && canPlaceInLane(prev, candBounds)) {
                targetLane = prev;
            }
        }

        // Если закрепленная дорожка недоступна или занята, ищем первую свободную снизу вверх
        if (targetLane === -1) {
            for (let lIdx = 0; lIdx < allowedLanesForMarkers; lIdx++) {
                if (canPlaceInLane(lIdx, candBounds)) {
                    targetLane = lIdx;
                    break;
                }
            }
        }

        if (targetLane !== -1) {
            lanes[targetLane].push({ marker: candidate, bounds: candBounds });
            placedMarkersData.push({ marker: candidate, laneIndex: targetLane });
        } else {
            evictedMarkers.push(candidate);
        }
    }

    // 5. Расчет фактически задействованных дорожек и высоты
    const hasOverflow = evictedMarkers.length > 0;
    const maxPlacedLane = placedMarkersData.length > 0
        ? Math.max(...placedMarkersData.map((p) => p.laneIndex))
        : -1;

    let usedLaneCount = 0;
    if (hasOverflow && maxLanes >= 2) {
        usedLaneCount = Math.max(maxPlacedLane + 1, overflowLaneIndex + 1);
    } else {
        usedLaneCount = maxPlacedLane >= 0 ? maxPlacedLane + 1 : (hasOverflow ? 1 : 0);
    }

    const laneHeight = calculateLaneHeight(usedLaneCount, availableHeight);

    // 6. Построение массива placedMarkers
    const placedMarkers = [];
    for (let i = 0; i < placedMarkersData.length; i++) {
        const { marker, laneIndex } = placedMarkersData[i];
        const laneY = computeLaneY(laneIndex, laneHeight, baseY);
        placedMarkers.push({
            event: marker.event,
            screenX: marker.screenX,
            widthPx: marker.widthPx,
            isPoint: marker.isPoint,
            themeVariable: marker.themeVariable,
            laneIndex,
            laneY,
            laneHeight,
        });
    }

    // 7. Построение массива aggregateMarkers для размещенных маркеров
    const aggregateMarkers = [];
    for (let i = 0; i < placedMarkers.length; i++) {
        const pm = placedMarkers[i];
        const badgeCenterX = computeAggregateBadgeCenterX(pm, safeWidth);
        if (badgeCenterX !== null) {
            aggregateMarkers.push({
                type: 'aggregate',
                parentId: pm.event.id,
                count: pm.event.collapsed_children_count,
                screenX: badgeCenterX,
                laneIndex: pm.laneIndex,
                laneY: pm.laneY,
                laneHeight: pm.laneHeight,
                event: pm.event,
                themeVariable: pm.themeVariable,
            });
        }
    }

    // 8. Кластеризация вытесненных маркеров и построение overflowMarkers
    const overflowMarkers = [];
    if (evictedMarkers.length > 0) {
        const evictedWithCoords = evictedMarkers.map((marker) => {
            const rawLeft = marker.screenX;
            const visibleLeft = Math.max(0, Math.min(safeWidth - OVERFLOW_BADGE_WIDTH_PX, rawLeft));
            return { marker, visibleLeft };
        });

        evictedWithCoords.sort((a, b) => a.visibleLeft - b.visibleLeft);

        const clusters = [];
        for (let i = 0; i < evictedWithCoords.length; i++) {
            const item = evictedWithCoords[i];
            const lastCluster = clusters[clusters.length - 1];

            if (
                !lastCluster ||
                (item.visibleLeft - lastCluster.startX) >= (OVERFLOW_BADGE_WIDTH_PX + LANE_HORIZONTAL_GAP_PX)
            ) {
                clusters.push({
                    startX: item.visibleLeft,
                    markers: [item.marker],
                });
            } else {
                lastCluster.markers.push(item.marker);
            }
        }

        const overflowLaneY = computeLaneY(overflowLaneIndex, laneHeight, baseY);
        for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i];
            overflowMarkers.push({
                type: 'overflow',
                screenX: cluster.startX,
                widthPx: OVERFLOW_BADGE_WIDTH_PX,
                count: cluster.markers.length,
                laneIndex: overflowLaneIndex,
                laneY: overflowLaneY,
                laneHeight,
                evictedEvents: cluster.markers.map((m) => m.event),
            });
        }
    }

    // 9. Формирование карты распределения дорожек
    const laneAssignments = new Map();
    for (let i = 0; i < placedMarkers.length; i++) {
        const pm = placedMarkers[i];
        if (pm.event?.id !== undefined) {
            laneAssignments.set(pm.event.id, pm.laneIndex);
        }
    }

    // 10. Заморозка и возврат результирующего дескриптора компоновки
    return Object.freeze({
        placedMarkers: Object.freeze(placedMarkers.map((m) => Object.freeze(m))),
        overflowMarkers: Object.freeze(overflowMarkers.map((m) => Object.freeze(m))),
        aggregateMarkers: Object.freeze(aggregateMarkers.map((m) => Object.freeze(m))),
        laneCount: usedLaneCount,
        laneHeight,
        evictedCount: evictedMarkers.length,
        laneAssignments,
    });
}
