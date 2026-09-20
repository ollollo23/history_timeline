/**
 * Модульные тесты изолированного хранилища событий (eventStore.js).
 * Проверяет подавление сетевого дребезга (debounce), экспоненциальную задержку при отказах,
 * политику кэширования единого окна, сужение окна при усечении, защиту от гонки ответов (requestId),
 * отсечение по лимиту (softLimit) и очистку памяти во фреймворке Vitest[cite: 17].
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
 * Содержит все обязательные поля схемы сущности Event платформы History Timeline[cite: 17].
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
        // Включение виртуального таймера Vitest для детерминированного контроля debounce[cite: 17]
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Очистка активных шпионов и возврат системных часов[cite: 17]
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
        // упреждающее окно с множителем 3 покрывает интервал [-1000, 2000][cite: 17]
        const vpInitial = createViewportMock(0, 0, 1000);
        store.requestWindow(vpInitial, ['century'], []);

        // Продвижение виртуального времени до срабатывания debounce[cite: 17]
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Повторный запрос: смещение на 50 секунд вправо, видимая область [50, 1050],
        // требуемое окно [-900, 2000] полностью вложено в ранее загруженное [-1000, 2000][cite: 17]
        const vpNested = createViewportMock(50, 0, 1000);
        store.requestWindow(vpNested, ['century'], []);

        await vi.advanceTimersByTimeAsync(50);
        // Сетевой запрос не должен выполняться повторно[cite: 17]
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('инициирует сетевой запрос при изменении набора рангов при неизменных координатах камеры', async () => {
        const fetchFn = vi.fn().mockResolvedValue([]);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 50 });

        const vp = createViewportMock(0, 0, 1000);

        // 1. Запрос с набором рангов ['century'][cite: 17]
        store.requestWindow(vp, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // 2. Запрос для тех же координат, но с расширенным набором рангов ['century', 'year'][cite: 17]
        store.requestWindow(vp, ['century', 'year'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Ключ формы запроса изменился -> инициируется повторная загрузка[cite: 17]
        expect(fetchFn).toHaveBeenCalledTimes(2);
        // 4-й аргумент fetchFn — массив запрашиваемых рангов[cite: 17]
        expect(fetchFn.mock.calls[1][3]).toEqual(['century', 'year']);

        store.destroy();
    });

    it('подавляет частые последовательные запросы (debounce) при панорамировании', async () => {
        const fetchFn = vi.fn().mockResolvedValue([]);
        const onStateChange = vi.fn();
        const store = createEventStore(fetchFn, onStateChange, { debounceMs: 50 });

        // 20 частых сдвигов камеры с интервалом 5 мс (суммарно 100 мс)[cite: 17]
        for (let i = 0; i < 20; i++) {
            store.requestWindow(createViewportMock(i * 2000, 0, 1000), ['century'], []);
            await vi.advanceTimersByTimeAsync(5);
        }

        // До истечения 50 мс с момента последнего сдвига сетевой вызов не должен стартовать[cite: 17]
        expect(fetchFn).not.toHaveBeenCalled();

        // Ожидание завершения таймера последнего вызова[cite: 17]
        await vi.advanceTimersByTimeAsync(50);

        // Серия из 20 обращений схлопнута строго в 1 вызов[cite: 17]
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

        // Инициация первого запроса (requestId = 1)[cite: 17]
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // Инициация второго запроса (requestId = 2), прерывающего первый[cite: 17]
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);
        expect(fetchFn).toHaveBeenCalledTimes(2);

        // Разрешение второго (более свежего) запроса новыми данными[cite: 17]
        resolveSecondRequest([createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие')]);
        await vi.advanceTimersByTimeAsync(0);

        expect(store.getState().events).toEqual([
            createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие'),
        ]);

        // Разрешение первого (запоздалого) запроса старыми данными[cite: 17]
        resolveFirstRequest([createMockEvent(1, 50, null, 'science', 'year', 'approved', 'Устаревшее событие')]);
        await vi.advanceTimersByTimeAsync(0);

        // Данные первого запроса обязаны быть отброшены, состояние сохраняет свежие события[cite: 17]
        expect(store.getState().events).toEqual([
            createMockEvent(2, 50100, null, 'science', 'year', 'approved', 'Свежее событие'),
        ]);

        store.destroy();
    });

    it('определяет усечение выборки при получении softLimit + 1 записей и отбрасывает лишнюю', async () => {
        const vp = createViewportMock(0, 0, 100);
        const expectedRequestedWindow = calculateRequiredLoadWindow(vp);

        // При softLimit = 5 возвращаем 6 записей с возрастающими датами начала[cite: 17]
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
        // 1. Флаг усечения выставлен в true[cite: 17]
        expect(state.isTruncated).toBe(true);
        // 2. Массив усечен ровно до 5 элементов[cite: 17]
        expect(state.events).toHaveLength(5);
        expect(state.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);

        // 3. Значение loadedWindow.to_date строго меньше to_date фактически запрошенного окна[cite: 17]
        expect(state.loadedWindow).not.toBeNull();
        expect(state.loadedWindow.to_date).toBeLessThan(expectedRequestedWindow.to_date);

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

        // Успешная первичная загрузка[cite: 17]
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        expect(store.getState().status).toBe('idle');
        expect(store.getState().events).toHaveLength(1);

        // Второй запрос в некэшированную область падает с сетевой ошибкой[cite: 17]
        shouldFail = true;
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        const state = store.getState();
        expect(state.status).toBe('error');
        expect(state.error).toBeInstanceOf(Error);
        expect(state.error?.message).toBe('Сетевой сбой СУБД');
        // Ранее загруженные события сохраняются на холсте для непрерывности отображения[cite: 17]
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

        // Первый запрос начинает выполняться[cite: 17]
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        // Второй запрос прерывает первый[cite: 17]
        store.requestWindow(createViewportMock(50000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(20);

        // Статус хранилища не должен быть 'error' из-за прерванного соединения[cite: 17]
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

        // Уничтожение хранилища до завершения сетевого запроса[cite: 17]
        store.destroy();

        const destroyedState = store.getState();
        expect(destroyedState.events).toEqual([]);
        expect(destroyedState.loadedWindow).toBeNull();
        expect(destroyedState.status).toBe('idle');

        // Разрешение зависшего сетевого вызова[cite: 17]
        resolveInFlightPromise([createMockEvent(99, 50, null, 'politics', 'year', 'approved', 'Запоздалое событие')]);
        await vi.advanceTimersByTimeAsync(0);

        // Колбэк не должен быть вызван, а состояние остается очищенным[cite: 17]
        expect(onStateChange).not.toHaveBeenCalled();
        expect(store.getState().events).toEqual([]);
    });

    it('после усечённой выдачи смещение камеры вправо порождает повторный сетевой запрос', async () => {
        const vpInitial = createViewportMock(0, 0, 1000);
        // Для vpInitial: видимая область [0, 1000], запрошенное окно [-1000, 2000] (длина 3000)
        // Левая треть окна: события от -900 до -400[cite: 17]
        const truncatedEvents = [
            createMockEvent(1, -900),
            createMockEvent(2, -800),
            createMockEvent(3, -700),
            createMockEvent(4, -600),
            createMockEvent(5, -500),
            createMockEvent(6, -400),
        ];

        const secondBatchEvents = [
            createMockEvent(7, 1200),
        ];

        let callCount = 0;
        const fetchFn = vi.fn().mockImplementation(() => {
            callCount++;
            return Promise.resolve(callCount === 1 ? truncatedEvents : secondBatchEvents);
        });

        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        // Первичный запрос данных[cite: 17]
        store.requestWindow(vpInitial, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);

        // После усечения загруженное окно сузилось: to_date = -501 (-500 - 1)[cite: 17]
        const firstState = store.getState();
        expect(firstState.isTruncated).toBe(true);
        expect(firstState.loadedWindow.to_date).toBe(-501);

        // Смещение камеры вправо: сдвиг 1100 > widthPx (1000), но остается внутри исходного окна [-1000, 2000][cite: 17]
        const vpShifted = createViewportMock(1100, 0, 1000);
        store.requestWindow(vpShifted, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Поскольку окно было сужено до -501, новое положение [1100, 2100] в него не входит -> инициируется 2-й запрос[cite: 17]
        expect(fetchFn).toHaveBeenCalledTimes(2);

        store.destroy();
    });

    it('после неусечённой выдачи смещение камеры внутри загруженного окна не порождает запроса', async () => {
        // Возвращается 3 события, что меньше softLimit = 5[cite: 17]
        const events = [
            createMockEvent(1, 100),
            createMockEvent(2, 200),
            createMockEvent(3, 300),
        ];

        const fetchFn = vi.fn().mockResolvedValue(events);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        const vpInitial = createViewportMock(0, 0, 1000);
        // Загруженное упреждающее окно: [-1000, 2000][cite: 17]
        store.requestWindow(vpInitial, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(store.getState().isTruncated).toBe(false);

        // Смещение камеры: видимая область [200, 1200] полностью лежит внутри [-1000, 2000][cite: 17]
        const vpShifted = createViewportMock(200, 0, 1000);
        store.requestWindow(vpShifted, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);

        // Повторный запрос не выполняется, данные обслуживаются из кэша[cite: 17]
        expect(fetchFn).toHaveBeenCalledTimes(1);

        store.destroy();
    });

    it('вырожденный случай одинаковых меток не приводит к некорректной границе окна', async () => {
        const vp = createViewportMock(0, 0, 1000);
        const requestedWindow = calculateRequiredLoadWindow(vp);

        // softLimit + 1 событий с абсолютно одинаковым start_date, равным нижней границе окна[cite: 17]
        const identicalEvents = [
            createMockEvent(1, requestedWindow.from_date),
            createMockEvent(2, requestedWindow.from_date),
            createMockEvent(3, requestedWindow.from_date),
            createMockEvent(4, requestedWindow.from_date),
            createMockEvent(5, requestedWindow.from_date),
            createMockEvent(6, requestedWindow.from_date),
        ];

        const fetchFn = vi.fn().mockResolvedValue(identicalEvents);
        const store = createEventStore(fetchFn, vi.fn(), { debounceMs: 50, softLimit: 5 });

        store.requestWindow(vp, ['century'], []);
        await vi.advanceTimersByTimeAsync(50);

        const state = store.getState();
        expect(state.isTruncated).toBe(true);
        expect(state.loadedWindow).not.toBeNull();
        // Проверка отсутствия инверсии: to_date не может быть меньше from_date[cite: 17]
        expect(state.loadedWindow.to_date).toBeGreaterThanOrEqual(state.loadedWindow.from_date);
        expect(state.loadedWindow.from_date).toBe(requestedWindow.from_date);
        expect(state.loadedWindow.to_date).toBe(requestedWindow.from_date);

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

        // 1. Первый запрос (до отказов): планируется через базовую задержку (debounceMs = 50)[cite: 17]
        store.requestWindow(createViewportMock(0, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs - 1);
        expect(fetchFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(1); // Первый отказ (attempt 1)[cite: 17]

        // 2. Запрос после первого отказа: планируется через удвоенную задержку (2 * debounceMs = 100)[cite: 17]
        store.requestWindow(createViewportMock(10000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(1); // При базовой задержке еще не сработал[cite: 17]
        await vi.advanceTimersByTimeAsync(debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(2); // Второй отказ (attempt 2)[cite: 17]

        // 3. Запрос после второго отказа: планируется через учетверенную задержку (4 * debounceMs = 200)[cite: 17]
        store.requestWindow(createViewportMock(20000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(2 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(2); // При удвоенной задержке еще не сработал[cite: 17]
        await vi.advanceTimersByTimeAsync(2 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(3); // Третий отказ (attempt 3)[cite: 17]

        // 4. Запрос после третьего отказа: планируется через задержку 8 * debounceMs = 400[cite: 17]
        store.requestWindow(createViewportMock(30000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(4 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(4 * debounceMs);
        expect(fetchFn).toHaveBeenCalledTimes(4); // Четвертая попытка завершается успехом[cite: 17]
        expect(store.getState().status).toBe('idle');

        // 5. После успешного ответа задержка возвращается к базовой (debounceMs = 50)[cite: 17]
        store.requestWindow(createViewportMock(40000, 0, 100), ['century'], []);
        await vi.advanceTimersByTimeAsync(debounceMs - 1);
        expect(fetchFn).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchFn).toHaveBeenCalledTimes(5); // Выполнен строго через базовую задержку[cite: 17]

        store.destroy();
    });
});
