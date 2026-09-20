/**
 * Модуль изолированного хранилища событий (Event Store) таймлайна.
 * Управляет асинхронной загрузкой данных, кэшированием единого окна,
 * подавлением частоты сетевых обращений (debounce), защитой от гонки ответов
 * и детекцией усечения выборки[cite: 14].
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Изоляция ввода-вывода: сетевая функция fetchFn и функция обратного вызова
 *    onStateChange внедряются через параметры фабрики, обеспечивая 100% покрытие
 *    тестами в среде Node.js без эмуляции глобального объекта fetch[cite: 14].
 * 2. Двойная защита от гонок: перед каждым новым запросом активный AbortController
 *    прерывает предыдущее сетевое соединение, а монотонный идентификатор requestId
 *    отсекает ответы, пришедшие не в порядке отправки[cite: 14].
 * 3. Разделение окон проверки кэша и загрузки: попадание в кэш оценивается по
 *    видимой области экрана (multiplier = 1), тогда как сетевая выборка упреждает
 *    панорамирование с трехкратным запасом (multiplier = DEFAULT_PREFETCH_MULTIPLIER = 3)[cite: 14].
 * 4. Безопасное управление памятью: метод destroy гарантированно останавливает таймеры,
 *    прерывает активные соединения и блокирует любые последующие вызовы onStateChange[cite: 14].
 * 5. Детекция усечения: запрос softLimit + 1 записей позволяет определить наличие
 *    непоместившихся событий без изменения контракта эндпоинта и без серверных счетчиков[cite: 14].
 * 6. Динамическая адаптация окна кэша: при усечении выборки правая граница загруженного окна
 *    сужается до даты последнего полученного события, предотвращая появление «слепых зон» на шкале.
 * 7. Экспоненциальная задержка при сбоях: счетчик consecutiveFailures увеличивает паузу
 *    между повторными сетевыми попытками до 2000 мс при недоступности API.
 */

import {
    buildRequestShapeKey,
    calculateRequiredLoadWindow,
    shouldFetchEvents,
} from './loadWindow.js';

/**
 * Базовая задержка подавления частоты запросов при панорамировании в миллисекундах[cite: 14].
 */
export const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Мягкий лимит количества событий, отображаемых на одном экране по умолчанию[cite: 14].
 */
export const DEFAULT_SOFT_LIMIT = 500;

/**
 * Фабрика создания экземпляра изолированного хранилища событий[cite: 14].
 *
 * @param {(fromDate: number, toDate: number, categories: string[], ranks: string[]|null, skip: number, limit: number, signal: AbortSignal|null) => Promise<Array<Object>>} fetchFn
 *        Функция выполнения сетевого запроса к API[cite: 14].
 * @param {(state: Object) => void} onStateChange
 *        Функция обратного вызова для уведомления об изменении состояния хранилища[cite: 14].
 * @param {{
 *   debounceMs?: number,
 *   softLimit?: number
 * }} [options={}] Дополнительные конфигурационные параметры хранилища[cite: 14].
 * @returns {{
 *   getState: () => Readonly<Object>,
 *   requestWindow: (viewportState: Object, ranks?: string[]|null, categories?: string[]) => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления хранилищем событий[cite: 14].
 */
export function createEventStore(fetchFn, onStateChange, options = {}) {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const softLimit = options.softLimit ?? DEFAULT_SOFT_LIMIT;

    // Внутреннее состояние хранилища, инкапсулированное в замыкании[cite: 14]
    let events = [];
    let loadedWindow = null;
    let loadedShapeKey = null;
    let isTruncated = false;
    let status = 'idle';
    let error = null;

    // Счетчик последовательных сетевых отказов для нарастающей задержки планирования
    let consecutiveFailures = 0;

    // Системные переменные управления жизненным циклом асинхронных запросов[cite: 14]
    let currentRequestId = 0;
    let activeAbortController = null;
    let debounceTimer = null;
    let isDestroyed = false;

    /**
     * Формирует замороженный слепок текущего состояния хранилища[cite: 14].
     *
     * @returns {Readonly<{
     *   events: Array<Object>,
     *   loadedWindow: { from_date: number, to_date: number } | null,
     *   loadedShapeKey: string | null,
     *   isTruncated: boolean,
     *   status: 'idle' | 'loading' | 'error',
     *   error: Error | null
     * }>}
     */
    function getState() {
        return Object.freeze({
            events: [...events],
            loadedWindow: loadedWindow ? { ...loadedWindow } : null,
            loadedShapeKey,
            isTruncated,
            status,
            error,
        });
    }

    /**
     * Запрашивает загрузку интервала событий для заданного состояния камеры и фильтров[cite: 14].
     * Проверяет покрытие видимой области ранее загруженным окном упреждения,
     * подавляет частые вызовы и управляет сетевыми запросами[cite: 14].
     *
     * @param {{ originTimestamp: number, zoomIndex: number, widthPx: number }} viewportState Состояние камеры[cite: 14].
     * @param {string[]|null} [ranks=null] Набор запрашиваемых уровней детализации[cite: 14].
     * @param {string[]} [categories=[]] Набор запрашиваемых категорий событий[cite: 14].
     */
    function requestWindow(viewportState, ranks = null, categories = []) {
        if (isDestroyed) {
            return;
        }

        // 1. Расчет видимого диапазона экрана (множитель 1) и ключа формы параметров
        const requiredVisibleWindow = calculateRequiredLoadWindow(viewportState, 1);
        const currentShapeKey = buildRequestShapeKey(ranks, categories);

        // 2. Проверка покрытия: если видимая область укладывается в загруженное окно, запрос не требуется
        if (!shouldFetchEvents(requiredVisibleWindow, loadedWindow, currentShapeKey, loadedShapeKey)) {
            return;
        }

        // 3. Ранний перевод статуса в режим загрузки до сброса и повторного планирования таймера.
        // Выполняется только если текущий статус не равен 'loading', предотвращая лавину уведомлений при панорамировании.
        if (status !== 'loading') {
            status = 'loading';
            error = null;
            onStateChange(getState());
        }

        // 4. Расчет упреждающего окна для фактической сетевой загрузки (множитель 3 по умолчанию)
        const windowToLoad = calculateRequiredLoadWindow(viewportState);

        // 5. Сброс ранее запланированного таймера подавления сетевой активности[cite: 14]
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        // 6. Расчет фактической задержки с нарастанием при последовательных сетевых отказах.
        // Задержка удваивается при каждом отказе (до максимума debounceMs * 2^3 = 2000 мс).
        const actualDelayMs = debounceMs * Math.pow(2, Math.min(consecutiveFailures, 3));

        // 7. Планирование отложенного сетевого запроса с адаптивной задержкой[cite: 14]
        debounceTimer = setTimeout(async () => {
            debounceTimer = null;

            if (isDestroyed) {
                return;
            }

            // Прерывание предыдущего незавершенного запроса для разгрузки сети[cite: 14]
            if (activeAbortController) {
                activeAbortController.abort();
                activeAbortController = null;
            }

            // Инициализация нового контроллера отмены и инкремент счетчика запросов[cite: 14]
            activeAbortController = new AbortController();
            currentRequestId++;
            const requestId = currentRequestId;

            try {
                // Запрос лимита softLimit + 1 для определения факта усечения выдачи[cite: 14]
                const rawEvents = await fetchFn(
                    windowToLoad.from_date,
                    windowToLoad.to_date,
                    categories,
                    ranks,
                    0,
                    softLimit + 1,
                    activeAbortController.signal
                );

                // Защита от гонки ответов: если запрос устарел или хранилище уничтожено, результат отбрасывается[cite: 14]
                if (isDestroyed || requestId !== currentRequestId) {
                    return;
                }

                // Детекция усечения выборки при превышении мягкого лимита[cite: 14]
                if (Array.isArray(rawEvents) && rawEvents.length > softLimit) {
                    isTruncated = true;
                    events = rawEvents.slice(0, softLimit);
                } else {
                    isTruncated = false;
                    events = Array.isArray(rawEvents) ? rawEvents : [];
                }

                // Расчет и фиксация параметров зарегистрированного окна загрузки.
                // Причина: регистрация полного интервала при усечении приводит к тому,
                // что предикат shouldFetchEvents признаёт правую часть интервала
                // загруженной и никогда её не догружает.
                if (isTruncated) {
                    let coveredTo = windowToLoad.from_date;
                    if (events.length > 0) {
                        const lastEvent = events[events.length - 1];
                        const lastStartDate =
                            lastEvent && typeof lastEvent.start_date === 'number'
                                ? lastEvent.start_date
                                : windowToLoad.from_date;

                        // Вычитаем единицу для исключения неполного среза событий с граничным start_date
                        const rawCoveredTo = lastStartDate - 1;
                        // Защита от вырожденного случая, когда все события имеют одинаковый start_date
                        coveredTo = Math.max(rawCoveredTo, windowToLoad.from_date);
                    }

                    loadedWindow = Object.freeze({
                        from_date: windowToLoad.from_date,
                        to_date: Math.floor(coveredTo),
                    });
                } else {
                    loadedWindow = windowToLoad;
                }

                // Сброс счетчика последовательных отказов после успешного ответа
                consecutiveFailures = 0;

                // Фиксация успешного состояния и уведомление интерфейса
                loadedShapeKey = currentShapeKey;
                status = 'idle';
                error = null;
                onStateChange(getState());
            } catch (err) {
                // Исключение отмены запроса штатно игнорируется[cite: 14]
                if (err?.name === 'AbortError' || isDestroyed || requestId !== currentRequestId) {
                    return;
                }

                // Инкремент счетчика отказов для нарастающей задержки последующих попыток
                consecutiveFailures++;

                // При сетевом сбое фиксируем ошибку, сохраняя ранее загруженные события на экране[cite: 14]
                status = 'error';
                error = err instanceof Error ? err : new Error(String(err));
                onStateChange(getState());
            } finally {
                // Очистка контроллера отмены только если данный запрос все еще является актуальным[cite: 14]
                if (requestId === currentRequestId) {
                    activeAbortController = null;
                }
            }
        }, actualDelayMs);
    }

    /**
     * Полное уничтожение хранилища с освобождением сетевых ресурсов и памяти[cite: 14].
     * Блокирует любые последующие мутации состояния и уведомления подписчиков[cite: 14].
     */
    function destroy() {
        isDestroyed = true;

        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }

        events = [];
        loadedWindow = null;
        loadedShapeKey = null;
        status = 'idle';
        error = null;
        consecutiveFailures = 0;
    }

    return {
        getState,
        requestWindow,
        destroy,
    };
}
