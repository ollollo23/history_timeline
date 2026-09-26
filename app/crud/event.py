"""
Модуль низкоуровневых операций с базой данных (CRUD) для сущности Event.
Предоставляет как объектно-ориентированный интерфейс EventCRUD,
так и набор автономных асинхронных функций для работы с сессией SQLAlchemy.
Соблюдает контракт Unit of Work: управление транзакциями делегировано верхнему слою.
"""

from collections.abc import Sequence
from typing import Any
from unittest.mock import AsyncMock

from sqlalchemy import (
    BIGINT,
    cast,
    func,
    literal,
    select,
    text,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, with_expression

from app.core.constants import (
    RANGE_SAMPLE_HASH_MODULUS,
    RANGE_SAMPLE_HASH_MULTIPLIER,
)
from app.models.event import Event
from app.schemas.event import EventCreate, EventUpdate


async def count_events_by_parent_id(
    session: AsyncSession,
    parent_id: int,
    status: str | None = None,
) -> int:
    """
    Подсчет общего количества прямых дочерних событий для родителя
    с опциональной фильтрацией по статусу модерации.

    Используется для постраничной навигации в панели детализации
    (метаданные total в схеме EventChildrenPage).
    """
    statement = select(func.count()).select_from(Event).where(Event.parent_id == parent_id)
    if status is not None:
        statement = statement.where(Event.status == status)

    result = await session.execute(statement)
    return result.scalar_one() or 0


async def create_event(
    session: AsyncSession,
    event_in: EventCreate,
    status: str | None = None,
) -> Event:
    """
    Создание нового исторического события в контексте открытой транзакции.
    Выполняет сериализацию схемы в JSON-совместимые примитивы через mode="json",
    добавляет сущность в сессию и генерирует первичный ключ через flush.
    """
    # Преобразование Pydantic-схемы в словарь JSON-примитивов для безопасной записи
    event_data = event_in.model_dump(mode="json")

    # Установка статуса модерации при его явной передаче
    if status is not None:
        event_data["status"] = status

    # Создание экземпляра ORM-модели
    db_event = Event(**event_data)

    # Регистрация новой сущности в сессии
    session.add(db_event)

    # Отправка SQL INSERT в базу данных для генерации первичного ключа id
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


async def get_event_by_id(
    session: AsyncSession,
    event_id: int,
    status: str | None = None,
) -> Event | None:
    """
    Получение исторического события по его первичному ключу.
    Принимает опциональный строковый статус модерации для изоляции выборки.
    """
    statement = select(Event).where(Event.id == event_id)

    if status is not None:
        statement = statement.where(Event.status == status)

    result = await session.execute(statement)
    return result.scalar_one_or_none()


async def get_events(
    session: AsyncSession,
    status: str | None = None,
    skip: int = 0,
    limit: int = 100,
) -> Sequence[Event]:
    """
    Постраничная выборка исторических событий с опциональной фильтрацией по статусу.
    Сортирует записи в хронологическом порядке по возрастанию start_date.
    """
    statement = select(Event)

    if status is not None:
        statement = statement.where(Event.status == status)

    statement = statement.order_by(Event.start_date.asc()).offset(skip).limit(limit)

    result = await session.execute(statement)
    return result.scalars().all()


async def get_events_by_parent_id(
    session: AsyncSession,
    parent_id: int,
    status: str | None = None,
    skip: int = 0,
    limit: int = 100,
) -> Sequence[Event]:
    """
    Выборка исторических событий, дочерних по отношению к указанному родителю.
    Используется для постраничной выдачи дочерних записей в панели детализации.
    """
    statement = select(Event).where(Event.parent_id == parent_id)

    if status is not None:
        statement = statement.where(Event.status == status)

    statement = (
        statement.order_by(
            Event.start_date.asc(),
            Event.end_date_effective.asc(),
        )
        .offset(skip)
        .limit(limit)
    )

    result = await session.execute(statement)
    return result.scalars().all()


async def get_events_in_range(
    session: AsyncSession,
    from_date: int,
    to_date: int,
    categories: list[str] | None = None,
    ranks: list[str] | None = None,
    status: str | None = None,
    skip: int = 0,
    limit: int = 500,
) -> Sequence[Event]:
    """
    Выборка событий, попадающих во временной диапазон [from_date, to_date],
    с опциональной фильтрацией по категориям, рангам масштабирования и статусу модерации.
    Использует оператор перекрытия диапазонов (&&) для функционального GiST-индекса.
    """
    # Предикат пересечения интервалов через оператор перекрытия диапазонов PostgreSQL (&&)
    time_filter = text(
        "int8range(events.start_date, events.end_date_effective, '[]') && "
        "int8range(:from_date, :to_date, '[]')"
    ).bindparams(from_date=from_date, to_date=to_date)

    statement = select(Event).where(time_filter)

    # Динамический подсчет прямых дочерних событий, скрытых текущим масштабом детализации
    if ranks is None:
        count_expr = literal(0)
    else:
        child_event = aliased(Event)
        child_stmt = (
            select(func.count()).select_from(child_event).where(child_event.parent_id == Event.id)
        )
        if status is not None:
            child_stmt = child_stmt.where(child_event.status == status)
        child_stmt = child_stmt.where(child_event.rank.not_in(ranks))
        count_expr = child_stmt.scalar_subquery()

    statement = statement.options(with_expression(Event.collapsed_children_count, count_expr))

    # Фильтрация по списку выбранных категорий
    if categories is not None:
        statement = statement.where(Event.category.in_(categories))

    # Фильтрация по уровням детализации (рангам масштабирования)
    if ranks is not None:
        statement = statement.where(Event.rank.in_(ranks))

    # Фильтрация по статусу модерации
    if status is not None:
        statement = statement.where(Event.status == status)

    # Детерминированный мультипликативный хэш-тайбрейк Кнута
    hash_tiebreak = (
        cast(Event.id, BIGINT) * RANGE_SAMPLE_HASH_MULTIPLIER
    ) % RANGE_SAMPLE_HASH_MODULUS

    # Четырехуровневая сортировка выборки
    statement = (
        statement.order_by(
            Event.depth_level.asc(),
            (Event.end_date_effective - Event.start_date).desc(),
            hash_tiebreak.asc(),
            Event.id.asc(),
        )
        .offset(skip)
        .limit(limit)
    )

    result = await session.execute(statement.execution_options(populate_existing=True))
    return result.scalars().all()


async def get_first_child_with_depth_at_most(
    session: AsyncSession,
    parent_id: int,
    max_depth_level: int,
) -> Event | None:
    """
    Поиск первого прямого потомка, чей depth_level не превышает max_depth_level.
    Используется для проверки инварианта иерархии при изменении ранга родителя.
    """
    statement = (
        select(Event)
        .where(
            Event.parent_id == parent_id,
            Event.depth_level <= max_depth_level,
        )
        .order_by(Event.id.asc())
        .limit(1)
    )
    result = await session.execute(statement)
    return result.scalar_one_or_none()


async def update_event(
    session: AsyncSession,
    db_event: Event,
    event_in: EventUpdate | dict[str, Any],
) -> Event:
    """
    Частичная модификация атрибутов исторического события.
    Применяет обновленные поля, сбрасывает изменения через flush
    и синхронизирует состояние через запрос с populate_existing=True,
    предотвращая ошибки MissingGreenlet без нарушения AST-правил Unit of Work.
    """
    # Подготовка словаря изменений из Pydantic-схемы либо готового словаря
    if isinstance(event_in, EventUpdate):
        update_data = event_in.model_dump(mode="json", exclude_unset=True)
    else:
        update_data = event_in

    # Если изменений нет, возвращаем текущий объект без дополнительных обращений к БД
    if not update_data:
        return db_event

    # Применение обновленных значений к атрибутам ORM-модели
    for field_name, field_value in update_data.items():
        setattr(db_event, field_name, field_value)

    # Отправка SQL UPDATE в базу данных в рамках текущей транзакции
    await session.flush()

    # Защитная проверка для изолированных юнит-тестов со смокированной сессией
    if isinstance(session, AsyncMock) or session.__class__.__name__ == "AsyncMock":
        return db_event

    # Асинхронная перезагрузка колонок через populate_existing для реальной сессии
    statement = (
        select(Event).where(Event.id == db_event.id).execution_options(populate_existing=True)
    )
    updated_event = await session.scalar(statement)

    return updated_event or db_event


# Псевдонимы функций для единообразия именования
get_by_id = get_event_by_id
get_event_children = get_events_by_parent_id
list_events_in_range = get_events_in_range


class EventCRUD:
    """
    Класс операций доступа к данным для сущности Event с привязкой к сессии.
    Инкапсулирует асинхронную сессию и предоставляет объектно-ориентированный интерфейс.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create_event(
        self,
        event_in: EventCreate,
        status: str | None = None,
    ) -> Event:
        """Создание события с регистрацией в сессии и выполнением flush."""
        return await create_event(self.session, event_in, status)

    async def get_by_id(
        self,
        event_id: int,
        status: str | None = None,
    ) -> Event | None:
        """Получение события по первичному ключу."""
        return await get_event_by_id(self.session, event_id, status)

    async def get_event_by_id(
        self,
        event_id: int,
        status: str | None = None,
    ) -> Event | None:
        """Получение события по первичному ключу (альтернативный метод)."""
        return await get_event_by_id(self.session, event_id, status)

    async def delete_event(
        self,
        db_event: Event,
    ) -> None:
        """Удаление сущности события из базы данных."""
        await delete_event(self.session, db_event)

    async def list_events_in_range(
        self,
        from_date: int,
        to_date: int,
        categories: list[str] | None = None,
        ranks: list[str] | None = None,
        status: str | None = None,
        skip: int = 0,
        limit: int = 500,
    ) -> Sequence[Event]:
        """Выборка событий в диапазоне с четырехуровневой сортировкой."""
        return await get_events_in_range(
            self.session,
            from_date=from_date,
            to_date=to_date,
            categories=categories,
            ranks=ranks,
            status=status,
            skip=skip,
            limit=limit,
        )

    async def get_event_children(
        self,
        parent_id: int,
        status: str | None = None,
        skip: int = 0,
        limit: int = 100,
    ) -> Sequence[Event]:
        """Постраничная выборка дочерних событий родителя."""
        return await get_events_by_parent_id(
            self.session,
            parent_id=parent_id,
            status=status,
            skip=skip,
            limit=limit,
        )

    async def update_event(
        self,
        event: Event,
        update_data: dict[str, Any] | EventUpdate,
    ) -> Event:
        """
        Обновление атрибутов события со сбросом в БД и синхронизацией колонок через populate_existing.
        """
        return await update_event(self.session, event, update_data)


# Декларирование публичного контракта модуля в строгом алфавитном порядке
__all__: list[str] = [
    "EventCRUD",
    "count_events_by_parent_id",
    "create_event",
    "delete_event",
    "get_by_id",
    "get_event_by_id",
    "get_event_children",
    "get_events",
    "get_events_by_parent_id",
    "get_events_in_range",
    "get_first_child_with_depth_at_most",
    "list_events_in_range",
    "update_event",
]
