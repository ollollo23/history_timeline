/**
 * Математическое ядро пролептической григорианской календарной арифметики.
 * Реализует алгоритм Говарда Хиннанта со сдвигом вычислительного года на 1 марта.
 *
 * СИСТЕМНЫЕ СОГЛАШЕНИЯ И АРХИТЕКТУРНЫЕ ПРАВИЛА:
 * 1. Високосные секунды не учитываются; базовой единицей измерения служат секунды
 *    относительно эпохи Unix (1970-01-01T00:00:00Z UTC).
 * 2. Все расчеты производятся в непрерывной астрономической нумерации годов:
 *    год 0 соответствует 1 году до н. э., год -1 — 2 году до н. э., год 1 — 1 году н. э.
 * 3. Встроенный объект JavaScript Date категорически запрещен, так как его допустимый
 *    диапазон ограничен отметкой -8.64e12 секунд (~ -271 821 год), тогда как нижняя
 *    граница платформы TIMELINE_MIN_TIMESTAMP составляет -31.5576e12 секунд (~ -1 000 000 лет).
 * 4. Реализация строго следует пролептическому григорианскому календарю (gregorian_proleptic).
 *    Параметр calendarSystem со значением по умолчанию 'gregorian_proleptic' заложен
 *    в сигнатуры функций для будущего расширения юлианским календарем.
 */

import {
    SECONDS_PER_DAY,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
} from './constants.js';

/**
 * Проверка високосности астрономического года по правилу пролептического григорианского календаря.
 * Год является високосным, если он кратен 4 и при этом (не кратен 100 либо кратен 400).
 *
 * @param {number} year Целочисленный астрономический год (..., -1, 0, 1, ...).
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {boolean} True, если год високосный (366 дней).
 */
export function isLeapYear(year, calendarSystem = 'gregorian_proleptic') {
    if (calendarSystem !== 'gregorian_proleptic') {
        throw new Error(`Неподдерживаемая календарная система: ${calendarSystem}`);
    }

    // В JavaScript оператор остатка от деления (%) корректно сохраняет нулевой остаток для отрицательных чисел
    return (year % 4 === 0) && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Определение точного количества дней в месяце с учетом високосности года.
 *
 * @param {number} year Астрономический год.
 * @param {number} month Номер месяца от 1 (январь) до 12 (декабрь).
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {number} Количество дней в указанном месяце (28, 29, 30 или 31).
 */
export function getDaysInMonth(year, month, calendarSystem = 'gregorian_proleptic') {
    if (month === 2) {
        return isLeapYear(year, calendarSystem) ? 29 : 28;
    }

    // Апрель, июнь, сентябрь, ноябрь содержат ровно 30 дней
    if (month === 4 || month === 6 || month === 9 || month === 11) {
        return 30;
    }

    // Январь, март, май, июль, август, октябрь, декабрь содержат 31 день
    return 31;
}

/**
 * Преобразование временной метки в секундах от эпохи Unix в структуру гражданской даты.
 * Применяет непрерывный целочисленный алгоритм со сдвигом года к 1 марта.
 *
 * @param {number} timestamp Временная метка в секундах Unix (поддерживает отрицательные числа).
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 */
export function timestampToCivil(timestamp, calendarSystem = 'gregorian_proleptic') {
    if (calendarSystem !== 'gregorian_proleptic') {
        throw new Error(`Неподдерживаемая календарная система: ${calendarSystem}`);
    }

    // Вычисление количества полных суток от эпохи с округлением строго к отрицательной бесконечности
    const days = Math.floor(timestamp / SECONDS_PER_DAY);

    // Вычисление положительного остатка секунд внутри текущих суток [0, 86399]
    const secondOfDay = timestamp - days * SECONDS_PER_DAY;

    // Извлечение компонентов времени суток
    const hour = Math.floor(secondOfDay / SECONDS_PER_HOUR);
    const minute = Math.floor((secondOfDay % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const second = secondOfDay % SECONDS_PER_MINUTE;

    // Алгоритм разложения дней: сдвиг эпохи с 1970-01-01 на 0000-03-01 (+719468 дней)
    const z = days + 719468;

    // Определение 400-летнего цикла (эры) через чистое математическое деление с округлением вниз
    const era = Math.floor(z / 146097);

    // Номер дня внутри 400-летнего цикла [0, 146096]
    const doe = z - era * 146097;

    // Определение года внутри эры [0, 399] с компенсацией високосных дней столетий
    const yoe = Math.floor(
        (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
    );

    // Абсолютный год со сдвинутым началом (март)
    const y = yoe + era * 400;

    // Порядковый день года со сдвигом на 1 марта [0, 365]
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));

    // Вычисление номера месяца со сдвигом (март = 0, апрель = 1, ..., февраль = 11)
    const mp = Math.floor((5 * doy + 2) / 153);

    // Вычисление дня месяца
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;

    // Преобразование сдвинутого месяца в стандартный календарный номер [1, 12]
    const month = mp < 10 ? mp + 3 : mp - 9;

    // Корректировка года для января и февраля, принадлежащих следующему астрономическому году
    const year = y + (month <= 2 ? 1 : 0);

    return { year, month, day, hour, minute, second };
}

/**
 * Обратное преобразование структуры гражданской даты в точную метку времени в секундах Unix.
 * Полностью обратимо и согласовано с функцией timestampToCivil.
 *
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number}} civilDate
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {number} Временная метка в секундах от эпохи Unix.
 */
export function civilToTimestamp(civilDate, calendarSystem = 'gregorian_proleptic') {
    if (calendarSystem !== 'gregorian_proleptic') {
        throw new Error(`Неподдерживаемая календарная система: ${calendarSystem}`);
    }

    const { year, month, day } = civilDate;
    const hour = civilDate.hour ?? 0;
    const minute = civilDate.minute ?? 0;
    const second = civilDate.second ?? 0;

    // Сдвиг вычислительного года на 1 марта для исключения ветвления високосного дня
    const y = year - (month <= 2 ? 1 : 0);

    // Определение 400-летней эры через чистое математическое деление с округлением вниз
    const era = Math.floor(y / 400);

    // Год внутри эры [0, 399]
    const yoe = y - era * 400;

    // Месяц со сдвигом: март = 0, ..., декабрь = 9, январь = 10, февраль = 11
    const m = month > 2 ? month - 3 : month + 9;

    // Номер дня со сдвинутого начала года
    const doy = Math.floor((153 * m + 2) / 5) + day - 1;

    // Номер дня внутри 400-летней эры
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;

    // Преобразование в дни от 1970-01-01
    const days = era * 146097 + doe - 719468;

    // Итоговая сборка секунд Unix
    return (
        days * SECONDS_PER_DAY +
        hour * SECONDS_PER_HOUR +
        minute * SECONDS_PER_MINUTE +
        second
    );
}

/**
 * Вычисление метки времени начала календарной единицы (выравнивание вниз).
 * Служит основой привязки делений сетки таймлайна к естественным границам времени.
 *
 * @param {number} timestamp Временная метка в секундах Unix.
 * @param {'second'|'minute'|'hour'|'day'|'month'|'year'|'decade'|'century'|'millennium'} unit Календарная единица.
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {number} Метка времени начала соответствующего интервала в секундах.
 */
export function startOf(timestamp, unit, calendarSystem = 'gregorian_proleptic') {
    if (unit === 'second') {
        return Math.floor(timestamp);
    }
    if (unit === 'minute') {
        return Math.floor(timestamp / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
    }
    if (unit === 'hour') {
        return Math.floor(timestamp / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
    }
    if (unit === 'day') {
        return Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    }

    // Для календарных единиц от месяца и выше требуется разложение в дату
    const civil = timestampToCivil(timestamp, calendarSystem);

    if (unit === 'month') {
        return civilToTimestamp(
            { year: civil.year, month: civil.month, day: 1, hour: 0, minute: 0, second: 0 },
            calendarSystem
        );
    }
    if (unit === 'year') {
        return civilToTimestamp(
            { year: civil.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
            calendarSystem
        );
    }
    if (unit === 'decade') {
        // Округление астрономического года вниз до кратного 10
        const decadeYear = Math.floor(civil.year / 10) * 10;
        return civilToTimestamp(
            { year: decadeYear, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
            calendarSystem
        );
    }
    if (unit === 'century') {
        // Округление астрономического года вниз до кратного 100
        const centuryYear = Math.floor(civil.year / 100) * 100;
        return civilToTimestamp(
            { year: centuryYear, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
            calendarSystem
        );
    }
    if (unit === 'millennium') {
        // Округление астрономического года вниз до кратного 1000
        const millenniumYear = Math.floor(civil.year / 1000) * 1000;
        return civilToTimestamp(
            { year: millenniumYear, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
            calendarSystem
        );
    }

    throw new Error(`Неизвестная календарная единица: ${unit}`);
}

/**
 * Смещение временной метки вперед или назад на целое число календарных единиц.
 * Корректно учитывает переменную продолжительность месяцев и високосные годы.
 *
 * @param {number} timestamp Исходная временная метка в секундах Unix.
 * @param {number} amount Количество добавляемых единиц (может быть отрицательным).
 * @param {'second'|'minute'|'hour'|'day'|'month'|'year'|'decade'|'century'|'millennium'} unit Календарная единица.
 * @param {string} [calendarSystem='gregorian_proleptic'] Идентификатор календарной системы.
 * @returns {number} Результирующая временная метка в секундах.
 */
export function addCalendarUnits(timestamp, amount, unit, calendarSystem = 'gregorian_proleptic') {
    if (amount === 0) {
        return timestamp;
    }

    // Равномерные единицы времени рассчитываются прямым прибавлением секунд
    if (unit === 'second') {
        return timestamp + amount;
    }
    if (unit === 'minute') {
        return timestamp + amount * SECONDS_PER_MINUTE;
    }
    if (unit === 'hour') {
        return timestamp + amount * SECONDS_PER_HOUR;
    }
    if (unit === 'day') {
        return timestamp + amount * SECONDS_PER_DAY;
    }

    // Календарный шаг по месяцам с защитой от выхода за границу дней целевого месяца
    if (unit === 'month') {
        const civil = timestampToCivil(timestamp, calendarSystem);
        const totalMonths = civil.year * 12 + (civil.month - 1) + amount;

        const newYear = Math.floor(totalMonths / 12);
        const newMonth = (((totalMonths % 12) + 12) % 12) + 1;

        // Ограничение дня текущей датой окончания нового месяца (например, 31 января + 1 месяц -> 28/29 февраля)
        const maxDays = getDaysInMonth(newYear, newMonth, calendarSystem);
        const newDay = Math.min(civil.day, maxDays);

        return civilToTimestamp(
            {
                year: newYear,
                month: newMonth,
                day: newDay,
                hour: civil.hour,
                minute: civil.minute,
                second: civil.second,
            },
            calendarSystem
        );
    }

    // Календарный шаг по годам
    if (unit === 'year') {
        const civil = timestampToCivil(timestamp, calendarSystem);
        const newYear = civil.year + amount;

        let newDay = civil.day;
        // Коррекция 29 февраля при переходе на невисокосный год
        if (civil.month === 2 && civil.day === 29 && !isLeapYear(newYear, calendarSystem)) {
            newDay = 28;
        }

        return civilToTimestamp(
            {
                year: newYear,
                month: civil.month,
                day: newDay,
                hour: civil.hour,
                minute: civil.minute,
                second: civil.second,
            },
            calendarSystem
        );
    }

    // Крупные календарные единицы делегируются шагу по годам
    if (unit === 'decade') {
        return addCalendarUnits(timestamp, amount * 10, 'year', calendarSystem);
    }
    if (unit === 'century') {
        return addCalendarUnits(timestamp, amount * 100, 'year', calendarSystem);
    }
    if (unit === 'millennium') {
        return addCalendarUnits(timestamp, amount * 1000, 'year', calendarSystem);
    }

    throw new Error(`Неизвестная календарная единица: ${unit}`);
}
