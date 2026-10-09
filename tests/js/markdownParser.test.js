/**
 * Модульные тесты синтаксического анализатора Markdown (parser.js).
 * Проверяют нормализацию входных данных, разбор блочных и инлайн-структур,
 * комбинированную вложенность элементов, ограничение глубины по MAX_NESTING_DEPTH,
 * экранирование сырого HTML и обработчиков событий, HTML-сущности,
 * корректность парсинга сложных вариантов ссылок и устойчивость к ReDoS.
 */

import { describe, it, expect } from 'vitest';
import {
    parseMarkdown,
    MAX_NESTING_DEPTH,
} from '../../frontend/js/markdown/parser.js';

describe('Модуль синтаксического анализатора Markdown (parser.js)', () => {
    describe('Нормализация входных данных', () => {
        it('возвращает пустой корневой узел для некорректных типов и пустых строк', () => {
            const expectedEmpty = { type: 'root', children: [] };

            expect(parseMarkdown(null)).toEqual(expectedEmpty);
            expect(parseMarkdown(undefined)).toEqual(expectedEmpty);
            expect(parseMarkdown('')).toEqual(expectedEmpty);
            expect(parseMarkdown(12345)).toEqual(expectedEmpty);
            expect(parseMarkdown({})).toEqual(expectedEmpty);
            expect(parseMarkdown([])).toEqual(expectedEmpty);
        });

        it('удаляет нулевые байты \\0 из входного текста', () => {
            const input = 'Текст\0 с\0 нулевыми\0 байтами';
            const ast = parseMarkdown(input);

            expect(ast.children.length).toBe(1);
            expect(ast.children[0].type).toBe('paragraph');
            expect(ast.children[0].children[0]).toEqual({
                type: 'text',
                text: 'Текст с нулевыми байтами',
            });
        });

        it('нормализует переводы строк CRLF и CR в единый символ LF', () => {
            const input = 'Первый параграф\r\n\r\nВторой параграф\r\rТретий параграф';
            const ast = parseMarkdown(input);

            expect(ast.children.length).toBe(3);
            expect(ast.children[0].type).toBe('paragraph');
            expect(ast.children[0].children[0].text).toBe('Первый параграф');
            expect(ast.children[1].type).toBe('paragraph');
            expect(ast.children[1].children[0].text).toBe('Второй параграф');
            expect(ast.children[2].type).toBe('paragraph');
            expect(ast.children[2].children[0].text).toBe('Третий параграф');
        });

        it('развертывает символы табуляции в 4 пробела', () => {
            const input = '\t- Элемент списка с табуляцией';
            const ast = parseMarkdown(input);

            expect(ast.children.length).toBe(1);
            expect(ast.children[0].type).toBe('list');
            expect(ast.children[0].items[0].type).toBe('list_item');
        });
    });

    describe('Блочные элементы разметки', () => {
        it('корректно понижает заголовки h1 и h2 до уровня 3', () => {
            const inputH1 = '# Заголовок 1';
            const astH1 = parseMarkdown(inputH1);
            expect(astH1.children[0]).toEqual({
                type: 'heading',
                level: 3,
                children: [{ type: 'text', text: 'Заголовок 1' }],
            });

            const inputH2 = '## Заголовок 2';
            const astH2 = parseMarkdown(inputH2);
            expect(astH2.children[0]).toEqual({
                type: 'heading',
                level: 3,
                children: [{ type: 'text', text: 'Заголовок 2' }],
            });
        });

        it('корректно разбирает заголовки h3, h4, h5 и понижает h6 до уровня 5', () => {
            const inputH3 = '### Заголовок 3';
            const astH3 = parseMarkdown(inputH3);
            expect(astH3.children[0].level).toBe(3);

            const inputH4 = '#### Заголовок 4';
            const astH4 = parseMarkdown(inputH4);
            expect(astH4.children[0].level).toBe(4);

            const inputH5 = '##### Заголовок 5';
            const astH5 = parseMarkdown(inputH5);
            expect(astH5.children[0].level).toBe(5);

            const inputH6 = '###### Заголовок 6';
            const astH6 = parseMarkdown(inputH6);
            expect(astH6.children[0].level).toBe(5);
        });

        it('отсекает хвостовые символы # в заголовках', () => {
            const input = '### Заголовок раздела ###';
            const ast = parseMarkdown(input);

            expect(ast.children[0]).toEqual({
                type: 'heading',
                level: 3,
                children: [{ type: 'text', text: 'Заголовок раздела' }],
            });
        });

        it('разбирает блоки кода fenced code blocks с языком и без него', () => {
            const codeWithLang = '```python\nprint("Hello World")\n```';
            const astWithLang = parseMarkdown(codeWithLang);

            expect(astWithLang.children[0]).toEqual({
                type: 'code_block',
                language: 'python',
                text: 'print("Hello World")',
            });

            const codeWithoutLang = '```\nplain text content\n```';
            const astWithoutLang = parseMarkdown(codeWithoutLang);

            expect(astWithoutLang.children[0]).toEqual({
                type: 'code_block',
                language: null,
                text: 'plain text content',
            });
        });

        it('распознает тематический разделитель thematic_break', () => {
            const dashes = '---';
            const stars = '***';
            const underscores = '___';

            expect(parseMarkdown(dashes).children[0]).toEqual({ type: 'thematic_break' });
            expect(parseMarkdown(stars).children[0]).toEqual({ type: 'thematic_break' });
            expect(parseMarkdown(underscores).children[0]).toEqual({ type: 'thematic_break' });
        });

        it('группирует текст в параграфы и разделяет их пустыми строками', () => {
            const input = 'Строка один\nСтрока два\n\nВторой параграф';
            const ast = parseMarkdown(input);

            expect(ast.children.length).toBe(2);
            expect(ast.children[0]).toEqual({
                type: 'paragraph',
                children: [{ type: 'text', text: 'Строка один Строка два' }],
            });
            expect(ast.children[1]).toEqual({
                type: 'paragraph',
                children: [{ type: 'text', text: 'Второй параграф' }],
            });
        });

        it('разбирает маркированные списки с маркерами -, * и +', () => {
            const inputDash = '- Первый\n- Второй';
            const astDash = parseMarkdown(inputDash);
            expect(astDash.children[0].type).toBe('list');
            expect(astDash.children[0].ordered).toBe(false);
            expect(astDash.children[0].items.length).toBe(2);

            const inputStar = '* Элемент А\n* Элемент Б';
            const astStar = parseMarkdown(inputStar);
            expect(astStar.children[0].type).toBe('list');
            expect(astStar.children[0].ordered).toBe(false);

            const inputPlus = '+ Пункт 1\n+ Пункт 2';
            const astPlus = parseMarkdown(inputPlus);
            expect(astPlus.children[0].type).toBe('list');
            expect(astPlus.children[0].ordered).toBe(false);
        });

        it('разбирает нумерованные списки с проверкой атрибута ordered и стартового номера', () => {
            const input = '1. Начальный шаг\n2. Следующий шаг';
            const ast = parseMarkdown(input);

            expect(ast.children[0]).toEqual({
                type: 'list',
                ordered: true,
                start: 1,
                items: [
                    {
                        type: 'list_item',
                        children: [{ type: 'text', text: 'Начальный шаг' }],
                    },
                    {
                        type: 'list_item',
                        children: [{ type: 'text', text: 'Следующий шаг' }],
                    },
                ],
            });
        });

        it('разбирает цитаты blockquote с вложенными параграфами', () => {
            const input = '> Историческая цитата первого абзаца\n>\n> Продолжение цитаты';
            const ast = parseMarkdown(input);

            expect(ast.children[0].type).toBe('blockquote');
            expect(ast.children[0].children.length).toBe(2);
            expect(ast.children[0].children[0].type).toBe('paragraph');
            expect(ast.children[0].children[0].children[0].text).toBe(
                'Историческая цитата первого абзаца'
            );
            expect(ast.children[0].children[1].type).toBe('paragraph');
            expect(ast.children[0].children[1].children[0].text).toBe(
                'Продолжение цитаты'
            );
        });
    });

    describe('Блочная вложенность и лимиты глубины', () => {
        it('разбирает цитату, содержащую список, блоки кода и горизонтальный разделитель', () => {
            const input = [
                '> - Пункт списка один',
                '> - Пункт списка два',
                '>',
                '> ```js',
                '> const active = true;',
                '> ```',
                '>',
                '> ---',
            ].join('\n');

            const ast = parseMarkdown(input);

            expect(ast.children.length).toBe(1);
            const quoteNode = ast.children[0];
            expect(quoteNode.type).toBe('blockquote');

            const childTypes = quoteNode.children.map((c) => c.type);
            expect(childTypes).toContain('list');
            expect(childTypes).toContain('code_block');
            expect(childTypes).toContain('thematic_break');
        });

        it('разбирает список, содержащий цитаты и вложенные подсписки до 4 уровней включительно', () => {
            const input = [
                '- Уровень 1',
                '    > Вложенная цитата в элементе',
                '    - Уровень 2',
                '        - Уровень 3',
                '            - Уровень 4',
            ].join('\n');

            const ast = parseMarkdown(input);

            expect(ast.children[0].type).toBe('list');
            let current = ast.children[0];
            let depth = 0;

            while (current && current.type === 'list') {
                depth++;
                const item = current.items ? current.items[0] : null;
                current = item?.children?.find((c) => c.type === 'list');
            }

            expect(depth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
            expect(depth).toBe(4);
        });

        it('ограничивает 7 уровней вложенных списков и 7 уровней цитат лимитом MAX_NESTING_DEPTH', () => {
            const deepQuotes = '> > > > > > > Текст на седьмом уровне цитаты';
            const astQuotes = parseMarkdown(deepQuotes);

            let quoteCurrent = astQuotes.children[0];
            let quoteDepth = 0;

            while (quoteCurrent && quoteCurrent.type === 'blockquote') {
                quoteDepth++;
                quoteCurrent = quoteCurrent.children ? quoteCurrent.children[0] : null;
            }

            expect(quoteDepth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
            expect(quoteDepth).toBe(MAX_NESTING_DEPTH);

            const deepLists = [
                '- L1',
                '    - L2',
                '        - L3',
                '            - L4',
                '                - L5',
                '                    - L6',
                '                        - L7',
            ].join('\n');

            const astLists = parseMarkdown(deepLists);

            let listCurrent = astLists.children[0];
            let listDepth = 0;

            while (listCurrent && listCurrent.type === 'list') {
                listDepth++;
                const item = listCurrent.items ? listCurrent.items[0] : null;
                listCurrent = item?.children?.find((c) => c.type === 'list');
            }

            expect(listDepth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
            expect(listDepth).toBe(MAX_NESTING_DEPTH);
        });
    });

    describe('Инлайн-элементы разметки', () => {
        it('разбирает жирный шрифт с маркерами ** и __', () => {
            const inputStars = '**Жирный текст**';
            const astStars = parseMarkdown(inputStars);
            expect(astStars.children[0].children[0]).toEqual({
                type: 'strong',
                children: [{ type: 'text', text: 'Жирный текст' }],
            });

            const inputUnderscores = '__Жирный текст__';
            const astUnderscores = parseMarkdown(inputUnderscores);
            expect(astUnderscores.children[0].children[0]).toEqual({
                type: 'strong',
                children: [{ type: 'text', text: 'Жирный текст' }],
            });
        });

        it('разбирает курсив с маркерами * и _', () => {
            const inputStar = '*Курсивный текст*';
            const astStar = parseMarkdown(inputStar);
            expect(astStar.children[0].children[0]).toEqual({
                type: 'emphasis',
                children: [{ type: 'text', text: 'Курсивный текст' }],
            });

            const inputUnderscore = '_Курсивный текст_';
            const astUnderscore = parseMarkdown(inputUnderscore);
            expect(astUnderscore.children[0].children[0]).toEqual({
                type: 'emphasis',
                children: [{ type: 'text', text: 'Курсивный текст' }],
            });
        });

        it('разбирает зачеркнутый текст с маркерами ~~', () => {
            const input = '~~Зачеркнутый текст~~';
            const ast = parseMarkdown(input);
            expect(ast.children[0].children[0]).toEqual({
                type: 'strikethrough',
                children: [{ type: 'text', text: 'Зачеркнутый текст' }],
            });
        });

        it('разбирает инлайн-код в обратных кавычках без обработки вложенной разметки', () => {
            const input = 'Код `const x = **не жирный**;` в строке';
            const ast = parseMarkdown(input);

            expect(ast.children[0].children).toEqual([
                { type: 'text', text: 'Код ' },
                { type: 'inline_code', text: 'const x = **не жирный**;' },
                { type: 'text', text: ' в строке' },
            ]);
        });

        it('разбирает ссылки с адресом и опциональным заголовком title', () => {
            const inputWithoutTitle = '[Архив](https://example.com/archive)';
            const astWithoutTitle = parseMarkdown(inputWithoutTitle);
            expect(astWithoutTitle.children[0].children[0]).toEqual({
                type: 'link',
                href: 'https://example.com/archive',
                title: null,
                children: [{ type: 'text', text: 'Архив' }],
            });

            const inputWithTitle = '[Архив](https://example.com/archive "Исторический архив")';
            const astWithTitle = parseMarkdown(inputWithTitle);
            expect(astWithTitle.children[0].children[0]).toEqual({
                type: 'link',
                href: 'https://example.com/archive',
                title: 'Исторический архив',
                children: [{ type: 'text', text: 'Архив' }],
            });
        });

        it('обрабатывает экранирование служебных символов через обратный слеш', () => {
            const input = '\\*не курсив\\* и \\[не ссылка\\]';
            const ast = parseMarkdown(input);

            expect(ast.children[0].children).toEqual([
                { type: 'text', text: '*не курсив* и [не ссылка]' },
            ]);
        });
    });

    describe('Ссылки, скобочные адреса и несбалансированные конструкции', () => {
        it('корректно обрабатывает вложенные скобочные ссылки без создания link внутри link', () => {
            const input = '[[ссылка 1](https://a.com)](https://b.com)';
            const ast = parseMarkdown(input);

            const findNestedLinks = (nodes) => {
                let hasNested = false;
                nodes.forEach((node) => {
                    if (node.type === 'link') {
                        if (node.children && node.children.some((c) => c.type === 'link')) {
                            hasNested = true;
                        }
                    }
                    if (node.children) {
                        if (findNestedLinks(node.children)) {
                            hasNested = true;
                        }
                    }
                });
                return hasNested;
            };

            expect(findNestedLinks(ast.children)).toBe(false);
        });

        it('сохраняет полный адрес ссылки с круглыми скобками в пути', () => {
            const input = '[Статья](https://ru.wikipedia.org/wiki/Событие_(значения))';
            const ast = parseMarkdown(input);

            const linkNode = ast.children[0]?.children?.[0];
            expect(linkNode?.type).toBe('link');
            expect(linkNode?.href).toBe('https://ru.wikipedia.org/wiki/Событие_(значения)');
            expect(linkNode?.children?.[0]?.text).toBe('Статья');
        });

        it('формирует узел link с исходным адресом для обфусцированных и опасных протоколов', () => {
            const variants = [
                { input: '[Тест](java script:alert(1))', href: 'java script:alert(1)' },
                { input: '[Тест](javascript\t:alert(1))', href: 'javascript    :alert(1)' },
                { input: '[Тест](javascript:(alert)(1))', href: 'javascript:(alert)(1)' },
                { input: '[Тест](javascript:void(0))', href: 'javascript:void(0)' },
            ];

            variants.forEach(({ input, href }) => {
                const ast = parseMarkdown(input);
                const linkNode = ast.children[0]?.children?.[0];
                expect(linkNode?.type).toBe('link');
                expect(linkNode?.href).toBe(href);
            });
        });

        it('разбирает несбалансированные скобки ссылок как обычный текст без создания узла link', () => {
            const unbalanced = [
                '[незакрытая ссылка(https://example.com)',
                '[текст](https://example.com',
                '[текст] (https://example.com)',
            ];

            unbalanced.forEach((input) => {
                const ast = parseMarkdown(input);
                const hasLink = ast.children[0]?.children?.some((c) => c.type === 'link');
                expect(hasLink).toBe(false);
            });
        });
    });

    describe('Безопасность, сырой HTML и HTML-сущности', () => {
        it('парсит теги <script> как плоский текст без исполнения', () => {
            const input = '<script>alert(1)</script>';
            const ast = parseMarkdown(input);

            expect(ast.children[0].children[0]).toEqual({
                type: 'text',
                text: '<script>alert(1)</script>',
            });
        });

        it('сохраняет HTML-теги как буквальный текст', () => {
            const input = 'Текст с тегами <b>жирный HTML</b> и <div class="danger">блок</div>';
            const ast = parseMarkdown(input);

            expect(ast.children[0].children[0]).toEqual({
                type: 'text',
                text: 'Текст с тегами <b>жирный HTML</b> и <div class="danger">блок</div>',
            });
        });

        it('сохраняет HTML-теги с обработчиками событий исключительно как текстовые узлы', () => {
            const payloads = [
                '<img src=x onerror=alert(1)>',
                '<svg onload=alert(1)>',
                '<iframe src="//evil.com">',
                '<body onload=alert(1)>',
            ];

            payloads.forEach((payload) => {
                const ast = parseMarkdown(payload);
                const firstChild = ast.children[0]?.children?.[0];
                expect(firstChild?.type).toBe('text');
                expect(firstChild?.text).toBe(payload);
            });
        });

        it('не декодирует HTML-сущности в активные угловые скобки на этапе парсинга', () => {
            const entities = [
                '&lt;script&gt;alert(1)&lt;/script&gt;',
                '&#60;script&#62;',
                '&amp;quot;',
                '&quot;',
            ];

            entities.forEach((entity) => {
                const ast = parseMarkdown(entity);
                const firstChild = ast.children[0]?.children?.[0];
                expect(firstChild?.type).toBe('text');
                expect(firstChild?.text).toBe(entity);
            });
        });

        it('устойчив к незакрытым маркерам форматирования', () => {
            const input = '**незакрытый жирный текст';
            const ast = parseMarkdown(input);

            expect(ast.children[0].children[0]).toEqual({
                type: 'text',
                text: '**незакрытый жирный текст',
            });
        });
    });

    describe('Граничные условия и ReDoS-стресс-тестирование', () => {
        it('ограничивает глубину вложенности цитат порогом MAX_NESTING_DEPTH', () => {
            const deepQuote = '> > > > > > Глубокая цитата шести уровней';
            const ast = parseMarkdown(deepQuote);

            let current = ast.children[0];
            let depth = 0;

            while (current && current.type === 'blockquote') {
                depth++;
                current = current.children[0];
            }

            expect(depth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
            expect(depth).toBe(MAX_NESTING_DEPTH);
        });

        it('ограничивает глубину вложенных списков порогом MAX_NESTING_DEPTH', () => {
            const deepList = [
                '- Уровень 1',
                '    - Уровень 2',
                '        - Уровень 3',
                '            - Уровень 4',
                '                - Уровень 5',
                '                    - Уровень 6',
            ].join('\n');

            const ast = parseMarkdown(deepList);

            let current = ast.children[0];
            let depth = 0;

            while (current && current.type === 'list') {
                depth++;
                const item = current.items[0];
                current = item?.children?.find((c) => c.type === 'list');
            }

            expect(depth).toBeLessThanOrEqual(MAX_NESTING_DEPTH);
        });

        it('выполняет парсинг патологической строки длиной 20000 символов менее чем за 50 мс', () => {
            const pathological = '*_'.repeat(10000);
            expect(pathological.length).toBe(20000);

            const startTime = performance.now();
            const ast = parseMarkdown(pathological);
            const duration = performance.now() - startTime;

            expect(ast.type).toBe('root');
            expect(ast.children.length).toBeGreaterThan(0);
            expect(duration).toBeLessThan(50);

            const unclosedPathological = '* '.repeat(10000);
            const startUnclosed = performance.now();
            const astUnclosed = parseMarkdown(unclosedPathological);
            const durationUnclosed = performance.now() - startUnclosed;

            expect(astUnclosed.type).toBe('root');
            expect(durationUnclosed).toBeLessThan(50);
        });

        it('разбирает 10 000 незакрытых квадратных скобок быстрее 50 мс без переполнения стека', () => {
            const input = '['.repeat(10000);

            const startTime = performance.now();
            const ast = parseMarkdown(input);
            const duration = performance.now() - startTime;

            expect(ast.type).toBe('root');
            expect(ast.children.length).toBeGreaterThan(0);
            expect(duration).toBeLessThan(50);
        });

        it('разбирает 10 000 незакрытых обратных кавычек быстрее 50 мс без переполнения стека', () => {
            const input = '`'.repeat(10000);

            const startTime = performance.now();
            const ast = parseMarkdown(input);
            const duration = performance.now() - startTime;

            expect(ast.type).toBe('root');
            expect(ast.children.length).toBeGreaterThan(0);
            expect(duration).toBeLessThan(50);
        });

        it('обрабатывает патологическую строку со спецсимволами и маркерами быстрее 50 мс', () => {
            const input = '**_\0*~'.repeat(2000);

            const startTime = performance.now();
            const ast = parseMarkdown(input);
            const duration = performance.now() - startTime;

            expect(ast.type).toBe('root');
            expect(duration).toBeLessThan(50);
        });
    });
});
