/**
 * Модульные тесты модели состояния области просмотра (viewport.js).
 * Валидируют создание иммутабельного состояния виртуальной камеры, панорамирование,
 * реакцию на изменение размеров контейнера и математический инвариант сохранения
 * временной метки под курсором при непрерывном масштабировании на различных масштабах.
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Исполнение в изолированной среде Node.js (Vitest) без обращений к DOM и Canvas.
 * 2. Импорты модулей ядра выполняются с подъемом на два уровня (../../frontend/js/timeline/...).
 * 3. Все состояния строго иммутабельны (Object.isFrozen).
 * 4. Опорная точка originTimestamp сохраняет точное вещественное значение без квантования до целых секунд.
 */

import { describe, it, expect } from 'vitest';
import {
    createViewportState,
    getDefaultViewportState,
    panViewport,
    zoomViewport,
    resizeViewport,
    fitInterval,
} from '../../frontend/js/timeline/viewport.js';
import {
    zoomIndexToSecondsPerPixel,
    secondsPerPixelToZoomIndex,
    timestampToScreenX,
    screenXToTimestamp,
} from '../../frontend/js/timeline/scale.js';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
    SECONDS_PER_YEAR_AVG,
    MIN_SECONDS_PER_PIXEL,
    MAX_SECONDS_PER_PIXEL,
} from '../../frontend/js/timeline/constants.js';

/**
 * Контрольный набор масштабов для параметризованного стресс-тестирования
 * геометрических проекций, панорамирования и инвариантов привязки камеры.
 */
const SCALE_TEST_LEVELS = [0.02, 0.1, 1, 1000, 1000000, MAX_SECONDS_PER_PIXEL];

describe('createViewportState and immutability', () => {
    it('создает объект состояния с обязательными полями геометрической проекции', () => {
        const state = createViewportState(0, 10, 1000, 400);

        expect(state).toHaveProperty('originTimestamp');
        expect(state).toHaveProperty('zoomIndex');
        expect(state).toHaveProperty('widthPx');
        expect(state).toHaveProperty('heightPx');

        expect(state.zoomIndex).toBe(10);
        expect(state.widthPx).toBe(1000);
        expect(state.heightPx).toBe(400);
    });

    it('гарантирует глубокую иммутабельность возвращаемого объекта (Object.isFrozen)', () => {
        const state = createViewportState(1000, 5, 800, 300);

        expect(Object.isFrozen(state)).toBe(true);

        // Попытка прямой мутации свойств должна приводить к ошибке в strict mode или игнорироваться
        expect(() => {
            // @ts-ignore
            state.originTimestamp = 99999;
        }).toThrow();

        expect(() => {
            // @ts-ignore
            state.zoomIndex = 20;
        }).toThrow();
    });

    it('сохраняет точную вещественную метку originTimestamp без принудительного округления', () => {
        // Дробная временная метка сохраняется полностью для исключения мертвого панорамирования
        const fractionalOrigin = 1715783742.68;
        const state = createViewportState(fractionalOrigin, 12, 1000, 300);

        expect(state.originTimestamp).toBe(fractionalOrigin);

        // Выход за пределы минимальной границы платформы упирается в TIMELINE_MIN_TIMESTAMP
        const underflowState = createViewportState(TIMELINE_MIN_TIMESTAMP - 1000000, 12, 1000, 300);
        expect(underflowState.originTimestamp).toBe(TIMELINE_MIN_TIMESTAMP);
    });
});

describe('getDefaultViewportState', () => {
    it('формирует корректное начальное состояние для заданных размеров контейнера', () => {
        const width = 1200;
        const height = 350;
        const state = getDefaultViewportState(width, height);

        expect(state.widthPx).toBe(width);
        expect(state.heightPx).toBe(height);
        expect(Object.isFrozen(state)).toBe(true);
    });

    it('обеспечивает обзорный интервал порядка 200 лет с центром в окрестности текущего времени', () => {
        const width = 1000;
        const height = 300;
        const state = getDefaultViewportState(width, height);

        const spp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const visibleDuration = width * spp;

        // Проверка, что видимая длительность составляет около 200 лет (с допуском на логарифмический шаг)
        const targetDuration = 200 * SECONDS_PER_YEAR_AVG;
        expect(visibleDuration).toBeGreaterThan(targetDuration * 0.7);
        expect(visibleDuration).toBeLessThan(targetDuration * 1.5);

        // Проверка, что текущий момент времени находится внутри видимой области
        const nowSec = Math.floor(Date.now() / 1000);
        expect(state.originTimestamp).toBeLessThanOrEqual(nowSec);
        expect(state.originTimestamp + visibleDuration).toBeGreaterThanOrEqual(nowSec);
    });
});

describe('panViewport', () => {
    const initialState = createViewportState(1000000, 10, 1000, 300);

    it('возвращает исходную ссылку на объект при deltaPx === 0', () => {
        const nextState = panViewport(initialState, 0);
        expect(nextState).toBe(initialState);
    });

    it('смещает originTimestamp влево (в прошлое) при перетаскивании вправо (deltaPx > 0)', () => {
        const deltaPx = 50;
        const nextState = panViewport(initialState, deltaPx);

        expect(nextState).not.toBe(initialState);
        expect(nextState.originTimestamp).toBeLessThan(initialState.originTimestamp);

        const spp = zoomIndexToSecondsPerPixel(initialState.zoomIndex);
        const expectedShift = deltaPx * spp;
        expect(nextState.originTimestamp).toBe(initialState.originTimestamp - expectedShift);
    });

    it('не мутирует исходный экземпляр состояния при панорамировании', () => {
        const originalOrigin = initialState.originTimestamp;
        panViewport(initialState, -100);

        expect(initialState.originTimestamp).toBe(originalOrigin);
    });

    it('упирается в системные границы шкалы платформы при экстремальном панорамировании', () => {
        // Упор в глубокую древность (влево)
        const panLeft = panViewport(initialState, 1e15);
        expect(panLeft.originTimestamp).toBe(TIMELINE_MIN_TIMESTAMP);

        // Упор в будущее (вправо)
        const panRight = panViewport(initialState, -1e15);
        const spp = zoomIndexToSecondsPerPixel(initialState.zoomIndex);
        const visibleDuration = initialState.widthPx * spp;
        expect(panRight.originTimestamp).toBe(TIMELINE_MAX_TIMESTAMP - visibleDuration);
    });

    it('серия из 200 событий панорамирования по 2 пикселя при масштабе 0.02 с/пкс смещает ось ровно на 400 пикселей', () => {
        const minZoomIdx = secondsPerPixelToZoomIndex(MIN_SECONDS_PER_PIXEL);
        const initialOrigin = 1000000.0;
        let state = createViewportState(initialOrigin, minZoomIdx, 1000, 300);

        // 200 вызовов по 2 пикселя
        for (let i = 0; i < 200; i++) {
            state = panViewport(state, 2);
        }

        // Суммарное смещение времени: 400 px * 0.02 s/px = 8 секунд
        const expectedTimeShift = 400 * MIN_SECONDS_PER_PIXEL;
        const actualTimeShift = initialOrigin - state.originTimestamp;
        expect(Math.abs(actualTimeShift - expectedTimeShift)).toBeLessThanOrEqual(1e-5);

        // Расчетное экранное смещение строго равно 400 пикселям без мертвого залипания
        const screenShiftPx = actualTimeShift / MIN_SECONDS_PER_PIXEL;
        expect(Math.abs(screenShiftPx - 400)).toBeLessThanOrEqual(1e-5);
    });

    it.each(SCALE_TEST_LEVELS)(
        'серия из 200 событий панорамирования по 1 пикселю для spp = %s смещает ось ровно на 200 пикселей',
        (spp) => {
            let state = createViewportState(0, secondsPerPixelToZoomIndex(spp), 1000, 400);
            const initialOrigin = state.originTimestamp;

            for (let i = 0; i < 200; i++) {
                state = panViewport(state, 1);
            }

            const actualTimeShift = initialOrigin - state.originTimestamp;
            const actualShiftPx = actualTimeShift / spp;

            expect(Math.abs(actualShiftPx - 200)).toBeLessThanOrEqual(1.0);
        }
    );

    it.each(SCALE_TEST_LEVELS)(
        'серия из 200 событий панорамирования по 2 пикселя для spp = %s смещает ось ровно на 400 пикселей',
        (spp) => {
            let state = createViewportState(0, secondsPerPixelToZoomIndex(spp), 1000, 400);
            const initialOrigin = state.originTimestamp;

            for (let i = 0; i < 200; i++) {
                state = panViewport(state, 2);
            }

            const actualShiftPx = (initialOrigin - state.originTimestamp) / spp;

            expect(Math.abs(actualShiftPx - 400)).toBeLessThanOrEqual(1.0);
        }
    );
});

describe('zoomViewport anchor invariant', () => {
    it('сохраняет временную метку под курсором при одиночном приближении', () => {
        const width = 1200;
        const height = 400;
        const state = getDefaultViewportState(width, height);

        const anchorX = 450;
        const oldSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const targetTs = screenXToTimestamp(anchorX, state.originTimestamp, oldSpp, false);

        // Приближение на 1.5 шага индекса
        const zoomedState = zoomViewport(state, anchorX, 1.5);
        const newSpp = zoomIndexToSecondsPerPixel(zoomedState.zoomIndex);
        const newScreenX = timestampToScreenX(targetTs, zoomedState.originTimestamp, newSpp);

        expect(Math.abs(newScreenX - anchorX)).toBeLessThan(1.0);
    });

    it('сохраняет инвариант при стресс-тесте из 100 встречных шагов зума (фазовый дрейф < 1px)', () => {
        const width = 1200;
        const height = 400;
        let state = getDefaultViewportState(width, height);

        const anchorX = 450; // Точка фокусировки курсора
        const initialSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const targetTs = screenXToTimestamp(anchorX, state.originTimestamp, initialSpp, false);

        // 50 последовательных шагов масштабирования (+0.02)
        for (let i = 0; i < 50; i++) {
            state = zoomViewport(state, anchorX, 0.02);
        }

        // 50 встречных шагов масштабирования (-0.02)
        for (let i = 0; i < 50; i++) {
            state = zoomViewport(state, anchorX, -0.02);
        }

        const finalSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const finalScreenX = timestampToScreenX(targetTs, state.originTimestamp, finalSpp);

        // Проверка отсутствия накопленного дрейфа: курсор остается строго над той же временной отметкой
        expect(Math.abs(finalScreenX - anchorX)).toBeLessThan(1.0);
    });

    it('сохраняет инвариант привязки к курсору при стресс-тесте из 200 встречных шагов зума (дрейф < 1px)', () => {
        const width = 1200;
        const height = 400;
        let state = getDefaultViewportState(width, height);

        const anchorX = 450;
        const initialSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const targetTs = screenXToTimestamp(anchorX, state.originTimestamp, initialSpp, false);

        // 100 последовательных шагов приближения (+0.02)
        for (let i = 0; i < 100; i++) {
            state = zoomViewport(state, anchorX, 0.02);
        }

        // 100 встречных шагов отдаления (-0.02)
        for (let i = 0; i < 100; i++) {
            state = zoomViewport(state, anchorX, -0.02);
        }

        const finalSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
        const finalScreenX = timestampToScreenX(targetTs, state.originTimestamp, finalSpp);

        // Фазовый дрейф после 200 операций встречного масштабирования не превышает 1 пикселя
        expect(Math.abs(finalScreenX - anchorX)).toBeLessThan(1.0);
    });

    it.each(SCALE_TEST_LEVELS)(
        'сохраняет инвариант привязки к курсору при 100 встречных шагах зума для spp = %s (дрейф < 1px)',
        (spp) => {
            const zoomIdx = secondsPerPixelToZoomIndex(spp);
            let state = createViewportState(0, zoomIdx, 1000, 400);

            const anchorX = 450;
            const targetTs = screenXToTimestamp(anchorX, state.originTimestamp, spp, false);

            // 50 последовательных шагов приближения
            for (let i = 0; i < 50; i++) {
                state = zoomViewport(state, anchorX, 0.02);
            }

            // 50 встречных шагов отдаления
            for (let i = 0; i < 50; i++) {
                state = zoomViewport(state, anchorX, -0.02);
            }

            const finalSpp = zoomIndexToSecondsPerPixel(state.zoomIndex);
            const finalScreenX = timestampToScreenX(targetTs, state.originTimestamp, finalSpp);

            expect(Math.abs(finalScreenX - anchorX)).toBeLessThan(1.0);
        }
    );
});

describe('resizeViewport', () => {
    const initialState = createViewportState(1715783742, 10, 1000, 300);

    it('возвращает идентичный объект при сохранении геометрических размеров', () => {
        const nextState = resizeViewport(initialState, 1000, 300);
        expect(nextState).toBe(initialState);
    });

    it('сохраняет originTimestamp неизменным при расширении контейнера (левый край стабилен)', () => {
        const expandedState = resizeViewport(initialState, 1400, 300);

        expect(expandedState).not.toBe(initialState);
        expect(expandedState.originTimestamp).toBe(initialState.originTimestamp);
        expect(expandedState.widthPx).toBe(1400);
        expect(expandedState.heightPx).toBe(300);
    });
});

describe('fitInterval', () => {
    it('позиционирует начало интервала и подбирает масштаб для точного помещения в ширину экрана', () => {
        const state = createViewportState(0, 10, 1000, 300);
        const startTs = 1000000;
        const endTs = 1500000; // Длительность 500 000 секунд

        const fitted = fitInterval(state, startTs, endTs);

        expect(fitted.originTimestamp).toBe(startTs);

        const spp = zoomIndexToSecondsPerPixel(fitted.zoomIndex);
        const renderedDuration = fitted.widthPx * spp;

        // Рассчитанный интервал укладывается в ширину холста с точностью до шага масштабирования
        expect(renderedDuration).toBeGreaterThanOrEqual(endTs - startTs);
    });
});
