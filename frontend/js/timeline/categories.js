/**
 * Модуль единого клиентского реестра категорий исторических событий.
 * Содержит нормализованные идентификаторы, русскоязычные подписи,
 * привязки к CSS-переменным палитры темы и калиброванные безопасные цвета (HEX).
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Чистая декларативная модель: модуль изолирован от DOM-дерева и Canvas API.
 * 2. Синхронизация с сервером: состав и порядок категорий строго повторяют
 *    доменное перечисление EventCategory (культура, политика, экономика, наука).
 * 3. Доступность цветовой палитры: цвета подобраны с учетом физиологической
 *    различимости при цветовой слепоте (Machado 2009) и контрастности WCAG.
 * 4. Немутабельность: все структуры данных глубоко заморожены (Object.freeze).
 */

/**
 * Запасная категория для событий с неизвестным или пользовательским типом.
 * @type {Readonly<{ id: string, label: string, themeVariable: string, fallbackColor: string }>}
 */
export const FALLBACK_CATEGORY = Object.freeze({
    id: 'other',
    label: 'Прочее',
    themeVariable: '--color-category-other',
    fallbackColor: '#b0b0b8',
});

/**
 * Единый реестр регламентированных категорий исторических событий платформы.
 * Порядок элементов строго соответствует серверному перечислению EventCategory.
 * @type {ReadonlyArray<Readonly<{ id: string, label: string, themeVariable: string, fallbackColor: string }>>}
 */
export const CATEGORY_REGISTRY = Object.freeze([
    Object.freeze({
        id: 'culture',
        label: 'Культура',
        themeVariable: '--color-category-culture',
        fallbackColor: '#854ece',
    }),
    Object.freeze({
        id: 'politics',
        label: 'Политика',
        themeVariable: '--color-category-politics',
        fallbackColor: '#c83841',
    }),
    Object.freeze({
        id: 'economy',
        label: 'Экономика',
        themeVariable: '--color-category-economy',
        fallbackColor: '#c08933',
    }),
    Object.freeze({
        id: 'science',
        label: 'Наука',
        themeVariable: '--color-category-science',
        fallbackColor: '#1794a0',
    }),
]);

/**
 * Список валидных идентификаторов категорий в порядке их объявления.
 * @type {ReadonlyArray<string>}
 */
export const CATEGORY_IDS = Object.freeze(CATEGORY_REGISTRY.map((cat) => cat.id));

/**
 * Внутренняя поисковая карта для быстрого сопоставления по нормализованному идентификатору.
 * @type {ReadonlyMap<string, Readonly<{ id: string, label: string, themeVariable: string, fallbackColor: string }>>}
 */
const CATEGORY_MAP = new Map(CATEGORY_REGISTRY.map((cat) => [cat.id, cat]));

/**
 * Нормализует входящее значение идентификатора категории.
 * Выполняет отсечение пробельных символов и приведение к нижнему регистру.
 *
 * @param {unknown} value Произвольное значение для валидации.
 * @returns {string|null} Нормализованный строковый идентификатор категории или null при невалидных данных.
 */
export function normalizeCategoryId(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim().toLowerCase();
    return CATEGORY_MAP.has(trimmed) ? trimmed : null;
}

/**
 * Возвращает полный дескриптор категории по переданному идентификатору.
 * При отсутствии совпадения или невалидных данных возвращает FALLBACK_CATEGORY.
 *
 * @param {unknown} value Идентификатор категории или произвольное значение.
 * @returns {Readonly<{ id: string, label: string, themeVariable: string, fallbackColor: string }>}
 */
export function getCategoryDescriptor(value) {
    const normalizedId = normalizeCategoryId(value);
    if (normalizedId !== null) {
        return CATEGORY_MAP.get(normalizedId);
    }
    return FALLBACK_CATEGORY;
}

/**
 * Возвращает читаемую русскоязычную подпись категории для отображения в интерфейсе.
 *
 * @param {unknown} value Идентификатор категории или произвольное значение.
 * @returns {string} Локализованное название категории.
 */
export function getCategoryLabel(value) {
    return getCategoryDescriptor(value).label;
}
