"""
Корневой конфигурационный модуль фикстур pytest для проекта History Timeline.
Обеспечивает запуск ASGI-приложения через LifespanManager и изолирует тестовый
контур от внешней базы данных с помощью автоматической подмены get_db на AsyncMock.
"""

from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.core.database.database import get_db
from app.main import app


@pytest_asyncio.fixture
async def mock_db_session() -> AsyncMock:
    """
    Асинхронная фикстура для создания объекта-заглушки (mock) сессии базы данных.

    Имитирует методы SQLAlchemy AsyncSession, предотвращая выполнение
    реальных сетевых запросов к PostgreSQL 18.
    """
    # Инициализация базового асинхронного мок-объекта сессии
    session = AsyncMock()

    # Синхронный метод добавления сущности в Identity Map сессии переопределяется как MagicMock,
    # что исключает появление RuntimeWarning о невызванной корутине при session.add()
    session.add = MagicMock()

    # Явная настройка асинхронных методов сессии для корректной работы с await
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.close = AsyncMock()

    return session


@pytest_asyncio.fixture
async def async_client(
    mock_db_session: AsyncMock,
) -> AsyncGenerator[AsyncClient]:
    """
    Асинхронная фикстура тестового HTTP-клиента с управлением полным жизненным циклом.

    - Подменяет зависимость get_db генератором, возвращающим mock_db_session;
    - Запускает startup и shutdown хуки приложения через LifespanManager;
    - Создает изолированный транспорт ASGITransport без привязки к TCP-портам;
    - Гарантированно очищает app.dependency_overrides после завершения теста.
    """

    # Локальный генератор-заглушка для внедрения зависимости сессии базы данных
    async def _override_get_db() -> AsyncGenerator[AsyncMock]:
        yield mock_db_session

    # Регистрация подмены зависимости генератора сессии в FastAPI
    app.dependency_overrides[get_db] = _override_get_db

    try:
        # Управление жизненным циклом приложения (выполнение lifespan startup/shutdown)
        async with LifespanManager(app):
            # Создание асинхронного HTTP-клиента с виртуальным ASGI-транспортом
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                yield client
    finally:
        # Гарантированный сброс всех переопределений зависимостей для изоляции тестов
        app.dependency_overrides.clear()
