"""
Модуль низкоуровневых операций с базой данных (CRUD) для сущности Event.
Реализует операции выборки, вставки, обновления и удаления без управления транзакционными границами.
"""

from collections.abc import Sequence

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.schemas.event import EventCreate, EventUpdate


async def create_event(
    session: AsyncSession,
    event_in: EventCreate,
) -> Event:
    """
    Создание нового исторического события в контексте открытой транзакции.
    Выполняет сериализацию схемы в JSON-совместимые примитивы через mode="json",
    предотвращая передачу специальных объектов Pydantic (Url, Enum) в драйвер asyncpg.
    Выполняет flush для генерации первичного ключа без фиксации транзакции.
    """
    # Преобразование Pydantic-схемы в словарь JSON-примитивов для безопасной записи в JSONB и Enum колонки
    event_data = event_in.model_dump(mode="json")
    db_event = Event(**event_data)

    # Регистрация новой сущности в сессии
    session.add(db_event)

    # Отправка SQL INSERT в базу данных для получения первичного ключа id
    await session.flush()

    return db_event


async def get_event_by_id(
    session: AsyncSession,
    event_id: int,
) -> Event | None:
    """
    Получение исторического события по его первичному ключу.
    Возвращает экземпляр Event или None при отсутствии записи.
    """
    # Формирование запроса на выборку события по точному идентификатору
    statement = select(Event).where(Event.id == event_id)

    # Асинхронное выполнение запроса к СУБД
    result = await session.execute(statement)

    # Извлечение скалярного объекта или None
    return result.scalar_one_or_none()


async def get_events(
    session: AsyncSession,
    skip: int = 0,
    limit: int = 100,
) -> Sequence[Event]:
    """
    Постраничная выборка исторических событий.
    Сортирует записи в строгом хронологическом порядке по возрастанию start_date.
    """
    # Построение запроса с хронологической сортировкой и пагинацией
    statement = select(Event).order_by(Event.start_date.asc()).offset(skip).limit(limit)

    # Выполнение запроса
    result = await session.execute(statement)

    # Возврат последовательности найденных ORM-моделей
    return result.scalars().all()


async def get_events_in_range(
    session: AsyncSession,
    from_date: int,
    to_date: int,
    categories: list[str] | None = None,
    status: str | None = None,
    skip: int = 0,
    limit: int = 500,
) -> Sequence[Event]:
    """
    Выборка событий, попадающих во временной диапазон [from_date, to_date].
    Использует хранимую вычисляемую колонку end_date_effective для быстрого
    поиска пересечений через композитный индекс без ветвлений OR.
    """
    # Фильтрация пересечения интервалов события с видимым окном таймлайна
    time_filter = and_(
        Event.start_date <= to_date,
        Event.end_date_effective >= from_date,
    )

    statement = select(Event).where(time_filter)

    # Фильтрация по списку выбранных категорий
    if categories:
        statement = statement.where(Event.category.in_(categories))

    # Фильтрация по статусу модерации (например, EventStatus.APPROVED)
    if status is not None:
        statement = statement.where(Event.status == status)

    # Сортировка по возрастанию даты начала и эффективного окончания с пагинацией
    statement = (
        statement.order_by(
            Event.start_date.asc(),
            Event.end_date_effective.asc(),
        )
        .offset(skip)
        .limit(limit)
    )

    # Выполнение запроса
    result = await session.execute(statement)

    return result.scalars().all()


async def update_event(
    session: AsyncSession,
    db_event: Event,
    event_in: EventUpdate,
) -> Event:
    """
    Частичная модификация атрибутов исторического события.
    Преобразует переданные поля в JSON-совместимые примитивы через mode="json",
    применяет только явно переданные поля и отправляет изменения через flush.
    """
    # Извлечение словаря переданных полей с сериализацией сложных типов (Url, Enum) в примитивы
    update_data = event_in.model_dump(mode="json", exclude_unset=True)

    # Применение обновленных значений к атрибутам ORM-модели
    for field_name, field_value in update_data.items():
        setattr(db_event, field_name, field_value)

    # Отправка SQL UPDATE в базу данных в рамках текущей транзакции
    await session.flush()

    return db_event


async def delete_event(
    session: AsyncSession,
    db_event: Event,
) -> None:
    """
    Удаление записи исторического события из базы данных.
    Помечает объект на удаление и синхронизирует состояние сессии через flush.
    """
    # Маркировка сущности на удаление в контексте сессии
    await session.delete(db_event)

    # Отправка SQL DELETE в базу данных
    await session.flush()


# Явный список публичных функций слоя доступа к данным
__all__: list[str] = [
    "create_event",
    "delete_event",
    "get_event_by_id",
    "get_events",
    "get_events_in_range",
    "update_event",
]
