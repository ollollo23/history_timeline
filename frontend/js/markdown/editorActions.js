/**
 * Модуль чистых функций форматирования текста в формате Markdown.
 * Предоставляет функции трансформации текстовых диапазонов для редактора
 * без обращений к DOM API, объектам window, document и HTML-элементам.
 * Все функции возвращают неизменяемый объект со скорректированными границами выделения.
 */

/**
 * Нормализует входящий текст и числовые границы выделения.
 *
 * @param {unknown} text Исходный текст.
 * @param {unknown} start Начальный индекс выделения.
 * @param {unknown} end Конечный индекс выделения.
 * @returns {{ text: string, start: number, end: number, valid: boolean }}
 */
function normalizeInputs(text, start, end) {
    if (typeof text !== 'string') {
        return { text: '', start: 0, end: 0, valid: false };
    }

    let s = typeof start === 'number' && !Number.isNaN(start) ? Math.floor(start) : 0;
    let e = typeof end === 'number' && !Number.isNaN(end) ? Math.floor(end) : s;

    if (s < 0) s = 0;
    if (e < 0) e = 0;
    if (s > text.length) s = text.length;
    if (e > text.length) e = text.length;

    if (s > e) {
        const tmp = s;
        s = e;
        e = tmp;
    }

    return { text, start: s, end: e, valid: true };
}

/**
 * Находит начальный и конечный индексы строк, охватывающих диапазон [start, end].
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {{ lineStart: number, lineEnd: number }}
 */
export function getLineRange(text, start, end) {
    const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1));
    const actualStart = lineStart === -1 ? 0 : lineStart + 1;

    const searchFrom = end > start && text[end - 1] === '\n' ? end - 1 : end;
    let lineEnd = text.indexOf('\n', searchFrom);
    if (lineEnd === -1) {
        lineEnd = text.length;
    }

    return { lineStart: actualStart, lineEnd };
}

/**
 * Выполняет строчную блочную трансформацию строк с пересчетом границ выделения.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @param {(lines: string[]) => { newLines: string[], lineDeltas: number[] }} lineTransformFn Функция преобразования строк.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
function transformLines(text, start, end, lineTransformFn) {
    const { lineStart, lineEnd } = getLineRange(text, start, end);
    const block = text.slice(lineStart, lineEnd);
    const lines = block.split('\n');

    const { newLines, lineDeltas } = lineTransformFn(lines);
    const newBlock = newLines.join('\n');
    const newText = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);

    let currentOrigOffset = lineStart;
    let currentNewOffset = lineStart;
    let newStart = start;
    let newEnd = end;
    let startAdjusted = false;
    let endAdjusted = false;

    for (let i = 0; i < lines.length; i++) {
        const origLine = lines[i];
        const delta = lineDeltas[i];
        const origLineLen = origLine.length;
        const nextOrigOffset = currentOrigOffset + origLineLen + 1;

        if (!startAdjusted) {
            if (start <= currentOrigOffset + origLineLen) {
                if (start === currentOrigOffset) {
                    newStart = start === end ? currentNewOffset + Math.max(0, delta) : currentNewOffset;
                } else {
                    newStart = start + (currentNewOffset - currentOrigOffset) + delta;
                }
                startAdjusted = true;
            }
        }

        if (!endAdjusted) {
            if (end <= currentOrigOffset + origLineLen) {
                if (end === currentOrigOffset) {
                    newEnd = currentNewOffset;
                } else {
                    newEnd = end + (currentNewOffset - currentOrigOffset) + delta;
                }
                endAdjusted = true;
            }
        }

        currentOrigOffset = nextOrigOffset;
        currentNewOffset += newLines[i].length + 1;
    }

    if (!startAdjusted) {
        newStart = start + (newBlock.length - block.length);
    }
    if (!endAdjusted) {
        newEnd = end + (newBlock.length - block.length);
    }

    newStart = Math.max(0, Math.min(newText.length, newStart));
    newEnd = Math.max(newStart, Math.min(newText.length, newEnd));

    return Object.freeze({
        text: newText,
        selectionStart: newStart,
        selectionEnd: newEnd,
    });
}

/**
 * Оборачивает или снимает инлайновое обрамление разметки вокруг выделения.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало диапазона.
 * @param {number} end Конец диапазона.
 * @param {string} delimiter Разделитель разметки.
 * @param {string} defaultText Текст-заполнитель при пустом выделении.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleInlineWrap(text, start, end, delimiter, defaultText) {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }
    const { text: srcText, start: s, end: e } = norm;
    const dLen = delimiter.length;

    // 1. Проверка случая, когда выделение само содержит маркеры по краям
    if (e - s >= dLen * 2) {
        const startsWithDelim = srcText.slice(s, s + dLen) === delimiter;
        const endsWithDelim = srcText.slice(e - dLen, e) === delimiter;

        if (startsWithDelim && endsWithDelim) {
            const isIsolated =
                delimiter !== '*' ||
                ((s === 0 || srcText[s - 1] !== '*') &&
                    (s + dLen >= srcText.length || srcText[s + dLen] !== '*') &&
                    (e - dLen === 0 || srcText[e - dLen - 1] !== '*') &&
                    (e >= srcText.length || srcText[e] !== '*'));

            if (isIsolated) {
                const unwrapped = srcText.slice(s + dLen, e - dLen);
                const newText = srcText.slice(0, s) + unwrapped + srcText.slice(e);
                return Object.freeze({
                    text: newText,
                    selectionStart: s,
                    selectionEnd: s + unwrapped.length,
                });
            }
        }
    }

    // 2. Проверка случая, когда выделение окружено маркерами
    if (s >= dLen && e + dLen <= srcText.length) {
        const before = srcText.slice(s - dLen, s);
        const after = srcText.slice(e, e + dLen);

        if (before === delimiter && after === delimiter) {
            const isIsolated =
                delimiter !== '*' ||
                ((s - dLen === 0 || srcText[s - dLen - 1] !== '*') &&
                    (s >= srcText.length || srcText[s] !== '*') &&
                    (e === 0 || srcText[e - 1] !== '*') &&
                    (e + dLen >= srcText.length || srcText[e + dLen] !== '*'));

            if (isIsolated) {
                const inner = srcText.slice(s, e);
                const newText = srcText.slice(0, s - dLen) + inner + srcText.slice(e + dLen);
                return Object.freeze({
                    text: newText,
                    selectionStart: s - dLen,
                    selectionEnd: s - dLen + inner.length,
                });
            }
        }
    }

    // 3. Выделение не обернуто: применяем обрамление
    if (s === e) {
        const newText = srcText.slice(0, s) + delimiter + defaultText + delimiter + srcText.slice(e);
        const newStart = s + dLen;
        const newEnd = newStart + defaultText.length;
        return Object.freeze({
            text: newText,
            selectionStart: newStart,
            selectionEnd: newEnd,
        });
    }

    const selected = srcText.slice(s, e);
    const newText = srcText.slice(0, s) + delimiter + selected + delimiter + srcText.slice(e);
    return Object.freeze({
        text: newText,
        selectionStart: s + dLen,
        selectionEnd: e + dLen,
    });
}

/**
 * Переключает форматирование жирного шрифта (две звездочки).
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleBold(text, start, end) {
    return toggleInlineWrap(text, start, end, '**', 'жирный текст');
}

/**
 * Переключает форматирование курсива (одна звездочка).
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleItalic(text, start, end) {
    return toggleInlineWrap(text, start, end, '*', 'курсив');
}

/**
 * Переключает форматирование зачеркнутого текста (две тильды).
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleStrikethrough(text, start, end) {
    return toggleInlineWrap(text, start, end, '~~', 'зачеркнутый текст');
}

/**
 * Переключает форматирование инлайн-кода (обратные кавычки).
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleInlineCode(text, start, end) {
    return toggleInlineWrap(text, start, end, '`', 'код');
}

/**
 * Форматирует выделенный фрагмент как ссылку Markdown.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @param {string} [defaultUrl='https://example.com'] URL по умолчанию.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function formatLink(text, start, end, defaultUrl = 'https://example.com') {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }
    const { text: srcText, start: s, end: e } = norm;
    const url =
        typeof defaultUrl === 'string' && defaultUrl.trim().length > 0
            ? defaultUrl.trim()
            : 'https://example.com';

    if (s === e) {
        const label = 'ссылка';
        const formatted = `[${label}](${url})`;
        const newText = srcText.slice(0, s) + formatted + srcText.slice(e);
        const newStart = s + 1;
        const newEnd = newStart + label.length;
        return Object.freeze({
            text: newText,
            selectionStart: newStart,
            selectionEnd: newEnd,
        });
    }

    const selected = srcText.slice(s, e);
    const prefix = `[${selected}](`;
    const formatted = `${prefix}${url})`;
    const newText = srcText.slice(0, s) + formatted + srcText.slice(e);
    const newStart = s + prefix.length;
    const newEnd = newStart + url.length;
    return Object.freeze({
        text: newText,
        selectionStart: newStart,
        selectionEnd: newEnd,
    });
}

/**
 * Переключает или обновляет заголовок Markdown заданного уровня (h3-h5).
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @param {number} [level=3] Уровень заголовка (от 3 до 5).
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleHeading(text, start, end, level = 3) {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }
    let lvl = typeof level === 'number' && Number.isInteger(level) ? level : 3;
    if (lvl < 3) lvl = 3;
    if (lvl > 5) lvl = 5;

    const targetPrefix = '#'.repeat(lvl) + ' ';

    return transformLines(norm.text, norm.start, norm.end, (lines) => {
        const headingRegex = /^ {0,3}(#{1,6})\s+/;
        const nonEmpty = lines.filter((l) => l.trim().length > 0);
        const allHaveTarget =
            nonEmpty.length > 0 &&
            nonEmpty.every((l) => {
                const m = l.match(headingRegex);
                return m && m[1].length === lvl;
            });

        let newLines;
        if (allHaveTarget) {
            newLines = lines.map((l) => {
                const m = l.match(headingRegex);
                return m ? l.slice(m[0].length) : l;
            });
        } else {
            newLines = lines.map((l) => {
                const m = l.match(headingRegex);
                if (m) {
                    return targetPrefix + l.slice(m[0].length);
                }
                if (l.trim().length > 0 || lines.length === 1) {
                    return targetPrefix + l;
                }
                return l;
            });
        }

        const lineDeltas = newLines.map((nl, i) => nl.length - lines[i].length);
        return { newLines, lineDeltas };
    });
}

/**
 * Переключает маркированный список Markdown с маркером дефиса.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleUnorderedList(text, start, end) {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }

    const prefix = '- ';
    return transformLines(norm.text, norm.start, norm.end, (lines) => {
        const listRegex = /^ {0,3}[-*+]\s+/;
        const nonEmpty = lines.filter((l) => l.trim().length > 0);
        const allUnordered = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));

        let newLines;
        if (allUnordered) {
            newLines = lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
        } else {
            newLines = lines.map((l) => {
                if (l.trim().length > 0 || lines.length === 1) {
                    const m = l.match(listRegex);
                    const clean = m ? l.slice(m[0].length) : l;
                    return prefix + clean;
                }
                return l;
            });
        }

        const lineDeltas = newLines.map((nl, i) => nl.length - lines[i].length);
        return { newLines, lineDeltas };
    });
}

/**
 * Переключает нумерованный список Markdown с автоинкрементом номеров.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleOrderedList(text, start, end) {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }

    const orderedRegex = /^ {0,3}\d+\.\s+/;
    const bulletRegex = /^ {0,3}[-*+]\s+/;

    return transformLines(norm.text, norm.start, norm.end, (lines) => {
        const nonEmpty = lines.filter((l) => l.trim().length > 0);
        const allOrdered = nonEmpty.length > 0 && nonEmpty.every((l) => orderedRegex.test(l));

        let newLines;
        if (allOrdered) {
            newLines = lines.map((l) => {
                const m = l.match(orderedRegex);
                return m ? l.slice(m[0].length) : l;
            });
        } else {
            let counter = 1;
            newLines = lines.map((l) => {
                if (l.trim().length > 0 || lines.length === 1) {
                    let clean = l;
                    const om = clean.match(orderedRegex);
                    if (om) {
                        clean = clean.slice(om[0].length);
                    } else {
                        const bm = clean.match(bulletRegex);
                        if (bm) {
                            clean = clean.slice(bm[0].length);
                        }
                    }
                    const res = `${counter}. ${clean}`;
                    counter++;
                    return res;
                }
                return l;
            });
        }

        const lineDeltas = newLines.map((nl, i) => nl.length - lines[i].length);
        return { newLines, lineDeltas };
    });
}

/**
 * Переключает блок цитаты Markdown с маркером угловой скобки.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleBlockquote(text, start, end) {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }

    const prefix = '> ';
    return transformLines(norm.text, norm.start, norm.end, (lines) => {
        const isQuote = (l) => l.startsWith(prefix) || l === '>';
        const nonEmpty = lines.filter((l) => l.trim().length > 0);
        const allQuote = nonEmpty.length > 0 && nonEmpty.every(isQuote);

        let newLines;
        if (allQuote) {
            newLines = lines.map((l) => {
                if (l.startsWith(prefix)) {
                    return l.slice(prefix.length);
                }
                if (l === '>') {
                    return '';
                }
                return l;
            });
        } else {
            newLines = lines.map((l) => (l.trim().length > 0 || lines.length === 1 ? prefix + l : l));
        }

        const lineDeltas = newLines.map((nl, i) => nl.length - lines[i].length);
        return { newLines, lineDeltas };
    });
}

/**
 * Переключает многострочный блок кода с тройными обратными кавычками.
 *
 * @param {string} text Исходный текст.
 * @param {number} start Начало выделения.
 * @param {number} end Конец выделения.
 * @param {string} [defaultLang=''] Язык программирования по умолчанию.
 * @returns {Readonly<{ text: string, selectionStart: number, selectionEnd: number }>}
 */
export function toggleCodeBlock(text, start, end, defaultLang = '') {
    const norm = normalizeInputs(text, start, end);
    if (!norm.valid) {
        return Object.freeze({ text: '', selectionStart: 0, selectionEnd: 0 });
    }
    const { text: srcText, start: s, end: e } = norm;
    const lang = typeof defaultLang === 'string' ? defaultLang.trim() : '';

    const { lineStart, lineEnd } = getLineRange(srcText, s, e);
    const block = srcText.slice(lineStart, lineEnd);
    const lines = block.split('\n');

    // 1. Проверка наличия ограждающих блоков внутри выделенных строк
    if (lines.length >= 2 && lines[0].startsWith('```') && lines[lines.length - 1].startsWith('```')) {
        const innerLines = lines.slice(1, -1);
        const newBlock = innerLines.join('\n');
        const newText = srcText.slice(0, lineStart) + newBlock + srcText.slice(lineEnd);
        return Object.freeze({
            text: newText,
            selectionStart: lineStart,
            selectionEnd: lineStart + newBlock.length,
        });
    }

    // 2. Проверка обрамляющих строк кода выше и ниже диапазона
    if (lineStart > 0 && lineEnd < srcText.length) {
        const prevRange = getLineRange(srcText, lineStart - 1, lineStart - 1);
        const nextRange = getLineRange(srcText, lineEnd + 1, lineEnd + 1);
        const prevLine = srcText.slice(prevRange.lineStart, prevRange.lineEnd);
        const nextLine = srcText.slice(nextRange.lineStart, nextRange.lineEnd);

        if (prevLine.startsWith('```') && nextLine.startsWith('```')) {
            const newText = srcText.slice(0, prevRange.lineStart) + block + srcText.slice(nextRange.lineEnd);
            const shift = prevRange.lineEnd - prevRange.lineStart + 1;
            return Object.freeze({
                text: newText,
                selectionStart: lineStart - shift,
                selectionEnd: lineEnd - shift,
            });
        }
    }

    // 3. Пустое выделение: вставка блока с текстом-заполнителем
    if (s === e) {
        const placeholder = 'код';
        const openFence = '```' + lang;
        const closeFence = '```';
        const insertText = `${openFence}\n${placeholder}\n${closeFence}`;

        const needsLeadingNewline = s > 0 && srcText[s - 1] !== '\n';
        const needsTrailingNewline = s < srcText.length && srcText[s] !== '\n';

        const prefix = needsLeadingNewline ? '\n' : '';
        const suffix = needsTrailingNewline ? '\n' : '';

        const fullInsert = prefix + insertText + suffix;
        const newText = srcText.slice(0, s) + fullInsert + srcText.slice(e);

        const newStart = s + prefix.length + openFence.length + 1;
        const newEnd = newStart + placeholder.length;

        return Object.freeze({
            text: newText,
            selectionStart: newStart,
            selectionEnd: newEnd,
        });
    }

    // 4. Непустое выделение: оборачивание строк в блок кода
    const openFence = '```' + lang;
    const closeFence = '```';
    const wrappedBlock = `${openFence}\n${block}\n${closeFence}`;
    const newText = srcText.slice(0, lineStart) + wrappedBlock + srcText.slice(lineEnd);

    const newStart = lineStart + openFence.length + 1;
    const newEnd = newStart + block.length;

    return Object.freeze({
        text: newText,
        selectionStart: newStart,
        selectionEnd: newEnd,
    });
}
