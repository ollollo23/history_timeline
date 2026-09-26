/**
 * Модуль расчета и валидации границ упреждающего окна сетевой загрузки данных.
 * Определяет чистую политику формирования запросов к API, устраняет риски
 * передачи дробных меток в целочисленные параметры сервера и управляет кэшированием.
 *
 * АРХИТЕКТУРНЫЕ СОГЛАШЕНИЯ:
 * 1. Модуль является чистой математической функцией без состояния, сетевого ввода-вывода
 *    и обращений к DOM-дереву.
 * 2. Коэффициент упреждения DEFAULT_PREFETCH_MULTIPLIER расширяет запрашиваемый интервал
 *    в 3 раза относительно видимой ширины экрана, устраняя сетевые запросы при мелком панорамировании.
 * 3. Округление границ: from_date округляется строго вниз (Math.floor), а to_date — строго
 *    вверх (Math.ceil). Это защищает эндпоинт FastAPI от ошибки валидации HTTP 422 при передаче
 *    вещественного originTimestamp и гарантирует покрытие экранного интервала без сужения.
 * 4. Запрашиваемые границы строго ограничиваются хронологическими пределами платформы
 *    TIMELINE_MIN_TIMESTAMP и TIMELINE_MAX_TIMESTAMP.
 * 5. Политика усеченного окна: при зафиксированном усечении выборки сервером (isTruncated)
 *    окно сохраняется целиком, а повторный запрос данных инициируется при приближении масштаба
 *    на величину TRUNCATED_REFETCH_ZOOM_INDEX_DELTA и более.
 */

import {
    TIMELINE_MAX_TIMESTAMP,
    TIMELINE_MIN_TIMESTAMP,
    TRUNCATED_REFETCH_ZOOM_INDEX_DELTA,
} from './constants.js';
import {
    calculateVisibleDuration,
    zoomIndexToSecondsPerPixel,
} from './scale.js';

/**
 * Коэффициент кратности упреждающего окна загрузки по умолчанию.
 * Загружает диапазон втрое шире текущей видимой области для буферизации панорамирования.
 */
export const DEFAULT_PREFETCH_MULTIPLIER = 3;

/**
 * Вычисляет целочисленные границы упреждающего окна загрузки данных из состояния виртуальной камеры.
 * Центрирует интервал на видимой области и гарантирует целочисленный формат для API.
 *
 * @param {{ originTimestamp: number, zoomIndex: number, widthPx: number }} viewportState Текущее состояние камеры.
 * @param {number} [multiplier=DEFAULT_PREFETCH_MULTIPLIER] Множитель ширины окна упреждения.
 * @returns {Readonly<{ from_date: number, to_date: number }>} Замороженный объект целочисленных границ окна.
 */
export function calculateRequiredLoadWindow(
    viewportState,
    multiplier = DEFAULT_PREFETCH_MULTIPLIER
) {
    const spp = zoomIndexToSecondsPerPixel(viewportState.zoomIndex);
    const visibleDuration = calculateVisibleDuration(viewportState.widthPx, spp);

    // Защита множителя от некорректных значений меньше единицы
    const safeMultiplier = Math.max(1, multiplier);
    const loadDuration = visibleDuration * safeMultiplier;

    // Центрирование запрашиваемого интервала относительно текущего центра экрана
    const visibleCenter = viewportState.originTimestamp + visibleDuration / 2;
    const rawFrom = visibleCenter - loadDuration / 2;
    const rawTo = visibleCenter + loadDuration / 2;

    // Ограничение диапазона физическими границами платформы (эпоха плейстоцена / 3000 год)
    const clampedFrom = Math.max(
        TIMELINE_MIN_TIMESTAMP,
        Math.min(TIMELINE_MAX_TIMESTAMP, rawFrom)
    );
    const clampedTo = Math.max(
        TIMELINE_MIN_TIMESTAMP,
        Math.min(TIMELINE_MAX_TIMESTAMP, rawTo)
    );

    // Округление до целых секунд: from_date вниз, to_date вверх для надежного накрытия
    const from_date = Math.floor(clampedFrom);
    const to_date = Math.ceil(clampedTo);

    return Object.freeze({
        from_date,
        to_date,
    });
}

/**
 * Проверяет, покрывается ли требуемый временной интервал уже загруженным окном данных.
 *
 * @param {{ from_date: number, to_date: number }|null|undefined} requiredWindow Требуемый интервал.
 * @param {{ from_date: number, to_date: number }|null|undefined} loadedWindow Ранее загруженный интервал.
 * @returns {boolean} True, если загруженное окно полностью включает в себя требуемое.
 */
export function isWindowCovered(requiredWindow, loadedWindow) {
    if (
        !requiredWindow ||
        !loadedWindow ||
        typeof requiredWindow.from_date !== 'number' ||
        typeof requiredWindow.to_date !== 'number' ||
        typeof loadedWindow.from_date !== 'number' ||
        typeof loadedWindow.to_date !== 'number'
    ) {
        return false;
    }

    // Требуемое окно покрыто, если его границы строго лежат внутри загруженного
    return (
        loadedWindow.from_date <= requiredWindow.from_date &&
        loadedWindow.to_date >= requiredWindow.to_date
    );
}

/**
 * Генерирует детерминированный строковый ключ формы запроса из наборов рангов и категорий.
 * Используется для моментальной инвалидации кэшированного окна при изменении параметров фильтрации.
 *
 * @param {string[]|null|undefined} ranks Список запрошенных рангов детализации.
 * @param {string[]|null|undefined} categories Список запрошенных категорий событий.
 * @returns {string} Канонический сериализованный ключ формы запроса вида "ranks:...|categories:...".
 */
export function buildRequestShapeKey(ranks, categories) {
    let ranksKey = '*';
    if (Array.isArray(ranks)) {
        const uniqueRanks = [
            ...new Set(ranks.filter((r) => typeof r === 'string' && r.trim().length > 0)),
        ].sort();
        // При пустом массиве или отсутствии валидных строк подставляется '*' (все ранги)
        ranksKey = uniqueRanks.length > 0 ? uniqueRanks.join(',') : '*';
    }

    let categoriesKey = '*';
    if (Array.isArray(categories)) {
        const uniqueCategories = [
            ...new Set(
                categories
                    .filter((c) => typeof c === 'string')
                    .map((c) => c.trim().toLowerCase())
                    .filter((c) => c.length > 0)
            ),
        ].sort();
        // При пустом массиве или отсутствии валидных категорий подставляется '*' (все категории)
        categoriesKey = uniqueCategories.length > 0 ? uniqueCategories.join(',') : '*';
    }

    return Object.freeze(`ranks:${ranksKey}|categories:${categoriesKey}`);
}

/**
 * Комплексный предикат принятия решения о необходимости отправки сетевого HTTP-запроса.
 *
 * @param {{ from_date: number, to_date: number }} requiredWindow Требуемый диапазон экрана.
 * @param {{ from_date: number, to_date: number }|null} loadedWindow Текущий загруженный диапазон.
 * @param {string} currentShapeKey Ключ формы текущего запроса (фильтры рангов и категорий).
 * @param {string|null} loadedShapeKey Ключ формы ранее загруженного запроса.
 * @param {{ isTruncated?: boolean, currentZoomIndex?: number, loadedZoomIndex?: number } | null} [truncationContext=null]
 *        Контекст усечения выборки и масштабов виртуальной камеры.
 * @returns {boolean} True, если требуется выполнить сетевой запрос за данными.
 */
export function shouldFetchEvents(
    requiredWindow,
    loadedWindow,
    currentShapeKey,
    loadedShapeKey,
    truncationContext = null
) {
    // 1. Первичная инициализация: данные еще ни разу не загружались
    if (!loadedWindow) {
        return true;
    }

    // 2. Инвалидация по фильтрам: изменился состав рангов или категорий
    if (!loadedShapeKey || currentShapeKey !== loadedShapeKey) {
        return true;
    }

    // 3. Выход за пределы: требуемое окно вышло за границы ранее выгруженного диапазона
    if (!isWindowCovered(requiredWindow, loadedWindow)) {
        return true;
    }

    // 4. Проверка необходимости дозагрузки при усечении: приближение камеры на 1 шаг логарифмического масштаба и более
    if (
        truncationContext !== null &&
        typeof truncationContext === 'object' &&
        truncationContext.isTruncated === true &&
        typeof truncationContext.loadedZoomIndex === 'number' &&
        typeof truncationContext.currentZoomIndex === 'number' &&
        (truncationContext.loadedZoomIndex - truncationContext.currentZoomIndex) >= TRUNCATED_REFETCH_ZOOM_INDEX_DELTA
    ) {
        return true;
    }

    // 5. Попадание в кэш: требуемое окно полностью содержится внутри загруженного
    return false;
}
