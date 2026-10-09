/**
 * Компонент безопасного встраивания мультимедийных ресурсов с фасадом отложенной загрузки.
 * Предотвращает несанкционированную загрузку сторонних скриптов до явного взаимодействия пользователя,
 * изолирует контексты исполнения во фреймах через атрибуты sandbox и referrerpolicy,
 * а также гарантирует остановку воспроизведения и освобождение ресурсов при демонтаже.
 */

import {
    validateEmbedUrl,
    isAllowedDirectAudioUrl,
    getProviderEmbedAttributes,
} from '../media/providers.js';
import { getSafeLinkAttributes } from '../markdown/linkPolicy.js';

/**
 * Фабричная функция создания интерфейсного компонента медиа-вложения.
 *
 * @param {Object} mediaItem Описание медиа-ресурса.
 * @param {string} mediaItem.media_type Тип ресурса (video, audio, image, link).
 * @param {string} mediaItem.url Исходный веб-адрес ресурса.
 * @param {string|null} [mediaItem.title] Название или краткая подпись к материалу.
 * @param {string|null} [mediaItem.provider] Зарегистрированный провайдер (youtube, vk, rutube, yandex, direct).
 * @param {string|null} [mediaItem.embed_url] Серверный канонический адрес для безопасного встраивания.
 * @param {Object} [options={}] Дополнительные параметры инициализации.
 * @param {Document} [options.documentRef] Контекст документа (по умолчанию globalThis.document).
 * @returns {{ element: HTMLElement, destroy: () => void }} Корневой элемент и функция очистки ресурсов.
 */
export function createMediaEmbed(mediaItem, options = {}) {
    const doc = options.documentRef || globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') {
        throw new Error('DOM document is required for creating media embed component');
    }

    // Внутренние ссылки на управляющие узлы для корректной очистки в destroy
    let facadeEl = null;
    let playBtnEl = null;
    let onPlayClick = null;
    let frameWrapperEl = null;
    let iframeEl = null;
    let audioWrapperEl = null;
    let audioEl = null;

    // Создание корневой карточки медиа-ресурса
    const card = doc.createElement('article');
    card.className = 'timeline-media-card';

    // Создание шапки карточки с заголовком
    const header = doc.createElement('header');
    header.className = 'timeline-media-header';

    const titleHeading = doc.createElement('h4');
    titleHeading.className = 'timeline-media-title';

    let displayTitle = '';
    if (mediaItem && typeof mediaItem.title === 'string' && mediaItem.title.trim().length > 0) {
        displayTitle = mediaItem.title.trim();
    } else if (mediaItem && mediaItem.media_type === 'video') {
        displayTitle = 'Видеоматериал';
    } else if (mediaItem && mediaItem.media_type === 'audio') {
        displayTitle = 'Аудиозапись';
    } else {
        displayTitle = 'Материал';
    }
    titleHeading.textContent = displayTitle;

    header.appendChild(titleHeading);
    card.appendChild(header);

    // Проверка условий активации ветки интерактивного внешнего встраивания
    const isEmbedCandidate =
        mediaItem &&
        (mediaItem.media_type === 'video' ||
            (mediaItem.media_type === 'audio' && mediaItem.provider === 'yandex'));

    const canEmbed =
        isEmbedCandidate &&
        typeof mediaItem.embed_url === 'string' &&
        typeof mediaItem.provider === 'string' &&
        validateEmbedUrl(mediaItem.embed_url, mediaItem.provider);

    // Проверка условий активации ветки прямого воспроизведения аудиофайла
    const isDirectAudio =
        mediaItem &&
        mediaItem.media_type === 'audio' &&
        typeof mediaItem.url === 'string' &&
        isAllowedDirectAudioUrl(mediaItem.url);

    if (canEmbed) {
        // Ветка 1: Отложенная загрузка внешнего плеера через интерактивный фасад
        facadeEl = doc.createElement('div');
        facadeEl.className = 'timeline-media-facade';

        playBtnEl = doc.createElement('button');
        playBtnEl.type = 'button';
        playBtnEl.className = 'timeline-media-play-btn';

        const ariaLabelText =
            mediaItem.title && mediaItem.title.trim().length > 0
                ? `Воспроизвести: ${mediaItem.title.trim()}`
                : 'Воспроизвести медиаматериал';
        playBtnEl.setAttribute('aria-label', ariaLabelText);

        const actionLabel =
            mediaItem.media_type === 'audio' ? 'Слушать запись' : 'Смотреть видео';
        playBtnEl.textContent = `▶ ${actionLabel}`;

        onPlayClick = () => {
            // Удаление фасада перед монтированием внешнего плеера
            if (facadeEl && facadeEl.parentNode) {
                facadeEl.parentNode.removeChild(facadeEl);
                facadeEl = null;
            }

            frameWrapperEl = doc.createElement('div');
            frameWrapperEl.className = 'timeline-media-frame-wrapper';

            const embedAttrs = getProviderEmbedAttributes(mediaItem.provider);

            iframeEl = doc.createElement('iframe');
            iframeEl.className = 'timeline-media-iframe';
            iframeEl.setAttribute('src', mediaItem.embed_url);
            iframeEl.setAttribute('loading', 'lazy');
            iframeEl.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

            if (embedAttrs) {
                iframeEl.setAttribute('sandbox', embedAttrs.sandbox);
                iframeEl.setAttribute('allow', embedAttrs.allow);
            }

            const frameTitle =
                mediaItem.title && mediaItem.title.trim().length > 0
                    ? mediaItem.title.trim()
                    : 'Встроенный медиаплеер';
            iframeEl.setAttribute('title', frameTitle);

            frameWrapperEl.appendChild(iframeEl);
            card.appendChild(frameWrapperEl);

            try {
                iframeEl.focus();
            } catch {
                // Фокус может быть заблокирован политиками песочницы или тестовой средой
            }
        };

        playBtnEl.addEventListener('click', onPlayClick);
        facadeEl.appendChild(playBtnEl);
        card.appendChild(facadeEl);
    } else if (isDirectAudio) {
        // Ветка 2: Нативное воспроизведение прямого аудиофайла
        audioWrapperEl = doc.createElement('div');
        audioWrapperEl.className = 'timeline-media-audio-wrapper';

        audioEl = doc.createElement('audio');
        audioEl.className = 'timeline-media-audio';
        audioEl.setAttribute('controls', '');
        audioEl.setAttribute('preload', 'none');
        audioEl.setAttribute('src', mediaItem.url);

        const fallbackNotice = doc.createTextNode(
            'Ваш браузер не поддерживает встроенное воспроизведение аудио.'
        );
        audioEl.appendChild(fallbackNotice);

        audioWrapperEl.appendChild(audioEl);
        card.appendChild(audioWrapperEl);
    } else {
        // Ветка 3: Отказоустойчивый вывод гиперссылки на первоисточник
        const fallbackWrapper = doc.createElement('div');
        fallbackWrapper.className = 'timeline-media-fallback-wrapper';

        const rawUrl = mediaItem && typeof mediaItem.url === 'string' ? mediaItem.url : '';
        const rawTitle = mediaItem && typeof mediaItem.title === 'string' ? mediaItem.title : null;
        const safeLinkAttrs = getSafeLinkAttributes(rawUrl, rawTitle);

        if (safeLinkAttrs) {
            const sourceLink = doc.createElement('a');
            sourceLink.className = 'timeline-media-source-link';
            sourceLink.setAttribute('href', safeLinkAttrs.href);
            sourceLink.setAttribute('target', safeLinkAttrs.target);
            sourceLink.setAttribute('rel', safeLinkAttrs.rel);
            sourceLink.textContent = 'Открыть источник';

            if (safeLinkAttrs.title) {
                sourceLink.setAttribute(
                    'aria-label',
                    `Открыть источник: ${safeLinkAttrs.title}`
                );
            }

            fallbackWrapper.appendChild(sourceLink);
        } else {
            const unsafeNotice = doc.createElement('span');
            unsafeNotice.className = 'timeline-media-unsafe';
            unsafeNotice.textContent = 'Недопустимый адрес первоисточника';
            fallbackWrapper.appendChild(unsafeNotice);
        }

        card.appendChild(fallbackWrapper);
    }

    /**
     * Метод утилизации компонента: останавливает активное воспроизведение,
     * очищает внешние сетевые фреймы и снимает зарегистрированные обработчики событий.
     */
    function destroy() {
        if (playBtnEl && onPlayClick) {
            playBtnEl.removeEventListener('click', onPlayClick);
            onPlayClick = null;
        }

        if (iframeEl) {
            iframeEl.setAttribute('src', 'about:blank');
            if (iframeEl.parentNode) {
                iframeEl.parentNode.removeChild(iframeEl);
            }
            iframeEl = null;
        }

        if (frameWrapperEl && frameWrapperEl.parentNode) {
            frameWrapperEl.parentNode.removeChild(frameWrapperEl);
            frameWrapperEl = null;
        }

        if (audioEl) {
            try {
                audioEl.pause();
            } catch {
                // Игнорируем исключения при попытке паузы незапущенного аудио
            }
            audioEl.setAttribute('src', '');
            if (audioEl.parentNode) {
                audioEl.parentNode.removeChild(audioEl);
            }
            audioEl = null;
        }

        if (audioWrapperEl && audioWrapperEl.parentNode) {
            audioWrapperEl.parentNode.removeChild(audioWrapperEl);
            audioWrapperEl = null;
        }

        if (facadeEl && facadeEl.parentNode) {
            facadeEl.parentNode.removeChild(facadeEl);
            facadeEl = null;
        }

        playBtnEl = null;
    }

    return {
        element: card,
        destroy,
    };
}
