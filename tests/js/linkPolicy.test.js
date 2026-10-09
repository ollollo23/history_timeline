/**
 * Модульные тесты политики безопасности внешних гиперссылок (linkPolicy.js).
 * Проверяют фильтрацию протоколов, защиту от XSS-векторов обхода схем,
 * отсечение учетных данных и относительных ссылок, генерацию атрибутов,
 * а также исчерпывающие параметризованные таблицы допустимых и недопустимых URL.
 */

import { describe, it, expect } from 'vitest';
import {
    isSafeLinkUrl,
    sanitizeLinkUrl,
    getSafeLinkAttributes,
    SAFE_EXTERNAL_LINK_REL,
    SAFE_EXTERNAL_LINK_TARGET,
} from '../../frontend/js/markdown/linkPolicy.js';

/**
 * Параметризованная таблица допустимых URL-адресов.
 * Содержит кортежи вида [описание, входной_URL, ожидаемый_нормализованный_URL].
 */
const VALID_URLS_CASES = [
    ['стандартный https', 'https://example.com', 'https://example.com/'],
    ['стандартный http', 'http://example.org/path', 'http://example.org/path'],
    [
        'глубокий поддомен',
        'https://sub.domain.deep.example.com/api/v1/resource',
        'https://sub.domain.deep.example.com/api/v1/resource',
    ],
    [
        'нестандартный порт',
        'https://history.archive.org:8443/catalog',
        'https://history.archive.org:8443/catalog',
    ],
    ['стандартный порт http', 'http://example.com:80/index.html', 'http://example.com/index.html'],
    ['стандартный порт https', 'https://example.com:443/index.html', 'https://example.com/index.html'],
    ['IPv4-адрес', 'http://192.168.1.1:8080/timeline', 'http://192.168.1.1:8080/timeline'],
    ['IPv6-адрес', 'http://[::1]:8000/api', 'http://[::1]:8000/api'],
    [
        'параметры запроса с экранированием',
        'https://search.org/find?q=rome%20empire&page=2&sort=asc',
        'https://search.org/find?q=rome%20empire&page=2&sort=asc',
    ],
    ['якорь фрагмента', 'https://wiki.org/history#early-republic', 'https://wiki.org/history#early-republic'],
    [
        'сложный путь с точками и дефисами',
        'https://cdn.org/data/archive-1917.v2.tar.gz',
        'https://cdn.org/data/archive-1917.v2.tar.gz',
    ],
    ['домен IDN на кириллице', 'https://президент.рф/документы', null],
    [
        'домен Punycode',
        'https://xn--p1ai.xn--e1afmkfd.xn--p1ai/path',
        'https://xn--p1ai.xn--e1afmkfd.xn--p1ai/path',
    ],
    ['адрес с завершающим слэшем и пробелами по краям', '  https://clean-domain.org/dir/  ', 'https://clean-domain.org/dir/'],
];

/**
 * Параметризованная таблица недопустимых URL-адресов.
 * Содержит кортежи вида [описание, входной_URL].
 */
const INVALID_URLS_CASES = [
    ['опасный протокол javascript', 'javascript:alert(1)'],
    ['javascript с манипуляцией регистра', 'JaVaScRiPt:alert(document.cookie)'],
    ['javascript в верхнем регистре', 'JAVASCRIPT:void(0)'],
    ['javascript с пробелом перед двоеточием', 'java script:alert(1)'],
    ['javascript с табуляцией перед двоеточием', 'javascript\t:alert(1)'],
    ['javascript с переводом строки перед двоеточием', 'javascript\n:alert(1)'],
    ['javascript с возвратом каретки', 'javascript\r:alert(1)'],
    ['javascript со скобочным выражением', 'javascript:(alert)(1)'],
    ['javascript с нулевым байтом', 'java\0script:alert(1)'],
    ['javascript с управляющим ASCII-символом', 'java\x01script:alert(1)'],
    ['псевдопротокол data', 'data:text/html,<script>alert(1)</script>'],
    ['data в верхнем регистре', 'DATA:image/svg+xml;base64,PHN2Zz4='],
    ['псевдопротокол vbscript', 'vbscript:msgbox(1)'],
    ['vbscript в верхнем регистре', 'VBSCRIPT:execute(something)'],
    ['схема локальной файловой системы', 'file:///etc/passwd'],
    ['схема Windows-файла', 'file://C:/Windows/System32/drivers/etc/hosts'],
    ['схема blob-объекта', 'blob:https://example.com/8394-2394-234'],
    ['сетевой протокол ftp', 'ftp://ftp.example.org/file.zip'],
    ['почтовый протокол mailto', 'mailto:admin@history.org'],
    ['телефонный протокол tel', 'tel:+1234567890'],
    ['протокол вебсокетов ws', 'ws://backend.local:8000/socket'],
    ['протокол защищенных вебсокетов wss', 'wss://secure.local:8000/socket'],
    ['служебный протокол браузера', 'about:blank'],
    ['протокольно-относительный адрес', '//attacker.org/payload'],
    ['протокольно-относительный адрес с путем', '//evil.com/xss.js'],
    ['относительный путь от корня', '/api/v1/events'],
    ['относительный путь от текущей страницы', 'events/new'],
    ['внутристраничный якорь', '#overview'],
    ['учетные данные в URL (userinfo)', 'https://user:password@target.org/login'],
    ['учетная запись без пароля', 'https://admin@phishing.com/secret'],
    ['пустая строка', ''],
    ['строка из одних пробелов', '    '],
    ['строка из одних табуляций', '\t\t'],
    ['значение null', null],
    ['значение undefined', undefined],
    ['числовое значение', 12345],
    ['булево значение', true],
    ['пустой объект', {}],
    ['массив', []],
];

describe('Модуль политики безопасности ссылок (linkPolicy.js)', () => {
    describe('Параметризованные тесты допустимых URL-адресов (Valid URLs Table)', () => {
        it.each(VALID_URLS_CASES)(
            'допустимый URL: %s',
            (_, inputUrl, expectedNormalized) => {
                expect(isSafeLinkUrl(inputUrl)).toBe(true);

                const sanitized = sanitizeLinkUrl(inputUrl);
                expect(typeof sanitized).toBe('string');
                expect(sanitized.length).toBeGreaterThan(0);

                if (expectedNormalized) {
                    expect(sanitized).toBe(expectedNormalized);
                }

                const attrs = getSafeLinkAttributes(inputUrl);
                expect(attrs).not.toBeNull();
                expect(attrs.href).toBe(sanitized);
                expect(attrs.target).toBe(SAFE_EXTERNAL_LINK_TARGET);

                const tokens = attrs.rel.split(' ');
                const expectedTokens = SAFE_EXTERNAL_LINK_REL.split(' ');
                expectedTokens.forEach((token) => {
                    expect(tokens).toContain(token);
                });
            }
        );
    });

    describe('Параметризованные тесты недопустимых URL-адресов (Invalid URLs Table)', () => {
        it.each(INVALID_URLS_CASES)(
            'недопустимый URL: %s',
            (_, inputUrl) => {
                expect(isSafeLinkUrl(inputUrl)).toBe(false);
                expect(sanitizeLinkUrl(inputUrl)).toBeNull();
                expect(getSafeLinkAttributes(inputUrl)).toBeNull();
            }
        );
    });

    describe('Доверенные ссылки (http и https)', () => {
        it('подтверждает валидность стандартных URL-адресов http и https', () => {
            expect(isSafeLinkUrl('https://example.com')).toBe(true);
            expect(isSafeLinkUrl('http://example.org')).toBe(true);
            expect(isSafeLinkUrl('https://sub.domain.example.com/path/to/resource')).toBe(true);
        });

        it('сохраняет параметры запроса и фрагменты якорей', () => {
            const url = 'https://history.org/event?id=123&sort=asc#summary';
            expect(isSafeLinkUrl(url)).toBe(true);
            expect(sanitizeLinkUrl(url)).toBe(url);
        });

        it('поддерживает адреса с нестандартными сетевыми портами', () => {
            const urlWithPort = 'https://archive.local:8080/path';
            expect(isSafeLinkUrl(urlWithPort)).toBe(true);
            expect(sanitizeLinkUrl(urlWithPort)).toBe(urlWithPort);
        });

        it('поддерживает интернационализированные доменные имена IDN и Punycode', () => {
            const punycodeUrl = 'https://xn--e1afmkfd.xn--p1ai/';
            expect(isSafeLinkUrl(punycodeUrl)).toBe(true);
            expect(sanitizeLinkUrl(punycodeUrl)).toBe(punycodeUrl);

            const idnUrl = 'https://президент.рф/документы';
            expect(isSafeLinkUrl(idnUrl)).toBe(true);
            expect(sanitizeLinkUrl(idnUrl)).toContain('xn--');
        });

        it('нормализует канонический адрес href в функции sanitizeLinkUrl', () => {
            const rawUrl = '  https://example.com/test/../test/  ';
            const sanitized = sanitizeLinkUrl(rawUrl);
            expect(sanitized).toBe('https://example.com/test/');
        });
    });

    describe('Запрещенные протоколы и векторы XSS-атак', () => {
        it('отклоняет прямые псевдопротоколы javascript:', () => {
            expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false);
            expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull();
        });

        it('отклоняет псевдопротоколы с манипуляциями регистра символов', () => {
            expect(isSafeLinkUrl('JaVaScRiPt:alert(document.cookie)')).toBe(false);
            expect(isSafeLinkUrl('JAVASCRIPT:void(0)')).toBe(false);
            expect(sanitizeLinkUrl('JaVaScRiPt:alert(1)')).toBeNull();
        });

        it('отклоняет скрытые схемы с пробелами и табуляциями перед двоеточием', () => {
            expect(isSafeLinkUrl('java script:alert(1)')).toBe(false);
            expect(isSafeLinkUrl('javascript\t:alert(1)')).toBe(false);
            expect(isSafeLinkUrl('javascript\n:alert(1)')).toBe(false);
            expect(isSafeLinkUrl('javascript\r:alert(1)')).toBe(false);
            expect(sanitizeLinkUrl('java script:alert(1)')).toBeNull();
        });

        it('отклоняет ссылки с внедренными управляющими символами и нулевыми байтами', () => {
            expect(isSafeLinkUrl('java\0script:alert(1)')).toBe(false);
            expect(isSafeLinkUrl('jav\x01ascript:alert(1)')).toBe(false);
            expect(sanitizeLinkUrl('java\0script:alert(1)')).toBeNull();
        });

        it('отклоняет протокол data:', () => {
            expect(isSafeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
            expect(isSafeLinkUrl('DATA:text/html,alert(1)')).toBe(false);
            expect(sanitizeLinkUrl('data:text/html,alert(1)')).toBeNull();
        });

        it('отклоняет протокол vbscript:', () => {
            expect(isSafeLinkUrl('vbscript:msgbox(1)')).toBe(false);
            expect(isSafeLinkUrl('VBSCRIPT:execute(something)')).toBe(false);
            expect(sanitizeLinkUrl('vbscript:msgbox(1)')).toBeNull();
        });

        it('отклоняет протоколы файловых систем и объектов file: и blob:', () => {
            expect(isSafeLinkUrl('file:///etc/passwd')).toBe(false);
            expect(isSafeLinkUrl('file://C:/Windows/win.ini')).toBe(false);
            expect(isSafeLinkUrl('blob:https://example.com/uuid-string')).toBe(false);
            expect(sanitizeLinkUrl('file:///etc/passwd')).toBeNull();
            expect(sanitizeLinkUrl('blob:https://example.com/uuid-string')).toBeNull();
        });
    });

    describe('Относительные ссылки и некорректные форматы', () => {
        it('отклоняет пути относительно корня домена', () => {
            expect(isSafeLinkUrl('/events/123')).toBe(false);
            expect(sanitizeLinkUrl('/events/123')).toBeNull();
        });

        it('отклоняет пути относительно текущей страницы', () => {
            expect(isSafeLinkUrl('events/123')).toBe(false);
            expect(sanitizeLinkUrl('events/123')).toBeNull();
        });

        it('отклоняет внутристраничные якорные ссылки', () => {
            expect(isSafeLinkUrl('#anchor')).toBe(false);
            expect(sanitizeLinkUrl('#anchor')).toBeNull();
        });

        it('отклоняет протокольно-относительные ссылки', () => {
            expect(isSafeLinkUrl('//evil.com')).toBe(false);
            expect(isSafeLinkUrl('//evil.com/phishing')).toBe(false);
            expect(sanitizeLinkUrl('//evil.com')).toBeNull();
        });

        it('отклоняет адреса с учетными данными пользователя (userinfo / фишинг)', () => {
            expect(isSafeLinkUrl('https://user:password@phishing.com/login')).toBe(false);
            expect(isSafeLinkUrl('https://admin@target.org/panel')).toBe(false);
            expect(sanitizeLinkUrl('https://user:password@phishing.com/login')).toBeNull();
        });

        it('отклоняет пустые значения и невалидные типы данных', () => {
            expect(isSafeLinkUrl('')).toBe(false);
            expect(isSafeLinkUrl('   ')).toBe(false);
            expect(isSafeLinkUrl(null)).toBe(false);
            expect(isSafeLinkUrl(undefined)).toBe(false);
            expect(isSafeLinkUrl(12345)).toBe(false);
            expect(isSafeLinkUrl({})).toBe(false);
            expect(isSafeLinkUrl([])).toBe(false);
            expect(sanitizeLinkUrl('')).toBeNull();
            expect(sanitizeLinkUrl(null)).toBeNull();
            expect(sanitizeLinkUrl(undefined)).toBeNull();
        });
    });

    describe('Генератор безопасных атрибутов getSafeLinkAttributes', () => {
        it('возвращает null для невалидных или небезопасных адресов', () => {
            expect(getSafeLinkAttributes('javascript:alert(1)')).toBeNull();
            expect(getSafeLinkAttributes('/relative/path')).toBeNull();
            expect(getSafeLinkAttributes('')).toBeNull();
            expect(getSafeLinkAttributes(null)).toBeNull();
        });

        it('возвращает объект атрибутов с href, target и rel для валидного адреса', () => {
            const result = getSafeLinkAttributes('https://example.com/article');
            expect(result).not.toBeNull();
            expect(result.href).toBe('https://example.com/article');
            expect(result.target).toBe(SAFE_EXTERNAL_LINK_TARGET);
            expect(result.rel).toBe(SAFE_EXTERNAL_LINK_REL);
        });

        it('гарантирует значение target строго равным _blank', () => {
            const result = getSafeLinkAttributes('https://example.com');
            expect(result.target).toBe('_blank');
            expect(SAFE_EXTERNAL_LINK_TARGET).toBe('_blank');
        });

        it('гарантирует наличие токенов noopener, noreferrer, nofollow и ugc в атрибуте rel', () => {
            const result = getSafeLinkAttributes('https://example.com');
            const tokens = result.rel.split(' ');

            expect(tokens).toContain('noopener');
            expect(tokens).toContain('noreferrer');
            expect(tokens).toContain('nofollow');
            expect(tokens).toContain('ugc');
            expect(result.rel).toBe(SAFE_EXTERNAL_LINK_REL);
        });

        it('корректно обрабатывает и очищает опциональный параметр title', () => {
            const withTitle = getSafeLinkAttributes(
                'https://example.com',
                '  Заголовок статьи  '
            );
            expect(withTitle.title).toBe('Заголовок статьи');

            const withEmptyTitle = getSafeLinkAttributes('https://example.com', '   ');
            expect(withEmptyTitle.title).toBeNull();

            const withoutTitle = getSafeLinkAttributes('https://example.com', null);
            expect(withoutTitle.title).toBeNull();

            const withDefaultTitle = getSafeLinkAttributes('https://example.com');
            expect(withDefaultTitle.title).toBeNull();
        });

        it('возвращает замороженный объект атрибутов для предотвращения мутаций', () => {
            const result = getSafeLinkAttributes('https://example.com');
            expect(Object.isFrozen(result)).toBe(true);
        });
    });
});
