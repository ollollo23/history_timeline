from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config.config import settings
from app.core.config.python_spec import verify_python_environment
from app.core.logger import logger, setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Первичная инициализация подсистемы централизованного логирования
    setup_logging()

    # Валидация версии Python 3.14.7 перед выполнением основного рантайма
    verify_python_environment()

    # Фиксация события старта сервиса с параметрами конфигурации
    logger.info(
        "Запуск сервиса %s v%s на Python 3.14...",
        settings.app_title,
        settings.app_version,
    )

    # Передача управления работающему экземпляру приложения FastAPI
    yield

    # Фиксация события корректной остановки сервиса при завершении процесса
    logger.info("Сервис %s успешно остановлен.", settings.app_title)


# Инициализация основного приложения FastAPI с подключением менеджера жизненного цикла
app = FastAPI(
    title=settings.app_title,
    version=settings.app_version,
    lifespan=lifespan,
)

# Конфигурация CORS для разрешения кросс-доменных запросов на этапе локальной разработки
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Подключение центрального маршрутизатора API с версионированием v1
app.include_router(
    api_router,
    prefix="/api/v1",
)