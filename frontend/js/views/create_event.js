/**
 * Модуль представления экрана добавления нового исторического события.
 * Реализует контракт жизненного цикла SPA-представлений { html, mount, unmount },
 * интеграцию текстового редактора Markdown с предпросмотром, динамический реестр
 * медиа-вложений (до 20 элементов), парсинг календарных дат ДД.ММ.ГГГГ ЧЧ:ММ:СС
 * в секунды Unix и предварительную валидацию без использования innerHTML.
 */

import { createEvent } from '../services/api.js';
import { CATEGORY_REGISTRY } from '../timeline/categories.js';
import { createMarkdownEditor } from '../components/markdownEditor.js';
import {
    validateEmbedUrl,
    isAllowedDirectAudioUrl,
} from '../media/providers.js';
import { isSafeLinkUrl } from '../markdown/linkPolicy.js';
import { civilToTimestamp } from '../timeline/calendar.js';
import {
    TIMELINE_MIN_TIMESTAMP,
    TIMELINE_MAX_TIMESTAMP,
} from '../timeline/constants.js';

/**
 * Предельно допустимое количество медиа-вложений для одного события.
 * @type {number}
 */
const MAX_MEDIA_ITEMS = 20;

/**
 * Проверяет, является ли год високосным по григорианскому календарю.
 *
 * @param {number} year Календарный год.
 * @returns {boolean} True, если год високосный.
 */
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Возвращает количество дней в указанном месяце с учетом високосности года.
 *
 * @param {number} year Год.
 * @param {number} month Месяц (1-12).
 * @returns {number} Количество дней (28-31).
 */
function getDaysInMonth(year, month) {
    if (month === 2) {
        return isLeapYear(year) ? 29 : 28;
    }
    if (month === 4 || month === 6 || month === 9 || month === 11) {
        return 30;
    }
    return 31;
}

/**
 * Выполняет синтаксический анализ и валидацию календарной строки даты и времени.
 * Поддерживает формат ДД.ММ.ГГГГ ЧЧ:ММ:СС, а также резервный ввод секунд Unix.
 *
 * @param {unknown} value Строковое представление даты.
 * @returns {{ success: boolean, timestamp?: number | null, error?: string }} Результат разбора.
 */
export function parseDateTimeInput(value) {
    if (value === null || value === undefined) {
        return { success: true, timestamp: null };
    }

    const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
    if (trimmed.length === 0) {
        return { success: true, timestamp: null };
    }

    const formatError =
        'Неверный формат даты. Используйте DD.MM.YYYY HH:mm:ss (например, 25.10.2026 14:30:00)';
    const boundsError = 'Дата выходит за допустимые границы платформы';

    const match = trimmed.match(
        /^(\d{1,2})\.(\d{1,2})\.(-?\d+)(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
    );

    if (match) {
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        const year = parseInt(match[3], 10);
        const hour = match[4] !== undefined ? parseInt(match[4], 10) : 0;
        const minute = match[5] !== undefined ? parseInt(match[5], 10) : 0;
        const second = match[6] !== undefined ? parseInt(match[6], 10) : 0;

        // Валидация диапазонов календарных и часовых компонентов
        if (month < 1 || month > 12) {
            return { success: false, error: formatError };
        }
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
            return { success: false, error: formatError };
        }

        const maxDays = getDaysInMonth(year, month);
        if (day < 1 || day > maxDays) {
            return { success: false, error: formatError };
        }

        // Преобразование валидной календарной даты в секунды Unix (UTC)
        const timestamp = civilToTimestamp({
            year,
            month,
            day,
            hour,
            minute,
            second,
        });

        // Контроль физических границ шкалы платформы
        if (timestamp < TIMELINE_MIN_TIMESTAMP || timestamp > TIMELINE_MAX_TIMESTAMP) {
            return { success: false, error: boundsError };
        }

        return { success: true, timestamp };
    }

    // Резервный режим обратной совместимости: прямое указание секунд Unix
    if (/^-?\d+$/.test(trimmed)) {
        const timestamp = parseInt(trimmed, 10);
        if (timestamp < TIMELINE_MIN_TIMESTAMP || timestamp > TIMELINE_MAX_TIMESTAMP) {
            return { success: false, error: boundsError };
        }
        return { success: true, timestamp };
    }

    return { success: false, error: formatError };
}

/**
 * Формирует статический HTML-список опций категорий на основе системного реестра.
 *
 * @returns {string} Разметка тегов option для селектора категорий.
 */
function buildCategoryOptionsHtml() {
    if (Array.isArray(CATEGORY_REGISTRY)) {
        return CATEGORY_REGISTRY.map((cat) => {
            const val = cat.id || cat.key || cat.slug || '';
            const lbl = cat.label || cat.title || val;
            return `<option value="${val}">${lbl}</option>`;
        }).join('\n');
    }
    if (CATEGORY_REGISTRY && typeof CATEGORY_REGISTRY === 'object') {
        return Object.entries(CATEGORY_REGISTRY)
            .map(([key, desc]) => {
                const lbl =
                    desc && typeof desc === 'object' && (desc.label || desc.title)
                        ? desc.label || desc.title
                        : key;
                return `<option value="${key}">${lbl}</option>`;
            })
            .join('\n');
    }
    return `
        <option value="politics">Политика</option>
        <option value="science">Наука</option>
        <option value="culture">Культура</option>
        <option value="economy">Экономика</option>
        <option value="military">Военное дело</option>
        <option value="religion">Религия</option>
        <option value="society">Общество</option>
    `;
}

/**
 * Выполняет эвристическое определение провайдера по типу медиа и веб-адресу.
 *
 * @param {string} type Тип медиа-ресурса (image, video, audio, link).
 * @param {string} url Проверяемый адрес ресурса.
 * @returns {string|null} Идентификатор провайдера или null.
 */
function detectMediaProvider(type, url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    const trimmed = url.trim();

    if (type === 'video') {
        const embedProviders = ['youtube', 'rutube', 'vk'];
        for (let i = 0; i < embedProviders.length; i++) {
            if (validateEmbedUrl(trimmed, embedProviders[i])) {
                return embedProviders[i];
            }
        }
        if (/youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(trimmed)) {
            return 'youtube';
        }
        if (/rutube\.ru/i.test(trimmed)) {
            return 'rutube';
        }
        if (/vk\.com|vkvideo\.ru/i.test(trimmed)) {
            return 'vk';
        }
        return null;
    }

    if (type === 'audio') {
        if (validateEmbedUrl(trimmed, 'yandex') || /music\.yandex\.ru/i.test(trimmed)) {
            return 'yandex';
        }
        if (isAllowedDirectAudioUrl(trimmed)) {
            return 'direct';
        }
        return null;
    }

    return null;
}

/**
 * Проверяет адрес медиа-ресурса на стороне клиента для формирования текстовой подсказки.
 *
 * @param {string} type Тип ресурса.
 * @param {string} url Адрес ресурса.
 * @returns {{ valid: boolean, warning?: boolean, message: string }} Результат проверки.
 */
function validateMediaUrlClient(type, url) {
    if (!url || typeof url !== 'string' || url.trim().length === 0) {
        return { valid: false, message: 'Адрес URL обязателен' };
    }
    const trimmed = url.trim();

    if (type === 'video') {
        const isValidVideo =
            validateEmbedUrl(trimmed, 'youtube') ||
            validateEmbedUrl(trimmed, 'rutube') ||
            validateEmbedUrl(trimmed, 'vk');

        if (isValidVideo) {
            return {
                valid: true,
                message: 'Доверенный адрес встраивания видео',
            };
        }
        return {
            valid: false,
            message: 'Неподдерживаемый или небезопасный адрес видео',
        };
    }

    if (type === 'audio') {
        if (isAllowedDirectAudioUrl(trimmed)) {
            return { valid: true, message: 'Прямой HTTPS-аудиофайл (.mp3, .ogg, .wav, .m4a, .opus)' };
        }
        if (validateEmbedUrl(trimmed, 'yandex')) {
            return { valid: true, message: 'Доверенный виджет Яндекс.Музыки' };
        }
        if (isSafeLinkUrl(trimmed)) {
            return {
                valid: true,
                warning: true,
                message: 'Внешняя ссылка на аудиоматериал',
            };
        }
        return {
            valid: false,
            message: 'Неподдерживаемый аудиофайл (требуется HTTPS и аудио-расширение)',
        };
    }

    if (type === 'image' || type === 'link') {
        if (isSafeLinkUrl(trimmed)) {
            return { valid: true, message: 'Безопасный веб-адрес' };
        }
        return {
            valid: false,
            message: 'Недопустимый протокол или формат адреса (разрешены только HTTP/HTTPS)',
        };
    }

    return { valid: isSafeLinkUrl(trimmed), message: '' };
}

/**
 * Создает экземпляр экрана создания исторического события.
 *
 * @returns {{
 *   html: string,
 *   mount: (container: HTMLElement) => void,
 *   unmount: () => void
 * }} Контракт жизненного цикла представления.
 */
export function renderCreateEvent() {
    const categoryOptionsHtml = buildCategoryOptionsHtml();

    const html = `
        <section class="view-card create-event-view">
            <header class="view-card-header">
                <h1>Добавить историческое событие</h1>
                <p class="view-card-subtitle">Форма добавления события на ось времени с хронологической привязкой, форматированным описанием и медиа-материалами.</p>
            </header>

            <form id="create-event-form" class="create-event-form" novalidate>
                <!-- Группа заголовка события -->
                <div class="form-group">
                    <label for="event-title" class="form-label">Название события <span class="required-star">*</span></label>
                    <input type="text" id="event-title" name="title" class="form-control" required maxlength="255" placeholder="Например: Основание Санкт-Петербурга" />
                    <div id="event-title-error" class="form-field-error" style="display: none;"></div>
                </div>

                <!-- Группа хронологических дат -->
                <div class="form-row" style="display: flex; gap: 1rem; flex-wrap: wrap;">
                    <div class="form-group" style="flex: 1; min-width: 220px;">
                        <label for="event-start-date" class="form-label">Начальная дата (ДД.ММ.ГГГГ ЧЧ:ММ:СС) <span class="required-star">*</span></label>
                        <input type="text" id="event-start-date" name="start_date" class="form-control" required placeholder="25.10.2026 14:30:00" />
                        <div id="event-start-date-error" class="form-field-error" style="display: none;"></div>
                    </div>
                    <div class="form-group" style="flex: 1; min-width: 220px;">
                        <label for="event-end-date" class="form-label">Конечная дата (ДД.ММ.ГГГГ ЧЧ:ММ:СС, опционально)</label>
                        <input type="text" id="event-end-date" name="end_date" class="form-control" placeholder="25.10.2026 18:00:00 (опционально)" />
                        <div id="event-end-date-error" class="form-field-error" style="display: none;"></div>
                    </div>
                </div>

                <!-- Группа классификации: категория и ранг -->
                <div class="form-row" style="display: flex; gap: 1rem; flex-wrap: wrap;">
                    <div class="form-group" style="flex: 1; min-width: 220px;">
                        <label for="event-category" class="form-label">Тематическая категория <span class="required-star">*</span></label>
                        <select id="event-category" name="category" class="form-control" required>
                            <option value="" disabled selected>Выберите категорию...</option>
                            ${categoryOptionsHtml}
                        </select>
                        <div id="event-category-error" class="form-field-error" style="display: none;"></div>
                    </div>
                    <div class="form-group" style="flex: 1; min-width: 220px;">
                        <label for="event-rank" class="form-label">Масштаб детализации (ранг) <span class="required-star">*</span></label>
                        <select id="event-rank" name="rank" class="form-control" required>
                            <option value="century">Век (century)</option>
                            <option value="decade">Десятилетие (decade)</option>
                            <option value="year" selected>Год (year)</option>
                            <option value="month">Месяц (month)</option>
                            <option value="day">День (day)</option>
                            <option value="hour">Час (hour)</option>
                            <option value="minute">Минута (minute)</option>
                            <option value="second">Секунда (second)</option>
                        </select>
                        <div id="event-rank-error" class="form-field-error" style="display: none;"></div>
                    </div>
                </div>

                <!-- Контейнер редактора форматированного описания -->
                <div class="form-group">
                    <label class="form-label">Описание события в формате Markdown</label>
                    <div id="event-description-editor-container"></div>
                    <div id="event-description-error" class="form-field-error" style="display: none;"></div>
                </div>

                <!-- Секция динамических медиа-материалов -->
                <section id="event-media-section" class="form-media-section" style="margin-top: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 1rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                        <h2 style="font-size: 1.25rem; margin: 0;">Медиа-материалы</h2>
                        <span id="media-counter" style="color: var(--text-secondary); font-size: 0.875rem;">0 / 20</span>
                    </div>

                    <div id="event-media-list" class="form-media-list" style="display: flex; flex-direction: column; gap: 0.75rem;"></div>
                    <div id="event-media-error" class="form-field-error" style="display: none;"></div>

                    <div class="form-media-controls" style="margin-top: 0.75rem;">
                        <button id="add-media-btn" type="button" class="btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.875rem;">+ Добавить материал</button>
                    </div>
                </section>

                <!-- Общий блок системных уведомлений и статусов -->
                <div id="form-status-message" class="form-status-message" style="display: none; margin-top: 1.25rem; padding: 0.75rem 1rem; border-radius: 4px;"></div>

                <!-- Подвал формы с кнопкой отправки -->
                <div class="form-actions" style="margin-top: 1.5rem;">
                    <button id="submit-event-btn" type="submit" class="btn btn-primary" style="padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer;">Опубликовать событие</button>
                </div>
            </form>
        </section>
    `;

    // Внутреннее состояние представления для методов mount и unmount
    let markdownEditor = null;
    let mediaItems = [];
    let formEl = null;
    let submitBtnEl = null;
    let addMediaBtnEl = null;
    let mediaListEl = null;
    let mediaCounterEl = null;
    let statusMessageEl = null;

    let onSubmitHandler = null;
    let onAddMediaHandler = null;

    /**
     * Очищает видимые сообщения об ошибках валидации полей формы.
     */
    function clearFieldErrors() {
        if (!formEl) {
            return;
        }
        const errorNodes = formEl.querySelectorAll('.form-field-error');
        errorNodes.forEach((node) => {
            node.textContent = '';
            node.style.display = 'none';
        });

        if (statusMessageEl) {
            statusMessageEl.textContent = '';
            statusMessageEl.style.display = 'none';
            statusMessageEl.className = 'form-status-message';
        }
    }

    /**
     * Отображает ошибку валидации под конкретным полем ввода.
     *
     * @param {string} fieldId Идентификатор контейнера ошибки.
     * @param {string} message Текст сообщения об ошибке.
     */
    function showFieldError(fieldId, message) {
        if (!formEl) {
            return;
        }
        const errorEl = formEl.querySelector(`#${fieldId}`);
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
    }

    /**
     * Обновляет индикатор количества прикрепленных медиа-материалов.
     */
    function updateMediaCounter() {
        if (mediaCounterEl) {
            mediaCounterEl.textContent = `${mediaItems.length} / ${MAX_MEDIA_ITEMS}`;
        }
        if (addMediaBtnEl) {
            addMediaBtnEl.disabled = mediaItems.length >= MAX_MEDIA_ITEMS;
        }
    }

    /**
     * Создает и монтирует строку медиа-вложения в DOM-дерево.
     *
     * @param {Document} doc Контекст документа.
     */
    function addMediaRow(doc) {
        if (mediaItems.length >= MAX_MEDIA_ITEMS || !mediaListEl) {
            return;
        }

        const rowContainer = doc.createElement('div');
        rowContainer.className = 'form-media-item';
        rowContainer.style.display = 'flex';
        rowContainer.style.flexDirection = 'column';
        rowContainer.style.gap = '0.4rem';
        rowContainer.style.padding = '0.75rem';
        rowContainer.style.border = '1px solid var(--border-color)';
        rowContainer.style.borderRadius = '4px';
        rowContainer.style.background = 'var(--bg-accent, #fafafa)';

        const inputsRow = doc.createElement('div');
        inputsRow.style.display = 'flex';
        inputsRow.style.gap = '0.5rem';
        inputsRow.style.flexWrap = 'wrap';

        // 1. Селектор типа ресурса
        const typeSelect = doc.createElement('select');
        typeSelect.className = 'form-control form-media-type';
        typeSelect.style.flex = '0 0 130px';

        const types = [
            { value: 'image', text: 'Изображение' },
            { value: 'video', text: 'Видео' },
            { value: 'audio', text: 'Аудио' },
            { value: 'link', text: 'Ссылка' },
        ];
        types.forEach((t) => {
            const opt = doc.createElement('option');
            opt.value = t.value;
            opt.textContent = t.text;
            typeSelect.appendChild(opt);
        });

        // 2. Поле ввода URL-адреса
        const urlInput = doc.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'form-control form-media-url';
        urlInput.placeholder = 'URL адрес (https://...)';
        urlInput.style.flex = '2';
        urlInput.style.minWidth = '200px';

        // 3. Поле ввода названия/подписи
        const titleInput = doc.createElement('input');
        titleInput.type = 'text';
        titleInput.className = 'form-control form-media-title';
        titleInput.placeholder = 'Подпись к материалу (опционально)';
        titleInput.style.flex = '1';
        titleInput.style.minWidth = '160px';

        // 4. Кнопка удаления строки
        const removeBtn = doc.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-danger form-media-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Удалить этот материал';
        removeBtn.style.padding = '0.3rem 0.6rem';
        removeBtn.style.cursor = 'pointer';

        inputsRow.appendChild(typeSelect);
        inputsRow.appendChild(urlInput);
        inputsRow.appendChild(titleInput);
        inputsRow.appendChild(removeBtn);

        // 5. Блок валидационной подсказки с двойным классом для DOM-тестов
        const hintEl = doc.createElement('div');
        hintEl.className = 'form-media-hint media-hint';
        hintEl.style.fontSize = '0.8125rem';
        hintEl.style.display = 'none';

        rowContainer.appendChild(inputsRow);
        rowContainer.appendChild(hintEl);

        const mediaItemRecord = {
            element: rowContainer,
            typeSelect,
            urlInput,
            titleInput,
            hintEl,
        };

        const updateHint = () => {
            const rawUrl = urlInput.value.trim();
            if (!rawUrl) {
                hintEl.textContent = '';
                hintEl.style.display = 'none';
                hintEl.classList.remove('media-hint-error');
                return;
            }

            const currentType = typeSelect.value;
            if (currentType === 'video') {
                const isValid =
                    validateEmbedUrl(rawUrl, 'youtube') ||
                    validateEmbedUrl(rawUrl, 'rutube') ||
                    validateEmbedUrl(rawUrl, 'vk');

                hintEl.style.display = 'block';
                if (isValid) {
                    hintEl.textContent = 'Доверенный адрес встраивания видео';
                    hintEl.classList.remove('media-hint-error');
                    hintEl.style.color = 'var(--success-color, #15803d)';
                } else {
                    hintEl.textContent = 'Неподдерживаемый или небезопасный адрес видео';
                    hintEl.classList.add('media-hint-error');
                    hintEl.style.color = 'var(--danger-color, #b91c1c)';
                }
                return;
            }

            const check = validateMediaUrlClient(currentType, rawUrl);
            hintEl.textContent = check.message;
            hintEl.style.display = 'block';
            if (check.valid) {
                hintEl.classList.remove('media-hint-error');
                hintEl.style.color = check.warning
                    ? 'var(--warning-color, #b45309)'
                    : 'var(--success-color, #15803d)';
            } else {
                hintEl.classList.add('media-hint-error');
                hintEl.style.color = 'var(--danger-color, #b91c1c)';
            }
        };

        urlInput.addEventListener('input', updateHint);
        typeSelect.addEventListener('change', updateHint);

        removeBtn.addEventListener('click', () => {
            const idx = mediaItems.indexOf(mediaItemRecord);
            if (idx !== -1) {
                mediaItems.splice(idx, 1);
            }
            if (rowContainer.parentNode) {
                rowContainer.parentNode.removeChild(rowContainer);
            }
            updateMediaCounter();
        });

        mediaItems.push(mediaItemRecord);
        mediaListEl.appendChild(rowContainer);
        updateMediaCounter();
    }

    /**
     * Монтирует обработчики событий, инициализирует редактор Markdown и элементы формы.
     *
     * @param {HTMLElement} container Родительский DOM-контейнер страницы.
     */
    function mount(container) {
        if (!container) {
            return;
        }

        const doc = container.ownerDocument || globalThis.document;

        formEl = container.querySelector('#create-event-form');
        submitBtnEl = container.querySelector('#submit-event-btn');
        addMediaBtnEl = container.querySelector('#add-media-btn');
        mediaListEl = container.querySelector('#event-media-list');
        mediaCounterEl = container.querySelector('#media-counter');
        statusMessageEl = container.querySelector('#form-status-message');

        const editorMountPoint = container.querySelector('#event-description-editor-container');
        if (editorMountPoint) {
            markdownEditor = createMarkdownEditor(editorMountPoint, {
                maxLength: 20000,
                documentRef: doc,
            });
        }

        onAddMediaHandler = () => {
            addMediaRow(doc);
        };
        if (addMediaBtnEl) {
            addMediaBtnEl.addEventListener('click', onAddMediaHandler);
        }

        onSubmitHandler = async (e) => {
            e.preventDefault();
            clearFieldErrors();

            const titleInput = formEl.querySelector('#event-title');
            const startDateInput = formEl.querySelector('#event-start-date');
            const endDateInput = formEl.querySelector('#event-end-date');
            const categorySelect = formEl.querySelector('#event-category');
            const rankSelect = formEl.querySelector('#event-rank');

            const titleVal = titleInput ? titleInput.value.trim() : '';
            const startDateRaw = startDateInput ? startDateInput.value.trim() : '';
            const endDateRaw = endDateInput ? endDateInput.value.trim() : '';
            const categoryVal = categorySelect ? categorySelect.value : '';
            const rankVal = rankSelect ? rankSelect.value : 'year';
            const descriptionVal = markdownEditor ? markdownEditor.getValue().trim() : '';

            let hasErrors = false;

            // 1. Валидация заголовка события
            if (!titleVal) {
                showFieldError('event-title-error', 'Укажите название исторического события');
                hasErrors = true;
            }

            // 2. Валидация и парсинг начальной даты
            let parsedStart = null;
            if (!startDateRaw) {
                showFieldError(
                    'event-start-date-error',
                    'Поле начальной даты обязательно для заполнения'
                );
                hasErrors = true;
            } else {
                parsedStart = parseDateTimeInput(startDateRaw);
                if (!parsedStart.success) {
                    showFieldError('event-start-date-error', parsedStart.error);
                    hasErrors = true;
                }
            }

            // 3. Валидация и парсинг конечной даты (опционально)
            const parsedEnd = parseDateTimeInput(endDateRaw);
            if (!parsedEnd.success) {
                showFieldError('event-end-date-error', parsedEnd.error);
                hasErrors = true;
            } else if (
                parsedStart &&
                parsedStart.success &&
                parsedEnd.timestamp !== null &&
                parsedStart.timestamp !== null &&
                parsedEnd.timestamp < parsedStart.timestamp
            ) {
                showFieldError(
                    'event-end-date-error',
                    'Конечная дата не может предшествовать начальной'
                );
                hasErrors = true;
            }

            // 4. Валидация категории и ранга детализации
            if (!categoryVal) {
                showFieldError('event-category-error', 'Выберите категорию события');
                hasErrors = true;
            }
            if (!rankVal) {
                showFieldError('event-rank-error', 'Выберите масштаб детализации');
                hasErrors = true;
            }

            if (hasErrors) {
                return;
            }

            // 5. Сборка массива медиа-материалов
            const parsedMedia = [];
            for (let i = 0; i < mediaItems.length; i++) {
                const item = mediaItems[i];
                const u = item.urlInput.value.trim();
                const t = item.titleInput.value.trim();
                const mType = item.typeSelect.value;

                if (u) {
                    const provider = detectMediaProvider(mType, u);
                    parsedMedia.push({
                        media_type: mType,
                        url: u,
                        title: t.length > 0 ? t : null,
                        provider,
                    });
                }
            }

            const payload = {
                title: titleVal,
                start_date: parsedStart.timestamp,
                end_date: parsedEnd.timestamp,
                category: categoryVal,
                rank: rankVal,
                description: descriptionVal.length > 0 ? descriptionVal : null,
                media_payload: parsedMedia.length > 0 ? parsedMedia : null,
            };

            if (submitBtnEl) {
                submitBtnEl.disabled = true;
                submitBtnEl.textContent = 'Отправка...';
            }

            try {
                const createdEvent = await createEvent(payload);

                if (statusMessageEl) {
                    statusMessageEl.className = 'form-status-message form-status-success';
                    statusMessageEl.style.display = 'block';
                    statusMessageEl.style.background = 'var(--success-bg, #ecfdf5)';
                    statusMessageEl.style.color = 'var(--success-text, #065f46)';
                    statusMessageEl.style.border = '1px solid var(--success-border, #a7f3d0)';

                    const eventId = createdEvent?.id || createdEvent?.event_id || '—';
                    statusMessageEl.textContent = `Событие успешно создано и отправлено на модерацию (ID: ${eventId})`;
                }

                // Сброс формы и очистка редактора
                formEl.reset();
                if (markdownEditor) {
                    markdownEditor.setValue('');
                }

                if (mediaListEl) {
                    mediaListEl.textContent = '';
                }
                mediaItems.length = 0;
                updateMediaCounter();
            } catch (err) {
                const status = err?.status || err?.response?.status;

                if (status === 401 || status === 403) {
                    if (statusMessageEl) {
                        statusMessageEl.className = 'form-status-message form-status-warning';
                        statusMessageEl.style.display = 'block';
                        statusMessageEl.style.background = 'var(--warning-bg, #fffbeb)';
                        statusMessageEl.style.color = 'var(--warning-text, #92400e)';
                        statusMessageEl.style.border = '1px solid var(--warning-border, #fde68a)';
                        statusMessageEl.textContent =
                            'Для публикации требуются права доступа. Модуль авторизации будет подключен на следующем этапе.';
                    }
                } else if (status === 422 && Array.isArray(err?.detail)) {
                    // Разбор Pydantic-ошибок валидации
                    const unmappedErrors = [];
                    err.detail.forEach((issue) => {
                        const locField = Array.isArray(issue.loc)
                            ? issue.loc[issue.loc.length - 1]
                            : '';
                        const msg = issue.msg || 'Некорректное значение';

                        if (locField === 'title') {
                            showFieldError('event-title-error', msg);
                        } else if (locField === 'start_date') {
                            showFieldError('event-start-date-error', msg);
                        } else if (locField === 'end_date') {
                            showFieldError('event-end-date-error', msg);
                        } else if (locField === 'category') {
                            showFieldError('event-category-error', msg);
                        } else if (locField === 'rank') {
                            showFieldError('event-rank-error', msg);
                        } else if (locField === 'description') {
                            showFieldError('event-description-error', msg);
                        } else if (locField === 'media_payload') {
                            showFieldError('event-media-error', msg);
                        } else {
                            unmappedErrors.push(`${locField ? locField + ': ' : ''}${msg}`);
                        }
                    });

                    if (unmappedErrors.length > 0 && statusMessageEl) {
                        statusMessageEl.className = 'form-status-message form-status-error';
                        statusMessageEl.style.display = 'block';
                        statusMessageEl.style.background = 'var(--danger-bg, #fef2f2)';
                        statusMessageEl.style.color = 'var(--danger-text, #991b1b)';
                        statusMessageEl.style.border = '1px solid var(--danger-border, #fecaca)';
                        statusMessageEl.textContent = unmappedErrors.join('; ');
                    }
                } else {
                    if (statusMessageEl) {
                        statusMessageEl.className = 'form-status-message form-status-error';
                        statusMessageEl.style.display = 'block';
                        statusMessageEl.style.background = 'var(--danger-bg, #fef2f2)';
                        statusMessageEl.style.color = 'var(--danger-text, #991b1b)';
                        statusMessageEl.style.border = '1px solid var(--danger-border, #fecaca)';
                        statusMessageEl.textContent =
                            err?.message || 'Не удалось сохранить событие. Проверьте соединение с сервером.';
                    }
                }
            } finally {
                if (submitBtnEl) {
                    submitBtnEl.disabled = false;
                    submitBtnEl.textContent = 'Опубликовать событие';
                }
            }
        };

        if (formEl) {
            formEl.addEventListener('submit', onSubmitHandler);
        }
    }

    /**
     * Освобождает ресурсы, останавливает редактор и снимает обработчики событий.
     */
    function unmount() {
        if (markdownEditor) {
            markdownEditor.destroy();
            markdownEditor = null;
        }

        if (formEl && onSubmitHandler) {
            formEl.removeEventListener('submit', onSubmitHandler);
            onSubmitHandler = null;
        }

        if (addMediaBtnEl && onAddMediaHandler) {
            addMediaBtnEl.removeEventListener('click', onAddMediaHandler);
            onAddMediaHandler = null;
        }

        if (mediaListEl) {
            mediaListEl.textContent = '';
        }
        mediaItems.length = 0;

        formEl = null;
        submitBtnEl = null;
        addMediaBtnEl = null;
        mediaListEl = null;
        mediaCounterEl = null;
        statusMessageEl = null;
    }

    return {
        html,
        mount,
        unmount,
    };
}
