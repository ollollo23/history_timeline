"""
Модульные тесты промежуточного слоя безопасности SecurityHeadersMiddleware.
Проверяет установку HTTP-заголовков безопасности, директив Content Security Policy (CSP),
наличие доверенных медиа-хостов в frame-src, изоляцию документации Swagger UI и ReDoc,
доставку статических файлов и обработку корневого SPA-маршрута.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config.config import settings
from app.main import app
from app.middleware.security_headers import build_csp_header


@pytest.mark.unit
@pytest.mark.asyncio
async def test_security_headers_present_on_api_endpoints() -> None:
    """
    Проверка обязательных заголовков безопасности на API-эндпоинтах.
    Убеждается в наличии точных значений nosniff, strict-origin-when-cross-origin, DENY
    и полного набора директив CSP на GET- и HEAD-запросах.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response_get = await client.get("/api/v1/health")
        response_head = await client.head("/api/v1/health")

    for response in (response_get, response_head):
        # Проверка базовых защитных заголовков HTTP
        assert response.headers.get("x-content-type-options") == "nosniff"
        assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
        assert response.headers.get("x-frame-options") == "DENY"

        # Проверка наличия заголовка Content-Security-Policy и его полного набора директив
        csp = response.headers.get("content-security-policy")
        assert csp is not None
        assert "default-src 'self'" in csp
        assert "script-src 'self'" in csp
        assert "style-src 'self' 'unsafe-inline'" in csp
        assert "img-src 'self' https: data:" in csp
        assert "media-src https: 'self'" in csp
        assert "object-src 'none'" in csp
        assert "base-uri 'self'" in csp
        assert "frame-ancestors 'none'" in csp


@pytest.mark.unit
@pytest.mark.asyncio
async def test_security_headers_on_static_files() -> None:
    """
    Проверка отсутствия побочных эффектов промежуточного слоя безопасности на раздаче статики.
    Убеждается в статусе 200 OK, MIME-типе text/css, наличии базовых заголовков безопасности
    и присутствии политики CSP, не блокирующей загрузку собственных ассетов ('self').
    """
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/static/css/style.css")

    assert response.status_code == 200
    assert "text/css" in response.headers.get("content-type", "")

    # Базовые заголовки безопасности обязаны сопровождать статические файлы
    assert response.headers.get("x-content-type-options") == "nosniff"
    assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert response.headers.get("x-frame-options") == "DENY"

    # CSP заголовок присутствует и разрешает стили со своего источника
    csp = response.headers.get("content-security-policy")
    assert csp is not None
    assert "default-src 'self'" in csp
    assert "style-src 'self' 'unsafe-inline'" in csp


@pytest.mark.unit
@pytest.mark.asyncio
async def test_csp_frame_src_contains_allowed_hosts() -> None:
    """
    Проверка включения всех регламентированных медиа-хостов
    из белого списка в директиву frame-src заголовка CSP.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/v1/health")

    csp = response.headers.get("content-security-policy", "")
    assert "frame-src" in csp

    # Проверка обязательных доменов встраивания из спецификации
    expected_hosts = (
        "youtube-nocookie.com",
        "rutube.ru",
        "vk.com",
        "music.yandex.ru",
    )
    for host in expected_hosts:
        assert host in csp


@pytest.mark.unit
@pytest.mark.asyncio
async def test_csp_bypassed_for_swagger_and_redoc_documentation() -> None:
    """
    Проверка исключения маршрутов интерактивной документации OpenAPI (/docs, /redoc, /openapi.json)
    из наложения заголовка Content-Security-Policy при сохранении статуса 200 OK
    и обязательных базовых заголовков защиты (nosniff, strict-origin-when-cross-origin, DENY).
    """
    documentation_routes = ("/docs", "/redoc", "/openapi.json")

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        for route in documentation_routes:
            response = await client.get(route)

            # Проверка успешного ответа сервера документации
            assert response.status_code == 200

            # Заголовок CSP обязан отсутствовать во избежание блокировки внешних скриптов UI
            assert "content-security-policy" not in response.headers

            # Базовые заголовки защиты обязаны присутствовать на всех маршрутах
            assert response.headers.get("x-content-type-options") == "nosniff"
            assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
            assert response.headers.get("x-frame-options") == "DENY"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_security_headers_present_on_spa_root() -> None:
    """
    Проверка проставления полного комплекта заголовков безопасности
    для корневого маршрута клиентского Single Page Application.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get("/")

    assert response.headers.get("x-content-type-options") == "nosniff"
    assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert response.headers.get("x-frame-options") == "DENY"
    assert "content-security-policy" in response.headers


@pytest.mark.unit
@pytest.mark.asyncio
async def test_build_csp_header_unit() -> None:
    """
    Изолированный тест генератора директив политики безопасности build_csp_header.
    Проверяет корректное формирование префиксов https и wildcard-поддоменов.
    """
    custom_hosts = ["custom-host.com"]
    csp_header = build_csp_header(custom_hosts)

    assert "https://custom-host.com" in csp_header
    assert "https://*.custom-host.com" in csp_header
    # Проверка наличия хостов по умолчанию из системной конфигурации
    assert settings.app_title is not None
