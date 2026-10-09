// @vitest-environment happy-dom

/**
 * Модульные тесты интерактивного представления создания события (create_event.js).
 * Выполняются в виртуальной среде happy-dom с использованием фреймворка Vitest.
 * Проверяют структуру формы, динамическое управление медиа-вложениями (до 20 элементов),
 * клиентскую предвалидацию ссылок, валидацию соотношения дат, обработку успешной отправки,
 * серверных ошибок (422, 401, 403) и корректное размонтирование представления в unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderCreateEvent } from '../../frontend/js/views/create_event.js';
import { createEvent } from '../../frontend/js/services/api.js';

vi.mock('../../frontend/js/services/api.js', () => ({
    createEvent: vi.fn(),
}));

describe('Представление создания исторического события (create_event.js)', () => {
    let container;
    let view;

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
        view = renderCreateEvent();
    });

    afterEach(() => {
        if (view && typeof view.unmount === 'function') {
            view.unmount();
        }
        if (container && container.parentNode) {
            container.parentNode.removeChild(container);
        }
        vi.restoreAllMocks();
    });

    describe('Контракт представления и базовая разметка', () => {
        it('возвращает объект со свойствами html, mount и unmount', () => {
            expect(view).toBeDefined();
            expect(typeof view.html).toBe('string');
            expect(typeof view.mount).toBe('function');
            expect(typeof view.unmount).toBe('function');
        });

        it('монтирует форму и все обязательные элементы управления в контейнер', () => {
            container.innerHTML = view.html;
            view.mount(container);

            expect(container.querySelector('#create-event-form')).not.toBeNull();
            expect(container.querySelector('#event-title')).not.toBeNull();
            expect(container.querySelector('#event-start-date')).not.toBeNull();
            expect(container.querySelector('#event-end-date')).not.toBeNull();
            expect(container.querySelector('#event-category')).not.toBeNull();
            expect(container.querySelector('#event-rank')).not.toBeNull();
            expect(container.querySelector('#event-description-editor-container')).not.toBeNull();
            expect(container.querySelector('#event-media-section')).not.toBeNull();
            expect(container.querySelector('#submit-event-btn')).not.toBeNull();
        });
    });

    describe('Динамический список медиа-вложений', () => {
        it('инициализирует пустой список и добавляет строку при нажатии кнопки добавления', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const mediaList = container.querySelector('#event-media-list');
            const addBtn = container.querySelector('#add-media-btn');
            const counter = container.querySelector('#media-counter');

            expect(mediaList.children.length).toBe(0);
            expect(counter.textContent).toBe('0 / 20');

            addBtn.click();

            expect(mediaList.children.length).toBe(1);
            expect(counter.textContent).toBe('1 / 20');

            const mediaRow = mediaList.querySelector('.form-media-item');
            expect(mediaRow).not.toBeNull();
            expect(mediaRow.querySelector('.form-media-type')).not.toBeNull();
            expect(mediaRow.querySelector('.form-media-url')).not.toBeNull();
            expect(mediaRow.querySelector('.form-media-title')).not.toBeNull();
            expect(mediaRow.querySelector('.form-media-remove-btn')).not.toBeNull();
        });

        it('блокирует добавление свыше 20 элементов медиа-вложений', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const addBtn = container.querySelector('#add-media-btn');
            const mediaList = container.querySelector('#event-media-list');
            const counter = container.querySelector('#media-counter');

            for (let i = 0; i < 20; i++) {
                addBtn.click();
            }

            expect(mediaList.children.length).toBe(20);
            expect(counter.textContent).toBe('20 / 20');
            expect(addBtn.disabled).toBe(true);

            addBtn.click();
            expect(mediaList.children.length).toBe(20);
        });

        it('удаляет выбранную строку медиа и уменьшает счетчик', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const addBtn = container.querySelector('#add-media-btn');
            const mediaList = container.querySelector('#event-media-list');
            const counter = container.querySelector('#media-counter');

            addBtn.click();
            addBtn.click();
            expect(mediaList.children.length).toBe(2);
            expect(counter.textContent).toBe('2 / 20');

            const firstRemoveBtn = mediaList.querySelector('.form-media-remove-btn');
            firstRemoveBtn.click();

            expect(mediaList.children.length).toBe(1);
            expect(counter.textContent).toBe('1 / 20');
            expect(addBtn.disabled).toBe(false);
        });
    });

    describe('Предварительная клиентская проверка URL медиа', () => {
        it('выводит подтверждение для валидного доверенного адреса встраивания видео', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const addBtn = container.querySelector('#add-media-btn');
            addBtn.click();

            const mediaRow = container.querySelector('.form-media-item');
            const typeSelect = mediaRow.querySelector('.form-media-type');
            const urlInput = mediaRow.querySelector('.form-media-url');
            const hint = mediaRow.querySelector('.form-media-hint');

            typeSelect.value = 'video';
            typeSelect.dispatchEvent(new Event('change'));

            urlInput.value = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
            urlInput.dispatchEvent(new Event('input'));

            expect(hint.style.display).toBe('block');
            expect(hint.textContent).toBe('Доверенный адрес встраивания видео');
        });

        it('выводит предупреждение при вводе недопустимого или неподдерживаемого видео-хоста', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const addBtn = container.querySelector('#add-media-btn');
            addBtn.click();

            const mediaRow = container.querySelector('.form-media-item');
            const typeSelect = mediaRow.querySelector('.form-media-type');
            const urlInput = mediaRow.querySelector('.form-media-url');
            const hint = mediaRow.querySelector('.form-media-hint');

            typeSelect.value = 'video';
            typeSelect.dispatchEvent(new Event('change'));

            urlInput.value = 'https://evil-site.com/video';
            urlInput.dispatchEvent(new Event('input'));

            expect(hint.style.display).toBe('block');
            expect(hint.textContent).toBe('Неподдерживаемый или небезопасный адрес видео');
        });
    });

    describe('Валидация хронологических дат', () => {
        it('предотвращает сетевой запрос и выводит ошибку, если дата окончания меньше начальной', async () => {
            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            container.querySelector('#event-title').value = 'Битва при реке';
            container.querySelector('#event-start-date').value = '1000';
            container.querySelector('#event-end-date').value = '500';
            container.querySelector('#event-category').value = 'politics';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();

            expect(createEvent).not.toHaveBeenCalled();

            const endDateError = container.querySelector('#event-end-date-error');
            expect(endDateError.style.display).toBe('block');
            expect(endDateError.textContent).toBe('Конечная дата не может предшествовать начальной');
        });
    });

    describe('Успешная отправка формы', () => {
        it('вызывает createEvent с валидной структурой данных и выводит ID созданного события', async () => {
            createEvent.mockResolvedValueOnce({ id: 42, title: 'Тестовое событие' });

            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            container.querySelector('#event-title').value = 'Основание города';
            container.querySelector('#event-start-date').value = '1000';
            container.querySelector('#event-end-date').value = '1050';
            container.querySelector('#event-category').value = 'culture';
            container.querySelector('#event-rank').value = 'year';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(createEvent).toHaveBeenCalledWith({
                title: 'Основание города',
                start_date: 1000,
                end_date: 1050,
                category: 'culture',
                rank: 'year',
                description: null,
                media_payload: null,
            });

            const statusMsg = container.querySelector('#form-status-message');
            expect(statusMsg.style.display).toBe('block');
            expect(statusMsg.textContent).toContain('42');
            expect(statusMsg.textContent).toContain('Событие успешно создано');
        });
    });

    describe('Обработка серверных ошибок', () => {
        it('отображает общее сообщение об ошибке при отклонении сетевого запроса', async () => {
            createEvent.mockRejectedValueOnce(new Error("Поле 'title' не может быть пустым"));

            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            container.querySelector('#event-title').value = 'Событие';
            container.querySelector('#event-start-date').value = '2000';
            container.querySelector('#event-category').value = 'science';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const statusMsg = container.querySelector('#form-status-message');
            expect(statusMsg.style.display).toBe('block');
            expect(statusMsg.textContent).toContain("Поле 'title' не может быть пустым");
        });

        it('отображает сервисное уведомление при статусах отказа в доступе 401 и 403', async () => {
            createEvent.mockRejectedValueOnce({ status: 401 });

            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            container.querySelector('#event-title').value = 'Закрытое событие';
            container.querySelector('#event-start-date').value = '2000';
            container.querySelector('#event-category').value = 'economy';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const statusMsg = container.querySelector('#form-status-message');
            expect(statusMsg.style.display).toBe('block');
            expect(statusMsg.textContent).toContain('Для публикации требуются права доступа');
        });

        it('распределяет ошибки валидации 422 по соответствующим полям ввода', async () => {
            createEvent.mockRejectedValueOnce({
                status: 422,
                detail: [{ loc: ['body', 'title'], msg: 'Слишком короткий заголовок' }],
            });

            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            container.querySelector('#event-title').value = 'А';
            container.querySelector('#event-start-date').value = '100';
            container.querySelector('#event-category').value = 'politics';

            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 10));

            const titleError = container.querySelector('#event-title-error');
            expect(titleError.style.display).toBe('block');
            expect(titleError.textContent).toBe('Слишком короткий заголовок');
        });
    });

    describe('Размонтирование представления unmount', () => {
        it('уничтожает редактор Markdown и деактивирует слушатели событий', () => {
            container.innerHTML = view.html;
            view.mount(container);

            const form = container.querySelector('#create-event-form');
            const addBtn = container.querySelector('#add-media-btn');
            const editorContainer = container.querySelector('#event-description-editor-container');

            expect(editorContainer.querySelector('.markdown-editor')).not.toBeNull();

            view.unmount();

            expect(editorContainer.querySelector('.markdown-editor')).toBeNull();

            addBtn.click();
            expect(container.querySelectorAll('.form-media-item').length).toBe(0);

            createEvent.mockClear();
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            expect(createEvent).not.toHaveBeenCalled();
        });
    });
});
