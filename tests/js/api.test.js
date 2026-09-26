/**
 * Модульные тесты клиентского сетевого сервиса api.js.
 * Проверяет формирование URL-маршрутов, разбор постраничных ответов дочерних событий,
 * сценарии прерывания запросов внешними сигналами и таймаутами,
 * а также обработку ошибок REST API через parseApiError.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    fetchEventChildren,
    fetchEventsInRange,
    fetchEventById,
    createRequestSignal,
    API_REQUEST_TIMEOUT_MS,
} from '../../frontend/js/services/api.js';

describe('Клиентский сетевой сервис (api.js)', () => {
    // Очистка всех глобальных подмен и моков после каждого сценария
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('экспортирует стандартное значение таймаута запросов 15 секунд', () => {
        expect(API_REQUEST_TIMEOUT_MS).toBe(15000);
    });

    it('корректно формирует URL и query-параметры при выборке дочерних событий', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ items: [], total: 0, skip: 10, limit: 25 }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await fetchEventChildren(42, 10, 25);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/v1/events/42/children?skip=10&limit=25',
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            })
        );
    });

    it('возвращает структурированный объект страницы дочерних событий', async () => {
        const mockPage = {
            items: [
                { id: 101, title: 'Потомок 1' },
                { id: 102, title: 'Потомок 2' },
            ],
            total: 2,
            skip: 0,
            limit: 100,
        };

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockPage,
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await fetchEventChildren(1);

        expect(result).toEqual(mockPage);
        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.skip).toBe(0);
        expect(result.limit).toBe(100);
    });

    it('корректно обрабатывает отмену запроса внешним сигналом (AbortError)', async () => {
        const controller = new AbortController();
        controller.abort();

        const mockFetch = vi.fn().mockImplementation((_url, options) => {
            if (options?.signal?.aborted) {
                return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
            }
            return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                });
            });
        });
        vi.stubGlobal('fetch', mockFetch);

        await expect(
            fetchEventChildren(1, 0, 100, controller.signal)
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('прерывает запрос по таймауту с ошибкой TimeoutError', async () => {
        // Создание сигнала с коротким таймаутом 15 мс для тестирования на реальных таймерах
        const shortTimeoutSignal = createRequestSignal(null, 15);
        expect(shortTimeoutSignal).toBeInstanceOf(AbortSignal);

        const mockFetch = vi.fn().mockImplementation((_url, options) => {
            return new Promise((_resolve, reject) => {
                if (options?.signal?.aborted) {
                    reject(options.signal.reason);
                    return;
                }
                options?.signal?.addEventListener('abort', () => {
                    reject(options.signal.reason);
                });
            });
        });
        vi.stubGlobal('fetch', mockFetch);

        const requestPromise = fetchEventById(99, shortTimeoutSignal);

        await expect(requestPromise).rejects.toSatisfy((err) => {
            return (
                err?.name === 'TimeoutError' ||
                err?.reason?.name === 'TimeoutError' ||
                String(err).includes('TimeoutError')
            );
        });
    });

    describe('обработка и разбор ошибок API через parseApiError', () => {
        it('извлекает строковое сообщение detail при ошибке HTTP 404', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                json: async () => ({ detail: 'Историческое событие не найдено' }),
            });
            vi.stubGlobal('fetch', mockFetch);

            await expect(fetchEventById(999)).rejects.toThrow('Историческое событие не найдено');
        });

        it('собирает массив сообщений валидации Pydantic при ошибке HTTP 422', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 422,
                json: async () => ({
                    detail: [
                        { msg: 'Field required', loc: ['body', 'title'] },
                        { msg: 'Input should be greater than 0', loc: ['query', 'limit'] },
                    ],
                }),
            });
            vi.stubGlobal('fetch', mockFetch);

            await expect(
                fetchEventsInRange(0, 1000)
            ).rejects.toThrow('Field required, Input should be greater than 0');
        });

        it('возвращает fallbackMessage по умолчанию при невалидном ответе JSON', async () => {
            const mockFetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 502,
                json: async () => {
                    throw new Error('Unexpected token < in JSON at position 0');
                },
            });
            vi.stubGlobal('fetch', mockFetch);

            await expect(fetchEventById(999)).rejects.toThrow('Событие с id=999 не найдено');
        });
    });
});
