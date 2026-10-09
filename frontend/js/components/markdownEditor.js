/**
 * Компонент текстового редактора Markdown с панелью инструментов и предпросмотром.
 * Реализует доступность WAI-ARIA, переключение вкладок, горячие клавиши форматирования,
 * дебаунс синхронизации предварительного просмотра и счетчик символов с цветовой индикацией.
 * Категорически исключает использование innerHTML, outerHTML и insertAdjacentHTML.
 */

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
} from '../markdown/editorActions.js';
import { renderMarkdown } from '../markdown/renderer.js';

/**
 * Конфигурация кнопок панели инструментов форматирования.
 * @type {ReadonlyArray<{ action: string, label: string, text: string }>}
 */
const TOOLBAR_BUTTONS = Object.freeze([
    { action: 'bold', label: 'Жирный шрифт (Ctrl+B)', text: 'B' },
    { action: 'italic', label: 'Курсив (Ctrl+I)', text: 'I' },
    { action: 'strike', label: 'Зачеркнутый текст', text: 'S' },
    { action: 'heading', label: 'Заголовок H3', text: 'H3' },
    { action: 'ul', label: 'Маркированный список', text: '•' },
    { action: 'ol', label: 'Нумерованный список', text: '1.' },
    { action: 'quote', label: 'Блок цитаты', text: '”' },
    { action: 'code', label: 'Встроенный код', text: '<>' },
    { action: 'link', label: 'Вставить ссылку (Ctrl+K)', text: '🔗' },
]);

/**
 * Фабричная функция создания интерактивного редактора Markdown.
 *
 * @param {HTMLElement|null} containerElement Родительский узел для монтирования редактора.
 * @param {Object} [options={}] Параметры конфигурации редактора.
 * @param {string} [options.initialValue=""] Начальный текст в формате Markdown.
 * @param {number} [options.maxLength=20000] Максимально допустимая длина текста.
 * @param {number} [options.debounceMs=150] Задержка обновления предпросмотра в миллисекундах.
 * @param {(value: string) => void} [options.onChange] Функция обратного вызова при изменении текста.
 * @param {Document} [options.documentRef] Экземпляр DOM-документа (по умолчанию globalThis.document).
 * @returns {{
 *   getValue: () => string,
 *   setValue: (val: string) => void,
 *   focus: () => void,
 *   destroy: () => void,
 *   dispose: () => void,
 *   element: HTMLElement
 * }} Публичный интерфейс управления редактором.
 */
export function createMarkdownEditor(containerElement, options = {}) {
    const doc = options.documentRef || globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') {
        throw new Error('DOM document is required for creating markdown editor');
    }

    const initialValue =
        typeof options.initialValue === 'string' ? options.initialValue : '';
    const maxLength =
        typeof options.maxLength === 'number' && options.maxLength > 0
            ? Math.floor(options.maxLength)
            : 20000;
    const debounceMs =
        typeof options.debounceMs === 'number' && options.debounceMs >= 0
            ? Math.floor(options.debounceMs)
            : 150;
    const onChange =
        typeof options.onChange === 'function' ? options.onChange : null;

    let debounceTimer = null;
    const eventCleanupTasks = [];

    // 1. Создание корневого контейнера редактора
    const rootEl = doc.createElement('div');
    rootEl.className = 'markdown-editor';

    // 2. Создание панели переключения вкладок (WAI-ARIA tablist)
    const tabsBar = doc.createElement('div');
    tabsBar.className = 'markdown-editor-tabs';
    tabsBar.setAttribute('role', 'tablist');

    const editTab = doc.createElement('button');
    editTab.type = 'button';
    editTab.id = 'editor-tab-edit';
    editTab.className = 'markdown-editor-tab active';
    editTab.setAttribute('role', 'tab');
    editTab.setAttribute('aria-selected', 'true');
    editTab.setAttribute('aria-controls', 'editor-panel-edit');
    editTab.textContent = 'Редактор';

    const previewTab = doc.createElement('button');
    previewTab.type = 'button';
    previewTab.id = 'editor-tab-preview';
    previewTab.className = 'markdown-editor-tab';
    previewTab.setAttribute('role', 'tab');
    previewTab.setAttribute('aria-selected', 'false');
    previewTab.setAttribute('aria-controls', 'editor-panel-preview');
    previewTab.textContent = 'Предпросмотр';

    tabsBar.appendChild(editTab);
    tabsBar.appendChild(previewTab);

    // 3. Создание панели инструментов форматирования (WAI-ARIA toolbar)
    const toolbar = doc.createElement('div');
    toolbar.className = 'markdown-editor-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Инструменты форматирования');

    TOOLBAR_BUTTONS.forEach((btnConfig) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'markdown-editor-tool-btn';
        btn.setAttribute('data-action', btnConfig.action);
        btn.setAttribute('aria-label', btnConfig.label);
        btn.textContent = btnConfig.text;

        const onToolClick = (e) => {
            e.preventDefault();
            applyAction(btnConfig.action);
        };
        btn.addEventListener('click', onToolClick);
        eventCleanupTasks.push(() => btn.removeEventListener('click', onToolClick));

        toolbar.appendChild(btn);
    });

    // 4. Панель редактирования текста
    const editPanel = doc.createElement('div');
    editPanel.id = 'editor-panel-edit';
    editPanel.className = 'markdown-editor-panel';
    editPanel.setAttribute('role', 'tabpanel');
    editPanel.setAttribute('aria-labelledby', 'editor-tab-edit');

    const textarea = doc.createElement('textarea');
    textarea.className = 'markdown-editor-textarea';
    textarea.setAttribute('aria-label', 'Текст описания в формате Markdown');
    textarea.setAttribute('rows', '10');
    textarea.value = initialValue;

    editPanel.appendChild(textarea);

    // 5. Панель предварительного просмотра
    const previewPanel = doc.createElement('div');
    previewPanel.id = 'editor-panel-preview';
    previewPanel.className = 'markdown-editor-panel';
    previewPanel.setAttribute('role', 'tabpanel');
    previewPanel.setAttribute('aria-labelledby', 'editor-tab-preview');
    previewPanel.style.display = 'none';

    const previewContainer = doc.createElement('div');
    previewContainer.className = 'markdown-editor-preview';
    previewContainer.setAttribute('aria-live', 'polite');

    previewPanel.appendChild(previewContainer);

    // 6. Подвал со счетчиком символов
    const footer = doc.createElement('div');
    footer.className = 'markdown-editor-footer';

    const counterEl = doc.createElement('div');
    counterEl.className = 'markdown-editor-counter';
    footer.appendChild(counterEl);

    // Монтирование узлов в корневой контейнер
    rootEl.appendChild(tabsBar);
    rootEl.appendChild(toolbar);
    rootEl.appendChild(editPanel);
    rootEl.appendChild(previewPanel);
    rootEl.appendChild(footer);

    if (containerElement && typeof containerElement.appendChild === 'function') {
        containerElement.appendChild(rootEl);
    }

    /**
     * Обновляет индикацию счетчика символов и присваивает классы предупреждений.
     */
    function updateCounter() {
        const length = textarea.value.length;
        counterEl.textContent = `${length} / ${maxLength}`;
        counterEl.classList.remove('counter-warning', 'counter-danger');

        if (length > maxLength) {
            counterEl.classList.add('counter-danger');
        } else if (length >= Math.floor(maxLength * 0.9)) {
            counterEl.classList.add('counter-warning');
        }
    }

    /**
     * Выполняет немедленный безопасный рендеринг текста в контейнер предпросмотра.
     */
    function renderPreviewContent() {
        previewContainer.textContent = '';
        const fragment = renderMarkdown(textarea.value, { documentRef: doc });
        previewContainer.appendChild(fragment);
    }

    /**
     * Обрабатывает изменение текста поля ввода с обновлением счетчика и таймером предпросмотра.
     */
    function handleInput() {
        updateCounter();

        if (onChange) {
            onChange(textarea.value);
        }

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            renderPreviewContent();
            debounceTimer = null;
        }, debounceMs);
    }

    /**
     * Применяет алгоритмическое строковое форматирование к выделенному фрагменту текста.
     *
     * @param {string} actionName Идентификатор действия панели инструментов.
     */
    function applyAction(actionName) {
        const text = textarea.value;
        const start = textarea.selectionStart || 0;
        const end = textarea.selectionEnd || 0;

        let result = null;

        switch (actionName) {
            case 'bold':
                result = toggleBold(text, start, end);
                break;
            case 'italic':
                result = toggleItalic(text, start, end);
                break;
            case 'strike':
                result = toggleStrikethrough(text, start, end);
                break;
            case 'heading':
                result = toggleHeading(text, start, end, 3);
                break;
            case 'ul':
                result = toggleUnorderedList(text, start, end);
                break;
            case 'ol':
                result = toggleOrderedList(text, start, end);
                break;
            case 'quote':
                result = toggleBlockquote(text, start, end);
                break;
            case 'code':
                result = toggleInlineCode(text, start, end);
                break;
            case 'link':
                result = formatLink(text, start, end);
                break;
            default:
                return;
        }

        if (!result) {
            return;
        }

        textarea.value = result.text;

        if (typeof textarea.setSelectionRange === 'function') {
            textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
        }

        try {
            textarea.focus();
        } catch {
            // Игнорируем ограничения окружений без полной реализации фокуса
        }

        handleInput();
    }

    // Обработчик сочетаний клавиш быстрого форматирования
    const onKeyDown = (e) => {
        if (!e.ctrlKey && !e.metaKey) {
            return;
        }

        const key = e.key ? e.key.toLowerCase() : '';

        if (key === 'b') {
            e.preventDefault();
            applyAction('bold');
        } else if (key === 'i') {
            e.preventDefault();
            applyAction('italic');
        } else if (key === 'k') {
            e.preventDefault();
            applyAction('link');
        }
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', onKeyDown);
    eventCleanupTasks.push(() => textarea.removeEventListener('input', handleInput));
    eventCleanupTasks.push(() => textarea.removeEventListener('keydown', onKeyDown));

    // Переключение на вкладку редактирования
    const onEditTabClick = () => {
        editTab.setAttribute('aria-selected', 'true');
        editTab.classList.add('active');
        previewTab.setAttribute('aria-selected', 'false');
        previewTab.classList.remove('active');

        editPanel.style.display = 'block';
        previewPanel.style.display = 'none';

        toolbar.style.display = 'flex';
        toolbar.removeAttribute('aria-disabled');

        try {
            textarea.focus();
        } catch {
            // Защита от сбоя фокуса в виртуальных средах
        }
    };

    // Переключение на вкладку предпросмотра
    const onPreviewTabClick = () => {
        previewTab.setAttribute('aria-selected', 'true');
        previewTab.classList.add('active');
        editTab.setAttribute('aria-selected', 'false');
        editTab.classList.remove('active');

        previewPanel.style.display = 'block';
        editPanel.style.display = 'none';

        toolbar.style.display = 'none';
        toolbar.setAttribute('aria-disabled', 'true');

        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        renderPreviewContent();
    };

    editTab.addEventListener('click', onEditTabClick);
    previewTab.addEventListener('click', onPreviewTabClick);
    eventCleanupTasks.push(() => editTab.removeEventListener('click', onEditTabClick));
    eventCleanupTasks.push(() => previewTab.removeEventListener('click', onPreviewTabClick));

    // Первичная инициализация состояния счетчика и предпросмотра
    updateCounter();
    renderPreviewContent();

    /**
     * Возвращает текущее текстовое значение редактора.
     *
     * @returns {string} Текущий текст Markdown.
     */
    function getValue() {
        return textarea.value;
    }

    /**
     * Программно устанавливает новое значение текста в редакторе.
     *
     * @param {string} val Новое текстовое значение.
     */
    function setValue(val) {
        textarea.value = typeof val === 'string' ? val : '';
        handleInput();
        renderPreviewContent();
    }

    /**
     * Переводит фокус пользовательского ввода на поле textarea.
     */
    function focus() {
        try {
            textarea.focus();
        } catch {
            // Безопасный вызов для совместимости
        }
    }

    /**
     * Полная утилизация компонента: очистка таймеров, слушателей событий и удаление из DOM.
     */
    function destroy() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        eventCleanupTasks.forEach((cleanup) => {
            try {
                cleanup();
            } catch {
                // Игнорируем возможные ошибки при демонтаже
            }
        });
        eventCleanupTasks.length = 0;

        if (rootEl.parentNode) {
            rootEl.parentNode.removeChild(rootEl);
        }
    }

    return {
        getValue,
        setValue,
        focus,
        destroy,
        dispose: destroy,
        element: rootEl,
    };
}
