/**
 * Модуль геометрической проекции и фильтрации видимости маркеров исторических событий.
 * Выполняет чистый расчет экранных координат, ширины полос интервальных событий,
 * определение вырожденных интервалов и маппинг CSS-переменных цветовых категорий темы.
 *
 * АРХИТЕКТУРНЫЕ СОГЛАШЕНИЯ:
 * 1. Модуль является чистой математической функцией без побочных эффектов, состояния
 *    и зависимостей от DOM-дерева и контекста Canvas 2D.
 * 2. Вертикальное распределение (стекирование полос) и разрешение коллизий маркеров
 *    в данном модуле не реализуются и сознательно отнесены к шагу 3 дорожной карты.
 *    Все маркеры формируются для размещения на единой горизонтальной базовой полосе,
 *    а визуальные наложения перекрываются в естественном хронологическом порядке.
 * 3. Правило вырожденного интервала: если длина интервального события на экране меньше
 *    MIN_EVENT_BAR_WIDTH_PX, событие маркируется как точечное (isPoint = true, widthPx = 0),
 *    что гарантирует его визуальную различимость на обзорных масштабах времени.
 */

import { timestampToScreenX } from './scale.js';

/**
 * Минимальная экранная ширина полосы интервального события в пикселях.
 * События с меньшей расчетной шириной отображаются точечными маркерами.
 */
export const MIN_EVENT_BAR_WIDTH_PX = 4;

/**
 * Размер горизонтального буфера упреждения в пикселях по умолчанию.
 * Обеспечивает плавное появление маркеров при панорамировании.
 */
export const DEFAULT_MARKER_BUFFER_PX = 50;

/**
 * Предельный потолок количества одновременно подготавливаемых маркеров на кадр.
 * Защищает графический конвейер от деградации FPS при высокой плотности выборки.
 */
export const MAX_RENDERED_MARKERS_CEILING = 500;

/**
 * Имя CSS-переменной цвета по умолчанию для неизвестных или пользовательских категорий.
 */
export const FALLBACK_CATEGORY_THEME_VARIABLE = '--color-category-other';

/**
 * Таблица соответствия регламентированных категорий событий переменным цветовой палитры темы.
 * @type {Readonly<Record<string, string>>}
 */
export const CATEGORY_THEME_VARIABLES = Object.freeze({
    culture: '--color-category-culture',
    politics: '--color-category-politics',
    economy: '--color-category-economy',
    science: '--color-category-science',
});

/**
 * Проецирует временные границы события в экранную геометрию (координату X, ширину и тип маркера).
 *
 * @param {{ start_date: number, end_date?: number | null }} event Доменная сущность события.
 * @param {number} originTimestamp Метка времени на левом крае видимой области (X = 0).
 * @param {number} secondsPerPixel Текущий физический масштаб виртуальной камеры.
 * @param {number} [minBarWidth=MIN_EVENT_BAR_WIDTH_PX] Минимальный порог ширины для интервальной полосы.
 * @returns {{ screenX: number, widthPx: number, isPoint: boolean }} Экранные геометрические параметры.
 */
export function projectEventGeometry(
    event,
    originTimestamp,
    secondsPerPixel,
    minBarWidth = MIN_EVENT_BAR_WIDTH_PX
) {
    // Расчет экранной координаты начала события в логических пикселях
    const startX = timestampToScreenX(event.start_date, originTimestamp, secondsPerPixel);

    // Правило точечного события: отсутствие даты окончания либо нулевая/отрицательная длительность
    if (
        event.end_date === null ||
        event.end_date === undefined ||
        event.end_date <= event.start_date
    ) {
        return {
            screenX: startX,
            widthPx: 0,
            isPoint: true,
        };
    }

    // Расчет экранной ширины интервального события
    const rawWidthPx = (event.end_date - event.start_date) / secondsPerPixel;

    // Правило вырожденного интервала: слишком короткие интервалы отображаются точечными маркерами
    if (rawWidthPx < minBarWidth) {
        return {
            screenX: startX,
            widthPx: 0,
            isPoint: true,
        };
    }

    return {
        screenX: startX,
        widthPx: rawWidthPx,
        isPoint: false,
    };
}

/**
 * Определяет имя CSS-переменной палитры темы для заданной категории события.
 * Поддерживает нечувствительность к регистру и защиту от пользовательских значений СУБД.
 *
 * @param {string|unknown} category Строковый идентификатор категории.
 * @returns {string} Имя CSS-переменной темы (например, '--color-category-science').
 */
export function getCategoryThemeVariable(category) {
    if (typeof category === 'string') {
        const normalizedCategory = category.trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(CATEGORY_THEME_VARIABLES, normalizedCategory)) {
            return CATEGORY_THEME_VARIABLES[normalizedCategory];
        }
    }

    return FALLBACK_CATEGORY_THEME_VARIABLE;
}

/**
 * Проверяет, попадает ли проекция события в видимую область экрана с учетом буфера упреждения.
 * Корректно определяет видимость макрособытий, целиком накрывающих видимое окно.
 *
 * @param {{ start_date: number, end_date?: number | null }} event Доменная сущность события.
 * @param {number} originTimestamp Метка времени на левом крае видимой области (X = 0).
 * @param {number} secondsPerPixel Текущий физический масштаб виртуальной камеры.
 * @param {number} widthPx Ширина видимой области холста в логических пикселях.
 * @param {number} [bufferPx=DEFAULT_MARKER_BUFFER_PX] Дополнительный пиксельный запас слева и справа.
 * @returns {boolean} True, если маркер пересекает расширенные границы области отображения.
 */
export function isEventVisible(
    event,
    originTimestamp,
    secondsPerPixel,
    widthPx,
    bufferPx = DEFAULT_MARKER_BUFFER_PX
) {
    const minScreenX = -bufferPx;
    const maxScreenX = widthPx + bufferPx;

    const startX = timestampToScreenX(event.start_date, originTimestamp, secondsPerPixel);

    // Для точечного события проверяем попадание точки startX в допустимый интервал
    if (event.end_date === null || event.end_date === undefined) {
        return startX >= minScreenX && startX <= maxScreenX;
    }

    // Для интервального события рассчитываем проекцию окончания и крайние границы
    const endX = timestampToScreenX(event.end_date, originTimestamp, secondsPerPixel);
    const eventLeft = Math.min(startX, endX);
    const eventRight = Math.max(startX, endX);

    // Событие видимо, если его отрезок пересекается с окном [minScreenX, maxScreenX]
    return eventRight >= minScreenX && eventLeft <= maxScreenX;
}

/**
 * Пакетная фильтрация и геометрическая проекция массива исторических событий для отрисовки.
 * Отбирает только видимые маркеры, рассчитывает геометрию, определяет цвет темы
 * и ограничивает результирующий массив потолком maxMarkers с сохранением хронологии.
 *
 * @param {Array<Object>} events Массив загруженных доменных сущностей событий.
 * @param {number} originTimestamp Метка времени на левом крае видимой области (X = 0).
 * @param {number} secondsPerPixel Текущий физический масштаб виртуальной камеры.
 * @param {number} widthPx Ширина видимой области холста в логических пикселях.
 * @param {{
 *   bufferPx?: number,
 *   minBarWidth?: number,
 *   maxMarkers?: number
 * }} [options={}] Дополнительные параметры фильтрации и геометрии.
 * @returns {Array<{
 *   event: Object,
 *   screenX: number,
 *   widthPx: number,
 *   isPoint: boolean,
 *   themeVariable: string
 * }>} Массив готовых геометрических дескрипторов маркеров для отрисовки.
 */
export function prepareEventMarkers(
    events,
    originTimestamp,
    secondsPerPixel,
    widthPx,
    options = {}
) {
    if (!Array.isArray(events) || events.length === 0) {
        return [];
    }

    const bufferPx = options.bufferPx ?? DEFAULT_MARKER_BUFFER_PX;
    const minBarWidth = options.minBarWidth ?? MIN_EVENT_BAR_WIDTH_PX;
    const maxMarkers = options.maxMarkers ?? MAX_RENDERED_MARKERS_CEILING;

    const preparedMarkers = [];

    // Итерация по событиям в исходном хронологическом порядке
    for (let i = 0; i < events.length; i++) {
        const event = events[i];

        if (!event || typeof event.start_date !== 'number') {
            continue;
        }

        // Проверка вхождения в расширенное видимое окно
        if (isEventVisible(event, originTimestamp, secondsPerPixel, widthPx, bufferPx)) {
            // Расчет проекционных координат
            const geom = projectEventGeometry(
                event,
                originTimestamp,
                secondsPerPixel,
                minBarWidth
            );

            // Разрешение переменной темы оформления по категории
            const themeVariable = getCategoryThemeVariable(event.category);

            preparedMarkers.push({
                event,
                screenX: geom.screenX,
                widthPx: geom.widthPx,
                isPoint: geom.isPoint,
                themeVariable,
            });

            // Защита от деградации производительности: прерывание при достижении лимита
            if (preparedMarkers.length >= maxMarkers) {
                break;
            }
        }
    }

    return preparedMarkers;
}
