/**
 * Модуль изолированного хранилища событий (Event Store) таймлайна.
 * Управляет асинхронной загрузкой данных, кэшированием единого окна,
 * подавлением частоты сетевых обращений (debounce), защитой от гонки ответов
 * и детекцией усечения выборки.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Изоляция ввода-вывода: сетевая функция fetchFn и функция обратного вызова
 *    onStateChange внедряются через параметры фабрики, обеспечивая 100% покрытие
 *    тестами в среде Node.js без эмуляции глобального объекта fetch.
 * 2. Двойная защита от гонок: перед каждым новым запросом активный AbortController
 *    прерывает предыдущее сетевое соединение, а монотонный идентификатор requestId
 *    отсекает ответы, пришедшие не в порядке отправки.
 * 3. Разделение окон проверки кэша и загрузки: попадание в кэш оценивается по
 *    видимой области экрана (multiplier = 1), тогда как сетевая выборка упреждает
 *    панорамирование с трехкратным запасом (multiplier = DEFAULT_PREFETCH_MULTIPLIER = 3).
 * 4. Безопасное управление памятью: метод destroy гарантированно останавливает таймеры,
 *    прерывает активные соединения и блокирует любые последующие вызовы onStateChange.
 * 5. Детекция усечения: запрос softLimit + 1 записей позволяет определить наличие
 *    непоместившихся событий без изменения контракта эндпоинта и без серверных счетчиков.
 * 6. Кэширование усеченного окна: при усечении выборки регистрируется полное окно упреждения
 *    вместе с масштабом загрузки loadedZoomIndex. Перезапрос данных при усечении происходит
 *    только при приближении масштаба (zoom in) на величину TRUNCATED_REFETCH_ZOOM_INDEX_DELTA
 *    и более, исключая повторные сетевые вызовы при сдвиге внутри окна.
 * 7. Экспоненциальная задержка при сбоях: счетчик consecutiveFailures увеличивает паузу
 *    между повторными сетевыми попытками до 2000 мс при недоступности API.
 */

import {
    buildRequestShapeKey,
    calculateRequiredLoadWindow,
    shouldFetchEvents,
} from './loadWindow.js';

/**
 * Базовая задержка подавления частоты запросов при панорамировании в миллисекундах.
 */
export const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Мягкий лимит количества событий, отображаемых на одном экране по умолчанию.
 */
export const DEFAULT_SOFT_LIMIT = 500;

/**
 * Фабрика создания экземпляра изолированного хранилища событий.
 *
 * @param {(fromDate: number, toDate: number, categories: string[], ranks: string[]|null, skip: number, limit: number, signal: AbortSignal|null) => Promise<Array<Object>>} fetchFn
 *        Функция выполнения сетевого запроса к API.
 * @param {(state: Object) => void} onStateChange
 *        Функция обратного вызова для уведомления об изменении состояния хранилища.
 * @param {{
 *   debounceMs?: number,
 *   softLimit?: number
 * }} [options={}] Дополнительные конфигурационные параметры хранилища.
 * @returns {{
 *   getState: () => Readonly<{
 *     events: Array<Object>,
 *     loadedWindow: { from_date: number, to_date: number } | null,
 *     loadedShapeKey: string | null,
 *     loadedZoomIndex: number | null,
 *     isTruncated: boolean,
 *     status: 'idle' | 'loading' | 'error',
 *     error: Error | null
 *   }>,
 *   requestWindow: (viewportState: Object, ranks?: string[]|null, categories?: string[]) => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления хранилищем событий.
 */
export function createEventStore(fetchFn, onStateChange, options = {}) {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const softLimit = options.softLimit ?? DEFAULT_SOFT_LIMIT;

    // Внутреннее состояние хранилища, инкапсулированное в замыкании
    let events = [];
    let loadedWindow = null;
    let loadedShapeKey = null;
    let loadedZoomIndex = null;
    let isTruncated = false;
    let status = 'idle';
    let error = null;

    // Счетчик последовательных сетевых отказов для нарастающей задержки планирования
    let consecutiveFailures = 0;

    // Системные переменные управления жизненным циклом асинхронных запросов
    let currentRequestId = 0;
    let activeAbortController = null;
    let debounceTimer = null;
    let isDestroyed = false;

    /**
     * Формирует замороженный слепок текущего состояния хранилища.
     *
     * @returns {Readonly<{
     *   events: Array<Object>,
     *   loadedWindow: { from_date: number, to_date: number } | null,
     *   loadedShapeKey: string | null,
     *   loadedZoomIndex: number | null,
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
            loadedZoomIndex,
            isTruncated,
            status,
            error,
        });
    }

    /**
     * Запрашивает загрузку интервала событий для заданного состояния камеры и фильтров.
     * Проверяет покрытие видимой области ранее загруженным окном упреждения,
     * учитывает масштаб при усечении выборки, подавляет частые вызовы и управляет сетевыми запросами.
     *
     * @param {{ originTimestamp: number, zoomIndex: number, widthPx: number }} viewportState Состояние камеры.
     * @param {string[]|null} [ranks=null] Набор запрашиваемых уровней детализации.
     * @param {string[]} [categories=[]] Набор запрашиваемых категорий событий.
     */
    function requestWindow(viewportState, ranks = null, categories = []) {
        if (isDestroyed) {
            return;
        }

        // 1. Расчет видимого диапазона экрана (множитель 1), ключа формы параметров и контекста усечения
        const requiredVisibleWindow = calculateRequiredLoadWindow(viewportState, 1);
        const currentShapeKey = buildRequestShapeKey(ranks, categories);
        const truncationContext = {
            isTruncated,
            currentZoomIndex: viewportState.zoomIndex,
            loadedZoomIndex,
        };

        // 2. Проверка покрытия: если видимая область укладывается в загруженное окно (и нет приближения при усечении), запрос не требуется
        if (!shouldFetchEvents(requiredVisibleWindow, loadedWindow, currentShapeKey, loadedShapeKey, truncationContext)) {
            return;
        }

        // 3. Ранний перевод статуса в режим загрузки до сброса и повторного планирования таймера.
        // Выполняется только если текущий статус не равен 'loading', предотвращая лавину уведомлений при панорамировании.
        if (status !== 'loading') {
            status = 'loading';
            error = null;
            onStateChange(getState());
        }

        // 4. Расчет упреждающего окна для сетевой выборки (множитель 3) и фиксация масштаба запроса
        const windowToLoad = calculateRequiredLoadWindow(viewportState);
        const requestZoomIndex = viewportState.zoomIndex;

        // 5. Сброс ранее запланированного таймера подавления сетевой активности
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        // 6. Расчет фактической задержки с нарастанием при последовательных сетевых отказах.
        // Задержка удваивается при каждом отказе (до максимума debounceMs * 2^3 = 2000 мс).
        const actualDelayMs = debounceMs * Math.pow(2, Math.min(consecutiveFailures, 3));

        // 7. Планирование отложенного сетевого запроса с адаптивной задержкой
        debounceTimer = setTimeout(async () => {
            debounceTimer = null;

            if (isDestroyed) {
                return;
            }

            // Прерывание предыдущего незавершенного запроса для разгрузки сети
            if (activeAbortController) {
                activeAbortController.abort();
                activeAbortController = null;
            }

            // Инициализация нового контроллера отмены и инкремент счетчика запросов
            activeAbortController = new AbortController();
            currentRequestId++;
            const requestId = currentRequestId;

            try {
                // Запрос лимита softLimit + 1 для определения факта усечения выдачи
                const rawEvents = await fetchFn(
                    windowToLoad.from_date,
                    windowToLoad.to_date,
                    categories,
                    ranks,
                    0,
                    softLimit + 1,
                    activeAbortController.signal
                );

                // Защита от гонки ответов: если запрос устарел или хранилище уничтожено, результат отбрасывается
                if (isDestroyed || requestId !== currentRequestId) {
                    return;
                }

                // Детекция усечения выборки при превышении мягкого лимита
                if (Array.isArray(rawEvents) && rawEvents.length > softLimit) {
                    isTruncated = true;
                    events = rawEvents.slice(0, softLimit);
                } else {
                    isTruncated = false;
                    events = Array.isArray(rawEvents) ? rawEvents : [];
                }

                // Безусловная регистрация полного окна упреждения и масштаба запроса
                loadedWindow = windowToLoad;
                loadedZoomIndex = requestZoomIndex;

                // Сброс счетчика последовательных отказов после успешного ответа
                consecutiveFailures = 0;

                // Фиксация успешного состояния и уведомление интерфейса
                loadedShapeKey = currentShapeKey;
                status = 'idle';
                error = null;
                onStateChange(getState());
            } catch (err) {
                // Исключение отмены запроса штатно игнорируется
                if (err?.name === 'AbortError' || isDestroyed || requestId !== currentRequestId) {
                    return;
                }

                // Инкремент счетчика отказов для нарастающей задержки последующих попыток
                consecutiveFailures++;

                // При сетевом сбое фиксируем ошибку, сохраняя ранее загруженные события на экране
                status = 'error';
                error = err instanceof Error ? err : new Error(String(err));
                onStateChange(getState());
            } finally {
                // Очистка контроллера отмены только если данный запрос все еще является актуальным
                if (requestId === currentRequestId) {
                    activeAbortController = null;
                }
            }
        }, actualDelayMs);
    }

    /**
     * Полное уничтожение хранилища с освобождением сетевых ресурсов и памяти.
     * Блокирует любые последующие мутации состояния и уведомления подписчиков.
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
        loadedZoomIndex = null;
        isTruncated = false;
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
