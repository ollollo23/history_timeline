/**
 * Модульные тесты клиентского реестра медиа-провайдеров (providers.js).
 * Проверяют белый список доверенных хостов встраивания, валидацию embed_url,
 * защиту от перекрестной подмены провайдеров (cross-provider tampering),
 * изоляцию параметров iframe-песочницы и проверку прямых HTTPS-аудиопотоков.
 */

import { describe, it, expect } from 'vitest';
import {
    isAllowedEmbedHost,
    validateEmbedUrl,
    isAllowedDirectAudioUrl,
    getProviderEmbedAttributes,
    DIRECT_AUDIO_EXTENSIONS,
} from '../../frontend/js/media/providers.js';

describe('Модуль реестра медиа-провайдеров и валидации встраивания (providers.js)', () => {
    describe('Функция проверки хоста isAllowedEmbedHost', () => {
        it('подтверждает валидность точных хостов YouTube nocookie', () => {
            expect(isAllowedEmbedHost('youtube-nocookie.com', 'youtube')).toBe(true);
            expect(isAllowedEmbedHost('www.youtube-nocookie.com', 'youtube')).toBe(true);
            expect(isAllowedEmbedHost('YOUTUBE-NOCOOKIE.COM', 'youtube')).toBe(true);
            expect(isAllowedEmbedHost('www.youtube-nocookie.com.', 'youtube')).toBe(true);
        });

        it('отклоняет стандартный домен youtube.com в качестве embed-хоста', () => {
            expect(isAllowedEmbedHost('youtube.com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('www.youtube.com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('m.youtube.com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('youtu.be', 'youtube')).toBe(false);
        });

        it('подтверждает валидность доверенных хостов Rutube', () => {
            expect(isAllowedEmbedHost('rutube.ru', 'rutube')).toBe(true);
            expect(isAllowedEmbedHost('www.rutube.ru', 'rutube')).toBe(true);
            expect(isAllowedEmbedHost('RUTUBE.RU', 'rutube')).toBe(true);
        });

        it('подтверждает валидность доверенных хостов VK Video', () => {
            expect(isAllowedEmbedHost('vk.com', 'vk')).toBe(true);
            expect(isAllowedEmbedHost('www.vk.com', 'vk')).toBe(true);
            expect(isAllowedEmbedHost('VK.COM', 'vk')).toBe(true);
        });

        it('подтверждает валидность доверенного хоста Яндекс.Музыки', () => {
            expect(isAllowedEmbedHost('music.yandex.ru', 'yandex')).toBe(true);
            expect(isAllowedEmbedHost('MUSIC.YANDEX.RU', 'yandex')).toBe(true);
        });

        it('отклоняет фишинговые домены с похожими префиксами и суффиксами', () => {
            expect(isAllowedEmbedHost('evilyoutube-nocookie.com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('youtube-nocookie.com.attacker.org', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('rutube.ru.evil.com', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('fake-rutube.ru', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('music.yandex.ru.attacker.org', 'yandex')).toBe(false);
            expect(isAllowedEmbedHost('yandex.ru', 'yandex')).toBe(false);
        });

        it('проверяет нечувствительность к регистру доверенных хостов', () => {
            expect(isAllowedEmbedHost('YOUTUBE-NOCOOKIE.COM', 'youtube')).toBe(true);
            expect(isAllowedEmbedHost('wWw.YoUtUbE-nOcOoKiE.cOm', 'youtube')).toBe(true);
            expect(isAllowedEmbedHost('RuTuBe.Ru', 'rutube')).toBe(true);
            expect(isAllowedEmbedHost('Vk.CoM', 'vk')).toBe(true);
            expect(isAllowedEmbedHost('MuSiC.yAnDeX.rU', 'yandex')).toBe(true);
        });

        it('отклоняет хосты с поддельными доменными зонами', () => {
            expect(isAllowedEmbedHost('youtube-nocookie.org', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('youtube-nocookie.net', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('rutube.com', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('vk.org', 'vk')).toBe(false);
            expect(isAllowedEmbedHost('music.yandex.com', 'yandex')).toBe(false);
        });

        it('отклоняет хосты с посторонними поддоменами', () => {
            expect(isAllowedEmbedHost('evil.youtube-nocookie.com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('sub.rutube.ru', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('api.vk.com', 'vk')).toBe(false);
            expect(isAllowedEmbedHost('radio.music.yandex.ru', 'yandex')).toBe(false);
        });

        it('отклоняет IP-адреса и строки с внедренными пробелами или спецсимволами', () => {
            expect(isAllowedEmbedHost('127.0.0.1', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('192.168.1.1', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('[::1]', 'vk')).toBe(false);
            expect(isAllowedEmbedHost('youtube-nocookie .com', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('rutube\t.ru', 'rutube')).toBe(false);
            expect(isAllowedEmbedHost('vk\0.com', 'vk')).toBe(false);
        });

        it('возвращает false для неизвестных провайдеров и некорректных типов данных', () => {
            expect(isAllowedEmbedHost('youtube-nocookie.com', 'unknown_provider')).toBe(false);
            expect(isAllowedEmbedHost('youtube-nocookie.com', 'direct')).toBe(false);
            expect(isAllowedEmbedHost('', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('   ', 'youtube')).toBe(false);
            expect(isAllowedEmbedHost(null, 'youtube')).toBe(false);
            expect(isAllowedEmbedHost(undefined, 'youtube')).toBe(false);
            expect(isAllowedEmbedHost('rutube.ru', null)).toBe(false);
        });
    });

    describe('Функция валидации адреса встраивания validateEmbedUrl', () => {
        it('подтверждает валидный канонический embed_url YouTube', () => {
            const url = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
            expect(validateEmbedUrl(url, 'youtube')).toBe(true);

            const urlNoWww = 'https://youtube-nocookie.com/embed/dQw4w9WgXcQ';
            expect(validateEmbedUrl(urlNoWww, 'youtube')).toBe(true);
        });

        it('подтверждает валидный канонический embed_url Rutube', () => {
            const url = 'https://rutube.ru/play/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90';
            expect(validateEmbedUrl(url, 'rutube')).toBe(true);

            const urlWww = 'https://www.rutube.ru/play/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90';
            expect(validateEmbedUrl(urlWww, 'rutube')).toBe(true);
        });

        it('подтверждает валидный канонический embed_url VK Video', () => {
            const url = 'https://vk.com/video_ext.php?oid=-22822305&id=456239018&hash=abcdef1234';
            expect(validateEmbedUrl(url, 'vk')).toBe(true);

            const urlNoHash = 'https://vk.com/video_ext.php?oid=12345&id=67890';
            expect(validateEmbedUrl(urlNoHash, 'vk')).toBe(true);
        });

        it('подтверждает валидные канонические embed_url Яндекс.Музыки', () => {
            const trackUrl = 'https://music.yandex.ru/iframe/#track/67890/12345';
            expect(validateEmbedUrl(trackUrl, 'yandex')).toBe(true);

            const albumUrl = 'https://music.yandex.ru/iframe/#album/12345';
            expect(validateEmbedUrl(albumUrl, 'yandex')).toBe(true);
        });

        it('блокирует перекрестную подмену адресов между зарегистрированными провайдерами', () => {
            // Rutube адрес с провайдером youtube
            expect(
                validateEmbedUrl('https://rutube.ru/play/embed/12345', 'youtube')
            ).toBe(false);

            // VK адрес с провайдером rutube
            expect(
                validateEmbedUrl('https://vk.com/video_ext.php?oid=1&id=2', 'rutube')
            ).toBe(false);

            // Яндекс.Музыка с провайдером vk
            expect(
                validateEmbedUrl('https://music.yandex.ru/iframe/#album/123', 'vk')
            ).toBe(false);

            // YouTube адрес с провайдером yandex
            expect(
                validateEmbedUrl(
                    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
                    'yandex'
                )
            ).toBe(false);

            // Сторонний адрес Vimeo с любым из зарегистрированных провайдеров
            const vimeoUrl = 'https://vimeo.com/video/12345';
            expect(validateEmbedUrl(vimeoUrl, 'youtube')).toBe(false);
            expect(validateEmbedUrl(vimeoUrl, 'rutube')).toBe(false);
            expect(validateEmbedUrl(vimeoUrl, 'vk')).toBe(false);
            expect(validateEmbedUrl(vimeoUrl, 'yandex')).toBe(false);
        });

        it('отклоняет незащищенный протокол http для всех провайдеров', () => {
            expect(validateEmbedUrl('http://www.youtube-nocookie.com/embed/123', 'youtube')).toBe(false);
            expect(validateEmbedUrl('http://rutube.ru/play/embed/123', 'rutube')).toBe(false);
            expect(validateEmbedUrl('http://vk.com/video_ext.php?oid=1&id=2', 'vk')).toBe(false);
            expect(validateEmbedUrl('http://music.yandex.ru/iframe/#album/1', 'yandex')).toBe(false);
        });

        it('отклоняет несоответствие хоста и переданного идентификатора провайдера', () => {
            const rutubeUrl = 'https://rutube.ru/play/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90';
            expect(validateEmbedUrl(rutubeUrl, 'youtube')).toBe(false);

            const youtubeUrl = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
            expect(validateEmbedUrl(youtubeUrl, 'vk')).toBe(false);
        });

        it('отклоняет некорректные префиксы путей URL', () => {
            const wrongYoutubePath = 'https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ';
            expect(validateEmbedUrl(wrongYoutubePath, 'youtube')).toBe(false);

            const wrongRutubePath = 'https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/';
            expect(validateEmbedUrl(wrongRutubePath, 'rutube')).toBe(false);

            const wrongVkPath = 'https://vk.com/video-22822305_456239018';
            expect(validateEmbedUrl(wrongVkPath, 'vk')).toBe(false);

            const wrongYandexPath = 'https://music.yandex.ru/album/123/track/456';
            expect(validateEmbedUrl(wrongYandexPath, 'yandex')).toBe(false);
        });

        it('отклоняет URL с нестандартными сетевыми портами', () => {
            expect(
                validateEmbedUrl('https://www.youtube-nocookie.com:8443/embed/123', 'youtube')
            ).toBe(false);
            expect(
                validateEmbedUrl('https://rutube.ru:8080/play/embed/123', 'rutube')
            ).toBe(false);
            expect(
                validateEmbedUrl('https://vk.com:444/video_ext.php?oid=1&id=2', 'vk')
            ).toBe(false);
            expect(
                validateEmbedUrl('https://music.yandex.ru:8000/iframe/#album/1', 'yandex')
            ).toBe(false);
        });

        it('отклоняет протокольно-относительные адреса и двойные слэши в путях', () => {
            expect(
                validateEmbedUrl('//www.youtube-nocookie.com/embed/123', 'youtube')
            ).toBe(false);
            expect(
                validateEmbedUrl('//rutube.ru/play/embed/123', 'rutube')
            ).toBe(false);
            expect(
                validateEmbedUrl('https://www.youtube-nocookie.com//embed/123', 'youtube')
            ).toBe(false);
        });

        it('отклоняет опасные схемы и псевдопротоколы', () => {
            expect(validateEmbedUrl('javascript:alert(1)', 'youtube')).toBe(false);
            expect(validateEmbedUrl('data:text/html,<iframe></iframe>', 'youtube')).toBe(false);
            expect(validateEmbedUrl('vbscript:msgbox(1)', 'rutube')).toBe(false);
            expect(validateEmbedUrl('file:///etc/passwd', 'vk')).toBe(false);
            expect(validateEmbedUrl('blob:https://music.yandex.ru/uuid', 'yandex')).toBe(false);
        });

        it('отклоняет URL с внедренными учетными данными пользователя (userinfo / фишинг)', () => {
            const urlWithCreds = 'https://user:pass@rutube.ru/play/embed/123';
            expect(validateEmbedUrl(urlWithCreds, 'rutube')).toBe(false);

            const urlWithUserOnly = 'https://admin@vk.com/video_ext.php?oid=1&id=2';
            expect(validateEmbedUrl(urlWithUserOnly, 'vk')).toBe(false);

            const ytWithCreds = 'https://admin:secret@www.youtube-nocookie.com/embed/123';
            expect(validateEmbedUrl(ytWithCreds, 'youtube')).toBe(false);
        });

        it('отклоняет относительные ссылки и нестроковые входные данные', () => {
            expect(validateEmbedUrl('/embed/dQw4w9WgXcQ', 'youtube')).toBe(false);
            expect(validateEmbedUrl('', 'youtube')).toBe(false);
            expect(validateEmbedUrl(null, 'youtube')).toBe(false);
            expect(validateEmbedUrl(undefined, 'youtube')).toBe(false);
        });
    });

    describe('Функция валидации прямого аудио isAllowedDirectAudioUrl', () => {
        it('подтверждает допустимость ссылок https для всех регламентированных расширений', () => {
            DIRECT_AUDIO_EXTENSIONS.forEach((ext) => {
                const url = `https://cdn.example.org/audio/lecture${ext}`;
                expect(isAllowedDirectAudioUrl(url)).toBe(true);
            });
        });

        it('сохраняет параметры запроса и фрагменты якорей при проверке расширения', () => {
            const url = 'https://cdn.example.org/audio/track.mp3?token=secret#part1';
            expect(isAllowedDirectAudioUrl(url)).toBe(true);

            const urlUppercase = 'https://cdn.example.org/audio/RECORDING.OGG?quality=high';
            expect(isAllowedDirectAudioUrl(urlUppercase)).toBe(true);
        });

        it('поддерживает регистронезависимые расширения аудиофайлов (.MP3, .Ogg, .WAV)', () => {
            expect(isAllowedDirectAudioUrl('https://cdn.example.org/audio/test.MP3')).toBe(true);
            expect(isAllowedDirectAudioUrl('https://cdn.example.org/audio/test.Ogg')).toBe(true);
            expect(isAllowedDirectAudioUrl('https://cdn.example.org/audio/test.WAV')).toBe(true);
            expect(isAllowedDirectAudioUrl('https://cdn.example.org/audio/test.M4A')).toBe(true);
            expect(isAllowedDirectAudioUrl('https://cdn.example.org/audio/test.OPUS')).toBe(true);
        });

        it('отклоняет незащищенный протокол http для прямых аудиофайлов', () => {
            expect(isAllowedDirectAudioUrl('http://example.com/audio.mp3')).toBe(false);
            expect(isAllowedDirectAudioUrl('http://cdn.history.org/track.wav')).toBe(false);
        });

        it('отклоняет URL, где аудио-расширение присутствует только в query-параметрах', () => {
            expect(
                isAllowedDirectAudioUrl('https://cdn.example.com/stream?file=test.mp3')
            ).toBe(false);
            expect(
                isAllowedDirectAudioUrl('https://cdn.example.com/api/get?track=song.ogg')
            ).toBe(false);
        });

        it('отклоняет исполняемые, плейлист- и текстовые расширения файлов', () => {
            expect(isAllowedDirectAudioUrl('https://example.com/video.mp4')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/clip.avi')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/playlist.m3u8')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/manifest.mpd')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/text.txt')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/script.js')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/index.html')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/api.php')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/run.sh')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/app.exe')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/archive.zip')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/doc.pdf')).toBe(false);
        });

        it('отклоняет URL без расширения файла, с userinfo или с недопустимой структурой', () => {
            expect(isAllowedDirectAudioUrl('https://example.com/audio-stream')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://example.com/')).toBe(false);
            expect(isAllowedDirectAudioUrl('https://user:pass@cdn.example.com/audio.mp3')).toBe(false);
            expect(isAllowedDirectAudioUrl('')).toBe(false);
            expect(isAllowedDirectAudioUrl(null)).toBe(false);
            expect(isAllowedDirectAudioUrl(undefined)).toBe(false);
            expect(isAllowedDirectAudioUrl(12345)).toBe(false);
        });
    });

    describe('Функция получения параметров песочницы getProviderEmbedAttributes', () => {
        it('возвращает непустые строки sandbox и allow для всех зарегистрированных провайдеров', () => {
            const supportedProviders = ['youtube', 'rutube', 'vk', 'yandex'];

            supportedProviders.forEach((provider) => {
                const attrs = getProviderEmbedAttributes(provider);
                expect(attrs).not.toBeNull();
                expect(typeof attrs.sandbox).toBe('string');
                expect(attrs.sandbox.length).toBeGreaterThan(0);
                expect(typeof attrs.allow).toBe('string');
                expect(attrs.allow.length).toBeGreaterThan(0);
            });
        });

        it('гарантирует обязательные токены песочницы и исключает allow-top-navigation', () => {
            const supportedProviders = ['youtube', 'rutube', 'vk', 'yandex'];

            supportedProviders.forEach((provider) => {
                const attrs = getProviderEmbedAttributes(provider);
                const tokens = attrs.sandbox.split(' ');

                expect(tokens).toContain('allow-scripts');
                expect(tokens).toContain('allow-same-origin');
                expect(tokens).toContain('allow-presentation');
                expect(tokens).not.toContain('allow-top-navigation');
                expect(tokens).not.toContain('allow-top-navigation-by-user-activation');
            });
        });

        it('возвращает null для прямого аудио и неизвестных провайдеров', () => {
            expect(getProviderEmbedAttributes('direct')).toBeNull();
            expect(getProviderEmbedAttributes('custom_provider')).toBeNull();
            expect(getProviderEmbedAttributes('')).toBeNull();
            expect(getProviderEmbedAttributes(null)).toBeNull();
            expect(getProviderEmbedAttributes(undefined)).toBeNull();
        });

        it('возвращает неизменяемый (замороженный) объект конфигурации', () => {
            const attrs = getProviderEmbedAttributes('youtube');
            expect(Object.isFrozen(attrs)).toBe(true);
        });
    });
});
