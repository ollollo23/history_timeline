/**
 * Модульные тесты математических проекций и масштабирования временной оси (scale.js).
 * Валидируют алгоритмы прямого проецирования меток времени в экранные пиксели,
 * обратного пересчета координат, логарифмического шага масштаба и ограничения области видимости.
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Изоляция исполнения в среде Node.js под управлением Vitest без DOM и Canvas.
 * 2. Импорт исходных модулей с двухуровневым подъемом (../../frontend/js/timeline/...).
 * 3. Высокая точность расчетов во всем диапазоне от -1 000 000 лет до 3000 года.
 */

import { describe, it, expect } from 'vitest';
import {
    timestampToScreenX,
    screenXToTimestamp,
    zoomIndexToSecondsPerPixel,
    secondsPerPixelToZoomIndex,
    calculateVisibleDuration,
    calculatePixelWidth,
    clampOriginTimestamp,
} from '../../frontend/js/timeline/scale.js';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
    MIN_SECONDS_PER_PIXEL,
    MAX_SECONDS_PER_PIXEL,
} from '../../frontend/js/timeline/constants.js';

describe('timestampToScreenX and screenXToTimestamp', () => {
    const origin = 1715783742; // Базовая точка привязки экрана (2024-05-15 14:35:42)
    const spp = 10; // Масштаб: 10 секунд в одном пикселе

    it('проецирует originTimestamp строго в нулевую экранную координату', () => {
        const screenX = timestampToScreenX(origin, origin, spp);
        expect(screenX).toBe(0);
    });

    it('проецирует смещение на 100 * spp строго в координату 100 пикселей', () => {
        const targetTs = origin + 100 * spp;
        const screenX = timestampToScreenX(targetTs, origin, spp);
        expect(screenX).toBe(100);
    });

    it('гарантирует математическую обратимость проекции на 8 порядках масштаба', () => {
        // Уровни масштаба: от субсекундного разрешения до охвата геологических эпох
        const testScales = [0.02, 1, 60, 3600, 86400, 31557600, 1000000000, 21000000000];
        const screenX = 450.5;

        for (const currentSpp of testScales) {
            const calculatedTs = screenXToTimestamp(screenX, origin, currentSpp, false);
            const reconstructedX = timestampToScreenX(calculatedTs, origin, currentSpp);
            expect(Math.abs(reconstructedX - screenX)).toBeLessThanOrEqual(1e-4);
        }
    });

    it('обеспечивает точность восстановления экранной координаты не хуже 1e-4 пикселя на ключевых метках', () => {
        const keyTimestamps = [
            TIMELINE_MIN_TIMESTAMP,
            -1000000000,
            0,
            1715783742,
            TIMELINE_MAX_TIMESTAMP,
        ];
        const currentSpp = 1000;

        for (const ts of keyTimestamps) {
            const x = timestampToScreenX(ts, origin, currentSpp);
            const reconstructedTs = screenXToTimestamp(x, origin, currentSpp, false);
            const reconstructedX = timestampToScreenX(reconstructedTs, origin, currentSpp);
            expect(Math.abs(reconstructedX - x)).toBeLessThanOrEqual(1e-4);
        }
    });

    it('вызов screenXToTimestamp без аргумента roundToInteger возвращает вещественное значение по умолчанию', () => {
        const fractionalScreenX = 12.34;
        const exactSpp = 0.5; // Смещение = 6.17 секунд
        const expectedExactTs = origin + fractionalScreenX * exactSpp; // 1715783748.17

        // Вызов строго с тремя обязательными позиционными аргументами
        const defaultTs = screenXToTimestamp(fractionalScreenX, origin, exactSpp);

        // Проверка сохранения точного вещественного значения и наличия дробной доли
        expect(defaultTs).toBe(expectedExactTs);
        expect(Number.isInteger(defaultTs)).toBe(false);
        expect(defaultTs % 1).not.toBe(0);

        // Проверка принудительного округления при явной передаче флага true
        const roundedTs = screenXToTimestamp(fractionalScreenX, origin, exactSpp, true);
        expect(roundedTs).toBe(Math.round(expectedExactTs));
        expect(Number.isInteger(roundedTs)).toBe(true);
    });
});

describe('zoomIndex conversion', () => {
    it('гарантирует взаимную обратимость преобразования индекса масштаба', () => {
        // Проверка значений в пределах рабочего диапазона
        const testIndices = [0, 2.5, 5, 8.75, 12, 16.33, 20, 24.5];

        for (const idx of testIndices) {
            const calculatedSpp = zoomIndexToSecondsPerPixel(idx);
            const reconstructedIdx = secondsPerPixelToZoomIndex(calculatedSpp);
            expect(reconstructedIdx).toBeCloseTo(idx, 4);
        }
    });

    it('ограничивает zoomIndexToSecondsPerPixel рамками допустимых констант масштаба', () => {
        // Ограничение снизу при экстремальном приближении
        const minClampedSpp = zoomIndexToSecondsPerPixel(-100);
        expect(minClampedSpp).toBe(MIN_SECONDS_PER_PIXEL);

        // Ограничение сверху при экстремальном отдалении
        const maxClampedSpp = zoomIndexToSecondsPerPixel(1000);
        expect(maxClampedSpp).toBe(MAX_SECONDS_PER_PIXEL);
    });

    it('ограничивает secondsPerPixelToZoomIndex при выходе за границы диапазона масштабирования', () => {
        const subMinSpp = MIN_SECONDS_PER_PIXEL / 10;
        const ultraMaxSpp = MAX_SECONDS_PER_PIXEL * 10;

        const minIdx = secondsPerPixelToZoomIndex(subMinSpp);
        const maxIdx = secondsPerPixelToZoomIndex(ultraMaxSpp);

        const resolvedMinSpp = zoomIndexToSecondsPerPixel(minIdx);
        const resolvedMaxSpp = zoomIndexToSecondsPerPixel(maxIdx);

        // Валидация удержания минимального масштаба с точностью до 6 знаков
        expect(resolvedMinSpp).toBeCloseTo(MIN_SECONDS_PER_PIXEL, 6);

        // Валидация удержания максимального масштаба с точностью до 4 знаков
        expect(resolvedMaxSpp).toBeCloseTo(MAX_SECONDS_PER_PIXEL, 4);
    });
});

describe('intervals and pixel dimensions', () => {
    it('calculateVisibleDuration возвращает точное произведение ширины на масштаб', () => {
        const widthPx = 1920;
        const spp = 2.5;
        expect(calculateVisibleDuration(widthPx, spp)).toBe(4800);
    });

    it('calculatePixelWidth возвращает точное частное длительности на масштаб', () => {
        const duration = 86400; // 1 сутки
        const spp = 60; // 1 минута в пикселе
        expect(calculatePixelWidth(duration, spp)).toBe(1440);
    });
});

describe('clampOriginTimestamp', () => {
    const totalPlatformDuration = TIMELINE_MAX_TIMESTAMP - TIMELINE_MIN_TIMESTAMP;

    it('ограничивает смещение влево минимальной границей шкалы платформы', () => {
        const widthPx = 1000;
        const spp = 86400; // 1 сутки/пкс
        const targetOrigin = TIMELINE_MIN_TIMESTAMP - 1000000;

        const clamped = clampOriginTimestamp(targetOrigin, widthPx, spp);
        expect(clamped).toBe(TIMELINE_MIN_TIMESTAMP);
    });

    it('ограничивает смещение вправо значением TIMELINE_MAX_TIMESTAMP минус видимая длительность', () => {
        const widthPx = 1000;
        const spp = 3600; // 1 час/пкс
        const targetOrigin = TIMELINE_MAX_TIMESTAMP + 500000;
        const expectedMaxOrigin = TIMELINE_MAX_TIMESTAMP - 1000 * 3600;

        const clamped = clampOriginTimestamp(targetOrigin, widthPx, spp);
        expect(clamped).toBe(expectedMaxOrigin);
    });

    it('центрирует область просмотра, если видимый интервал превышает общую длительность шкалы', () => {
        const widthPx = 2000;
        const spp = MAX_SECONDS_PER_PIXEL;
        const visibleDuration = widthPx * spp;
        const arbitraryOrigin = 0;

        const expectedCenteredOrigin =
            TIMELINE_MIN_TIMESTAMP + (totalPlatformDuration - visibleDuration) / 2;

        const clamped = clampOriginTimestamp(arbitraryOrigin, widthPx, spp);
        expect(clamped).toBe(expectedCenteredOrigin);
    });

    it('сохраняет дробную часть при вызове с вещественной опорной меткой внутри допустимого диапазона', () => {
        const widthPx = 1000;
        const spp = 10;
        const floatOrigin = 1715783742.684;

        const clamped = clampOriginTimestamp(floatOrigin, widthPx, spp);
        expect(clamped).toBe(floatOrigin);
    });
});
