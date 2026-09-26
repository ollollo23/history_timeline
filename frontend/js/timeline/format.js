/**
 * Модуль форматирования текстовых подписей делений временной шкалы, интервалов и дат событий.
 * Реализует чистое форматирование дат на русском языке без обращения к объектам Date и Intl.
 *
 * СИСТЕМНЫЕ СОГЛАШЕНИЯ И АРХИТЕКТУРНЫЕ ОГРАНИЧЕНИЯ:
 * 1. Категорически запрещено использование new Date(), статических методов Date
 *    и конструктора Intl.DateTimeFormat из-за аппаратного лимита -271 821 года.
 * 2. Все разложения секунд Unix на составляющие производятся через функцию timestampToCivil.
 * 3. Нумерация годов до нашей эры строго следует историческому соглашению:
 *    астрономический год 0 отображается как «1 до н. э.», год -1 — как «2 до н. э.».
 * 4. Для крупных масштабов (тысячелетия, эпохи, миллионы лет) применяются компактные
 *    суффиксы («тыс. лет до н. э.», «млн лет до н. э.») без паразитных дробных хвостов.
 * 5. Масштаб миллионов лет активируется строго при достижении одного миллиона лет (>= 1 000 000).
 * 6. Форматирование дат событий адаптируется под доменный ранг детализации (rank).
 */

import { timestampToCivil } from './calendar.js';

/**
 * Сокращенные наименования месяцев года на русском языке (индексы 0..11).
 */
export const MONTH_NAMES_SHORT = [
    'янв', 'фев', 'мар', 'апр', 'май', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/**
 * Вспомогательная функция дополнения числа лидирующими нулями до заданной длины.
 *
 * @param {number|string} value Исходное числовое значение.
 * @param {number} [length=2] Требуемая минимальная длина строки.
 * @returns {string} Строка, дополненная нулями слева.
 */
export function padZero(value, length = 2) {
    return String(value).padStart(length, '0');
}

/**
 * Форматирование астрономического года в историческое строковое представление.
 * Гарантирует отсутствие дробных хвостов при целочисленных значениях тысяч и миллионов лет.
 * Масштаб миллионов лет применяется строго при historicalYear >= 1 000 000.
 *
 * @param {number} year Астрономический год (..., -1, 0, 1, ...).
 * @param {'year'|'millennium'|'millennium_large'} [compactScale='year'] Масштаб компактности.
 * @returns {string} Человекочитаемая текстовая подпись года.
 */
export function formatAstronomicalYear(year, compactScale = 'year') {
    // 1. Обработка дат до нашей эры (year <= 0)
    if (year <= 0) {
        // Преобразование астрономического года в исторический год до н. э. (0 -> 1, -1 -> 2)
        const historicalYear = 1 - year;

        // Масштаб миллионов лет: строго при historicalYear >= 1 000 000
        if (historicalYear >= 1000000) {
            const millions = historicalYear / 1000000;
            const formatted = Number.isInteger(millions)
                ? millions.toLocaleString('ru-RU')
                : Number(millions.toFixed(1)).toLocaleString('ru-RU');
            return `${formatted} млн лет до н. э.`;
        }

        // Масштаб тысячелетий: от 10 тыс. лет либо при явном запросе масштаба тысячелетий
        if (compactScale === 'millennium' || compactScale === 'millennium_large' || historicalYear >= 10000) {
            const thousands = historicalYear / 1000;
            const formatted = Number.isInteger(thousands)
                ? thousands.toLocaleString('ru-RU')
                : Number(thousands.toFixed(1)).toLocaleString('ru-RU');
            return `${formatted} тыс. лет до н. э.`;
        }

        return `${historicalYear} до н. э.`;
    }

    // 2. Обработка дат нашей эры (year > 0)
    if (year >= 1000000) {
        const millions = year / 1000000;
        const formatted = Number.isInteger(millions)
            ? millions.toLocaleString('ru-RU')
            : Number(millions.toFixed(1)).toLocaleString('ru-RU');
        return `${formatted} млн лет н. э.`;
    }

    if (year >= 10000) {
        const thousands = year / 1000;
        const formatted = Number.isInteger(thousands)
            ? thousands.toLocaleString('ru-RU')
            : Number(thousands.toFixed(1)).toLocaleString('ru-RU');
        return `${formatted} тыс. лет н. э.`;
    }

    // Для ранних эпох нашей эры (до 500 года) суффикс обязателен для однозначности восприятия
    if (year <= 500) {
        return `${year} н. э.`;
    }

    // Общепринятый современный формат без суффикса (501..9999 гг.)
    return `${year}`;
}

/**
 * Форматирование текстовой подписи отдельного деления шкалы времени (Tick Label).
 * Объединяет годовые и макро-единицы с порогом миллионов лет строго от 1 000 000 лет.
 *
 * @param {number} tickTimestamp Временная метка деления в секундах Unix.
 * @param {'second'|'minute'|'hour'|'day'|'month'|'year'|'decade'|'century'|'millennium'} unit Календарная единица шага.
 * @param {number} [stepCount=1] Множитель шага деления.
 * @returns {string} Текстовая подпись деления для отображения на холсте.
 */
export function formatTickLabel(tickTimestamp, unit, stepCount = 1) {
    const civil = timestampToCivil(tickTimestamp);

    switch (unit) {
        case 'second':
            // Секундный уровень: часы, минуты и секунды (HH:MM:SS)
            return `${padZero(civil.hour)}:${padZero(civil.minute)}:${padZero(civil.second)}`;

        case 'minute':
            // Минутный уровень: часы и минуты (HH:MM)
            return `${padZero(civil.hour)}:${padZero(civil.minute)}`;

        case 'hour':
            // В полночь отображается дата, в остальные часы — время (HH:MM)
            if (civil.hour === 0) {
                return `${civil.day} ${MONTH_NAMES_SHORT[civil.month - 1]}`;
            }
            return `${padZero(civil.hour)}:${padZero(civil.minute)}`;

        case 'day':
            // Первое число месяца выделяется указанием месяца и года
            if (civil.day === 1) {
                return `${MONTH_NAMES_SHORT[civil.month - 1]} ${formatAstronomicalYear(civil.year)}`;
            }
            return `${civil.day} ${MONTH_NAMES_SHORT[civil.month - 1]}`;

        case 'month':
            // Месячный уровень: сокращенное имя месяца и год
            return `${MONTH_NAMES_SHORT[civil.month - 1]} ${formatAstronomicalYear(civil.year)}`;

        case 'year':
        case 'decade':
        case 'century':
        case 'millennium': {
            // Расчет эффективного временного охвата шага в астрономических годах
            let effectiveYears = stepCount;
            if (unit === 'decade') {
                effectiveYears *= 10;
            } else if (unit === 'century') {
                effectiveYears *= 100;
            } else if (unit === 'millennium') {
                effectiveYears *= 1000;
            }

            // Выбор масштаба компактности: миллионы активируются строго при шаге от 1 000 000 лет
            let compactScale = 'year';
            if (effectiveYears >= 1000000) {
                compactScale = 'millennium_large';
            } else if (effectiveYears >= 1000) {
                compactScale = 'millennium';
            }

            return formatAstronomicalYear(civil.year, compactScale);
        }

        default:
            return formatAstronomicalYear(civil.year);
    }
}

/**
 * Форматирование строкового диапазона видимой области таймлайна для информационной панели.
 *
 * @param {number} startTimestamp Начало видимого интервала в секундах.
 * @param {number} endTimestamp Конец видимого интервала в секундах.
 * @returns {string} Текстовое представление диапазона вида «Начало — Конец».
 */
export function formatContextInterval(startTimestamp, endTimestamp) {
    const startCivil = timestampToCivil(startTimestamp);
    const endCivil = timestampToCivil(endTimestamp);
    const duration = Math.abs(endTimestamp - startTimestamp);

    let startText;
    let endText;

    // 1. Интервалы масштаба от двух лет и крупнее
    if (duration >= 63115200) {
        startText = formatAstronomicalYear(startCivil.year);
        endText = formatAstronomicalYear(endCivil.year);
    }
    // 2. Интервалы масштаба месяцев (от ~1 месяца до 2 лет)
    else if (duration >= 2592000) {
        startText = `${MONTH_NAMES_SHORT[startCivil.month - 1]} ${formatAstronomicalYear(startCivil.year)}`;
        endText = `${MONTH_NAMES_SHORT[endCivil.month - 1]} ${formatAstronomicalYear(endCivil.year)}`;
    }
    // 3. Интервалы масштаба суток (от 1 суток до месяца)
    else if (duration >= 86400) {
        startText = `${startCivil.day} ${MONTH_NAMES_SHORT[startCivil.month - 1]} ${formatAstronomicalYear(startCivil.year)}`;
        endText = `${endCivil.day} ${MONTH_NAMES_SHORT[endCivil.month - 1]} ${formatAstronomicalYear(endCivil.year)}`;
    }
    // 4. Внутрисуточные интервалы (часы, минуты, секунды)
    else {
        startText = `${startCivil.day} ${MONTH_NAMES_SHORT[startCivil.month - 1]} ${formatAstronomicalYear(startCivil.year)} ${padZero(startCivil.hour)}:${padZero(startCivil.minute)}`;
        endText = `${endCivil.day} ${MONTH_NAMES_SHORT[endCivil.month - 1]} ${formatAstronomicalYear(endCivil.year)} ${padZero(endCivil.hour)}:${padZero(endCivil.minute)}`;
    }

    return `${startText} — ${endText}`;
}

/**
 * Получение наименования текущего уровня масштаба на русском языке.
 * Поддерживает весь диапазон лестницы TICK_LADDER от секунд до тысячелетий.
 *
 * @param {'second'|'minute'|'hour'|'day'|'month'|'year'|'decade'|'century'|'millennium'} unit Календарная единица сетки.
 * @param {number} [stepCount=1] Множитель шага сетки.
 * @returns {string} Читаемое русскоязычное обозначение уровня детализации.
 */
export function formatScaleLevelName(unit, stepCount = 1) {
    switch (unit) {
        case 'second':
            return stepCount === 1 ? 'Секунды' : `${stepCount} сек.`;

        case 'minute':
            return stepCount === 1 ? 'Минуты' : `${stepCount} мин.`;

        case 'hour':
            return stepCount === 1 ? 'Часы' : `${stepCount} ч.`;

        case 'day':
            if (stepCount === 7) {
                return 'Недели';
            }
            return stepCount === 1 ? 'Дни' : `${stepCount} дн.`;

        case 'month':
            return stepCount === 1 ? 'Месяцы' : `${stepCount} мес.`;

        case 'year':
            return stepCount === 1 ? 'Годы' : `${stepCount} г.`;

        case 'decade':
            return stepCount === 1 ? 'Десятилетия' : `${stepCount * 10} лет`;

        case 'century':
            return stepCount === 1
                ? 'Века'
                : (stepCount < 10 ? `${stepCount} в.` : `${stepCount * 100} лет`);

        case 'millennium':
            if (stepCount >= 1000) {
                return `${stepCount / 1000} млн лет`;
            }
            if (stepCount === 1) {
                return 'Тысячелетия';
            }
            return `${stepCount} тыс. лет`;

        default:
            return String(unit);
    }
}

/**
 * Форматирование временной метки исторического события в строковое представление
 * с точностью, соответствующей доменному рангу детализации.
 *
 * @param {number} timestamp Временная метка события в секундах Unix.
 * @param {string} rank Доменный ранг детализации события.
 * @returns {string} Человекочитаемая текстовая подпись даты события.
 */
export function formatEventDate(timestamp, rank) {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        return '';
    }

    const civil = timestampToCivil(timestamp);
    const yearStr = formatAstronomicalYear(civil.year);
    const monthStr = MONTH_NAMES_SHORT[civil.month - 1];

    switch (rank) {
        case 'century':
        case 'decade':
        case 'year':
            return yearStr;

        case 'month':
            return `${monthStr} ${yearStr}`;

        case 'hour':
        case 'minute':
            return `${civil.day} ${monthStr} ${yearStr} ${padZero(civil.hour)}:${padZero(civil.minute)}`;

        case 'second':
            return `${civil.day} ${monthStr} ${yearStr} ${padZero(civil.hour)}:${padZero(civil.minute)}:${padZero(civil.second)}`;

        case 'day':
        default:
            return `${civil.day} ${monthStr} ${yearStr}`;
    }
}

/**
 * Форматирование временного диапазона исторического события в строку вида «Начало — Конец».
 * Если дата окончания не задана, некорректна, меньше/равна дате начала
 * либо строковые представления совпадают при заданной точности ранга,
 * возвращается одиночная дата начала.
 *
 * @param {number} startTimestamp Начальная метка времени в секундах Unix.
 * @param {number|null|undefined} endTimestamp Конечная метка времени в секундах Unix.
 * @param {string} rank Доменный ранг детализации события.
 * @returns {string} Человекочитаемый диапазон дат либо одиночная дата начала.
 */
export function formatEventDateRange(startTimestamp, endTimestamp, rank) {
    if (typeof startTimestamp !== 'number' || !Number.isFinite(startTimestamp)) {
        return '';
    }

    const startStr = formatEventDate(startTimestamp, rank);

    if (
        endTimestamp === null ||
        endTimestamp === undefined ||
        typeof endTimestamp !== 'number' ||
        !Number.isFinite(endTimestamp) ||
        endTimestamp <= startTimestamp
    ) {
        return startStr;
    }

    const endStr = formatEventDate(endTimestamp, rank);

    if (startStr === endStr) {
        return startStr;
    }

    return `${startStr} — ${endStr}`;
}
