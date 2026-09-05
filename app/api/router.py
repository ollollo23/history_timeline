from fastapi import APIRouter

from app.api.endpoints.events import router as events_router
from app.api.endpoints.health import router as health_router

# Создание главного агрегирующего роутера для всех эндпоинтов приложения
api_router = APIRouter()

# Регистрация системного роутера мониторинга состояния сервиса
api_router.include_router(
    health_router,
    prefix="",
    tags=["System"],
)

# Регистрация роутера CRUD-операций над сущностями исторических событий
api_router.include_router(
    events_router,
    prefix="/events",
    tags=["Events"],
)
