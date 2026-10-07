/**
 * Модульные тесты компонента часов реального времени (clock.js).
 * Проверяет форматирование даты и времени со смещением часового пояса,
 * расчет задержки до границы секунды с учетом CLOCK_TICK_SAFETY_DELAY_MS,
 * тактовое обновление времени, интеграцию с Page Visibility API,
 * корректность освобождения ресурсов в destroy и изоляцию исключений в onTick.
 */

import { describe, it, expect, vi } from 'vitest';
import { createClock } from '../../frontend/js/components/clock.js';
import { CLOCK_TICK_SAFETY_DELAY_MS } from '../../frontend/js/timeline/constants.js';

/**
 * Создает имитацию DOM-элемента для вывода времени.
 *
 * @returns {{
 *   textContent: string,
 *   title: string,
 *   attributes: Record<string, string>,
 *   setAttribute: (name: string, val: unknown) => void,
 *   getAttribute: (name: string) => string | null
 * }}
 */
function createMockElement() {
    const attributes = {};
    return {
        textContent: '',
        title: '',
        attributes,
        setAttribute(name, val) {
            attributes[name] = String(val);
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name)
                ? attributes[name]
                : null;
        },
    };
}

/**
 * Создает имитацию объекта документа с поддержкой Page Visibility API.
 *
 * @param {string} [initialVisibility='visible'] Начальное состояние видимости вкладки.
 * @returns {{
 *   visibilityState: string,
 *   addEventListener: (event: string, fn: Function) => void,
 *   removeEventListener: (event: string, fn: Function) => void,
 *   triggerVisibilityChange: (nextState: string) => void,
 *   getListenerCount: (event: string) => number
 * }}
 */
function createMockDocument(initialVisibility = 'visible') {
    const listeners = new Map();

    return {
        visibilityState: initialVisibility,
        addEventListener(event, fn) {
            if (!listeners.has(event)) {
                listeners.set(event, new Set());
            }
            listeners.get(event).add(fn);
        },
        removeEventListener(event, fn) {
            if (listeners.has(event)) {
                listeners.get(event).delete(fn);
            }
        },
        triggerVisibilityChange(nextState) {
            this.visibilityState = nextState;
            const fns = listeners.get('visibilitychange');
            if (fns) {
                fns.forEach((fn) => fn());
            }
        },
        getListenerCount(event) {
            return listeners.get(event)?.size ?? 0;
        },
    };
}

describe('Модуль компонента часов clock.js', () => {
    describe('Начальное отображение времени', () => {
        it('выводит начальное форматированное время, атрибут datetime и подсказку title', () => {
            const element = createMockElement();
            const doc = createMockDocument('visible');

            // 1790457303000 мс соответствует 26 сен 2026, 21:15:03 UTC (27 сен 2026, 00:15:03 при UTC+3)
            const clock = createClock(element, {
                now: () => 1790457303000,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: vi.fn(),
                clearTimeoutFn: vi.fn(),
            });

            clock.start();

            expect(element.textContent).toBe('27 сен 2026, 00:15:03 (UTC+03:00)');
            expect(element.getAttribute('datetime')).toBe('2026-09-26T21:15:03.000Z');
            expect(element.title).toBe(
                'UTC: 26 сен 2026, 21:15:03. Подписи шкалы указаны в UTC.'
            );
        });
    });

    describe('Расчет задержки планирования тика', () => {
        it('рассчитывает задержку до границы следующей секунды с запасом безопасности', () => {
            const element = createMockElement();
            const doc = createMockDocument('visible');
            const setTimeoutSpy = vi.fn();

            // 1. Момент в середине секунды (500 мс): до границы остается 500 мс + 20 мс запаса = 520 мс
            let currentMs = 1790457303500;
            const clock1 = createClock(element, {
                now: () => currentMs,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: setTimeoutSpy,
                clearTimeoutFn: vi.fn(),
            });

            clock1.start();
            expect(setTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                500 + CLOCK_TICK_SAFETY_DELAY_MS
            );
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 520);

            setTimeoutSpy.mockClear();

            // 2. Момент точно на границе секунды (0 мс): до следующей секунды 1000 мс + 20 мс = 1020 мс
            currentMs = 1790457303000;
            const clock2 = createClock(element, {
                now: () => currentMs,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: setTimeoutSpy,
                clearTimeoutFn: vi.fn(),
            });

            clock2.start();
            expect(setTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                1000 + CLOCK_TICK_SAFETY_DELAY_MS
            );
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1020);
        });
    });

    describe('Обновление времени после границы секунды', () => {
        it('обновляет текстовое содержимое элемента при наступлении тика', () => {
            const element = createMockElement();
            const doc = createMockDocument('visible');
            let capturedTick = null;

            let currentMs = 1790457303000;
            const clock = createClock(element, {
                now: () => currentMs,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: (fn) => {
                    capturedTick = fn;
                    return 101;
                },
                clearTimeoutFn: vi.fn(),
            });

            clock.start();
            expect(element.textContent).toBe('27 сен 2026, 00:15:03 (UTC+03:00)');
            expect(typeof capturedTick).toBe('function');

            // Переход на следующую секунду
            currentMs = 1790457304000;
            capturedTick();

            expect(element.textContent).toBe('27 сен 2026, 00:15:04 (UTC+03:00)');
            expect(element.getAttribute('datetime')).toBe('2026-09-26T21:15:04.000Z');
        });
    });

    describe('Управление видимостью вкладки (Visibility API)', () => {
        it('останавливает планирование при скрытой вкладке и немедленно обновляет при возврате', () => {
            const element = createMockElement();
            const doc = createMockDocument('hidden');
            const setTimeoutSpy = vi.fn((_fn, _delay) => 42);
            const clearTimeoutSpy = vi.fn();

            let currentMs = 1790457303000;
            const clock = createClock(element, {
                now: () => currentMs,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: setTimeoutSpy,
                clearTimeoutFn: clearTimeoutSpy,
            });

            // 1. Старт в скрытой вкладке: таймер не должен быть запланирован
            clock.start();
            expect(setTimeoutSpy).not.toHaveBeenCalled();

            // 2. Возврат на вкладку: немедленная отрисовка и запуск планирования
            doc.triggerVisibilityChange('visible');
            expect(element.textContent).toBe('27 сен 2026, 00:15:03 (UTC+03:00)');
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

            // 3. Уход с вкладки: активный таймер очищается
            doc.triggerVisibilityChange('hidden');
            expect(clearTimeoutSpy).toHaveBeenCalledWith(42);
        });
    });

    describe('Утилизация и очистка ресурсов (destroy)', () => {
        it('метод destroy останавливает таймер, снимает слушатели и обнуляет ссылки', () => {
            const element = createMockElement();
            const doc = createMockDocument('visible');
            const clearTimeoutSpy = vi.fn();

            const clock = createClock(element, {
                now: () => 1790457303000,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: () => 999,
                clearTimeoutFn: clearTimeoutSpy,
            });

            clock.start();
            expect(doc.getListenerCount('visibilitychange')).toBe(1);

            clock.destroy();
            expect(clearTimeoutSpy).toHaveBeenCalledWith(999);
            expect(doc.getListenerCount('visibilitychange')).toBe(0);

            // Повторный вызов destroy идемпотентен
            expect(() => clock.destroy()).not.toThrow();

            // Повторный вызов start после destroy заблокирован
            const setTimeoutSpy = vi.fn();
            clock.start();
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        });
    });

    describe('Уведомление подписчика onTick и изоляция ошибок', () => {
        it('onTick получает текущую временную метку, а исключение в нем не прерывает работу часов', () => {
            const element = createMockElement();
            const doc = createMockDocument('visible');
            const setTimeoutSpy = vi.fn();
            const onTickSpy = vi.fn(() => {
                throw new Error('Сбой в подписчике');
            });

            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const clock = createClock(element, {
                now: () => 1790457303000,
                getTimezoneOffset: () => -180,
                documentRef: doc,
                setTimeoutFn: setTimeoutSpy,
                clearTimeoutFn: vi.fn(),
                onTick: onTickSpy,
            });

            clock.start();

            expect(onTickSpy).toHaveBeenCalledWith(1790457303000);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                'Ошибка в обработчике onTick часов:',
                expect.any(Error)
            );
            // Таймер успешно запланирован, несмотря на выброс ошибки в колбэке
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

            consoleWarnSpy.mockRestore();
        });
    });
});
