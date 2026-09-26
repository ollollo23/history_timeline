/**
 * Модульные тесты изолированного хранилища состояния выбора (Selection Store).
 * Проверяет идемпотентность выбора, отмену запросов через AbortSignal,
 * защиту от состояния гонки, частичную деградацию сети, обработку постраничных ответов
 * EventChildrenPage, фиксацию таймаутов и очистку ресурсов.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSelectionStore } from '../../frontend/js/timeline/selection.js';

/**
 * Вспомогательная фабрика мокированных зависимостей для тестирования хранилища выбора.
 *
 * @param {Object} [overrides={}] Переопределения функций.
 * @returns {{
 *   fetchEventById: ReturnType<typeof vi.fn>,
 *   fetchChildren: ReturnType<typeof vi.fn>,
 *   onStateChange: ReturnType<typeof vi.fn>
 * }}
 */
function createMockDependencies(overrides = {}) {
    const fetchEventById = vi.fn((eventId, _signal) =>
        Promise.resolve({ id: eventId, title: `Событие ${eventId}` })
    );
    const fetchChildren = vi.fn((_eventId, _skip, _limit, _signal) =>
        Promise.resolve({
            items: [{ id: 101, title: 'Потомок 101' }],
            total: 1,
            skip: 0,
            limit: 100,
        })
    );
    const onStateChange = vi.fn();

    return {
        fetchEventById,
        fetchChildren,
        onStateChange,
        ...overrides,
    };
}

describe('Модуль состояния выбора selection.js', () => {
    it('Сценарий 1: повторный выбор того же идентификатора не порождает повторных запросов', async () => {
        const deps = createMockDependencies();
        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        // Первый выбор события с ID 5
        await store.select(5);
        expect(deps.fetchEventById).toHaveBeenCalledTimes(1);
        expect(deps.fetchChildren).toHaveBeenCalledTimes(1);

        // Повторный выбор того же события с ID 5
        await store.select(5);
        expect(deps.fetchEventById).toHaveBeenCalledTimes(1);
        expect(deps.fetchChildren).toHaveBeenCalledTimes(1);
    });

    it('Сценарий 2: выбор нового идентификатора прерывает предыдущий запрос через AbortSignal', async () => {
        let firstSignal = null;
        const deps = createMockDependencies({
            fetchEventById: vi.fn((eventId, signal) => {
                if (eventId === 1) {
                    firstSignal = signal;
                    return new Promise((resolve) => setTimeout(resolve, 50));
                }
                return Promise.resolve({ id: eventId, title: `Событие ${eventId}` });
            }),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        // Запуск первого медленного запроса и мгновенный запуск второго
        const p1 = store.select(1);
        const p2 = store.select(2);

        await Promise.all([p1, p2]);

        // Сигнал первого запроса должен быть переведен в состояние aborted
        expect(firstSignal).not.toBeNull();
        expect(firstSignal.aborted).toBe(true);
    });

    it('Сценарий 3: ответ с устаревшим счётчиком запросов не изменяет состояние (защита от гонки)', async () => {
        const deps = createMockDependencies({
            fetchEventById: vi.fn((eventId) => {
                // Запрос 1 возвращается медленнее (50 мс), чем запрос 2 (10 мс)
                const delay = eventId === 1 ? 50 : 10;
                return new Promise((resolve) => {
                    setTimeout(() => {
                        resolve({ id: eventId, title: `Событие ${eventId}` });
                    }, delay);
                });
            }),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        const p1 = store.select(1);
        const p2 = store.select(2);

        await Promise.all([p1, p2]);

        // Итоговое состояние должно отражать актуальный второй запрос
        const state = store.getState();
        expect(state.selectedId).toBe(2);
        expect(state.event).not.toBeNull();
        expect(state.event.id).toBe(2);
    });

    it('Сценарий 4: отказ загрузки потомков не обнуляет детали события', async () => {
        const deps = createMockDependencies({
            fetchEventById: vi.fn(() => Promise.resolve({ id: 10, title: 'Главное событие' })),
            fetchChildren: vi.fn(() => Promise.reject(new Error('Сбой сети дочерних событий'))),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(10);

        const state = store.getState();
        // Основная карточка сохраняется, статус переходит в idle, ошибка потомков изолируется
        expect(state.status).toBe('idle');
        expect(state.event).not.toBeNull();
        expect(state.event.id).toBe(10);
        expect(state.error).toBeNull();
        expect(state.children).toEqual([]);
        expect(state.childrenTotal).toBe(0);
        expect(state.childrenError).toBeInstanceOf(Error);
        expect(state.childrenError.message).toBe('Сбой сети дочерних событий');
    });

    it('Сценарий 5.1: отмена предыдущего запроса при повторном select не влияет на итоговое состояние', async () => {
        const deps = createMockDependencies({
            fetchEventById: vi.fn((eventId, signal) => {
                if (eventId === 1) {
                    return new Promise((_, reject) => {
                        signal.addEventListener('abort', () => {
                            reject(new DOMException('The operation was aborted.', 'AbortError'));
                        });
                    });
                }
                return Promise.resolve({ id: 2, title: 'Событие 2' });
            }),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        // Быстрый последовательный запуск двух запросов
        const p1 = store.select(1);
        const p2 = store.select(2);

        await Promise.all([p1, p2]);

        const state = store.getState();
        expect(state.selectedId).toBe(2);
        expect(state.status).toBe('idle');
        expect(state.error).toBeNull();
        expect(state.event).not.toBeNull();
        expect(state.event.id).toBe(2);
    });

    it('Сценарий 5.2: внешний AbortError для актуального запроса переводит статус в error', async () => {
        const deps = createMockDependencies({
            fetchEventById: vi.fn(() =>
                Promise.reject(new DOMException('Запрос отменен', 'AbortError'))
            ),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);

        const state = store.getState();
        expect(state.status).toBe('error');
        expect(state.error?.name).toBe('AbortError');
        expect(state.event).toBeNull();
    });

    it('Сценарий 5.3: TimeoutError для актуального запроса переводит статус в error', async () => {
        const deps = createMockDependencies({
            fetchEventById: vi.fn(() =>
                Promise.reject(new DOMException('Время ожидания истекло', 'TimeoutError'))
            ),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);

        const state = store.getState();
        expect(state.status).toBe('error');
        expect(state.error?.name).toBe('TimeoutError');
        expect(state.event).toBeNull();
    });

    it('Сценарий 6: после вызова destroy пришедший ответ не изменяет состояние и не вызывает колбэк', async () => {
        let resolveEvent;
        const deps = createMockDependencies({
            fetchEventById: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveEvent = resolve;
                    })
            ),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        const selectPromise = store.select(1);

        // Немедленное уничтожение хранилища до завершения сетевого вызова
        store.destroy();
        const callsAtDestroy = deps.onStateChange.mock.calls.length;

        // Разрешение отложенного промиса
        if (resolveEvent) {
            resolveEvent({ id: 1, title: 'Запоздалое событие' });
        }
        await selectPromise;

        // Количество вызовов колбэка не должно увеличиться после destroy
        expect(deps.onStateChange.mock.calls.length).toBe(callsAtDestroy);

        const state = store.getState();
        expect(state.selectedId).toBeNull();
        expect(state.event).toBeNull();
        expect(state.childrenTotal).toBe(0);
    });

    it('Сценарий 7: метод clear сбрасывает выбор и уведомляет подписчика', async () => {
        const deps = createMockDependencies();
        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);
        expect(store.getState().selectedId).toBe(1);

        // Сброс текущего выбора
        store.clear();

        const state = store.getState();
        expect(state.selectedId).toBeNull();
        expect(state.event).toBeNull();
        expect(state.children).toHaveLength(0);
        expect(state.childrenTotal).toBe(0);
        expect(state.status).toBe('idle');
        expect(state.error).toBeNull();
        expect(state.childrenError).toBeNull();

        // Проверка отправки сброшенного состояния подписчику
        expect(deps.onStateChange).toHaveBeenCalled();
        const lastCallState =
            deps.onStateChange.mock.calls[deps.onStateChange.mock.calls.length - 1][0];
        expect(lastCallState.selectedId).toBeNull();
        expect(lastCallState.status).toBe('idle');
        expect(lastCallState.childrenTotal).toBe(0);
    });

    it('Сценарий 8: успешный разбор страницы потомков сохраняет items и childrenTotal, а clear сбрасывает счетчик', async () => {
        const deps = createMockDependencies({
            fetchChildren: vi.fn(() =>
                Promise.resolve({
                    items: [{ id: 10 }, { id: 20 }],
                    total: 42,
                    skip: 0,
                    limit: 100,
                })
            ),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);

        const state = store.getState();
        expect(state.children).toHaveLength(2);
        expect(state.childrenTotal).toBe(42);
        expect(state.childrenError).toBeNull();

        store.clear();
        expect(store.getState().childrenTotal).toBe(0);
    });

    it('Сценарий 9: защитный путь разбора плоского массива устанавливает childrenTotal равным его длине', async () => {
        const deps = createMockDependencies({
            fetchChildren: vi.fn(() =>
                Promise.resolve([{ id: 301 }, { id: 302 }, { id: 303 }])
            ),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);

        const state = store.getState();
        expect(state.children).toHaveLength(3);
        expect(state.childrenTotal).toBe(3);
        expect(state.childrenError).toBeNull();
    });

    it('Сценарий 10: некорректный формат ответа потомков фиксирует childrenError и обнуляет childrenTotal', async () => {
        const deps = createMockDependencies({
            fetchChildren: vi.fn(() => Promise.resolve('invalid payload')),
        });

        const store = createSelectionStore(deps.fetchEventById, deps.fetchChildren, deps.onStateChange);

        await store.select(1);

        const state = store.getState();
        expect(state.status).toBe('idle');
        expect(state.event?.id).toBe(1);
        expect(state.children).toEqual([]);
        expect(state.childrenTotal).toBe(0);
        expect(state.childrenError).toBeInstanceOf(Error);
        expect(state.childrenError?.message).toBe('Некорректный формат ответа');
    });
});
