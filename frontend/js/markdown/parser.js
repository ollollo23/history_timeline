/**
 * Модуль синтаксического анализатора подмножества языка Markdown.
 * Преобразует исходный текст в абстрактное синтаксическое дерево (AST)
 * без использования сторонних библиотек и браузерного окружения DOM.
 *
 * Архитектурные принципы:
 * 1. Изоляция от DOM: модуль не использует document, window, DOMParser и innerHTML.
 * 2. Защита от ReDoS: строчный разбор использует линейное сканирование O(N).
 * 3. Ограничение рекурсии: максимальная глубина вложенности ограничена MAX_NESTING_DEPTH.
 * 4. Безопасность разметки: сырой HTML сохраняется как плоские текстовые узлы.
 * 5. Соответствие CommonMark: запрещены вложенные узлы ссылок link внутри link.
 */

/**
 * Предельная глубина рекурсивной вложенности для списков и цитат.
 * При превышении лимита вложенные структуры сворачиваются в линейные блоки.
 * @type {number}
 */
export const MAX_NESTING_DEPTH = 4;

/**
 * Объединяет соседние текстовые узлы в один непрерывный узел.
 *
 * @param {Array<Object>} nodes Массив строчных узлов AST.
 * @returns {Array<Object>} Оптимизированный массив узлов.
 */
function mergeAdjacentTextNodes(nodes) {
    const merged = [];
    for (let i = 0; i < nodes.length; i++) {
        const current = nodes[i];
        if (
            current.type === 'text' &&
            merged.length > 0 &&
            merged[merged.length - 1].type === 'text'
        ) {
            merged[merged.length - 1].text += current.text;
        } else {
            merged.push(current);
        }
    }
    return merged;
}

/**
 * Линейный синтаксический анализ строчных элементов (inline) разметки.
 * Выполняет разбор жирного текста, курсива, зачеркивания, инлайн-кода, ссылок и экранирования.
 *
 * @param {string} text Текстовая строка для инлайн-парсинга.
 * @param {boolean} [allowLinks=true] Флаг разрешения разбора ссылок (запрещает вложенные ссылки).
 * @returns {Array<Object>} Массив строчных узлов AST.
 */
export function parseInline(text, allowLinks = true) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    const result = [];
    let textBuf = '';

    function flushText() {
        if (textBuf.length > 0) {
            result.push({ type: 'text', text: textBuf });
            textBuf = '';
        }
    }

    let i = 0;
    const len = text.length;

    // Переменные для кэширования индексов закрывающих скобок и кавычек ради O(N)
    let nextCloseBracket = -1;
    let hasClosingBracket = true;
    let nextCloseTick = -1;
    let hasClosingTick = true;

    while (i < len) {
        // 1. Обработка экранирования через обратный слеш
        if (text[i] === '\\' && i + 1 < len) {
            const nextChar = text[i + 1];
            if (['*', '_', '[', ']', '~', '`', '\\'].includes(nextChar)) {
                textBuf += nextChar;
                i += 2;
                continue;
            }
        }

        // 2. Инлайн-код: одиночные обратные кавычки с O(N) кэшированием поиска
        if (hasClosingTick && text[i] === '`') {
            if (nextCloseTick < i + 1) {
                nextCloseTick = text.indexOf('`', i + 1);
                if (nextCloseTick === -1) {
                    hasClosingTick = false;
                    textBuf += text[i];
                    i++;
                    continue;
                }
            }
            const closeIdx = nextCloseTick;
            flushText();
            const codeContent = text.slice(i + 1, closeIdx);
            result.push({ type: 'inline_code', text: codeContent });
            i = closeIdx + 1;
            continue;
        }

        // 3. Зачеркивание: ~~текст~~
        if (text.startsWith('~~', i)) {
            let closeIdx = -1;
            for (let j = i + 2; j < len - 1; j++) {
                if (text[j] === '\\') {
                    j++;
                    continue;
                }
                if (text[j] === '~' && text[j + 1] === '~') {
                    closeIdx = j;
                    break;
                }
            }
            if (closeIdx !== -1 && closeIdx > i + 2) {
                flushText();
                const inner = text.slice(i + 2, closeIdx);
                result.push({
                    type: 'strikethrough',
                    children: parseInline(inner, allowLinks),
                });
                i = closeIdx + 2;
                continue;
            }
        }

        // 4. Тройное выделение (жирный + курсив): ***текст*** или ___текст___
        if (text.startsWith('***', i) || text.startsWith('___', i)) {
            const delimiter = text.slice(i, i + 3);
            let closeIdx = -1;
            for (let j = i + 3; j <= len - 3; j++) {
                if (text[j] === '\\') {
                    j++;
                    continue;
                }
                if (text.startsWith(delimiter, j)) {
                    closeIdx = j;
                    break;
                }
            }
            if (closeIdx !== -1 && closeIdx > i + 3) {
                flushText();
                const inner = text.slice(i + 3, closeIdx);
                result.push({
                    type: 'strong',
                    children: [
                        {
                            type: 'emphasis',
                            children: parseInline(inner, allowLinks),
                        },
                    ],
                });
                i = closeIdx + 3;
                continue;
            }
        }

        // 5. Жирный шрифт: **текст** или __текст__
        if (text.startsWith('**', i) || text.startsWith('__', i)) {
            const delimiter = text.slice(i, i + 2);
            let closeIdx = -1;
            for (let j = i + 2; j <= len - 2; j++) {
                if (text[j] === '\\') {
                    j++;
                    continue;
                }
                if (text.startsWith(delimiter, j)) {
                    closeIdx = j;
                    break;
                }
            }
            if (closeIdx !== -1 && closeIdx > i + 2) {
                flushText();
                const inner = text.slice(i + 2, closeIdx);
                result.push({
                    type: 'strong',
                    children: parseInline(inner, allowLinks),
                });
                i = closeIdx + 2;
                continue;
            }
        }

        // 6. Курсив: *текст* или _текст_
        if (text[i] === '*' || text[i] === '_') {
            const delimiter = text[i];
            let closeIdx = -1;
            for (let j = i + 1; j < len; j++) {
                if (text[j] === '\\') {
                    j++;
                    continue;
                }
                if (text[j] === delimiter) {
                    closeIdx = j;
                    break;
                }
            }
            if (closeIdx !== -1 && closeIdx > i + 1) {
                flushText();
                const inner = text.slice(i + 1, closeIdx);
                result.push({
                    type: 'emphasis',
                    children: parseInline(inner, allowLinks),
                });
                i = closeIdx + 1;
                continue;
            }
        }

        // 7. Ссылки: [текст](url) или [текст](url "title")
        if (allowLinks && hasClosingBracket && text[i] === '[') {
            // Кэшированная проверка наличия закрывающей скобки ']' в оставшейся строке
            if (nextCloseBracket < i + 1) {
                nextCloseBracket = text.indexOf(']', i + 1);
                if (nextCloseBracket === -1) {
                    hasClosingBracket = false;
                    textBuf += text[i];
                    i++;
                    continue;
                }
            }

            // Поиск парной закрывающей скобки текста ссылки с учетом экранирования
            let bracketDepth = 1;
            let closeBracket = -1;
            for (let j = i + 1; j < len; j++) {
                if (text[j] === '\\') {
                    j++;
                    continue;
                }
                if (text[j] === '[') {
                    bracketDepth++;
                } else if (text[j] === ']') {
                    bracketDepth--;
                    if (bracketDepth === 0) {
                        closeBracket = j;
                        break;
                    }
                }
            }

            // Проверка наличия открывающей круглой скобки адреса сразу за закрывающей квадратной
            if (
                closeBracket !== -1 &&
                closeBracket + 1 < len &&
                text[closeBracket + 1] === '('
            ) {
                // Сканирование адреса со сбалансированными круглыми скобками (depth counter)
                let parenDepth = 1;
                let closeParen = -1;
                for (let k = closeBracket + 2; k < len; k++) {
                    if (text[k] === '\\') {
                        k++;
                        continue;
                    }
                    if (text[k] === '(') {
                        parenDepth++;
                    } else if (text[k] === ')') {
                        parenDepth--;
                        if (parenDepth === 0) {
                            closeParen = k;
                            break;
                        }
                    }
                }

                if (closeParen !== -1) {
                    const linkText = text.slice(i + 1, closeBracket);
                    const rawTarget = text.slice(closeBracket + 2, closeParen).trim();
                    let href = rawTarget;
                    let title = null;

                    // Выделение опционального заголовка title в кавычках из конца строки адреса
                    const titleMatch = rawTarget.match(/^(.*?)\s+(["'])(.*)\2$/);
                    if (titleMatch) {
                        href = titleMatch[1].trim();
                        title = titleMatch[3];
                    }

                    flushText();
                    // Рекурсивный разбор детей ссылки с allowLinks: false (запрет вложенных ссылок)
                    result.push({
                        type: 'link',
                        href,
                        title,
                        children: parseInline(linkText, false),
                    });
                    i = closeParen + 1;
                    continue;
                }
            }
        }

        // 8. Накопление обычных символов текста (включая сырые HTML-теги)
        textBuf += text[i];
        i++;
    }

    flushText();
    return mergeAdjacentTextNodes(result);
}

/**
 * Проверяет, является ли строка началом нового блочного элемента.
 *
 * @param {string} line Проверяемая строка.
 * @returns {boolean} True, если строка открывает новый блочный элемент.
 */
function isBlockStart(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
        return true;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        return true;
    }
    if (/^ {0,3}#{1,6}\s+/.test(line)) {
        return true;
    }
    if (line.trimStart().startsWith('>')) {
        return true;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        return true;
    }
    return false;
}

/**
 * Рекурсивный синтаксический анализ блочных структур документа.
 *
 * @param {Array<string>} lines Массив строк текста.
 * @param {number} depth Текущий уровень рекурсивной вложенности.
 * @returns {Array<Object>} Массив блочных узлов AST.
 */
function parseBlocks(lines, depth) {
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // 1. Пропуск пустых строк
        if (line.trim() === '') {
            i++;
            continue;
        }

        // 2. Блоки исходного кода (Fenced Code Blocks)
        if (line.trimStart().startsWith('```')) {
            const afterTicks = line.trimStart().replace(/^```+/, '').trim();
            const language = afterTicks.length > 0 ? afterTicks.split(/\s+/)[0] : null;
            const codeLines = [];
            i++;

            while (i < lines.length) {
                if (lines[i].trimStart().startsWith('```')) {
                    i++;
                    break;
                }
                codeLines.push(lines[i]);
                i++;
            }

            blocks.push({
                type: 'code_block',
                language,
                text: codeLines.join('\n'),
            });
            continue;
        }

        // 3. Горизонтальный разделитель (Thematic Break)
        if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            blocks.push({ type: 'thematic_break' });
            i++;
            continue;
        }

        // 4. Заголовки (Headings с нормализацией уровней 3-5)
        const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const rawLevel = headingMatch[1].length;
            let content = headingMatch[2].trim();
            content = content.replace(/\s+#+\s*$/, '');

            let level = rawLevel;
            if (level <= 2) {
                level = 3;
            } else if (level >= 6) {
                level = 5;
            }

            blocks.push({
                type: 'heading',
                level,
                children: parseInline(content),
            });
            i++;
            continue;
        }

        // 5. Блоки цитат (Blockquotes)
        if (line.trimStart().startsWith('>')) {
            const quoteLines = [];
            while (i < lines.length) {
                const currentLine = lines[i];
                if (currentLine.trimStart().startsWith('>')) {
                    quoteLines.push(currentLine.trimStart().replace(/^>\s?/, ''));
                    i++;
                } else if (
                    currentLine.trim() !== '' &&
                    quoteLines.length > 0 &&
                    !isBlockStart(currentLine)
                ) {
                    quoteLines.push(currentLine);
                    i++;
                } else {
                    break;
                }
            }

            if (depth >= MAX_NESTING_DEPTH) {
                blocks.push({
                    type: 'paragraph',
                    children: parseInline(quoteLines.join(' ')),
                });
            } else {
                blocks.push({
                    type: 'blockquote',
                    children: parseBlocks(quoteLines, depth + 1),
                });
            }
            continue;
        }

        // 6. Списки (Lists: маркированные и нумерованные)
        const listMatch = line.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
        if (listMatch) {
            if (depth >= MAX_NESTING_DEPTH) {
                const textLines = [];
                while (i < lines.length) {
                    const m = lines[i].match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
                    if (m) {
                        textLines.push(m[2]);
                        i++;
                    } else if (lines[i].trim() !== '' && !isBlockStart(lines[i])) {
                        textLines.push(lines[i].trim());
                        i++;
                    } else {
                        break;
                    }
                }
                blocks.push({
                    type: 'paragraph',
                    children: parseInline(textLines.join(' ')),
                });
                continue;
            }

            const baseIndent = listMatch[1].length;
            const isOrdered = Boolean(listMatch[3]);
            const startNum = isOrdered ? parseInt(listMatch[3], 10) : null;
            const items = [];

            while (i < lines.length) {
                if (lines[i].trim() === '') {
                    let nextNonEmpty = i + 1;
                    while (nextNonEmpty < lines.length && lines[nextNonEmpty].trim() === '') {
                        nextNonEmpty++;
                    }
                    if (nextNonEmpty >= lines.length) {
                        i = nextNonEmpty;
                        break;
                    }
                    const nextLine = lines[nextNonEmpty];
                    const nextMatch = nextLine.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
                    if (nextMatch && nextMatch[1].length >= baseIndent) {
                        i = nextNonEmpty;
                    } else if (nextLine.search(/\S/) > baseIndent) {
                        i = nextNonEmpty;
                    } else {
                        break;
                    }
                }

                const currentLine = lines[i];
                const itemMatch = currentLine.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);

                if (!itemMatch || itemMatch[1].length < baseIndent) {
                    break;
                }

                if (itemMatch[1].length === baseIndent) {
                    const currentOrdered = Boolean(itemMatch[3]);
                    if (currentOrdered !== isOrdered && items.length > 0) {
                        break;
                    }

                    const itemText = itemMatch[4];
                    const subLines = [];
                    i++;

                    while (i < lines.length) {
                        const peekLine = lines[i];
                        if (peekLine.trim() === '') {
                            let lookahead = i + 1;
                            while (lookahead < lines.length && lines[lookahead].trim() === '') {
                                lookahead++;
                            }
                            if (
                                lookahead < lines.length &&
                                lines[lookahead].search(/\S/) > baseIndent
                            ) {
                                subLines.push(peekLine);
                                i++;
                                continue;
                            } else {
                                break;
                            }
                        }

                        const peekMatch = peekLine.match(/^(\s*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
                        if (peekMatch && peekMatch[1].length <= baseIndent) {
                            break;
                        }

                        if (peekLine.search(/\S/) > baseIndent) {
                            subLines.push(peekLine);
                            i++;
                        } else {
                            break;
                        }
                    }

                    const itemChildren = [];
                    if (itemText.trim().length > 0) {
                        itemChildren.push(...parseInline(itemText));
                    }

                    if (subLines.length > 0) {
                        const nonEmptySubLines = subLines.filter((l) => l.trim() !== '');
                        if (nonEmptySubLines.length > 0) {
                            const minIndent = Math.min(
                                ...nonEmptySubLines.map((l) => l.search(/\S/))
                            );
                            const dedented = subLines.map((l) =>
                                l.trim() === '' ? '' : l.slice(minIndent)
                            );
                            const subBlocks = parseBlocks(dedented, depth + 1);
                            itemChildren.push(...subBlocks);
                        }
                    }

                    items.push({
                        type: 'list_item',
                        children: itemChildren,
                    });
                } else {
                    break;
                }
            }

            blocks.push({
                type: 'list',
                ordered: isOrdered,
                start: startNum,
                items,
            });
            continue;
        }

        // 7. Параграфы (Paragraphs: непрерывные строки текста)
        const paraLines = [line];
        i++;
        while (i < lines.length) {
            const nextLine = lines[i];
            if (nextLine.trim() === '' || isBlockStart(nextLine)) {
                break;
            }
            paraLines.push(nextLine.trim());
            i++;
        }

        blocks.push({
            type: 'paragraph',
            children: parseInline(paraLines.join(' ')),
        });
    }

    return blocks;
}

/**
 * Главная точка входа синтаксического анализатора Markdown.
 * Выполняет нормализацию текста и строит дерево AST с корнем root.
 *
 * @param {string|null|undefined} markdownText Исходный текст в формате Markdown.
 * @returns {{ type: 'root', children: Array<Object> }} Корневой узел AST документа.
 */
export function parseMarkdown(markdownText) {
    if (typeof markdownText !== 'string' || !markdownText) {
        return { type: 'root', children: [] };
    }

    // Удаление нулевых байтов для защиты от уязвимостей экранирования
    let normalized = markdownText.replace(/\0/g, '');

    // Унификация переводов строк (CRLF, CR -> LF)
    normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Преобразование табуляции в 4 пробела для детерминированного разбора отступов
    normalized = normalized.replace(/\t/g, '    ');

    const lines = normalized.split('\n');
    const children = parseBlocks(lines, 0);

    return {
        type: 'root',
        children,
    };
}
