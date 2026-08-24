from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config.config import settings

# Создание асинхронного движка для подключения к PostgreSQL через драйвер asyncpg
engine = create_async_engine(
    url=settings.database_url,
    echo=False,
)

# Фабрика асинхронных сессий с отключенным сбросом состояния объектов после фиксации транзакции
async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Асинхронный генератор зависимостей FastAPI для внедрения сессии базы данных.
    Предоставляет изолированную сессию, выполняет откат при исключении и гарантированно закрывает соединение.
    """
    session: AsyncSession = async_session_maker()
    try:
        # Передача сессии вызывающему эндпоинту или сервисному слою
        yield session
    except Exception:
        # Автоматический откат незавершенной транзакции при возникновении сбоя
        await session.rollback()
        # Повторный выброс исключения для дальнейшей обработки на уровне FastAPI
        raise
    finally:
        # Гарантированное закрытие сессии и возврат соединения в пул asyncpg
        await session.close()