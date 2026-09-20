/**
 * Модуль клиентского API-сервиса для асинхронного взаимодействия с REST API бэкенда.
 * Использует нативный интерфейс Fetch API без сторонних библиотек[cite: 18].
 */

// Базовый URL-префикс всех эндпоинтов с версионированием API v1[cite: 18]
const API_BASE = '/api/v1';

/**
 * Вспомогательная асинхронная функция унифицированного разбора ошибок HTTP-ответов сервера[cite: 18].
 * Извлекает валидационные сообщения FastAPI/Pydantic или возвращает запасной текст ошибки[cite: 18].
 *
 * @param {Response} response Объект HTTP-ответа fetch[cite: 18].
 * @param {string} fallbackMessage Сообщение по умолчанию при отсутствии структурированного тела ошибки[cite: 18].
 * @throws {Error} Всегда выбрасывает исключение Error с разобранным текстом ошибки[cite: 18].
 */
async function parseApiError(response, fallbackMessage) {
    // Инициализация результирующего сообщения значением по умолчанию[cite: 18]
    let errorMessage = fallbackMessage;

    try {
        // Попытка асинхронного чтения и парсинга JSON-полезной нагрузки ошибки[cite: 18]
        const errorPayload = await response.json();

        // Проверка строкового поля detail (стандартное исключение HTTPException FastAPI)[cite: 18]
        if (typeof errorPayload.detail === 'string') {
            errorMessage = errorPayload.detail;
        } else if (Array.isArray(errorPayload.detail)) {
            // Разбор массива ошибок валидации схемы Pydantic v2[cite: 18]
            errorMessage = errorPayload.detail
                .map((err) => err.msg || JSON.stringify(err))
                .join(', ');
        } else if (errorPayload.message) {
            // Проверка альтернативного поля message[cite: 18]
            errorMessage = errorPayload.message;
        }
    } catch {
        // При ошибке синтаксического анализа JSON сохраняется исходный fallbackMessage[cite: 18]
    }

    // Выброс исключения с итоговым текстом ошибки для вызывающего слоя[cite: 18]
    throw new Error(errorMessage);
}

/**
 * Проверка статуса доступности сервиса и подключения к СУБД PostgreSQL[cite: 18].
 * Выполняет диагностический запрос к системному эндпоинту /health[cite: 18].
 *
 * @returns {Promise<Object>} Объект состояния сервиса HealthResponse[cite: 18].
 * @throws {Error} При сбое проверки статуса или сетевой ошибке[cite: 18].
 */
export async function fetchHealth() {
    // Выполнение GET-запроса к маршруту мониторинга[cite: 18]
    const response = await fetch(`${API_BASE}/health`);

    // Проверка успешности HTTP-статуса (диапазон 200-299)[cite: 18]
    if (!response.ok) {
        await parseApiError(response, 'Сбой проверки статуса API');
    }

    // Десериализация и возврат тела ответа[cite: 18]
    return await response.json();
}

/**
 * Получение постраничного списка исторических событий[cite: 18].
 *
 * @param {number} [skip=0] Количество пропускаемых записей выборки[cite: 18].
 * @param {number} [limit=100] Максимальное количество возвращаемых записей[cite: 18].
 * @returns {Promise<Array<Object>>} Массив исторических событий[cite: 18].
 * @throws {Error} При ошибке выполнения запроса к API[cite: 18].
 */
export async function fetchEvents(skip = 0, limit = 100) {
    // Выполнение GET-запроса с параметрами смещения и лимита[cite: 18]
    const response = await fetch(`${API_BASE}/events/?skip=${skip}&limit=${limit}`);

    // Валидация успешности ответа сервера[cite: 18]
    if (!response.ok) {
        await parseApiError(response, 'Ошибка при получении списка событий');
    }

    // Возврат массива событий[cite: 18]
    return await response.json();
}

/**
 * Выборка исторических событий по временному диапазону с фильтрацией и пагинацией[cite: 18].
 * Публичная лента бэкенда возвращает исключительно подтвержденный контент (status=approved)[cite: 18].
 *
 * @param {number} fromDate Начальная временная метка диапазона (BIGINT)[cite: 18].
 * @param {number} toDate Конечная временная метка диапазона (BIGINT)[cite: 18].
 * @param {Array<string>} [categories=[]] Список категорий для фильтрации[cite: 18].
 * @param {Array<string>|null} [ranks=null] Массив строковых идентификаторов рангов детализации[cite: 18].
 * @param {number} [skip=0] Смещение пагинации[cite: 18].
 * @param {number} [limit=500] Лимит выборки событий[cite: 18].
 * @param {AbortSignal|null} [signal=null] Экземпляр AbortSignal для отмены сетевого запроса[cite: 18].
 * @returns {Promise<Array<Object>>} Массив событий, пересекающих заданный интервал[cite: 18].
 * @throws {DOMException} При отмене запроса через AbortSignal (error.name === 'AbortError'). Исключение пробрасывается без преобразования и обрабатывается в eventStore.js.
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
    // Инициализация строителя параметров URL-строки[cite: 18]
    const params = new URLSearchParams({
        from_date: fromDate.toString(),
        to_date: toDate.toString(),
        skip: skip.toString(),
        limit: limit.toString(),
    });

    // Добавление категорий отдельными повторяющимися query-параметрами[cite: 18]
    if (Array.isArray(categories) && categories.length > 0) {
        categories.forEach((cat) => {
            params.append('categories', cat);
        });
    }

    // Добавление рангов отдельными повторяющимися query-параметрами[cite: 18]
    if (Array.isArray(ranks) && ranks.length > 0) {
        ranks.forEach((rank) => {
            params.append('ranks', rank);
        });
    }

    // Конфигурация параметров сетевого вызова с поддержкой отмены через AbortSignal[cite: 18]
    const fetchOptions = signal ? { signal } : {};

    // Выполнение прямого GET-запроса к интервальному эндпоинту без избыточного try/catch
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
 * Получение детальных данных конкретного исторического события по его уникальному ID[cite: 18].
 *
 * @param {number} eventId Уникальный первичный ключ события[cite: 18].
 * @returns {Promise<Object>} Объект исторического события[cite: 18].
 * @throws {Error} Если событие отсутствует в базе или при сетевом сбое[cite: 18].
 */
export async function fetchEventById(eventId) {
    // Выполнение GET-запроса по идентификатору сущности[cite: 18]
    const response = await fetch(`${API_BASE}/events/${eventId}`);

    // Валидация успешности ответа с передачей контекстного сообщения[cite: 18]
    if (!response.ok) {
        await parseApiError(response, `Событие с id=${eventId} не найдено`);
    }

    // Возврат десериализованного объекта[cite: 18]
    return await response.json();
}

/**
 * Создание новой записи исторического события в системе[cite: 18].
 * Отправляет POST-запрос с полезной нагрузкой JSON[cite: 18].
 *
 * @param {Object} eventData Данные события, соответствующие схеме EventCreate[cite: 18].
 * @returns {Promise<Object>} Созданный объект исторического события с ID[cite: 18].
 * @throws {Error} При ошибках валидации схемы или сбое сохранения[cite: 18].
 */
export async function createEvent(eventData) {
    // Выполнение асинхронного POST-запроса с заголовком application/json[cite: 18]
    const response = await fetch(`${API_BASE}/events/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventData),
    });

    // Валидация ответа сервера и разбор деталей валидации Pydantic[cite: 18]
    if (!response.ok) {
        await parseApiError(response, 'Ошибка при создании события');
    }

    // Возврат созданного объекта события[cite: 18]
    return await response.json();
}

/**
 * Безвозвратное удаление исторического события по его первичному ключу[cite: 18].
 *
 * @param {number} eventId Уникальный идентификатор удаляемого события[cite: 18].
 * @returns {Promise<boolean>} Флаг true при успешном удалении[cite: 18].
 * @throws {Error} При ошибке удаления или если запись не найдена[cite: 18].
 */
export async function deleteEvent(eventId) {
    // Выполнение DELETE-запроса к API[cite: 18]
    const response = await fetch(`${API_BASE}/events/${eventId}`, {
        method: 'DELETE',
    });

    // Валидация статуса ответа (для 204 No Content response.ok равен true)[cite: 18]
    if (!response.ok) {
        await parseApiError(response, `Ошибка при удалении события id=${eventId}`);
    }

    // Успешный возврат подтверждения без парсинга пустого тела ответа[cite: 18]
    return true;
}
