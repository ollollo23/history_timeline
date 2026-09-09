"""
Модульные тесты проверки отдачи статических файлов и SPA-маршрутизации.
Валидирует отдачу index.html, стилей CSS, JavaScript-модулей интерфейса
и регрессионную целостность путей клиентского роутера.
"""

import pytest
from fastapi import status
from httpx import AsyncClient


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
async def test_router_js_content_integrity(async_client: AsyncClient) -> None:
    """
    Регрессионная проверка целостности содержимого клиентского маршрутизатора router.js.
    Проверяет статус 200 OK, отсутствие опечатки в пути файла и наличие корректного пути импорта.
    """
    # Запрос содержимого модуля маршрутизации
    response = await async_client.get("/static/js/router.js")

    # Проверка успешной отдачи файла роутера
    assert response.status_code == status.HTTP_200_OK

    # Контроль отсутствия опечатки импорта в пути файла
    assert "/views/reate_event.js" not in response.text

    # Контроль обязательного наличия легитимного пути к представлению создания события
    assert "/views/create_event.js" in response.text


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
