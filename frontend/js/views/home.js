/**
 * Модуль представления домашней страницы (главный экран таймлайна).
 * Реализует контракт жизненного цикла SPA-представлений платформы History Timeline:
 * декларативную HTML-разметку, фазу монтирования (mount) с инициализацией контроллера Canvas
 * и фазу демонтирования (unmount) с полной очисткой системных ресурсов.
 */

import { createTimelineController } from '../timeline/controller.js';
import {
    zoomIndexToSecondsPerPixel,
    calculateVisibleDuration,
} from '../timeline/scale.js';
import { formatContextInterval } from '../timeline/format.js';

/**
 * Форматирование понятного текстового описания текущего масштаба времени на пиксель экрана.
 *
 * @param {number} spp Количество секунд в одном логическом пикселе.
 * @returns {string} Текстовое описание масштаба.
 */
function formatScaleInfo(spp) {
    if (spp < 60) {
        return `${spp >= 1 ? spp.toFixed(1) : spp.toFixed(2)} с/пкс`;
    }
    if (spp < 3600) {
        return `~${(spp / 60).toFixed(1)} мин/пкс`;
    }
    if (spp < 86400) {
        return `~${(spp / 3600).toFixed(1)} ч/пкс`;
    }
    if (spp < 31557600) {
        return `~${(spp / 86400).toFixed(1)} дн/пкс`;
    }

    const years = spp / 31557600;
    if (years < 1000) {
        return `~${years.toFixed(1)} лет/пкс`;
    }
    if (years < 1000000) {
        return `~${(years / 1000).toFixed(1)} тыс. лет/пкс`;
    }
    return `~${(years / 1000000).toFixed(1)} млн лет/пкс`;
}

/**
 * Генерация конфигурации домашней страницы приложения.
 * Возвращает декларативную разметку и методы жизненного цикла экрана.
 *
 * @returns {{ html: string, mount: (container: HTMLElement) => void, unmount: () => void }}
 */
export function renderHome() {
    // Локализованные переменные состояния экземпляра экрана для предотвращения утечек памяти
    let timelineController = null;
    let resetClickListener = null;
    let savedResetBtnElement = null;
    let statusRafId = null;
    let pendingStatusState = null;

    const html = `
        <section class="view-card">
            <!-- Основной заголовок экрана таймлайна -->
            <h1>Интерактивная временная шкала</h1>

            <!-- Пояснительное описание назначения рабочей области -->
            <p>Рабочая область таймлайна для визуализации исторических процессов с динамическим масштабированием от тысячелетий до секунд.</p>

            <!-- Индикатор проверки связи с бэкендом (динамически обновляется контроллером) -->
            <div id="api-status" class="api-status-badge">Инициализация соединения с API...</div>

            <!-- Рабочий контейнер интерактивного холста временной шкалы -->
            <div id="timeline-container" class="timeline-container" style="position: relative; width: 100%; height: 320px; overflow: hidden; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; margin-top: 1.5rem;">
                <canvas id="timeline-canvas" style="display: block; width: 100%; height: 100%; cursor: grab; outline: none;"></canvas>
            </div>

            <!-- Служебная панель управления и отображения статуса камеры -->
            <div class="timeline-toolbar" style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 1rem; padding: 0.75rem 1rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.875rem;">
                <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 1.5rem;">
                    <div><span style="color: var(--text-secondary);">Видимый диапазон: </span><strong id="timeline-range-info" style="color: var(--text-primary); font-family: monospace;">—</strong></div>
                    <div><span style="color: var(--text-secondary);">Масштаб: </span><strong id="timeline-scale-info" style="color: var(--text-primary); font-family: monospace;">—</strong></div>
                </div>
                <button id="timeline-reset-btn" type="button" class="btn" style="padding: 0.4rem 0.85rem; font-size: 0.85rem; background: var(--bg-accent, #27272a); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">К началу</button>
            </div>
        </section>
    `;

    /**
     * Фаза монтирования: вызывается маршрутизатором после вставки разметки в DOM.
     * Инициализирует интерактивный контроллер таймлайна и привязывает обработчики событий.
     *
     * @param {HTMLElement} [container] Корневой элемент монтирования представления.
     */
    const mount = (container) => {
        const root = container || document;

        // Поиск элементов управления и холста внутри смонтированного DOM-дерева
        const canvasElement = root.querySelector('#timeline-canvas');
        const containerElement = root.querySelector('#timeline-container');
        const rangeInfoElement = root.querySelector('#timeline-range-info');
        const scaleInfoElement = root.querySelector('#timeline-scale-info');
        const resetBtnElement = root.querySelector('#timeline-reset-btn');

        // Прерывание инициализации при отсутствии ключевых элементов рабочей области
        if (!canvasElement || !containerElement) {
            return;
        }

        // Сохранение ссылки на кнопку сброса для безопасного снятия слушателя в unmount
        savedResetBtnElement = resetBtnElement;

        /**
         * Синхронное применение данных состояния к DOM-элементам тулбара.
         *
         * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
         */
        const applyStatusUpdate = (state) => {
            if (!rangeInfoElement || !scaleInfoElement) {
                return;
            }

            const spp = zoomIndexToSecondsPerPixel(state.zoomIndex);
            const duration = calculateVisibleDuration(state.widthPx, spp);

            const startTs = state.originTimestamp;
            const endTs = startTs + duration;

            // Форматирование диапазона через централизованную функцию модуля format.js
            rangeInfoElement.textContent = formatContextInterval(startTs, endTs);
            scaleInfoElement.textContent = formatScaleInfo(spp);
        };

        /**
         * Пакетное обновление тулбара с планированием через requestAnimationFrame.
         * Предотвращает множественные синхронные пересчеты стилей и разметки.
         *
         * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} state
         */
        const updateStatus = (state) => {
            pendingStatusState = state;

            // Если кадр уже запланирован, пропускаем повторный вызов
            if (statusRafId !== null) {
                return;
            }

            statusRafId = requestAnimationFrame(() => {
                statusRafId = null;
                if (pendingStatusState) {
                    applyStatusUpdate(pendingStatusState);
                }
            });
        };

        // Создание контроллера интерактивного взаимодействия с холстом
        timelineController = createTimelineController(canvasElement, containerElement, updateStatus);

        // Первичное заполнение индикаторов статуса текущим состоянием камеры
        if (timelineController && typeof timelineController.getState === 'function') {
            applyStatusUpdate(timelineController.getState());
        }

        // Привязка кнопки сброса положения камеры к начальным координатам
        if (savedResetBtnElement && timelineController) {
            resetClickListener = () => {
                if (timelineController && typeof timelineController.reset === 'function') {
                    timelineController.reset();
                }
            };
            savedResetBtnElement.addEventListener('click', resetClickListener);
        }
    };

    /**
     * Фаза демонтирования: вызывается маршрутизатором перед переключением на другой экран.
     * Завершает все анимации, слушатели ввода и освобождает ссылки для сборщика мусора.
     */
    const unmount = () => {
        // Отмена запланированного кадра обновления тулбара
        if (statusRafId !== null) {
            cancelAnimationFrame(statusRafId);
            statusRafId = null;
            pendingStatusState = null;
        }

        // Снятие обработчика клика по сохраненной ссылке на кнопку сброса без querySelector
        if (savedResetBtnElement && resetClickListener) {
            savedResetBtnElement.removeEventListener('click', resetClickListener);
            resetClickListener = null;
            savedResetBtnElement = null;
        }

        // Полное уничтожение контроллера таймлайна (Canvas, ResizeObserver, EventListeners)
        if (timelineController) {
            if (typeof timelineController.destroy === 'function') {
                timelineController.destroy();
            } else if (typeof timelineController.unmount === 'function') {
                timelineController.unmount();
            }
            timelineController = null;
        }
    };

    return { html, mount, unmount };
}
