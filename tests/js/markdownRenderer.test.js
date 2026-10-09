// @vitest-environment happy-dom

/**
 * Модульные тесты рендерера абстрактного синтаксического дерева Markdown (renderer.js).
 * Проверяют построение DOM-узлов без innerHTML, фильтрацию опасных протоколов ссылок,
 * нейтрализацию XSS-векторов и обработчиков событий, сохранение буквальности сущностей,
 * отказоустойчивость к аномальным узлам AST и точные границы счетчика MAX_RENDER_NODES.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    renderMarkdownAst,
    renderMarkdown,
    MAX_RENDER_NODES,
} from '../../frontend/js/markdown/renderer.js';

describe('Модуль рендерера Markdown AST в DOM (renderer.js)', () => {
    describe('Блочный рендеринг', () => {
        it('создает элементы параграфов p с текстовым содержимым', () => {
            const frag = renderMarkdown('Первый параграф.\n\nВторой параграф.');
            const paragraphs = frag.querySelectorAll('p');

            expect(paragraphs.length).toBe(2);
            expect(paragraphs[0].textContent).toBe('Первый параграф.');
            expect(paragraphs[1].textContent).toBe('Второй параграф.');
        });

        it('создает заголовки h3, h4, h5 и исключает появление h1, h2 и h6', () => {
            const markdown = [
                '# Уровень 1',
                '## Уровень 2',
                '### Уровень 3',
                '#### Уровень 4',
                '##### Уровень 5',
                '###### Уровень 6',
            ].join('\n\n');

            const frag = renderMarkdown(markdown);

            expect(frag.querySelector('h1')).toBeNull();
            expect(frag.querySelector('h2')).toBeNull();
            expect(frag.querySelector('h6')).toBeNull();

            const h3List = frag.querySelectorAll('h3');
            expect(h3List.length).toBe(3);
            expect(h3List[0].textContent).toBe('Уровень 1');
            expect(h3List[1].textContent).toBe('Уровень 2');
            expect(h3List[2].textContent).toBe('Уровень 3');

            const h4 = frag.querySelector('h4');
            expect(h4).not.toBeNull();
            expect(h4.textContent).toBe('Уровень 4');

            const h5List = frag.querySelectorAll('h5');
            expect(h5List.length).toBe(2);
            expect(h5List[0].textContent).toBe('Уровень 5');
            expect(h5List[1].textContent).toBe('Уровень 6');
        });

        it('создает блоки цитат blockquote со вложенными элементами', () => {
            const frag = renderMarkdown('> Цитата исторического документа');
            const bq = frag.querySelector('blockquote');

            expect(bq).not.toBeNull();
            const innerP = bq.querySelector('p');
            expect(innerP).not.toBeNull();
            expect(innerP.textContent).toBe('Цитата исторического документа');
        });

        it('создает маркированные списки ul и нумерованные списки ol с элементами li', () => {
            const ulFrag = renderMarkdown('- Пункт А\n- Пункт Б');
            const ul = ulFrag.querySelector('ul');
            expect(ul).not.toBeNull();
            const ulItems = ul.querySelectorAll('li');
            expect(ulItems.length).toBe(2);
            expect(ulItems[0].textContent).toBe('Пункт А');
            expect(ulItems[1].textContent).toBe('Пункт Б');

            const olFrag = renderMarkdown('2. Второй\n3. Третий');
            const ol = olFrag.querySelector('ol');
            expect(ol).not.toBeNull();
            expect(ol.getAttribute('start')).toBe('2');
            const olItems = ol.querySelectorAll('li');
            expect(olItems.length).toBe(2);
            expect(olItems[0].textContent).toBe('Второй');
            expect(olItems[1].textContent).toBe('Третий');
        });

        it('создает блоки кода pre > code с классом языка и буквальным текстом', () => {
            const markdown = '```javascript\nconst tag = "<b>тест</b>";\n```';
            const frag = renderMarkdown(markdown);

            const pre = frag.querySelector('pre');
            expect(pre).not.toBeNull();
            const code = pre.querySelector('code');
            expect(code).not.toBeNull();
            expect(code.className).toBe('language-javascript');
            expect(code.textContent).toBe('const tag = "<b>тест</b>";');
            expect(code.querySelector('b')).toBeNull();
        });

        it('создает горизонтальный тематический разделитель hr', () => {
            const frag = renderMarkdown('Параграф до\n\n---\n\nПараграф после');
            const hr = frag.querySelector('hr');

            expect(hr).not.toBeNull();
            expect(frag.querySelectorAll('p').length).toBe(2);
        });
    });

    describe('Строчное форматирование', () => {
        it('создает элементы strong для полужирного начертания', () => {
            const frag = renderMarkdown('Текст с **жирным шрифтом** в строке.');
            const strong = frag.querySelector('strong');

            expect(strong).not.toBeNull();
            expect(strong.textContent).toBe('жирным шрифтом');
        });

        it('создает элементы em для курсивного начертания', () => {
            const frag = renderMarkdown('Текст с *курсивом* в строке.');
            const em = frag.querySelector('em');

            expect(em).not.toBeNull();
            expect(em.textContent).toBe('курсивом');
        });

        it('создает элементы del для зачеркнутого текста', () => {
            const frag = renderMarkdown('Текст с ~~зачеркиванием~~ в строке.');
            const del = frag.querySelector('del');

            expect(del).not.toBeNull();
            expect(del.textContent).toBe('зачеркиванием');
        });

        it('создает элементы code для инлайн-кода', () => {
            const frag = renderMarkdown('Команда `npm test` запущена.');
            const code = frag.querySelector('code');

            expect(code).not.toBeNull();
            expect(code.textContent).toBe('npm test');
            expect(frag.querySelector('pre')).toBeNull();
        });

        it('корректно обрабатывает вложенные строчные конструкции', () => {
            const frag = renderMarkdown('- Пункт списка с ***жирным курсивом***');
            const li = frag.querySelector('li');

            expect(li).not.toBeNull();
            const strong = li.querySelector('strong');
            expect(strong).not.toBeNull();
            const em = strong.querySelector('em');
            expect(em).not.toBeNull();
            expect(em.textContent).toBe('жирным курсивом');
        });
    });

    describe('Безопасность внешних ссылок', () => {
        it('формирует безопасный элемент a с защитными атрибутами для схемы https', () => {
            const frag = renderMarkdown(
                '[Исторический архив](https://example.com/archive "Подсказка")'
            );
            const a = frag.querySelector('a');

            expect(a).not.toBeNull();
            expect(a.getAttribute('href')).toBe('https://example.com/archive');
            expect(a.getAttribute('target')).toBe('_blank');
            expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
            expect(a.getAttribute('title')).toBe('Подсказка');
            expect(a.textContent).toBe('Исторический архив');
        });

        it('нейтрализует ссылку javascript:alert(1) в span.markdown-unsafe-link без создания тега a', () => {
            const frag = renderMarkdown('[Вредоносный переход](javascript:alert(1))');

            expect(frag.querySelector('a')).toBeNull();
            const span = frag.querySelector('span.markdown-unsafe-link');
            expect(span).not.toBeNull();
            expect(span.textContent).toBe('Вредоносный переход');
        });

        it('нейтрализует ссылку со схемой data:text/html в span.markdown-unsafe-link', () => {
            const frag = renderMarkdown(
                '[Инъекция данных](data:text/html,<script>alert(1)</script>)'
            );

            expect(frag.querySelector('a')).toBeNull();
            const span = frag.querySelector('span.markdown-unsafe-link');
            expect(span).not.toBeNull();
            expect(span.textContent).toBe('Инъекция данных');
        });

        it('нейтрализует все варианты опасных и недопустимых схем в span.markdown-unsafe-link', () => {
            const dangerousUrls = [
                'javascript:alert(1)',
                'javascript:void(0)',
                'javascript:(alert)(1)',
                'JAVASCRIPT:alert(1)',
                'java script:alert(1)',
                'javascript\t:alert(1)',
                'javascript\n:alert(1)',
                'vbscript:msgbox(1)',
                'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
                'file:///etc/passwd',
                'blob:https://example.com/uuid',
                '//evil-domain.com',
                '/api/v1/leak',
                '../config.json',
                '#anchor',
            ];

            dangerousUrls.forEach((url) => {
                const markdown = `[Опасная ссылка](${url})`;
                const frag = renderMarkdown(markdown);

                expect(frag.querySelector('a')).toBeNull();
                const span = frag.querySelector('span.markdown-unsafe-link');
                expect(span).not.toBeNull();
                expect(span.textContent).toBe('Опасная ссылка');
            });
        });

        it('сохраняет легитимные ссылки с круглыми скобками в пути, query-параметрами и хэшем', () => {
            const wikiMarkdown =
                '[Википедия](https://ru.wikipedia.org/wiki/Событие_(значения))';
            const wikiFrag = renderMarkdown(wikiMarkdown);
            const wikiLink = wikiFrag.querySelector('a');

            expect(wikiLink).not.toBeNull();
            expect(decodeURI(wikiLink.getAttribute('href'))).toBe(
                'https://ru.wikipedia.org/wiki/Событие_(значения)'
            );
            expect(wikiLink.getAttribute('target')).toBe('_blank');
            expect(wikiLink.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
            expect(wikiLink.textContent).toBe('Википедия');

            const complexMarkdown =
                '[Документ](https://example.com/doc?id=10&ref=2#top)';
            const complexFrag = renderMarkdown(complexMarkdown);
            const complexLink = complexFrag.querySelector('a');

            expect(complexLink).not.toBeNull();
            expect(complexLink.getAttribute('href')).toBe(
                'https://example.com/doc?id=10&ref=2#top'
            );
            expect(complexLink.getAttribute('target')).toBe('_blank');
            expect(complexLink.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
            expect(complexLink.textContent).toBe('Документ');
        });
    });

    describe('Защита от XSS и контроль API', () => {
        it('рендерит тег <script> как безопасный текстовый узел без создания элемента script', () => {
            const frag = renderMarkdown('<script>alert("xss")</script>');

            expect(frag.querySelector('script')).toBeNull();
            expect(frag.textContent).toBe('<script>alert("xss")</script>');
        });

        it('нейтрализует HTML-теги с обработчиками событий, исключая их появление в DOM', () => {
            const payloads = [
                '<img src=x onerror=alert(1)>',
                '<svg onload=alert(1)>',
                '<iframe src="//evil.com">',
                '<body onload=alert(1)>',
            ];

            payloads.forEach((payload) => {
                const frag = renderMarkdown(payload);

                expect(frag.querySelector('img')).toBeNull();
                expect(frag.querySelector('svg')).toBeNull();
                expect(frag.querySelector('iframe')).toBeNull();
                expect(frag.querySelector('body')).toBeNull();

                const p = frag.querySelector('p');
                expect(p).not.toBeNull();
                expect(p.textContent).toBe(payload);
            });
        });

        it('сохраняет HTML-сущности как буквальный текст без декодирования в теги', () => {
            const markdown = '&lt;script&gt;alert(1)&lt;/script&gt;';
            const frag = renderMarkdown(markdown);

            expect(frag.querySelector('script')).toBeNull();
            expect(frag.textContent).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
        });

        it('не вызывает innerHTML, outerHTML и insertAdjacentHTML в процессе построения DOM', () => {
            const innerHtmlSpy = vi.spyOn(Element.prototype, 'innerHTML', 'set');
            const outerHtmlSpy = vi.spyOn(Element.prototype, 'outerHTML', 'set');
            const insertAdjacentHtmlSpy = vi.spyOn(
                Element.prototype,
                'insertAdjacentHTML'
            );

            try {
                renderMarkdown(
                    '### Заголовок\n\nТекст с **жирным**, `кодом` и [ссылкой](https://example.com).'
                );

                expect(innerHtmlSpy).not.toHaveBeenCalled();
                expect(outerHtmlSpy).not.toHaveBeenCalled();
                expect(insertAdjacentHtmlSpy).not.toHaveBeenCalled();
            } finally {
                innerHtmlSpy.mockRestore();
                outerHtmlSpy.mockRestore();
                insertAdjacentHtmlSpy.mockRestore();
            }
        });
    });

    describe('Устойчивость к аномальным и разрушенным узлам AST', () => {
        it('не выбрасывает ошибок при передаче null, undefined, пустых объектов и некорректных узлов', () => {
            expect(() => renderMarkdownAst(null)).not.toThrow();
            expect(renderMarkdownAst(null).children.length).toBe(0);

            expect(() => renderMarkdownAst(undefined)).not.toThrow();
            expect(renderMarkdownAst(undefined).children.length).toBe(0);

            expect(() => renderMarkdownAst({})).not.toThrow();
            expect(renderMarkdownAst({}).children.length).toBe(0);

            const rootNullChildren = { type: 'root', children: null };
            expect(() => renderMarkdownAst(rootNullChildren)).not.toThrow();
            expect(renderMarkdownAst(rootNullChildren).children.length).toBe(0);

            const unknownNodeAst = {
                type: 'root',
                children: [{ type: 'unknown_future_block', data: 123 }],
            };
            expect(() => renderMarkdownAst(unknownNodeAst)).not.toThrow();
            expect(renderMarkdownAst(unknownNodeAst).children.length).toBe(0);

            const textWithoutContentAst = {
                type: 'root',
                children: [
                    {
                        type: 'paragraph',
                        children: [{ type: 'text' }],
                    },
                ],
            };
            expect(() => renderMarkdownAst(textWithoutContentAst)).not.toThrow();
            const frag = renderMarkdownAst(textWithoutContentAst);
            expect(frag.querySelector('p')).not.toBeNull();
            expect(frag.querySelector('p').textContent).toBe('');
        });
    });

    describe('Лимит количества узлов', () => {
        it('останавливает рендеринг при превышении MAX_RENDER_NODES и выводит сервисное уведомление', () => {
            const excessiveChildren = [];
            for (let i = 0; i < 3000; i++) {
                excessiveChildren.push({
                    type: 'paragraph',
                    children: [{ type: 'text', text: `Параграф номер ${i}` }],
                });
            }

            const artificialAst = {
                type: 'root',
                children: excessiveChildren,
            };

            const frag = renderMarkdownAst(artificialAst);

            const notice = frag.querySelector('.markdown-truncation-notice');
            expect(notice).not.toBeNull();
            expect(notice.textContent).toBe(
                'Превышен максимальный лимит отображаемых элементов разметки.'
            );

            const paragraphs = frag.querySelectorAll('p:not(.markdown-truncation-notice)');
            expect(paragraphs.length).toBeLessThan(3000);
            expect(paragraphs.length).toBeGreaterThan(0);
            expect(paragraphs.length).toBeLessThanOrEqual(MAX_RENDER_NODES);
        });

        it('рендерит ровно MAX_RENDER_NODES узлов без вывода сервисного уведомления', () => {
            const exactChildren = [];
            for (let i = 0; i < MAX_RENDER_NODES; i++) {
                exactChildren.push({ type: 'thematic_break' });
            }

            const astExact = {
                type: 'root',
                children: exactChildren,
            };

            const frag = renderMarkdownAst(astExact);

            const hrs = frag.querySelectorAll('hr');
            expect(hrs.length).toBe(MAX_RENDER_NODES);

            const notice = frag.querySelector('.markdown-truncation-notice');
            expect(notice).toBeNull();
        });

        it('останавливает рендеринг и выводит плашку при превышении лимита ровно на 1 узел', () => {
            const overflowChildren = [];
            for (let i = 0; i < MAX_RENDER_NODES + 1; i++) {
                overflowChildren.push({ type: 'thematic_break' });
            }

            const astOverflow = {
                type: 'root',
                children: overflowChildren,
            };

            const frag = renderMarkdownAst(astOverflow);

            const hrs = frag.querySelectorAll('hr');
            expect(hrs.length).toBe(MAX_RENDER_NODES);

            const notice = frag.querySelector('.markdown-truncation-notice');
            expect(notice).not.toBeNull();
            expect(notice.textContent).toBe(
                'Превышен максимальный лимит отображаемых элементов разметки.'
            );
        });
    });
});
