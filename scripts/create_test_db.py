"""
Скрипт автоматической и идемпотентной инициализации тестовой базы данных PostgreSQL.
Подключается к служебной базе данных postgres в режиме AUTOCOMMIT и выполняет создание
целевой тестовой базы данных, если она еще не создана.
"""

import asyncio
import os
import sys

# Добавление корневой директории проекта в sys.path для корректного импорта пакета app
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import text
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config.config import settings


async def main() -> None:
    """
    Основная асинхронная процедура проверки и создания тестовой базы данных.
    Выполняет подключение к сервисной БД postgres и управляет жизненным циклом движка.
    """
    try:
        # Разбор базового URL подключения из синглтона конфигурации приложения
        base_url = make_url(str(settings.database_url))

        # Формирование URL подключения к служебной базе данных postgres с сохранением хоста, порта и учетных данных
        admin_url = base_url.set(database="postgres")

        # Определение имени тестовой базы и пользователя-владельца
        test_db_name = settings.test_db_name
        db_user = admin_url.username or "postgres"

        # Инициализация асинхронного движка в режиме AUTOCOMMIT для возможности исполнения DDL-команд
        engine = create_async_engine(
            admin_url,
            isolation_level="AUTOCOMMIT",
        )

        try:
            async with engine.connect() as connection:
                # Проверка фактического существования тестовой базы в системном каталоге PostgreSQL
                check_query = text("SELECT 1 FROM pg_database WHERE datname = :dbname")
                result = await connection.execute(check_query, {"dbname": test_db_name})
                database_exists = result.scalar_one_or_none() is not None

                if not database_exists:
                    # Исполнение команды создания базы данных с явным указанием владельца и кодировки UTF8
                    create_query = text(
                        f'CREATE DATABASE "{test_db_name}" OWNER "{db_user}" ENCODING \'UTF8\''
                    )
                    await connection.execute(create_query)
                    sys.stdout.write(f"Тестовая база данных '{test_db_name}' успешно создана.\n")
                else:
                    sys.stdout.write(f"Тестовая база данных '{test_db_name}' уже существует.\n")
        finally:
            # Гарантированное освобождение сетевых сокетов и пула соединений служебного движка
            await engine.dispose()

    except Exception as error:
        # Фиксация ошибки подключения или выполнения DDL в потоке stderr с кодом аварийного завершения
        sys.stderr.write(f"Сбой при инициализации тестовой базы данных: {error}\n")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
