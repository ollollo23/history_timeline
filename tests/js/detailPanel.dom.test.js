// @vitest-environment happy-dom

/**
 * Модульные тесты компонента боковой панели деталей (detailPanel.js).
 * Выполняются в виртуальной среде happy-dom с использованием фреймворка Vitest.
 * Проверяют структуру DOM, безопасный рендеринг Markdown, плейсхолдер при пустом описании,
 * монтирование и строгую утилизацию медиа-плееров, список потомков и снятие обработчиков.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDetailPanel } from '../../frontend/js/components/detailPanel.js';

describe('Компонент панели деталей (detailPanel.js)', () => {
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

    describe('Монтирование и базовая структура', () => {
        it('создает скрытую панель со всеми обязательными структурными элементами', () => {
            const panel = createDetailPanel(container);
            const el = panel.element;

            expect(el.classList.contains('timeline-detail-panel')).toBe(true);
            expect(el.classList.contains('hidden')).toBe(true);
            expect(el.style.display).toBe('none');

            expect(el.querySelector('.timeline-detail-header')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-title')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-close-btn')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-content')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-dates')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-meta')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-description')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-media')).not.toBeNull();
            expect(el.querySelector('.timeline-detail-children')).not.toBeNull();

            panel.destroy();
        });
    });

    describe('Безопасный рендеринг Markdown', () => {
        it('рендерит форматированное описание и нейтрализует сырые HTML-теги', () => {
            const panel = createDetailPanel(container);
            const eventData = {
                id: 1,
                title: 'Бородинское сражение',
                start_date: -4964688000,
                end_date: null,
                category: 'politics',
                rank: 'day',
                description: 'Был **Важный текст** и [ссылка](https://example.com)\n\n<script>alert(1)</script>',
            };

            panel.render(eventData);

            const descEl = panel.element.querySelector('.timeline-detail-description');
            expect(descEl).not.toBeNull();

            const strongEl = descEl.querySelector('strong');
            expect(strongEl).not.toBeNull();
            expect(strongEl.textContent).toBe('Важный текст');

            const linkEl = descEl.querySelector('a');
            expect(linkEl).not.toBeNull();
            expect(linkEl.getAttribute('href')).toBe('https://example.com/');
            expect(linkEl.getAttribute('target')).toBe('_blank');
            expect(linkEl.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');

            expect(descEl.querySelector('script')).toBeNull();
            expect(descEl.textContent).toContain('<script>alert(1)</script>');

            panel.destroy();
        });
    });

    describe('Обработка пустого описания (fallback)', () => {
        it('выводит абзац с текстом Описание отсутствует. для null, пустой строки и пробелов', () => {
            const panel = createDetailPanel(container);
            const emptyVariants = [null, '', '   ', undefined];

            emptyVariants.forEach((descValue) => {
                panel.render({
                    id: 2,
                    title: 'Событие без описания',
                    start_date: 0,
                    category: 'culture',
                    description: descValue,
                });

                const descEl = panel.element.querySelector('.timeline-detail-description');
                expect(descEl).not.toBeNull();
                const emptyNotice = descEl.querySelector('.timeline-detail-description-empty');
                expect(emptyNotice).not.toBeNull();
                expect(emptyNotice.textContent).toBe('Описание отсутствует.');
            });

            panel.destroy();
        });
    });

    describe('Секция медиа-материалов', () => {
        it('отображает блок материалов при наличии media_payload и скрывает при его отсутствии', () => {
            const panel = createDetailPanel(container);

            const eventWithMedia = {
                id: 10,
                title: 'Событие с медиа',
                start_date: 1000,
                category: 'science',
                media_payload: [
                    {
                        media_type: 'video',
                        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        provider: 'youtube',
                        embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
                        title: 'Архивная кинохроника',
                    },
                    {
                        media_type: 'audio',
                        url: 'https://cdn.history.org/audio/lecture.mp3',
                        provider: 'direct',
                        title: 'Аудиозапись доклада',
                    },
                ],
            };

            panel.render(eventWithMedia);

            const mediaSection = panel.element.querySelector('.timeline-detail-media');
            expect(mediaSection).not.toBeNull();
            expect(mediaSection.style.display).toBe('block');

            const mediaCards = panel.element.querySelectorAll('.timeline-media-card');
            expect(mediaCards.length).toBe(2);

            panel.render({
                id: 11,
                title: 'Событие без медиа',
                start_date: 2000,
                category: 'economy',
                media_payload: [],
            });

            expect(mediaSection.style.display).toBe('none');
            expect(panel.element.querySelectorAll('.timeline-media-card').length).toBe(0);

            panel.destroy();
        });
    });

    describe('Сброс состояния и защита от утечек плееров', () => {
        it('гарантированно очищает активные фреймы при переключении события и при hide', () => {
            const panel = createDetailPanel(container);

            const eventWithVideo = {
                id: 20,
                title: 'Событие с плеером',
                start_date: 1000,
                category: 'culture',
                media_payload: [
                    {
                        media_type: 'video',
                        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        provider: 'youtube',
                        embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
                    },
                ],
            };

            panel.render(eventWithVideo);

            const playBtn = panel.element.querySelector('.timeline-media-play-btn');
            expect(playBtn).not.toBeNull();
            playBtn.click();

            const iframe = panel.element.querySelector('iframe');
            expect(iframe).not.toBeNull();
            const setAttrSpy = vi.spyOn(iframe, 'setAttribute');

            panel.render({
                id: 21,
                title: 'Следующее событие без медиа',
                start_date: 2000,
                category: 'science',
            });

            expect(setAttrSpy).toHaveBeenCalledWith('src', 'about:blank');
            expect(panel.element.querySelector('iframe')).toBeNull();

            panel.render(eventWithVideo);
            const playBtn2 = panel.element.querySelector('.timeline-media-play-btn');
            playBtn2.click();

            const iframe2 = panel.element.querySelector('iframe');
            const setAttrSpy2 = vi.spyOn(iframe2, 'setAttribute');

            panel.hide();

            expect(setAttrSpy2).toHaveBeenCalledWith('src', 'about:blank');
            expect(panel.element.querySelector('iframe')).toBeNull();
            expect(panel.element.style.display).toBe('none');

            panel.destroy();
        });
    });

    describe('Список дочерних событий и навигация', () => {
        it('отображает список потомков и вызывает onSelectChild при клике', () => {
            const onSelectChildMock = vi.fn();
            const panel = createDetailPanel(container, {
                onSelectChild: onSelectChildMock,
            });

            const parentEvent = {
                id: 100,
                title: 'Российская империя',
                start_date: -7889184000,
                end_date: -16725225600,
                category: 'politics',
            };

            const children = [
                {
                    id: 101,
                    title: 'Северная война',
                    start_date: -8520336000,
                    end_date: -7889184000,
                    category: 'politics',
                    calendar_system: 'gregorian_proleptic',
                },
                {
                    id: 102,
                    title: 'Основание Санкт-Петербурга',
                    start_date: -8413987200,
                    end_date: null,
                    category: 'culture',
                    calendar_system: 'gregorian_proleptic',
                },
            ];

            panel.render(parentEvent, children, null, 2);

            const childrenSection = panel.element.querySelector('.timeline-detail-children');
            expect(childrenSection.style.display).toBe('block');

            const childItems = panel.element.querySelectorAll('.timeline-detail-child-item');
            expect(childItems.length).toBe(2);

            const firstTitle = childItems[0].querySelector('.timeline-detail-child-title');
            expect(firstTitle.textContent).toBe('Северная война');

            const firstBtn = childItems[0].querySelector('.timeline-detail-child-btn');
            firstBtn.click();

            expect(onSelectChildMock).toHaveBeenCalledWith(children[0]);

            panel.destroy();
        });
    });

    describe('Утилизация destroy', () => {
        it('очищает ресурсы, удаляет узел из DOM и снимает слушатель клавиши Escape', () => {
            const onRequestCloseMock = vi.fn();
            const panel = createDetailPanel(container, {
                onRequestClose: onRequestCloseMock,
            });

            const eventData = {
                id: 200,
                title: 'Событие для утилизации',
                start_date: 0,
                category: 'science',
                media_payload: [
                    {
                        media_type: 'video',
                        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        provider: 'youtube',
                        embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
                    },
                ],
            };

            panel.render(eventData);
            expect(container.contains(panel.element)).toBe(true);

            panel.destroy();

            expect(container.contains(panel.element)).toBe(false);

            const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
            document.dispatchEvent(escapeEvent);

            expect(onRequestCloseMock).not.toHaveBeenCalled();
        });
    });
});
