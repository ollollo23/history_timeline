"""
Модуль конфигурации среды выполнения миграций базы данных Alembic.
Обеспечивает асинхронное подключение к PostgreSQL через asyncpg,
динамическое переопределение строки подключения для тестового контура
и расширенное сравнение схемы данных.
"""

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

# Импорт готового синглтона настроек окружения и метаданных ORM-моделей
from app.core.config.config import settings
from app.models import Base

# Получение объекта глобальной конфигурации Alembic из файла alembic.ini
config = context.config

# Настройка системного логирования на основе параметров из alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Связывание метаданных базового класса моделей для генерации ревизий
target_metadata = Base.metadata


def get_target_url() -> str:
    """
    Динамическое определение целевой строки подключения к базе данных.
    Считывает переопределенный через config.set_main_option параметр 'sqlalchemy.url'
    (используется фикстурами тестов для изоляции тестовой БД), а при его отсутствии
    возвращает основной database_url из синглтона настроек приложения.
    """
    custom_url = config.get_main_option("sqlalchemy.url")
    if custom_url and custom_url.strip():
        return custom_url.strip()
    return str(settings.database_url)


def run_migrations_offline() -> None:
    """
    Запуск миграций в автономном ('offline') режиме.
    Генерирует чистый SQL-скрипт без создания сетевого подключения к СУБД.
    Целевой DSN вычисляется динамически для поддержки оффлайн-генерации под разные БД.
    """
    target_url = get_target_url()

    context.configure(
        # Передача динамически вычисленной строки подключения
        url=target_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Включение детекции изменений типов данных колонок (например, Integer -> BIGINT)
        compare_type=True,
        # Включение детекции изменений серверных значений по умолчанию
        compare_server_default=True,
    )

    # Исполнение генерации инструкций в рамках изолированного транзакционного блока
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """
    Выполнение процесса миграций в синхронном контексте активного подключения.
    Вызывается асинхронным раннером через connection.run_sync.
    """
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Активация глубокой инспекции изменений типов данных
        compare_type=True,
        # Активация инспекции серверных выражений server_default
        compare_server_default=True,
    )

    # Фиксация изменений схемы в рамках транзакции базы данных
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """
    Асинхронная инициализация движка базы данных и исполнение миграций к PostgreSQL.
    Использует NullPool для предотвращения удержания неактивных соединений в пуле.
    """
    target_url = get_target_url()

    # Извлечение параметров секции [alembic] из конфигурационного ini-файла
    configuration = config.get_section(config.config_ini_section, {})

    # Явная перезапись целевого URL для гарантированной изоляции тестового контура
    configuration["sqlalchemy.url"] = target_url

    # Инициализация асинхронного движка без постоянного пула соединений
    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    # Открытие прямого асинхронного соединения и запуск синхронной процедуры миграций
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    # Гарантированное освобождение ресурсов движка при завершении процесса
    await connectable.dispose()


def run_migrations_online() -> None:
    """
    Запуск миграций в сетевом ('online') режиме.
    Инициализирует цикл событий asyncio для асинхронного выполнения DDL-команд.
    """
    asyncio.run(run_async_migrations())


# Определение режима запуска на основе флагов командной строки Alembic
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
