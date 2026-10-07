/**
 * Модуль компонента отображения реального времени и смещения часового пояса.
 * Обеспечивает синхронизацию часов тулбара с местным временем пользователя
 * и шкалой UTC с поддержкой энергосбережения при скрытии вкладки.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Инверсия зависимостей (DI): функции таймеров, времени и объект документа
 *    передаются через опции, обеспечивая 100% изоляцию в тестах Node.js.
 * 2. Синхронизация по границе секунды: расчет задержки планирует вызов
 *    строго на начало следующей секунды с запасом CLOCK_TICK_SAFETY_DELAY_MS.
 * 3. Энергосбережение: при visibilityState === 'hidden' таймер останавливается,
 *    а при возврате фокуса немедленно отрисовывает актуальное время.
 * 4. Безопасность подписчиков: ошибки в переданном колбэке onTick изолируются
 *    блоком try...catch и не прерывают работу внутренних часов.
 */

import { CLOCK_TICK_SAFETY_DELAY_MS } from '../timeline/constants.js';
import {
    formatClockDateTime,
    formatUtcOffset,
} from '../timeline/format.js';

/**
 * Фабрика создания автономного компонента часов.
 *
 * @param {HTMLElement|null} timeElement DOM-элемент time для вывода времени.
 * @param {{
 *   now?: () => number,
 *   getTimezoneOffset?: (epochMs: number) => number,
 *   setTimeoutFn?: (fn: Function, delay: number) => number | any,
 *   clearTimeoutFn?: (id: number | any) => void,
 *   documentRef?: Document | { visibilityState: string, addEventListener?: Function, removeEventListener?: Function } | null,
 *   onTick?: ((nowMs: number) => void) | null
 * }} [options={}] Опции конфигурации и внедрения зависимостей.
 * @returns {{
 *   start: () => void,
 *   stop: () => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления часами.
 */
export function createClock(timeElement, options = {}) {
    // Внедрение зависимостей с безопасными системными значениями по умолчанию
    const now = typeof options.now === 'function'
        ? options.now
        : () => Date.now();

    const getTimezoneOffset = typeof options.getTimezoneOffset === 'function'
        ? options.getTimezoneOffset
        : (ms) => new Date(ms).getTimezoneOffset();

    const setTimeoutFn = typeof options.setTimeoutFn === 'function'
        ? options.setTimeoutFn
        : (fn, delay) => setTimeout(fn, delay);

    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function'
        ? options.clearTimeoutFn
        : (id) => clearTimeout(id);

    const documentRef = options.documentRef !== undefined
        ? options.documentRef
        : (typeof document !== 'undefined' ? document : null);

    const onTick = typeof options.onTick === 'function'
        ? options.onTick
        : null;

    // Внутреннее состояние жизненного цикла компонента
    let targetElement = timeElement;
    let isRunning = false;
    let timerId = null;
    let isDestroyed = false;

    /**
     * Выполняет форматирование времени, обновление DOM-элемента и вызов подписчика.
     *
     * @returns {number} Временная метка текущего тика в миллисекундах.
     */
    function render() {
        const currentMs = now();
        const offsetMin = getTimezoneOffset(currentMs);

        const localDateStr = formatClockDateTime(currentMs, offsetMin);
        const offsetStr = formatUtcOffset(offsetMin);
        const utcDateStr = formatClockDateTime(currentMs, 0);
        const isoStr = new Date(currentMs).toISOString();

        if (targetElement) {
            targetElement.textContent = localDateStr + ' (' + offsetStr + ')';
            targetElement.setAttribute('datetime', isoStr);
            targetElement.title = 'UTC: ' + utcDateStr + '. Подписи шкалы указаны в UTC.';
        }

        if (typeof onTick === 'function') {
            try {
                onTick(currentMs);
            } catch (err) {
                console.warn('Ошибка в обработчике onTick часов:', err);
            }
        }

        return currentMs;
    }

    /**
     * Планирует следующий запуск таймера с привязкой к границе секунды.
     *
     * @param {number} currentMs Метка времени последней отрисовки.
     */
    function scheduleNextTick(currentMs) {
        if (!isRunning || isDestroyed) {
            return;
        }

        if (documentRef && documentRef.visibilityState === 'hidden') {
            return;
        }

        const msUntilNextSecond = 1000 - (currentMs % 1000);
        const delay = msUntilNextSecond + CLOCK_TICK_SAFETY_DELAY_MS;

        timerId = setTimeoutFn(tick, delay);
    }

    /**
     * Обработчик тактового срабатывания таймера.
     */
    function tick() {
        timerId = null;

        if (!isRunning || isDestroyed) {
            return;
        }

        const currentMs = render();
        scheduleNextTick(currentMs);
    }

    /**
     * Обработчик событий Page Visibility API для управления фоновым режимом.
     */
    function handleVisibilityChange() {
        if (!isRunning || isDestroyed || !documentRef) {
            return;
        }

        if (documentRef.visibilityState === 'hidden') {
            // Остановка таймера при скрытии вкладки для экономии ресурсов
            if (timerId !== null) {
                clearTimeoutFn(timerId);
                timerId = null;
            }
        } else {
            // Немедленная актуализация и перезапуск цикла при возврате фокуса
            if (timerId !== null) {
                clearTimeoutFn(timerId);
                timerId = null;
            }
            const currentMs = render();
            scheduleNextTick(currentMs);
        }
    }

    /**
     * Запуск работы часов и цикла тактовых обновлений.
     * Метод идемпотентен: повторные вызовы не создают дополнительных таймеров.
     */
    function start() {
        if (isRunning || isDestroyed) {
            return;
        }

        isRunning = true;

        if (documentRef && typeof documentRef.addEventListener === 'function') {
            documentRef.addEventListener('visibilitychange', handleVisibilityChange);
        }

        if (documentRef && documentRef.visibilityState === 'hidden') {
            return;
        }

        const currentMs = render();
        scheduleNextTick(currentMs);
    }

    /**
     * Приостановка работы часов и очистка активного таймера.
     */
    function stop() {
        if (!isRunning) {
            return;
        }

        isRunning = false;

        if (timerId !== null) {
            clearTimeoutFn(timerId);
            timerId = null;
        }
    }

    /**
     * Полная утилизация компонента, снятие слушателей и очистка ссылок.
     */
    function destroy() {
        if (isDestroyed) {
            return;
        }

        stop();
        isDestroyed = true;

        if (documentRef && typeof documentRef.removeEventListener === 'function') {
            documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
        }

        targetElement = null;
    }

    return {
        start,
        stop,
        destroy,
    };
}
