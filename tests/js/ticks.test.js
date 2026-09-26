/**
 * Модульные тесты подсистемы генерации делений сетки таймлайна (ticks.js).
 * Валидируют сквозную синхронизацию системных констант между фронтендом и бэкендом,
 * математическую строгость и монотонность лестницы шагов TICK_LADDER,
 * кратность крупных делений мелким, целевую плотность сетки, сплошное покрытие
 * буфера упреждения и выравнивание дохристианских дат по историческим годам до н. э.
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Исполнение в изолированной среде Node.js под управлением Vitest без DOM и Canvas.
 * 2. Импорт модулей ядра осуществляется с подъемом на два уровня (../../frontend/js/timeline/...).
 * 3. Жесткая гарантия производительности: не более 120 тиков на стандартных экранах и не более 200 на 4K.
 */

import { describe, it, expect } from 'vitest';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
    TICK_LADDER,
    MIN_SECONDS_PER_PIXEL,
    MAX_SECONDS_PER_PIXEL,
    TARGET_MINOR_TICK_SPACING_PX,
    TARGET_MAJOR_TICK_SPACING_PX,
} from '../../frontend/js/timeline/constants.js';
import { generateTicks } from '../../frontend/js/timeline/ticks.js';
import {
    createViewportState,
    getDefaultViewportState,
} from '../../frontend/js/timeline/viewport.js';
import { secondsPerPixelToZoomIndex } from '../../frontend/js/timeline/scale.js';
import { timestampToCivil } from '../../frontend/js/timeline/calendar.js';

describe('constants synchronization with backend', () => {
    it('проверяет нижнюю границу шкалы платформы TIMELINE_MIN_TIMESTAMP', () => {
        // Первоисточник: app/core/constants.py -> TIMELINE_MIN_TIMESTAMP (-1 000 000 лет)
        expect(TIMELINE_MIN_TIMESTAMP).toBe(-31557600000000);
    });

    it('проверяет верхнюю границу шкалы платформы TIMELINE_MAX_TIMESTAMP', () => {
        // Первоисточник: app/core/constants.py -> TIMELINE_MAX_TIMESTAMP (3000-01-01)
        expect(TIMELINE_MAX_TIMESTAMP).toBe(32503680000);
    });

    it('проверяет, что общая длительность шкалы строго положительна и превышает 31 триллион секунд', () => {
        const totalDuration = TIMELINE_MAX_TIMESTAMP - TIMELINE_MIN_TIMESTAMP;
        expect(totalDuration).toBeGreaterThan(31000000000000);
    });
});

describe('TICK_LADDER structure and invariants', () => {
    it('содержит не менее 23 уровней дискретизации сетки', () => {
        expect(Array.isArray(TICK_LADDER)).toBe(true);
        expect(TICK_LADDER.length).toBeGreaterThanOrEqual(23);
    });

    it('содержит обязательные свойства unit, step, majorStep и исключает thresholdSpp в каждом уровне', () => {
        for (const level of TICK_LADDER) {
            // Проверка обязательных свойств физической конфигурации шага
            expect(level).toHaveProperty('unit');
            expect(level).toHaveProperty('step');
            expect(level).toHaveProperty('majorStep');

            expect(typeof level.unit).toBe('string');
            expect(typeof level.step).toBe('number');
            expect(typeof level.majorStep).toBe('number');

            expect(level.step).toBeGreaterThan(0);
            expect(level.majorStep).toBeGreaterThan(0);

            // Контроль отсутствия устаревшего статического порога масштаба
            expect(level).not.toHaveProperty('thresholdSpp');
        }
    });

    it('гарантирует строгую монотонность длительности мелкого шага сетки без инверсий и дубликатов', () => {
        // Приведение различных календарных единиц к эквивалентной длительности в секундах
        const unitToSeconds = {
            second: 1,
            minute: 60,
            hour: 3600,
            day: 86400,
            month: 86400 * 30,
            year: 31557600,
            decade: 31557600 * 10,
            century: 31557600 * 100,
            millennium: 31557600 * 1000,
        };

        let previousDuration = 0;

        for (const level of TICK_LADDER) {
            const unitMultiplier = unitToSeconds[level.unit];
            expect(unitMultiplier).toBeDefined();

            const currentDuration = level.step * unitMultiplier;

            // Каждый последующий уровень обязан охватывать строго больший интервал времени
            expect(currentDuration).toBeGreaterThan(previousDuration);
            previousDuration = currentDuration;
        }
    });

    it('обеспечивает целочисленную кратность крупного шага мелкому (major / minor >= 2)', () => {
        for (const level of TICK_LADDER) {
            // Крупный шаг должен делиться на мелкий нацело
            expect(level.majorStep % level.step).toBe(0);

            const ratio = level.majorStep / level.step;
            expect(ratio).toBeGreaterThanOrEqual(2);
            expect(Number.isInteger(ratio)).toBe(true);
        }
    });
});

describe('generateTicks ceiling and density', () => {
    it('генерирует от 1 до 120 меток на стандартном экране (1200x400) на 10 уровнях зума', () => {
        // Выборка различных уровней масштабирования: от секундного разрешения до тысячелетий
        const testZoomIndices = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28];

        for (const zoomIndex of testZoomIndices) {
            const state = createViewportState(1715783742, zoomIndex, 1200, 400);
            const ticks = generateTicks(state);

            expect(ticks.length).toBeGreaterThan(0);
            // Проверка потолка плотности: не более 120 делений для защиты от просадки FPS
            expect(ticks.length).toBeLessThanOrEqual(120);
        }
    });

    it('не превышает потолок в 200 меток на сверхшироком 4K-разрешении (3840 пикселей)', () => {
        const testZoomIndices = [2, 6, 10, 14, 18, 22, 26];

        for (const zoomIndex of testZoomIndices) {
            const state = createViewportState(1715783742, zoomIndex, 3840, 1000);
            const ticks = generateTicks(state);

            expect(ticks.length).toBeGreaterThan(0);
            // Проверка потолка на экранах сверхвысокой четкости: не более 200 делений на кадр
            expect(ticks.length).toBeLessThanOrEqual(200);
        }
    });

    it('формирует корректную структуру и допустимые диапазоны полей для каждого деления', () => {
        const state = getDefaultViewportState(1200, 400);
        const ticks = generateTicks(state);

        expect(ticks.length).toBeGreaterThan(0);

        for (const tick of ticks) {
            expect(typeof tick.timestamp).toBe('number');
            expect(Number.isFinite(tick.timestamp)).toBe(true);

            expect(typeof tick.screenX).toBe('number');
            expect(Number.isFinite(tick.screenX)).toBe(true);

            expect(typeof tick.isMajor).toBe('boolean');
            expect(typeof tick.unit).toBe('string');
            expect(typeof tick.step).toBe('number');

            // Прозрачность деления обязана быть строго в диапазоне [0.0, 1.0] для корректного альфа-блендинга
            expect(typeof tick.opacity).toBe('number');
            expect(tick.opacity).toBeGreaterThanOrEqual(0.0);
            expect(tick.opacity).toBeLessThanOrEqual(1.0);
        }
    });

    it('удерживает все деления в пределах видимой области с буфером упреждения ([-100, widthPx + 100])', () => {
        const widthPx = 1200;
        const state = createViewportState(1715783742, 12, widthPx, 400);
        const ticks = generateTicks(state);

        expect(ticks.length).toBeGreaterThan(0);

        for (const tick of ticks) {
            // Деления генерируются только в пределах экрана плюс небольшой буфер упреждения
            expect(tick.screenX).toBeGreaterThanOrEqual(-100);
            expect(tick.screenX).toBeLessThanOrEqual(widthPx + 100);
        }
    });

    it('гарантирует целевую плотность сетки (minor >= 90px, major >= 220px) на 16 логарифмических масштабах', () => {
        const minLog = Math.log2(MIN_SECONDS_PER_PIXEL);
        const maxLog = Math.log2(MAX_SECONDS_PER_PIXEL);
        const numScales = 16;
        const logStep = (maxLog - minLog) / (numScales - 1);

        for (let i = 0; i < numScales; i++) {
            const zoomIdx = minLog + i * logStep;
            const state = createViewportState(0, zoomIdx, 1200, 400);
            const ticks = generateTicks(state);

            expect(ticks.length).toBeGreaterThanOrEqual(2);

            // Проверка минимального расстояния между соседними мелкими делениями (допуск 8px на длину месяцев/лет)
            for (let k = 1; k < ticks.length; k++) {
                const spacing = ticks[k].screenX - ticks[k - 1].screenX;
                expect(spacing).toBeGreaterThanOrEqual(TARGET_MINOR_TICK_SPACING_PX - 8);
            }

            // Проверка минимального расстояния между соседними крупными делениями
            const majorTicks = ticks.filter((t) => t.isMajor);
            if (majorTicks.length >= 2) {
                for (let j = 1; j < majorTicks.length; j++) {
                    const majorSpacing = majorTicks[j].screenX - majorTicks[j - 1].screenX;
                    expect(majorSpacing).toBeGreaterThanOrEqual(TARGET_MAJOR_TICK_SPACING_PX - 15);
                }
            }
        }
    });

    it('обеспечивает сплошное покрытие области и заполнение буфера упреждения без обрыва по потолку', () => {
        // Выборка 10 масштабов от секунд до глубоких тысячелетий с шагом сетки в диапазоне 90-100px
        const testScales = [
            { spp: 1 / 95, origin: 0 },
            { spp: 60 / 95, origin: 0 },
            { spp: 3600 / 95, origin: 0 },
            { spp: 86400 / 95, origin: 0 },
            { spp: 2592000 / 95, origin: 0 },
            { spp: 31557600 / 95, origin: 0 },
            { spp: 315576000 / 95, origin: -31557600 * 1000 },
            { spp: 3155760000 / 95, origin: -31557600 * 10000 },
            { spp: 31557600000 / 95, origin: -31557600 * 50000 },
            { spp: (50 * 1000 * 31557600) / 95, origin: -31557600 * 300000 },
        ];

        for (const { spp, origin } of testScales) {
            const zoomIndex = secondsPerPixelToZoomIndex(spp);
            const state = createViewportState(origin, zoomIndex, 1200, 400);
            const ticks = generateTicks(state);

            expect(ticks.length).toBeGreaterThan(0);

            // Первая отметка не должна быть смещена внутрь экрана дальше одного целевого шага
            expect(ticks[0].screenX).toBeLessThanOrEqual(TARGET_MINOR_TICK_SPACING_PX);

            // Последняя отметка обязана доходить до правого края с допуском на один шаг сетки
            expect(ticks[ticks.length - 1].screenX).toBeGreaterThanOrEqual(
                state.widthPx - TARGET_MINOR_TICK_SPACING_PX
            );

            // Проверка защитного лимита экрана
            expect(ticks.length).toBeLessThanOrEqual(120);
        }
    });
});

describe('historical BCE tick alignment', () => {
    it('выравнивает деления в дохристианской части шкалы по круглым историческим годам до н. э.', () => {
        // 1. Проверка масштаба столетий в окрестности 5000 года до н. э.
        const sppCentury = 31557600 * 50;
        const originCentury = -31557600 * 5000;
        const zoomCentury = secondsPerPixelToZoomIndex(sppCentury);
        const stateCentury = createViewportState(originCentury, zoomCentury, 1200, 400);
        const ticksCentury = generateTicks(stateCentury);

        expect(ticksCentury.length).toBeGreaterThan(0);

        for (const tick of ticksCentury) {
            const civil = timestampToCivil(tick.timestamp);
            if (civil.year <= 0) {
                const bceYear = 1 - civil.year;
                const stepYears =
                    tick.unit === 'century'
                        ? tick.step * 100
                        : tick.unit === 'millennium'
                          ? tick.step * 1000
                          : tick.step;

                // Проверка кратности исторического года размеру мелкого шага сетки
                expect(bceYear % stepYears).toBe(0);

                // Если деление помечено как крупное, оно обязано быть кратно крупному историческому периоду
                if (tick.isMajor) {
                    const level = TICK_LADDER.find(
                        (l) => l.unit === tick.unit && l.step === tick.step
                    );
                    const majorSpanYears = level
                        ? (level.unit === 'century'
                              ? level.majorStep * 100
                              : level.unit === 'millennium'
                                ? level.majorStep * 1000
                                : level.majorStep)
                        : stepYears * 2;

                    expect(bceYear % majorSpanYears).toBe(0);
                }
            }
        }

        // 2. Проверка масштаба тысячелетий в глубокой древности (~500 тыс. лет до н. э.)
        const sppMillennium = 31557600 * 5000;
        const originMillennium = -31557600 * 500000;
        const zoomMillennium = secondsPerPixelToZoomIndex(sppMillennium);
        const stateMillennium = createViewportState(originMillennium, zoomMillennium, 1200, 400);
        const ticksMillennium = generateTicks(stateMillennium);

        expect(ticksMillennium.length).toBeGreaterThan(0);

        for (const tick of ticksMillennium) {
            const civil = timestampToCivil(tick.timestamp);
            if (civil.year <= 0) {
                const bceYear = 1 - civil.year;
                const stepYears = tick.step * 1000;

                // Исторический год до н. э. строго делится на шаг тысячелетий без остатка
                expect(bceYear % stepYears).toBe(0);
            }
        }
    });
});
