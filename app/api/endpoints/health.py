"""
Контроллер системной диагностики и мониторинга состояния сервиса History Timeline.
Проверяет сетевую доступность СУБД PostgreSQL через изолированное подключение и возвращает стандартизированный статус.
"""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config.config import settings
from app.core.database.database import get_db_engine
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
    engine: AsyncEngine = Depends(get_db_engine),
) -> HealthResponse:
    """
    Диагностический эндпоинт проверки работоспособности сервиса.

    Жизненный цикл подключения и изоляция сетевых сбоев:
    - Зависимость get_db_engine возвращает объект AsyncEngine без выполнения сетевых вызовов
      на этапе сборки зависимостей FastAPI, предотвращая падение с кодом 500 до входа в обработчик.
    - Открытие сетевого сокета (engine.connect()) и выполнение контрольного запроса (SELECT 1)
      выполняются внутри защищенного блока try...except.
    - При штатной работе возвращается код 200 OK, status='ok' и db_connected=True.
    - При любом сетевом или инфраструктурном сбое (отказ сокета, недоступность СУБД) ошибка
      логируется на уровне ERROR с полным стеком exc_info=True, код ответа устанавливается
      в 503 Service Unavailable, и возвращается структурированная схема деградации без раскрытия
      системных деталей клиенту.
    """
    try:
        # Открытие сетевого соединения и выполнение контрольного запроса внутри изолированного блока
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

        # Возврат успешного статуса при подтвержденной доступности базы данных
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
