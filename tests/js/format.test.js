/**
 * Модульные тесты форматирования текстовых меток дат, уровней сетки, интервалов и дат событий (format.js).
 * Валидируют исторические суффиксы, астрономический сдвиг нулевого года,
 * компактные формы тысячелетий и миллионов лет без дробных хвостов,
 * полную русскую локализацию всех 23 уровней лестницы TICK_LADDER,
 * а также ранговую точность форматирования дат и диапазонов событий.
 *
 * СИСТЕМНЫЕ ПРАВИЛА:
 * 1. Исполнение в среде Node.js под управлением Vitest без зависимостей от DOM и Canvas.
 * 2. Двухуровневый подъем импортов из ядра таймлайна (../../frontend/js/timeline/...).
 * 3. Полная изоляция от встроенных классов Date и Intl.DateTimeFormat.
 */

import { describe, it, expect } from 'vitest';
import {
    formatAstronomicalYear,
    formatTickLabel,
    formatScaleLevelName,
    formatContextInterval,
    formatEventDate,
    formatEventDateRange,
    padZero,
} from '../../frontend/js/timeline/format.js';
import { TICK_LADDER } from '../../frontend/js/timeline/constants.js';
import { civilToTimestamp } from '../../frontend/js/timeline/calendar.js';

describe('formatAstronomicalYear', () => {
    it('корректно обрабатывает переход через нулевой год и суффиксы до нашей эры', () => {
        // Астрономический год 0 соответствует 1 году до н. э.
        expect(formatAstronomicalYear(0)).toBe('1 до н. э.');

        // Астрономический год -1 соответствует 2 году до н. э.
        expect(formatAstronomicalYear(-1)).toBe('2 до н. э.');

        // Промежуточные исторические даты до н. э.
        expect(formatAstronomicalYear(-43)).toBe('44 до н. э.');
        expect(formatAstronomicalYear(-322)).toBe('323 до н. э.');
    });

    it('добавляет обязательный суффикс н. э. для ранней эпохи нашей эры (1–500 гг.)', () => {
        expect(formatAstronomicalYear(1)).toBe('1 н. э.');
        expect(formatAstronomicalYear(33)).toBe('33 н. э.');
        expect(formatAstronomicalYear(500)).toBe('500 н. э.');
    });

    it('выводит простые числовые строки без суффикса для общепринятой эры (501–9999 гг.)', () => {
        expect(formatAstronomicalYear(501)).toBe('501');
        expect(formatAstronomicalYear(1000)).toBe('1000');
        expect(formatAstronomicalYear(1999)).toBe('1999');
        expect(formatAstronomicalYear(2026)).toBe('2026');
    });

    it('формирует компактные метки тысячелетий до нашей эры без дробных хвостов', () => {
        // Астрономический год -999 соответствует историческому 1000 году до н. э.
        const label1k = formatAstronomicalYear(-999, 'millennium');
        expect(label1k).toBe('1 тыс. лет до н. э.');
        expect(label1k).not.toContain('.0');
        expect(label1k).not.toContain(',0');

        // Астрономический год -9999 соответствует 10 000 годам до н. э.
        const label10k = formatAstronomicalYear(-9999);
        expect(label10k).toBe('10 тыс. лет до н. э.');
        expect(label10k).not.toContain('.0');
        expect(label10k).not.toContain(',0');
    });

    it('формирует компактные метки миллионов лет до нашей эры без дробных хвостов', () => {
        // Астрономический год -999999 соответствует 1 000 000 лет до н. э.
        const label1m = formatAstronomicalYear(-999999, 'millennium_large');
        expect(label1m).toBe('1 млн лет до н. э.');
        expect(label1m).not.toContain('.0');
        expect(label1m).not.toContain(',0');
    });

    it('формирует компактные метки тысяч и миллионов лет нашей эры', () => {
        expect(formatAstronomicalYear(10000)).toBe('10 тыс. лет н. э.');
        expect(formatAstronomicalYear(1000000)).toBe('1 млн лет н. э.');
    });
});

describe('formatTickLabel', () => {
    it('корректно форматирует базовые внутрисуточные единицы (секунды, минуты, часы)', () => {
        const ts = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });

        // Секундный уровень: HH:MM:SS
        expect(formatTickLabel(ts, 'second', 1)).toBe('14:30:15');

        // Минутный уровень: HH:MM
        expect(formatTickLabel(ts, 'minute', 1)).toBe('14:30');

        // Часовой уровень в течение дня: HH:MM
        expect(formatTickLabel(ts, 'hour', 1)).toBe('14:30');

        // Часовой уровень в полночь (00:00:00): отображается число и краткий месяц
        const tsMidnight = civilToTimestamp({
            year: 2024,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsMidnight, 'hour', 1)).toBe('1 янв');
    });

    it('корректно форматирует календарные дни и месяцы', () => {
        const tsFirstDay = civilToTimestamp({
            year: 2024,
            month: 3,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        const tsMidDay = civilToTimestamp({
            year: 2024,
            month: 3,
            day: 15,
            hour: 0,
            minute: 0,
            second: 0,
        });

        // Первое число месяца для шкалы дней включает месяц и год
        expect(formatTickLabel(tsFirstDay, 'day', 1)).toBe('мар 2024');

        // Рядовое число месяца отображает день и месяц
        expect(formatTickLabel(tsMidDay, 'day', 1)).toBe('15 мар');

        // Месячный уровень
        expect(formatTickLabel(tsFirstDay, 'month', 1)).toBe('мар 2024');
    });

    it('явно обрабатывает макро-единицы (decade, century, millennium) с учетом множителя шага', () => {
        // Десятилетия со stepCount = 1 (шаг 10 лет)
        const tsDecade = civilToTimestamp({
            year: 1980,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsDecade, 'decade', 1)).toBe('1980');

        // Столетия со stepCount = 1 (шаг 100 лет)
        const tsCenturyBce = civilToTimestamp({
            year: -499,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsCenturyBce, 'century', 1)).toBe('500 до н. э.');

        // Тысячелетия со stepCount = 1 (шаг 1000 лет) -> компактный масштаб millennium
        const tsMillennium1k = civilToTimestamp({
            year: -999,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsMillennium1k, 'millennium', 1)).toBe('1 тыс. лет до н. э.');

        // Тысячелетия со stepCount = 10 (шаг 10 000 лет)
        const tsMillennium10k = civilToTimestamp({
            year: -9999,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsMillennium10k, 'millennium', 10)).toBe('10 тыс. лет до н. э.');

        // Тысячелетия со stepCount = 100 (шаг 100 000 лет) -> масштаб millennium_large
        const tsMillennium100k = civilToTimestamp({
            year: -99999,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsMillennium100k, 'millennium', 100)).toBe('100 тыс. лет до н. э.');

        // Глубокое время: 1 млн лет до н. э. со stepCount = 500
        const tsMillennium1m = civilToTimestamp({
            year: -999999,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatTickLabel(tsMillennium1m, 'millennium', 500)).toBe('1 млн лет до н. э.');
    });
});

describe('formatScaleLevelName', () => {
    it('возвращает корректные наименования для базовых временных единиц', () => {
        expect(formatScaleLevelName('second', 1)).toBe('Секунды');
        expect(formatScaleLevelName('second', 5)).toBe('5 сек.');
        expect(formatScaleLevelName('minute', 1)).toBe('Минуты');
        expect(formatScaleLevelName('minute', 15)).toBe('15 мин.');
        expect(formatScaleLevelName('hour', 1)).toBe('Часы');
        expect(formatScaleLevelName('hour', 6)).toBe('6 ч.');
        expect(formatScaleLevelName('day', 1)).toBe('Дни');
        expect(formatScaleLevelName('day', 7)).toBe('Недели');
        expect(formatScaleLevelName('month', 1)).toBe('Месяцы');
        expect(formatScaleLevelName('year', 1)).toBe('Годы');
    });

    it('возвращает русскоязычные наименования для макро-единиц шкалы', () => {
        expect(formatScaleLevelName('decade', 1)).toBe('Десятилетия');
        expect(formatScaleLevelName('decade', 5)).toBe('50 лет');
        expect(formatScaleLevelName('century', 1)).toBe('Века');
        expect(formatScaleLevelName('century', 5)).toBe('5 в.');
        expect(formatScaleLevelName('millennium', 1)).toBe('Тысячелетия');
        expect(formatScaleLevelName('millennium', 10)).toBe('10 тыс. лет');
        expect(formatScaleLevelName('millennium', 100)).toBe('100 тыс. лет');
        expect(formatScaleLevelName('millennium', 500)).toBe('500 тыс. лет');
        expect(formatScaleLevelName('millennium', 1000)).toBe('1 млн лет');
    });

    it('гарантирует корректную русскую локализацию для всех 23 уровней TICK_LADDER', () => {
        expect(TICK_LADDER.length).toBeGreaterThanOrEqual(23);

        for (const level of TICK_LADDER) {
            const name = formatScaleLevelName(level.unit, level.step);

            // Имя обязано быть непустой строкой
            expect(typeof name).toBe('string');
            expect(name.length).toBeGreaterThan(0);

            // Имя не должно совпадать с сырым английским идентификатором единицы
            expect(name).not.toBe(level.unit);

            // Имя обязано содержать кириллические символы
            expect(/[а-яА-ЯёЁ]/.test(name)).toBe(true);
        }
    });
});

describe('formatContextInterval and padZero', () => {
    it('корректно форматирует интервалы видимого диапазона с разделителем тире', () => {
        // 1. Многолетний диапазон (>= 2 лет)
        const startYear = civilToTimestamp({ year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const endYear = civilToTimestamp({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(formatContextInterval(startYear, endYear)).toBe('1900 — 2000');

        // 2. Месячный диапазон (от 1 месяца до 2 лет)
        const startMonth = civilToTimestamp({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const endMonth = civilToTimestamp({ year: 2024, month: 6, day: 1, hour: 0, minute: 0, second: 0 });
        expect(formatContextInterval(startMonth, endMonth)).toBe('янв 2024 — июн 2024');

        // 3. Суточный диапазон (от 1 суток до месяца)
        const startDay = civilToTimestamp({ year: 2024, month: 5, day: 1, hour: 0, minute: 0, second: 0 });
        const endDay = civilToTimestamp({ year: 2024, month: 5, day: 10, hour: 0, minute: 0, second: 0 });
        expect(formatContextInterval(startDay, endDay)).toBe('1 май 2024 — 10 май 2024');

        // 4. Внутрисуточный диапазон (часы, минуты)
        const startHour = civilToTimestamp({ year: 2024, month: 5, day: 1, hour: 10, minute: 0, second: 0 });
        const endHour = civilToTimestamp({ year: 2024, month: 5, day: 1, hour: 14, minute: 30, second: 0 });
        expect(formatContextInterval(startHour, endHour)).toBe('1 май 2024 10:00 — 1 май 2024 14:30');
    });

    it('дополняет числовые значения нулями до заданной длины в padZero', () => {
        expect(padZero(5)).toBe('05');
        expect(padZero(12)).toBe('12');
        expect(padZero(7, 3)).toBe('007');
        expect(padZero(1234, 2)).toBe('1234');
    });
});

describe('formatEventDate', () => {
    it('форматирует дату события с точностью до года для рангов century, decade, year', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });

        // Наша эра
        expect(formatEventDate(ts2024May15, 'century')).toBe('2024');
        expect(formatEventDate(ts2024May15, 'decade')).toBe('2024');
        expect(formatEventDate(ts2024May15, 'year')).toBe('2024');

        // До нашей эры (-43 астрономический год соответствует 44 году до н. э.)
        const tsBce = civilToTimestamp({
            year: -43,
            month: 3,
            day: 15,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatEventDate(tsBce, 'century')).toBe('44 до н. э.');
        expect(formatEventDate(tsBce, 'decade')).toBe('44 до н. э.');
        expect(formatEventDate(tsBce, 'year')).toBe('44 до н. э.');
    });

    it('форматирует дату события с точностью до месяца для ранга month', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });
        expect(formatEventDate(ts2024May15, 'month')).toBe('май 2024');

        const tsBce = civilToTimestamp({
            year: -43,
            month: 3,
            day: 15,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatEventDate(tsBce, 'month')).toBe('мар 44 до н. э.');
    });

    it('форматирует дату события с точностью до дня для ранга day', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });
        expect(formatEventDate(ts2024May15, 'day')).toBe('15 май 2024');

        const tsJan1 = civilToTimestamp({
            year: 2024,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatEventDate(tsJan1, 'day')).toBe('1 янв 2024');

        const tsBce = civilToTimestamp({
            year: -43,
            month: 3,
            day: 15,
            hour: 0,
            minute: 0,
            second: 0,
        });
        expect(formatEventDate(tsBce, 'day')).toBe('15 мар 44 до н. э.');
    });

    it('форматирует дату события с точностью до минут для рангов hour и minute', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });
        expect(formatEventDate(ts2024May15, 'hour')).toBe('15 май 2024 14:30');
        expect(formatEventDate(ts2024May15, 'minute')).toBe('15 май 2024 14:30');

        // Проверка лидирующих нулей в часах и минутах
        const tsLeadingZeros = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 5,
            hour: 4,
            minute: 5,
            second: 9,
        });
        expect(formatEventDate(tsLeadingZeros, 'hour')).toBe('5 май 2024 04:05');
        expect(formatEventDate(tsLeadingZeros, 'minute')).toBe('5 май 2024 04:05');
    });

    it('форматирует дату события с точностью до секунд для ранга second', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });
        expect(formatEventDate(ts2024May15, 'second')).toBe('15 май 2024 14:30:15');

        // Проверка лидирующих нулей в часах, минутах и секундах
        const tsLeadingZeros = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 5,
            hour: 4,
            minute: 5,
            second: 9,
        });
        expect(formatEventDate(tsLeadingZeros, 'second')).toBe('5 май 2024 04:05:09');
    });

    it('применяет форматирование суточного уровня по умолчанию при неизвестном или некорректном ранге', () => {
        const ts2024May15 = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });
        expect(formatEventDate(ts2024May15, 'unknown_rank')).toBe('15 май 2024');
        expect(formatEventDate(ts2024May15, null)).toBe('15 май 2024');
        expect(formatEventDate(ts2024May15, undefined)).toBe('15 май 2024');
        expect(formatEventDate(ts2024May15, '')).toBe('15 май 2024');
    });

    it('возвращает пустую строку при невалидной временной метке', () => {
        expect(formatEventDate(NaN, 'day')).toBe('');
        expect(formatEventDate('invalid', 'day')).toBe('');
        expect(formatEventDate(null, 'day')).toBe('');
        expect(formatEventDate(undefined, 'day')).toBe('');
    });
});

describe('formatEventDateRange', () => {
    it('возвращает одиночную дату начала для точечных событий без конечной даты', () => {
        const tsStart = civilToTimestamp({
            year: 2024,
            month: 5,
            day: 15,
            hour: 14,
            minute: 30,
            second: 15,
        });

        // Отсутствие endTimestamp (null или undefined)
        expect(formatEventDateRange(tsStart, null, 'year')).toBe('2024');
        expect(formatEventDateRange(tsStart, undefined, 'day')).toBe('15 май 2024');

        // Конечная дата меньше либо равна начальной
        expect(formatEventDateRange(tsStart, tsStart - 100, 'hour')).toBe('15 май 2024 14:30');
        expect(formatEventDateRange(tsStart, tsStart, 'hour')).toBe('15 май 2024 14:30');
    });

    it('схлопывает диапазон в одиночную дату, если строковые представления совпадают при выбранной точности', () => {
        // Событие началось 15 мая 2024 в 10:00 и закончилось 15 мая 2024 в 18:00
        const ts10 = civilToTimestamp({ year: 2024, month: 5, day: 15, hour: 10, minute: 0, second: 0 });
        const ts18 = civilToTimestamp({ year: 2024, month: 5, day: 15, hour: 18, minute: 0, second: 0 });

        // При ранге day даты совпадают -> схлопывание в одну дату
        expect(formatEventDateRange(ts10, ts18, 'day')).toBe('15 май 2024');

        // Для ранга year диапазон внутри одного года схлопывается в число года
        const ts1945Jan1 = civilToTimestamp({ year: 1945, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const ts1945May9 = civilToTimestamp({ year: 1945, month: 5, day: 9, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(ts1945Jan1, ts1945May9, 'year')).toBe('1945');

        // При ранге hour для того же события выводится полноценный диапазон
        expect(formatEventDateRange(ts10, ts18, 'hour')).toBe(
            '15 май 2024 10:00 — 15 май 2024 18:00'
        );
    });

    it('корректно форматирует полноценный диапазон дат нашей эры', () => {
        const ts1914 = civilToTimestamp({ year: 1914, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const ts1918 = civilToTimestamp({ year: 1918, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(ts1914, ts1918, 'year')).toBe('1914 — 1918');

        const tsJan1 = civilToTimestamp({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const tsJan10 = civilToTimestamp({ year: 2024, month: 1, day: 10, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(tsJan1, tsJan10, 'day')).toBe('1 янв 2024 — 10 янв 2024');
    });

    it('корректно форматирует диапазон дат до нашей эры и переход через нулевой год', () => {
        // Даты до нашей эры: -499 (500 до н. э.) по -439 (440 до н. э.)
        const ts500bce = civilToTimestamp({ year: -499, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const ts440bce = civilToTimestamp({ year: -439, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(ts500bce, ts440bce, 'year')).toBe('500 до н. э. — 440 до н. э.');

        // Переход через нулевой год: -43 (44 до н. э.) по 14 (14 н. э.)
        const ts44bce = civilToTimestamp({ year: -43, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const ts14ce = civilToTimestamp({ year: 14, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(ts44bce, ts14ce, 'year')).toBe('44 до н. э. — 14 н. э.');
    });

    it('форматирует границы диапазона по суточному правилу при неизвестном ранге', () => {
        const tsJan1 = civilToTimestamp({ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        const tsJan10 = civilToTimestamp({ year: 2024, month: 1, day: 10, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(tsJan1, tsJan10, 'custom')).toBe('1 янв 2024 — 10 янв 2024');
    });

    it('возвращает пустую строку при невалидной начальной метке времени', () => {
        const tsJan10 = civilToTimestamp({ year: 2024, month: 1, day: 10, hour: 0, minute: 0, second: 0 });
        expect(formatEventDateRange(null, tsJan10, 'day')).toBe('');
        expect(formatEventDateRange(NaN, tsJan10, 'day')).toBe('');
        expect(formatEventDateRange('invalid', tsJan10, 'day')).toBe('');
    });
});
