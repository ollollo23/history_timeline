/**
 * Модульные тесты геометрической проекции и фильтрации маркеров исторических событий.
 * Проверяет вычисление экранных координат, правило вырожденного интервала,
 * определение видимости макрособытий, маппинг переменных темы и ограничение потолка
 * отрисовки во фреймворке Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
    projectEventGeometry,
    isEventVisible,
    getCategoryThemeVariable,
    prepareEventMarkers,
    MIN_EVENT_BAR_WIDTH_PX,
    DEFAULT_MARKER_BUFFER_PX,
    MAX_RENDERED_MARKERS_CEILING,
    CATEGORY_THEME_VARIABLES,
    FALLBACK_CATEGORY_THEME_VARIABLE,
} from '../../frontend/js/timeline/markers.js';

describe('markers module', () => {
    describe('Функция projectEventGeometry', () => {
        it('проецирует точечное событие при end_date === null', () => {
            const event = { start_date: 1000, end_date: null };
            // При originTimestamp = 0 и secondsPerPixel = 10: screenX = (1000 - 0) / 10 = 100
            const geometry = projectEventGeometry(event, 0, 10);

            expect(geometry).toEqual({
                screenX: 100,
                widthPx: 0,
                isPoint: true,
            });
        });

        it('проецирует точечное событие при end_date === undefined или end_date <= start_date', () => {
            const eventWithoutEnd = { start_date: 500 };
            expect(projectEventGeometry(eventWithoutEnd, 0, 5)).toEqual({
                screenX: 100,
                widthPx: 0,
                isPoint: true,
            });

            const eventEqualDates = { start_date: 500, end_date: 500 };
            expect(projectEventGeometry(eventEqualDates, 0, 5)).toEqual({
                screenX: 100,
                widthPx: 0,
                isPoint: true,
            });

            const eventInvertedDates = { start_date: 500, end_date: 400 };
            expect(projectEventGeometry(eventInvertedDates, 0, 5)).toEqual({
                screenX: 100,
                widthPx: 0,
                isPoint: true,
            });
        });

        it('распознает вырожденный интервал и отображает его как точечный маркер', () => {
            // Длительность 20 секунд при масштабе 10 с/пкс дает rawWidthPx = 2px
            // При minBarWidth = 4px интервал обязан стать точечным маркером
            const degenerateEvent = { start_date: 1000, end_date: 1020 };
            const geometry = projectEventGeometry(degenerateEvent, 0, 10, MIN_EVENT_BAR_WIDTH_PX);

            expect(geometry).toEqual({
                screenX: 100,
                widthPx: 0,
                isPoint: true,
            });
        });

        it('корректно рассчитывает экранную ширину для полноценного интервального события', () => {
            // Длительность 500 секунд при масштабе 10 с/пкс дает rawWidthPx = 50px (>= 4px)
            const intervalEvent = { start_date: 1000, end_date: 1500 };
            const geometry = projectEventGeometry(intervalEvent, 0, 10, MIN_EVENT_BAR_WIDTH_PX);

            expect(geometry).toEqual({
                screenX: 100,
                widthPx: 50,
                isPoint: false,
            });
        });
    });

    describe('Функция isEventVisible', () => {
        const originTimestamp = 1000;
        const secondsPerPixel = 1;
        const widthPx = 800;
        const bufferPx = 50;

        // Видимая область холста: [0, 800] px -> timestamp [1000, 1800]
        // Расширенная область с буфером: [-50, 850] px -> timestamp [950, 1850]

        it('возвращает true для точечного события внутри видимой области экрана', () => {
            const event = { start_date: 1400, end_date: null }; // screenX = 400px
            expect(isEventVisible(event, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);
        });

        it('возвращает true для точечного события в зоне левого или правого буфера', () => {
            const leftBufferEvent = { start_date: 970, end_date: null }; // screenX = -30px (внутри [-50, 0))
            expect(isEventVisible(leftBufferEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);

            const rightBufferEvent = { start_date: 1830, end_date: null }; // screenX = 830px (внутри (800, 850])
            expect(isEventVisible(rightBufferEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);
        });

        it('возвращает false для точечного события за пределами буферной зоны', () => {
            const farLeftEvent = { start_date: 900, end_date: null }; // screenX = -100px (< -50px)
            expect(isEventVisible(farLeftEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(false);

            const farRightEvent = { start_date: 1900, end_date: null }; // screenX = 900px (> 850px)
            expect(isEventVisible(farRightEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(false);
        });

        it('возвращает true для интервального события, частично пересекающего границы экрана', () => {
            // Пересечение левой границы: началось далеко слева, закончилось внутри экрана
            const crossLeftEvent = { start_date: 500, end_date: 1200 }; // [-500px, 200px]
            expect(isEventVisible(crossLeftEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);

            // Пересечение правой границы: началось внутри экрана, закончилось далеко справа
            const crossRightEvent = { start_date: 1600, end_date: 2500 }; // [600px, 1500px]
            expect(isEventVisible(crossRightEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);
        });

        it('возвращает true для масштабного события, целиком накрывающего экран с обеих сторон', () => {
            // Началось до левого буфера и закончилось после правого буфера
            const macroEvent = { start_date: -5000, end_date: 15000 }; // screenX от -6000px до 14000px
            expect(isEventVisible(macroEvent, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(true);
        });

        it('возвращает false для интервального события, целиком лежащего за пределами буфера', () => {
            const leftInterval = { start_date: 200, end_date: 800 }; // [-800px, -200px]
            expect(isEventVisible(leftInterval, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(false);

            const rightInterval = { start_date: 2000, end_date: 2500 }; // [1000px, 1500px]
            expect(isEventVisible(rightInterval, originTimestamp, secondsPerPixel, widthPx, bufferPx)).toBe(false);
        });
    });

    describe('Функция getCategoryThemeVariable', () => {
        it('возвращает корректные переменные темы для регламентированных категорий', () => {
            expect(getCategoryThemeVariable('culture')).toBe(CATEGORY_THEME_VARIABLES.culture);
            expect(getCategoryThemeVariable('politics')).toBe(CATEGORY_THEME_VARIABLES.politics);
            expect(getCategoryThemeVariable('economy')).toBe(CATEGORY_THEME_VARIABLES.economy);
            expect(getCategoryThemeVariable('science')).toBe(CATEGORY_THEME_VARIABLES.science);
        });

        it('нечувствительна к регистру символов и лишним пробелам', () => {
            expect(getCategoryThemeVariable('  Culture  ')).toBe('--color-category-culture');
            expect(getCategoryThemeVariable('POLITICS')).toBe('--color-category-politics');
            expect(getCategoryThemeVariable('Science')).toBe('--color-category-science');
            expect(getCategoryThemeVariable('  eCoNoMy ')).toBe('--color-category-economy');
        });

        it('возвращает запасную переменную темы для неизвестных или пользовательских категорий', () => {
            expect(getCategoryThemeVariable('military')).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable('religion')).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable('custom_tag')).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable('')).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
        });

        it('возвращает запасную переменную темы для некорректных типов данных', () => {
            expect(getCategoryThemeVariable(null)).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable(undefined)).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable(123)).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
            expect(getCategoryThemeVariable({})).toBe(FALLBACK_CATEGORY_THEME_VARIABLE);
        });
    });

    describe('Функция prepareEventMarkers', () => {
        const originTimestamp = 0;
        const secondsPerPixel = 1;
        const widthPx = 500;

        it('полностью трансформирует массив доменных сущностей в геометрические маркеры', () => {
            const rawEvents = [
                { id: 1, title: 'Событие 1', start_date: 50, end_date: null, category: 'science' },
                { id: 2, title: 'Событие 2', start_date: 100, end_date: 200, category: 'politics' },
            ];

            const markers = prepareEventMarkers(rawEvents, originTimestamp, secondsPerPixel, widthPx);

            expect(markers).toHaveLength(2);

            expect(markers[0]).toEqual({
                event: rawEvents[0],
                screenX: 50,
                widthPx: 0,
                isPoint: true,
                themeVariable: '--color-category-science',
            });

            expect(markers[1]).toEqual({
                event: rawEvents[1],
                screenX: 100,
                widthPx: 100,
                isPoint: false,
                themeVariable: '--color-category-politics',
            });
        });

        it('отсекает события, находящиеся за пределами видимости', () => {
            const rawEvents = [
                { id: 1, title: 'Вне видимости слева', start_date: -500, end_date: null, category: 'science' },
                { id: 2, title: 'Внутри видимости', start_date: 250, end_date: null, category: 'culture' },
                { id: 3, title: 'Вне видимости справа', start_date: 1500, end_date: null, category: 'economy' },
            ];

            const markers = prepareEventMarkers(rawEvents, originTimestamp, secondsPerPixel, widthPx);

            expect(markers).toHaveLength(1);
            expect(markers[0].event.id).toBe(2);
        });

        it('строго соблюдает защитный потолок количества отрисовываемых маркеров', () => {
            // Генерация 50 видимых событий
            const rawEvents = [];
            for (let i = 0; i < 50; i++) {
                rawEvents.push({
                    id: i + 1,
                    title: `Событие #${i + 1}`,
                    start_date: 10 + i * 5, // Все события попадают в диапазон [10, 255]
                    end_date: null,
                    category: 'science',
                });
            }

            const limit = 15;
            const markers = prepareEventMarkers(rawEvents, originTimestamp, secondsPerPixel, widthPx, {
                maxMarkers: limit,
            });

            expect(markers).toHaveLength(limit);
        });

        it('сохраняет исходный хронологический порядок событий при усечении по потолку', () => {
            const rawEvents = [];
            for (let i = 0; i < 20; i++) {
                rawEvents.push({
                    id: i + 1,
                    title: `Событие #${i + 1}`,
                    start_date: 100 + i * 10,
                    end_date: null,
                    category: 'politics',
                });
            }

            const markers = prepareEventMarkers(rawEvents, originTimestamp, secondsPerPixel, widthPx, {
                maxMarkers: 5,
            });

            expect(markers).toHaveLength(5);
            // Первые 5 маркеров обязаны строго соответствовать первым 5 событиям
            for (let i = 0; i < 5; i++) {
                expect(markers[i].event.id).toBe(i + 1);
                expect(markers[i].event.start_date).toBe(100 + i * 10);
            }
        });

        it('корректно обрабатывает пустые или некорректные входные данные', () => {
            expect(prepareEventMarkers([], originTimestamp, secondsPerPixel, widthPx)).toEqual([]);
            expect(prepareEventMarkers(null, originTimestamp, secondsPerPixel, widthPx)).toEqual([]);
            expect(prepareEventMarkers(undefined, originTimestamp, secondsPerPixel, widthPx)).toEqual([]);
            expect(prepareEventMarkers('not_an_array', originTimestamp, secondsPerPixel, widthPx)).toEqual([]);
        });

        it('использует константу MAX_RENDERED_MARKERS_CEILING по умолчанию', () => {
            expect(MAX_RENDERED_MARKERS_CEILING).toBe(500);
            expect(DEFAULT_MARKER_BUFFER_PX).toBe(50);
        });
    });
});
