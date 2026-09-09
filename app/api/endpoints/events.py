"""
Контроллеры HTTP-эндпоинтов для управления сущностями исторических событий.
Реализованы в виде тонких адаптеров транспортного слоя, делегирующих операции сервисному слою.
"""

from collections.abc import Sequence

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database.database import get_db
from app.core.enums import EventCategory, EventStatus
from app.models.event import Event
from app.schemas.event import EventCreate, EventResponse, EventUpdate
from app.services.event_service import (
    create_event,
    delete_event,
    get_event,
    list_events,
    list_events_in_range,
    update_event,
)

# Инициализация маршрутизатора эндпоинтов управления событиями
router = APIRouter(prefix="", tags=["Events"])


@router.post(
    "/",
    response_model=EventResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Создание нового исторического события",
)
async def create_new_event(
    event_in: EventCreate,
    session: AsyncSession = Depends(get_db),
) -> Event:
    """
    Создание новой записи исторического события.
    Принимает валидированные входные данные EventCreate и делегирует операцию сервисному слою.
    """
    return await create_event(session=session, event_in=event_in)


@router.get(
    "/",
    response_model=list[EventResponse],
    status_code=status.HTTP_200_OK,
    summary="Получение списка исторических событий с пагинацией",
)
async def read_events(
    skip: int = Query(
        default=0,
        ge=0,
        description="Количество пропускаемых записей",
    ),
    limit: int = Query(
        default=100,
        ge=1,
        le=1000,
        description="Максимальное количество записей в выборке",
    ),
    session: AsyncSession = Depends(get_db),
) -> Sequence[Event]:
    """
    Постраничное получение списка исторических событий.
    Возвращает отсортированную последовательность событий в хронологическом порядке.
    """
    return await list_events(session=session, skip=skip, limit=limit)


@router.get(
    "/range",
    response_model=list[EventResponse],
    status_code=status.HTTP_200_OK,
    summary="Выборка событий по временному диапазону",
)
async def read_events_in_range(
    from_date: int = Query(
        ...,
        description="Начальная временная метка диапазона (BIGINT)",
    ),
    to_date: int = Query(
        ...,
        description="Конечная временная метка диапазона (BIGINT)",
    ),
    categories: list[EventCategory] | None = Query(
        default=None,
        description="Список категорий для фильтрации",
    ),
    skip: int = Query(
        default=0,
        ge=0,
        description="Смещение пагинации",
    ),
    limit: int = Query(
        default=500,
        ge=1,
        le=5000,
        description="Лимит выборки для таймлайна",
    ),
    session: AsyncSession = Depends(get_db),
) -> Sequence[Event]:
    """
    Выборка исторических событий, пересекающих заданный хронологический интервал.
    Публичная лента таймлайна возвращает исключительно одобренный контент (status='approved').
    Фильтрация по статусам и модераторские выборки будут реализованы на шаге 5 в рамках ролевой модели.
    """
    # Преобразование перечислений EventCategory в список строковых примитивов для слоя данных
    raw_categories = [category.value for category in categories] if categories else None

    return await list_events_in_range(
        session=session,
        from_date=from_date,
        to_date=to_date,
        categories=raw_categories,
        status=EventStatus.APPROVED.value,
        skip=skip,
        limit=limit,
    )


@router.get(
    "/{event_id}",
    response_model=EventResponse,
    status_code=status.HTTP_200_OK,
    summary="Получение исторического события по ID",
)
async def read_event_by_id(
    event_id: int,
    session: AsyncSession = Depends(get_db),
) -> Event:
    """
    Получение детальной информации об историческом событии по первичному ключу.
    При отсутствии события выбрасывается доменное исключение EventNotFoundError.
    """
    return await get_event(session=session, event_id=event_id)


@router.patch(
    "/{event_id}",
    response_model=EventResponse,
    status_code=status.HTTP_200_OK,
    summary="Частичное обновление исторического события",
)
async def update_existing_event(
    event_id: int,
    event_in: EventUpdate,
    session: AsyncSession = Depends(get_db),
) -> Event:
    """
    Частичное обновление полей исторического события.
    Проверяет существование записи и согласованность дат с текущим состоянием базы данных.
    """
    return await update_event(session=session, event_id=event_id, event_in=event_in)


@router.delete(
    "/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Удаление исторического события",
)
async def delete_existing_event(
    event_id: int,
    session: AsyncSession = Depends(get_db),
) -> None:
    """
    Удаление исторического события по его идентификатору.
    Возвращает пустой ответ со статусом 204 No Content.
    """
    await delete_event(session=session, event_id=event_id)
