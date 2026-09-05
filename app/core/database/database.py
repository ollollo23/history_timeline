"""
Модуль асинхронного подключения к базе данных PostgreSQL через SQLAlchemy и asyncpg.
Настраивает параметры пула соединений и предоставляет генератор сессий с семантикой Unit of Work.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config.config import settings

# Инициализация асинхронного движка SQLAlchemy с расширенной конфигурацией пула соединений asyncpg
engine = create_async_engine(
    url=settings.database_url,
    # Проверка активности соединения (ping) перед выдачей из пула для защиты от разорванных сокетов
    pool_pre_ping=True,
    # Базовое количество постоянно удерживаемых открытых соединений в пуле
    pool_size=settings.db_pool_size,
    # Предельное количество дополнительных соединений, создаваемых сверх pool_size при всплесках нагрузки
    max_overflow=settings.db_max_overflow,
    # Максимальный срок жизни соединения в секундах до принудительной утилизации и пересоздания
    pool_recycle=settings.db_pool_recycle,
    # Трассировка сгенерированных SQL-запросов в стандартный вывод (управляется переменной DB_ECHO)
    echo=settings.db_echo,
)

# Фабрика асинхронных сессий с отключенным сбросом состояния объектов после фиксации транзакции
async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession]:
    """
    Асинхронный генератор зависимостей FastAPI для управления единицей работы (Unit of Work).

    Жизненный цикл транзакции:
    1. Инициализация сессии: создание экземпляра AsyncSession через фабрику async_session_maker.
    2. Выполнение логики запроса: передача сессии в контекст эндпоинта через yield session.
    3. Автоматическая фиксация: при успешном завершении эндпоинта без исключений вызывается await session.commit().
    4. Автоматический откат: при возникновении любого системного или доменного сбоя вызывается await session.rollback().
    5. Гарантированное закрытие: в блоке finally вызывается await session.close(), возвращая сокет в пул asyncpg.
    """
    session: AsyncSession = async_session_maker()
    try:
        # Передача сессии в вызывающий эндпоинт или сервисный слой
        yield session
        # Автоматическая фиксация транзакции при успешном завершении обработки запроса
        await session.commit()
    except Exception:
        # Автоматический откат всех незафиксированных изменений при сбое
        await session.rollback()
        # Повторный выброс исключения для передачи централизованным обработчикам FastAPI
        raise
    finally:
        # Гарантированное закрытие сессии и возврат сетевого соединения в пул
        await session.close()


# Явный экспорт публичных компонентов модуля базы данных в алфавитном порядке
__all__: list[str] = [
    "async_session_maker",
    "engine",
    "get_db",
]
