/**
 * Модульные тесты функций позиционирования камеры и фокусировки на событиях (focus.js).
 * Проверяет адаптивный пошаговый подбор масштаба zoomIndex для всех восьми рангов детализации,
 * неизменность масштаба при уже видимом ранге, расчет хронологического центра
 * для точечных и интервальных событий, а также устойчивость к невалидным аргументам во фреймворке Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
    findZoomIndexForRank,
    computeFocusViewport,
} from '../../frontend/js/timeline/focus.js';
import { MAX_SECONDS_PER_PIXEL } from '../../frontend/js/timeline/constants.js';
import {
    calculateVisibleDuration,
    secondsPerPixelToZoomIndex,
    zoomIndexToSecondsPerPixel,
} from '../../frontend/js/timeline/scale.js';
import { getActiveLadderLevel } from '../../frontend/js/timeline/ticks.js';
import { getRanksForUnit } from '../../frontend/js/timeline/rankMapping.js';
import { createViewportState } from '../../frontend/js/timeline/viewport.js';

describe('Модуль фокусировки камеры focus.js', () => {
    describe('Подбор масштаба от максимального отдаления для всех восьми рангов', () => {
        const maxZoomIndex = secondsPerPixelToZoomIndex(MAX_SECONDS_PER_PIXEL);
        const ranks = [
            'century',
            'decade',
            'year',
            'month',
            'day',
            'hour',
            'minute',
            'second',
        ];

        ranks.forEach((rank) => {
            it(`находит корректный масштаб детализации для ранга "${rank}"`, () => {
                const targetZoom = findZoomIndexForRank(rank, maxZoomIndex);

                // Масштаб обязан приближаться (уменьшаться) либо оставаться прежним, отдаление запрещено
                expect(targetZoom).toBeLessThanOrEqual(maxZoomIndex);

                // Целевой ранг гарантированно отображается на найденном делении сетки
                const level = getActiveLadderLevel({ zoomIndex: targetZoom });
                const visibleRanks = getRanksForUnit(level.unit);
                expect(visibleRanks).toContain(rank);
            });
        });
    });

    describe('Неизменность масштаба при уже включенном ранге', () => {
        const maxZoomIndex = secondsPerPixelToZoomIndex(MAX_SECONDS_PER_PIXEL);

        it('сохраняет maxZoomIndex для ранга century, так как он уже виден при максимальном отдалении', () => {
            expect(findZoomIndexForRank('century', maxZoomIndex)).toBe(maxZoomIndex);
        });

        it('не меняет масштаб, если ранг уже активен на текущем zoomIndex', () => {
            const dayZoom = findZoomIndexForRank('day', maxZoomIndex);
            // Повторный вызов для уже активного ранга возвращает текущий масштаб без изменений
            expect(findZoomIndexForRank('day', dayZoom)).toBe(dayZoom);
        });

        it('не мутирует zoomIndex в computeFocusViewport, если ранг события уже отображается', () => {
            const dayZoom = findZoomIndexForRank('day', maxZoomIndex);
            const state = createViewportState(0, dayZoom, 1000);
            const event = { id: 1, start_date: 5000, end_date: null, rank: 'day' };

            const nextState = computeFocusViewport(state, event);
            expect(nextState.zoomIndex).toBe(state.zoomIndex);
        });
    });

    describe('Расчет хронологического центра экрана', () => {
        const state = createViewportState(0, 15, 1000);

        it('центрирует область отображения точно на дате точечного события', () => {
            const pointEvent = { id: 1, start_date: 5000, end_date: null, rank: 'century' };
            const resPoint = computeFocusViewport(state, pointEvent);

            const sppPoint = zoomIndexToSecondsPerPixel(resPoint.zoomIndex);
            const durPoint = calculateVisibleDuration(resPoint.widthPx, sppPoint);
            const centerPoint = resPoint.originTimestamp + durPoint / 2;

            expect(centerPoint).toBeCloseTo(5000, 3);
        });

        it('центрирует область отображения на середине интервального события', () => {
            // Середина интервала [2000, 8000] равна 5000
            const intervalEvent = { id: 2, start_date: 2000, end_date: 8000, rank: 'century' };
            const resInterval = computeFocusViewport(state, intervalEvent);

            const sppInt = zoomIndexToSecondsPerPixel(resInterval.zoomIndex);
            const durInt = calculateVisibleDuration(resInterval.widthPx, sppInt);
            const centerInt = resInterval.originTimestamp + durInt / 2;

            expect(centerInt).toBeCloseTo(5000, 3);
        });
    });

    describe('Обработка неизвестных рангов и невалидных данных', () => {
        const state = createViewportState(0, 12, 1000);
        const pointEvent = { id: 1, start_date: 5000, end_date: null, rank: 'century' };

        it('возвращает исходный масштаб при неизвестных рангах и некорректных аргументах в findZoomIndexForRank', () => {
            expect(findZoomIndexForRank('unknown_rank', 12)).toBe(12);
            expect(findZoomIndexForRank(null, 12)).toBe(12);
            expect(findZoomIndexForRank(undefined, 12)).toBe(12);
            expect(findZoomIndexForRank('year', NaN)).toBeNaN();
        });

        it('сохраняет текущий масштаб камеры при фокусировке на событии с неизвестным рангом', () => {
            const res = computeFocusViewport(state, { start_date: 1000, rank: 'alien_rank' });

            expect(res.zoomIndex).toBe(state.zoomIndex);
            // Координата центра сместилась, масштаб остался прежним
            expect(res.originTimestamp).not.toBe(state.originTimestamp);
        });

        it('возвращает исходное состояние без мутаций при передаче поврежденных объектов в computeFocusViewport', () => {
            expect(computeFocusViewport(state, null)).toBe(state);
            expect(computeFocusViewport(state, {})).toBe(state);
            expect(computeFocusViewport(state, { start_date: 'invalid' })).toBe(state);
            expect(computeFocusViewport(null, pointEvent)).toBeNull();
        });
    });
});
