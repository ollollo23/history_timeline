"""
Модульные тесты проверки отдачи статических файлов и SPA-маршрутизации.
Валидирует отдачу index.html, стилей CSS, JavaScript-модулей интерфейса и таймлайна,
регрессионную целостность путей, контракт жизненного цикла представлений в роутере
и синхронизацию доменных перечислений между бэкендом и клиентскими модулями.
"""

import pytest
from fastapi import status
from httpx import AsyncClient

from app.core.enums import EventRank


@pytest.mark.unit
async def test_serve_index_html(async_client: AsyncClient) -> None:
    """
    Проверка успешной отдачи корневого HTML-файла SPA-приложения.
    Валидирует статус 200 OK, MIME-тип text/html и наличие точки монтирования app-root.
    """
    # Выполнение асинхронного GET-запроса к корню веб-приложения
    response = await async_client.get("/")

    # Проверка успешного HTTP-статуса ответа сервера
    assert response.status_code == status.HTTP_200_OK

    # Проверка корректности MIME-типа документа
    assert "text/html" in response.headers["content-type"]

    # Проверка присутствия базового DOM-контейнера для динамического рендеринга
    assert 'id="app-root"' in response.text


@pytest.mark.unit
async def test_serve_static_css(async_client: AsyncClient) -> None:
    """
    Проверка отдачи таблицы стилей из директории статики.
    Валидирует статус 200 OK и присутствие базовых CSS-переменных темы.
    """
    # Выполнение GET-запроса к файлу стилей
    response = await async_client.get("/static/css/style.css")

    # Проверка успешности ответа сервера
    assert response.status_code == status.HTTP_200_OK

    # Проверка наличия ключевых CSS-переменных темной темы интерфейса
    assert "--bg-primary" in response.text


@pytest.mark.unit
async def test_spa_client_routing_fallback(async_client: AsyncClient) -> None:
    """
    Проверка перехвата произвольных клиентских путей (SPA Fallback).
    Запрос к несуществующему на бэкенде маршруту должен возвращать базовый index.html со статусом 200 OK.
    """
    # Выполнение GET-запроса к клиентскому маршруту SPA
    response = await async_client.get("/events/new")

    # Проверка успешного статуса возврата каркаса вместо ошибки 404
    assert response.status_code == status.HTTP_200_OK

    # Проверка типа контента возвращенного HTML-документа
    assert "text/html" in response.headers["content-type"]

    # Проверка отдачи полноценного HTML-каркаса с точкой монтирования
    assert 'id="app-root"' in response.text


@pytest.mark.unit
@pytest.mark.parametrize(
    "path",
    [
        "/static/js/app.js",
        "/static/js/router.js",
        "/static/js/services/api.js",
        "/static/js/views/home.js",
        "/static/js/views/create_event.js",
        "/static/js/views/admin.js",
    ],
)
async def test_serve_static_js(async_client: AsyncClient, path: str) -> None:
    """
    Параметризованная проверка успешной отдачи JavaScript-модулей приложения.
    Валидирует статус 200 OK и MIME-тип javascript в заголовке Content-Type.
    """
    # Выполнение асинхронного GET-запроса к статическому JavaScript-файлу
    response = await async_client.get(path)

    # Проверка успешности отдачи статического ресурса
    assert response.status_code == status.HTTP_200_OK

    # Проверка наличия подстроки javascript в заголовке Content-Type в нижнем регистре
    assert "javascript" in response.headers["content-type"].lower()


@pytest.mark.unit
@pytest.mark.parametrize(
    "path",
    [
        "/static/js/timeline/constants.js",
        "/static/js/timeline/calendar.js",
        "/static/js/timeline/scale.js",
        "/static/js/timeline/viewport.js",
        "/static/js/timeline/ticks.js",
        "/static/js/timeline/format.js",
        "/static/js/timeline/renderer.js",
        "/static/js/timeline/controller.js",
    ],
)
async def test_serve_timeline_static_js(async_client: AsyncClient, path: str) -> None:
    """
    Параметризованная проверка отдачи всех восьми JavaScript-модулей ядра таймлайна.
    Контролирует сетевую доступность клиентских файлов хронологической шкалы,
    математических проекций, календарных преобразований и рендеринга.
    Валидирует статус 200 OK и наличие подстроки javascript в заголовке Content-Type.
    """
    # Выполнение асинхронного GET-запроса к модулю ядра таймлайна
    response = await async_client.get(path)

    # Проверка успешного HTTP-статуса ответа сервера
    assert response.status_code == status.HTTP_200_OK

    # Проверка корректности MIME-типа ответа (application/javascript или text/javascript)
    assert "javascript" in response.headers["content-type"].lower()


@pytest.mark.unit
@pytest.mark.parametrize(
    "path",
    [
        "/static/js/timeline/rankMapping.js",
        "/static/js/timeline/loadWindow.js",
        "/static/js/timeline/markers.js",
        "/static/js/timeline/eventStore.js",
    ],
)
async def test_serve_substep_2b_timeline_modules(
    async_client: AsyncClient,
    path: str,
) -> None:
    """
    Параметризованная проверка отдачи четырех новых JavaScript-модулей подшага 2б.
    Валидирует доставку модулей маппинга рангов, окна упреждающей загрузки,
    геометрии маркеров и хранилища событий со статусом 200 OK и корректным MIME-типом.
    """
    # Выполнение GET-запроса к новому модулю каталога timeline
    response = await async_client.get(path)

    # Проверка успешности HTTP-ответа сервера
    assert response.status_code == status.HTTP_200_OK

    # Проверка наличия признака JavaScript в заголовке Content-Type
    assert "javascript" in response.headers["content-type"].lower()


@pytest.mark.unit
async def test_rank_mapping_enum_synchronization(
    async_client: AsyncClient,
) -> None:
    """
    Проверка кросс-контурной синхронизации списка рангов модуля rankMapping.js
    с серверным перечислением EventRank (подзадача 12.6).
    Гарантирует идентичность состава рангов и монотонное соответствие порядка глубины depth_level().
    """
    # Получение текстового содержимого клиентского модуля rankMapping.js
    response = await async_client.get("/static/js/timeline/rankMapping.js")
    assert response.status_code == status.HTTP_200_OK

    # Формирование эталонного списка рангов на основе серверного перечисления EventRank
    expected_ranks = [rank.value for rank in sorted(EventRank, key=lambda r: r.depth_level())]

    # Валидация полноты серверного перечисления (ровно 8 уровней детализации)
    assert len(expected_ranks) == 8

    # Проверка монотонного возрастания позиций рангов в отдаваемом тексте модуля
    last_index = -1
    for rank_value in expected_ranks:
        pos = response.text.find(rank_value)
        # Убеждаемся, что каждый серверный ранг присутствует в исходном коде клиента
        assert pos != -1, f"Ранг '{rank_value}' не найден в коде rankMapping.js"
        # Убеждаемся, что текущий ранг расположен строго позже предыдущего (порядок сохранен)
        assert pos > last_index, f"Ранг '{rank_value}' нарушает порядок иерархии в rankMapping.js"
        last_index = pos


@pytest.mark.unit
async def test_router_js_content_integrity(async_client: AsyncClient) -> None:
    """
    Регрессионная проверка целостности содержимого клиентского маршрутизатора router.js.
    Контролирует корректность путей импорта представлений, а также наличие архитектурного
    контракта жизненного цикла экранов (переменной currentUnmount, вызова функции очистки
    currentUnmount(), изолированного блока перехвата unmountError и точки монтирования mount).
    Это исключает утечки памяти при переключении экранов с Canvas-анимациями и слушателями событий.
    """
    # Запрос содержимого модуля маршрутизации
    response = await async_client.get("/static/js/router.js")

    # Проверка успешной отдачи файла роутера
    assert response.status_code == status.HTTP_200_OK

    # Контроль отсутствия опечатки импорта в пути файла
    assert "/views/reate_event.js" not in response.text

    # Контроль обязательного наличия легитимного пути к представлению создания события
    assert "/views/create_event.js" in response.text

    # Контроль объявления переменной отслеживания активной функции очистки ресурсов
    assert "currentUnmount" in response.text

    # Контроль гарантированного вызова функции размонтирования перед сменой экрана
    assert "currentUnmount()" in response.text

    # Контроль наличия изолированного перехвата исключений очистки памяти
    assert "unmountError" in response.text

    # Контроль вызова метода монтирования нового экрана
    assert "mount(" in response.text


@pytest.mark.unit
@pytest.mark.parametrize(
    "path, expected_status, expected_body_token",
    [
        ("/api-guide", status.HTTP_200_OK, 'id="app-root"'),
        ("/documentation", status.HTTP_200_OK, 'id="app-root"'),
        (
            "/api/v1/unknown",
            status.HTTP_404_NOT_FOUND,
            "Эндпоинт API не найден.",
        ),
        (
            "/static/missing.js",
            status.HTTP_404_NOT_FOUND,
            "Not Found",
        ),
    ],
)
async def test_route_segment_isolation_spa_and_service_paths(
    async_client: AsyncClient,
    path: str,
    expected_status: int,
    expected_body_token: str,
) -> None:
    """
    Параметризованная проверка изоляции сегментов пути клиентского SPA-роутера.
    Подтверждает отдачу HTML-каркаса для клиентских маршрутов со служебными
    подстроками в названии (/api-guide, /documentation) и возврат JSON 404 для
    служебных пространств. Смонтированное приложение StaticFiles возвращает
    стандартное сообщение Starlette 'Not Found', тогда как роутер serve_spa
    изолирует эндпоинты API с кастомным сообщением 'Эндпоинт API не найден.'.
    """
    # Выполнение асинхронного GET-запроса по проверяемому маршруту
    response = await async_client.get(path)

    # Проверка соответствия статус-кода ожидаемому значению
    assert response.status_code == expected_status

    # Валидация успешной отдачи клиентского HTML-каркаса
    if expected_status == status.HTTP_200_OK:
        assert "text/html" in response.headers["content-type"]
        assert expected_body_token in response.text
    # Валидация изолированного возврата ошибки для служебных маршрутов
    else:
        assert "application/json" in response.headers.get("content-type", "")
        assert response.json() == {"detail": expected_body_token}
