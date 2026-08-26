from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest_asyncio.fixture
async def mock_db_session() -> AsyncMock:
    """
    Асинхронная фикстура для создания объекта-заглушки (mock) сессии базы данных.
    Имитирует асинхронное поведение AsyncSession без выполнения реальных SQL-запросов.
    """
    # Инициализация асинхронного мок-объекта сессии
    session = AsyncMock()
    return session


@pytest_asyncio.fixture
async def async_client() -> AsyncGenerator[AsyncClient, None]:
    """
    Асинхронная фикстура для создания изолированного тестового HTTP-клиента.
    Обеспечивает маршрутизацию ASGI-запросов и гарантированную очистку переопределений зависимостей.
    """
    # Инициализация прямого транспорта ASGI без открытия реального сетевого сокета
    transport = ASGITransport(app=app)

    try:
        # Открытие асинхронного контекста HTTP-клиента
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
        ) as client:
            # Передача сконфигурированного клиента в тестовый сценарий
            yield client
    finally:
        # Гарантированный сброс всех мокированных зависимостей FastAPI после завершения каждого теста
        app.dependency_overrides.clear()