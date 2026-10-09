// @vitest-environment happy-dom

/**
 * Модульные тесты интерфейсного компонента редактора Markdown (markdownEditor.js).
 * Выполняются в виртуальной среде happy-dom с использованием фреймворка Vitest.
 * Проверяют структуру доступности WAI-ARIA, форматирование панели инструментов,
 * клавиатурные сокращения Ctrl+B/I/K, дебаунс предпросмотра, счетчик символов и метод destroy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMarkdownEditor } from '../../frontend/js/components/markdownEditor.js';

describe('Компонент редактора Markdown (markdownEditor.js)', () => {
    let container;

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }
    });

    describe('Инициализация и разметка WAI-ARIA', () => {
        it('создает корневой узел, переключатели вкладок и панели с атрибутами доступности', () => {
            const editor = createMarkdownEditor(container);
            const el = editor.element;

            expect(el.classList.contains('markdown-editor')).toBe(true);

            const tablist = el.querySelector('[role="tablist"]');
            expect(tablist).not.toBeNull();
            expect(tablist.classList.contains('markdown-editor-tabs')).toBe(true);

            const editTab = el.querySelector('#editor-tab-edit');
            const previewTab = el.querySelector('#editor-tab-preview');
            expect(editTab).not.toBeNull();
            expect(previewTab).not.toBeNull();

            expect(editTab.getAttribute('role')).toBe('tab');
            expect(editTab.getAttribute('aria-selected')).toBe('true');
            expect(editTab.getAttribute('aria-controls')).toBe('editor-panel-edit');

            expect(previewTab.getAttribute('role')).toBe('tab');
            expect(previewTab.getAttribute('aria-selected')).toBe('false');
            expect(previewTab.getAttribute('aria-controls')).toBe('editor-panel-preview');

            const editPanel = el.querySelector('#editor-panel-edit');
            const previewPanel = el.querySelector('#editor-panel-preview');
            expect(editPanel).not.toBeNull();
            expect(previewPanel).not.toBeNull();

            expect(editPanel.getAttribute('role')).toBe('tabpanel');
            expect(previewPanel.getAttribute('role')).toBe('tabpanel');
            expect(previewPanel.style.display).toBe('none');

            editor.destroy();
        });

        it('создает панель инструментов с 9 кнопками форматирования и непустыми aria-label', () => {
            const editor = createMarkdownEditor(container);
            const toolbar = editor.element.querySelector('[role="toolbar"]');

            expect(toolbar).not.toBeNull();
            expect(toolbar.getAttribute('aria-label')).toBe('Инструменты форматирования');

            const buttons = toolbar.querySelectorAll('button.markdown-editor-tool-btn');
            expect(buttons.length).toBe(9);

            const expectedActions = [
                'bold',
                'italic',
                'strike',
                'heading',
                'ul',
                'ol',
                'quote',
                'code',
                'link',
            ];

            buttons.forEach((btn, index) => {
                expect(btn.getAttribute('type')).toBe('button');
                expect(btn.getAttribute('data-action')).toBe(expectedActions[index]);
                const ariaLabel = btn.getAttribute('aria-label');
                expect(ariaLabel).toBeTruthy();
                expect(ariaLabel.trim().length).toBeGreaterThan(0);
            });

            editor.destroy();
        });
    });

    describe('Панель инструментов и форматирование', () => {
        it('обрамляет выделенный текст звездочками при нажатии кнопки Жирный', () => {
            const editor = createMarkdownEditor(container, { initialValue: 'текст' });
            const textarea = editor.element.querySelector('.markdown-editor-textarea');
            const boldBtn = editor.element.querySelector('button[data-action="bold"]');

            textarea.selectionStart = 0;
            textarea.selectionEnd = 5;
            if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(0, 5);
            }

            boldBtn.click();

            expect(textarea.value).toBe('**текст**');
            editor.destroy();
        });

        it('добавляет маркер списка при нажатии кнопки Маркированный список', () => {
            const editor = createMarkdownEditor(container, { initialValue: 'Первый пункт' });
            const textarea = editor.element.querySelector('.markdown-editor-textarea');
            const ulBtn = editor.element.querySelector('button[data-action="ul"]');

            textarea.selectionStart = 0;
            textarea.selectionEnd = 0;
            if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(0, 0);
            }

            ulBtn.click();

            expect(textarea.value).toBe('- Первый пункт');
            editor.destroy();
        });
    });

    describe('Горячие клавиши', () => {
        it('применяет жирный шрифт и отменяет стандартное действие при нажатии Ctrl+B', () => {
            const editor = createMarkdownEditor(container, { initialValue: 'фрагмент' });
            const textarea = editor.element.querySelector('.markdown-editor-textarea');

            textarea.selectionStart = 0;
            textarea.selectionEnd = 8;
            if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(0, 8);
            }

            const keyEvent = new KeyboardEvent('keydown', {
                key: 'b',
                ctrlKey: true,
                cancelable: true,
                bubbles: true,
            });

            textarea.dispatchEvent(keyEvent);

            expect(keyEvent.defaultPrevented).toBe(true);
            expect(textarea.value).toBe('**фрагмент**');

            editor.destroy();
        });

        it('применяет курсив при нажатии Ctrl+I и ссылку при нажатии Ctrl+K', () => {
            const editor = createMarkdownEditor(container, { initialValue: 'слово' });
            const textarea = editor.element.querySelector('.markdown-editor-textarea');

            textarea.selectionStart = 0;
            textarea.selectionEnd = 5;
            if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(0, 5);
            }

            const italicEvent = new KeyboardEvent('keydown', {
                key: 'i',
                ctrlKey: true,
                cancelable: true,
                bubbles: true,
            });
            textarea.dispatchEvent(italicEvent);

            expect(italicEvent.defaultPrevented).toBe(true);
            expect(textarea.value).toBe('*слово*');

            textarea.selectionStart = 0;
            textarea.selectionEnd = textarea.value.length;
            if (typeof textarea.setSelectionRange === 'function') {
                textarea.setSelectionRange(0, textarea.value.length);
            }

            const linkEvent = new KeyboardEvent('keydown', {
                key: 'k',
                ctrlKey: true,
                cancelable: true,
                bubbles: true,
            });
            textarea.dispatchEvent(linkEvent);

            expect(linkEvent.defaultPrevented).toBe(true);
            expect(textarea.value).toBe('[*слово*](https://example.com)');

            editor.destroy();
        });
    });

    describe('Переключение вкладок и предпросмотр', () => {
        it('переключает видимость панелей, обновляет ARIA-атрибуты и рендерит DOM-узлы', () => {
            const editor = createMarkdownEditor(container, {
                initialValue: '### Заголовок\n\n**Важный** текст',
            });
            const editTab = editor.element.querySelector('#editor-tab-edit');
            const previewTab = editor.element.querySelector('#editor-tab-preview');
            const editPanel = editor.element.querySelector('#editor-panel-edit');
            const previewPanel = editor.element.querySelector('#editor-panel-preview');
            const previewContainer = editor.element.querySelector('.markdown-editor-preview');

            previewTab.click();

            expect(previewTab.getAttribute('aria-selected')).toBe('true');
            expect(editTab.getAttribute('aria-selected')).toBe('false');
            expect(previewPanel.style.display).toBe('block');
            expect(editPanel.style.display).toBe('none');

            const h3 = previewContainer.querySelector('h3');
            const strong = previewContainer.querySelector('strong');
            expect(h3).not.toBeNull();
            expect(h3.textContent).toBe('Заголовок');
            expect(strong).not.toBeNull();
            expect(strong.textContent).toBe('Важный');

            editTab.click();

            expect(editTab.getAttribute('aria-selected')).toBe('true');
            expect(previewTab.getAttribute('aria-selected')).toBe('false');
            expect(editPanel.style.display).toBe('block');
            expect(previewPanel.style.display).toBe('none');

            editor.destroy();
        });

        it('откладывает рендеринг предпросмотра на время дебаунса при пользовательском вводе', () => {
            vi.useFakeTimers();

            const editor = createMarkdownEditor(container, {
                initialValue: '',
                debounceMs: 150,
            });
            const textarea = editor.element.querySelector('.markdown-editor-textarea');
            const previewContainer = editor.element.querySelector('.markdown-editor-preview');

            textarea.value = '**отложенный текст**';
            textarea.dispatchEvent(new Event('input'));

            expect(previewContainer.querySelector('strong')).toBeNull();

            vi.advanceTimersByTime(150);

            expect(previewContainer.querySelector('strong')).not.toBeNull();
            expect(previewContainer.querySelector('strong').textContent).toBe(
                'отложенный текст'
            );

            editor.destroy();
            vi.useRealTimers();
        });
    });

    describe('Счетчик символов и предупреждения', () => {
        it('отображает текущее количество символов и применяет классы предупреждений', () => {
            const editor = createMarkdownEditor(container, { maxLength: 20000 });
            const counter = editor.element.querySelector('.markdown-editor-counter');

            editor.setValue('1234567890');
            expect(counter.textContent).toBe('10 / 20000');
            expect(counter.classList.contains('counter-warning')).toBe(false);
            expect(counter.classList.contains('counter-danger')).toBe(false);

            editor.setValue('a'.repeat(18001));
            expect(counter.classList.contains('counter-warning')).toBe(true);
            expect(counter.classList.contains('counter-danger')).toBe(false);

            editor.setValue('a'.repeat(20001));
            expect(counter.classList.contains('counter-danger')).toBe(true);

            editor.destroy();
        });
    });

    describe('Программные методы и утилизация', () => {
        it('корректно работает с методами getValue, setValue и focus', () => {
            const editor = createMarkdownEditor(container, { initialValue: 'Начало' });
            expect(editor.getValue()).toBe('Начало');

            editor.setValue('Обновленный текст');
            expect(editor.getValue()).toBe('Обновленный текст');

            const textarea = editor.element.querySelector('.markdown-editor-textarea');
            const focusSpy = vi.spyOn(textarea, 'focus');
            editor.focus();
            expect(focusSpy).toHaveBeenCalled();

            editor.destroy();
        });

        it('удаляет корневой элемент из контейнера и снимает слушатели при destroy', () => {
            const editor = createMarkdownEditor(container);
            expect(container.contains(editor.element)).toBe(true);

            editor.destroy();
            expect(container.contains(editor.element)).toBe(false);
        });
    });
});
