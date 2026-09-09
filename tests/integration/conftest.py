"""
Модуль фикстур интеграционного контура тестирования платформы History Timeline.
Обеспечивает автоматическое наложение миграций Alembic на тестовую базу данных PostgreSQL,
гарантированную превентивную очистку таблиц от внешних данных,
транзакционную изоляцию каждого тестового сценария и тестирование паттерна Unit of Work.
"""

import asyncio
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

import app.core.database.database as db_module
from app.core.config.config import settings
from app.core.database.database import get_db
from app.core.logger import logger
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def apply_migrations() -> None:
    """
    Фикстура сессионного уровня для синхронизации схемы тестовой базы данных.
    Автоматически накатывает все миграции Alembic до 'head' перед запуском первого теста,
    выполняет превентивную очистку таблиц от остаточных данных бенчмарков
    и откатывает структуру до 'base' после завершения всех интеграционных тестов.
    """
    # Определение пути к корневой директории проекта и конфигурационному файлу alembic.ini
    project_root = Path(__file__).resolve().parent.parent.parent
    alembic_ini_path = project_root / "alembic.ini"

    # Инициализация объекта конфигурации среды миграций Alembic
    alembic_cfg = Config(str(alembic_ini_path))

    # Безопасная передача целевого URL базы данных через словарь атрибутов конфигурации
    # Исключает ошибку InterpolationSyntaxError при наличии символа процента в пароле
    alembic_cfg.attributes["target_url"] = str(settings.test_database_url)

    # Наложение всех актуальных миграций на изолированную тестовую базу данных
    command.upgrade(alembic_cfg, "head")

    # Превентивная очистка таблицы events для изоляции тестов от данных предыдущих скриптов
    try:

        async def _truncate_events() -> None:
            clean_engine = create_async_engine(settings.test_database_url, echo=False)
            try:
                async with clean_engine.begin() as conn:
                    await conn.execute(text("TRUNCATE TABLE events RESTART IDENTITY CASCADE;"))
            finally:
                await clean_engine.dispose()

        try:
            asyncio.run(_truncate_events())
        except RuntimeError:
            # Запасное выполнение в отдельном потоке при наличии активного event loop
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                executor.submit(asyncio.run, _truncate_events()).result()

        logger.info("Превентивная очистка таблицы events успешно выполнена.")
    except Exception as exc:
        logger.warning(
            "Превентивная очистка таблицы events пропущена или завершилась с ошибкой: %s",
            exc,
        )

    try:
        # Передача управления процедуре исполнения тестов сессии
        yield
    finally:
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
async def integration_engine(test_engine: AsyncEngine) -> AsyncEngine:
    """
    Псевдоним фикстуры тестового движка для интеграционных сценариев.
    """
    return test_engine


@pytest_asyncio.fixture(scope="function")
async def db_connection(
    test_engine: AsyncEngine,
) -> AsyncGenerator[AsyncConnection]:
    """
    Функциональная фикстура прямого сетевого подключения к тестовой базе данных.
    """
    async with test_engine.connect() as connection:
        yield connection


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


@pytest_asyncio.fixture(scope="function")
async def uow_client(test_engine: AsyncEngine) -> AsyncGenerator[AsyncClient]:
    """
    Функциональная фикстура интеграционного HTTP-клиента для сквозного тестирования Unit of Work.

    В отличие от integration_client, фикстура не подменяет зависимость get_db через
    dependency_overrides, а временно перенаправляет глобальную фабрику async_session_maker
    на движок тестовой базы данных test_engine. Это обеспечивает исполнение реального тела
    генератора get_db с вызовами session.commit() и session.rollback().

    По окончании теста фабрика восстанавливается, а данные таблицы events очищаются через TRUNCATE.
    """
    # Сохранение исходной продуктовой фабрики сессий для последующего восстановления
    original_session_maker = db_module.async_session_maker

    # Создание временной фабрики сессий, привязанной к движку тестовой базы данных
    test_session_maker = async_sessionmaker(
        bind=test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    # Подмена глобальной фабрики в модуле app.core.database.database
    db_module.async_session_maker = test_session_maker

    # Гарантированное удаление переопределения get_db, если оно было установлено другими фикстурами
    app.dependency_overrides.pop(get_db, None)

    try:
        # Запуск ASGI-приложения в контексте Lifespan и создание асинхронного клиента
        async with LifespanManager(app):
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                yield client
    finally:
        # Восстановление оригинальной фабрики асинхронных сессий
        db_module.async_session_maker = original_session_maker

        # Очистка таблицы events со сбросом автоинкрементного первичного ключа
        async with test_engine.begin() as conn:
            await conn.execute(text("TRUNCATE TABLE events RESTART IDENTITY CASCADE;"))

        # Очистка словаря переопределений зависимостей
        app.dependency_overrides.clear()
