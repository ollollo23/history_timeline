/**
 * Модульные тесты клиентского реестра категорий исторических событий (categories.js).
 * Проверяет структуру реестра, константы, граничные случаи нормализации идентификаторов,
 * извлечение дескрипторов и подписей, синхронизацию с файлом style.css
 * и соблюдение минимального контраста WCAG 2.1 относительно темного фона.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CATEGORY_REGISTRY,
    FALLBACK_CATEGORY,
    CATEGORY_IDS,
    normalizeCategoryId,
    getCategoryDescriptor,
    getCategoryLabel,
} from '../../frontend/js/timeline/categories.js';

/**
 * Преобразование шестнадцатеричной строки цвета (#rrggbb) в числовые компоненты RGB.
 *
 * @param {string} hex Строка цвета в формате #rrggbb.
 * @returns {{ r: number, g: number, b: number }} Числовые каналы от 0 до 255.
 */
function hexToRgb(hex) {
    const cleanHex = hex.replace('#', '').trim();
    const num = parseInt(cleanHex, 16);
    return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255,
    };
}

/**
 * Расчет относительной яркости (relative luminance) цвета по спецификации WCAG 2.1.
 *
 * @param {{ r: number, g: number, b: number }} rgb Объект с компонентами r, g, b в диапазоне [0, 255].
 * @returns {number} Значение относительной яркости в диапазоне [0, 1].
 */
function getLuminance({ r, g, b }) {
    const [sR, sG, sB] = [r, g, b].map((val) => {
        const s = val / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

/**
 * Расчет коэффициента контрастности между двумя цветами по стандарту WCAG 2.1.
 *
 * @param {string} hex1 Первый цвет (#rrggbb).
 * @param {string} hex2 Второй цвет (#rrggbb).
 * @returns {number} Отношение контрастности от 1 до 21.
 */
function getContrastRatio(hex1, hex2) {
    const lum1 = getLuminance(hexToRgb(hex1));
    const lum2 = getLuminance(hexToRgb(hex2));
    const brightest = Math.max(lum1, lum2);
    const darkest = Math.min(lum1, lum2);
    return (brightest + 0.05) / (darkest + 0.05);
}

describe('Модуль реестра категорий categories.js', () => {
    describe('Структура реестра и констант', () => {
        it('экспортирует замороженный массив CATEGORY_IDS с уникальными элементами в строгом порядке', () => {
            expect(Object.isFrozen(CATEGORY_IDS)).toBe(true);
            expect(CATEGORY_IDS).toEqual(['culture', 'politics', 'economy', 'science']);
            expect(new Set(CATEGORY_IDS).size).toBe(4);
        });

        it('экспортирует глубоко замороженный массив CATEGORY_REGISTRY с корректными полями дескрипторов', () => {
            expect(Object.isFrozen(CATEGORY_REGISTRY)).toBe(true);
            expect(CATEGORY_REGISTRY).toHaveLength(4);

            const ids = CATEGORY_REGISTRY.map((item) => item.id);
            expect(ids).toEqual(['culture', 'politics', 'economy', 'science']);

            for (const descriptor of CATEGORY_REGISTRY) {
                expect(Object.isFrozen(descriptor)).toBe(true);
                expect(typeof descriptor.id).toBe('string');
                expect(descriptor.id.length).toBeGreaterThan(0);
                expect(typeof descriptor.label).toBe('string');
                expect(descriptor.label.length).toBeGreaterThan(0);
                expect(descriptor.themeVariable).toBe(`--color-category-${descriptor.id}`);
                expect(typeof descriptor.fallbackColor).toBe('string');
                expect(descriptor.fallbackColor).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        });

        it('экспортирует неизменяемый объект FALLBACK_CATEGORY для резервной категории', () => {
            expect(Object.isFrozen(FALLBACK_CATEGORY)).toBe(true);
            expect(FALLBACK_CATEGORY).toEqual({
                id: 'other',
                label: 'Прочее',
                themeVariable: '--color-category-other',
                fallbackColor: '#b0b0b8',
            });
        });
    });

    describe('Функция normalizeCategoryId', () => {
        it('возвращает валидные строковые идентификаторы без изменений', () => {
            expect(normalizeCategoryId('culture')).toBe('culture');
            expect(normalizeCategoryId('politics')).toBe('politics');
            expect(normalizeCategoryId('economy')).toBe('economy');
            expect(normalizeCategoryId('science')).toBe('science');
        });

        it('выполняет нечувствительное к регистру приведение', () => {
            expect(normalizeCategoryId('CULTURE')).toBe('culture');
            expect(normalizeCategoryId('Politics')).toBe('politics');
            expect(normalizeCategoryId('eCoNoMy')).toBe('economy');
            expect(normalizeCategoryId('SCIENCE')).toBe('science');
        });

        it('выполняет обрезку краевых пробельных символов и переводов строк', () => {
            expect(normalizeCategoryId('  culture  ')).toBe('culture');
            expect(normalizeCategoryId('\tpolitics\n')).toBe('politics');
            expect(normalizeCategoryId('   economy ')).toBe('economy');
            expect(normalizeCategoryId('science\r\n')).toBe('science');
        });

        it('возвращает null для нестроковых типов аргументов', () => {
            expect(normalizeCategoryId(null)).toBeNull();
            expect(normalizeCategoryId(undefined)).toBeNull();
            expect(normalizeCategoryId(123)).toBeNull();
            expect(normalizeCategoryId({})).toBeNull();
            expect(normalizeCategoryId([])).toBeNull();
            expect(normalizeCategoryId(true)).toBeNull();
            expect(normalizeCategoryId(false)).toBeNull();
        });

        it('возвращает null для пустых, пробельных и неизвестных категорий', () => {
            expect(normalizeCategoryId('')).toBeNull();
            expect(normalizeCategoryId('   ')).toBeNull();
            expect(normalizeCategoryId('unknown')).toBeNull();
            expect(normalizeCategoryId('military')).toBeNull();
            expect(normalizeCategoryId('religion')).toBeNull();
            expect(normalizeCategoryId('other')).toBeNull();
        });
    });

    describe('Функции getCategoryDescriptor и getCategoryLabel', () => {
        it('возвращает точный дескриптор из CATEGORY_REGISTRY для зарегистрированных категорий', () => {
            expect(getCategoryDescriptor('culture')).toBe(CATEGORY_REGISTRY[0]);
            expect(getCategoryDescriptor('POLITICS')).toBe(CATEGORY_REGISTRY[1]);
            expect(getCategoryDescriptor('  economy  ')).toBe(CATEGORY_REGISTRY[2]);
            expect(getCategoryDescriptor('science')).toBe(CATEGORY_REGISTRY[3]);
        });

        it('возвращает FALLBACK_CATEGORY для неизвестных значений, опечаток и некорректных типов', () => {
            expect(getCategoryDescriptor('other')).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor('unknown')).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor('')).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor('   ')).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor(null)).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor(undefined)).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor(42)).toBe(FALLBACK_CATEGORY);
            expect(getCategoryDescriptor({})).toBe(FALLBACK_CATEGORY);
        });

        it('возвращает локализованные подписи категорий через getCategoryLabel', () => {
            expect(getCategoryLabel('culture')).toBe('Культура');
            expect(getCategoryLabel('politics')).toBe('Политика');
            expect(getCategoryLabel('economy')).toBe('Экономика');
            expect(getCategoryLabel('science')).toBe('Наука');
            expect(getCategoryLabel('other')).toBe('Прочее');
            expect(getCategoryLabel('unknown_category')).toBe('Прочее');
            expect(getCategoryLabel(null)).toBe('Прочее');
            expect(getCategoryLabel(undefined)).toBe('Прочее');
        });
    });

    describe('Сверка fallbackColor со значениями в style.css', () => {
        it('содержит объявленные переменные цветов в блоке :root файла style.css', () => {
            const currentDir = dirname(fileURLToPath(import.meta.url));
            const cssPath = resolve(currentDir, '../../frontend/css/style.css');
            const styleCss = readFileSync(cssPath, 'utf-8');

            const rootBlockMatch = styleCss.match(/:root\s*\{([^}]+)\}/);
            expect(rootBlockMatch).not.toBeNull();
            const rootContent = rootBlockMatch[1];

            // Таблица допустимых значений: целевая палитра либо переходная палитра до задачи 3.1
            const transitionalLegacyColors = {
                '--color-category-culture': '#a855f7',
                '--color-category-politics': '#ef4444',
                '--color-category-economy': '#eab308',
                '--color-category-science': '#06b6d4',
                '--color-category-other': '#64748b',
            };

            const allCategoriesToCheck = [...CATEGORY_REGISTRY, FALLBACK_CATEGORY];

            for (const category of allCategoriesToCheck) {
                const varName = category.themeVariable;
                const varRegex = new RegExp(`${varName}\\s*:\\s*(#[0-9a-fA-F]{6})`);
                const match = rootContent.match(varRegex);

                expect(match).not.toBeNull();

                const cssHexValue = match[1].toLowerCase();
                const expectedTargetHex = category.fallbackColor.toLowerCase();
                const allowedLegacyHex = transitionalLegacyColors[varName]?.toLowerCase();

                expect([expectedTargetHex, allowedLegacyHex]).toContain(cssHexValue);
            }
        });
    });

    describe('Проверка контрастности по стандарту WCAG 2.1', () => {
        const backgroundDark = '#121214';

        it('гарантирует коэффициент контрастности не ниже 3:1 для всех категорий на фоне темы', () => {
            const allCategories = [...CATEGORY_REGISTRY, FALLBACK_CATEGORY];

            for (const category of allCategories) {
                const contrast = getContrastRatio(category.fallbackColor, backgroundDark);
                expect(contrast).toBeGreaterThanOrEqual(3.0);
            }
        });
    });
});
