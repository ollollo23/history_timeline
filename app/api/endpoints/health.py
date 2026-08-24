from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database.database import get_db
from app.core.logger import logger
from app.schemas.health import HealthResponse

# Инициализация роутера с системным тегом для группировки в документации OpenAPI
router = APIRouter(prefix="", tags=["System"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Проверка статуса сервиса и подключения к БД",
)
async def health_check(
    session: AsyncSession = Depends(get_db),
) -> HealthResponse:
    """
    Диагностический эндпоинт для проверки статуса приложения и валидации соединения с PostgreSQL.
    """
    try:
        # Выполнение легковесного тестового запроса к PostgreSQL для проверки пула соединений
        await session.execute(text("SELECT 1"))

        # Возврат типизированного объекта HealthResponse в строгом соответствии со схемой
        return HealthResponse(
            status="ok",
            db_connected=True,
            version="1.0.0",
        )
    except Exception as error:
        # Фиксация полного трейса ошибки соединения в подсистеме централизованного логирования
        logger.error(
            "Сбой соединения с PostgreSQL: %s",
            error,
            exc_info=True,
        )

        # Выброс HTTP-исключения со статусом 500 для информирования вызывающей стороны
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Ошибка подключения к базе данных: {str(error)}",
        )