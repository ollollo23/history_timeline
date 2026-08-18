from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config.python_spec import verify_python_environment


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Валидация соответствия версии Python 3.14.7 при старте приложения
    verify_python_environment()
    # Передача управления работающему приложению
    yield
    # Логика корректного освобождения ресурсов при остановке сервера (при необходимости)


# Инициализация основного приложения FastAPI с подключением менеджера жизненного цикла
app = FastAPI(
    title="History Timeline API",
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