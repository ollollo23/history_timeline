"""
Модульные тесты системной диагностики и проверки спецификации OpenAPI.
Тестирует эндпоинты /api/v1/health и /docs с эмуляцией состояний базы данных
через MagicMock и AsyncEngine без запуска физического экземпляра PostgreSQL.
"""

from unittest.mock import MagicMock

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
    mock_db_engine: MagicMock,
) -> None:
    """
    Проверка штатного ответа эндпоинта /api/v1/health при доступной базе данных.
    Ожидается статус 200 OK и тело схемы HealthResponse со статусом 'ok'.
    """
    # Настройка успешного исполнения запроса SELECT 1 через мок-соединение
    mock_db_engine._mock_connection.execute.return_value = None

    # Выполнение GET-запроса к диагностическому маршруту
    response = await async_client.get("/api/v1/health")

    # Валидация успешного HTTP-статуса ответа
    assert response.status_code == status.HTTP_200_OK

    # Проверка соответствия полей ответа контракту схемы HealthResponse
    data = response.json()
    assert data["status"] == "ok"
    assert data["db_connected"] is True
    assert data["version"] == settings.app_version


@pytest.mark.unit
async def test_health_endpoint_connection_failure(
    async_client: AsyncClient,
    mock_db_engine: MagicMock,
) -> None:
    """
    Проверка деградации сервиса при сбое открытия сетевого подключения к СУБД.
    Эмулирует отказ входа в асинхронный контекстный менеджер engine.connect().
    Ожидается статус 503 Service Unavailable, флаг db_connected=False и отсутствие detail.
    """
    # Эмуляция ошибки соединения на этапе открытия сокета к PostgreSQL
    mock_db_engine.connect.return_value.__aenter__.side_effect = ConnectionRefusedError(
        "Сетевой порт PostgreSQL недоступен"
    )

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


@pytest.mark.unit
async def test_health_endpoint_query_execution_failure(
    async_client: AsyncClient,
    mock_db_engine: MagicMock,
) -> None:
    """
    Проверка деградации сервиса при разрыве сокета во время выполнения запроса.
    Эмулирует успешное открытие соединения, но отказ при вызове execute(text('SELECT 1')).
    Ожидается статус 503 Service Unavailable, флаг db_connected=False и отсутствие detail.
    """
    # Обеспечение успешного открытия соединения в контекстном менеджере
    mock_db_engine.connect.return_value.__aenter__.side_effect = None

    # Эмуляция сетевого сбоя при непосредственном исполнении контрольного запроса
    mock_db_engine._mock_connection.execute.side_effect = ConnectionResetError(
        "Разрыв сокета при выполнении запроса"
    )

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
