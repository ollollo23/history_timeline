// @vitest-environment happy-dom

/**
 * Модульные тесты пользовательского интерфейса панели слоев (layerPanel.js).
 * Проверяет первичное построение разметки, доступность по стандарту WCAG,
 * переключение видимости, сохранение фокуса при вертикальном перемещении слоев,
 * двухфазную регулировку непрозрачности и корректную утилизацию в среде happy-dom.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLayerPanel } from '../../frontend/js/components/layerPanel.js';
import { createDefaultLayerState } from '../../frontend/js/timeline/layers.js';
import { CATEGORY_IDS, getCategoryLabel } from '../../frontend/js/timeline/categories.js';

describe('DOM-компонент панели слоев layerPanel.js', () => {
    let container = null;

    beforeEach(() => {
        // Создание изолированного корневого контейнера перед каждым тестом
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        // Очистка дерева документа и сброс шпионов
        if (container) {
            container.remove();
            container = null;
        }
        vi.restoreAllMocks();
    });

    it('Сценарий 1: начальная отрисовка панели слоев, чипов и кнопки «Все»', () => {
        const defaultState = createDefaultLayerState();
        createLayerPanel(container, { initialState: defaultState });

        // Проверка наличия строки быстрых фильтров
        const filterBar = container.querySelector('.layer-filter-bar');
        expect(filterBar).not.toBeNull();

        // Проверка отрисовки чипов строго в порядке категорий состояния
        const chips = filterBar.querySelectorAll('.layer-chip[data-action="toggle"]');
        expect(chips.length).toBe(defaultState.order.length);

        for (let i = 0; i < defaultState.order.length; i++) {
            const expectedCategory = defaultState.order[i];
            expect(chips[i].dataset.category).toBe(expectedCategory);
            expect(chips[i].getAttribute('aria-pressed')).toBe('true');
        }

        // Проверка наличия и неактивности кнопки «Все» при всех включенных слоях
        const allBtn = filterBar.querySelector('.layer-chip[data-action="all"]');
        expect(allBtn).not.toBeNull();
        expect(allBtn.disabled).toBe(true);
    });

    it('Сценарий 2: переключение видимости по клику на чип категории', () => {
        const onChange = vi.fn();
        createLayerPanel(container, {
            initialState: createDefaultLayerState(),
            onChange,
        });

        // Поиск чипа категории culture и эмуляция клика
        const cultureChip = container.querySelector(
            '.layer-chip[data-action="toggle"][data-category="culture"]'
        );
        expect(cultureChip).not.toBeNull();

        cultureChip.click();

        // Проверка вызова колбэка с фиксацией изменений в хранилище
        expect(onChange).toHaveBeenCalledTimes(1);
        const [nextState, meta] = onChange.mock.calls[0];
        expect(meta).toEqual({ commit: true });
        expect(nextState.visible.culture).toBe(false);

        // Проверка обновления состояния кнопки-чипа
        expect(cultureChip.getAttribute('aria-pressed')).toBe('false');

        // Проверка активации кнопки «Все»
        const allBtn = container.querySelector('.layer-chip[data-action="all"]');
        expect(allBtn.disabled).toBe(false);
    });

    it('Сценарий 3: перемещение слоя без достижения границы списка и сохранение фокуса', () => {
        const onChange = vi.fn();
        createLayerPanel(container, {
            initialState: createDefaultLayerState(),
            onChange,
        });

        // Поиск строки третьего слоя (индекс 2, economy) и кнопки перемещения вверх
        const economyUpBtn = container.querySelector(
            '.layer-move-btn[data-action="up"][data-category="economy"]'
        );
        expect(economyUpBtn).not.toBeNull();

        economyUpBtn.focus();
        economyUpBtn.click();

        // Проверка сдвига слоя на индекс 1
        expect(onChange).toHaveBeenCalledTimes(1);
        const [nextState] = onChange.mock.calls[0];
        expect(nextState.order[1]).toBe('economy');

        // Проверка сохранения фокуса на кнопке перемещения вверх того же слоя
        const activeEl = document.activeElement;
        expect(activeEl).not.toBeNull();
        expect(activeEl.dataset.action).toBe('up');
        expect(activeEl.dataset.category).toBe('economy');
        expect(activeEl.disabled).toBe(false);
    });

    it('Сценарий 4: перемещение слоя в самый верх списка и перенос фокуса на кнопку «↓»', () => {
        const onChange = vi.fn();
        createLayerPanel(container, {
            initialState: createDefaultLayerState(),
            onChange,
        });

        // Поиск строки второго слоя (индекс 1, politics) и кнопки перемещения вверх
        const politicsUpBtn = container.querySelector(
            '.layer-move-btn[data-action="up"][data-category="politics"]'
        );
        expect(politicsUpBtn).not.toBeNull();

        politicsUpBtn.focus();
        politicsUpBtn.click();

        // Проверка перемещения категории politics на вершину (индекс 0)
        expect(onChange).toHaveBeenCalledTimes(1);
        const [nextState] = onChange.mock.calls[0];
        expect(nextState.order[0]).toBe('politics');

        // Кнопка перемещения вверх на верхнем элементе должна стать заблокированной
        const currentPoliticsUpBtn = container.querySelector(
            '.layer-move-btn[data-action="up"][data-category="politics"]'
        );
        expect(currentPoliticsUpBtn.disabled).toBe(true);

        // Проверка переноса фокуса на противоположную кнопку перемещения вниз того же слоя
        const activeEl = document.activeElement;
        expect(activeEl).not.toBeNull();
        expect(activeEl.dataset.action).toBe('down');
        expect(activeEl.dataset.category).toBe('politics');
    });

    it('Сценарий 5: разделение событий ползунка непрозрачности (input и change)', () => {
        const onChange = vi.fn();
        createLayerPanel(container, {
            initialState: createDefaultLayerState(),
            onChange,
        });

        const slider = container.querySelector('.layer-opacity-input');
        expect(slider).not.toBeNull();
        const categoryId = slider.dataset.category;

        const row = slider.closest('.layer-row');
        const valueSpan = row.querySelector('.layer-opacity-value');

        // 1. Событие input: живой предпросмотр без фиксации в хранилище
        slider.value = '60';
        slider.dispatchEvent(new Event('input', { bubbles: true }));

        expect(valueSpan.textContent).toBe('60 %');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith(expect.any(Object), { commit: false });

        // 2. Событие change: фиксация значения в хранилище
        slider.value = '70';
        slider.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onChange).toHaveBeenCalledTimes(2);
        const [nextState, meta] = onChange.mock.calls[1];
        expect(meta).toEqual({ commit: true });
        expect(nextState.opacity[categoryId]).toBe(0.7);
    });

    it('Сценарий 6: проверка атрибута доступности aria-label у кнопки «Только»', () => {
        createLayerPanel(container, {
            initialState: createDefaultLayerState(),
        });

        const rows = container.querySelectorAll('.layer-manager-content .layer-row');
        expect(rows.length).toBe(CATEGORY_IDS.length);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const id = row.dataset.category;
            const soloBtn = row.querySelector('.layer-solo-btn');
            expect(soloBtn).not.toBeNull();

            const expectedLabel = getCategoryLabel(id);
            expect(soloBtn.getAttribute('aria-label')).toBe(`Показать только слой «${expectedLabel}»`);
        }
    });

    it('Сценарий 7: утилизация компонента через метод destroy', () => {
        const onChange = vi.fn();
        const panel = createLayerPanel(container, {
            initialState: createDefaultLayerState(),
            onChange,
        });

        const chip = container.querySelector('.layer-chip[data-action="toggle"]');
        expect(chip).not.toBeNull();

        // Полное уничтожение компонента
        panel.destroy();

        // Проверка удаления корневого элемента из родительского контейнера
        expect(container.children.length).toBe(0);

        // Проверка снятия слушателей событий
        onChange.mockClear();
        chip.click();

        expect(onChange).not.toHaveBeenCalled();
    });
});
