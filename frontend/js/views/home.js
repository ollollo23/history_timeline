/**
 * Модуль представления домашней страницы (главный экран таймлайна).
 * Реализует контракт жизненного цикла SPA-представлений платформы History Timeline:
 * декларативную HTML-разметку, фазу монтирования (mount) с инициализацией контроллера Canvas,
 * панели слоев категорий, часов реального времени и боковой панели детализации,
 * а также фазу демонтирования (unmount) с полной очисткой системных ресурсов.
 */

import { createTimelineController } from '../timeline/controller.js';
import {
    zoomIndexToSecondsPerPixel,
    calculateVisibleDuration,
} from '../timeline/scale.js';
import { formatContextInterval } from '../timeline/format.js';
import { createDetailPanel } from '../components/detailPanel.js';
import { createClock } from '../components/clock.js';
import { createLayerPanel } from '../components/layerPanel.js';
import {
    loadLayerState,
    saveLayerState,
    filterEventsByLayers,
    isCategoryFilterActive,
    getCategoryRequest,
    countVisibleLayers,
} from '../timeline/layers.js';

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
    let detailPanel = null;
    let layerPanel = null;
    let clock = null;
    let layerState = null;
    let resetClickListener = null;
    let savedResetBtnElement = null;
    let statusRafId = null;
    let pendingViewportState = null;
    let pendingStoreState = null;
    let pendingSelectionState = null;

    // Ссылка на последний примененный слепок выбора для предотвращения избыточных DOM-мутаций
    let lastAppliedSelectionState = null;

    const html = `
        <section class="view-card">
            <!-- Основной заголовок экрана таймлайна -->
            <h1>Интерактивная временная шкала</h1>

            <!-- Пояснительное описание назначения рабочей области -->
            <p>Рабочая область таймлайна для визуализации исторических процессов с динамическим масштабированием от тысячелетий до секунд.</p>

            <!-- Индикатор проверки связи с бэкендом (динамически обновляется контроллером) -->
            <div id="api-status" class="api-status-badge">Инициализация соединения с API...</div>

            <!-- Контейнер панели управления слоями и быстрыми фильтрами -->
            <div id="timeline-layer-panel"></div>

            <!-- Рабочий контейнер интерактивного холста временной шкалы -->
            <div id="timeline-container" class="timeline-container" style="position: relative; width: 100%; height: 440px; overflow: hidden; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; margin-top: 1.5rem;">
                <canvas id="timeline-canvas" style="display: block; width: 100%; height: 100%; cursor: grab; outline: none;"></canvas>
            </div>

            <!-- Служебная панель управления и отображения статуса камеры и контура данных -->
            <div class="timeline-toolbar" style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 1rem; padding: 0.75rem 1rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.875rem;">
                <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 1.5rem;">
                    <div><span style="color: var(--text-secondary);">Видимый диапазон: </span><strong id="timeline-range-info" style="color: var(--text-primary); font-family: monospace;">—</strong></div>
                    <div><span style="color: var(--text-secondary);">Масштаб: </span><strong id="timeline-scale-info" style="color: var(--text-primary); font-family: monospace;">—</strong></div>
                    <div><span style="color: var(--text-secondary);">Сейчас: </span><time id="timeline-now-info" class="timeline-now-info">—</time></div>
                    <div><span style="color: var(--text-secondary);">Событий: </span><strong id="timeline-events-count" style="color: var(--text-primary); font-family: monospace;">0</strong></div>
                    <div id="timeline-directions-wrapper" hidden><span style="color: var(--text-secondary);">Направления: </span><strong id="timeline-directions-info" class="timeline-directions-info">—</strong></div>
                    <div><span style="color: var(--text-secondary);">Статус: </span><strong id="timeline-loading-status" style="color: var(--text-primary); font-family: monospace;">Ожидание</strong></div>
                    <div id="timeline-truncation-warning" style="display: none; color: #eab308; font-weight: 500;">Показаны не все события (приблизьте масштаб)</div>
                </div>
                <button id="timeline-reset-btn" type="button" class="btn" style="padding: 0.4rem 0.85rem; font-size: 0.85rem; background: var(--bg-accent, #27272a); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;">К началу</button>
            </div>
        </section>
    `;

    /**
     * Фаза монтирования: вызывается маршрутизатором после вставки разметки в DOM.
     * Инициализирует интерактивный контроллер таймлайна, панель деталей, панель слоев, часы и слушатели событий.
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
        const eventsCountElement = root.querySelector('#timeline-events-count');
        const directionsWrapperElement = root.querySelector('#timeline-directions-wrapper');
        const directionsInfoElement = root.querySelector('#timeline-directions-info');
        const loadingStatusElement = root.querySelector('#timeline-loading-status');
        const truncationWarningElement = root.querySelector('#timeline-truncation-warning');
        const layerPanelContainer = root.querySelector('#timeline-layer-panel');
        const nowElement = root.querySelector('#timeline-now-info');

        // Прерывание инициализации при отсутствии ключевых элементов рабочей области
        if (!canvasElement || !containerElement) {
            return;
        }

        // Сохранение ссылки на кнопку сброса для безопасного снятия слушателя в unmount
        savedResetBtnElement = resetBtnElement;

        // Загрузка сохраненного состояния слоев из хранилища
        layerState = loadLayerState();

        // Инициализация компонента боковой панели детализации с передачей обработчиков
        detailPanel = createDetailPanel(containerElement, {
            onClose: () => {
                if (timelineController && typeof timelineController.clearSelection === 'function') {
                    timelineController.clearSelection();
                }
            },
            onSelectChild: (child) => {
                // Плавная фокусировка камеры на выбранном дочернем событии
                if (timelineController && child && typeof timelineController.focusEvent === 'function') {
                    timelineController.focusEvent(child);
                }
            },
        });

        /**
         * Синхронное применение данных состояния камеры, хранилища и выбора к элементам интерфейса.
         *
         * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>|null} viewportState
         * @param {Readonly<{status: string, isTruncated: boolean, events: Array<Object>}>|null} storeState
         * @param {Readonly<{selectedId: number|null, event: Object|null, children: Array<Object>, childrenTotal: number, status: string, error: Error|null, childrenError: Error|null}>|null} [selectionState]
         */
        const applyStatusUpdate = (viewportState, storeState, selectionState) => {
            // 1. Обновление диапазона и масштаба камеры
            if (viewportState && rangeInfoElement && scaleInfoElement) {
                const spp = zoomIndexToSecondsPerPixel(viewportState.zoomIndex);
                const duration = calculateVisibleDuration(viewportState.widthPx, spp);

                const startTs = viewportState.originTimestamp;
                const endTs = startTs + duration;

                // Форматирование диапазона через централизованную функцию модуля format.js
                rangeInfoElement.textContent = formatContextInterval(startTs, endTs);
                scaleInfoElement.textContent = formatScaleInfo(spp);
            }

            // 2. Управление отображением индикатора направлений
            if (directionsWrapperElement && directionsInfoElement && layerState) {
                if (isCategoryFilterActive(layerState)) {
                    const counts = countVisibleLayers(layerState);
                    directionsInfoElement.textContent = counts.visible + ' из ' + counts.total;
                    directionsWrapperElement.hidden = false;
                } else {
                    directionsWrapperElement.hidden = true;
                }
            }

            // 3. Обновление числа видимых событий
            if (storeState && eventsCountElement) {
                const rawEvents = Array.isArray(storeState.events) ? storeState.events : [];
                const visibleEvents = layerState ? filterEventsByLayers(rawEvents, layerState) : rawEvents;
                eventsCountElement.textContent = String(visibleEvents.length);
            }

            // 4. Обработка сетевого статуса с учетом отключения всех категорий
            const categoryReq = layerState ? getCategoryRequest(layerState) : null;
            if (categoryReq && categoryReq.shouldRequest === false) {
                if (loadingStatusElement) {
                    loadingStatusElement.textContent = 'Все направления скрыты';
                    loadingStatusElement.style.color = 'var(--text-secondary)';
                }
                if (truncationWarningElement) {
                    truncationWarningElement.style.display = 'none';
                }
            } else if (storeState) {
                // Обновление сетевого статуса с цветовой индикацией
                if (loadingStatusElement) {
                    if (storeState.status === 'loading') {
                        loadingStatusElement.textContent = 'Загрузка...';
                        loadingStatusElement.style.color = '#3b82f6';
                    } else if (storeState.status === 'error') {
                        loadingStatusElement.textContent = 'Отказ';
                        loadingStatusElement.style.color = '#ef4444';
                    } else {
                        loadingStatusElement.textContent = 'Ожидание';
                        loadingStatusElement.style.color = 'var(--text-primary)';
                    }
                }

                // Управление видимостью предупреждения об усечении выборки
                if (truncationWarningElement) {
                    truncationWarningElement.style.display = storeState.isTruncated
                        ? 'inline-block'
                        : 'none';
                }
            }

            // 5. Синхронизация состояния боковой панели детализации с защитой от повторного рендеринга
            if (selectionState && detailPanel) {
                if (selectionState !== lastAppliedSelectionState) {
                    lastAppliedSelectionState = selectionState;

                    if (selectionState.status === 'loading') {
                        detailPanel.showLoading();
                    } else if (selectionState.status === 'error') {
                        detailPanel.showError(selectionState.error);
                    } else if (selectionState.status === 'idle') {
                        if (selectionState.event) {
                            detailPanel.render(
                                selectionState.event,
                                selectionState.children,
                                selectionState.childrenError,
                                selectionState.childrenTotal
                            );
                        } else {
                            detailPanel.hide();
                        }
                    }
                }
            }
        };

        /**
         * Пакетное обновление тулбара и панели с планированием через requestAnimationFrame.
         *
         * @param {Readonly<{originTimestamp: number, zoomIndex: number, widthPx: number, heightPx: number}>} viewportState
         * @param {Readonly<{status: string, isTruncated: boolean, events: Array<Object>}>} [storeState]
         * @param {Readonly<{selectedId: number|null, event: Object|null, children: Array<Object>, childrenTotal: number, status: string, error: Error|null, childrenError: Error|null}>} [selectionState]
         */
        const updateStatus = (viewportState, storeState, selectionState) => {
            pendingViewportState = viewportState;
            if (storeState) {
                pendingStoreState = storeState;
            }
            if (selectionState) {
                pendingSelectionState = selectionState;
            }

            // Если кадр уже запланирован, пропускаем повторный вызов
            if (statusRafId !== null) {
                return;
            }

            statusRafId = requestAnimationFrame(() => {
                statusRafId = null;
                applyStatusUpdate(
                    pendingViewportState,
                    pendingStoreState,
                    pendingSelectionState
                );
            });
        };

        /**
         * Обработчик реактивного изменения состояния слоев (фильтрация, порядок, прозрачность).
         *
         * @param {Object} next Новое состояние слоев.
         * @param {{ commit?: boolean }} [meta] Флаг фиксации изменений в localStorage.
         */
        const handleLayerChange = (next, { commit = true } = {}) => {
            layerState = next;

            if (timelineController && typeof timelineController.setLayerState === 'function') {
                timelineController.setLayerState(next);
            }

            if (layerPanel && typeof layerPanel.update === 'function') {
                layerPanel.update(next);
            }

            if (commit) {
                saveLayerState(next);
            }

            if (timelineController) {
                updateStatus(
                    timelineController.getState(),
                    timelineController.getStoreState(),
                    timelineController.getSelectionState()
                );
            }
        };

        // Инициализация интерактивной панели слоев
        if (layerPanelContainer) {
            layerPanel = createLayerPanel(layerPanelContainer, {
                initialState: layerState,
                onChange: handleLayerChange,
            });
        }

        // Создание контроллера интерактивного взаимодействия с холстом с передачей состояния слоев
        timelineController = createTimelineController(
            canvasElement,
            containerElement,
            updateStatus,
            { layerState }
        );

        // Инициализация и запуск компонента часов реального времени
        if (nowElement) {
            clock = createClock(nowElement, {
                onTick: () => timelineController?.refreshNowMarker(),
            });
            clock.start();
        }

        // Первичное заполнение индикаторов статуса текущим состоянием камеры, хранилища и выбора
        if (timelineController && typeof timelineController.getState === 'function') {
            const initialStoreState =
                typeof timelineController.getStoreState === 'function'
                    ? timelineController.getStoreState()
                    : null;
            const initialSelectionState =
                typeof timelineController.getSelectionState === 'function'
                    ? timelineController.getSelectionState()
                    : null;
            applyStatusUpdate(
                timelineController.getState(),
                initialStoreState,
                initialSelectionState
            );
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
        // Остановка и очистка часов и панели слоев
        if (clock) {
            clock.destroy();
            clock = null;
        }
        if (layerPanel) {
            layerPanel.destroy();
            layerPanel = null;
        }

        // Отмена запланированного кадра обновления тулбара
        if (statusRafId !== null) {
            cancelAnimationFrame(statusRafId);
            statusRafId = null;
            pendingViewportState = null;
            pendingStoreState = null;
            pendingSelectionState = null;
        }

        // Очистка кэшированного слепка выбора
        lastAppliedSelectionState = null;

        // Уничтожение компонента боковой панели детализации
        if (detailPanel) {
            detailPanel.destroy();
            detailPanel = null;
        }

        // Снятие обработчика клика по сохраненной ссылке на кнопку сброса без querySelector
        if (savedResetBtnElement && resetClickListener) {
            savedResetBtnElement.removeEventListener('click', resetClickListener);
            resetClickListener = null;
            savedResetBtnElement = null;
        }

        // Полное уничтожение контроллера таймлайна (Canvas, EventStore, SelectionStore, ResizeObserver, EventListeners)
        if (timelineController) {
            if (typeof timelineController.destroy === 'function') {
                timelineController.destroy();
            } else if (typeof timelineController.unmount === 'function') {
                timelineController.unmount();
            }
            timelineController = null;
        }

        // Обнуление состояния слоев
        layerState = null;
    };

    return { html, mount, unmount };
}
