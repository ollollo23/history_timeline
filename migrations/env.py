import asyncio
import os
import sys
from logging.config import fileConfig

# Добавление корневой директории проекта в sys.path для корректных импортов пакета app
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

# Импорт конфигурации приложения и декларативного базового класса с автогенерацией имен таблиц
from app.core.config.config import Settings
from app.models.base import Base

# Получение объекта конфигурации Alembic из файла .ini
config = context.config

# Настройка системного логирования на основе параметров из alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Связывание метаданных базового класса моделей для работы автогенерации миграций
target_metadata = Base.metadata

# Инициализация объекта настроек для получения динамического DSN подключения
settings = Settings()


def run_migrations_offline() -> None:
    """Запуск миграций в 'offline' режиме (генерация SQL-скрипта без прямого подключения)."""

    # Динамическая передача URL базы данных из Pydantic Settings
    config.set_main_option("sqlalchemy.url", str(settings.database_url))
    url = config.get_main_option("sqlalchemy.url")

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """Выполнение миграций в контексте активного соединения."""
    context.configure(connection=connection, target_metadata=target_metadata)

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Асинхронная инициализация движка и применение миграций к PostgreSQL."""

    # Динамическая передача URL подключения перед сборкой асинхронного движка
    config.set_main_option("sqlalchemy.url", str(settings.database_url))

    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Запуск миграций в 'online' режиме с асинхронным циклом событий."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()