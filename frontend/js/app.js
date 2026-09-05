import { router, navigateTo, handlePopState } from './router.js';

/**
 * Главная точка входа клиентской части приложения History Timeline.
 * Настраивает глобальное делегирование навигации и запускает первичный рендеринг.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Регистрация глобального перехватчика кликов на теле документа для SPA-навигации
    document.body.addEventListener('click', (event) => {
        // Поиск ближайшего родительского элемента ссылки с маркером data-link
        const targetLink = event.target.closest('a[data-link]');

        // Отмена стандартного браузерного перехода по ссылке и запуск внутреннего роутинга
        if (targetLink) {
            event.preventDefault();

            // Получение относительного пути перехода
            const targetPath = targetLink.getAttribute('href');

            // Программное изменение URL в адресной строке и монтирование целевого View
            if (targetPath) {
                navigateTo(targetPath);
            }
        }
    });

    // Регистрация безопасной функции-обертки для обработки событий истории браузера («Назад» / «Вперед»)
    // Предотвращает появление unhandledrejection при асинхронных сбоях роутера
    window.addEventListener('popstate', handlePopState);

    // Первичная инициализация и отрисовка представления для начального URL адреса
    router();
});