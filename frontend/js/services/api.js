/**
 * Модуль клиентского API-сервиса для асинхронного взаимодействия с REST API бэкенда.
 * Использует нативный интерфейс Fetch API без сторонних библиотек.
 */

// Базовый URL-префикс всех эндпоинтов с версионированием API v1
const API_BASE = '/api/v1';

/**
 * Предельное время ожидания ответа REST API по умолчанию в миллисекундах (15 секунд).
 */
export const API_REQUEST_TIMEOUT_MS = 15000;

/**
 * Создает объединенный сигнал отмены запроса с поддержкой ограничения времени ожидания (таймаута).
 * Безопасно комбинирует внешний сигнал отмены и внутренний таймер через AbortSignal.any.
 * При отсутствии поддержки AbortSignal.any или AbortSignal.timeout в среде исполнения возвращает внешний сигнал.
 *
 * @param {AbortSignal|null} [externalSignal=null] Внешний сигнал прерывания запроса (например, от контроллера или хранилища).
 * @param {number} [timeoutMs=API_REQUEST_TIMEOUT_MS] Лимит времени ожидания ответа в миллисекундах.
 * @returns {AbortSignal|null} Результирующий сигнал отмены или null.
 */
export function createRequestSignal(externalSignal = null, timeoutMs = API_REQUEST_TIMEOUT_MS) {
    if (
        typeof AbortSignal === 'undefined' ||
        typeof AbortSignal.any !== 'function' ||
        typeof AbortSignal.timeout !== 'function'
    ) {
        return externalSignal;
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    if (!externalSignal) {
        return timeoutSignal;
    }

    return AbortSignal.any([externalSignal, timeoutSignal]);
}

/**
 * Вспомогательная асинхронная функция унифицированного разбора ошибок HTTP-ответов сервера.
 * Извлекает валидационные сообщения FastAPI/Pydantic или возвращает запасной текст ошибки.
 *
 * @param {Response} response Объект HTTP-ответа fetch.
 * @param {string} fallbackMessage Сообщение по умолчанию при отсутствии структурированного тела ошибки.
 * @throws {Error} Всегда выбрасывает исключение Error с разобранным текстом ошибки.
 */
async function parseApiError(response, fallbackMessage) {
    // Инициализация результирующего сообщения значением по умолчанию
    let errorMessage = fallbackMessage;

    try {
        // Попытка асинхронного чтения и парсинга JSON-полезной нагрузки ошибки
        const errorPayload = await response.json();

        // Проверка строкового поля detail (стандартное исключение HTTPException FastAPI)
        if (typeof errorPayload.detail === 'string') {
            errorMessage = errorPayload.detail;
        } else if (Array.isArray(errorPayload.detail)) {
            // Разбор массива ошибок валидации схемы Pydantic v2
            errorMessage = errorPayload.detail
                .map((err) => err.msg || JSON.stringify(err))
                .join(', ');
        } else if (errorPayload.message) {
            // Проверка альтернативного поля message
            errorMessage = errorPayload.message;
        }
    } catch {
        // При ошибке синтаксического анализа JSON сохраняется исходный fallbackMessage
    }

    // Выброс исключения с итоговым текстом ошибки для вызывающего слоя
    throw new Error(errorMessage);
}

/**
 * Проверка статуса доступности сервиса и подключения к СУБД PostgreSQL.
 * Выполняет диагностический запрос к системному эндпоинту /health.
 *
 * @returns {Promise<Object>} Объект состояния сервиса HealthResponse.
 * @throws {Error} При сбое проверки статуса или сетевой ошибке.
 */
export async function fetchHealth() {
    // Выполнение GET-запроса к маршруту мониторинга
    const response = await fetch(`${API_BASE}/health`);

    // Проверка успешности HTTP-статуса (диапазон 200-299)
    if (!response.ok) {
        await parseApiError(response, 'Сбой проверки статуса API');
    }

    // Десериализация и возврат тела ответа
    return await response.json();
}

/**
 * Получение постраничного списка исторических событий.
 *
 * @param {number} [skip=0] Количество пропускаемых записей выборки.
 * @param {number} [limit=100] Максимальное количество возвращаемых записей.
 * @returns {Promise<Array<Object>>} Массив исторических событий.
 * @throws {Error} При ошибке выполнения запроса к API.
 */
export async function fetchEvents(skip = 0, limit = 100) {
    // Выполнение GET-запроса с параметрами смещения и лимита
    const response = await fetch(`${API_BASE}/events/?skip=${skip}&limit=${limit}`);

    // Валидация успешности ответа сервера
    if (!response.ok) {
        await parseApiError(response, 'Ошибка при получении списка событий');
    }

    // Возврат массива событий
    return await response.json();
}

/**
 * Выборка исторических событий по временному диапазону с фильтрацией и пагинацией.
 * Публичная лента бэкенда возвращает исключительно подтвержденный контент (status=approved).
 *
 * @param {number} fromDate Начальная временная метка диапазона (BIGINT).
 * @param {number} toDate Конечная временная метка диапазона (BIGINT).
 * @param {Array<string>} [categories=[]] Список категорий для фильтрации.
 * @param {Array<string>|null} [ranks=null] Массив строковых идентификаторов рангов детализации.
 * @param {number} [skip=0] Смещение пагинации.
 * @param {number} [limit=500] Лимит выборки событий.
 * @param {AbortSignal|null} [signal=null] Экземпляр AbortSignal для отмены сетевого запроса.
 * @returns {Promise<Array<Object>>} Массив событий, пересекающих заданный интервал.
 * @throws {DOMException} При отмене запроса через AbortSignal (error.name === 'AbortError') или таймауте (error.name === 'TimeoutError').
 * @throws {Error} При сетевом сбое, отказе сервера или неверных параметрах диапазона.
 */
export async function fetchEventsInRange(
    fromDate,
    toDate,
    categories = [],
    ranks = null,
    skip = 0,
    limit = 500,
    signal = null
) {
    // Инициализация строителя параметров URL-строки
    const params = new URLSearchParams({
        from_date: fromDate.toString(),
        to_date: toDate.toString(),
        skip: skip.toString(),
        limit: limit.toString(),
    });

    // Добавление категорий отдельными повторяющимися query-параметрами
    if (Array.isArray(categories) && categories.length > 0) {
        categories.forEach((cat) => {
            params.append('categories', cat);
        });
    }

    // Добавление рангов отдельными повторяющимися query-параметрами
    if (Array.isArray(ranks) && ranks.length > 0) {
        ranks.forEach((rank) => {
            params.append('ranks', rank);
        });
    }

    // Конфигурация параметров сетевого вызова с поддержкой таймаута и внешней отмены
    const requestSignal = createRequestSignal(signal);
    const fetchOptions = requestSignal ? { signal: requestSignal } : {};

    // Выполнение прямого GET-запроса к интервальному эндпоинту
    const response = await fetch(
        `${API_BASE}/events/range?${params.toString()}`,
        fetchOptions
    );

    // Разбор ошибок некорректных параметров или серверных сбоев
    if (!response.ok) {
        await parseApiError(response, 'Ошибка при выборке событий по диапазону');
    }

    // Возврат десериализованной выборки событий
    return await response.json();
}

/**
 * Получение детальных данных конкретного исторического события по его уникальному ID.
 *
 * @param {number} eventId Уникальный первичный ключ события.
 * @param {AbortSignal|null} [signal=null] Экземпляр AbortSignal для отмены сетевого запроса.
 * @returns {Promise<Object>} Объект исторического события.
 * @throws {DOMException} При отмене запроса через AbortSignal (error.name === 'AbortError') или таймауте (error.name === 'TimeoutError').
 * @throws {Error} Если событие отсутствует в базе или при сетевом сбое.
 */
export async function fetchEventById(eventId, signal = null) {
    const requestSignal = createRequestSignal(signal);
    const fetchOptions = requestSignal ? { signal: requestSignal } : {};
    const response = await fetch(`${API_BASE}/events/${eventId}`, fetchOptions);

    // Валидация успешности ответа с передачей контекстного сообщения
    if (!response.ok) {
        await parseApiError(response, `Событие с id=${eventId} не найдено`);
    }

    // Возврат десериализованного объекта
    return await response.json();
}

/**
 * Получение списка подтвержденных дочерних событий для родительского события.
 *
 * @param {number} eventId Уникальный первичный ключ родительского события.
 * @param {number} [skip=0] Смещение выборки пагинации.
 * @param {number} [limit=100] Максимальное количество возвращаемых записей.
 * @param {AbortSignal|null} [signal=null] Экземпляр AbortSignal для отмены сетевого запроса.
 * @returns {Promise<{items: Array<Object>, total: number, skip: number, limit: number}>} Объект страницы дочерних исторических событий.
 * @throws {DOMException} При отмене запроса через AbortSignal (error.name === 'AbortError') или таймауте (error.name === 'TimeoutError').
 * @throws {Error} При ошибке выполнения запроса к API или если родитель не найден.
 */
export async function fetchEventChildren(eventId, skip = 0, limit = 100, signal = null) {
    const params = new URLSearchParams({
        skip: skip.toString(),
        limit: limit.toString(),
    });

    const requestSignal = createRequestSignal(signal);
    const fetchOptions = requestSignal ? { signal: requestSignal } : {};
    const response = await fetch(
        `${API_BASE}/events/${eventId}/children?${params.toString()}`,
        fetchOptions
    );

    if (!response.ok) {
        await parseApiError(
            response,
            `Ошибка при получении дочерних событий для id=${eventId}`
        );
    }

    return await response.json();
}

/**
 * Создание новой записи исторического события в системе.
 * Отправляет POST-запрос с полезной нагрузкой JSON.
 *
 * @param {Object} eventData Данные события, соответствующие схеме EventCreate.
 * @returns {Promise<Object>} Созданный объект исторического события с ID.
 * @throws {Error} При ошибках валидации схемы или сбое сохранения.
 */
export async function createEvent(eventData) {
    // Выполнение асинхронного POST-запроса с заголовком application/json
    const response = await fetch(`${API_BASE}/events/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventData),
    });

    // Валидация ответа сервера и разбор деталей валидации Pydantic
    if (!response.ok) {
        await parseApiError(response, 'Ошибка при создании события');
    }

    // Возврат созданного объекта события
    return await response.json();
}

/**
 * Безвозвратное удаление исторического события по его первичному ключу.
 *
 * @param {number} eventId Уникальный идентификатор удаляемого события.
 * @returns {Promise<boolean>} Флаг true при успешном удалении.
 * @throws {Error} При ошибке удаления или если запись не найдена.
 */
export async function deleteEvent(eventId) {
    // Выполнение DELETE-запроса к API
    const response = await fetch(`${API_BASE}/events/${eventId}`, {
        method: 'DELETE',
    });

    // Валидация статуса ответа (для 204 No Content response.ok равен true)
    if (!response.ok) {
        await parseApiError(response, `Ошибка при удалении события id=${eventId}`);
    }

    // Успешный возврат подтверждения без парсинга пустого тела ответа
    return true;
}
