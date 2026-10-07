/**
 * Модульные тесты математического ядра вертикальной компоновки временной шкалы (layout.js).
 * Проверяет расчет вместимости и динамической высоты дорожек, инвертированные координаты Y,
 * независимое размещение потомков, позиционирование бейджей скрытых потомков,
 * расширенные границы коллизий, стресс-компоновку переполнения, закрепление дорожек,
 * приоритет слоев категорий и регрессионный сброс привязок при изменении порядка слоев.
 */

import { describe, it, expect } from 'vitest';
import {
    calculateMarkerLanesCapacity,
    calculateLaneHeight,
    computeLaneY,
    computeAggregateBadgeCenterX,
    computeMarkerLayoutBounds,
    compareMarkersByPriority,
    computeTimelineLayout,
    EVENT_RANKS_ORDERED,
} from '../../frontend/js/timeline/layout.js';
import {
    createDefaultLayerState,
    moveLayer,
    buildLayerPriority,
} from '../../frontend/js/timeline/layers.js';
import {
    LANE_MIN_HEIGHT_PX,
    LANE_MAX_HEIGHT_PX,
    LANE_VERTICAL_GAP_PX,
    MARKER_LANES_TOP_PADDING_PX,
    TIMELINE_CANVAS_HEIGHT_PX,
} from '../../frontend/js/timeline/constants.js';

/**
 * Вспомогательная фабрика для сборки геометрического дескриптора маркера в тестах.
 *
 * @param {number} id Идентификатор события.
 * @param {number} screenX Экранная координата X.
 * @param {number} widthPx Экранная ширина маркера.
 * @param {Object} [options={}] Дополнительные атрибуты сущности.
 * @returns {Object} Дескриптор маркера.
 */
function createTestMarker(id, screenX, widthPx, options = {}) {
    return {
        event: {
            id,
            title: options.title || `Событие ${id}`,
            rank: options.rank || 'year',
            category: options.category || 'science',
            start_date: options.startDate ?? 1000,
            parent_id: options.parentId ?? null,
            collapsed_children_count: options.collapsedChildrenCount ?? 0,
        },
        screenX,
        widthPx,
        isPoint: options.isPoint ?? (widthPx === 0),
        themeVariable:
            options.themeVariable ||
            (options.category
                ? '--color-category-' + options.category
                : '--color-category-science'),
    };
}

describe('Модуль вертикальной компоновки layout.js', () => {
    describe('Расчет вместимости полосы дорожек (calculateMarkerLanesCapacity)', () => {
        it('рассчитывает эталонные параметры при базовой высоте холста 440 px', () => {
            const capacity = calculateMarkerLanesCapacity(440);

            // axisY = Math.floor(440 * 0.65) = 286
            expect(capacity.axisY).toBe(286);
            // baseY = 286 - 28 = 258
            expect(capacity.baseY).toBe(258);
            // availableHeight = 258 - 24 = 234
            expect(capacity.availableHeight).toBe(234);
            // maxLanes = Math.floor((234 + 4) / (12 + 4)) = 14
            expect(capacity.maxLanes).toBe(14);
            expect(capacity.topPadding).toBe(24);
            expect(Object.isFrozen(capacity)).toBe(true);
        });

        it('использует запасную высоту TIMELINE_CANVAS_HEIGHT_PX при невалидных входных параметрах', () => {
            const fallbackCapacity = calculateMarkerLanesCapacity(TIMELINE_CANVAS_HEIGHT_PX);

            expect(calculateMarkerLanesCapacity()).toEqual(fallbackCapacity);
            expect(calculateMarkerLanesCapacity(null)).toEqual(fallbackCapacity);
            expect(calculateMarkerLanesCapacity(0)).toEqual(fallbackCapacity);
            expect(calculateMarkerLanesCapacity(-100)).toEqual(fallbackCapacity);
        });
    });

    describe('Расчет динамической высоты дорожки (calculateLaneHeight)', () => {
        it('возвращает максимальную высоту LANE_MAX_HEIGHT_PX при 1 занятой дорожке', () => {
            expect(calculateLaneHeight(1, 234)).toBe(LANE_MAX_HEIGHT_PX);
            expect(calculateLaneHeight(1, 234)).toBe(22);
        });

        it('возвращает максимальную высоту при 0 занятых дорожек', () => {
            expect(calculateLaneHeight(0, 234)).toBe(LANE_MAX_HEIGHT_PX);
            expect(calculateLaneHeight(0, 234)).toBe(22);
        });

        it('ограничивает высоту нижним пределом LANE_MIN_HEIGHT_PX при 14 дорожках на сжатой высоте 220 px', () => {
            // rawHeight = Math.floor((220 - 13 * 4) / 14) = Math.floor(168 / 14) = 12
            expect(calculateLaneHeight(14, 220)).toBe(LANE_MIN_HEIGHT_PX);
            expect(calculateLaneHeight(14, 220)).toBe(12);
        });

        it('вычисляет пропорциональную высоту 13 px при 14 дорожках на высоте 234 px', () => {
            // rawHeight = Math.floor((234 - 13 * 4) / 14) = Math.floor(182 / 14) = 13
            expect(calculateLaneHeight(14, 234)).toBe(13);
        });
    });

    describe('Вертикальные координаты дорожек (computeLaneY)', () => {
        const baseY = 258;
        const laneHeight = 13;

        it('размещает дорожку 0 ближе всего к базовой оси nad горизонтальной шкалой', () => {
            // baseY - (0 + 1) * 13 - 0 * 4 = 258 - 13 = 245
            expect(computeLaneY(0, laneHeight, baseY)).toBe(245);
        });

        it('размещает верхнюю дорожку 13 строго без захода выше topPadding (24 px)', () => {
            // baseY - 14 * 13 - 13 * 4 = 258 - 182 - 52 = 24
            const topLaneY = computeLaneY(13, laneHeight, baseY);
            expect(topLaneY).toBe(24);
            expect(topLaneY).toBeGreaterThanOrEqual(MARKER_LANES_TOP_PADDING_PX);
        });

        it('поддерживает строгий зазор LANE_VERTICAL_GAP_PX между смежными дорожками', () => {
            const lane0Y = computeLaneY(0, laneHeight, baseY);
            const lane1Y = computeLaneY(1, laneHeight, baseY);

            // Разность верхних границ минус высота дорожки равна зазору
            expect(lane0Y - lane1Y - laneHeight).toBe(LANE_VERTICAL_GAP_PX);
            expect(lane0Y - lane1Y - laneHeight).toBe(4);
        });
    });

    describe('Раздельное размещение родителя и потомков без клиентской фильтрации', () => {
        it('размещает родительское событие и потомков как независимые маркеры', () => {
            const parent = createTestMarker(1, 100, 400, { rank: 'century' });
            const child1 = createTestMarker(2, 150, 20, { rank: 'minute', parentId: 1 });
            const child2 = createTestMarker(3, 250, 20, { rank: 'minute', parentId: 1 });

            const result = computeTimelineLayout([parent, child1, child2], 1000, 440);

            // Все 3 маркера размещаются на дорожках независимо
            expect(result.placedMarkers).toHaveLength(3);
            expect(result.aggregateMarkers).toHaveLength(0);
            expect(result.evictedCount).toBe(0);

            const placedIds = result.placedMarkers.map((m) => m.event.id).sort();
            expect(placedIds).toEqual([1, 2, 3]);
        });
    });

    describe('Позиционирование бейджа агрегации потомков', () => {
        it('формирует бейдж агрегации внутри видимого интервала родителя при collapsed_children_count >= 1', () => {
            const parent = createTestMarker(10, 100, 300, {
                rank: 'century',
                collapsedChildrenCount: 3,
            });

            const result = computeTimelineLayout([parent], 1000, 440);

            expect(result.aggregateMarkers).toHaveLength(1);
            const badge = result.aggregateMarkers[0];
            expect(badge.parentId).toBe(10);
            expect(badge.count).toBe(3);
            expect(badge.laneIndex).toBe(result.placedMarkers[0].laneIndex);
            expect(badge.laneY).toBe(result.placedMarkers[0].laneY);

            // Центр бейджа находится внутри полосы родителя [100, 400]
            expect(badge.screenX).toBeGreaterThanOrEqual(100);
            expect(badge.screenX).toBeLessThanOrEqual(400);
        });

        it('не создает бейдж агрегации при нулевом или отсутствующем значении collapsed_children_count', () => {
            const mZero = createTestMarker(1, 100, 200, { collapsedChildrenCount: 0 });
            const mNull = createTestMarker(2, 400, 200, { collapsedChildrenCount: null });

            const result = computeTimelineLayout([mZero, mNull], 1000, 440);
            expect(result.aggregateMarkers).toHaveLength(0);
        });

        it('выносит бейдж вправо за пределы маркера при узкой интервальной полосе', () => {
            const narrowMarker = createTestMarker(1, 100, 10, { collapsedChildrenCount: 2 });
            const badgeX = computeAggregateBadgeCenterX(narrowMarker, 1000);

            // Правый край маркера = 110, вынос вправо с отступом и радиусом: 110 + 2 + 7 = 119
            expect(badgeX).toBe(119);
        });
    });

    describe('Резервирование габаритов точечным маркером с бейджем', () => {
        it('учитывает вынос бейджа агрегации вправо при расчете коллизий точечного маркера', () => {
            // point1 с бейджем агрегации: screenX = 100, бейдж сдвинут вправо до ~113 px
            const point1 = createTestMarker(1, 100, 0, {
                isPoint: true,
                collapsedChildrenCount: 5,
            });

            // point2 без бейджа: screenX = 115 px попадает в зону безопасности point1 + бейдж
            const point2 = createTestMarker(2, 115, 0, {
                isPoint: true,
                collapsedChildrenCount: 0,
            });

            const result = computeTimelineLayout([point1, point2], 1000, 440);

            // Из-за коллизии с бейджем point2 вытесняется на следующую дорожку 1
            expect(result.placedMarkers[0].laneIndex).toBe(0);
            expect(result.placedMarkers[1].laneIndex).toBe(1);
            expect(result.laneCount).toBe(2);
        });
    });

    describe('Стресс-тест 500 маркеров и свойства бейджей переполнения', () => {
        it('сохраняет инвариант общего числа элементов и изолирует бейджи переполнения на верхней дорожке', () => {
            // Генерация 500 сильно пересекающихся маркеров
            const markers = [];
            for (let i = 0; i < 500; i++) {
                markers.push(
                    createTestMarker(i + 1, (i * 7) % 800, 100, { rank: 'year' })
                );
            }

            const canvasWidth = 1000;
            const canvasHeight = 440;
            const result = computeTimelineLayout(markers, canvasWidth, canvasHeight);

            // а) Инвариант сохранения данных: сумма размещенных и вытесненных строго равна 500
            const overflowTotal = result.overflowMarkers.reduce((sum, b) => sum + b.count, 0);
            expect(result.placedMarkers.length + overflowTotal).toBe(500);
            expect(result.evictedCount).toBe(overflowTotal);

            // б) Бейджи переполнения не пересекаются между собой и укладываются в границы холста
            expect(result.overflowMarkers.length).toBeGreaterThan(0);

            for (const badge of result.overflowMarkers) {
                expect(badge.screenX).toBeGreaterThanOrEqual(0);
                expect(badge.screenX + badge.widthPx).toBeLessThanOrEqual(canvasWidth);
            }

            const sortedBadges = [...result.overflowMarkers].sort((a, b) => a.screenX - b.screenX);
            for (let i = 0; i < sortedBadges.length - 1; i++) {
                expect(sortedBadges[i].screenX + sortedBadges[i].widthPx).toBeLessThanOrEqual(
                    sortedBadges[i + 1].screenX
                );
            }

            // в) Резервирование дорожки: все бейджи переполнения размещены на зарезервированной дорожке 13,
            // а все обычные маркеры — строго на дорожках 0..12
            expect(result.overflowMarkers.every((b) => b.laneIndex === 13)).toBe(true);
            expect(result.placedMarkers.every((m) => m.laneIndex <= 12)).toBe(true);
        });
    });

    describe('Закрепление дорожек (previousLaneAssignments)', () => {
        it('сохраняет ранее назначенные дорожки маркеров между кадрами панорамирования', () => {
            const m1 = createTestMarker(1, 100, 100, { rank: 'year' });
            const m2 = createTestMarker(2, 100, 100, { rank: 'year' });
            const m3 = createTestMarker(3, 100, 100, { rank: 'year' });

            // Первый прогон компоновки
            const res1 = computeTimelineLayout([m1, m2, m3], 1000, 440);
            const assignments = res1.laneAssignments;

            expect(assignments.size).toBe(3);

            // Второй прогон с перестановкой маркеров во входном массиве
            const res2 = computeTimelineLayout(
                [m3, m1, m2],
                1000,
                440,
                { previousLaneAssignments: assignments }
            );

            // Каждый маркер обязан сохранить свою первоначальную дорожку
            for (const placed of res2.placedMarkers) {
                expect(placed.laneIndex).toBe(assignments.get(placed.event.id));
            }
        });
    });

    describe('Синхронизация приоритетов рангов и вспомогательные функции', () => {
        it('содержит полный упорядоченный список рангов EventRank', () => {
            expect(EVENT_RANKS_ORDERED).toEqual([
                'century',
                'decade',
                'year',
                'month',
                'day',
                'hour',
                'minute',
                'second',
            ]);
        });

        it('отдает приоритет крупному масштабу и протяженным маркерам', () => {
            const centuryMarker = createTestMarker(1, 0, 50, { rank: 'century' });
            const secondMarker = createTestMarker(2, 0, 50, { rank: 'second' });

            // Ранг century имеет приоритет над second
            expect(compareMarkersByPriority(centuryMarker, secondMarker)).toBeLessThan(0);

            const wideYear = createTestMarker(3, 0, 200, { rank: 'year' });
            const narrowYear = createTestMarker(4, 0, 50, { rank: 'year' });

            // При равенстве рангов более протяженный маркер идет первым
            expect(compareMarkersByPriority(wideYear, narrowYear)).toBeLessThan(0);
        });

        it('корректно рассчитывает габариты маркеров через computeMarkerLayoutBounds', () => {
            const pointMarker = createTestMarker(1, 100, 0, { isPoint: true });
            const boundsPoint = computeMarkerLayoutBounds(pointMarker, 1000);

            // Точечный маркер центрируется: 100 - 2 = 98, правый край: 100 + 2 + 6 = 108
            expect(boundsPoint.left).toBe(98);
            expect(boundsPoint.right).toBe(108);

            const barMarker = createTestMarker(2, 100, 50);
            const boundsBar = computeMarkerLayoutBounds(barMarker, 1000);

            // Интервальный маркер: left = 100, right = 100 + 50 + 6 = 156
            expect(boundsBar.left).toBe(100);
            expect(boundsBar.right).toBe(156);
        });
    });

    describe('Приоритет слоев в компоновке (layerPriority)', () => {
        it('при конфликте в одном ранге ближе к оси встает маркер верхнего слоя', () => {
            const layerPriority = new Map([
                ['politics', 0],
                ['culture', 1],
            ]);

            const mCulture = createTestMarker(1, 100, 100, {
                rank: 'year',
                category: 'culture',
            });
            const mPolitics = createTestMarker(2, 100, 100, {
                rank: 'year',
                category: 'politics',
            });

            const result = computeTimelineLayout([mCulture, mPolitics], 1000, 440, {
                layerPriority,
            });

            const placedPolitics = result.placedMarkers.find((m) => m.event.id === 2);
            const placedCulture = result.placedMarkers.find((m) => m.event.id === 1);

            expect(placedPolitics.laneIndex).toBe(0);
            expect(placedCulture.laneIndex).toBe(1);
        });

        it('при разных рангах ранг побеждает независимо от слоя', () => {
            const layerPriority = new Map([
                ['politics', 0],
                ['culture', 1],
            ]);

            const mCentury = createTestMarker(1, 100, 100, {
                rank: 'century',
                category: 'culture',
            });
            const mDay = createTestMarker(2, 100, 100, {
                rank: 'day',
                category: 'politics',
            });

            const result = computeTimelineLayout([mDay, mCentury], 1000, 440, {
                layerPriority,
            });

            const placedCentury = result.placedMarkers.find((m) => m.event.id === 1);
            const placedDay = result.placedMarkers.find((m) => m.event.id === 2);

            expect(placedCentury.laneIndex).toBe(0);
            expect(placedDay.laneIndex).toBe(1);
        });

        it('неизвестная категория идет последней в своем ранге', () => {
            const layerPriority = new Map([
                ['politics', 0],
                ['culture', 1],
            ]);

            const mCulture = createTestMarker(1, 100, 100, {
                rank: 'year',
                category: 'culture',
            });
            const mUnknown = createTestMarker(2, 100, 100, {
                rank: 'year',
                category: 'unknown_custom_category',
            });

            const result = computeTimelineLayout([mUnknown, mCulture], 1000, 440, {
                layerPriority,
            });

            const placedCulture = result.placedMarkers.find((m) => m.event.id === 1);
            const placedUnknown = result.placedMarkers.find((m) => m.event.id === 2);

            expect(placedCulture.laneIndex).toBe(0);
            expect(placedUnknown.laneIndex).toBe(1);
        });

        it('без layerPriority порядок определяется базовыми правилами', () => {
            const m1 = createTestMarker(1, 100, 100, {
                rank: 'year',
                category: 'culture',
            });
            const m2 = createTestMarker(2, 100, 100, {
                rank: 'year',
                category: 'politics',
            });

            const result = computeTimelineLayout([m2, m1], 1000, 440);

            const placedM1 = result.placedMarkers.find((m) => m.event.id === 1);
            const placedM2 = result.placedMarkers.find((m) => m.event.id === 2);

            expect(placedM1.laneIndex).toBe(0);
            expect(placedM2.laneIndex).toBe(1);
            expect(compareMarkersByPriority(m1, m2)).toBeLessThan(0);
        });

        it('агрегат несет themeVariable родительского маркера', () => {
            const parent = createTestMarker(10, 100, 300, {
                rank: 'century',
                category: 'culture',
                themeVariable: '--color-category-culture',
                collapsedChildrenCount: 3,
            });

            const result = computeTimelineLayout([parent], 1000, 440);

            expect(result.aggregateMarkers).toHaveLength(1);
            expect(result.aggregateMarkers[0].themeVariable).toBe('--color-category-culture');
        });

        it('закрепление сохраняет раскладку после смены порядка, компоновка без закрепления переносит верхний слой к оси', () => {
            const mCulture = createTestMarker(1, 100, 500, {
                rank: 'year',
                category: 'culture',
                startDate: 100,
            });
            const mPolitics = createTestMarker(2, 200, 500, {
                rank: 'year',
                category: 'politics',
                startDate: 200,
            });

            // Этап 1. Компоновка с приоритетом слоев по умолчанию (культура 0, политика 1)
            const defaultState = createDefaultLayerState();
            const defaultPriority = buildLayerPriority(defaultState);
            const res1 = computeTimelineLayout([mCulture, mPolitics], 1200, 440, {
                layerPriority: defaultPriority,
            });

            expect(res1.placedMarkers.find((m) => m.event.id === 1).laneIndex).toBe(0);
            expect(res1.placedMarkers.find((m) => m.event.id === 2).laneIndex).toBe(1);

            // Этап 2. Смена порядка слоев с сохранением закрепления (политика 0, культура 1)
            const nextState = moveLayer(defaultState, 'politics', -1);
            const nextPriority = buildLayerPriority(nextState);

            const resWithStickiness = computeTimelineLayout([mCulture, mPolitics], 1200, 440, {
                layerPriority: nextPriority,
                previousLaneAssignments: res1.laneAssignments,
            });

            expect(resWithStickiness.placedMarkers.find((m) => m.event.id === 2).laneIndex).toBe(1);
            expect(resWithStickiness.placedMarkers.find((m) => m.event.id === 1).laneIndex).toBe(0);

            // Этап 3. Та же компоновка без закрепления (сброс привязок дорожек)
            const resWithoutStickiness = computeTimelineLayout([mCulture, mPolitics], 1200, 440, {
                layerPriority: nextPriority,
            });

            expect(resWithoutStickiness.placedMarkers.find((m) => m.event.id === 2).laneIndex).toBe(0);
            expect(resWithoutStickiness.placedMarkers.find((m) => m.event.id === 1).laneIndex).toBe(1);
        });
    });
});
