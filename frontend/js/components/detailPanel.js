/**
 * Модуль компонента боковой панели детализации исторического события (Detail Panel).
 * Управляет безопасным рендерингом форматированного описания Markdown,
 * отображением медиа-материалов с отложенной загрузкой плееров, метаданных события,
 * первоисточника, иерархических потомков и диагностических состояний.
 * Полностью исключает использование innerHTML, outerHTML и insertAdjacentHTML.
 */

import { formatEventDateRange } from '../timeline/format.js';
import {
    getCategoryDescriptor,
    getCategoryLabel,
} from '../timeline/categories.js';
import { renderMarkdown } from '../markdown/renderer.js';
import { createMediaEmbed } from './mediaEmbed.js';

/**
 * Фабрика создания компонента боковой панели детализации события.
 *
 * @param {HTMLElement|Object} containerOrOptions Родительский DOM-контейнер или объект настроек.
 * @param {Function|Object} [onCloseOrOptions] Колбэк закрытия либо объект настроек.
 * @param {Function} [onSelectChildArg] Колбэк выбора дочернего события.
 * @returns {{
 *   element: HTMLElement,
 *   render: (event: Object, children?: Array<Object>, childrenError?: Error|string|null, childrenTotal?: number) => void,
 *   showLoading: () => void,
 *   showError: (error: Error|string) => void,
 *   hide: () => void,
 *   requestClose: () => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления боковой панелью.
 */
export function createDetailPanel(containerOrOptions, onCloseOrOptions, onSelectChildArg) {
    let containerElement = null;
    let onClose = null;
    let onSelectChild = null;

    if (
        containerOrOptions &&
        (containerOrOptions instanceof Node || typeof containerOrOptions.appendChild === 'function')
    ) {
        containerElement = containerOrOptions;
        if (typeof onCloseOrOptions === 'function') {
            onClose = onCloseOrOptions;
            if (typeof onSelectChildArg === 'function') {
                onSelectChild = onSelectChildArg;
            }
        } else if (typeof onCloseOrOptions === 'object' && onCloseOrOptions !== null) {
            onClose =
                typeof onCloseOrOptions.onClose === 'function'
                    ? onCloseOrOptions.onClose
                    : typeof onCloseOrOptions.onRequestClose === 'function'
                      ? onCloseOrOptions.onRequestClose
                      : typeof onCloseOrOptions.requestClose === 'function'
                        ? onCloseOrOptions.requestClose
                        : null;
            onSelectChild =
                typeof onCloseOrOptions.onSelectChild === 'function'
                    ? onCloseOrOptions.onSelectChild
                    : typeof onCloseOrOptions.onSelectEvent === 'function'
                      ? onCloseOrOptions.onSelectEvent
                      : null;
        }
    } else if (typeof containerOrOptions === 'object' && containerOrOptions !== null) {
        containerElement = containerOrOptions.container || null;
        onClose =
            typeof containerOrOptions.onClose === 'function'
                ? containerOrOptions.onClose
                : typeof containerOrOptions.onRequestClose === 'function'
                  ? containerOrOptions.onRequestClose
                  : typeof containerOrOptions.requestClose === 'function'
                    ? containerOrOptions.requestClose
                    : null;
        onSelectChild =
            typeof containerOrOptions.onSelectChild === 'function'
                ? containerOrOptions.onSelectChild
                : typeof containerOrOptions.onSelectEvent === 'function'
                  ? containerOrOptions.onSelectEvent
                  : null;
    }

    const doc =
        (containerElement && containerElement.ownerDocument) ||
        globalThis.document;
    if (!doc || typeof doc.createElement !== 'function') {
        throw new Error('DOM document is required for creating detail panel');
    }

    // Реестр активных мультимедийных плееров для своевременной утилизации
    let activeMediaEmbeds = [];

    // 1. Корневой элемент боковой панели
    const panelElement = doc.createElement('aside');
    panelElement.className = 'timeline-detail-panel hidden';
    panelElement.setAttribute('role', 'complementary');
    panelElement.setAttribute('aria-label', 'Детальная информация о событии');
    panelElement.style.display = 'none';

    // 2. Шапка панели: заголовок и кнопка закрытия
    const headerElement = doc.createElement('header');
    headerElement.className = 'timeline-detail-header';

    const titleElement = doc.createElement('h2');
    titleElement.className = 'timeline-detail-title';
    headerElement.appendChild(titleElement);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'timeline-detail-close-btn timeline-detail-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Закрыть панель');
    headerElement.appendChild(closeBtn);

    panelElement.appendChild(headerElement);

    // 3. Диагностический блок статуса (сообщения загрузки и сетевых ошибок)
    const statusElement = doc.createElement('div');
    statusElement.className = 'timeline-detail-status';
    statusElement.style.display = 'none';
    panelElement.appendChild(statusElement);

    // 4. Основной контейнер содержимого карточки события
    const contentElement = doc.createElement('div');
    contentElement.className = 'timeline-detail-content';

    // Блок дат проведения события
    const datesElement = doc.createElement('div');
    datesElement.className = 'timeline-detail-dates';

    // Блок мета-тегов (категория, ранг масштаба)
    const metaElement = doc.createElement('div');
    metaElement.className = 'timeline-detail-meta';

    const categoryBadge = doc.createElement('span');
    categoryBadge.className = 'timeline-detail-badge timeline-detail-badge-category';
    metaElement.appendChild(categoryBadge);

    const rankBadge = doc.createElement('span');
    rankBadge.className = 'timeline-detail-badge timeline-detail-badge-rank';
    metaElement.appendChild(rankBadge);

    // Блок форматированного описания Markdown
    const descriptionElement = doc.createElement('div');
    descriptionElement.className = 'timeline-detail-description';

    // Блок библиографического первоисточника
    const sourceElement = doc.createElement('div');
    sourceElement.className = 'timeline-detail-source';
    sourceElement.style.display = 'none';

    // Секция медиа-материалов
    const mediaSection = doc.createElement('section');
    mediaSection.className = 'timeline-detail-media';
    mediaSection.style.display = 'none';

    const mediaTitle = doc.createElement('h3');
    mediaTitle.className = 'timeline-detail-media-title';
    mediaTitle.textContent = 'Материалы';

    const mediaList = doc.createElement('div');
    mediaList.className = 'timeline-detail-media-list';

    mediaSection.appendChild(mediaTitle);
    mediaSection.appendChild(mediaList);

    // Секция дочерних исторических событий
    const childrenSection = doc.createElement('section');
    childrenSection.className = 'timeline-detail-children';
    childrenSection.style.display = 'none';

    const childrenTitle = doc.createElement('h3');
    childrenTitle.className = 'timeline-detail-children-title';
    childrenTitle.textContent = 'Дочерние события';
    childrenSection.appendChild(childrenTitle);

    const childrenCountElement = doc.createElement('div');
    childrenCountElement.className = 'timeline-detail-children-count';
    childrenCountElement.style.display = 'none';
    childrenSection.appendChild(childrenCountElement);

    const childrenErrorElement = doc.createElement('div');
    childrenErrorElement.className = 'timeline-detail-children-error';
    childrenErrorElement.style.display = 'none';
    childrenSection.appendChild(childrenErrorElement);

    const childrenList = doc.createElement('ul');
    childrenList.className = 'timeline-detail-children-list';
    childrenSection.appendChild(childrenList);

    const childrenEmptyElement = doc.createElement('p');
    childrenEmptyElement.className = 'timeline-detail-children-empty';
    childrenEmptyElement.textContent = 'Дочерние события отсутствуют.';
    childrenEmptyElement.style.display = 'none';
    childrenSection.appendChild(childrenEmptyElement);

    // Монтирование блоков в contentElement в строгом регламентированном порядке
    contentElement.appendChild(datesElement);
    contentElement.appendChild(metaElement);
    contentElement.appendChild(descriptionElement);
    contentElement.appendChild(sourceElement);
    contentElement.appendChild(mediaSection);
    contentElement.appendChild(childrenSection);

    panelElement.appendChild(contentElement);

    if (containerElement && typeof containerElement.appendChild === 'function') {
        containerElement.appendChild(panelElement);
    }

    /**
     * Проверяет текущее состояние видимости панели.
     *
     * @returns {boolean} True, если панель отображается на экране.
     */
    function isVisible() {
        return !panelElement.classList.contains('hidden') && panelElement.style.display !== 'none';
    }

    /**
     * Очищает активные экземпляры медиа-вложений, останавливает воспроизведение
     * и скрывает секцию медиа-материалов.
     */
    function cleanupMediaEmbeds() {
        for (let i = 0; i < activeMediaEmbeds.length; i++) {
            const embed = activeMediaEmbeds[i];
            if (embed && typeof embed.destroy === 'function') {
                embed.destroy();
            }
        }
        activeMediaEmbeds = [];
        mediaList.textContent = '';
        mediaSection.style.display = 'none';
    }

    /**
     * Инициирует закрытие панели по намерению пользователя (клик крестика, клавиша Escape).
     */
    function requestClose() {
        if (typeof onClose === 'function') {
            onClose();
        } else {
            hide();
        }
    }

    /**
     * Визуально скрывает панель и гарантированно освобождает мультимедийные ресурсы.
     */
    function hide() {
        cleanupMediaEmbeds();
        panelElement.classList.add('hidden');
        panelElement.style.display = 'none';
        titleElement.textContent = '';
        datesElement.textContent = '';
        categoryBadge.style.removeProperty('--badge-color');
        categoryBadge.textContent = '';
        rankBadge.textContent = '';
        descriptionElement.textContent = '';
        sourceElement.textContent = '';
        sourceElement.style.display = 'none';
        childrenList.textContent = '';
        childrenCountElement.textContent = '';
        childrenCountElement.style.display = 'none';
        childrenErrorElement.textContent = '';
        childrenErrorElement.style.display = 'none';
        childrenSection.style.display = 'none';
        statusElement.textContent = '';
        statusElement.style.display = 'none';
    }

    /**
     * Отображает состояние загрузки данных события.
     */
    function showLoading() {
        cleanupMediaEmbeds();
        panelElement.classList.remove('hidden');
        panelElement.style.display = 'block';
        contentElement.style.display = 'none';
        statusElement.style.display = 'block';
        statusElement.textContent = 'Загрузка данных...';
    }

    /**
     * Отображает состояние ошибки загрузки.
     *
     * @param {Error|string} error Объект ошибки или текстовое сообщение.
     */
    function showError(error) {
        cleanupMediaEmbeds();
        panelElement.classList.remove('hidden');
        panelElement.style.display = 'block';
        contentElement.style.display = 'none';
        statusElement.style.display = 'block';
        statusElement.textContent = error instanceof Error ? error.message : String(error);
    }

    /**
     * Отображает данные исторического события, дочерние записи и медиа-вложения.
     *
     * @param {Object} event Доменный объект события.
     * @param {Array<Object>} [children=[]] Список дочерних событий.
     * @param {Error|string|null} [childrenError=null] Ошибка получения дочерних событий.
     * @param {number} [childrenTotal] Общее количество дочерних записей на сервере.
     */
    function render(
        event,
        children = [],
        childrenError = null,
        childrenTotal = (Array.isArray(children) ? children.length : 0)
    ) {
        if (!event || typeof event !== 'object') {
            hide();
            return;
        }

        // 1. Очистка ресурсов медиа от предыдущего отображения
        cleanupMediaEmbeds();

        // 2. Переключение видимости: отображение контента и скрытие блока статуса
        panelElement.classList.remove('hidden');
        panelElement.style.display = 'block';
        statusElement.style.display = 'none';
        statusElement.textContent = '';
        contentElement.style.display = 'block';

        // 3. Заполнение заголовка события
        titleElement.textContent =
            typeof event.title === 'string' && event.title.trim().length > 0
                ? event.title.trim()
                : 'Без названия';

        // 4. Форматирование временного диапазона
        datesElement.textContent = formatEventDateRange(
            event.start_date,
            event.end_date,
            event.calendar_system || event.rank
        );

        // 5. Формирование бейджей мета-информации (категория и ранг)
        const categoryDesc = getCategoryDescriptor(event.category);
        categoryBadge.textContent = getCategoryLabel(event.category);
        if (categoryDesc && categoryDesc.themeVariable) {
            categoryBadge.style.setProperty('--badge-color', 'var(' + categoryDesc.themeVariable + ')');
        } else if (categoryDesc && categoryDesc.color) {
            categoryBadge.style.borderColor = categoryDesc.color;
            categoryBadge.style.color = categoryDesc.color;
        }

        rankBadge.textContent = event.rank ? String(event.rank) : '';

        // 6. Безопасный рендеринг форматированного описания Markdown
        descriptionElement.textContent = '';
        if (typeof event.description === 'string' && event.description.trim().length > 0) {
            const docRef = panelElement.ownerDocument || globalThis.document;
            const fragment = renderMarkdown(event.description.trim(), { documentRef: docRef });
            descriptionElement.appendChild(fragment);
        } else {
            const emptyNotice = doc.createElement('p');
            emptyNotice.className = 'timeline-detail-description-empty';
            emptyNotice.textContent = 'Описание отсутствует.';
            descriptionElement.appendChild(emptyNotice);
        }

        // 7. Отображение первоисточника данных
        sourceElement.textContent = '';
        if (typeof event.source === 'string' && event.source.trim().length > 0) {
            sourceElement.style.display = 'block';
            const sourceLabel = doc.createElement('span');
            sourceLabel.className = 'timeline-detail-source-label';
            sourceLabel.textContent = 'Источник: ';
            sourceElement.appendChild(sourceLabel);

            const sourceValue = event.source.trim();
            if (sourceValue.startsWith('http://') || sourceValue.startsWith('https://')) {
                const sourceLink = doc.createElement('a');
                sourceLink.className = 'timeline-detail-source-link';
                sourceLink.href = sourceValue;
                sourceLink.target = '_blank';
                sourceLink.rel = 'noopener noreferrer nofollow ugc';
                sourceLink.textContent = sourceValue;
                sourceElement.appendChild(sourceLink);
            } else {
                const sourceTextNode = doc.createTextNode(sourceValue);
                sourceElement.appendChild(sourceTextNode);
            }
        } else {
            sourceElement.style.display = 'none';
        }

        // 8. Построение секции медиа-вложений с отложенными плеерами
        if (Array.isArray(event.media_payload) && event.media_payload.length > 0) {
            mediaSection.style.display = 'block';
            const docRef = panelElement.ownerDocument || globalThis.document;
            for (let i = 0; i < event.media_payload.length; i++) {
                const mediaItem = event.media_payload[i];
                const embed = createMediaEmbed(mediaItem, { documentRef: docRef });
                activeMediaEmbeds.push(embed);
                mediaList.appendChild(embed.element);
            }
        } else {
            mediaSection.style.display = 'none';
        }

        // 9. Отображение дочерних событий и пагинации
        childrenList.textContent = '';
        const validChildren = Array.isArray(children) ? children : [];

        if (typeof childrenTotal === 'number' && childrenTotal > validChildren.length) {
            childrenCountElement.textContent = 'Показано ' + validChildren.length + ' из ' + childrenTotal;
            childrenCountElement.style.display = 'block';
        } else {
            childrenCountElement.textContent = '';
            childrenCountElement.style.display = 'none';
        }

        if (typeof childrenTotal === 'number' && childrenTotal > 0) {
            childrenTitle.textContent = `Дочерние события (${childrenTotal})`;
        } else if (validChildren.length > 0) {
            childrenTitle.textContent = `Дочерние события (${validChildren.length})`;
        } else {
            childrenTitle.textContent = 'Дочерние события';
        }

        if (validChildren.length > 0) {
            childrenSection.style.display = 'block';

            for (let i = 0; i < validChildren.length; i++) {
                const child = validChildren[i];
                const itemElement = doc.createElement('li');
                itemElement.className = 'timeline-detail-child-item';

                const btn = doc.createElement('button');
                btn.type = 'button';
                btn.className = 'timeline-detail-child-btn';

                const childTitleElement = doc.createElement('span');
                childTitleElement.className = 'timeline-detail-child-title';

                const childDesc = getCategoryDescriptor(child.category);
                if (childDesc && childDesc.themeVariable) {
                    const childSwatch = doc.createElement('span');
                    childSwatch.className = 'timeline-detail-child-swatch';
                    childSwatch.setAttribute('aria-hidden', 'true');
                    childSwatch.style.setProperty('--badge-color', 'var(' + childDesc.themeVariable + ')');
                    childTitleElement.appendChild(childSwatch);
                }

                const childTitleText = doc.createTextNode(child.title || 'Без названия');
                childTitleElement.appendChild(childTitleText);

                const childDatesElement = doc.createElement('span');
                childDatesElement.className = 'timeline-detail-child-date timeline-detail-child-dates';
                childDatesElement.textContent = formatEventDateRange(
                    child.start_date,
                    child.end_date,
                    child.calendar_system || child.rank
                );

                btn.appendChild(childTitleElement);
                btn.appendChild(childDatesElement);

                btn.addEventListener('click', () => {
                    if (typeof onSelectChild === 'function' && child) {
                        onSelectChild({ ...child });
                    }
                });

                itemElement.appendChild(btn);
                childrenList.appendChild(itemElement);
            }
        } else {
            childrenSection.style.display = 'none';
        }

        if (childrenError) {
            childrenSection.style.display = 'block';
            childrenErrorElement.style.display = 'block';
            childrenErrorElement.textContent =
                childrenError instanceof Error
                    ? `Не удалось загрузить дочерние события: ${childrenError.message}`
                    : String(childrenError);
        } else {
            childrenErrorElement.style.display = 'none';
            childrenErrorElement.textContent = '';
        }
    }

    // Слушатель нажатия кнопки закрытия панели
    closeBtn.addEventListener('click', requestClose);

    // Слушатель глобальной клавиши Escape для доступности
    function handleKeyDown(event) {
        if (event.key === 'Escape' && isVisible()) {
            requestClose();
        }
    }
    doc.addEventListener('keydown', handleKeyDown);

    /**
     * Полная утилизация компонента: очистка плееров, снятие слушателей и удаление из DOM.
     */
    function destroy() {
        cleanupMediaEmbeds();
        closeBtn.removeEventListener('click', requestClose);
        doc.removeEventListener('keydown', handleKeyDown);

        if (panelElement.parentNode) {
            panelElement.parentNode.removeChild(panelElement);
        }

        onClose = null;
        onSelectChild = null;
    }

    return {
        element: panelElement,
        render,
        showLoading,
        showError,
        hide,
        requestClose,
        destroy,
    };
}
