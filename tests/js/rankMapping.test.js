/**
 * Модульные тесты соответствия календарных единиц сетки и рангов детализации событий.
 * Проверяет упорядоченный список рангов EVENT_RANKS_ORDERED, функции unitToRank,
 * getRanksForUnit и предикат сравнения наборов areRankSetsEqual во фреймворке Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
    EVENT_RANKS_ORDERED,
    unitToRank,
    getRanksForUnit,
    areRankSetsEqual,
} from '../../frontend/js/timeline/rankMapping.js';

describe('rankMapping module', () => {
    describe('Константа EVENT_RANKS_ORDERED', () => {
        it('содержит ровно 8 уровней детализации', () => {
            expect(EVENT_RANKS_ORDERED).toHaveLength(8);
        });

        it('строго соблюдает порядок следования от крупного к мелкому', () => {
            const expectedOrder = [
                'century',
                'decade',
                'year',
                'month',
                'day',
                'hour',
                'minute',
                'second',
            ];
            expect(EVENT_RANKS_ORDERED).toEqual(expectedOrder);
        });

        it('является глубоко замороженным массивом', () => {
            expect(Object.isFrozen(EVENT_RANKS_ORDERED)).toBe(true);
        });
    });

    describe('Функция unitToRank', () => {
        it('корректно проецирует стандартные единицы лестницы делений в одноименные ранги', () => {
            expect(unitToRank('second')).toBe('second');
            expect(unitToRank('minute')).toBe('minute');
            expect(unitToRank('hour')).toBe('hour');
            expect(unitToRank('day')).toBe('day');
            expect(unitToRank('month')).toBe('month');
            expect(unitToRank('year')).toBe('year');
            expect(unitToRank('decade')).toBe('decade');
            expect(unitToRank('century')).toBe('century');
        });

        it('отображает макроединицу millennium в предельный доменный ранг century', () => {
            expect(unitToRank('millennium')).toBe('century');
        });

        it('нечувствительна к регистру символов и краевым пробелам', () => {
            expect(unitToRank('  YEAR  ')).toBe('year');
            expect(unitToRank('Century')).toBe('century');
            expect(unitToRank('MILLENNIUM')).toBe('century');
        });

        it('возвращает null для неизвестных строковых единиц', () => {
            expect(unitToRank('invalid_unit')).toBeNull();
            expect(unitToRank('week')).toBeNull();
            expect(unitToRank('epoch')).toBeNull();
            expect(unitToRank('')).toBeNull();
        });

        it('возвращает null для нестроковых и пустых типов данных', () => {
            expect(unitToRank(null)).toBeNull();
            expect(unitToRank(undefined)).toBeNull();
            expect(unitToRank(123)).toBeNull();
            expect(unitToRank({})).toBeNull();
            expect(unitToRank([])).toBeNull();
        });
    });

    describe('Функция getRanksForUnit', () => {
        it('для масштабов century и millennium возвращает только ранг century', () => {
            expect(getRanksForUnit('century')).toEqual(['century']);
            expect(getRanksForUnit('millennium')).toEqual(['century']);
        });

        it('для масштаба decade возвращает century и decade', () => {
            expect(getRanksForUnit('decade')).toEqual(['century', 'decade']);
        });

        it('для масштаба year возвращает century, decade и year', () => {
            expect(getRanksForUnit('year')).toEqual(['century', 'decade', 'year']);
        });

        it('для промежуточных масштабов возвращает ожидаемые кумулятивные срезы', () => {
            expect(getRanksForUnit('month')).toEqual([
                'century',
                'decade',
                'year',
                'month',
            ]);
            expect(getRanksForUnit('day')).toEqual([
                'century',
                'decade',
                'year',
                'month',
                'day',
            ]);
            expect(getRanksForUnit('hour')).toEqual([
                'century',
                'decade',
                'year',
                'month',
                'day',
                'hour',
            ]);
            expect(getRanksForUnit('minute')).toEqual([
                'century',
                'decade',
                'year',
                'month',
                'day',
                'hour',
                'minute',
            ]);
        });

        it('для секундного масштаба возвращает полный набор из всех 8 рангов', () => {
            expect(getRanksForUnit('second')).toEqual([...EVENT_RANKS_ORDERED]);
        });

        it('при неизвестной или пустой единице возвращает защитную копию всех рангов во избежание потери данных', () => {
            expect(getRanksForUnit('unknown')).toEqual([...EVENT_RANKS_ORDERED]);
            expect(getRanksForUnit('')).toEqual([...EVENT_RANKS_ORDERED]);
            expect(getRanksForUnit(null)).toEqual([...EVENT_RANKS_ORDERED]);
            expect(getRanksForUnit(undefined)).toEqual([...EVENT_RANKS_ORDERED]);
            expect(getRanksForUnit(42)).toEqual([...EVENT_RANKS_ORDERED]);
        });

        it('всегда возвращает новый массив, сохраняя иммутабельность константы', () => {
            const result = getRanksForUnit('unknown');
            expect(result).toEqual([...EVENT_RANKS_ORDERED]);
            expect(result).not.toBe(EVENT_RANKS_ORDERED);
        });
    });

    describe('Функция areRankSetsEqual', () => {
        it('возвращает true при идентичных ссылках на массивы', () => {
            const ranks = ['century', 'year'];
            expect(areRankSetsEqual(ranks, ranks)).toBe(true);
        });

        it('возвращает true для одинаковых наборов с идентичным порядком', () => {
            expect(areRankSetsEqual(['century', 'year'], ['century', 'year'])).toBe(true);
        });

        it('возвращает true для одинаковых наборов независимо от порядка следования элементов', () => {
            expect(areRankSetsEqual(['year', 'century'], ['century', 'year'])).toBe(true);
            expect(
                areRankSetsEqual(
                    ['second', 'hour', 'day'],
                    ['day', 'second', 'hour']
                )
            ).toBe(true);
        });

        it('игнорирует дубликаты элементов внутри наборов', () => {
            expect(
                areRankSetsEqual(
                    ['year', 'year', 'century'],
                    ['century', 'year']
                )
            ).toBe(true);
            expect(
                areRankSetsEqual(
                    ['decade'],
                    ['decade', 'decade', 'decade']
                )
            ).toBe(true);
        });

        it('возвращает false при различии в составе элементов', () => {
            expect(areRankSetsEqual(['century'], ['century', 'year'])).toBe(false);
            expect(areRankSetsEqual(['century', 'decade'], ['century', 'year'])).toBe(false);
            expect(areRankSetsEqual(['year'], ['month'])).toBe(false);
        });

        it('корректно обрабатывает граничные условия с отсутствующими значениями (null и undefined)', () => {
            expect(areRankSetsEqual(null, null)).toBe(true);
            expect(areRankSetsEqual(undefined, undefined)).toBe(true);
            expect(areRankSetsEqual(null, undefined)).toBe(true);

            expect(areRankSetsEqual(null, ['year'])).toBe(false);
            expect(areRankSetsEqual(['year'], null)).toBe(false);
            expect(areRankSetsEqual(undefined, ['century'])).toBe(false);
            expect(areRankSetsEqual([], null)).toBe(false);
        });

        it('возвращает false, если один из аргументов не является массивом', () => {
            expect(areRankSetsEqual('century', ['century'])).toBe(false);
            expect(areRankSetsEqual(['century'], 'century')).toBe(false);
            expect(areRankSetsEqual(123, 123)).toBe(false);
            expect(areRankSetsEqual({}, [])).toBe(false);
        });
    });
});
