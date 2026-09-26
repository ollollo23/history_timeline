/**
 * Модульные тесты изолированного хранилища событий (eventStore.js).
 * Проверяет подавление сетевого дребезга (debounce), экспоненциальную задержку при отказах,
 * политику кэширования единого окна с регистрацией полного диапазона при усечении выборки,
 * защиту от гонки ответов (requestId), отсечение по лимиту (softLimit) и очистку памяти во фреймворке Vitest.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createEventStore,
    DEFAULT_DEBOUNCE_MS,
    DEFAULT_SOFT_LIMIT,
} from '../../frontend/js/timeline/eventStore.js';
import { calculateRequiredLoadWindow } from '../../frontend/js/timeline/loadWindow.js';
import { prepareEventMarkers } from '../../frontend/js/timeline/markers.js';
import { zoomIndexToSecondsPerPixel } from '../../frontend/js/timeline/scale.js';

/**
 * Вспомогательная фабрика для сборки объекта состояния виртуальной камеры.
 *
 * @param {number} originTimestamp Метка времени на левом крае экрана.
 * @param {number} [zoomIndex=0] Логарифмический индекс масштаба (2^0 = 1 сек/пиксель).
 * @param {number} [widthPx=1000] Логическая ширина области отображения в пикселях.
 * @returns {{ originTimestamp: number, zoomIndex: number, widthPx: number }}
 */
function createViewportMock(originTimestamp, zoomIndex = 0, widthPx = 1000) {
    return {
        originTimestamp,
        zoomIndex,
        widthPx,
    };
}

/**
 * Вспомогательная фабрика создания полноценных доменных объектов событий для тестовых моков.
 * Содержит все обязательные поля схемы сущности Event платформы History Timeline.
 *
 * @param {number} id Уникальный идентификатор события.
 * @param {number} startDate Метка времени начала события в секундах Unix.
 * @param {number|null} [endDate=null] Метка времени окончания события.
 * @param {string} [category='science'] Категория события.
 * @param {string} [rank='year'] Ранг детализации события.
 * @param {string} [status='approved'] Статус модерации события.
 * @param {string} [title] Заголовок исторического события.
 * @returns {{
 *   id: number,
 *   title: string,
 *   start_date: number,
 *   end_date: number | null,
 *   category: string,
 *   rank: string,
 *   status: string
 * }}
 */
function createMockEvent(
    id,
    startDate,
    endDate = null,
    category = 'science',
    rank = 'year',
    status = 'approved',
    title = `Историческое событие #${id}`
) {
    return {
        id,
        title,
        start_date: startDate,
        end_date: endDate,
        category,
        rank,
        status,
    };
}

describe('eventStore module', () => {
    beforeEach(() => {
        // Включение виртуального таймера Vitest для детерминированного контроля debounce
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Очистка активных шпионов и возврат системных часов
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('экспортирует константы по умолчанию', () => {
        expect(DEFAULT_DEBOUNCE_MS).toBe(250);
        expect(DEFAULT_SOFT_LIMIT).toBe(500);
    });

    it('не вызывает fetchFn при повторном запросе вложенного окна', async () => {
        const fetchFn = vi.fn().mockResolvedValue([createMockEvent(1, 100)]);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 50 });

        // Первичный запрос: при widthPx=1000 и zoomIndex=0 видимая область [0, 1000],
        // упреждающее окно с множителем 3 покрывает интервал [-1000, 2000]
        const vpInitial = createViewportMock(0, 0, 1000);
        store.requestWindow(vpInitial, ['century'], []);

        // Продвижение виртуального времени до срабатывания debounce
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Повторный запрос: смещение на 50 секунд вправо, видимая область [50, 1050],
        // требуемое окно [-900, 2000] полностью вложено в ранее загруженное [-1000, 2000]
        const vpNested = createViewportMock(50, 0, 1000);
        store.requestWindow(vpNested, ['century'], []);

        await vi.advanceTimersByTimeAsync(50);
        // Сетевой запрос не должен выполняться повторно
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('инициирует сетевой запрос при изменении набора рангов при неизменных координатах камеры', async () => {
        const fetchFn = vi.fn().mockResolvedValue([]);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 50 });

        const vp = createViewportMock(0, 0, 1000);

        // 1. Запрос с набором рангов ['century']
        store.requestWindow(vp, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // 2. Запрос для тех же координат, но с расширенным набором рангов ['century', 'year']
        store.requestWindow(vp, ['century', 'year'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Ключ формы запроса изменился -> инициируется повторная загрузка
        expect(fetchFn).toHaveBeenCalledTimes(2);
        // 4-й аргумент fetchFn — массив запрашиваемых рангов
        expect(fetchFn.mock.calls[1][3]).toEqual(['century', 'year']);

        store.destroy();
    });

    it('подавляет частые последовательные запросы (debounce) при панорамировании', async () => {
        const fetchFn = vi.fn().mockResolvedValue([]);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 50 });

        // 20 частых сдвигов камеры с интервалом 5 мс (суммарно 100 мс)
        for (let i = 0; i < 20; i++) {
            store.requestWindow(createViewportMock(i * 2000, 0, 1000), ['century'], []);
            await vi.advanceTimersByTimeAsync(5);
        }

        // До истечения 50 мс с момента последнего сдвига сетевой вызов не должен стартовать
        expect(fetchFn).not.toHaveBeenCalled();

        // Ожидание завершения таймера последнего вызова
        await vi.advanceTimersByTimeAsync(50);

        // Серия из 20 обращений схлопнута строго в 1 вызов
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('защищает от гонки ответов и отбрасывает устаревшие запросы по счетчику requestId', async () => {
        let resolveFirstRequest;
        let resolveSecondRequest;

        const firstPromise = new Promise((resolve) => {
            resolveFirstRequest = resolve;
        });
        const secondPromise = new Promise((resolve) => {
            resolveSecondRequest = resolve;
        });

        let callCount = 0;
        const fetchFn = vi.fn().mockImplementation(() => {
            callCount++;
            return callCount === 1 ? firstPromise : secondPromise;
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 20 });

        // Инициация первого запроса (requestId = 1)
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Инициация второго запроса (requestId = 2), прерывающего первый
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        // Разрешение второго (более свежего) запроса новыми данными
        resolveSecondRequest([createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие')]);
        await vi.advanceTimersByTimeAsync(0);

        expect(store.getState().events).toEqual([
            createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие'),
        ]);

        // Разрешение первого (запоздалого) запроса старыми данными
        resolveFirstRequest([createMockEvent(1, 50, null, 'science', 'year', 'approved', 'Устаревшее событие')]);
        await vi.advanceTimersByTimeAsync(0);

        // Данные первого запроса обязаны быть отброшены, состояние сохраняет свежие события
        expect(store.getState().events).toEqual([
            createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие'),
        ]);

        store.destroy();
    });

    it('определяет усечение выборки при получении softLimit + 1 записей и отбрасывает лишнюю', async () => {
        const vp = createViewportMock(0, 0, 100);
        const expectedRequestedWindow = calculateRequiredLoadWindow(vp);

        // При softLimit = 5 возвращаем 6 записей с возрастающими датами начала
        const sixEvents = [
            createMockEvent(1, -80),
            createMockEvent(2, -60),
            createMockEvent(3, -40),
            createMockEvent(4, -20),
            createMockEvent(5, 0),
            createMockEvent(6, 20),
        ];
        const fetchFn = vi.fn().mockResolvedValue(sixEvents);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 20, softLimit: 5 });

        store.requestWindow(vp, ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        const state = store.getState();
        // 1. Флаг усечения выставлен в true
        expect(state.isTruncated).toBe(true);
        // 2. Массив усечен ровно до 5 элементов
        expect(state.events).toHaveLength(5);
        expect(state.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);

        // 3. Загруженное окно регистрируется целиком, фиксируя масштаб камеры
        expect(state.loadedWindow).toEqual(expectedRequestedWindow);
        expect(state.loadedZoomIndex).toBe(vp.zoomIndex);

        store.destroy();
    });

    it('при усечении регистрируется полное окно упреждения и масштаб загрузки', async () => {
        const sixEvents = [
            createMockEvent(1, 100),
            createMockEvent(2, 200),
            createMockEvent(3, 300),
            createMockEvent(4, 400),
            createMockEvent(5, 500),
            createMockEvent(6, 600),
        ];
        const fetchFn = vi.fn().mockResolvedValue(sixEvents);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 20, softLimit: 5 });

        const vp = createViewportMock(1000, 2, 800);
        const expectedWindow = calculateRequiredLoadWindow(vp);

        store.requestWindow(vp, ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        const state = store.getState();
        expect(state.isTruncated).toBe(true);
        expect(state.events).toHaveLength(5);
        expect(state.loadedWindow).toEqual(expectedWindow);
        expect(state.loadedZoomIndex).toBe(2);

        store.destroy();
    });

    it('сдвиг внутри усеченного окна обслуживается из кэша и не вызывает повторного запроса', async () => {
        const sixEvents = [
            createMockEvent(1, 0),
            createMockEvent(2, 100),
            createMockEvent(3, 200),
            createMockEvent(4, 300),
            createMockEvent(5, 400),
            createMockEvent(6, 500),
        ];
        const fetchFn = vi.fn().mockResolvedValue(sixEvents);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        const vpInitial = createViewportMock(0, 0, 1000);
        store.requestWindow(vpInitial, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Смещение камеры на 100 секунд вправо: видимая область [100, 1100] целиком лежит внутри [-1000, 2000]
        const vpShifted = createViewportMock(100, 0, 1000);
        store.requestWindow(vpShifted, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Повторный запрос не отправляется, выборка берется из локального состояния
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('приближение масштаба на 1 и более инициирует повторный запрос усеченной выборки', async () => {
        const sixEvents = [
            createMockEvent(1, 100),
            createMockEvent(2, 200),
            createMockEvent(3, 300),
            createMockEvent(4, 400),
            createMockEvent(5, 500),
            createMockEvent(6, 600),
        ];
        const fetchFn = vi.fn().mockResolvedValue(sixEvents);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        // Первичный запрос: масштаб loadedZoomIndex = 10
        const vp1 = createViewportMock(1000, 10, 1000);
        store.requestWindow(vp1, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(store.getState().isTruncated).toBe(true);
        expect(store.getState().loadedZoomIndex).toBe(10);

        // Попытка А: приближение на 0.5 шага (порог delta = 1 не достигнут)
        const vpZoomSmall = createViewportMock(1000, 9.5, 1000);
        store.requestWindow(vpZoomSmall, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Попытка Б: приближение ровно на 1 шаг зума от загруженного (10 - 9.0 = 1.0)
        const vpZoomStep = createViewportMock(1000, 9.0, 1000);
        store.requestWindow(vpZoomStep, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        store.destroy();
    });

    it('сценарий плотности: сохранение непрерывности маркеров и минимизация запросов при панорамировании', async () => {
        const depthMap = {
            century: 0,
            decade: 1,
            year: 2,
            month: 3,
            day: 4,
            hour: 5,
            minute: 6,
            second: 7,
        };
        const ranksList = ['century', 'decade', 'year', 'month', 'day', 'hour', 'minute', 'second'];

        // Синтетический пул из 1500 событий в диапазоне [-2000, 5000]
        const allEvents = [];
        for (let i = 1; i <= 1500; i++) {
            const start = -2000 + (i * 7000) / 1500;
            const duration = i % 5 === 0 ? 0 : (i % 10) * 100;
            allEvents.push(
                createMockEvent(
                    i,
                    Math.floor(start),
                    duration > 0 ? Math.floor(start + duration) : null,
                    'science',
                    ranksList[i % ranksList.length]
                )
            );
        }

        const softLimit = 500;
        const fetchFn = vi.fn().mockImplementation((from_date, to_date) => {
            const filtered = allEvents.filter((ev) => {
                const endEff = ev.end_date ?? ev.start_date;
                return ev.start_date <= to_date && endEff >= from_date;
            });

            // Имитация серверной сортировки: depth_level ASC, duration DESC, Knuth Hash ASC, id ASC
            filtered.sort((a, b) => {
                const depthA = depthMap[a.rank] ?? 7;
                const depthB = depthMap[b.rank] ?? 7;
                if (depthA !== depthB) {
                    return depthA - depthB;
                }

                const durA = (a.end_date ?? a.start_date) - a.start_date;
                const durB = (b.end_date ?? b.start_date) - b.start_date;
                if (durA !== durB) {
                    return durB - durA;
                }

                const hashA = (BigInt(a.id) * 2654435761n) % 4294967296n;
                const hashB = (BigInt(b.id) * 2654435761n) % 4294967296n;
                if (hashA !== hashB) {
                    return hashA < hashB ? -1 : 1;
                }

                return a.id - b.id;
            });

            return Promise.resolve(filtered.slice(0, softLimit + 1));
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit });

        // Начальное состояние: [0, 1000]
        const vpStart = createViewportMock(0, 0, 1000);
        store.requestWindow(vpStart);
        await vi.advanceTimersByTimeAsync(50);

        // 8 последовательных сдвигов на 250 секунд (четверть экрана)
        for (let step = 1; step <= 8; step++) {
            const currentOrigin = step * 250;
            const vpCurrent = createViewportMock(currentOrigin, 0, 1000);
            store.requestWindow(vpCurrent);
            await vi.advanceTimersByTimeAsync(50);

            const spp = zoomIndexToSecondsPerPixel(vpCurrent.zoomIndex);
            const markers = prepareEventMarkers(
                store.getState().events,
                vpCurrent.originTimestamp,
                spp,
                vpCurrent.widthPx,
                { bufferPx: 0 }
            );
            expect(markers.length).toBeGreaterThan(0);
        }

        // За все 8 сдвигов число сетевых вызовов не превышает 2
        expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(2);

        store.destroy();
    });

    it('обрабатывает сетевой отказ, переводит статус в error и сохраняет ранее загруженный кэш', async () => {
        let shouldFail = false;
        const fetchFn = vi.fn().mockImplementation(() => {
            if (shouldFail) {
                return Promise.reject(new Error('Сетевой сбой СУБД'));
            }
            return Promise.resolve([createMockEvent(10, 50, null, 'culture', 'year', 'approved', 'Первичное событие')]);
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 20 });

        // Успешная первичная загрузка
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        expect(store.getState().status).toBe('idle');
        expect(store.getState().events).toHaveLength(1);

        // Второй запрос в некэшированную область падает с сетевой ошибкой
        shouldFail = true;
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        const state = store.getState();
        expect(state.status).toBe('error');
        expect(state.error).toBeInstanceOf(Error);
        expect(state.error?.message).toBe('Сетевой сбой СУБД');
        // Ранее загруженные события сохраняются на холсте для непрерывности отображения
        expect(state.events).toHaveLength(1);
        expect(state.events[0].id).toBe(10);

        store.destroy();
    });

    it('штатно игнорирует прерывание сетевого вызова через AbortError без перехода в статус error', async () => {
        let triggerAbort;
        const fetchFn = vi.fn().mockImplementation((_from, _to, _cat, _rnk, _sk, _lim, signal) => {
            return new Promise((_, reject) => {
                triggerAbort = () => {
                    const abortErr = new Error('The operation was aborted');
                    abortErr.name = 'AbortError';
                    reject(abortErr);
                };
                if (signal) {
                    signal.addEventListener('abort', triggerAbort);
                }
            });
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 20 });

        // Первый запрос начинает выполняться
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        // Второй запрос прерывает первый
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        // Статус хранилища не должен быть 'error' из-за прерванного соединения
        expect(store.getState().status).toBe('loading');
        expect(store.getState().error).toBeNull();

        store.destroy();
    });

    it('гарантирует изоляцию и предотвращает мутации состояния после вызова destroy', async () => {
        let resolveInFlightPromise;
        const pendingPromise = new Promise((resolve) => {
            resolveInFlightPromise = resolve;
        });

        const fetchFn = vi.fn().mockReturnValue(pendingPromise);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 20 });

        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        onStateChange.mockClear();

        // Уничтожение хранилища до завершения сетевого запроса
        store.destroy();

        const destroyedState = store.getState();
        expect(destroyedState.events).toEqual([]);
        expect(destroyedState.loadedWindow).toBeNull();
        expect(destroyedState.status).toBe('idle');

        // Разрешение зависшего сетевого вызова
        resolveInFlightPromise([createMockEvent(99, 50, null, 'politics', 'year', 'approved', 'Запоздалое событие')]);
        await vi.advanceTimersByTimeAsync(0);

        // Колбэк не должен быть вызван, а состояние остается очищенным
        expect(onStateChange).not.toHaveBeenCalled();
        expect(store.getState().events).toEqual([]);
    });

    it('после неусечённой выдачи смещение камеры внутри загруженного окна не порождает запроса', async () => {
        // Возвращается 3 события, что меньше softLimit = 5
        const events = [
            createMockEvent(1, 100),
            createMockEvent(2, 200),
            createMockEvent(3, 300),
        ];

        const fetchFn = vi.fn().mockResolvedValue(events);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        const vpInitial = createViewportMock(0, 0, 1000);
        // Загруженное упреждающее окно: [-1000, 2000]
        store.requestWindow(vpInitial, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(store.getState().isTruncated).toBe(false);

        // Смещение камеры: видимая область [200, 1200] полностью лежит внутри [-1000, 2000]
        const vpShifted = createViewportMock(200, 0, 1000);
        store.requestWindow(vpShifted, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Повторный запрос не выполняется, данные обслуживаются из кэша
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('последовательные отказы увеличивают задержку планирования', async () => {
        const debounceMs = 50;
        let attempt = 0;

        const fetchFn = vi.fn().mockImplementation(() => {
            attempt++;
            if (attempt <= 3) {
                return Promise.reject(new Error(`Сетевой сбой #${attempt}`));
            }
            return Promise.resolve([createMockEvent(1, 100)]);
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs });

        // 1. Первый запрос (до отказов): планируется через базовую задержку (debounceMs = 50)
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs - 1);
        expect(fetchFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(1); // Первый отказ (attempt 1)

        // 2. Запрос после первого отказа: планируется через удвоенную задержку (2 * debounceMs = 100)
        store.requestWindow(createViewportMock(10000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(1); // При базовой задержке еще не сработал
        await vi.advanceTimersByTimeAsync(debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(2); // Второй отказ (attempt 2)

        // 3. Запрос после второго отказа: планируется через учетверенную задержку (4 * debounceMs = 200)
        store.requestWindow(createViewportMock(20000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(2 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(2); // При удвоенной задержке еще не сработал
        await vi.advanceTimersByTimeAsync(2 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(3); // Третий отказ (attempt 3)

        // 4. Запрос после третьего отказа: планируется через задержку 8 * debounceMs = 400
        store.requestWindow(createViewportMock(30000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(4 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(4 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(4); // Четвертая попытка завершается успехом
        expect(store.getState().status).toBe('idle');

        // 5. После успешного ответа задержка возвращается к базовой (debounceMs = 50)
        store.requestWindow(createViewportMock(40000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs - 1);
        expect(fetchFn).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(5); // Выполнен строго через базовую задержку

        store.destroy();
    });
});
