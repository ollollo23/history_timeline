"""
Модульные тесты системной диагностики и проверки спецификации OpenAPI.
Тестирует эндпоинты /api/v1/health и /docs с эмуляцией состояний базы данных
через AsyncMock без запуска физического экземпляра PostgreSQL.
"""

from unittest.mock import AsyncMock

import pytest
from fastapi import status
from httpx import AsyncClient

from app.core.config.config import settings


@pytest.mark.unit
async def test_docs_available(async_client: AsyncClient) -> None:
    """
    Проверка доступности интерактивной документации Swagger UI по пути /docs.
    Валидирует успешную генерацию схемы OpenAPI и возврат HTTP 200 OK.
    """
    # Выполнение асинхронного GET-запроса к Swagger UI
    response = await async_client.get("/docs")

    # Проверка успешного HTTP-статуса
    assert response.status_code == status.HTTP_200_OK


@pytest.mark.unit
async def test_health_endpoint_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка штатного ответа эндпоинта /api/v1/health при доступной базе данных.
    Ожидается статус 200 OK и тело схемы HealthResponse со статусом 'ok'.
    """
    # Настройка успешного ответа контрольного запроса SELECT 1 в мок-сессии
    mock_db_session.execute.return_value = None

    # Выполнение GET-запроса к диагностическому роуту
    response = await async_client.get("/api/v1/health")

    # Валидация успешного статуса ответа
    assert response.status_code == status.HTTP_200_OK

    # Проверка соответствия полей ответа контракту схемы HealthResponse
    data = response.json()
    assert data["status"] == "ok"
    assert data["db_connected"] is True
    assert data["version"] == settings.app_version


@pytest.mark.unit
async def test_health_endpoint_db_failure(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка деградации сервиса при аппаратном сбое подключения к PostgreSQL.
    Ожидается статус 503 Service Unavailable, флаг db_connected=False
    и отсутствие раскрытия технических подробностей системного исключения.
    """
    # Эмуляция сбоя сетевого сокета при выполнении запроса к PostgreSQL
    mock_db_session.execute.side_effect = ConnectionRefusedError("Сбой подключения к базе данных")

    # Выполнение GET-запроса к диагностическому роуту
    response = await async_client.get("/api/v1/health")

    # Валидация регламентированного статуса деградации 503 Service Unavailable
    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE

    # Проверка структуры тела ответа и сокрытия системного трейсбека
    data = response.json()
    assert data["status"] == "degraded"
    assert data["db_connected"] is False
    assert data["version"] == settings.app_version
    assert "detail" not in data
