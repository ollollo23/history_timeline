/**
 * Модуль компонента боковой панели детализации исторического события (Detail Panel).
 * Управляет отображением метаданных события, описания, первоисточника,
 * списка прямых потомков для иерархической навигации и состояний сетевой загрузки.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ И БЕЗОПАСНОСТЬ:
 * 1. Абсолютная защита от XSS: свойство innerHTML категорически не используется.
 *    Все узлы создаются через document.createElement, а пользовательские текстовые поля
 *    записываются исключительно через свойство textContent.
 * 2. Однократное монтирование и переиспользование: панель встраивается в DOM-дерево
 *    один раз при создании представления и обновляет содержимое через метод render.
 * 3. Единый источник форматирования дат: временные границы форматируются
 *    централизованной функцией formatEventDateRange с учетом ранга детализации.
 * 4. Разделение жизненного цикла: визуальное скрытие hide() изолировано от запроса
 *    закрытия requestClose(), исключая зацикливание при реактивных обновлениях.
 * 5. Безопасное управление ресурсами: в методе destroy снимаются слушатели событий
 *    и удаляется корневой узел из родительского контейнера.
 */

import { formatEventDateRange } from '../timeline/format.js';

/**
 * Фабрика создания компонента боковой панели детализации события.
 *
 * @param {HTMLElement} containerElement Родительский DOM-контейнер таймлайна (.timeline-container).
 * @param {Function|{ onClose?: Function, onSelectChild?: Function }} [onCloseOrOptions]
 *        Колбэк закрытия панели либо объект настроек с функциями onClose и onSelectChild.
 * @param {Function} [onSelectChildArg] Колбэк выбора дочернего события при позиционной передаче аргументов.
 * @returns {{
 *   render: (event: Object, children?: Array<Object>, childrenError?: Error|null, childrenTotal?: number) => void,
 *   showLoading: () => void,
 *   showError: (error: Error|string) => void,
 *   hide: () => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления боковой панелью.
 */
export function createDetailPanel(containerElement, onCloseOrOptions, onSelectChildArg) {
    // Нормализация аргументов: поддержка как позиционных функций, так и объекта опций
    let onClose = null;
    let onSelectChild = null;

    if (typeof onCloseOrOptions === 'function') {
        onClose = onCloseOrOptions;
        if (typeof onSelectChildArg === 'function') {
            onSelectChild = onSelectChildArg;
        }
    } else if (typeof onCloseOrOptions === 'object' && onCloseOrOptions !== null) {
        onClose = typeof onCloseOrOptions.onClose === 'function' ? onCloseOrOptions.onClose : null;
        onSelectChild =
            typeof onCloseOrOptions.onSelectChild === 'function'
                ? onCloseOrOptions.onSelectChild
                : null;
    }

    // 1. Корневой элемент боковой панели
    const panelElement = document.createElement('aside');
    panelElement.className = 'timeline-detail-panel hidden';
    panelElement.setAttribute('aria-label', 'Детальная информация о событии');

    // 2. Шапка панели: заголовок и кнопка закрытия
    const headerElement = document.createElement('header');
    headerElement.className = 'timeline-detail-header';

    const titleElement = document.createElement('h2');
    titleElement.className = 'timeline-detail-title';
    headerElement.appendChild(titleElement);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'timeline-detail-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Закрыть панель детализации');
    headerElement.appendChild(closeBtn);

    panelElement.appendChild(headerElement);

    // 3. Диагностический блок статуса (сообщения загрузки и сетевых ошибок)
    const statusElement = document.createElement('div');
    statusElement.className = 'timeline-detail-status';
    statusElement.style.display = 'none';
    panelElement.appendChild(statusElement);

    // 4. Основной контейнер содержимого карточки события
    const contentElement = document.createElement('div');
    contentElement.className = 'timeline-detail-content';

    // Строка форматированного диапазона дат
    const datesElement = document.createElement('div');
    datesElement.className = 'timeline-detail-dates';
    contentElement.appendChild(datesElement);

    // Контейнер бейджей метаданных (категория и ранг детализации)
    const metaElement = document.createElement('div');
    metaElement.className = 'timeline-detail-meta';

    const categoryBadge = document.createElement('span');
    categoryBadge.className = 'timeline-detail-badge timeline-detail-badge-category';
    metaElement.appendChild(categoryBadge);

    const rankBadge = document.createElement('span');
    rankBadge.className = 'timeline-detail-badge timeline-detail-badge-rank';
    metaElement.appendChild(rankBadge);

    contentElement.appendChild(metaElement);

    // Блок развернутого исторического описания
    const descriptionElement = document.createElement('p');
    descriptionElement.className = 'timeline-detail-description';
    contentElement.appendChild(descriptionElement);

    // Строка библиографического источника
    const sourceElement = document.createElement('div');
    sourceElement.className = 'timeline-detail-source';
    contentElement.appendChild(sourceElement);

    // Секция отображения иерархических потомков
    const childrenSection = document.createElement('section');
    childrenSection.className = 'timeline-detail-children';

    const childrenTitle = document.createElement('h3');
    childrenTitle.className = 'timeline-detail-children-title';
    childrenTitle.textContent = 'Дочерние события';
    childrenSection.appendChild(childrenTitle);

    // Информационный счетчик объема дочерних записей (пагинация)
    const childrenCountElement = document.createElement('div');
    childrenCountElement.className = 'timeline-detail-children-count';
    childrenCountElement.style.display = 'none';
    childrenSection.appendChild(childrenCountElement);

    const childrenErrorElement = document.createElement('div');
    childrenErrorElement.className = 'timeline-detail-children-error';
    childrenErrorElement.style.display = 'none';
    childrenSection.appendChild(childrenErrorElement);

    const childrenList = document.createElement('ul');
    childrenList.className = 'timeline-detail-children-list';
    childrenSection.appendChild(childrenList);

    contentElement.appendChild(childrenSection);
    panelElement.appendChild(contentElement);

    // Монтирование панели в контейнер таймлайна
    if (containerElement && typeof containerElement.appendChild === 'function') {
        containerElement.appendChild(panelElement);
    }

    /**
     * Визуальное скрытие боковой панели и сброс текстового содержимого полей.
     * Не инициирует внешних колбэков, исключая зацикливание при реактивных обновлениях.
     */
    function hide() {
        panelElement.classList.add('hidden');
        titleElement.textContent = '';
        datesElement.textContent = '';
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
     * Пользовательский запрос на закрытие панели (клик по кнопке или клавиша Escape).
     * Делегирует закрытие внешнему обработчику onClose либо вызывает локальный hide.
     */
    function requestClose() {
        if (typeof onClose === 'function') {
            onClose();
        } else {
            hide();
        }
    }

    /**
     * Обработчик нажатия клавиши Escape для доступности закрытия.
     * Срабатывает только если панель в данный момент видима.
     *
     * @param {KeyboardEvent} e
     */
    function handleKeyDown(e) {
        if (e.key === 'Escape' && !panelElement.classList.contains('hidden')) {
            requestClose();
        }
    }

    // Привязка обработчиков закрытия
    closeBtn.addEventListener('click', requestClose);
    document.addEventListener('keydown', handleKeyDown);

    /**
     * Отрисовка данных события и списка дочерних записей в панели.
     *
     * @param {Object} event Доменная сущность исторического события.
     * @param {Array<Object>} [children=[]] Массив прямых потомков события.
     * @param {Error|null} [childrenError=null] Ошибка при частичном сбое загрузки потомков.
     * @param {number} [childrenTotal] Общее количество дочерних записей на сервере.
     */
    function render(
        event,
        children = [],
        childrenError = null,
        childrenTotal = (Array.isArray(children) ? children.length : 0)
    ) {
        if (!event) {
            hide();
            return;
        }

        // Переключение видимости: отображение контента и скрытие блока статуса
        panelElement.classList.remove('hidden');
        statusElement.style.display = 'none';
        statusElement.textContent = '';
        contentElement.style.display = 'block';

        // Заполнение заголовка события
        titleElement.textContent = event.title || 'Без названия';

        // Форматирование хронологического интервала дат с точностью по рангу события
        datesElement.textContent = formatEventDateRange(event.start_date, event.end_date, event.rank);

        // Заполнение метаданных (категория и ранг)
        categoryBadge.textContent = event.category ? String(event.category) : 'Общее';
        rankBadge.textContent = event.rank ? String(event.rank) : '';

        // Заполнение описания
        descriptionElement.textContent =
            typeof event.description === 'string' && event.description.trim().length > 0
                ? event.description
                : 'Описание отсутствует.';

        // Заполнение источника при его наличии
        if (typeof event.source === 'string' && event.source.trim().length > 0) {
            sourceElement.style.display = 'block';
            sourceElement.textContent = `Источник: ${event.source.trim()}`;
        } else {
            sourceElement.style.display = 'none';
            sourceElement.textContent = '';
        }

        // Очистка предыдущего списка дочерних событий
        childrenList.textContent = '';

        const validChildren = Array.isArray(children) ? children : [];

        // Отображение счетчика частичной загрузки дочерних записей
        if (childrenTotal > validChildren.length) {
            childrenCountElement.textContent = 'Показано ' + validChildren.length + ' из ' + childrenTotal;
            childrenCountElement.style.display = 'block';
        } else {
            childrenCountElement.textContent = '';
            childrenCountElement.style.display = 'none';
        }

        // Обработка списка потомков
        if (validChildren.length > 0) {
            childrenSection.style.display = 'block';

            for (let i = 0; i < validChildren.length; i++) {
                const child = validChildren[i];
                const itemElement = document.createElement('li');
                itemElement.className = 'timeline-detail-child-item';

                const childTitleElement = document.createElement('span');
                childTitleElement.className = 'timeline-detail-child-title';
                childTitleElement.textContent = child.title || 'Без названия';

                const childDatesElement = document.createElement('span');
                childDatesElement.className = 'timeline-detail-child-dates';
                childDatesElement.textContent = formatEventDateRange(
                    child.start_date,
                    child.end_date,
                    child.rank
                );

                itemElement.appendChild(childTitleElement);
                itemElement.appendChild(childDatesElement);

                // Интерактивный переход к выбранному дочернему событию с передачей копии объекта
                itemElement.addEventListener('click', () => {
                    if (typeof onSelectChild === 'function' && child) {
                        onSelectChild({ ...child });
                    }
                });

                childrenList.appendChild(itemElement);
            }
        } else {
            childrenSection.style.display = 'none';
        }

        // Вывод сообщения при частичном сбое загрузки списка потомков
        if (childrenError) {
            childrenSection.style.display = 'block';
            childrenErrorElement.style.display = 'block';
            childrenErrorElement.textContent =
                childrenError instanceof Error
                    ? `Не удалось загрузить дочерние события: ${childrenError.message}`
                    : 'Не удалось загрузить дочерние события.';
        } else {
            childrenErrorElement.style.display = 'none';
            childrenErrorElement.textContent = '';
        }
    }

    /**
     * Отображение индикатора загрузки данных карточки события.
     */
    function showLoading() {
        panelElement.classList.remove('hidden');
        contentElement.style.display = 'none';
        statusElement.style.display = 'block';
        statusElement.textContent = 'Загрузка данных...';
    }

    /**
     * Отображение диагностического сообщения об ошибке загрузки.
     *
     * @param {Error|string} error Объект ошибки или текстовое сообщение.
     */
    function showError(error) {
        panelElement.classList.remove('hidden');
        contentElement.style.display = 'none';
        statusElement.style.display = 'block';
        statusElement.textContent = error instanceof Error ? error.message : String(error);
    }

    /**
     * Полная утилизация компонента, снятие глобальных слушателей и удаление из DOM.
     */
    function destroy() {
        document.removeEventListener('keydown', handleKeyDown);
        closeBtn.removeEventListener('click', requestClose);

        if (panelElement.parentNode) {
            panelElement.parentNode.removeChild(panelElement);
        }

        onClose = null;
        onSelectChild = null;
    }

    return {
        render,
        showLoading,
        showError,
        hide,
        destroy,
    };
}
