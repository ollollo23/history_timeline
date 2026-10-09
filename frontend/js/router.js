/**
 * Модуль клиентской маршрутизации Single Page Application (SPA).
 * Отвечает за сопоставление путей URL с функциями представлений,
 * управление жизненным циклом компонентов (mount / unmount),
 * обновление активных ссылок меню и безопасное отображение аварийного экрана
 * без использования строковых инлайн-стилей согласно требованиям CSP.
 */

import { renderHome } from './views/home.js';
import { renderCreateEvent } from './views/create_event.js';
import { renderAdmin } from './views/admin.js';
import { fetchHealth } from './services/api.js';

/**
 * Таблица декларативной маршрутизации SPA-клиента.
 * Связывает относительные URL-пути с соответствующими функциями генерации представлений.
 */
const routes = {
    '/': renderHome,
    '/events/new': renderCreateEvent,
    '/admin': renderAdmin,
};

/**
 * Ссылка на функцию размонтирования (очистки ресурсов) текущего активного экрана.
 * Позволяет корректно снимать глобальные слушатели, отключать наблюдатели и останавливать таймеры при навигации.
 * @type {Function|null}
 */
let currentUnmount = null;

/**
 * Программный переход по указанному маршруту с безопасным перехватом асинхронных ошибок.
 * Обновляет адресную строку через HTML5 History API и запускает процесс смены экрана.
 *
 * @param {string} url Относительный путь клиентского маршрута.
 */
export function navigateTo(url) {
    // Добавление записи в историю браузера без перезагрузки документа
    history.pushState(null, null, url);

    // Асинхронный вызов диспетчера маршрутизации с логированием отклонённых промисов
    router().catch((error) => console.error('Сбой асинхронного перехода маршрута:', error));
}

/**
 * Главный асинхронный диспетчер маршрутизации с управлением полным жизненным циклом (mount / unmount).
 * Отвечает за рендеринг представлений, синхронизацию навигации, очистку ресурсов и вывод аварийного экрана при сбоях.
 */
export async function router() {
    // Гарантированная очистка ресурсов предыдущего представления перед монтированием нового экрана
    if (typeof currentUnmount === 'function') {
        try {
            currentUnmount();
        } catch (unmountError) {
            console.error('Сбой при размонтировании предыдущего представления:', unmountError);
        }
        currentUnmount = null;
    }

    try {
        // Извлечение текущего пути из объекта window.location
        const path = window.location.pathname;

        // Определение функции рендеринга из таблицы или fallback на главную страницу
        const viewFunction = routes[path] || routes['/'];

        // Вызов функции представления для получения конфигурации экрана или разметки
        const viewResult = viewFunction();

        // Поддержка расширенного контракта { html, mount, unmount } и обратная совместимость со строкой
        const htmlContent =
            typeof viewResult === 'object' && viewResult !== null
                ? viewResult.html
                : viewResult;

        // Поиск целевого контейнера для монтирования контента
        const appRoot = document.getElementById('app-root');
        if (appRoot) {
            // Вставка сгенерированной HTML-разметки представления в DOM
            appRoot.innerHTML = htmlContent;

            // Вызов функции монтирования представления при ее наличии
            if (typeof viewResult?.mount === 'function') {
                try {
                    viewResult.mount(appRoot);
                } catch (mountError) {
                    console.error('Сбой при монтировании представления:', mountError);
                }
            }

            // Сохранение функции размонтирования для последующей очистки перед сменой маршрута
            currentUnmount =
                typeof viewResult?.unmount === 'function' ? viewResult.unmount : null;
        }

        // Обновление стилей активного состояния для навигационных ссылок меню
        const navLinks = document.querySelectorAll('nav a[data-link]');
        navLinks.forEach((link) => {
            if (link.getAttribute('href') === path) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });

        // Специальная логика для домашней страницы: проверка статуса соединения с бэкендом
        if (path === '/') {
            const apiStatus = document.getElementById('api-status');
            if (apiStatus) {
                try {
                    // Асинхронный запрос к эндпоинту мониторинга состояния
                    const healthData = await fetchHealth();
                    // Динамическая подстановка полученной с сервера версии API
                    apiStatus.textContent = `Статус API: подключено (v${healthData.version || '1.0.0'})`;
                    apiStatus.style.color = '#10b981';
                } catch {
                    // Обработка отсутствия соединения с сервером с опциональным связыванием исключения
                    apiStatus.textContent = 'Статус API: ошибка соединения';
                    apiStatus.style.color = '#ef4444';
                }
            }
        }
    } catch (error) {
        // Фиксация непредвиденного сбоя рендеринга представления в консоли
        console.error('Критический сбой клиентского роутера:', error);

        // Поиск корневого контейнера для вывода визуального сообщения об ошибке
        const appRoot = document.getElementById('app-root');
        if (appRoot) {
            // Монтирование статического HTML-каркаса карточки ошибки с использованием семантических CSS-классов
            appRoot.innerHTML = `
                <section class="view-card router-error-card">
                    <h1 class="router-error-title">Ошибка отображения страницы</h1>
                    <p>Произошел сбой при монтировании представления интерфейса.</p>
                    <div id="router-error-details" class="router-error-details"></div>
                    <div class="router-error-link">
                        <a href="/" data-link class="nav-link">Вернуться на главную страницу</a>
                    </div>
                </section>
            `;

            // Безопасная запись текста ошибки через textContent для исключения HTML-инъекций
            const errorDetails = document.getElementById('router-error-details');
            if (errorDetails) {
                errorDetails.textContent = error.message || 'Неизвестная ошибка';
            }
        }
    }
}

/**
 * Безопасный обработчик навигации по истории браузера (событие popstate).
 * Защищает от необработанных отклонений промисов при нажатии кнопок «Назад» и «Вперед».
 */
export function handlePopState() {
    router().catch((error) => console.error('Сбой popstate навигации:', error));
}
