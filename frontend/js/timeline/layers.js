/**
 * Модуль математической модели слоев категорий временной шкалы.
 * Управляет состоянием порядка отображения, видимостью, прозрачностью слоев,
 * клиентской фильтрацией событий, генерацией конфигураций рендеринга,
 * планированием фаз переходов состояния и безопасной персистентностью в Web Storage.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистая функциональная модель: модуль не зависит от DOM-дерева и Canvas API.
 * 2. Иммутабельность: все структуры данных глубоко замораживаются через Object.freeze;
 *    любые операции модификации возвращают новые объекты без изменения исходных.
 * 3. Отказоустойчивость: нормализатор устойчив к поврежденным структурам в хранилище,
 *    дополняет недостающие категории и отсекает некорректные идентификаторы.
 * 4. Безопасность окружения: чтение глобального localStorage изолировано от сигнатур
 *    функций, исключая возникновение исключения SecurityError в приватном режиме браузера.
 * 5. Дискретизация прозрачности: функция snapLayerOpacity использует шаг LAYER_OPACITY_STEP
 *    в качестве масштабирующего квантователя, исключая накопление дробных погрешностей.
 * 6. Планирование переходов: функция planLayerStateTransition определяет минимально
 *    необходимый набор реакций интерфейса (перерисовка, релейаут, сброс дорожек, запрос данных).
 */

import {
    LAYER_OPACITY_MIN,
    LAYER_OPACITY_MAX,
    LAYER_OPACITY_STEP,
    LAYER_STATE_STORAGE_KEY,
    LAYER_STATE_VERSION,
} from './constants.js';
import {
    CATEGORY_REGISTRY,
    CATEGORY_IDS,
    FALLBACK_CATEGORY,
    normalizeCategoryId,
} from './categories.js';

/**
 * Внутренняя поисковая карта CSS-переменных тем категорий.
 * @type {ReadonlyMap<string, string>}
 */
const THEME_VARIABLE_BY_ID = new Map(
    CATEGORY_REGISTRY.map((descriptor) => [descriptor.id, descriptor.themeVariable])
);

/**
 * Безопасное отложенное разрешение стандартного Web Storage браузера.
 * Обращение к globalThis.localStorage защищено блоком try...catch, так как в приватном
 * режиме браузера или при блокировке сторонних cookie чтение свойства вызывает SecurityError.
 *
 * @returns {Storage|null} Экземпляр localStorage либо null при недоступности или сбое.
 */
function resolveDefaultStorage() {
    try {
        if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
            return globalThis.localStorage;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Ограничивает и дискретизирует числовой коэффициент прозрачности с шагом LAYER_OPACITY_STEP.
 * Исключает дробный шум вычислений с плавающей точкой стандарта IEEE 754.
 *
 * @param {unknown} value Входное значение коэффициента непрозрачности.
 * @returns {number} Нормализованное вещественное число в пределах [LAYER_OPACITY_MIN, LAYER_OPACITY_MAX].
 */
export function snapLayerOpacity(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 1.0;
    }

    const clamped = Math.max(LAYER_OPACITY_MIN, Math.min(LAYER_OPACITY_MAX, value));
    const stepsPerUnit = Math.round(1 / LAYER_OPACITY_STEP);
    const rounded = Math.round(clamped * stepsPerUnit) / stepsPerUnit;

    return Math.max(LAYER_OPACITY_MIN, Math.min(LAYER_OPACITY_MAX, rounded));
}

/**
 * Создает новое неизменяемое состояние слоев по умолчанию.
 *
 * @returns {Readonly<{
 *   version: number,
 *   order: ReadonlyArray<string>,
 *   visible: Readonly<Record<string, boolean>>,
 *   opacity: Readonly<Record<string, number>>
 * }>} Глубоко замороженный объект состояния слоев.
 */
export function createDefaultLayerState() {
    const order = [...CATEGORY_IDS];
    const visible = {};
    const opacity = {};

    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        visible[id] = true;
        opacity[id] = 1.0;
    }

    return Object.freeze({
        version: LAYER_STATE_VERSION,
        order: Object.freeze(order),
        visible: Object.freeze(visible),
        opacity: Object.freeze(opacity),
    });
}

/**
 * Выполняет строгую нормализацию и валидацию структуры состояния слоев.
 * Восстанавливает отсутствующие поля и очищает структуру от некорректных данных.
 *
 * @param {unknown} raw Необработанные данные состояния (например, распарсенный JSON).
 * @returns {Readonly<{
 *   version: number,
 *   order: ReadonlyArray<string>,
 *   visible: Readonly<Record<string, boolean>>,
 *   opacity: Readonly<Record<string, number>>
 * }>} Валидное глубоко замороженное состояние слоев.
 */
export function normalizeLayerState(raw) {
    if (!raw || typeof raw !== 'object' || raw.version !== LAYER_STATE_VERSION) {
        return createDefaultLayerState();
    }

    // 1. Нормализация порядка слоев: дедупликация и дополнение недостающими категориями
    const order = [];
    const seen = new Set();

    if (Array.isArray(raw.order)) {
        for (let i = 0; i < raw.order.length; i++) {
            const normId = normalizeCategoryId(raw.order[i]);
            if (normId !== null && !seen.has(normId)) {
                seen.add(normId);
                order.push(normId);
            }
        }
    }

    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const catId = CATEGORY_IDS[i];
        if (!seen.has(catId)) {
            seen.add(catId);
            order.push(catId);
        }
    }

    // 2. Нормализация флагов видимости
    const visible = {};
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const catId = CATEGORY_IDS[i];
        const val = raw.visible ? raw.visible[catId] : undefined;
        visible[catId] = typeof val === 'boolean' ? val : true;
    }

    // 3. Нормализация коэффициентов прозрачности через централизованный snapLayerOpacity
    const opacity = {};
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const catId = CATEGORY_IDS[i];
        const val = raw.opacity ? raw.opacity[catId] : undefined;
        opacity[catId] = snapLayerOpacity(val);
    }

    return Object.freeze({
        version: LAYER_STATE_VERSION,
        order: Object.freeze(order),
        visible: Object.freeze(visible),
        opacity: Object.freeze(opacity),
    });
}

/**
 * Перемещает слой в массиве порядка на заданное смещение delta (-1 — выше, +1 — ниже).
 *
 * @param {Object} state Текущее валидное состояние слоев.
 * @param {string} id Идентификатор перемещаемой категории.
 * @param {number} delta Шаг смещения позиции в массиве (-1 или +1).
 * @returns {Object} Новое замороженное состояние или прежнее при невозможности перемещения.
 */
export function moveLayer(state, id, delta) {
    const normId = normalizeCategoryId(id);
    if (normId === null || !state || !Array.isArray(state.order)) {
        return state;
    }

    const currentIndex = state.order.indexOf(normId);
    if (currentIndex === -1) {
        return state;
    }

    const targetIndex = currentIndex + delta;
    if (targetIndex < 0 || targetIndex >= state.order.length) {
        return state;
    }

    const nextOrder = [...state.order];
    const temp = nextOrder[currentIndex];
    nextOrder[currentIndex] = nextOrder[targetIndex];
    nextOrder[targetIndex] = temp;

    return Object.freeze({
        version: state.version,
        order: Object.freeze(nextOrder),
        visible: state.visible,
        opacity: state.opacity,
    });
}

/**
 * Устанавливает статус видимости для указанного слоя.
 *
 * @param {Object} state Текущее состояние слоев.
 * @param {string} id Идентификатор категории.
 * @param {boolean} isVisible Флаг видимости.
 * @returns {Object} Новое замороженное состояние.
 */
export function setLayerVisibility(state, id, isVisible) {
    const normId = normalizeCategoryId(id);
    if (normId === null || !state || !state.visible) {
        return state;
    }

    const nextBool = Boolean(isVisible);
    if (state.visible[normId] === nextBool) {
        return state;
    }

    const nextVisible = { ...state.visible, [normId]: nextBool };

    return Object.freeze({
        version: state.version,
        order: state.order,
        visible: Object.freeze(nextVisible),
        opacity: state.opacity,
    });
}

/**
 * Инвертирует текущий статус видимости для указанного слоя.
 *
 * @param {Object} state Текущее состояние слоев.
 * @param {string} id Идентификатор категории.
 * @returns {Object} Новое замороженное состояние.
 */
export function toggleLayerVisibility(state, id) {
    const normId = normalizeCategoryId(id);
    if (normId === null || !state || !state.visible) {
        return state;
    }
    return setLayerVisibility(state, normId, !state.visible[normId]);
}

/**
 * Оставляет видимым только один указанный слой, скрывая все остальные.
 *
 * @param {Object} state Текущее состояние слоев.
 * @param {string} id Идентификатор сохраняемой категории.
 * @returns {Object} Новое замороженное состояние.
 */
export function showOnlyLayer(state, id) {
    const normId = normalizeCategoryId(id);
    if (normId === null || !state) {
        return state;
    }

    const nextVisible = {};
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const catId = CATEGORY_IDS[i];
        nextVisible[catId] = catId === normId;
    }

    return Object.freeze({
        version: state.version,
        order: state.order,
        visible: Object.freeze(nextVisible),
        opacity: state.opacity,
    });
}

/**
 * Включает видимость для всех регламентированных слоев категорий.
 *
 * @param {Object} state Текущее состояние слоев.
 * @returns {Object} Новое замороженное состояние со всеми включенными слоями.
 */
export function showAllLayers(state) {
    if (!state) {
        return createDefaultLayerState();
    }

    const nextVisible = {};
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        nextVisible[CATEGORY_IDS[i]] = true;
    }

    return Object.freeze({
        version: state.version,
        order: state.order,
        visible: Object.freeze(nextVisible),
        opacity: state.opacity,
    });
}

/**
 * Устанавливает уровень непрозрачности для указанного слоя с дискретизацией.
 *
 * @param {Object} state Текущее состояние слоев.
 * @param {string} id Идентификатор категории.
 * @param {number} opacity Числовой коэффициент непрозрачности.
 * @returns {Object} Новое замороженное состояние.
 */
export function setLayerOpacity(state, id, opacity) {
    const normId = normalizeCategoryId(id);
    if (normId === null || !state || !state.opacity) {
        return state;
    }

    const safeOpacity = snapLayerOpacity(opacity);

    if (state.opacity[normId] === safeOpacity) {
        return state;
    }

    const nextOpacity = { ...state.opacity, [normId]: safeOpacity };

    return Object.freeze({
        version: state.version,
        order: state.order,
        visible: state.visible,
        opacity: Object.freeze(nextOpacity),
    });
}

/**
 * Проверяет, активен ли в данный момент фильтр скрытия хотя бы одного слоя.
 *
 * @param {Object} state Текущее состояние слоев.
 * @returns {boolean} True, если хотя бы одна категория скрыта.
 */
export function isCategoryFilterActive(state) {
    if (!state || !state.visible) {
        return false;
    }

    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        if (state.visible[CATEGORY_IDS[i]] === false) {
            return true;
        }
    }

    return false;
}

/**
 * Формирует параметры сетевого запроса к эндпоинту диапазона с учетом видимости слоев.
 *
 * @param {Object} state Текущее состояние слоев.
 * @returns {{ shouldRequest: boolean, categories: string[] }} Решение о запросе и фильтр.
 */
export function getCategoryRequest(state) {
    if (!isCategoryFilterActive(state)) {
        // Если все слои видимы — запрос разрешен без параметров фильтра
        return { shouldRequest: true, categories: [] };
    }

    const visibleIds = [];
    for (let i = 0; i < state.order.length; i++) {
        const id = state.order[i];
        if (state.visible[id] === true) {
            visibleIds.push(id);
        }
    }

    if (visibleIds.length === 0) {
        // Если все слои скрыты — запрос к серверу не выполняется
        return { shouldRequest: false, categories: [] };
    }

    return { shouldRequest: true, categories: visibleIds };
}

/**
 * Выполняет клиентскую фильтрацию массива событий согласно настройкам видимости слоев.
 * События с неизвестной категорией пропускаются только при отсутствии активного фильтра.
 *
 * @param {Array<Object>} events Исходный массив доменных сущностей событий.
 * @param {Object} state Текущее состояние слоев.
 * @returns {Array<Object>} Отфильтрованный массив событий.
 */
export function filterEventsByLayers(events, state) {
    if (!Array.isArray(events) || !state || !state.visible) {
        return [];
    }

    const filterActive = isCategoryFilterActive(state);

    return events.filter((event) => {
        if (!event) {
            return false;
        }

        const normId = normalizeCategoryId(event.category);
        if (normId !== null) {
            return state.visible[normId] === true;
        }

        // События с неизвестной категорией видны только если фильтр полностью выключен
        return !filterActive;
    });
}

/**
 * Формирует карту приоритетов слоев для передачи в алгоритм компоновки дорожек.
 * 0 соответствует верхнему слою с наивысшим приоритетом.
 *
 * @param {Object} state Текущее состояние слоев.
 * @returns {Map<string, number>} Карта сопоставления ID категории с ее весом.
 */
export function buildLayerPriority(state) {
    const priority = new Map();
    if (!state || !Array.isArray(state.order)) {
        return priority;
    }

    for (let i = 0; i < state.order.length; i++) {
        priority.set(state.order[i], i);
    }

    return priority;
}

/**
 * Строит конфигурацию рендерера для послойной отрисовки с учетом прозрачности.
 * Порядок отрисовки разворачивается снизу вверх (верхний слой рисуется последним).
 *
 * @param {Object} state Текущее состояние слоев.
 * @returns {Readonly<{
 *   drawOrder: ReadonlyArray<string>,
 *   alphaByThemeVariable: Readonly<Record<string, number>>
 * }>} Замороженная конфигурация рендерера.
 */
export function buildLayerRenderConfig(state) {
    if (!state || !Array.isArray(state.order)) {
        return Object.freeze({
            drawOrder: Object.freeze([FALLBACK_CATEGORY.themeVariable]),
            alphaByThemeVariable: Object.freeze({
                [FALLBACK_CATEGORY.themeVariable]: 1.0,
            }),
        });
    }

    // 1. Порядок отрисовки: разворот сверху вниз -> снизу вверх, запасная категория первой
    const reversedOrder = [...state.order].reverse();
    const drawOrder = [
        FALLBACK_CATEGORY.themeVariable,
        ...reversedOrder.map((id) => THEME_VARIABLE_BY_ID.get(id) || `--color-category-${id}`),
    ];

    // 2. Расчет эффективной прозрачности для каждой переменной темы
    const alphaByThemeVariable = {};
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        const themeVar = THEME_VARIABLE_BY_ID.get(id) || `--color-category-${id}`;
        const isVisible = state.visible?.[id] === true;
        const opacityVal = state.opacity?.[id] ?? 1.0;

        alphaByThemeVariable[themeVar] = isVisible ? opacityVal : 0;
    }

    // Запасная категория скрывается при активности фильтра слоев
    const fallbackAlpha = isCategoryFilterActive(state) ? 0 : 1.0;
    alphaByThemeVariable[FALLBACK_CATEGORY.themeVariable] = fallbackAlpha;

    return Object.freeze({
        drawOrder: Object.freeze(drawOrder),
        alphaByThemeVariable: Object.freeze(alphaByThemeVariable),
    });
}

/**
 * Проверяет, идентична ли структура слоев (порядок и видимость) у двух состояний.
 * Используется для предотвращения лишних вычислений компоновки при изменении только прозрачности.
 *
 * @param {Object|null|undefined} a Первое состояние.
 * @param {Object|null|undefined} b Второе состояние.
 * @returns {boolean} True, если порядок и видимость слоев полностью совпадают.
 */
export function haveSameLayerStructure(a, b) {
    if (!a || !b) {
        return false;
    }
    if (a === b) {
        return true;
    }

    if (!Array.isArray(a.order) || !Array.isArray(b.order) || a.order.length !== b.order.length) {
        return false;
    }

    for (let i = 0; i < a.order.length; i++) {
        if (a.order[i] !== b.order[i]) {
            return false;
        }
    }

    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        if (Boolean(a.visible?.[id]) !== Boolean(b.visible?.[id])) {
            return false;
        }
    }

    return true;
}

/**
 * Определяет, изменился ли порядок следования слоев в массиве order между двумя состояниями.
 *
 * @param {unknown} prev Предыдущее состояние.
 * @param {unknown} next Новое состояние.
 * @returns {boolean} True, если порядок категорий изменился либо данные невалидны.
 */
export function hasLayerOrderChanged(prev, next) {
    if (
        !prev ||
        typeof prev !== 'object' ||
        !Array.isArray(prev.order) ||
        !next ||
        typeof next !== 'object' ||
        !Array.isArray(next.order)
    ) {
        return true;
    }

    if (prev.order.length !== next.order.length) {
        return true;
    }

    for (let i = 0; i < prev.order.length; i++) {
        if (prev.order[i] !== next.order[i]) {
            return true;
        }
    }

    return false;
}

/**
 * Составляет декларативный план обновления подсистем интерфейса при переходе между состояниями слоев.
 * Разделяет легкие операции обновления альфа-канала рендерера от тяжелых операций пересчета
 * дорожек, сброса закрепления дорожек и выполнения сетевых запросов.
 *
 * @param {Object|null|undefined} prev Предыдущее состояние слоев.
 * @param {Object|null|undefined} next Целевое состояние слоев.
 * @returns {Readonly<{
 *   changed: boolean,
 *   updateAppearance: boolean,
 *   relayout: boolean,
 *   resetLaneAssignments: boolean,
 *   requestData: boolean
 * }>} Замороженный план необходимых реакций интерфейса.
 */
export function planLayerStateTransition(prev, next) {
    // Правило 1: при невалидном начальном состоянии выполняются все операции
    if (
        !prev ||
        typeof prev !== 'object' ||
        !Array.isArray(prev.order) ||
        !prev.visible ||
        typeof prev.visible !== 'object' ||
        !prev.opacity ||
        typeof prev.opacity !== 'object'
    ) {
        return Object.freeze({
            changed: true,
            updateAppearance: true,
            relayout: true,
            resetLaneAssignments: true,
            requestData: true,
        });
    }

    // Правило 2: ссылочное равенство не требует никаких действий
    if (prev === next) {
        return Object.freeze({
            changed: false,
            updateAppearance: false,
            relayout: false,
            resetLaneAssignments: false,
            requestData: false,
        });
    }

    const orderChanged = hasLayerOrderChanged(prev, next);

    let visibilityChanged = false;
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        if (Boolean(prev.visible?.[id]) !== Boolean(next.visible?.[id])) {
            visibilityChanged = true;
            break;
        }
    }

    let opacityChanged = false;
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        if (prev.opacity?.[id] !== next.opacity?.[id]) {
            opacityChanged = true;
            break;
        }
    }

    // Правило 3: фактические значения полностью идентичны
    if (!orderChanged && !visibilityChanged && !opacityChanged) {
        return Object.freeze({
            changed: false,
            updateAppearance: false,
            relayout: false,
            resetLaneAssignments: false,
            requestData: false,
        });
    }

    // Правило 4: изменилась только непрозрачность (пересчет компоновки и сеть не требуются)
    if (!orderChanged && !visibilityChanged && opacityChanged) {
        return Object.freeze({
            changed: true,
            updateAppearance: true,
            relayout: false,
            resetLaneAssignments: false,
            requestData: false,
        });
    }

    // Правило 5: изменился порядок слоев (требуется релейаут и сброс закрепления дорожек)
    if (orderChanged) {
        return Object.freeze({
            changed: true,
            updateAppearance: true,
            relayout: true,
            resetLaneAssignments: true,
            requestData: visibilityChanged,
        });
    }

    // Правило 6: изменилась только видимость (требуется релейаут и сетевой запрос, но дорожки сохраняются)
    return Object.freeze({
        changed: true,
        updateAppearance: true,
        relayout: true,
        resetLaneAssignments: false,
        requestData: true,
    });
}

/**
 * Подсчитывает число активных (видимых) слоев и общее число регламентированных категорий.
 *
 * @param {Object|null|undefined} state Состояние слоев.
 * @returns {Readonly<{ visible: number, total: number }>} Замороженный объект счетчиков.
 */
export function countVisibleLayers(state) {
    const total = CATEGORY_IDS.length;
    if (!state || typeof state !== 'object' || !state.visible || typeof state.visible !== 'object') {
        return Object.freeze({ visible: 0, total });
    }

    let count = 0;
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
        const id = CATEGORY_IDS[i];
        if (state.visible[id] === true) {
            count++;
        }
    }

    return Object.freeze({ visible: count, total });
}

/**
 * Безопасно загружает и нормализует состояние слоев из Web Storage.
 * Разрешение объекта хранилища изолировано внутри защищенного блока try...catch:
 * прямое обращение к свойству localStorage на глобальном объекте в заголовке параметров
 * генерирует исключение SecurityError при запрете хранения данных сайта в браузере.
 *
 * @param {Storage|unknown} storage Экземпляр хранилища (если передан undefined, вызывается resolveDefaultStorage).
 * @returns {Object} Валидное глубоко замороженное состояние слоев.
 */
export function loadLayerState(storage) {
    try {
        const effectiveStorage = storage === undefined ? resolveDefaultStorage() : storage;

        if (
            !effectiveStorage ||
            typeof effectiveStorage !== 'object' ||
            typeof effectiveStorage.getItem !== 'function'
        ) {
            return createDefaultLayerState();
        }

        const rawString = effectiveStorage.getItem(LAYER_STATE_STORAGE_KEY);
        if (!rawString) {
            return createDefaultLayerState();
        }

        const parsed = JSON.parse(rawString);
        return normalizeLayerState(parsed);
    } catch {
        return createDefaultLayerState();
    }
}

/**
 * Безопасно сохраняет состояние слоев в Web Storage.
 * Разрешение объекта хранилища изолировано внутри защищенного блока try...catch:
 * прямое обращение к свойству localStorage на глобальном объекте в заголовке параметров
 * генерирует исключение SecurityError при запрете хранения данных сайта в браузере.
 *
 * @param {Object} state Сохраняемое состояние слоев.
 * @param {Storage|unknown} storage Экземпляр хранилища (если передан undefined, вызывается resolveDefaultStorage).
 * @returns {boolean} True, если запись завершилась успешно.
 */
export function saveLayerState(state, storage) {
    try {
        if (!state || typeof state !== 'object') {
            return false;
        }

        const effectiveStorage = storage === undefined ? resolveDefaultStorage() : storage;

        if (
            !effectiveStorage ||
            typeof effectiveStorage !== 'object' ||
            typeof effectiveStorage.setItem !== 'function'
        ) {
            return false;
        }

        effectiveStorage.setItem(LAYER_STATE_STORAGE_KEY, JSON.stringify(state));
        return true;
    } catch {
        return false;
    }
}
