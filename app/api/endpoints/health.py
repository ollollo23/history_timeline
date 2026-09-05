"""
Контроллер системной диагностики и мониторинга состояния сервиса History Timeline.
Проверяет сетевую доступность СУБД PostgreSQL и возвращает стандартизированный статус.
"""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config.config import settings
from app.core.database.database import get_db
from app.core.logger import logger
from app.schemas.health import HealthResponse

# Инициализация системного маршрутизатора для OpenAPI
router = APIRouter(prefix="", tags=["System"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Проверка статуса сервиса и подключения к БД",
    responses={
        status.HTTP_200_OK: {
            "model": HealthResponse,
            "description": "Сервис полностью работоспособен",
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "model": HealthResponse,
            "description": "Сервис деградирован, база данных недоступна",
        },
    },
)
async def health_check(
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> HealthResponse:
    """
    Диагностический эндпоинт проверки работоспособности сервиса.

    Логика разделения HTTP-статусов:
    - 200 OK: тестовый запрос SELECT 1 успешно выполнен, пул соединений к PostgreSQL активен,
      возвращается статус 'ok' и флаг db_connected=True.
    - 503 Service Unavailable: обнаружен сбой сетевого сокета или СУБД недоступна,
      код ответа мутируется через объект Response на 503, возвращается статус 'degraded'
      и db_connected=False без раскрытия технического трейсбека клиенту.
    """
    try:
        # Выполнение легковесного контрольного запроса для валидации сессии базы данных
        await session.execute(text("SELECT 1"))

        # Возврат успешного статуса при штатной работе всех компонентов
        return HealthResponse(
            status="ok",
            db_connected=True,
            version=settings.app_version,
        )
    except Exception as error:
        # Регистрация ошибки соединения в логах приложения с полным стеком вызовов
        logger.error(
            "Сбой проверки доступности PostgreSQL: %s",
            error,
            exc_info=True,
        )

        # Установка статус-кода 503 Service Unavailable в объекте ответа FastAPI
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

        # Возврат типизированного ответа о деградации сервиса
        return HealthResponse(
            status="degraded",
            db_connected=False,
            version=settings.app_version,
        )
