/**
 * Модульные тесты функций форматирования текста редактора (editorActions.js).
 * Выполняются в среде Node.js под управлением Vitest.
 * Проверяют инлайновое форматирование, математическую идемпотентность снятия разметки,
 * границы диапазонов выделения, обработку пробелов, сложные многострочные блочные
 * трансформации (заголовки h3-h5, списки, цитаты, код) и устойчивость к граничным условиям.
 */

import { describe, it, expect } from 'vitest';
import {
    toggleBold,
    toggleItalic,
    toggleStrikethrough,
    toggleInlineCode,
    formatLink,
    toggleHeading,
    toggleUnorderedList,
    toggleOrderedList,
    toggleBlockquote,
    toggleCodeBlock,
} from '../../frontend/js/markdown/editorActions.js';

describe('Модуль функций форматирования Markdown редактора (editorActions.js)', () => {
    describe('Инлайновое форматирование жирного шрифта (toggleBold)', () => {
        it('применяет жирный шрифт к выделенному слову внутри предложения со сдвигом курсора', () => {
            const text = 'Текст сообщения для проверки';
            // Выделяем слово "сообщения" (индексы с 6 по 15)
            const result = toggleBold(text, 6, 15);

            expect(result.text).toBe('Текст **сообщения** для проверки');
            expect(result.selectionStart).toBe(8);
            expect(result.selectionEnd).toBe(17);
        });

        it('снимает разметку жирного шрифта при повторном вызове на выделенном фрагменте', () => {
            const formattedText = 'Текст **сообщения** для проверки';

            // Случай 1: выделен текст внутри маркеров (индексы с 8 по 17)
            const unwrappedInner = toggleBold(formattedText, 8, 17);
            expect(unwrappedInner.text).toBe('Текст сообщения для проверки');
            expect(unwrappedInner.selectionStart).toBe(6);
            expect(unwrappedInner.selectionEnd).toBe(15);

            // Случай 2: выделен текст вместе с маркерами (индексы с 6 по 19)
            const unwrappedOuter = toggleBold(formattedText, 6, 19);
            expect(unwrappedOuter.text).toBe('Текст сообщения для проверки');
            expect(unwrappedOuter.selectionStart).toBe(6);
            expect(unwrappedOuter.selectionEnd).toBe(15);
        });

        it('вставляет текст по умолчанию при пустом выделении и выделяет заполнитель', () => {
            const text = 'Начало ';
            const result = toggleBold(text, 7, 7);

            expect(result.text).toBe('Начало **жирный текст**');
            expect(result.selectionStart).toBe(9);
            expect(result.selectionEnd).toBe(9 + 'жирный текст'.length);
        });
    });

    describe('Курсив и зачеркивание (toggleItalic, toggleStrikethrough)', () => {
        it('обрамляет и снимает курсив при непустом и пустом выделении', () => {
            const text = 'Текст сообщения';
            const result = toggleItalic(text, 6, 15);

            expect(result.text).toBe('Текст *сообщения*');
            expect(result.selectionStart).toBe(7);
            expect(result.selectionEnd).toBe(16);

            const unwrapped = toggleItalic(result.text, 7, 16);
            expect(unwrapped.text).toBe('Текст сообщения');
            expect(unwrapped.selectionStart).toBe(6);
            expect(unwrapped.selectionEnd).toBe(15);

            const emptyResult = toggleItalic('Курсор ', 7, 7);
            expect(emptyResult.text).toBe('Курсор *курсив*');
            expect(emptyResult.selectionStart).toBe(8);
            expect(emptyResult.selectionEnd).toBe(8 + 'курсив'.length);
        });

        it('не путает маркер одинарной звездочки с двойными звездочками жирного шрифта', () => {
            const boldText = 'Текст **жирный**';
            // Выделяем слово "жирный" внутри ** (индексы с 8 по 14)
            const result = toggleItalic(boldText, 8, 14);

            // Ожидается добавление курсива (три звездочки), а не снятие жирного шрифта
            expect(result.text).toBe('Текст ***жирный***');
            expect(result.selectionStart).toBe(9);
            expect(result.selectionEnd).toBe(15);
        });

        it('обрамляет и снимает тильды зачеркнутого текста', () => {
            const text = 'Текст черновика';
            const result = toggleStrikethrough(text, 6, 15);

            expect(result.text).toBe('Текст ~~черновика~~');
            expect(result.selectionStart).toBe(8);
            expect(result.selectionEnd).toBe(17);

            const unwrapped = toggleStrikethrough(result.text, 8, 17);
            expect(unwrapped.text).toBe('Текст черновика');
            expect(unwrapped.selectionStart).toBe(6);
            expect(unwrapped.selectionEnd).toBe(15);

            const emptyResult = toggleStrikethrough('', 0, 0);
            expect(emptyResult.text).toBe('~~зачеркнутый текст~~');
            expect(emptyResult.selectionStart).toBe(2);
            expect(emptyResult.selectionEnd).toBe(2 + 'зачеркнутый текст'.length);
        });
    });

    describe('Инлайн-код и гиперссылки (toggleInlineCode, formatLink)', () => {
        it('обрамляет и снимает обратные кавычки инлайн-кода', () => {
            const text = 'Команда npm test для тестов';
            const result = toggleInlineCode(text, 8, 16);

            expect(result.text).toBe('Команда `npm test` для тестов');
            expect(result.selectionStart).toBe(9);
            expect(result.selectionEnd).toBe(17);

            const unwrapped = toggleInlineCode(result.text, 9, 17);
            expect(unwrapped.text).toBe('Команда npm test для тестов');
            expect(unwrapped.selectionStart).toBe(8);
            expect(unwrapped.selectionEnd).toBe(16);
        });

        it('формирует ссылку при пустом выделении с выделением текста метки', () => {
            const text = 'Смотри тут: ';
            const result = formatLink(text, 12, 12, 'https://timeline.org');

            expect(result.text).toBe('Смотри тут: [ссылка](https://timeline.org)');
            expect(result.selectionStart).toBe(13);
            expect(result.selectionEnd).toBe(13 + 'ссылка'.length);
        });

        it('формирует ссылку при выделенном тексте с выделением адреса URL', () => {
            const text = 'Смотри архив документов далее';
            // Выделяем "архив документов" (индексы с 7 по 23)
            const result = formatLink(text, 7, 23, 'https://archive.org');

            expect(result.text).toBe('Смотри [архив документов](https://archive.org) далее');
            const urlStart = 'Смотри [архив документов]('.length;
            expect(result.selectionStart).toBe(urlStart);
            expect(result.selectionEnd).toBe(urlStart + 'https://archive.org'.length);
        });
    });

    describe('Блочные заголовки (toggleHeading)', () => {
        it('добавляет заголовок h3 к одиночной строке', () => {
            const text = 'Заголовок раздела';
            const result = toggleHeading(text, 0, 0, 3);

            expect(result.text).toBe('### Заголовок раздела');
        });

        it('добавляет заголовок, когда курсор находится в середине строки', () => {
            const text = 'Начало строки с курсором';
            const result = toggleHeading(text, 10, 10, 3);

            expect(result.text).toBe('### Начало строки с курсором');
        });

        it('снимает заголовок при повторном вызове с тем же уровнем', () => {
            const text = '### Заголовок раздела';
            const result = toggleHeading(text, 5, 5, 3);

            expect(result.text).toBe('Заголовок раздела');
        });

        it('заменяет уровень существующего заголовка с h3 на h4', () => {
            const text = '### Заголовок раздела';
            const result = toggleHeading(text, 2, 2, 4);

            expect(result.text).toBe('#### Заголовок раздела');
        });
    });

    describe('Списки и цитаты (многострочные операции)', () => {
        it('обрабатывает маркированный список на одиночной и нескольких строках', () => {
            const singleLine = 'Одиночный пункт';
            const singleResult = toggleUnorderedList(singleLine, 0, 0);
            expect(singleResult.text).toBe('- Одиночный пункт');

            const multiLine = 'Пункт 1\nПункт 2\nПункт 3';
            const multiResult = toggleUnorderedList(multiLine, 0, multiLine.length);
            expect(multiResult.text).toBe('- Пункт 1\n- Пункт 2\n- Пункт 3');

            // Снятие маркеров при повторном вызове
            const unwrapped = toggleUnorderedList(multiResult.text, 0, multiResult.text.length);
            expect(unwrapped.text).toBe('Пункт 1\nПункт 2\nПункт 3');
        });

        it('создает нумерованный список с последовательной нумерацией и снимает ее', () => {
            const multiLine = 'Шаг А\nШаг Б\nШаг В';
            const result = toggleOrderedList(multiLine, 0, multiLine.length);
            expect(result.text).toBe('1. Шаг А\n2. Шаг Б\n3. Шаг В');

            const unwrapped = toggleOrderedList(result.text, 0, result.text.length);
            expect(unwrapped.text).toBe('Шаг А\nШаг Б\nШаг В');
        });

        it('обрамляет многострочный фрагмент в блок цитаты и снимает его', () => {
            const lines = 'Первая мысль цитаты\nВторая мысль цитаты';
            const result = toggleBlockquote(lines, 0, lines.length);
            expect(result.text).toBe('> Первая мысль цитаты\n> Вторая мысль цитаты');

            const unwrapped = toggleBlockquote(result.text, 0, result.text.length);
            expect(unwrapped.text).toBe('Первая мысль цитаты\nВторая мысль цитаты');
        });
    });

    describe('Многострочные блоки кода (toggleCodeBlock)', () => {
        it('оборачивает многострочный фрагмент в тройные обратные кавычки с языком', () => {
            const code = 'const x = 10;\nconst y = 20;';
            const result = toggleCodeBlock(code, 0, code.length, 'javascript');

            expect(result.text).toBe('```javascript\nconst x = 10;\nconst y = 20;\n```');
        });

        it('снимает блок кода при повторном применении', () => {
            const fencedCode = '```javascript\nconst x = 10;\nconst y = 20;\n```';
            const result = toggleCodeBlock(fencedCode, 0, fencedCode.length);

            expect(result.text).toBe('const x = 10;\nconst y = 20;');
        });

        it('вставляет блок кода с текстом-заполнителем при пустом выделении', () => {
            const result = toggleCodeBlock('', 0, 0, 'python');

            expect(result.text).toBe('```python\nкод\n```');
            const expectedStart = '```python\n'.length;
            expect(result.selectionStart).toBe(expectedStart);
            expect(result.selectionEnd).toBe(expectedStart + 'код'.length);
        });
    });

    describe('Границы выделения и обработка пробельных символов (Selection Boundaries & Whitespace)', () => {
        it('корректно обрабатывает выделение строки с пробелами по краям', () => {
            const text = '  выделенный текст  ';
            const result = toggleBold(text, 0, text.length);

            expect(result.text).toBe('**  выделенный текст  **');
            expect(result.selectionStart).toBe(2);
            expect(result.selectionEnd).toBe(2 + text.length);

            const unwrapped = toggleBold(result.text, result.selectionStart, result.selectionEnd);
            expect(unwrapped.text).toBe(text);
            expect(unwrapped.selectionStart).toBe(0);
            expect(unwrapped.selectionEnd).toBe(text.length);
        });

        it('вставляет текст по умолчанию при пустом выделении в начале, середине и конце текста', () => {
            // В самом начале строки (индекс 0)
            const atStart = toggleBold('Конец строки', 0, 0);
            expect(atStart.text).toBe('**жирный текст**Конец строки');
            expect(atStart.selectionStart).toBe(2);
            expect(atStart.selectionEnd).toBe(2 + 'жирный текст'.length);

            // В конце многострочного текста
            const multiText = 'Строка 1\nСтрока 2';
            const atEnd = toggleItalic(multiText, multiText.length, multiText.length);
            expect(atEnd.text).toBe('Строка 1\nСтрока 2*курсив*');
            expect(atEnd.selectionStart).toBe(multiText.length + 1);
            expect(atEnd.selectionEnd).toBe(multiText.length + 1 + 'курсив'.length);

            // Между двумя словами
            const betweenWords = toggleInlineCode('Слово1 Слово2', 6, 6);
            expect(betweenWords.text).toBe('Слово1`код` Слово2');
            expect(betweenWords.selectionStart).toBe(7);
            expect(betweenWords.selectionEnd).toBe(7 + 'код'.length);
        });

        it('ограничивает индексы выделения, выходящие за пределы длины текста', () => {
            const text = 'Короткий текст';
            const result = toggleBold(text, 100, 200);

            // Индексы 100 и 200 нормализуются к text.length (14, 14), вставляя плейсхолдер в конец
            expect(result.text).toBe('Короткий текст**жирный текст**');
            expect(result.selectionStart).toBe(text.length + 2);
            expect(result.selectionEnd).toBe(text.length + 2 + 'жирный текст'.length);
        });
    });

    describe('Математическая идемпотентность снятия разметки f(f(x)) = x', () => {
        it('соблюдает обратимость f(f(x)) = x для инлайнового жирного текста', () => {
            const original = 'Исходное слово';
            const step1 = toggleBold(original, 0, original.length);
            expect(step1.text).toBe('**Исходное слово**');

            const step2 = toggleBold(step1.text, step1.selectionStart, step1.selectionEnd);
            expect(step2.text).toBe(original);
            expect(step2.selectionStart).toBe(0);
            expect(step2.selectionEnd).toBe(original.length);
        });

        it('соблюдает обратимость f(f(x)) = x для курсива', () => {
            const original = 'Курсивная фраза';
            const step1 = toggleItalic(original, 0, original.length);
            expect(step1.text).toBe('*Курсивная фраза*');

            const step2 = toggleItalic(step1.text, step1.selectionStart, step1.selectionEnd);
            expect(step2.text).toBe(original);
            expect(step2.selectionStart).toBe(0);
            expect(step2.selectionEnd).toBe(original.length);
        });

        it('соблюдает обратимость f(f(x)) = x для зачеркивания', () => {
            const original = 'Устаревшие данные';
            const step1 = toggleStrikethrough(original, 0, original.length);
            expect(step1.text).toBe('~~Устаревшие данные~~');

            const step2 = toggleStrikethrough(step1.text, step1.selectionStart, step1.selectionEnd);
            expect(step2.text).toBe(original);
            expect(step2.selectionStart).toBe(0);
            expect(step2.selectionEnd).toBe(original.length);
        });

        it('соблюдает обратимость f(f(x)) = x для инлайн-кода', () => {
            const original = 'npm run build';
            const step1 = toggleInlineCode(original, 0, original.length);
            expect(step1.text).toBe('`npm run build`');

            const step2 = toggleInlineCode(step1.text, step1.selectionStart, step1.selectionEnd);
            expect(step2.text).toBe(original);
            expect(step2.selectionStart).toBe(0);
            expect(step2.selectionEnd).toBe(original.length);
        });

        it('соблюдает обратимость f(f(x)) = x для многострочного блока цитаты', () => {
            const original = 'Стр 1\nСтр 2\nСтр 3';
            const step1 = toggleBlockquote(original, 0, original.length);
            expect(step1.text).toBe('> Стр 1\n> Стр 2\n> Стр 3');

            const step2 = toggleBlockquote(step1.text, 0, step1.text.length);
            expect(step2.text).toBe(original);
        });

        it('соблюдает обратимость f(f(x)) = x для списков', () => {
            const original = 'Элемент 1\nЭлемент 2';

            const ul1 = toggleUnorderedList(original, 0, original.length);
            expect(ul1.text).toBe('- Элемент 1\n- Элемент 2');
            const ul2 = toggleUnorderedList(ul1.text, 0, ul1.text.length);
            expect(ul2.text).toBe(original);

            const ol1 = toggleOrderedList(original, 0, original.length);
            expect(ol1.text).toBe('1. Элемент 1\n2. Элемент 2');
            const ol2 = toggleOrderedList(ol1.text, 0, ol1.text.length);
            expect(ol2.text).toBe(original);
        });

        it('соблюдает обратимость f(f(x)) = x для блока кода', () => {
            const original = 'const a = 1;\nconst b = 2;';
            const step1 = toggleCodeBlock(original, 0, original.length, 'typescript');
            expect(step1.text).toBe('```typescript\nconst a = 1;\nconst b = 2;\n```');

            const step2 = toggleCodeBlock(step1.text, step1.selectionStart, step1.selectionEnd);
            expect(step2.text).toBe(original);
        });
    });

    describe('Сложные многострочные блочные структуры', () => {
        it('добавляет маркеры маркированного списка только к непустым строкам', () => {
            const textWithGap = 'Пункт 1\n\nПункт 2';
            const result = toggleUnorderedList(textWithGap, 0, textWithGap.length);

            expect(result.text).toBe('- Пункт 1\n\n- Пункт 2');

            const unwrapped = toggleUnorderedList(result.text, 0, result.text.length);
            expect(unwrapped.text).toBe(textWithGap);
        });

        it('корректно переключает тип списка с маркированного на нумерованный', () => {
            const single = 'Простая строка';
            const ul = toggleUnorderedList(single, 0, single.length);
            expect(ul.text).toBe('- Простая строка');

            const ol = toggleOrderedList(ul.text, 0, ul.text.length);
            expect(ol.text).toBe('1. Простая строка');
        });

        it('последовательно переключает уровни заголовков h3 -> h4 -> h5 и снимает по совпадению', () => {
            const text = 'Заголовок секции';

            // Применение h3
            const h3 = toggleHeading(text, 0, text.length, 3);
            expect(h3.text).toBe('### Заголовок секции');

            // Переключение с h3 на h4
            const h4 = toggleHeading(h3.text, 0, h3.text.length, 4);
            expect(h4.text).toBe('#### Заголовок секции');

            // Переключение с h4 на h5
            const h5 = toggleHeading(h4.text, 0, h4.text.length, 5);
            expect(h5.text).toBe('##### Заголовок секции');

            // Повторный вызов с уровнем 5 снимает заголовок полностью
            const removed = toggleHeading(h5.text, 0, h5.text.length, 5);
            expect(removed.text).toBe('Заголовок секции');
        });

        it('сохраняет текст заголовка при наличии отступа перед маркерами решеток', () => {
            const indentedHeading = '   ### Заголовок с отступом';
            const result = toggleHeading(indentedHeading, 0, indentedHeading.length, 3);

            expect(result.text).toBe('Заголовок с отступом');
        });
    });

    describe('Граничные условия и устойчивость к некорректным аргументам', () => {
        it('возвращает пустой объект при передаче null или нестрокового текста', () => {
            const expectedDefault = { text: '', selectionStart: 0, selectionEnd: 0 };

            expect(toggleBold(null, 0, 0)).toEqual(expectedDefault);
            expect(toggleItalic(undefined, 0, 0)).toEqual(expectedDefault);
            expect(toggleHeading(12345, 0, 0)).toEqual(expectedDefault);
            expect(toggleCodeBlock({}, 0, 0)).toEqual(expectedDefault);
        });

        it('корректно нормализует отрицательные и инвертированные индексы выделения', () => {
            const text = 'Текст для теста';
            // Индексы за пределами и в обратном порядке (start > end, отрицательный старт)
            const result = toggleBold(text, -10, 5);

            expect(result.text).toBe('**Текст** для теста');
            expect(result.selectionStart).toBe(2);
            expect(result.selectionEnd).toBe(7);

            // start > end: нормализация меняет их местами
            const invertedResult = toggleBold(text, 10, 5);
            expect(invertedResult.text).toBe('Текст** для **теста');
        });

        it('корректно работает на физических границах документа', () => {
            const text = 'Строка в самом конце';
            const result = toggleHeading(text, text.length, text.length, 3);

            expect(result.text).toBe('### Строка в самом конце');
        });
    });
});
