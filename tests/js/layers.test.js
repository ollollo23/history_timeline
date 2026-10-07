/**
 * Модульные тесты математической модели слоев категорий (layers.js).
 * Проверяет глубокую иммутабельность состояния, граничные случаи перемещения слоев,
 * дискретизацию и ограничение непрозрачности, устойчивость нормализации к поврежденным структурам,
 * ветки формирования сетевого запроса, фильтрацию событий, генерацию конфигурации рендерера,
 * план переходов состояния, детекцию порядка, подсчет активных слоев
 * и отказоустойчивость работы с Web Storage (включая SecurityError) во фреймворке Vitest.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    LAYER_OPACITY_MIN,
    LAYER_OPACITY_MAX,
    LAYER_STATE_STORAGE_KEY,
    LAYER_STATE_VERSION,
} from '../../frontend/js/timeline/constants.js';
import {
    CATEGORY_IDS,
    FALLBACK_CATEGORY,
} from '../../frontend/js/timeline/categories.js';
import {
    createDefaultLayerState,
    normalizeLayerState,
    moveLayer,
    setLayerVisibility,
    toggleLayerVisibility,
    showOnlyLayer,
    showAllLayers,
    setLayerOpacity,
    snapLayerOpacity,
    isCategoryFilterActive,
    getCategoryRequest,
    filterEventsByLayers,
    buildLayerPriority,
    buildLayerRenderConfig,
    haveSameLayerStructure,
    hasLayerOrderChanged,
    planLayerStateTransition,
    countVisibleLayers,
    loadLayerState,
    saveLayerState,
} from '../../frontend/js/timeline/layers.js';

/**
 * Вспомогательная фабрика имитации интерфейса Web Storage в оперативной памяти.
 *
 * @returns {{ getItem: (key: string) => string|null, setItem: (key: string, value: string) => void }}
 */
function createFakeStorage() {
    const memory = new Map();
    return {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => {
            memory.set(key, String(value));
        },
    };
}

describe('Модуль модели слоев layers.js', () => {
    describe('Иммутабельность и базовые модификации состояния', () => {
        it('создает глубоко замороженное состояние по умолчанию', () => {
            const state = createDefaultLayerState();

            expect(Object.isFrozen(state)).toBe(true);
            expect(Object.isFrozen(state.order)).toBe(true);
            expect(Object.isFrozen(state.visible)).toBe(true);
            expect(Object.isFrozen(state.opacity)).toBe(true);

            expect(state.version).toBe(LAYER_STATE_VERSION);
            expect(state.order).toEqual(CATEGORY_IDS);

            for (let i = 0; i < CATEGORY_IDS.length; i++) {
                const id = CATEGORY_IDS[i];
                expect(state.visible[id]).toBe(true);
                expect(state.opacity[id]).toBe(1.0);
            }
        });

        it('гарантирует неизменяемость исходного объекта при вызовах функций модификации', () => {
            const initial = createDefaultLayerState();

            const mutations = [
                () => moveLayer(initial, 'culture', 1),
                () => setLayerVisibility(initial, 'culture', false),
                () => toggleLayerVisibility(initial, 'politics'),
                () => showOnlyLayer(initial, 'economy'),
                () => showAllLayers(initial),
                () => setLayerOpacity(initial, 'science', 0.5),
            ];

            for (let i = 0; i < mutations.length; i++) {
                const nextState = mutations[i]();

                expect(nextState).not.toBe(initial);
                expect(Object.isFrozen(nextState)).toBe(true);
                expect(Object.isFrozen(nextState.order)).toBe(true);
                expect(Object.isFrozen(nextState.visible)).toBe(true);
                expect(Object.isFrozen(nextState.opacity)).toBe(true);

                // Проверка сохранности исходного состояния
                expect(initial.version).toBe(LAYER_STATE_VERSION);
                expect(initial.order).toEqual(CATEGORY_IDS);
                expect(initial.visible.culture).toBe(true);
                expect(initial.visible.politics).toBe(true);
                expect(initial.opacity.science).toBe(1.0);
            }
        });
    });

    describe('Граничные случаи функции moveLayer', () => {
        it('меняет местами смежные элементы при перемещении в допустимых пределах', () => {
            const state = createDefaultLayerState();
            // Исходный порядок: ['culture', 'politics', 'economy', 'science']

            // Сдвиг первого элемента вниз
            const shiftedDown = moveLayer(state, 'culture', 1);
            expect(shiftedDown.order).toEqual(['politics', 'culture', 'economy', 'science']);

            // Сдвиг обратно вверх
            const shiftedUp = moveLayer(shiftedDown, 'culture', -1);
            expect(shiftedUp.order).toEqual(['culture', 'politics', 'economy', 'science']);
        });

        it('возвращает исходный объект по ссылке при попытке выхода за границы диапазона', () => {
            const state = createDefaultLayerState();
            const topId = state.order[0];
            const bottomId = state.order[state.order.length - 1];

            // Попытка сдвинуть верхний элемент еще выше
            const attemptTop = moveLayer(state, topId, -1);
            expect(attemptTop).toBe(state);

            // Попытка сдвинуть нижний элемент еще ниже
            const attemptBottom = moveLayer(state, bottomId, 1);
            expect(attemptBottom).toBe(state);
        });

        it('возвращает исходный объект по ссылке при неизвестном идентификаторе категории', () => {
            const state = createDefaultLayerState();
            expect(moveLayer(state, 'unknown_layer', 1)).toBe(state);
            expect(moveLayer(state, null, -1)).toBe(state);
        });

        it('сохраняет неизменным порядок слоев при передаче нулевого смещения delta', () => {
            const state = createDefaultLayerState();
            const result = moveLayer(state, 'culture', 0);
            expect(result.order).toEqual(state.order);
            expect(result.visible).toEqual(state.visible);
            expect(result.opacity).toEqual(state.opacity);
        });
    });

    describe('Округление и ограничение непрозрачности', () => {
        it('корректно ограничивает и округляет значения в setLayerOpacity', () => {
            const state = createDefaultLayerState();

            // Ограничение нижним порогом LAYER_OPACITY_MIN (0.4)
            expect(setLayerOpacity(state, 'culture', 0).opacity.culture).toBe(LAYER_OPACITY_MIN);
            expect(setLayerOpacity(state, 'culture', 0.3).opacity.culture).toBe(LAYER_OPACITY_MIN);
            expect(setLayerOpacity(state, 'culture', -0.5).opacity.culture).toBe(LAYER_OPACITY_MIN);

            // Округление до ближайшего шага 0.1 без дробного шума
            expect(setLayerOpacity(state, 'culture', 0.37).opacity.culture).toBe(0.4);
            expect(setLayerOpacity(state, 'culture', 0.54).opacity.culture).toBe(0.5);
            expect(setLayerOpacity(state, 'culture', 0.95).opacity.culture).toBe(LAYER_OPACITY_MAX);

            // Ограничение верхним порогом LAYER_OPACITY_MAX (1.0)
            expect(setLayerOpacity(state, 'culture', 1.4).opacity.culture).toBe(LAYER_OPACITY_MAX);

            // Невалидные типы приводят к значению 1.0
            expect(setLayerOpacity(state, 'culture', NaN).opacity.culture).toBe(1.0);
            expect(setLayerOpacity(state, 'culture', null).opacity.culture).toBe(1.0);
            expect(setLayerOpacity(state, 'culture', undefined).opacity.culture).toBe(1.0);
            expect(setLayerOpacity(state, 'culture', '0.5').opacity.culture).toBe(1.0);
        });

        it('применяет аналогичные правила ограничения непрозрачности в normalizeLayerState', () => {
            const raw = {
                version: LAYER_STATE_VERSION,
                opacity: {
                    culture: 0,
                    politics: 0.3,
                    economy: 0.37,
                    science: 0.54,
                },
            };

            const normalized = normalizeLayerState(raw);
            expect(normalized.opacity.culture).toBe(LAYER_OPACITY_MIN);
            expect(normalized.opacity.politics).toBe(LAYER_OPACITY_MIN);
            expect(normalized.opacity.economy).toBe(0.4);
            expect(normalized.opacity.science).toBe(0.5);

            const rawHighAndInvalid = {
                version: LAYER_STATE_VERSION,
                opacity: {
                    culture: 0.95,
                    politics: 1.5,
                    economy: 'not_a_number',
                    science: null,
                },
            };

            const normalizedHigh = normalizeLayerState(rawHighAndInvalid);
            expect(normalizedHigh.opacity.culture).toBe(1.0);
            expect(normalizedHigh.opacity.politics).toBe(1.0);
            expect(normalizedHigh.opacity.economy).toBe(1.0);
            expect(normalizedHigh.opacity.science).toBe(1.0);
        });

        it('прямой вызов snapLayerOpacity выполняет корректное квантование и ограничение', () => {
            expect(snapLayerOpacity(0)).toBe(LAYER_OPACITY_MIN);
            expect(snapLayerOpacity(0.3)).toBe(LAYER_OPACITY_MIN);
            expect(snapLayerOpacity(0.37)).toBe(0.4);
            expect(snapLayerOpacity(0.54)).toBe(0.5);
            expect(snapLayerOpacity(0.95)).toBe(1.0);
            expect(snapLayerOpacity(1.4)).toBe(1.0);

            expect(snapLayerOpacity(NaN)).toBe(1.0);
            expect(snapLayerOpacity(null)).toBe(1.0);
            expect(snapLayerOpacity(undefined)).toBe(1.0);
            expect(snapLayerOpacity('0.5')).toBe(1.0);
            expect(snapLayerOpacity('invalid')).toBe(1.0);
        });
    });

    describe('Устойчивость к мусору функции normalizeLayerState', () => {
        it('возвращает дефолтное состояние при невалидном типе или чужой версии', () => {
            const defaultState = createDefaultLayerState();

            expect(normalizeLayerState(null)).toEqual(defaultState);
            expect(normalizeLayerState(undefined)).toEqual(defaultState);
            expect(normalizeLayerState(123)).toEqual(defaultState);
            expect(normalizeLayerState('broken_data')).toEqual(defaultState);
            expect(normalizeLayerState(true)).toEqual(defaultState);

            // Чужие или отсутствующие версии
            expect(normalizeLayerState({ version: 99 })).toEqual(defaultState);
            expect(normalizeLayerState({ version: 0 })).toEqual(defaultState);
            expect(normalizeLayerState({})).toEqual(defaultState);
        });

        it('устраняет дубликаты, отбрасывает неизвестные id и дополняет недостающие в order', () => {
            const raw = {
                version: LAYER_STATE_VERSION,
                order: ['science', 'unknown', 'science', 'politics'],
            };

            const normalized = normalizeLayerState(raw);
            // science и politics сохраняются первыми, недостающие culture и economy добавляются в конец
            expect(normalized.order).toEqual(['science', 'politics', 'culture', 'economy']);
        });

        it('нормализует не-булевы значения флагов visible в true', () => {
            const raw = {
                version: LAYER_STATE_VERSION,
                visible: {
                    science: false,
                    politics: 'not_bool',
                    culture: null,
                },
            };

            const normalized = normalizeLayerState(raw);
            expect(normalized.visible.science).toBe(false);
            expect(normalized.visible.politics).toBe(true);
            expect(normalized.visible.culture).toBe(true);
            expect(normalized.visible.economy).toBe(true);
        });
    });

    describe('Ветки getCategoryRequest и флаг активности фильтра', () => {
        it('возвращает { shouldRequest: true, categories: [] } при всех включенных слоях', () => {
            const state = createDefaultLayerState();

            expect(isCategoryFilterActive(state)).toBe(false);

            const request = getCategoryRequest(state);
            expect(request).toEqual({
                shouldRequest: true,
                categories: [],
            });
        });

        it('возвращает список видимых категорий в текущем порядке при частичной видимости', () => {
            let state = createDefaultLayerState();
            state = moveLayer(state, 'science', -1);
            state = moveLayer(state, 'science', -1);
            state = moveLayer(state, 'science', -1); // science теперь первый
            state = setLayerVisibility(state, 'culture', false); // culture выключен

            expect(isCategoryFilterActive(state)).toBe(true);

            const request = getCategoryRequest(state);
            expect(request.shouldRequest).toBe(true);
            // Порядок строго по state.order без скрытой culture
            expect(request.categories).toEqual(['science', 'politics', 'economy']);
        });

        it('возвращает { shouldRequest: false, categories: [] } когда все слои скрыты', () => {
            let state = createDefaultLayerState();
            for (let i = 0; i < CATEGORY_IDS.length; i++) {
                state = setLayerVisibility(state, CATEGORY_IDS[i], false);
            }

            expect(isCategoryFilterActive(state)).toBe(true);

            const request = getCategoryRequest(state);
            expect(request).toEqual({
                shouldRequest: false,
                categories: [],
            });
        });

        it('корректно обрабатывает вызовы showOnlyLayer и showAllLayers', () => {
            const state = createDefaultLayerState();
            const soloState = showOnlyLayer(state, 'politics');

            expect(soloState.visible.politics).toBe(true);
            expect(soloState.visible.culture).toBe(false);
            expect(soloState.visible.economy).toBe(false);
            expect(soloState.visible.science).toBe(false);

            const allState = showAllLayers(soloState);
            for (let i = 0; i < CATEGORY_IDS.length; i++) {
                expect(allState.visible[CATEGORY_IDS[i]]).toBe(true);
            }
        });
    });

    describe('Клиентская фильтрация событий filterEventsByLayers', () => {
        it('возвращает пустой массив при некорректных входных параметрах', () => {
            const state = createDefaultLayerState();
            expect(filterEventsByLayers(null, state)).toEqual([]);
            expect(filterEventsByLayers(undefined, state)).toEqual([]);
            expect(filterEventsByLayers(123, state)).toEqual([]);
        });

        it('фильтрует события с известными категориями согласно флагам visible', () => {
            let state = createDefaultLayerState();
            state = setLayerVisibility(state, 'politics', false);

            const events = [
                { id: 1, title: 'Культура 1', category: 'culture' },
                { id: 2, title: 'Политика 1', category: 'politics' },
                { id: 3, title: 'Наука 1', category: 'science' },
            ];

            const filtered = filterEventsByLayers(events, state);
            expect(filtered.map((e) => e.id)).toEqual([1, 3]);
        });

        it('пропускает события с неизвестной категорией только при отсутствии активного фильтра', () => {
            const events = [
                { id: 10, title: 'Неизвестная', category: 'unknown_cat' },
                { id: 11, title: 'Без категории', category: null },
            ];

            // 1. Фильтр не активен: все слои видимы
            const stateNoFilter = createDefaultLayerState();
            expect(filterEventsByLayers(events, stateNoFilter)).toEqual(events);

            // 2. Фильтр активен: хотя бы один слой скрыт
            const stateWithFilter = setLayerVisibility(stateNoFilter, 'culture', false);
            expect(filterEventsByLayers(events, stateWithFilter)).toEqual([]);
        });
    });

    describe('Приоритет слоев и конфигурация рендеринга', () => {
        it('формирует карту весовых приоритетов buildLayerPriority строго по порядку order', () => {
            let state = createDefaultLayerState();
            // Пошаговое перемещение science на вершину списка
            state = moveLayer(state, 'science', -1);
            state = moveLayer(state, 'science', -1);
            state = moveLayer(state, 'science', -1);

            const priority = buildLayerPriority(state);
            expect(priority.get('science')).toBe(0);
            expect(priority.get('culture')).toBe(1);
            expect(priority.get('politics')).toBe(2);
            expect(priority.get('economy')).toBe(3);
        });

        it('формирует конфигурацию рендеринга с инвертированным порядком отрисовки снизу вверх', () => {
            let state = createDefaultLayerState();
            // Исходный порядок сверху вниз: culture, politics, economy, science
            state = setLayerOpacity(state, 'science', 0.6);
            state = setLayerVisibility(state, 'politics', false);

            const config = buildLayerRenderConfig(state);
            expect(Object.isFrozen(config)).toBe(true);

            // Запасная категория первая, затем слои в обратном порядке (снизу вверх)
            expect(config.drawOrder).toEqual([
                FALLBACK_CATEGORY.themeVariable,
                '--color-category-science',
                '--color-category-economy',
                '--color-category-politics',
                '--color-category-culture',
            ]);

            // Проверка уровней прозрачности: скрытый слой politics получает альфу 0
            expect(config.alphaByThemeVariable['--color-category-science']).toBe(0.6);
            expect(config.alphaByThemeVariable['--color-category-economy']).toBe(1.0);
            expect(config.alphaByThemeVariable['--color-category-politics']).toBe(0);
            expect(config.alphaByThemeVariable['--color-category-culture']).toBe(1.0);

            // Так как фильтр активен (politics выключен), запасная категория получает альфу 0
            expect(config.alphaByThemeVariable[FALLBACK_CATEGORY.themeVariable]).toBe(0);
        });
    });

    describe('Сравнение структуры слоев haveSameLayerStructure', () => {
        it('возвращает true при совпадении порядка и видимости даже при разной непрозрачности', () => {
            const a = createDefaultLayerState();
            const b = setLayerOpacity(a, 'culture', 0.6);

            expect(haveSameLayerStructure(a, b)).toBe(true);
        });

        it('возвращает false при изменении порядка или видимости любого слоя', () => {
            const a = createDefaultLayerState();
            const orderChanged = moveLayer(a, 'culture', 1);
            const visibilityChanged = setLayerVisibility(a, 'culture', false);

            expect(haveSameLayerStructure(a, orderChanged)).toBe(false);
            expect(haveSameLayerStructure(a, visibilityChanged)).toBe(false);
            expect(haveSameLayerStructure(a, null)).toBe(false);
        });
    });

    describe('Определение изменения порядка hasLayerOrderChanged', () => {
        it('возвращает false при одинаковом порядке категорий', () => {
            const state = createDefaultLayerState();
            expect(hasLayerOrderChanged(state, state)).toBe(false);
            expect(hasLayerOrderChanged(state, createDefaultLayerState())).toBe(false);
        });

        it('возвращает true при перестановке слоев', () => {
            const state = createDefaultLayerState();
            const moved = moveLayer(state, 'culture', 1);
            expect(hasLayerOrderChanged(state, moved)).toBe(true);
        });

        it('возвращает true при невалидных входных аргументах', () => {
            const state = createDefaultLayerState();
            expect(hasLayerOrderChanged(null, state)).toBe(true);
            expect(hasLayerOrderChanged(state, null)).toBe(true);
            expect(hasLayerOrderChanged({}, state)).toBe(true);
            expect(hasLayerOrderChanged(state, { order: ['culture'] })).toBe(true);
        });
    });

    describe('План перехода состояния planLayerStateTransition', () => {
        it('Случай 1: возвращает все поля false при ссылочном равенстве состояний', () => {
            const state = createDefaultLayerState();
            const plan = planLayerStateTransition(state, state);

            expect(plan).toEqual({
                changed: false,
                updateAppearance: false,
                relayout: false,
                resetLaneAssignments: false,
                requestData: false,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 2: возвращает все поля false при равном содержимом и разных ссылках', () => {
            const state = createDefaultLayerState();
            const anotherDefault = createDefaultLayerState();
            const plan = planLayerStateTransition(state, anotherDefault);

            expect(plan).toEqual({
                changed: false,
                updateAppearance: false,
                relayout: false,
                resetLaneAssignments: false,
                requestData: false,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 3: активирует только changed и updateAppearance при изменении только прозрачности', () => {
            const state = createDefaultLayerState();
            const modified = setLayerOpacity(state, 'culture', 0.6);
            const plan = planLayerStateTransition(state, modified);

            expect(plan).toEqual({
                changed: true,
                updateAppearance: true,
                relayout: false,
                resetLaneAssignments: false,
                requestData: false,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 4: требует релейаут и сброс дорожек при смене порядка без изменения видимости', () => {
            const state = createDefaultLayerState();
            const moved = moveLayer(state, 'culture', 1);
            const plan = planLayerStateTransition(state, moved);

            expect(plan).toEqual({
                changed: true,
                updateAppearance: true,
                relayout: true,
                resetLaneAssignments: true,
                requestData: false,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 5: активирует запрос данных при одновременной смене порядка и видимости', () => {
            const state = createDefaultLayerState();
            let nextState = moveLayer(state, 'culture', 1);
            nextState = setLayerVisibility(nextState, 'culture', false);
            const plan = planLayerStateTransition(state, nextState);

            expect(plan).toEqual({
                changed: true,
                updateAppearance: true,
                relayout: true,
                resetLaneAssignments: true,
                requestData: true,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 6: активирует релейаут и запрос данных без сброса дорожек при изменении только видимости', () => {
            const state = createDefaultLayerState();
            const toggled = setLayerVisibility(state, 'culture', false);
            const plan = planLayerStateTransition(state, toggled);

            expect(plan).toEqual({
                changed: true,
                updateAppearance: true,
                relayout: true,
                resetLaneAssignments: false,
                requestData: true,
            });
            expect(Object.isFrozen(plan)).toBe(true);
        });

        it('Случай 7: возвращает все флаги true при невалидном начальном состоянии', () => {
            const state = createDefaultLayerState();

            const expected = {
                changed: true,
                updateAppearance: true,
                relayout: true,
                resetLaneAssignments: true,
                requestData: true,
            };

            expect(planLayerStateTransition(null, state)).toEqual(expected);
            expect(planLayerStateTransition(undefined, state)).toEqual(expected);
            expect(planLayerStateTransition({}, state)).toEqual(expected);
            expect(Object.isFrozen(planLayerStateTransition(null, state))).toBe(true);
        });
    });

    describe('Подсчет активных слоев countVisibleLayers', () => {
        it('возвращает полный набор для состояния по умолчанию', () => {
            const state = createDefaultLayerState();
            const result = countVisibleLayers(state);

            expect(result).toEqual({ visible: 4, total: 4 });
            expect(Object.isFrozen(result)).toBe(true);
        });

        it('корректно подсчитывает частичное число активных слоев', () => {
            let state = createDefaultLayerState();
            state = setLayerVisibility(state, 'culture', false);
            state = setLayerVisibility(state, 'politics', false);

            const result = countVisibleLayers(state);
            expect(result).toEqual({ visible: 2, total: 4 });
            expect(Object.isFrozen(result)).toBe(true);
        });

        it('возвращает 0 видимых слоев при отключении всех категорий', () => {
            let state = createDefaultLayerState();
            for (let i = 0; i < CATEGORY_IDS.length; i++) {
                state = setLayerVisibility(state, CATEGORY_IDS[i], false);
            }

            const result = countVisibleLayers(state);
            expect(result).toEqual({ visible: 0, total: 4 });
            expect(Object.isFrozen(result)).toBe(true);
        });

        it('безопасно обрабатывает невалидные состояния', () => {
            expect(countVisibleLayers(null)).toEqual({ visible: 0, total: 4 });
            expect(countVisibleLayers(undefined)).toEqual({ visible: 0, total: 4 });
            expect(countVisibleLayers({})).toEqual({ visible: 0, total: 4 });
            expect(Object.isFrozen(countVisibleLayers(null))).toBe(true);
        });
    });

    describe('Работа с локальным хранилищем Web Storage', () => {
        it('успешно сохраняет и восстанавливает валидное состояние', () => {
            const storage = createFakeStorage();
            let state = createDefaultLayerState();
            state = moveLayer(state, 'economy', -1);
            state = moveLayer(state, 'economy', -1);
            state = setLayerVisibility(state, 'culture', false);
            state = setLayerOpacity(state, 'science', 0.7);

            const saveResult = saveLayerState(state, storage);
            expect(saveResult).toBe(true);

            const loaded = loadLayerState(storage);
            expect(loaded).toEqual(state);
        });

        it('возвращает дефолтное состояние при чтении поврежденного JSON', () => {
            const storage = createFakeStorage();
            storage.setItem(LAYER_STATE_STORAGE_KEY, '{broken-json');

            const loaded = loadLayerState(storage);
            expect(loaded).toEqual(createDefaultLayerState());
        });

        it('безопасно обрабатывает исключение SecurityError при чтении', () => {
            const throwingStorage = {
                getItem: () => {
                    throw new Error('SecurityError: доступ к хранилищу заблокирован');
                },
                setItem: () => {},
            };

            const loaded = loadLayerState(throwingStorage);
            expect(loaded).toEqual(createDefaultLayerState());
        });

        it('безопасно обрабатывает исключение QuotaExceededError при записи', () => {
            const throwingStorage = {
                getItem: () => null,
                setItem: () => {
                    throw new Error('QuotaExceededError: превышен лимит памяти');
                },
            };

            const state = createDefaultLayerState();
            const result = saveLayerState(state, throwingStorage);
            expect(result).toBe(false);
        });

        it('возвращает дефолтное состояние при чтении и false при записи с null-хранилищем', () => {
            const state = createDefaultLayerState();
            expect(loadLayerState(null)).toEqual(createDefaultLayerState());
            expect(saveLayerState(state, null)).toBe(false);
        });
    });

    describe('Защита от блокировки хранилища (SecurityError)', () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

        afterEach(() => {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
            } else {
                delete globalThis.localStorage;
            }
        });

        it('безопасно обрабатывает SecurityError при вызове без второго аргумента', () => {
            Object.defineProperty(globalThis, 'localStorage', {
                get() {
                    const err = new Error('SecurityError: Access denied');
                    err.name = 'SecurityError';
                    throw err;
                },
                configurable: true,
            });

            const state = createDefaultLayerState();

            // Вызов loadLayerState без аргументов не должен выбрасывать исключение
            expect(() => loadLayerState()).not.toThrow();
            expect(loadLayerState()).toEqual(createDefaultLayerState());

            // Вызов saveLayerState без второго аргумента не должен выбрасывать исключение
            expect(() => saveLayerState(state)).not.toThrow();
            expect(saveLayerState(state)).toBe(false);
        });
    });
});
