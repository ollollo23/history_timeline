from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database.database import get_db

# Инициализация основного приложения FastAPI с заданным заголовком
app = FastAPI(title="History Timeline API")

# Конфигурация CORS для разрешения запросов с любых источников (локальное тестирование)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check(session: AsyncSession = Depends(get_db)) -> dict:
    """
    Диагностический эндпоинт для проверки статуса приложения и соединения с базой данных.
    """
    try:
        # Выполнение легковесного запроса к PostgreSQL для валидации подключения
        await session.execute(text("SELECT 1"))
        return {"status": "ok", "db_connected": True}
    except Exception as e:
        # Перехват ошибки подключения и возврат корректного HTTP-ответа 500
        raise HTTPException(
            status_code=500,
            detail=f"Ошибка подключения к базе данных: {str(e)}"
        )