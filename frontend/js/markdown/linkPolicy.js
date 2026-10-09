/**
 * Модуль валидации, санитизации и формирования безопасных атрибутов внешних ссылок.
 * Предотвращает XSS-атаки через недоверенные протоколы (javascript:, data:, vbscript:)
 * и обеспечивает безопасное открывание ссылок согласно стандартам безопасности.
 *
 * Архитектурные принципы:
 * 1. Изоляция от DOM: модуль не использует document, window, DOMParser и HTMLElement.
 * 2. Анализ через WHATWG URL: проверка схемы и структуры выполняется парсером globalThis.URL.
 * 3. Строгий белый список: разрешены только протоколы http: и https:.
 * 4. Защита от фишинга: ссылки с внедренными учетными данными (userinfo) блокируются.
 * 5. Неизменяемость: результирующие наборы атрибутов защищены через Object.freeze.
 */

/**
 * Белый список допустимых протоколов для внешних ссылок.
 * @type {Readonly<Set<string>>}
 */
export const ALLOWED_LINK_PROTOCOLS = Object.freeze(new Set(['http:', 'https:']));

/**
 * Черный список префиксов заведомо опасных псевдопротоколов.
 * @type {ReadonlyArray<string>}
 */
export const FORBIDDEN_PROTOCOLS_PREFIXES = Object.freeze([
    'javascript:',
    'data:',
    'vbscript:',
    'file:',
    'blob:',
]);

/**
 * Эталонное значение атрибута rel для внешних ссылок.
 * Защищает от перехода по контексту window.opener, утечки реферера и разметки спама.
 * @type {string}
 */
export const SAFE_EXTERNAL_LINK_REL = 'noopener noreferrer nofollow ugc';

/**
 * Эталонное значение атрибута target для внешних ссылок.
 * Открывает внешние документы в новой изолированной вкладке браузера.
 * @type {string}
 */
export const SAFE_EXTERNAL_LINK_TARGET = '_blank';

/**
 * Очистка и предварительная нормализация входного строкового URL.
 * Удаляет непечатаемые символы и пресекает обход схемы через внедренные пробелы.
 *
 * @param {unknown} rawUrl Исходный адрес для проверки.
 * @returns {string|null} Очищенный URL или null, если входные данные невалидны.
 */
export function cleanRawUrl(rawUrl) {
    if (typeof rawUrl !== 'string') {
        return null;
    }

    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) {
        return null;
    }

    // Проверка наличия символа двоеточия
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex !== -1) {
        const protocolPart = trimmed.slice(0, colonIndex);
        // Запрет пробелов, табуляций и непечатаемых символов до первого двоеточия
        // eslint-disable-next-line no-control-regex
        if (/\s/.test(protocolPart) || /[\x00-\x20\x7F]/.test(protocolPart)) {
            return null;
        }
    }

    // Удаление ASCII-управляющих символов (0x00-0x1F, 0x7F) и нулевых байтов
    // eslint-disable-next-line no-control-regex
    const sanitized = trimmed.replace(/[\x00-\x1F\x7F]/g, '');
    if (sanitized.length === 0) {
        return null;
    }

    return sanitized;
}

/**
 * Проверяет безопасность строкового адреса ссылки.
 * Разрешены только протоколы http: и https: с валидным хостом и без учетных данных.
 *
 * @param {unknown} rawUrl Проверяемый строковый URL.
 * @returns {boolean} True, если ссылка безопасна для вставки в разметку.
 */
export function isSafeLinkUrl(rawUrl) {
    const cleanedUrl = cleanRawUrl(rawUrl);
    if (!cleanedUrl) {
        return false;
    }

    const lower = cleanedUrl.toLowerCase();
    for (let i = 0; i < FORBIDDEN_PROTOCOLS_PREFIXES.length; i++) {
        if (lower.startsWith(FORBIDDEN_PROTOCOLS_PREFIXES[i])) {
            return false;
        }
    }

    let urlObj;
    try {
        urlObj = new globalThis.URL(cleanedUrl);
    } catch {
        return false;
    }

    const protocol = urlObj.protocol.toLowerCase();
    if (!ALLOWED_LINK_PROTOCOLS.has(protocol)) {
        return false;
    }

    const hostname = urlObj.hostname;
    if (
        !hostname ||
        typeof hostname !== 'string' ||
        hostname.trim().length === 0 ||
        /\s/.test(hostname)
    ) {
        return false;
    }

    // Защита от фишинга через учетные данные пользователя (user:pass@host)
    if (urlObj.username || urlObj.password) {
        return false;
    }

    return true;
}

/**
 * Санитизирует входной URL, возвращая нормализованный канонический адрес href.
 * При обнаружении недопустимых или потенциально опасных протоколов возвращает null.
 *
 * @param {unknown} rawUrl Исходный адрес ссылки.
 * @returns {string|null} Нормализованный безопасный URL или null.
 */
export function sanitizeLinkUrl(rawUrl) {
    const cleanedUrl = cleanRawUrl(rawUrl);
    if (!cleanedUrl) {
        return null;
    }

    if (!isSafeLinkUrl(rawUrl)) {
        return null;
    }

    try {
        const urlObj = new globalThis.URL(cleanedUrl);
        return urlObj.href;
    } catch {
        return null;
    }
}

/**
 * Формирует безопасный набор HTML-атрибутов для внешней гиперссылки.
 * При невалидном или опасном адресе возвращает null.
 *
 * @param {unknown} rawUrl Исходный адрес ссылки.
 * @param {string|null} [title=null] Опциональный заголовок всплывающей подсказки ссылки.
 * @returns {Readonly<{ href: string, target: string, rel: string, title: string|null }>|null}
 */
export function getSafeLinkAttributes(rawUrl, title = null) {
    const sanitizedHref = sanitizeLinkUrl(rawUrl);
    if (!sanitizedHref) {
        return null;
    }

    const cleanTitle =
        typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;

    return Object.freeze({
        href: sanitizedHref,
        target: SAFE_EXTERNAL_LINK_TARGET,
        rel: SAFE_EXTERNAL_LINK_REL,
        title: cleanTitle,
    });
}
