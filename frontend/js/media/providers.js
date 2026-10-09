/**
 * Клиентский реестр доверенных медиа-провайдеров и валидатор адресов встраивания.
 * Обеспечивает эшелонированную защиту при создании элементов iframe и audio,
 * проверяя протоколы, хосты, порты, префиксы путей и конфигурации песочницы.
 * Модуль изолирован от DOM API и совместим с окружениями браузера и Node.js (Vitest).
 */

/**
 * Конфигурация доверенных провайдеров, хостов встраивания, префиксов путей
 * и нормативных атрибутов песочницы iframe.
 * @type {Readonly<Record<string, Readonly<{ allowedHosts: ReadonlyArray<string>, pathPrefix: string, sandbox: string, allow: string }>>>}
 */
export const PROVIDER_EMBED_CONFIGS = Object.freeze({
    youtube: Object.freeze({
        allowedHosts: Object.freeze([
            'www.youtube-nocookie.com',
            'youtube-nocookie.com',
        ]),
        pathPrefix: '/embed/',
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen',
    }),
    rutube: Object.freeze({
        allowedHosts: Object.freeze(['rutube.ru', 'www.rutube.ru']),
        pathPrefix: '/play/embed/',
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'clipboard-write; picture-in-picture; fullscreen',
    }),
    vk: Object.freeze({
        allowedHosts: Object.freeze(['vk.com', 'www.vk.com']),
        pathPrefix: '/video_ext.php',
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock',
    }),
    yandex: Object.freeze({
        allowedHosts: Object.freeze(['music.yandex.ru']),
        pathPrefix: '/iframe/',
        sandbox: 'allow-scripts allow-same-origin allow-presentation',
        allow: 'clipboard-write',
    }),
});

/**
 * Белый список расширений файлов прямых аудиопотоков.
 * @type {ReadonlyArray<string>}
 */
export const DIRECT_AUDIO_EXTENSIONS = Object.freeze([
    '.mp3',
    '.ogg',
    '.m4a',
    '.wav',
    '.opus',
]);

/**
 * Проверяет соответствие имени хоста белому списку разрешенных доменов провайдера.
 *
 * @param {unknown} hostname Проверяемое имя хоста.
 * @param {unknown} provider Идентификатор провайдера.
 * @returns {boolean} True, если хост разрешен для указанного провайдера.
 */
export function isAllowedEmbedHost(hostname, provider) {
    if (typeof hostname !== 'string' || typeof provider !== 'string') {
        return false;
    }

    const config = PROVIDER_EMBED_CONFIGS[provider];
    if (!config) {
        return false;
    }

    const normalizedHost = hostname.trim().toLowerCase().replace(/\.+$/, '');
    if (normalizedHost.length === 0) {
        return false;
    }

    return config.allowedHosts.includes(normalizedHost);
}

/**
 * Валидирует адрес встраивания перед генерацией узла iframe.
 * Проверяет протокол https:, отсутствие нестандартных сетевых портов,
 * отсутствие учетных данных, валидность хоста и соответствие префикса пути.
 *
 * @param {unknown} embedUrl Проверяемый адрес встраивания.
 * @param {unknown} provider Идентификатор провайдера.
 * @returns {boolean} True, если адрес безопасен и соответствует конфигурации провайдера.
 */
export function validateEmbedUrl(embedUrl, provider) {
    if (typeof embedUrl !== 'string' || typeof provider !== 'string') {
        return false;
    }

    const trimmedUrl = embedUrl.trim();
    if (trimmedUrl.length === 0) {
        return false;
    }

    const config = PROVIDER_EMBED_CONFIGS[provider];
    if (!config) {
        return false;
    }

    let urlObj;
    try {
        urlObj = new globalThis.URL(trimmedUrl);
    } catch {
        return false;
    }

    // Проверка обязательного защищенного протокола https:
    if (urlObj.protocol !== 'https:') {
        return false;
    }

    // Запрет нестандартных сетевых портов (порт по умолчанию 443 нормализуется в пустую строку)
    if (urlObj.port !== '') {
        return false;
    }

    // Защита от фишинга через внедрение учетных данных (user:pass@host)
    if (urlObj.username || urlObj.password) {
        return false;
    }

    // Проверка соответствия хоста белому списку доменов провайдера
    if (!isAllowedEmbedHost(urlObj.hostname, provider)) {
        return false;
    }

    // Проверка пути на соответствие доверенному префиксу встраивания
    if (!urlObj.pathname.startsWith(config.pathPrefix)) {
        return false;
    }

    return true;
}

/**
 * Валидирует веб-адрес прямого аудиофайла.
 * Проверяет протокол https:, отсутствие учетных данных и разрешенное расширение файла.
 *
 * @param {unknown} url Проверяемый адрес аудиопотока.
 * @returns {boolean} True, если адрес безопасен и указывает на допустимый аудиофайл.
 */
export function isAllowedDirectAudioUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
        return false;
    }

    let urlObj;
    try {
        urlObj = new globalThis.URL(trimmedUrl);
    } catch {
        return false;
    }

    // Проверка обязательного защищенного протокола https:
    if (urlObj.protocol !== 'https:') {
        return false;
    }

    // Защита от учетных данных в URL
    if (urlObj.username || urlObj.password) {
        return false;
    }

    const pathLower = urlObj.pathname.toLowerCase();
    return DIRECT_AUDIO_EXTENSIONS.some((ext) => pathLower.endsWith(ext));
}

/**
 * Возвращает неизменяемый объект параметров песочницы и разрешений iframe для провайдера.
 *
 * @param {unknown} provider Идентификатор провайдера.
 * @returns {Readonly<{ sandbox: string, allow: string }>|null} Объект атрибутов или null.
 */
export function getProviderEmbedAttributes(provider) {
    if (typeof provider !== 'string') {
        return null;
    }

    const config = PROVIDER_EMBED_CONFIGS[provider];
    if (!config) {
        return null;
    }

    return Object.freeze({
        sandbox: config.sandbox,
        allow: config.allow,
    });
}
