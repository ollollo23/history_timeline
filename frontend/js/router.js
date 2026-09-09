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
 * Главный асинхронный диспетчер маршрутизации.
 * Отвечает за рендеринг представлений, синхронизацию навигации и вывод аварийного экрана при сбоях.
 */
export async function router() {
    try {
        // Извлечение текущего пути из объекта window.location
        const path = window.location.pathname;

        // Определение функции рендеринга из таблицы или fallback на главную страницу
        const viewFunction = routes[path] || routes['/'];

        // Поиск целевого контейнера для монтирования контента
        const appRoot = document.getElementById('app-root');
        if (appRoot) {
            // Вставка сгенерированной HTML-разметки представления в DOM
            appRoot.innerHTML = viewFunction();
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
                } catch (healthError) {
                    // Обработка отсутствия соединения с сервером
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
            // Монтирование статического HTML-каркаса карточки ошибки без небезопасной интерполяции
            appRoot.innerHTML = `
                <section class="view-card" style="border-color: #ef4444;">
                    <h1 style="color: #ef4444;">Ошибка отображения страницы</h1>
                    <p>Произошел сбой при монтировании представления интерфейса.</p>
                    <div id="router-error-details" style="margin-top: 1rem; padding: 1rem; background: var(--bg-accent); border-radius: 6px; font-family: monospace; font-size: 0.9rem; color: #f87171; word-break: break-word;"></div>
                    <div style="margin-top: 1.5rem;">
                        <a href="/" data-link class="nav-link" style="color: var(--color-accent); text-decoration: underline;">Вернуться на главную страницу</a>
                    </div>
                </section>
            `;

            // Безопасная запись текста ошибки через textContent для экранирования HTML/XSS
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
