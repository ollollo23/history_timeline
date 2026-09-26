/**
 * Модульные тесты пространственной детекции попадания курсора (Hit-Testing).
 * Проверяет попадание в интервальные и точечные маркеры, допуск погрешности,
 * разрешение наложений по площади и строгий приоритет интерактивных целей.
 */

import { describe, it, expect } from 'vitest';
import {
    findMarkerAtPoint,
    findOverflowAtPoint,
    findAggregateAtPoint,
    resolveCursorTarget,
} from '../../frontend/js/timeline/hitTest.js';
import {
    HIT_TEST_TOLERANCE_PX,
    MARKER_POINT_RADIUS,
    OVERFLOW_BADGE_WIDTH_PX,
    AGGREGATE_BADGE_RADIUS_PX,
} from '../../frontend/js/timeline/constants.js';

/**
 * Вспомогательная фабрика для сборки тестового объекта раскладки.
 *
 * @param {Array<Object>} [placedMarkers=[]] Размещенные маркеры событий.
 * @param {Array<Object>} [overflowMarkers=[]] Маркеры переполнения.
 * @param {Array<Object>} [aggregateMarkers=[]] Бейджи агрегатов потомков.
 * @returns {{ placedMarkers: Array<Object>, overflowMarkers: Array<Object>, aggregateMarkers: Array<Object> }}
 */
function createTestLayout(placedMarkers = [], overflowMarkers = [], aggregateMarkers = []) {
    return {
        placedMarkers,
        overflowMarkers,
        aggregateMarkers,
    };
}

/**
 * Вспомогательная фабрика создания дескриптора размещенного маркера.
 *
 * @param {number} id Идентификатор события.
 * @param {number} screenX Экранная координата X.
 * @param {number} widthPx Экранная ширина маркера.
 * @param {boolean} isPoint Флаг точечного маркера.
 * @param {number} [laneY=20] Вертикальная координата дорожки.
 * @param {number} [laneHeight=16] Высота дорожки.
 * @returns {Object} Дескриптор маркера.
 */
function createPlacedMarker(id, screenX, widthPx, isPoint, laneY = 20, laneHeight = 16) {
    return {
        event: {
            id,
            title: `Событие ${id}`,
            rank: 'year',
        },
        screenX,
        widthPx,
        isPoint,
        laneIndex: 0,
        laneY,
        laneHeight,
        themeVariable: '--color-category-science',
    };
}

describe('Модуль детекции попадания hitTest.js', () => {
    it('Сценарий 1: точка внутри прямоугольника интервального маркера возвращает его дескриптор', () => {
        const marker = createPlacedMarker(1, 100, 200, false, 20, 16);
        const layout = createTestLayout([marker]);

        // Точка строго внутри прямоугольника [100..300] по X и [20..36] по Y
        const result = findMarkerAtPoint(layout, 150, 28);

        expect(result).not.toBeNull();
        expect(result.event.id).toBe(1);
    });

    it('Сценарий 2: точка на расстоянии допуска снаружи возвращает маркер', () => {
        const marker = createPlacedMarker(1, 100, 200, false, 20, 16);
        const layout = createTestLayout([marker]);

        // Границы с допуском 4px: X в [96..304], Y в [16..40]
        // Проверка граничных точек с отступом 3px от границ маркера
        const leftHit = findMarkerAtPoint(layout, 97, 28, HIT_TEST_TOLERANCE_PX);
        const rightHit = findMarkerAtPoint(layout, 303, 28, HIT_TEST_TOLERANCE_PX);
        const topHit = findMarkerAtPoint(layout, 150, 17, HIT_TEST_TOLERANCE_PX);
        const bottomHit = findMarkerAtPoint(layout, 150, 39, HIT_TEST_TOLERANCE_PX);

        expect(leftHit).not.toBeNull();
        expect(leftHit.event.id).toBe(1);

        expect(rightHit).not.toBeNull();
        expect(rightHit.event.id).toBe(1);

        expect(topHit).not.toBeNull();
        expect(topHit.event.id).toBe(1);

        expect(bottomHit).not.toBeNull();
        expect(bottomHit.event.id).toBe(1);
    });

    it('Сценарий 3: точка за пределами допуска возвращает null', () => {
        const marker = createPlacedMarker(1, 100, 200, false, 20, 16);
        const layout = createTestLayout([marker]);

        // Проверка точек с отступом 6px от границ (превышает допуск 4px)
        const leftMiss = findMarkerAtPoint(layout, 94, 28, HIT_TEST_TOLERANCE_PX);
        const rightMiss = findMarkerAtPoint(layout, 306, 28, HIT_TEST_TOLERANCE_PX);
        const topMiss = findMarkerAtPoint(layout, 150, 13, HIT_TEST_TOLERANCE_PX);
        const bottomMiss = findMarkerAtPoint(layout, 150, 43, HIT_TEST_TOLERANCE_PX);

        expect(leftMiss).toBeNull();
        expect(rightMiss).toBeNull();
        expect(topMiss).toBeNull();
        expect(bottomMiss).toBeNull();
    });

    it('Сценарий 4: при наложении точечного маркера на интервальный возвращается точечный маркер', () => {
        // Интервальный маркер с большой площадью: 400 * 16 = 6400 px^2
        const intervalMarker = createPlacedMarker(1, 100, 400, false, 20, 16);

        // Точечный маркер с малой площадью: pi * 4^2 ≈ 50.26 px^2
        const pointMarker = createPlacedMarker(2, 250, 0, true, 20, 16);

        const layout = createTestLayout([intervalMarker, pointMarker]);

        // Клик в точку центра точечного маркера: X = 250, Y = 20 + 16 / 2 = 28
        const result = findMarkerAtPoint(layout, 250, 28);

        // Должен быть выбран точечный маркер id=2 благодаря меньшей площади
        expect(result).not.toBeNull();
        expect(result.event.id).toBe(2);
        expect(result.isPoint).toBe(true);
    });

    it('Сценарий 5: соблюдение приоритета целей в resolveCursorTarget (агрегат -> переполнение -> маркер)', () => {
        const aggregate = {
            type: 'aggregate',
            parentId: 1,
            count: 3,
            screenX: 100,
            laneY: 20,
            laneHeight: 16,
        };

        const overflow = {
            type: 'overflow',
            count: 5,
            screenX: 100,
            widthPx: OVERFLOW_BADGE_WIDTH_PX,
            laneY: 20,
            laneHeight: 16,
            evictedEvents: [],
        };

        const marker = createPlacedMarker(10, 100, 100, false, 20, 16);

        // Шаг А: Все три цели присутствуют в точке (100, 28) -> побеждает агрегат
        const fullLayout = createTestLayout([marker], [overflow], [aggregate]);
        const targetA = resolveCursorTarget(fullLayout, 100, 28);
        expect(targetA).not.toBeNull();
        expect(targetA.type).toBe('aggregate');
        expect(targetA.parentId).toBe(1);

        // Шаг Б: Агрегаты отсутствуют -> побеждает маркер переполнения
        const noAggregateLayout = createTestLayout([marker], [overflow], []);
        const targetB = resolveCursorTarget(noAggregateLayout, 100, 28);
        expect(targetB).not.toBeNull();
        expect(targetB.type).toBe('overflow');
        expect(targetB.count).toBe(5);

        // Шаг В: Агрегаты и переполнение отсутствуют -> возвращается маркер события
        const markerOnlyLayout = createTestLayout([marker], [], []);
        const targetC = resolveCursorTarget(markerOnlyLayout, 100, 28);
        expect(targetC).not.toBeNull();
        expect(targetC.event.id).toBe(10);
    });

    it('Сценарий 6: пустая или невалидная раскладка возвращает null без исключения', () => {
        const invalidLayouts = [
            null,
            undefined,
            {},
            { placedMarkers: null },
            { placedMarkers: [], overflowMarkers: [], aggregateMarkers: [] },
        ];

        for (const layout of invalidLayouts) {
            expect(findMarkerAtPoint(layout, 100, 100)).toBeNull();
            expect(findOverflowAtPoint(layout, 100, 100)).toBeNull();
            expect(findAggregateAtPoint(layout, 100, 100)).toBeNull();
            expect(resolveCursorTarget(layout, 100, 100)).toBeNull();
        }
    });

    it('Вспомогательные проверки детекции точечных маркеров и бейджей', () => {
        // Проверка точечного маркера: попадание в радиус с допуском
        const pointMarker = createPlacedMarker(5, 50, 0, true, 30, 20);
        const layoutPoint = createTestLayout([pointMarker]);

        // Центр круга: X = 50, Y = 30 + 10 = 40. Радиус = 4 + 4 = 8px
        expect(findMarkerAtPoint(layoutPoint, 50, 40)).not.toBeNull();
        expect(findMarkerAtPoint(layoutPoint, 56, 40)).not.toBeNull(); // dist = 6 <= 8
        expect(findMarkerAtPoint(layoutPoint, 60, 40)).toBeNull(); // dist = 10 > 8

        // Проверка поиска агрегата
        const aggregate = {
            type: 'aggregate',
            parentId: 2,
            count: 4,
            screenX: 80,
            laneY: 10,
            laneHeight: 20,
        };
        const layoutAgg = createTestLayout([], [], [aggregate]);
        // Центр: (80, 20), радиус: AGGREGATE_BADGE_RADIUS_PX (7) + 4 = 11px
        expect(findAggregateAtPoint(layoutAgg, 80, 20)).not.toBeNull();
        expect(findAggregateAtPoint(layoutAgg, 90, 20)).not.toBeNull(); // dist = 10 <= 11
        expect(findAggregateAtPoint(layoutAgg, 95, 20)).toBeNull(); // dist = 15 > 11
        expect(AGGREGATE_BADGE_RADIUS_PX).toBe(7);
        expect(MARKER_POINT_RADIUS).toBe(4);
    });
});
