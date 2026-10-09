/**
 * Модуль безопасного преобразования абстрактного синтаксического дерева (AST) Markdown в DOM.
 * Выполняет построение дерева элементов исключительно стандартными методами createElement,
 * createTextNode и свойством textContent без использования innerHTML и внешних библиотек.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. Полная защита от XSS: категорический запрет innerHTML, outerHTML и insertAdjacentHTML.
 * 2. Санитизация гиперссылок: интеграция с модулем linkPolicy и изоляция опасных схем.
 * 3. Контроль расхода ресурсов: жесткое ограничение общего числа узлов константой MAX_RENDER_NODES.
 * 4. Совместимость окружений: поддержка передачи кастомного documentRef для тестов happy-dom.
 */

import { getSafeLinkAttributes } from './linkPolicy.js';
import { parseMarkdown } from './parser.js';

/**
 * Предельно допустимое количество создаваемых DOM-узлов (элементов и текстовых узлов).
 * Защищает графический поток браузера от исчерпания памяти и зависания при рендеринге.
 * @type {number}
 */
export const MAX_RENDER_NODES = 2000;

/**
 * Проверяет лимит и инкрементирует счетчик созданных узлов документа.
 *
 * @param {{ doc: Document, nodeCount: number, isTruncated: boolean }} ctx Контекст рендеринга.
 * @returns {boolean} True, если создание нового узла разрешено в пределах лимита.
 */
function canCreateNode(ctx) {
    if (ctx.nodeCount >= MAX_RENDER_NODES) {
        ctx.isTruncated = true;
        return false;
    }
    ctx.nodeCount++;
    return true;
}

/**
 * Рекурсивно монтирует массив дочерних узлов в родительский элемент.
 *
 * @param {Array<Object>|undefined} children Массив дочерних узлов AST.
 * @param {Node} parentEl Родительский DOM-элемент.
 * @param {{ doc: Document, nodeCount: number, isTruncated: boolean }} ctx Контекст рендеринга.
 */
function renderChildren(children, parentEl, ctx) {
    if (!Array.isArray(children)) {
        return;
    }

    for (let i = 0; i < children.length; i++) {
        if (ctx.isTruncated) {
            break;
        }
        const childNode = renderAstNode(children[i], ctx);
        if (childNode) {
            parentEl.appendChild(childNode);
        }
    }
}

/**
 * Преобразует единичный узел абстрактного синтаксического дерева в DOM-узел.
 *
 * @param {Object} node Узел AST.
 * @param {{ doc: Document, nodeCount: number, isTruncated: boolean }} ctx Контекст рендеринга.
 * @returns {Node|null} Созданный элемент, текстовый узел или null при превышении лимита.
 */
function renderAstNode(node, ctx) {
    if (!node || typeof node !== 'object' || !node.type) {
        return null;
    }

    // 1. Обработка строкового текстового узла
    if (node.type === 'text') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        return ctx.doc.createTextNode(typeof node.text === 'string' ? node.text : '');
    }

    // 2. Обработка инлайн-кода
    if (node.type === 'inline_code') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const code = ctx.doc.createElement('code');
        code.textContent = typeof node.text === 'string' ? node.text : '';
        return code;
    }

    // 3. Обработка полужирного текста
    if (node.type === 'strong') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const strong = ctx.doc.createElement('strong');
        renderChildren(node.children, strong, ctx);
        return strong;
    }

    // 4. Обработка курсива
    if (node.type === 'emphasis') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const em = ctx.doc.createElement('em');
        renderChildren(node.children, em, ctx);
        return em;
    }

    // 5. Обработка зачеркнутого текста
    if (node.type === 'strikethrough') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const del = ctx.doc.createElement('del');
        renderChildren(node.children, del, ctx);
        return del;
    }

    // 6. Обработка гиперссылок с интеграцией политики безопасности
    if (node.type === 'link') {
        const safeAttrs = getSafeLinkAttributes(node.href, node.title);

        if (safeAttrs) {
            if (!canCreateNode(ctx)) {
                return null;
            }
            const a = ctx.doc.createElement('a');
            a.setAttribute('href', safeAttrs.href);
            a.setAttribute('target', safeAttrs.target);
            a.setAttribute('rel', safeAttrs.rel);
            if (safeAttrs.title) {
                a.setAttribute('title', safeAttrs.title);
            }
            renderChildren(node.children, a, ctx);
            return a;
        }

        // При недопустимой схеме ссылка нейтрализуется в span без активного клика
        if (!canCreateNode(ctx)) {
            return null;
        }
        const span = ctx.doc.createElement('span');
        span.className = 'markdown-unsafe-link';
        renderChildren(node.children, span, ctx);
        return span;
    }

    // 7. Обработка параграфа
    if (node.type === 'paragraph') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const p = ctx.doc.createElement('p');
        renderChildren(node.children, p, ctx);
        return p;
    }

    // 8. Обработка заголовков (строго уровни 3, 4, 5)
    if (node.type === 'heading') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        let level = typeof node.level === 'number' ? node.level : 3;
        if (level !== 3 && level !== 4 && level !== 5) {
            level = 3;
        }
        const h = ctx.doc.createElement(`h${level}`);
        renderChildren(node.children, h, ctx);
        return h;
    }

    // 9. Обработка блоков цитат
    if (node.type === 'blockquote') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const bq = ctx.doc.createElement('blockquote');
        renderChildren(node.children, bq, ctx);
        return bq;
    }

    // 10. Обработка списков (маркированных и нумерованных)
    if (node.type === 'list') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const isOrdered = node.ordered === true;
        const list = ctx.doc.createElement(isOrdered ? 'ol' : 'ul');

        if (isOrdered && typeof node.start === 'number' && node.start > 1) {
            list.setAttribute('start', String(node.start));
        }

        if (Array.isArray(node.items)) {
            for (let i = 0; i < node.items.length; i++) {
                if (ctx.isTruncated) {
                    break;
                }
                const itemEl = renderAstNode(node.items[i], ctx);
                if (itemEl) {
                    list.appendChild(itemEl);
                }
            }
        }
        return list;
    }

    // 11. Обработка элемента списка
    if (node.type === 'list_item') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const li = ctx.doc.createElement('li');
        renderChildren(node.children, li, ctx);
        return li;
    }

    // 12. Обработка многострочного блока исходного кода
    if (node.type === 'code_block') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        const pre = ctx.doc.createElement('pre');

        if (!canCreateNode(ctx)) {
            return pre;
        }
        const code = ctx.doc.createElement('code');
        code.textContent = typeof node.text === 'string' ? node.text : '';

        if (typeof node.language === 'string' && node.language.trim().length > 0) {
            code.className = `language-${node.language.trim()}`;
        }

        pre.appendChild(code);
        return pre;
    }

    // 13. Обработка горизонтального разделителя
    if (node.type === 'thematic_break') {
        if (!canCreateNode(ctx)) {
            return null;
        }
        return ctx.doc.createElement('hr');
    }

    return null;
}

/**
 * Преобразует готовое абстрактное синтаксическое дерево (AST) Markdown в DocumentFragment.
 *
 * @param {Object} ast Корневой объект синтаксического дерева с узлом type: 'root'.
 * @param {{ documentRef?: Document }} [options={}] Опции рендеринга и ссылки на документ.
 * @returns {DocumentFragment} Фрагмент документа со смонтированными DOM-узлами.
 * @throws {Error} Если объект документа недоступен в текущей среде исполнения.
 */
export function renderMarkdownAst(ast, options = {}) {
    const doc = options.documentRef || globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') {
        throw new Error('DOM document is required for rendering');
    }

    const ctx = {
        doc,
        nodeCount: 0,
        isTruncated: false,
    };

    const fragment = doc.createDocumentFragment();

    if (ast && Array.isArray(ast.children)) {
        for (let i = 0; i < ast.children.length; i++) {
            if (ctx.isTruncated) {
                break;
            }
            const blockEl = renderAstNode(ast.children[i], ctx);
            if (blockEl) {
                fragment.appendChild(blockEl);
            }
        }
    }

    // Добавление сервисного предупреждения при превышении предела узлов
    if (ctx.isTruncated) {
        const notice = doc.createElement('p');
        notice.className = 'markdown-truncation-notice';
        notice.textContent = 'Превышен максимальный лимит отображаемых элементов разметки.';
        fragment.appendChild(notice);
    }

    return fragment;
}

/**
 * Выполняет полный конвейер разбора текста Markdown и рендеринга в DocumentFragment.
 *
 * @param {string|null|undefined} markdownText Исходный форматированный текст.
 * @param {{ documentRef?: Document }} [options={}] Опции рендеринга и контекст документа.
 * @returns {DocumentFragment} Готовый фрагмент документа со смонтированным контентом.
 */
export function renderMarkdown(markdownText, options = {}) {
    const ast = parseMarkdown(markdownText);
    return renderMarkdownAst(ast, options);
}
