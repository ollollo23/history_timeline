from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock

from fastapi import status
from httpx import AsyncClient

from app.core.database.database import get_db
from app.main import app


async def test_docs_available(async_client: AsyncClient) -> None:
    """
    Проверка доступности интерактивной документации Swagger UI по корневому пути /docs.
    """
    # Выполнение асинхронного GET-запроса к эндпоинту документации OpenAPI
    response = await async_client.get("/docs")

    # Валидация успешного статуса ответа 200 OK
    assert response.status_code == status.HTTP_200_OK


async def test_health_endpoint_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка успешного ответа эндпоинта /api/v1/health при штатной работе базы данных.
    Использует локальный асинхронный генератор для подмены зависимости get_db.
    """
    # Настройка успешного выполнения асинхронного SQL-запроса
    mock_db_session.execute.return_value = None

    # Локальный асинхронный генератор для строгого соответствия контракту get_db
    async def override_get_db() -> AsyncGenerator[AsyncMock, None]:
        yield mock_db_session

    # Регистрация генератора в реестре переопределений зависимостей FastAPI
    app.dependency_overrides[get_db] = override_get_db

    # Отправка GET-запроса к диагностическому роуту
    response = await async_client.get("/api/v1/health")

    # Валидация HTTP-статуса и структуры возвращаемых данных схемы HealthResponse
    assert response.status_code == status.HTTP_200_OK

    data = response.json()
    assert data["status"] == "ok"
    assert data["db_connected"] is True
    assert data["version"] == "1.0.0"


async def test_health_endpoint_db_failure(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка обработки сбоя базы данных эндпоинтом /api/v1/health.
    Использует локальный асинхронный генератор и эмулирует исключение при запросе.
    """
    # Имитация исключения при выполнении запроса к БД
    mock_db_session.execute.side_effect = Exception("Сбой соединения")

    # Локальный асинхронный генератор для строгого соответствия контракту get_db
    async def override_get_db() -> AsyncGenerator[AsyncMock, None]:
        yield mock_db_session

    # Регистрация генератора в реестре переопределений зависимостей FastAPI
    app.dependency_overrides[get_db] = override_get_db

    # Отправка GET-запроса к диагностическому роуту
    response = await async_client.get("/api/v1/health")

    # Проверка возврата статус-кода 500 и текста ошибки в теле ответа
    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR

    data = response.json()
    assert (
        data["detail"]
        == "Ошибка подключения к базе данных: Сбой соединения"
    )