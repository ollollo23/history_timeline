/**
 * Модуль сопоставления масштаба временной сетки и рангов детализации событий.
 * Предоставляет чистые функции проецирования активной календарной единицы
 * в упорядоченный набор запрашиваемых уровней детализации (EventRank) и сравнения наборов.
 *
 * АРХИТЕКТУРНОЕ СОГЛАШЕНИЕ:
 * Первоисточником иерархии рангов является серверное перечисление EventRank
 * и метод depth_level модуля app/core/enums.py[cite: 1, 12].
 * Порядок следования строго от крупного к мелкому:
 * century (0), decade (1), year (2), month (3), day (4), hour (5), minute (6), second (7)[cite: 1, 12].
 */

/**
 * Замороженный упорядоченный список идентификаторов рангов детализации событий.
 * Строго зеркалирует перечисление EventRank сервера в порядке увеличения глубины детализации[cite: 12].
 * @type {ReadonlyArray<string>}
 */
export const EVENT_RANKS_ORDERED = Object.freeze([
    'century',
    'decade',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
]);

/**
 * Таблица нормализованного отображения поддерживаемых календарных единиц сетки в ранг события.
 * @type {Readonly<Record<string, string>>}
 */
const UNIT_TO_RANK_MAP = Object.freeze({
    second: 'second',
    minute: 'minute',
    hour: 'hour',
    day: 'day',
    month: 'month',
    year: 'year',
    decade: 'decade',
    century: 'century',
    millennium: 'century', // В доменной модели максимальным рангом является century[cite: 12]
});

/**
 * Отображает календарную единицу деления сетки таймлайна в соответствующий ранг события[cite: 12].
 *
 * @param {string|unknown} unit Календарная единица сетки (например, 'year', 'century').
 * @returns {string|null} Идентификатор целевого ранга события или null при неизвестном значении[cite: 12].
 */
export function unitToRank(unit) {
    if (typeof unit !== 'string' || !unit) {
        return null;
    }

    const normalizedUnit = unit.trim().toLowerCase();
    return UNIT_TO_RANK_MAP[normalizedUnit] || null;
}

/**
 * Формирует срез набора запрашиваемых рангов под текущий масштаб отображения таймлайна[cite: 12].
 * На крупных масштабах возвращает только макроранги, исключая избыточный шум и нагрузку[cite: 12].
 * При неизвестной единице возвращает полный набор рангов во избежание скрытой потери данных[cite: 12].
 *
 * @param {string|unknown} unit Календарная единица текущего активного уровня сетки.
 * @returns {string[]} Список запрашиваемых рангов от century до ранга текущей единицы включительно[cite: 12].
 */
export function getRanksForUnit(unit) {
    const targetRank = unitToRank(unit);

    // При невалидной или неизвестной единице возвращаем защитную копию всех рангов
    if (targetRank === null) {
        return [...EVENT_RANKS_ORDERED];
    }

    const index = EVENT_RANKS_ORDERED.indexOf(targetRank);
    if (index === -1) {
        return [...EVENT_RANKS_ORDERED];
    }

    // Возврат среза от нулевого индекса (century) до индекса целевого ранга включительно
    return EVENT_RANKS_ORDERED.slice(0, index + 1);
}

/**
 * Проверяет математическую эквивалентность двух наборов рангов независимо от порядка следования и дубликатов[cite: 12].
 * Используется хранилищем событий для детекции изменения формы запроса и инвалидации кэша[cite: 12].
 *
 * @param {string[]|null|undefined} ranksA Первый набор рангов.
 * @param {string[]|null|undefined} ranksB Второй набор рангов.
 * @returns {boolean} True, если наборы содержат идентичные уникальные элементы[cite: 12].
 */
export function areRankSetsEqual(ranksA, ranksB) {
    // 1. Проверка отсутствующих (nullish) значений
    const isANullish = ranksA === null || ranksA === undefined;
    const isBNullish = ranksB === null || ranksB === undefined;

    // Оба аргумента отсутствуют (null или undefined) — наборы эквивалентны
    if (isANullish && isBNullish) {
        return true;
    }

    // Только один аргумент отсутствует — наборы заведомо не равны
    if (isANullish || isBNullish) {
        return false;
    }

    // 2. Строгая проверка типов: оба аргумента обязаны быть массивами
    if (!Array.isArray(ranksA) || !Array.isArray(ranksB)) {
        return false;
    }

    // 3. Проверка идентичности ссылок для подтвержденных массивов
    if (ranksA === ranksB) {
        return true;
    }

    // 4. Сравнение уникальных множеств элементов по мощности и составу
    const setA = new Set(ranksA);
    const setB = new Set(ranksB);

    if (setA.size !== setB.size) {
        return false;
    }

    for (const item of setA) {
        if (!setB.has(item)) {
            return false;
        }
    }

    return true;
}
