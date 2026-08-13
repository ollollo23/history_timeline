from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config.config import settings

# Создание асинхронного движка для подключения к PostgreSQL
engine = create_async_engine(
    url=settings.database_url,
    echo=False,
)

# Создание фабрики сессий, привязанной к асинхронному движку
async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,  # Отключение истечения срока действия объектов после коммита
)


# Базовый класс для всех ORM-моделей на основе современного стандарта SQLAlchemy 2.0+
class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Асинхронный генератор зависимостей для получения сессии базы данных.
    Выдает сессию эндпоинту, откатывает транзакцию при ошибке и закрывает сессию по завершении.
    """
    session: AsyncSession = async_session_maker()
    try:
        # Передача сессии вызывающему коду (эндпоинту)
        yield session
    except Exception:
        # Откат незавершенной транзакции в случае возникновения любой ошибки
        await session.rollback()
        # Проброс исключения дальше для обработки на уровне FastAPI
        raise
    finally:
        # Гарантированное закрытие сессии и возврат подключения в пул
        await session.close()