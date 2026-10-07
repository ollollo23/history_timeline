/**
 * Модуль компонента панели управления слоями и быстрыми фильтрами направлений.
 * Предоставляет пользовательский интерфейс для переключения видимости категорий,
 * изменения порядка отображения (z-index) и плавной регулировки прозрачности.
 *
 * АРХИТЕКТУРНЫЕ ПРИНЦИПЫ:
 * 1. 100% защита от XSS: свойство innerHTML категорически не используется;
 *    все элементы создаются через document.createElement, а текст — через textContent.
 * 2. Делегирование событий: клики, события input и change обрабатываются
 *    централизованно на корневом контейнере панели.
 * 3. Разделение предпросмотра и фиксации: input генерирует commit: false для живой
 *    перерисовки холста, change и клики кнопок — commit: true для записи в хранилище.
 * 4. Сохранение фокуса клавиатуры: при изменении порядка слоев фокус восстанавливается
 *    на соответствующей кнопке того же слоя с обработкой граничных состояний disabled.
 * 5. Синхронизация диапазона: границы и шаг ползунка непрозрачности привязаны
 *    к системным константам LAYER_OPACITY_MIN, LAYER_OPACITY_MAX и LAYER_OPACITY_STEP.
 */

import {
    LAYER_OPACITY_MIN,
    LAYER_OPACITY_MAX,
    LAYER_OPACITY_STEP,
} from '../timeline/constants.js';
import {
    getCategoryDescriptor,
    getCategoryLabel,
} from '../timeline/categories.js';
import {
    createDefaultLayerState,
    normalizeLayerState,
    moveLayer,
    toggleLayerVisibility,
    showOnlyLayer,
    showAllLayers,
    setLayerOpacity,
    isCategoryFilterActive,
} from '../timeline/layers.js';

/**
 * Фабрика создания компонента панели слоев.
 *
 * @param {HTMLElement|null} containerElement Родительский DOM-контейнер для монтирования.
 * @param {{
 *   initialState?: Object,
 *   onChange?: (state: Object, meta: { commit: boolean }) => void
 * }} [options={}] Опции инициализации панели.
 * @returns {{
 *   update: (state: Object) => void,
 *   destroy: () => void
 * }} Публичный интерфейс управления панелью слоев.
 */
export function createLayerPanel(containerElement, options = {}) {
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    let currentState = normalizeLayerState(options.initialState);

    // 1. Создание корневого контейнера панели
    let panelElement = document.createElement('div');
    panelElement.className = 'layer-panel';
    panelElement.setAttribute('role', 'group');
    panelElement.setAttribute('aria-label', 'Слои и направления');

    // 2. Создание контейнера строки быстрых фильтров
    let filterBar = document.createElement('div');
    filterBar.className = 'layer-filter-bar';
    panelElement.appendChild(filterBar);

    // 3. Создание сворачиваемого блока управления порядком и прозрачностью
    let details = document.createElement('details');
    details.className = 'layer-manager';

    let summary = document.createElement('summary');
    summary.textContent = 'Порядок и прозрачность';
    details.appendChild(summary);

    let managerContent = document.createElement('div');
    managerContent.className = 'layer-manager-content';
    details.appendChild(managerContent);

    panelElement.appendChild(details);

    /**
     * Построение кнопок быстрых фильтров в строке filterBar.
     *
     * @param {Object} state Актуальное состояние слоев.
     */
    function renderFilterBar(state) {
        filterBar.textContent = '';

        for (let i = 0; i < state.order.length; i++) {
            const id = state.order[i];
            const desc = getCategoryDescriptor(id);
            const label = getCategoryLabel(id);

            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'layer-chip';
            chip.setAttribute('aria-pressed', String(state.visible[id] === true));
            chip.dataset.action = 'toggle';
            chip.dataset.category = id;

            const swatch = document.createElement('span');
            swatch.className = 'layer-swatch';
            swatch.setAttribute('aria-hidden', 'true');
            swatch.style.setProperty('--layer-color', `var(${desc.themeVariable})`);
            chip.appendChild(swatch);

            const textNode = document.createTextNode(label);
            chip.appendChild(textNode);

            filterBar.appendChild(chip);
        }

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = 'layer-chip';
        allBtn.dataset.action = 'all';
        allBtn.textContent = 'Все';
        allBtn.disabled = !isCategoryFilterActive(state);
        filterBar.appendChild(allBtn);
    }

    /**
     * Построение строк управления слоями внутри блока managerContent.
     *
     * @param {Object} state Актуальное состояние слоев.
     */
    function renderManagerContent(state) {
        managerContent.textContent = '';

        const minOpacityPercent = Math.round(LAYER_OPACITY_MIN * 100);
        const maxOpacityPercent = Math.round(LAYER_OPACITY_MAX * 100);
        const stepOpacityPercent = Math.round(LAYER_OPACITY_STEP * 100);

        for (let i = 0; i < state.order.length; i++) {
            const id = state.order[i];
            const desc = getCategoryDescriptor(id);
            const label = getCategoryLabel(id);
            const opacity = state.opacity[id] !== undefined ? state.opacity[id] : 1.0;
            const percent = Math.round(opacity * 100);

            const row = document.createElement('div');
            row.className = 'layer-row';
            row.dataset.category = id;

            // Группа кнопок перемещения слоя
            const moveGroup = document.createElement('div');
            moveGroup.className = 'layer-move-group';

            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'layer-move-btn';
            upBtn.dataset.action = 'up';
            upBtn.dataset.category = id;
            upBtn.textContent = '↑';
            upBtn.setAttribute('aria-label', `Переместить слой «${label}» выше`);
            if (i === 0) {
                upBtn.disabled = true;
            }
            moveGroup.appendChild(upBtn);

            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'layer-move-btn';
            downBtn.dataset.action = 'down';
            downBtn.dataset.category = id;
            downBtn.textContent = '↓';
            downBtn.setAttribute('aria-label', `Переместить слой «${label}» ниже`);
            if (i === state.order.length - 1) {
                downBtn.disabled = true;
            }
            moveGroup.appendChild(downBtn);

            row.appendChild(moveGroup);

            // Образец цвета и текстовая метка
            const rowInfo = document.createElement('div');
            rowInfo.className = 'layer-row-info';

            const swatch = document.createElement('span');
            swatch.className = 'layer-swatch';
            swatch.setAttribute('aria-hidden', 'true');
            swatch.style.setProperty('--layer-color', `var(${desc.themeVariable})`);
            rowInfo.appendChild(swatch);

            const labelSpan = document.createElement('span');
            labelSpan.className = 'layer-row-label';
            labelSpan.textContent = label;
            rowInfo.appendChild(labelSpan);

            row.appendChild(rowInfo);

            // Ползунок регулировки прозрачности с динамическими пределами
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'layer-opacity-input';
            slider.min = String(minOpacityPercent);
            slider.max = String(maxOpacityPercent);
            slider.step = String(stepOpacityPercent);
            slider.value = String(percent);
            slider.dataset.category = id;
            slider.setAttribute('aria-label', `Непрозрачность слоя «${label}»`);
            row.appendChild(slider);

            // Отображаемое числовое значение процентов
            const valueSpan = document.createElement('span');
            valueSpan.className = 'layer-opacity-value';
            valueSpan.textContent = `${percent} %`;
            row.appendChild(valueSpan);

            // Кнопка изоляции слоя с атрибутом доступности aria-label
            const soloBtn = document.createElement('button');
            soloBtn.type = 'button';
            soloBtn.className = 'layer-solo-btn';
            soloBtn.dataset.action = 'solo';
            soloBtn.dataset.category = id;
            soloBtn.textContent = 'Только';
            soloBtn.setAttribute('aria-label', `Показать только слой «${label}»`);
            row.appendChild(soloBtn);

            managerContent.appendChild(row);
        }

        // Кнопка сброса настроек слоев к значениям по умолчанию
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'layer-reset-btn';
        resetBtn.dataset.action = 'reset';
        resetBtn.textContent = 'Сбросить';
        managerContent.appendChild(resetBtn);
    }

    // Первичная отрисовка содержимого панели
    renderFilterBar(currentState);
    renderManagerContent(currentState);

    /**
     * Делегированный обработчик кликов по кнопкам панели.
     *
     * @param {MouseEvent} event
     */
    function handleClick(event) {
        if (!panelElement) {
            return;
        }

        const target = event.target.closest('[data-action]');
        if (!target || target.disabled || !panelElement.contains(target)) {
            return;
        }

        const action = target.dataset.action;
        const category = target.dataset.category;
        let nextState = currentState;

        switch (action) {
            case 'toggle':
                if (category) {
                    nextState = toggleLayerVisibility(currentState, category);
                    if (typeof onChange === 'function') {
                        onChange(nextState, { commit: true });
                    }
                    update(nextState);
                }
                break;

            case 'all':
                nextState = showAllLayers(currentState);
                if (typeof onChange === 'function') {
                    onChange(nextState, { commit: true });
                }
                update(nextState);
                break;

            case 'up':
                if (category) {
                    nextState = moveLayer(currentState, category, -1);
                    if (typeof onChange === 'function') {
                        onChange(nextState, { commit: true });
                    }
                    update(nextState);
                }
                break;

            case 'down':
                if (category) {
                    nextState = moveLayer(currentState, category, 1);
                    if (typeof onChange === 'function') {
                        onChange(nextState, { commit: true });
                    }
                    update(nextState);
                }
                break;

            case 'solo':
                if (category) {
                    nextState = showOnlyLayer(currentState, category);
                    if (typeof onChange === 'function') {
                        onChange(nextState, { commit: true });
                    }
                    update(nextState);
                }
                break;

            case 'reset':
                nextState = createDefaultLayerState();
                if (typeof onChange === 'function') {
                    onChange(nextState, { commit: true });
                }
                update(nextState);
                break;

            default:
                break;
        }
    }

    /**
     * Делегированный обработчик перемещения ползунка для живого предпросмотра (commit: false).
     *
     * @param {InputEvent} event
     */
    function handleInput(event) {
        const target = event.target;
        if (!target || !target.classList.contains('layer-opacity-input')) {
            return;
        }

        const category = target.dataset.category;
        if (!category) {
            return;
        }

        const val = Number(target.value) / 100;
        const row = target.closest('.layer-row');
        if (row) {
            const valueSpan = row.querySelector('.layer-opacity-value');
            if (valueSpan) {
                valueSpan.textContent = `${Math.round(val * 100)} %`;
            }
        }

        const nextState = setLayerOpacity(currentState, category, val);
        currentState = nextState;

        if (typeof onChange === 'function') {
            onChange(nextState, { commit: false });
        }
    }

    /**
     * Делегированный обработчик фиксации значения ползунка для записи в хранилище (commit: true).
     *
     * @param {Event} event
     */
    function handleChange(event) {
        const target = event.target;
        if (!target || !target.classList.contains('layer-opacity-input')) {
            return;
        }

        const category = target.dataset.category;
        if (!category) {
            return;
        }

        const val = Number(target.value) / 100;
        const nextState = setLayerOpacity(currentState, category, val);
        currentState = nextState;

        if (typeof onChange === 'function') {
            onChange(nextState, { commit: true });
        }
    }

    // Регистрация централизованных слушателей событий
    panelElement.addEventListener('click', handleClick);
    panelElement.addEventListener('input', handleInput);
    panelElement.addEventListener('change', handleChange);

    // Монтирование панели в контейнер при его наличии
    if (containerElement && typeof containerElement.appendChild === 'function') {
        containerElement.appendChild(panelElement);
    }

    /**
     * Обновление отображения панели слоев при изменении внешнего состояния.
     * Выполняет точечную синхронизацию атрибутов либо полное перестроение с сохранением фокуса.
     *
     * @param {Object} state Новое состояние слоев.
     */
    function update(state) {
        if (!panelElement) {
            return;
        }

        const nextState = normalizeLayerState(state);

        let orderChanged = false;
        if (
            !currentState ||
            !Array.isArray(currentState.order) ||
            currentState.order.length !== nextState.order.length
        ) {
            orderChanged = true;
        } else {
            for (let i = 0; i < nextState.order.length; i++) {
                if (currentState.order[i] !== nextState.order[i]) {
                    orderChanged = true;
                    break;
                }
            }
        }

        if (orderChanged) {
            // Запоминание активного элемента для предотвращения потери позиции клавиатуры
            const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
            let focusedAction = null;
            let focusedCategory = null;

            if (activeEl && panelElement.contains(activeEl)) {
                focusedAction = activeEl.dataset.action || null;
                focusedCategory = activeEl.dataset.category || null;
            }

            renderFilterBar(nextState);
            renderManagerContent(nextState);

            // Восстановление фокуса после перестроения разметки
            if (focusedAction && focusedCategory) {
                const selector = `[data-action="${focusedAction}"][data-category="${focusedCategory}"]`;
                const elToFocus = panelElement.querySelector(selector);

                if (elToFocus) {
                    if (elToFocus.disabled && (focusedAction === 'up' || focusedAction === 'down')) {
                        const oppositeAction = focusedAction === 'up' ? 'down' : 'up';
                        const oppositeSelector = `[data-action="${oppositeAction}"][data-category="${focusedCategory}"]`;
                        const oppositeEl = panelElement.querySelector(oppositeSelector);
                        if (oppositeEl && !oppositeEl.disabled) {
                            oppositeEl.focus();
                        }
                    } else if (!elToFocus.disabled) {
                        elToFocus.focus();
                    }
                }
            } else if (focusedAction === 'all' || focusedAction === 'reset') {
                const elToFocus = panelElement.querySelector(`[data-action="${focusedAction}"]`);
                if (elToFocus && !elToFocus.disabled) {
                    elToFocus.focus();
                }
            }
        } else {
            // Обновление состояния существующих элементов без пересоздания DOM
            const chips = filterBar.querySelectorAll('.layer-chip[data-action="toggle"]');
            for (let i = 0; i < chips.length; i++) {
                const chip = chips[i];
                const cat = chip.dataset.category;
                if (cat) {
                    chip.setAttribute('aria-pressed', String(nextState.visible[cat] === true));
                }
            }

            const allBtn = filterBar.querySelector('.layer-chip[data-action="all"]');
            if (allBtn) {
                allBtn.disabled = !isCategoryFilterActive(nextState);
            }

            const rows = managerContent.querySelectorAll('.layer-row');
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const cat = row.dataset.category;
                if (!cat) {
                    continue;
                }

                const upBtn = row.querySelector('.layer-move-btn[data-action="up"]');
                if (upBtn) {
                    upBtn.disabled = i === 0;
                }

                const downBtn = row.querySelector('.layer-move-btn[data-action="down"]');
                if (downBtn) {
                    downBtn.disabled = i === rows.length - 1;
                }

                const slider = row.querySelector('.layer-opacity-input');
                const opacityVal = nextState.opacity[cat] !== undefined ? nextState.opacity[cat] : 1.0;
                const percent = Math.round(opacityVal * 100);

                if (slider && Number(slider.value) !== percent) {
                    slider.value = String(percent);
                }

                const valueSpan = row.querySelector('.layer-opacity-value');
                if (valueSpan) {
                    valueSpan.textContent = `${percent} %`;
                }
            }
        }

        currentState = nextState;
    }

    /**
     * Полная утилизация компонента, снятие слушателей и удаление из DOM.
     */
    function destroy() {
        if (!panelElement) {
            return;
        }

        panelElement.removeEventListener('click', handleClick);
        panelElement.removeEventListener('input', handleInput);
        panelElement.removeEventListener('change', handleChange);

        if (panelElement.parentNode) {
            panelElement.parentNode.removeChild(panelElement);
        }

        panelElement = null;
        filterBar = null;
        details = null;
        summary = null;
        managerContent = null;
    }

    return {
        update,
        destroy,
    };
}
