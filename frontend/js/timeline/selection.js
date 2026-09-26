/**
 * Модуль изолированного хранилища состояния выбора исторического события (Selection Store).
 * Управляет асинхронной загрузкой детальной информации о событии и постраничного списка
 * его дочерних записей, защитой от состояния гонки ответов (Race Conditions)
 * и частичной деградацией сети.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Инверсия управления (Dependency Injection): сетевые функции внедряются параметрами фабрики,
 *    обеспечивая автономное модульное тестирование в среде Node.js без полифилов fetch.
 * 2. Двойная защита от гонок: прерывание предыдущего запроса через AbortController.abort()
 *    и проверка монотонного счетчика requestId для отсечения устаревших ответов.
 * 3. Частичная деградация (Partial Failure Tolerance): сбой загрузки списка потомков не сбрасывает
 *    успешно загруженную карточку события, позволяя отобразить детализацию с предупреждением.
 * 4. Поддержка постраничной структуры: парсер обрабатывает схему EventChildrenPage (items, total),
 *    сохраняя общее количество существующих на сервере потомков в поле childrenTotal.
 * 5. Немутабельность: метод getState возвращает глубоко замороженный слепок текущего состояния.
 */

/**
 * Фабрика создания изолированного хранилища состояния выбора.
 *
 * @param {(eventId: number, signal: AbortSignal) => Promise<Object>} fetchEventByIdFn
 *        Функция загрузки карточки события по идентификатору.
 * @param {(eventId: number, skip: number, limit: number, signal: AbortSignal) => Promise<{items: Array<Object>, total: number, skip: number, limit: number} | Array<Object>>} fetchChildrenFn
 *        Функция загрузки списка дочерних событий (страница или массив).
 * @param {(state: Object) => void} onStateChange
 *        Функция обратного вызова для уведомления об изменении состояния.
 * @param {{ childrenLimit?: number }} [options={}]
 *        Дополнительные параметры хранилища (лимит выборки дочерних записей).
 * @returns {{
 *   getState: () => Readonly<{
 *     selectedId: number | null,
 *     event: Object | null,
 *     children: Array<Object>,
 *     childrenTotal: number,
 *     status: 'idle' | 'loading' | 'error',
 *     error: Error | null,
 *     childrenError: Error | null
 *   }>,
 *   select: (eventId: number) => Promise<void>,
 *   clear: () => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления состоянием выбора.
 */
export function createSelectionStore(fetchEventByIdFn, fetchChildrenFn, onStateChange, options = {}) {
    const childrenLimit = options.childrenLimit || 100;

    // Внутреннее реактивное состояние хранилища
    let selectedId = null;
    let event = null;
    let children = [];
    let childrenTotal = 0;
    let status = 'idle'; // 'idle' | 'loading' | 'error'
    let error = null;
    let childrenError = null;

    // Системные переменные управления жизненным циклом запросов
    let currentRequestId = 0;
    let activeAbortController = null;
    let isDestroyed = false;

    /**
     * Безопасный вызов колбэка уведомления подписчика с проверкой флага уничтожения.
     */
    function notifySubscriber() {
        if (!isDestroyed && typeof onStateChange === 'function') {
            onStateChange(getState());
        }
    }

    /**
     * Получение замороженного слепка текущего состояния хранилища.
     *
     * @returns {Readonly<{
     *   selectedId: number | null,
     *   event: Object | null,
     *   children: Array<Object>,
     *   childrenTotal: number,
     *   status: 'idle' | 'loading' | 'error',
     *   error: Error | null,
     *   childrenError: Error | null
     * }>}
     */
    function getState() {
        return Object.freeze({
            selectedId,
            event: event ? { ...event } : null,
            children: [...children],
            childrenTotal,
            status,
            error,
            childrenError,
        });
    }

    /**
     * Выбор исторического события по идентификатору и параллельная загрузка его данных.
     *
     * @param {number} eventId Уникальный первичный ключ исторического события.
     * @returns {Promise<void>}
     */
    async function select(eventId) {
        if (isDestroyed) {
            return;
        }

        // Ранний возврат при повторном выборе того же события (если оно уже не в ошибке)
        if (eventId === selectedId && status !== 'error') {
            return;
        }

        // Прерывание предыдущего незавершенного запроса для разгрузки сетевого канала
        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }

        // Инициализация нового контроллера отмены и инкремент счетчика запросов
        activeAbortController = new AbortController();
        const signal = activeAbortController.signal;
        currentRequestId++;
        const requestId = currentRequestId;

        // Перевод состояния в режим загрузки со сбросом счетчиков
        selectedId = eventId;
        event = null;
        children = [];
        childrenTotal = 0;
        status = 'loading';
        error = null;
        childrenError = null;
        notifySubscriber();

        try {
            // Параллельный запуск двух запросов через Promise.allSettled для изоляции частичных сбоев
            const [eventResult, childrenResult] = await Promise.allSettled([
                fetchEventByIdFn(eventId, signal),
                fetchChildrenFn(eventId, 0, childrenLimit, signal),
            ]);

            // Защита от гонки ответов: если запрос устарел или хранилище уничтожено, результат отбрасывается
            if (isDestroyed || requestId !== currentRequestId) {
                return;
            }

            // Обработка отказа загрузки карточки события (любое отклонение, включая AbortError и TimeoutError)
            if (eventResult.status === 'rejected') {
                status = 'error';
                error =
                    eventResult.reason instanceof Error
                        ? eventResult.reason
                        : new Error(String(eventResult.reason));
                event = null;
                children = [];
                childrenTotal = 0;
                childrenError = null;
                notifySubscriber();
                return;
            }

            // Успешная загрузка основного события
            event = eventResult.value;
            error = null;

            // Обработка результата загрузки дочерних записей с разбором схемы EventChildrenPage
            if (childrenResult.status === 'fulfilled') {
                const val = childrenResult.value;
                if (val && typeof val === 'object' && Array.isArray(val.items)) {
                    // Стандартный контракт страницы EventChildrenPage
                    children = val.items;
                    childrenTotal = typeof val.total === 'number' ? val.total : val.items.length;
                    childrenError = null;
                } else if (Array.isArray(val)) {
                    // Защитный путь обратной совместимости при получении плоского массива
                    children = val;
                    childrenTotal = val.length;
                    childrenError = null;
                } else {
                    // Непредвиденный формат данных дочерних событий
                    children = [];
                    childrenTotal = 0;
                    childrenError = new Error('Некорректный формат ответа');
                }
            } else {
                // Фиксация ошибки дочерних записей (включая AbortError и TimeoutError сетевого слоя)
                children = [];
                childrenTotal = 0;
                childrenError =
                    childrenResult.reason instanceof Error
                        ? childrenResult.reason
                        : new Error(String(childrenResult.reason));
            }

            status = 'idle';
            notifySubscriber();
        } finally {
            if (requestId === currentRequestId) {
                activeAbortController = null;
            }
        }
    }

    /**
     * Сброс текущего выбора и прерывание активных сетевых обращений.
     */
    function clear() {
        if (isDestroyed) {
            return;
        }

        // Предотвращение лишних уведомлений при уже сброшенном выборе
        if (selectedId === null && status === 'idle') {
            return;
        }

        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }

        currentRequestId++;

        selectedId = null;
        event = null;
        children = [];
        childrenTotal = 0;
        status = 'idle';
        error = null;
        childrenError = null;

        notifySubscriber();
    }

    /**
     * Полная утилизация хранилища и гарантированное освобождение ресурсов.
     */
    function destroy() {
        isDestroyed = true;

        if (activeAbortController) {
            activeAbortController.abort();
            activeAbortController = null;
        }

        selectedId = null;
        event = null;
        children = [];
        childrenTotal = 0;
        status = 'idle';
        error = null;
        childrenError = null;
    }

    return {
        getState,
        select,
        clear,
        destroy,
    };
}
