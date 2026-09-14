/**
 * Модульные тесты математического ядра пролептического григорианского календаря.
 * Обеспечивают всестороннюю верификацию функций високосности, длины месяцев,
 * взаимной обратимости (Round-trip), нормализации начала периодов и календарного смещения
 * без использования встроенного объекта Date и библиотеки Intl.
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Исполнение в среде Node.js под управлением фреймворка Vitest.
 * 2. Импорт исходных модулей строго через подъем на два уровня (../../frontend/js/timeline/...).
 * 3. Поддержка непрерывной шкалы времени от -1 000 000 лет до н. э. до 3000 года н. э.
 */

import { describe, it, expect } from 'vitest';
import {
    isLeapYear,
    getDaysInMonth,
    timestampToCivil,
    civilToTimestamp,
    startOf,
    addCalendarUnits,
} from '../../frontend/js/timeline/calendar.js';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
    SECONDS_PER_DAY,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
} from '../../frontend/js/timeline/constants.js';

describe('isLeapYear and getDaysInMonth', () => {
    it('корректно определяет високосные годы нашей эры (2000, 2024)', () => {
        expect(isLeapYear(2000)).toBe(true);
        expect(isLeapYear(2024)).toBe(true);
        expect(getDaysInMonth(2000, 2)).toBe(29);
        expect(getDaysInMonth(2024, 2)).toBe(29);
    });

    it('корректно определяет невисокосные годы нашей эры (1900, 2100, 2023)', () => {
        expect(isLeapYear(1900)).toBe(false);
        expect(isLeapYear(2100)).toBe(false);
        expect(isLeapYear(2023)).toBe(false);
        expect(getDaysInMonth(1900, 2)).toBe(28);
        expect(getDaysInMonth(2100, 2)).toBe(28);
        expect(getDaysInMonth(2023, 2)).toBe(28);
    });

    it('корректно рассчитывает високосность в астрономической нумерации до н. э. (0, -1, -100, -400)', () => {
        // Год 0 (1 до н. э.): делится на 400 -> високосный
        expect(isLeapYear(0)).toBe(true);
        expect(getDaysInMonth(0, 2)).toBe(29);

        // Год -1 (2 до н. э.): не делится на 4 -> невисокосный
        expect(isLeapYear(-1)).toBe(false);
        expect(getDaysInMonth(-1, 2)).toBe(28);

        // Год -100 (101 до н. э.): делится на 100, но не на 400 -> невисокосный
        expect(isLeapYear(-100)).toBe(false);
        expect(getDaysInMonth(-100, 2)).toBe(28);

        // Год -400 (401 до н. э.): делится на 400 -> високосный
        expect(isLeapYear(-400)).toBe(true);
        expect(getDaysInMonth(-400, 2)).toBe(29);
    });

    it('возвращает корректное число дней для стандартных месяцев года', () => {
        const months31 = [1, 3, 5, 7, 8, 10, 12];
        const months30 = [4, 6, 9, 11];

        for (const m of months31) {
            expect(getDaysInMonth(2024, m)).toBe(31);
            expect(getDaysInMonth(2023, m)).toBe(31);
        }

        for (const m of months30) {
            expect(getDaysInMonth(2024, m)).toBe(30);
            expect(getDaysInMonth(2023, m)).toBe(30);
        }
    });

    it('выбрасывает исключение Error при передаче неподдерживаемой календарной системы', () => {
        expect(() => isLeapYear(2024, 'julian')).toThrow(/Неподдерживаемая календарная система/);
        expect(() => getDaysInMonth(2024, 2, 'julian')).toThrow(/Неподдерживаемая календарная система/);
    });
});

describe('round-trip civilToTimestamp and timestampToCivil', () => {
    it('гарантирует точную обратимость civilToTimestamp(timestampToCivil(ts)) === ts на контрольных точках', () => {
        const checkpoints = [
            0, // 1970-01-01T00:00:00Z
            946684800, // 2000-01-01T00:00:00Z
            86400, // 1970-01-02T00:00:00Z
            -86400, // 1969-12-31T00:00:00Z
            TIMELINE_MIN_TIMESTAMP, // Граница древности (-31 557 600 000 000 с)
            TIMELINE_MAX_TIMESTAMP, // Граница будущего (32 503 680 000 с)
            -62167219200, // Смена эр: 0000-01-01T00:00:00Z (1 января 1 г. до н. э.)
            1715783742, // Произвольная современная дата: 2024-05-15 14:35:42
            -1234567890, // Произвольная отрицательная дата
        ];

        for (const ts of checkpoints) {
            const civil = timestampToCivil(ts);
            const reconstructedTs = civilToTimestamp(civil);
            expect(reconstructedTs).toBe(ts);
        }
    });

    it('гарантирует обратимость timestampToCivil(civilToTimestamp(date)) для високосных и граничных дат', () => {
        const leapDate = { year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 59 };
        const leapTs = civilToTimestamp(leapDate);
        expect(timestampToCivil(leapTs)).toEqual(leapDate);

        const ancientDate = { year: -500, month: 7, day: 15, hour: 12, minute: 30, second: 0 };
        const ancientTs = civilToTimestamp(ancientDate);
        expect(timestampToCivil(ancientTs)).toEqual(ancientDate);

        const minDate = timestampToCivil(TIMELINE_MIN_TIMESTAMP);
        expect(civilToTimestamp(minDate)).toBe(TIMELINE_MIN_TIMESTAMP);
    });

    it('выбрасывает исключение при передаче неверной календарной системы в методы преобразования', () => {
        expect(() => timestampToCivil(0, 'unsupported')).toThrow(/Неподдерживаемая календарная система/);
        expect(() => civilToTimestamp({ year: 2024, month: 1, day: 1 }, 'unsupported')).toThrow(
            /Неподдерживаемая календарная система/
        );
    });
});

describe('startOf', () => {
    // 2024-05-15 14:35:42
    const baseDate = { year: 2024, month: 5, day: 15, hour: 14, minute: 35, second: 42 };
    const baseTs = civilToTimestamp(baseDate);

    it('выравнивает секундный уровень, отсекая дробную часть', () => {
        expect(startOf(baseTs + 0.75, 'second')).toBe(baseTs);
    });

    it('обнуляет секунды при выравнивании по минутам', () => {
        const expected = civilToTimestamp({ ...baseDate, second: 0 });
        expect(startOf(baseTs, 'minute')).toBe(expected);
    });

    it('обнуляет минуты и секунды при выравнивании по часам', () => {
        const expected = civilToTimestamp({ ...baseDate, minute: 0, second: 0 });
        expect(startOf(baseTs, 'hour')).toBe(expected);
    });

    it('выравнивает на полночь текущих суток', () => {
        const expected = civilToTimestamp({ ...baseDate, hour: 0, minute: 0, second: 0 });
        expect(startOf(baseTs, 'day')).toBe(expected);
    });

    it('выравнивает на начало месяца (1 число, 00:00:00)', () => {
        const expected = civilToTimestamp({ year: 2024, month: 5, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(baseTs, 'month')).toBe(expected);
    });

    it('выравнивает на начало года (1 января, 00:00:00)', () => {
        const expected = civilToTimestamp({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(baseTs, 'year')).toBe(expected);
    });

    it('выравнивает на начало десятилетия (2020-01-01)', () => {
        const expected = civilToTimestamp({ year: 2020, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(baseTs, 'decade')).toBe(expected);
    });

    it('выравнивает на начало столетия и тысячелетия (2000-01-01)', () => {
        const expected = civilToTimestamp({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(baseTs, 'century')).toBe(expected);
        expect(startOf(baseTs, 'millennium')).toBe(expected);
    });

    it('корректно выравнивает отрицательные даты до нашей эры вниз', () => {
        // Год -45 (46 год до н. э.)
        const bceDate = { year: -45, month: 6, day: 10, hour: 12, minute: 0, second: 0 };
        const bceTs = civilToTimestamp(bceDate);

        // Math.floor(-45 / 10) * 10 = -50
        const expectedDecade = civilToTimestamp({ year: -50, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(bceTs, 'decade')).toBe(expectedDecade);

        // Math.floor(-45 / 100) * 100 = -100
        const expectedCentury = civilToTimestamp({ year: -100, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(startOf(bceTs, 'century')).toBe(expectedCentury);
    });

    it('выбрасывает ошибку при неизвестной календарной единице', () => {
        expect(() => startOf(baseTs, 'invalid_unit')).toThrow(/Неизвестная календарная единица: invalid_unit/);
    });
});

describe('addCalendarUnits', () => {
    const baseDate = { year: 2024, month: 1, day: 15, hour: 12, minute: 0, second: 0 };
    const baseTs = civilToTimestamp(baseDate);

    it('возвращает исходную метку при amount === 0', () => {
        expect(addCalendarUnits(baseTs, 0, 'day')).toBe(baseTs);
        expect(addCalendarUnits(baseTs, 0, 'year')).toBe(baseTs);
    });

    it('выполняет прямое смещение по равномерным единицам времени вперед и назад', () => {
        expect(addCalendarUnits(baseTs, 10, 'second')).toBe(baseTs + 10);
        expect(addCalendarUnits(baseTs, -10, 'second')).toBe(baseTs - 10);

        expect(addCalendarUnits(baseTs, 5, 'minute')).toBe(baseTs + 5 * SECONDS_PER_MINUTE);
        expect(addCalendarUnits(baseTs, -5, 'minute')).toBe(baseTs - 5 * SECONDS_PER_MINUTE);

        expect(addCalendarUnits(baseTs, 3, 'hour')).toBe(baseTs + 3 * SECONDS_PER_HOUR);
        expect(addCalendarUnits(baseTs, -3, 'hour')).toBe(baseTs - 3 * SECONDS_PER_HOUR);

        expect(addCalendarUnits(baseTs, 7, 'day')).toBe(baseTs + 7 * SECONDS_PER_DAY);
        expect(addCalendarUnits(baseTs, -7, 'day')).toBe(baseTs - 7 * SECONDS_PER_DAY);
    });

    it('корректно сдвигает месяцы с усечением дней (clamping) для високосного и невисокосного годов', () => {
        // 31 января 2024 (високосный) + 1 месяц -> 29 февраля 2024
        const jan31Leap = civilToTimestamp({ year: 2024, month: 1, day: 31, hour: 12, minute: 0, second: 0 });
        const feb29Leap = civilToTimestamp({ year: 2024, month: 2, day: 29, hour: 12, minute: 0, second: 0 });
        expect(addCalendarUnits(jan31Leap, 1, 'month')).toBe(feb29Leap);

        // 31 января 2023 (невисокосный) + 1 месяц -> 28 февраля 2023
        const jan31Common = civilToTimestamp({ year: 2023, month: 1, day: 31, hour: 12, minute: 0, second: 0 });
        const feb28Common = civilToTimestamp({ year: 2023, month: 2, day: 28, hour: 12, minute: 0, second: 0 });
        expect(addCalendarUnits(jan31Common, 1, 'month')).toBe(feb28Common);

        // 31 марта + 1 месяц -> 30 апреля
        const mar31 = civilToTimestamp({ year: 2024, month: 3, day: 31, hour: 10, minute: 0, second: 0 });
        const apr30 = civilToTimestamp({ year: 2024, month: 4, day: 30, hour: 10, minute: 0, second: 0 });
        expect(addCalendarUnits(mar31, 1, 'month')).toBe(apr30);
    });

    it('корректно сдвигает годы с обработкой високосного 29 февраля', () => {
        const feb29 = civilToTimestamp({ year: 2024, month: 2, day: 29, hour: 8, minute: 0, second: 0 });

        // 29 февраля 2024 + 1 год -> 28 февраля 2025 (невисокосный)
        const feb28NextYear = civilToTimestamp({ year: 2025, month: 2, day: 28, hour: 8, minute: 0, second: 0 });
        expect(addCalendarUnits(feb29, 1, 'year')).toBe(feb28NextYear);

        // 29 февраля 2024 + 4 года -> 29 февраля 2028 (високосный)
        const feb29In4Years = civilToTimestamp({ year: 2028, month: 2, day: 29, hour: 8, minute: 0, second: 0 });
        expect(addCalendarUnits(feb29, 4, 'year')).toBe(feb29In4Years);
    });

    it('корректно производит переходы через границы столетий и смену эр', () => {
        // 1999-12-15 + 1 месяц -> 2000-01-15
        const dec1999 = civilToTimestamp({ year: 1999, month: 12, day: 15, hour: 0, minute: 0, second: 0 });
        const jan2000 = civilToTimestamp({ year: 2000, month: 1, day: 15, hour: 0, minute: 0, second: 0 });
        expect(addCalendarUnits(dec1999, 1, 'month')).toBe(jan2000);

        // Сдвиг через нулевой год: год -1 (2 до н. э.) + 2 года -> год 1 (1 н. э.)
        const bce2 = civilToTimestamp({ year: -1, month: 5, day: 1, hour: 0, minute: 0, second: 0 });
        const ce1 = civilToTimestamp({ year: 1, month: 5, day: 1, hour: 0, minute: 0, second: 0 });
        expect(addCalendarUnits(bce2, 2, 'year')).toBe(ce1);

        // Шаг по десятилетиям, столетиям и тысячелетиям
        expect(addCalendarUnits(jan2000, 1, 'decade')).toBe(
            civilToTimestamp({ year: 2010, month: 1, day: 15, hour: 0, minute: 0, second: 0 })
        );
        expect(addCalendarUnits(jan2000, 1, 'century')).toBe(
            civilToTimestamp({ year: 2100, month: 1, day: 15, hour: 0, minute: 0, second: 0 })
        );
        expect(addCalendarUnits(jan2000, 1, 'millennium')).toBe(
            civilToTimestamp({ year: 3000, month: 1, day: 15, hour: 0, minute: 0, second: 0 })
        );
    });

    it('выбрасывает ошибку при попытке шага по неизвестной единице времени', () => {
        expect(() => addCalendarUnits(baseTs, 5, 'lightyear')).toThrow(/Неизвестная календарная единица: lightyear/);
    });
});
