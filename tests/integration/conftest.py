"""
Модуль фикстур интеграционного контура тестирования платформы History Timeline.
Обеспечивает автоматическое наложение миграций Alembic на тестовую базу данных PostgreSQL
и транзакционную изоляцию каждого тестового сценария с откатом изменений.
"""

from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    create_async_engine,
)

from app.core.config.config import settings
from app.core.database.database import get_db
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def apply_migrations() -> None:
    """
    Фикстура сессионного уровня для синхронизации схемы тестовой базы данных.
    Автоматически накатывает все миграции Alembic до 'head' перед запуском первого теста
    и откатывает структуру до 'base' после завершения всех интеграционных тестов.
    """
    # Определение пути к корневой директории проекта и конфигурационному файлу alembic.ini
    project_root = Path(__file__).resolve().parent.parent.parent
    alembic_ini_path = project_root / "alembic.ini"

    # Инициализация объекта конфигурации среды миграций Alembic
    alembic_cfg = Config(str(alembic_ini_path))

    # Переопределение целевого URL базы данных на тестовый контур
    alembic_cfg.set_main_option("sqlalchemy.url", str(settings.test_database_url))

    # Наложение всех актуальных миграций на изолированную тестовую базу данных
    command.upgrade(alembic_cfg, "head")

    # Передача управления процедуре исполнения тестов сессии
    yield

    # Полный откат схемы тестовой базы данных после завершения всех тестов
    command.downgrade(alembic_cfg, "base")


@pytest_asyncio.fixture(scope="function")
async def test_engine(apply_migrations: None) -> AsyncGenerator[AsyncEngine]:
    """
    Функциональная фикстура инициализации асинхронного движка SQLAlchemy для тестовой БД.
    Создает пул соединений к тестовой базе в рамках текущего цикла событий (event_loop)
    и утилизирует ресурсы по окончании каждого теста, устраняя ScopeMismatch.
    """
    # Создание движка для интеграционного контура с привязкой к текущему event_loop
    engine = create_async_engine(
        settings.test_database_url,
        echo=False,
    )

    yield engine

    # Гарантированное закрытие соединений движка после завершения теста
    await engine.dispose()


@pytest_asyncio.fixture(scope="function")
async def db_session(test_engine: AsyncEngine) -> AsyncGenerator[AsyncSession]:
    """
    Функциональная фикстура изолированной сессии базы данных для каждого теста.

    Механизм изоляции:
    1. Открывает прямое асинхронное соединение с тестовой базой данных;
    2. Начинает внешнюю транзакцию соединения;
    3. Привязывает AsyncSession к данному соединению;
    4. Оборачивает тест в блок try...finally;
    5. После завершения теста закрывает сессию, откатывает транзакцию только при
       ее активном состоянии (is_active) и закрывает соединение.
    """
    # Открытие прямого сетевого подключения к тестовой базе
    connection = await test_engine.connect()

    # Открытие внешней транзакции уровня соединения
    transaction = await connection.begin()

    # Создание сессии, привязанной к транзакционному контексту соединения
    session = AsyncSession(
        bind=connection,
        expire_on_commit=False,
    )

    try:
        yield session
    finally:
        # Гарантированное закрытие сессии SQLAlchemy
        await session.close()

        # Принудительный откат изменений только при активной транзакции
        if transaction.is_active:
            await transaction.rollback()

        # Гарантированное освобождение сетевого соединения
        await connection.close()


@pytest_asyncio.fixture(scope="function")
async def integration_client(
    db_session: AsyncSession,
) -> AsyncGenerator[AsyncClient]:
    """
    Функциональная фикстура интеграционного HTTP-клиента.
    Запускает ASGI-приложение через LifespanManager и подменяет зависимость get_db
    на транзакционную сессию db_session для работы с реальной базой данных PostgreSQL.
    """

    # Подмена фабрики сессий get_db на текущую изолированную сессию теста
    async def _override_get_db() -> AsyncGenerator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db

    try:
        # Инициализация контекста жизненного цикла ASGI-приложения
        async with LifespanManager(app):
            # Создание виртуального HTTP-клиента без открытия физического сетевого сокета
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                yield client
    finally:
        # Обязательный сброс переопределений зависимостей для предотвращения утечек состояния
        app.dependency_overrides.clear()
