// @vitest-environment happy-dom

/**
 * Модульные тесты интерфейсного компонента встраивания медиа (mediaEmbed.js).
 * Выполняются в виртуальной среде happy-dom с использованием фреймворка Vitest.
 * Проверяют фасад отложенной загрузки, монтирование iframe с атрибутами песочницы,
 * нативный аудиоплеер, откат к безопасным ссылкам и очистку ресурсов в destroy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMediaEmbed } from '../../frontend/js/components/mediaEmbed.js';

describe('Компонент медиа-встраивания (mediaEmbed.js)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('Фасад отложенной загрузки', () => {
        it('не монтирует узел iframe в DOM сразу при инициализации видеокарточки', () => {
            const mediaItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: 'Оборона крепости',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };

            const { element, destroy } = createMediaEmbed(mediaItem);

            expect(element.querySelector('iframe')).toBeNull();
            destroy();
        });

        it('создает контейнер фасада и кнопку воспроизведения с атрибутом aria-label', () => {
            const mediaItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: 'Историческая хроника',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };

            const { element, destroy } = createMediaEmbed(mediaItem);

            const facade = element.querySelector('.timeline-media-facade');
            expect(facade).not.toBeNull();

            const playBtn = element.querySelector('.timeline-media-play-btn');
            expect(playBtn).not.toBeNull();
            expect(playBtn.getAttribute('type')).toBe('button');
            expect(playBtn.getAttribute('aria-label')).toBe('Воспроизвести: Историческая хроника');
            expect(playBtn.textContent).toContain('Смотреть видео');

            destroy();
        });

        it('выводит переданный заголовок события либо подпись по умолчанию в шапке карточки', () => {
            const withTitleItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: 'Битва при Полтаве',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };
            const { element: withTitleEl, destroy: destroyWithTitle } = createMediaEmbed(withTitleItem);
            const titleEl = withTitleEl.querySelector('.timeline-media-title');
            expect(titleEl).not.toBeNull();
            expect(titleEl.textContent).toBe('Битва при Полтаве');
            destroyWithTitle();

            const defaultTitleItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: null,
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };
            const { element: defaultTitleEl, destroy: destroyDefault } = createMediaEmbed(defaultTitleItem);
            const defaultHeading = defaultTitleEl.querySelector('.timeline-media-title');
            expect(defaultHeading.textContent).toBe('Видеоматериал');
            const playBtn = defaultTitleEl.querySelector('.timeline-media-play-btn');
            expect(playBtn.getAttribute('aria-label')).toBe('Воспроизвести медиаматериал');
            destroyDefault();
        });
    });

    describe('Активация iframe по клику', () => {
        it('удаляет фасад и монтирует узел iframe с каноническим адресом и атрибутами', () => {
            const mediaItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: 'Архивная запись',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };

            const { element, destroy } = createMediaEmbed(mediaItem);
            const playBtn = element.querySelector('.timeline-media-play-btn');
            expect(playBtn).not.toBeNull();

            playBtn.click();

            expect(element.querySelector('.timeline-media-facade')).toBeNull();

            const iframe = element.querySelector('iframe.timeline-media-iframe');
            expect(iframe).not.toBeNull();
            expect(iframe.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
            expect(iframe.getAttribute('loading')).toBe('lazy');
            expect(iframe.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
            expect(iframe.getAttribute('title')).toBe('Архивная запись');

            const sandbox = iframe.getAttribute('sandbox');
            expect(sandbox).toContain('allow-scripts');
            expect(sandbox).toContain('allow-same-origin');
            expect(sandbox).toContain('allow-presentation');
            expect(sandbox).not.toContain('allow-top-navigation');

            destroy();
        });

        it('устанавливает корректные директивы атрибута allow для провайдеров YouTube, Rutube и VK', () => {
            const ytItem = {
                media_type: 'video',
                url: 'https://youtu.be/12345678901',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/12345678901',
            };
            const { element: ytEl, destroy: ytDestroy } = createMediaEmbed(ytItem);
            ytEl.querySelector('.timeline-media-play-btn').click();
            const ytIframe = ytEl.querySelector('iframe');
            expect(ytIframe.getAttribute('allow')).toBe(
                'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
            );
            ytDestroy();

            const rutubeItem = {
                media_type: 'video',
                url: 'https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/',
                provider: 'rutube',
                embed_url: 'https://rutube.ru/play/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90',
            };
            const { element: rutubeEl, destroy: rutubeDestroy } = createMediaEmbed(rutubeItem);
            rutubeEl.querySelector('.timeline-media-play-btn').click();
            const rutubeIframe = rutubeEl.querySelector('iframe');
            expect(rutubeIframe.getAttribute('allow')).toBe(
                'clipboard-write; picture-in-picture; fullscreen'
            );
            rutubeDestroy();

            const vkItem = {
                media_type: 'video',
                url: 'https://vk.com/video-1_2',
                provider: 'vk',
                embed_url: 'https://vk.com/video_ext.php?oid=-1&id=2',
            };
            const { element: vkEl, destroy: vkDestroy } = createMediaEmbed(vkItem);
            vkEl.querySelector('.timeline-media-play-btn').click();
            const vkIframe = vkEl.querySelector('iframe');
            expect(vkIframe.getAttribute('allow')).toBe(
                'autoplay; encrypted-media; fullscreen; picture-in-picture; screen-wake-lock'
            );
            vkDestroy();
        });
    });

    describe('Прямое воспроизведение аудио', () => {
        it('монтирует нативный элемент audio без создания фасада и iframe для https mp3-файла', () => {
            const audioItem = {
                media_type: 'audio',
                url: 'https://cdn.history.org/lectures/part1.mp3',
                title: 'Историческая лекция',
                provider: 'direct',
                embed_url: null,
            };

            const { element, destroy } = createMediaEmbed(audioItem);

            expect(element.querySelector('.timeline-media-facade')).toBeNull();
            expect(element.querySelector('iframe')).toBeNull();

            const audioWrapper = element.querySelector('.timeline-media-audio-wrapper');
            expect(audioWrapper).not.toBeNull();

            const audio = element.querySelector('audio.timeline-media-audio');
            expect(audio).not.toBeNull();
            expect(audio.hasAttribute('controls')).toBe(true);
            expect(audio.getAttribute('preload')).toBe('none');
            expect(audio.getAttribute('src')).toBe('https://cdn.history.org/lectures/part1.mp3');

            destroy();
        });
    });

    describe('Отказоустойчивость и резервная ссылка (Fallback)', () => {
        it('создает защищенную гиперссылку источника при несовпадении провайдера или отсутствии embed_url', () => {
            const invalidEmbedItem = {
                media_type: 'video',
                url: 'https://archive.org/details/historical-video',
                title: 'Видео из внешнего архива',
                provider: 'youtube',
                embed_url: null,
            };

            const { element, destroy } = createMediaEmbed(invalidEmbedItem);

            expect(element.querySelector('iframe')).toBeNull();
            expect(element.querySelector('.timeline-media-facade')).toBeNull();

            const fallbackWrapper = element.querySelector('.timeline-media-fallback-wrapper');
            expect(fallbackWrapper).not.toBeNull();

            const sourceLink = element.querySelector('a.timeline-media-source-link');
            expect(sourceLink).not.toBeNull();
            expect(sourceLink.textContent).toBe('Открыть источник');
            expect(sourceLink.getAttribute('href')).toBe('https://archive.org/details/historical-video');
            expect(sourceLink.getAttribute('target')).toBe('_blank');
            expect(sourceLink.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
            expect(sourceLink.getAttribute('aria-label')).toBe('Открыть источник: Видео из внешнего архива');

            destroy();
        });

        it('нейтрализует вредоносный протокол javascript: и выводит сообщение об ошибке', () => {
            const maliciousItem = {
                media_type: 'link',
                url: 'javascript:alert(1)',
                title: 'Вредоносный переход',
                provider: null,
                embed_url: null,
            };

            const { element, destroy } = createMediaEmbed(maliciousItem);

            expect(element.querySelector('a')).toBeNull();

            const unsafeNotice = element.querySelector('span.timeline-media-unsafe');
            expect(unsafeNotice).not.toBeNull();
            expect(unsafeNotice.textContent).toBe('Недопустимый адрес первоисточника');

            destroy();
        });
    });

    describe('Освобождение ресурсов и метод destroy', () => {
        it('устанавливает iframe.src в about:blank и удаляет элемент из DOM при вызове destroy', () => {
            const mediaItem = {
                media_type: 'video',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                title: 'Видеохроника',
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            };

            const { element, destroy } = createMediaEmbed(mediaItem);
            const playBtn = element.querySelector('.timeline-media-play-btn');
            playBtn.click();

            const iframe = element.querySelector('iframe');
            expect(iframe).not.toBeNull();

            const setAttributeSpy = vi.spyOn(iframe, 'setAttribute');

            destroy();

            expect(setAttributeSpy).toHaveBeenCalledWith('src', 'about:blank');
            expect(element.querySelector('iframe')).toBeNull();
            expect(element.querySelector('.timeline-media-frame-wrapper')).toBeNull();
        });

        it('вызывает pause у элемента audio и удаляет его из DOM при вызове destroy', () => {
            const audioItem = {
                media_type: 'audio',
                url: 'https://cdn.history.org/lectures/part2.mp3',
                title: 'Аудиозапись',
                provider: 'direct',
                embed_url: null,
            };

            const { element, destroy } = createMediaEmbed(audioItem);
            const audio = element.querySelector('audio');
            expect(audio).not.toBeNull();

            if (typeof audio.pause !== 'function') {
                audio.pause = () => {};
            }
            const pauseSpy = vi.spyOn(audio, 'pause');

            destroy();

            expect(pauseSpy).toHaveBeenCalled();
            expect(element.querySelector('audio')).toBeNull();
            expect(element.querySelector('.timeline-media-audio-wrapper')).toBeNull();
        });
    });
});
