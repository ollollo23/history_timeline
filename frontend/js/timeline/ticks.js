/**
 * Генератор делений временной шкалы (Ticks Generator) для интерактивного таймлайна.
 * Обеспечивает адаптивный расчет экранных позиций делений, флагов мажорности,
 * шагов и коэффициентов прозрачности на основе целевой плотности пикселей.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ И ДУАЛЬНАЯ КАЛЕНДАРНАЯ ШКАЛА:
 * 1. Дуальная хронологическая модель (до н.э. / н.э.):
 *    В астрономической системе счисления времени (стандарт ISO-8601 и proleptic Gregorian)
 *    присутствует нулевой год: 1 год н.э. соответствует +1, 1 год до н.э. соответствует 0,
 *    а 1000 год до н.э. соответствует астрономическому году -999[cite: 23].
 *    Для civil.year <= 0 расчет ведется по историческому году до н.э. (bceYear = 1 - civil.year),
 *    обеспечивая привязку к круглым историческим датам (1000, 10000, 1000000 лет до н.э.)[cite: 23].
 * 2. Динамический выбор уровня: шаг сетки рассчитывается из целевых расстояний
 *    TARGET_MINOR_TICK_SPACING_PX (90px) и TARGET_MAJOR_TICK_SPACING_PX (220px)[cite: 17, 23].
 * 3. Динамическая непрозрачность перехода (fade-in): порог minStepPx рассчитывается
 *    из отношения шагов соседних уровней TICK_LADDER, исключая жестко заданные константы[cite: 17].
 * 4. Ликвидация частичной отрисовки: при превышении потолка экранных делений
 *    алгоритм поднимается на следующий уровень лестницы и перегенерирует сетку целиком[cite: 23].
 * 5. Буфер упреждения: все метки формируются с запасом в диапазоне [-100, widthPx + 100] px[cite: 23].
 * 6. Контекст шага: каждое деление содержит поле step для компактного форматирования дат[cite: 23].
 */

import {
    TICK_LADDER,
    TARGET_MINOR_TICK_SPACING_PX,
    TARGET_MAJOR_TICK_SPACING_PX,
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
    MAX_TICKS_STANDARD_SCREEN,
    MAX_TICKS_WIDE_SCREEN,
} from './constants.js';
import {
    zoomIndexToSecondsPerPixel,
    timestampToScreenX,
} from './scale.js';
import {
    startOf,
    addCalendarUnits,
    timestampToCivil,
} from './calendar.js';

/**
 * Приближенная длительность календарных единиц в секундах
 * для математической оценки плотности сетки на экране.
 */
const APPROX_UNIT_SECONDS = Object.freeze({
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    month: 2592000, // 30 суток
    year: 31557600, // 365.25 суток
    decade: 315576000,
    century: 3155760000,
    millennium: 31557600000,
});

/**
 * Определение принадлежности деления крупному шагу сетки (Major Tick).
 *
 * МАТЕМАТИЧЕСКОЕ ОБОСНОВАНИЕ ДУАЛЬНОЙ ПРОВЕРКИ:
 * Для единиц от года до тысячелетия в дохристианской части шкалы (civil.year <= 0)
 * проверка кратности обязана выполняться по историческому году до н.э. (1 - civil.year),
 * так как астрономический год -5000 соответствует 5001 году до н.э.[cite: 23]
 * Историческая мажорность обеспечивает круглые подписи (500, 1000, 5000, 1000000 лет до н.э.)[cite: 23].
 *
 * @param {{year: number, month: number, day: number, hour: number, minute: number, second: number}} civil
 * @param {Object} level Уровень лестницы TICK_LADDER.
 * @returns {boolean} True, если метка кратна крупному шагу majorStep.
 */
function checkIsMajor(civil, level) {
    const { unit, majorStep } = level;

    if (unit === 'second') {
        return civil.second % majorStep === 0;
    }
    if (unit === 'minute') {
        return civil.second === 0 && civil.minute % majorStep === 0;
    }
    if (unit === 'hour') {
        return civil.second === 0 && civil.minute === 0 && civil.hour % majorStep === 0;
    }
    if (unit === 'day') {
        return civil.second === 0 && civil.minute === 0 && civil.hour === 0 && (civil.day - 1) % majorStep === 0;
    }
    if (unit === 'month') {
        return (
            civil.second === 0 &&
            civil.minute === 0 &&
            civil.hour === 0 &&
            civil.day === 1 &&
            (civil.month - 1) % majorStep === 0
        );
    }

    // Для годовых диапазонов проверяем строгое начало года (01 января, 00:00:00)
    if (unit === 'year' || unit === 'decade' || unit === 'century' || unit === 'millennium') {
        const isYearStart =
            civil.second === 0 &&
            civil.minute === 0 &&
            civil.hour === 0 &&
            civil.day === 1 &&
            civil.month === 1;

        if (!isYearStart) {
            return false;
        }

        // Вычисление периода мажорности в годах
        let spanYears = majorStep;
        if (unit === 'decade') {
            spanYears = majorStep * 10;
        } else if (unit === 'century') {
            spanYears = majorStep * 100;
        } else if (unit === 'millennium') {
            spanYears = majorStep * 1000;
        }

        // Ветвление: наша эра (civil.year > 0)
        if (civil.year > 0) {
            return civil.year % spanYears === 0;
        }

        // Ветвление: до нашей эры (civil.year <= 0) по историческому году
        const bceYear = 1 - civil.year;
        return bceYear % spanYears === 0;
    }

    return false;
}

/**
 * Выравнивание начальной временной метки интервала под кратность шага мелкой сетки.
 *
 * МАТЕМАТИЧЕСКОЕ ОБОСНОВАНИЕ ВЫРАВНИВАНИЯ ДО Н.Э.:
 * Временная ось генерируется слева направо (от прошлого к будущему)[cite: 23]. Чтобы охватить
 * startTime, начальная точка обязана быть сдвинута назад во времени (в сторону большего
 * исторического года до н.э.)[cite: 23]. Для civil.year <= 0 вычисляется исторический год
 * bceYear = 1 - civil.year, а шаг назад находится через дополнение остатка до полного шага:
 * rem = (stepYears - (bceYear % stepYears)) % stepYears[cite: 23].
 *
 * @param {number} startTime Начало временного диапазона в секундах.
 * @param {Object} level Уровень лестницы TICK_LADDER.
 * @returns {number} Выровненная временная метка.
 */
function alignStartTimestamp(startTime, level) {
    const { unit, step } = level;
    let current = startOf(startTime, unit);
    const civil = timestampToCivil(current);

    if (unit === 'second' || unit === 'minute') {
        const val = unit === 'second' ? civil.second : civil.minute;
        const rem = val % step;
        if (rem !== 0) {
            current = addCalendarUnits(current, -rem, unit);
        }
    } else if (unit === 'hour') {
        const rem = civil.hour % step;
        if (rem !== 0) {
            current = addCalendarUnits(current, -rem, 'hour');
        }
    } else if (unit === 'day') {
        const rem = (civil.day - 1) % step;
        if (rem !== 0) {
            current = addCalendarUnits(current, -rem, 'day');
        }
    } else if (unit === 'month') {
        const rem = (civil.month - 1) % step;
        if (rem !== 0) {
            current = addCalendarUnits(current, -rem, 'month');
        }
    } else if (unit === 'year' || unit === 'decade' || unit === 'century' || unit === 'millennium') {
        let stepYears = step;
        if (unit === 'decade') {
            stepYears = step * 10;
        } else if (unit === 'century') {
            stepYears = step * 100;
        } else if (unit === 'millennium') {
            stepYears = step * 1000;
        }

        if (civil.year > 0) {
            // Наша эра: стандартное выравнивание назад до ближайшего кратного года
            const rem = civil.year % stepYears;
            if (rem !== 0) {
                current = addCalendarUnits(current, -rem, 'year');
            }
        } else {
            // До нашей эры: выравнивание назад во времени к большему круглому году до н.э.
            const bceYear = 1 - civil.year;
            const rem = (stepYears - (bceYear % stepYears)) % stepYears;
            if (rem !== 0) {
                current = addCalendarUnits(current, -rem, 'year');
            }
        }
    }

    return current;
}

/**
 * Подбор оптимального индекса уровня сетки в массиве TICK_LADDER
 * на основе целевого экранного расстояния между мелкими и крупными делениями.
 *
 * @param {number} spp Текущий масштаб в секундах на пиксель.
 * @returns {number} Индекс выбранного уровня в массиве TICK_LADDER.
 */
function selectOptimalLevelIndex(spp) {
    let levelIndex = TICK_LADDER.length - 1;

    // Первичный подбор: первый уровень с шагом мелких делений >= TARGET_MINOR_TICK_SPACING_PX
    for (let i = 0; i < TICK_LADDER.length; i++) {
        const level = TICK_LADDER[i];
        const stepDuration = level.step * APPROX_UNIT_SECONDS[level.unit];
        const minorSpacingPx = stepDuration / spp;

        if (minorSpacingPx >= TARGET_MINOR_TICK_SPACING_PX) {
            levelIndex = i;
            break;
        }
    }

    // Вторичная проверка: шаг крупных делений обязан быть >= TARGET_MAJOR_TICK_SPACING_PX
    while (levelIndex < TICK_LADDER.length - 1) {
        const level = TICK_LADDER[levelIndex];
        const majorDuration = level.majorStep * APPROX_UNIT_SECONDS[level.unit];
        const majorSpacingPx = majorDuration / spp;

        if (majorSpacingPx < TARGET_MAJOR_TICK_SPACING_PX) {
            levelIndex++;
        } else {
            break;
        }
    }

    return levelIndex;
}

/**
 * Генерация упорядоченного массива делений временной шкалы для текущего состояния области просмотра.
 * Гарантирует сплошное заполнение холста с буфером упреждения без эффекта частичной обрезки.
 *
 * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} viewportState
 * @returns {Array<{ timestamp: number, screenX: number, isMajor: boolean, unit: string, step: number, opacity: number }>}
 */
export function generateTicks(viewportState) {
    const { originTimestamp, zoomIndex, widthPx } = viewportState;
    const spp = zoomIndexToSecondsPerPixel(zoomIndex);

    // Буфер упреждения в 100 пикселей слева и справа исключает клиппинг подписей на границах
    const bufferPx = 100;
    const minScreenX = -bufferPx;
    const maxScreenX = widthPx + bufferPx;

    const rawStartTime = originTimestamp + minScreenX * spp;
    const rawEndTime = originTimestamp + maxScreenX * spp;

    // Ограничение диапазона физическими пределами исторической платформы
    const startTime = Math.max(TIMELINE_MIN_TIMESTAMP, rawStartTime);
    const endTime = Math.min(TIMELINE_MAX_TIMESTAMP, rawEndTime);

    if (startTime >= endTime) {
        return [];
    }

    // Расчет потолка плотности через декларативные константы экрана
    const maxTicks = widthPx <= 1200 ? MAX_TICKS_STANDARD_SCREEN : MAX_TICKS_WIDE_SCREEN;

    let levelIndex = selectOptimalLevelIndex(spp);

    // Внешний цикл адаптации плотности: при переполнении выполняется подъем на более разреженный уровень
    while (levelIndex < TICK_LADDER.length) {
        const level = TICK_LADDER[levelIndex];

        // Длительность текущего шага в секундах
        const currentStepSeconds = level.step * APPROX_UNIT_SECONDS[level.unit];
        const stepPx = currentStepSeconds / spp;

        // Расчет динамического нижнего порога переключения на следующий уровень сетки
        let ratio = 0.5;
        if (levelIndex + 1 < TICK_LADDER.length) {
            const nextLevel = TICK_LADDER[levelIndex + 1];
            const nextStepSeconds = nextLevel.step * APPROX_UNIT_SECONDS[nextLevel.unit];
            ratio = currentStepSeconds / nextStepSeconds;
        }

        const minStepPx = TARGET_MINOR_TICK_SPACING_PX * ratio;
        const delta = TARGET_MINOR_TICK_SPACING_PX - minStepPx;

        // Вычисление нормализованного фактора прогресса в переходной полосе
        let progress;
        if (delta <= 0 || stepPx >= TARGET_MINOR_TICK_SPACING_PX) {
            progress = 1.0;
        } else if (stepPx <= minStepPx) {
            progress = 0.0;
        } else {
            progress = (stepPx - minStepPx) / delta;
        }

        // Итоговая непрозрачность в диапазоне от 0.2 до 1.0
        const minorOpacity = Number((0.2 + 0.8 * progress).toFixed(2));

        const ticks = [];
        let exceededCeiling = false;
        let current = alignStartTimestamp(startTime, level);

        // Внутренний цикл генерации делений с контролем переполнения
        while (current <= endTime) {
            const screenX = timestampToScreenX(current, originTimestamp, spp);

            // Фильтрация меток strictly в границах видимой области плюс буфер упреждения
            if (screenX >= minScreenX && screenX <= maxScreenX) {
                const civil = timestampToCivil(current);
                const isMajor = checkIsMajor(civil, level);

                ticks.push({
                    timestamp: current,
                    screenX,
                    isMajor,
                    unit: level.unit,
                    step: level.step,
                    opacity: isMajor ? 1.0 : minorOpacity,
                });

                // Контроль защитного потолка: предотвращает неполную отрисовку через динамический подъем
                if (ticks.length > maxTicks) {
                    exceededCeiling = true;
                    break;
                }
            }

            const next = addCalendarUnits(current, level.step, level.unit);
            // Защита от бесконечного цикла при переполнении или нулевом шаге
            if (next <= current) {
                break;
            }
            current = next;
        }

        // Если лимит превышен и есть более крупные уровни, пересобираем сетку с увеличенным шагом
        if (exceededCeiling && levelIndex < TICK_LADDER.length - 1) {
            levelIndex++;
            continue;
        }

        return ticks;
    }

    return [];
}
