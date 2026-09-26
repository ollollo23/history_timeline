/**
 * Модульные тесты политики расчета окна упреждающей загрузки данных.
 * Проверяет математику центрирования интервалов, целочисленность границ,
 * предикаты вложенности окон, построение ключа формы запроса и логику кэширования во фреймворке Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
    DEFAULT_PREFETCH_MULTIPLIER,
    calculateRequiredLoadWindow,
    isWindowCovered,
    buildRequestShapeKey,
    shouldFetchEvents,
} from '../../frontend/js/timeline/loadWindow.js';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
} from '../../frontend/js/timeline/constants.js';

describe('loadWindow module', () => {
    describe('Функция calculateRequiredLoadWindow', () => {
        it('рассчитывает окно заданной кратности и центрирует его относительно видимой области', () => {
            // zoomIndex = 0 соответствует масштабу 1 сек/пиксель (2^0 = 1)
            // widthPx = 100 -> видимая длительность = 100 секунд
            const viewportState = {
                originTimestamp: 1000,
                zoomIndex: 0,
                widthPx: 100,
            };

            // При множителе 3 ширина окна обязана быть равна 300 секундам
            // Середина видимой области: 1000 + 50 = 1050
            // Окно: 1050 - 150 = 900 (from_date), 1050 + 150 = 1200 (to_date)
            const window = calculateRequiredLoadWindow(viewportState, 3);

            expect(window.from_date).toBe(900);
            expect(window.to_date).toBe(1200);
            expect(window.to_date - window.from_date).toBe(300);
        });

        it('использует множитель упреждения DEFAULT_PREFETCH_MULTIPLIER по умолчанию', () => {
            const viewportState = {
                originTimestamp: 0,
                zoomIndex: 0,
                widthPx: 200,
            };

            const window = calculateRequiredLoadWindow(viewportState);
            const expectedDuration = 200 * DEFAULT_PREFETCH_MULTIPLIER;

            expect(window.to_date - window.from_date).toBe(expectedDuration);
        });

        it('жестко ограничивает границы окна физическими пределами шкалы платформы', () => {
            // Состояние вблизи левого края шкалы (эпоха плейстоцена)
            const leftState = {
                originTimestamp: TIMELINE_MIN_TIMESTAMP + 10,
                zoomIndex: 10,
                widthPx: 1000,
            };

            const leftWindow = calculateRequiredLoadWindow(leftState, 5);
            expect(leftWindow.from_date).toBeGreaterThanOrEqual(TIMELINE_MIN_TIMESTAMP);

            // Состояние вблизи правого края шкалы (3000 год н.э.)
            const rightState = {
                originTimestamp: TIMELINE_MAX_TIMESTAMP - 50,
                zoomIndex: 10,
                widthPx: 1000,
            };

            const rightWindow = calculateRequiredLoadWindow(rightState, 5);
            expect(rightWindow.to_date).toBeLessThanOrEqual(TIMELINE_MAX_TIMESTAMP);
        });

        it('гарантирует целочисленность границ при дробной опорной метке камеры (защита от ошибки 422)', () => {
            const floatState = {
                originTimestamp: 12345.6789,
                zoomIndex: 1.25, // Дробный логарифмический индекс зума
                widthPx: 843.5,
            };

            const window = calculateRequiredLoadWindow(floatState, 3);

            expect(Number.isInteger(window.from_date)).toBe(true);
            expect(Number.isInteger(window.to_date)).toBe(true);
        });

        it('выполняет округление from_date строго вниз, а to_date строго вверх во избежание сужения окна', () => {
            // Задаем параметры, дающие заведомо дробные границы
            const state = {
                originTimestamp: 100.4,
                zoomIndex: 0, // 1 с/пкс
                widthPx: 10, // Длительность 10 сек -> центр 105.4
            };
            // loadDuration = 30 -> rawFrom = 90.4, rawTo = 120.4
            const window = calculateRequiredLoadWindow(state, 3);

            // from_date округляется вниз: floor(90.4) = 90
            expect(window.from_date).toBe(90);
            // to_date округляется вверх: ceil(120.4) = 121
            expect(window.to_date).toBe(121);
        });

        it('возвращает иммутабельный замороженный объект', () => {
            const viewportState = {
                originTimestamp: 0,
                zoomIndex: 0,
                widthPx: 100,
            };

            const window = calculateRequiredLoadWindow(viewportState);
            expect(Object.isFrozen(window)).toBe(true);
        });
    });

    describe('Функция isWindowCovered', () => {
        const loaded = { from_date: 0, to_date: 1000 };

        it('возвращает true, если требуемое окно полностью вложено в загруженное', () => {
            expect(isWindowCovered({ from_date: 100, to_date: 900 }, loaded)).toBe(true);
        });

        it('возвращает true при точном совпадении обеих границ', () => {
            expect(isWindowCovered({ from_date: 0, to_date: 1000 }, loaded)).toBe(true);
        });

        it('возвращает false при выходе за левую границу хотя бы на одну секунду', () => {
            expect(isWindowCovered({ from_date: -1, to_date: 900 }, loaded)).toBe(false);
        });

        it('возвращает false при выходе за правую границу хотя бы на одну секунду', () => {
            expect(isWindowCovered({ from_date: 100, to_date: 1001 }, loaded)).toBe(false);
        });

        it('возвращает false при выходе за обе границы', () => {
            expect(isWindowCovered({ from_date: -50, to_date: 1500 }, loaded)).toBe(false);
        });

        it('возвращает false для невалидных входных параметров', () => {
            expect(isWindowCovered(null, loaded)).toBe(false);
            expect(isWindowCovered(undefined, loaded)).toBe(false);
            expect(isWindowCovered({ from_date: 100, to_date: 200 }, null)).toBe(false);
            expect(isWindowCovered({ from_date: 'invalid', to_date: 200 }, loaded)).toBe(false);
            expect(isWindowCovered({ from_date: 100, to_date: 200 }, { from_date: null, to_date: 500 })).toBe(false);
        });
    });

    describe('Функция buildRequestShapeKey', () => {
        it('нормализует и сортирует список рангов в канонический вид', () => {
            const key1 = buildRequestShapeKey(['year', 'century'], []);
            const key2 = buildRequestShapeKey(['century', 'year'], []);

            expect(key1).toBe('ranks:century,year|categories:*');
            expect(key2).toBe('ranks:century,year|categories:*');
        });

        it('приводит категории к нижнему регистру, очищает пробелы и сортирует', () => {
            const key = buildRequestShapeKey(
                ['century'],
                [' Science ', 'POLITICS', 'science']
            );

            expect(key).toBe('ranks:century|categories:politics,science');
        });

        it('подставляет звездочку (*) при пустых или неуказанных параметрах', () => {
            expect(buildRequestShapeKey(null, null)).toBe('ranks:*|categories:*');
            expect(buildRequestShapeKey(undefined, undefined)).toBe('ranks:*|categories:*');
            expect(buildRequestShapeKey([], [])).toBe('ranks:*|categories:*');
        });

        it('возвращает замороженную строку', () => {
            const key = buildRequestShapeKey(['year'], ['culture']);
            expect(Object.isFrozen(key)).toBe(true);
        });
    });

    describe('Функция shouldFetchEvents', () => {
        const shapeKey = 'ranks:century,year|categories:*';
        const loadedWindow = { from_date: 0, to_date: 1000 };

        it('возвращает true при первичном старте (loadedWindow равен null)', () => {
            const required = { from_date: 100, to_date: 200 };
            expect(shouldFetchEvents(required, null, shapeKey, null)).toBe(true);
        });

        it('возвращает true при изменении формы запроса даже при полном вложении интервалов', () => {
            const required = { from_date: 100, to_date: 200 };
            const newShapeKey = 'ranks:century,decade,year|categories:*';

            // Окно вложено, но изменился набор рангов — требуется обновить данные
            expect(shouldFetchEvents(required, loadedWindow, newShapeKey, shapeKey)).toBe(true);
        });

        it('возвращает true, если требуемое окно выходит за пределы загруженного при неизменной форме', () => {
            const required = { from_date: 500, to_date: 1200 }; // Выход за правую границу
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey)).toBe(true);
        });

        it('возвращает false при полном попадании в кэш (форма совпадает, интервал вложен)', () => {
            const required = { from_date: 200, to_date: 800 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey)).toBe(false);
        });

        it('возвращает true при усечении выборки и приближении масштаба ровно на 1', () => {
            const required = { from_date: 200, to_date: 800 };
            const context = { isTruncated: true, loadedZoomIndex: 10, currentZoomIndex: 9 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, context)).toBe(true);
        });

        it('возвращает false при усечении выборки и приближении масштаба меньше порога (на 0.5)', () => {
            const required = { from_date: 200, to_date: 800 };
            const context = { isTruncated: true, loadedZoomIndex: 10, currentZoomIndex: 9.5 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, context)).toBe(false);
        });

        it('возвращает false при отсутствии усечения выборки даже при значительном приближении масштаба (на 3)', () => {
            const required = { from_date: 200, to_date: 800 };
            const context = { isTruncated: false, loadedZoomIndex: 10, currentZoomIndex: 7 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, context)).toBe(false);
        });

        it('возвращает false при отдалении масштаба внутри покрытого диапазона', () => {
            const required = { from_date: 200, to_date: 800 };
            const context = { isTruncated: true, loadedZoomIndex: 10, currentZoomIndex: 12 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, context)).toBe(false);
        });

        it('сохраняет стандартное поведение кэширования при явном отсутствии контекста усечения', () => {
            const required = { from_date: 200, to_date: 800 };
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, null)).toBe(false);
            expect(shouldFetchEvents(required, loadedWindow, shapeKey, shapeKey, undefined)).toBe(false);
        });
    });
});
