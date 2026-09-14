/**
 * Модульные тесты подсистемы интерактивного контроллера (controller.js).
 * Валидируют вычисление приращения масштаба колесом мыши (computeWheelZoomDelta)
 * и математический инвариант картографического направления зума:
 * прокрутка от себя (deltaY < 0) уменьшает secondsPerPixel (приближение),
 * а прокрутка на себя (deltaY > 0) увеличивает secondsPerPixel (отдаление).
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Изоляция исполнения в среде Node.js под управлением Vitest без DOM и Canvas.
 * 2. Двухуровневый подъем импортов из ядра таймлайна (../../frontend/js/timeline/...).
 * 3. Строгое соответствие правилам линтинга ESLint 9 (Flat Config)[cite: 23].
 */

import { describe, it, expect } from 'vitest';
import { computeWheelZoomDelta } from '../../frontend/js/timeline/controller.js';
import { ZOOM_STEP_PER_WHEEL_NOTCH } from '../../frontend/js/timeline/constants.js';
import {
    createViewportState,
    zoomViewport,
} from '../../frontend/js/timeline/viewport.js';
import { zoomIndexToSecondsPerPixel } from '../../frontend/js/timeline/scale.js';

describe('computeWheelZoomDelta', () => {
    it('возвращает отрицательное приращение при прокрутке вверх (deltaY < 0) для приближения шкалы', () => {
        const negativeDeltas = [-100, -1, -0.5];

        for (const deltaY of negativeDeltas) {
            const zoomDelta = computeWheelZoomDelta(deltaY);
            // Отрицательное приращение уменьшает zoomIndex и приближает камеру
            expect(zoomDelta).toBe(-ZOOM_STEP_PER_WHEEL_NOTCH);
        }
    });

    it('возвращает положительное приращение при прокрутке вниз (deltaY > 0) для отдаления шкалы', () => {
        const positiveDeltas = [100, 1, 0.5];

        for (const deltaY of positiveDeltas) {
            const zoomDelta = computeWheelZoomDelta(deltaY);
            // Положительное приращение увеличивает zoomIndex и отдаляет камеру
            expect(zoomDelta).toBe(ZOOM_STEP_PER_WHEEL_NOTCH);
        }
    });

    it('возвращает 0 при deltaY === 0', () => {
        expect(computeWheelZoomDelta(0)).toBe(0);
    });
});

describe('wheel zoom direction integration with viewport camera', () => {
    it('прокрутка вверх (deltaY < 0) уменьшает secondsPerPixel, приближая временную шкалу', () => {
        const initialZoomIndex = 10;
        const state = createViewportState(0, initialZoomIndex, 1000, 400);
        const initialSpp = zoomIndexToSecondsPerPixel(initialZoomIndex);

        // deltaY < 0 соответствует жесту прокрутки колеса от себя (вверх)
        const delta = computeWheelZoomDelta(-100);
        const newState = zoomViewport(state, 500, delta);
        const newSpp = zoomIndexToSecondsPerPixel(newState.zoomIndex);

        // Уменьшение количества секунд в пикселе означает увеличение детальности (приближение)
        expect(newSpp).toBeLessThan(initialSpp);
        expect(newState.zoomIndex).toBeLessThan(state.zoomIndex);
    });

    it('прокрутка вниз (deltaY > 0) увеличивает secondsPerPixel, отдаляя временную шкалу', () => {
        const initialZoomIndex = 10;
        const state = createViewportState(0, initialZoomIndex, 1000, 400);
        const initialSpp = zoomIndexToSecondsPerPixel(initialZoomIndex);

        // deltaY > 0 соответствует жесту прокрутки колеса на себя (вниз)
        const delta = computeWheelZoomDelta(100);
        const newState = zoomViewport(state, 500, delta);
        const newSpp = zoomIndexToSecondsPerPixel(newState.zoomIndex);

        // Увеличение количества секунд в пикселе означает переход к обзорному масштабу (отдаление)
        expect(newSpp).toBeGreaterThan(initialSpp);
        expect(newState.zoomIndex).toBeGreaterThan(state.zoomIndex);
    });
});
