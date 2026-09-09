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
    status: str | None = None,
) -> Event:
    """
    Создание нового исторического события в контексте открытой транзакции.
    Выполняет сериализацию схемы в JSON-совместимые примитивы через mode="json",
    предотвращая передачу специальных объектов Pydantic (Url, Enum) в драйвер asyncpg.
    Принимает опциональный строковый статус модерации, сохраняя независимость
    слоя доступа к данным от доменных перечислений сервисного ядра.
    Выполняет flush для генерации первичного ключа без фиксации транзакции.
    """
    # Преобразование Pydantic-схемы в словарь JSON-примитивов для безопасной записи в базу данных
    event_data = event_in.model_dump(mode="json")

    # Установка статуса модерации при его явной передаче из вызывающего сервиса
    if status is not None:
        event_data["status"] = status

    # Создание экземпляра ORM-модели на основе подготовленных данных
    db_event = Event(**event_data)

    # Регистрация новой сущности в сессии базы данных
    session.add(db_event)

    # Отправка SQL INSERT в базу данных для генерации первичного ключа id
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
    status: str | None = None,
    skip: int = 0,
    limit: int = 100,
) -> Sequence[Event]:
    """
    Постраничная выборка исторических событий с опциональной фильтрацией по статусу.
    Сортирует записи в строгом хронологическом порядке по возрастанию start_date.
    """
    # Построение базового SQL-выражения выборки
    statement = select(Event)

    # Применение фильтра статуса модерации при его передаче
    if status is not None:
        statement = statement.where(Event.status == status)

    # Сортировка по возрастанию даты начала и применение смещения пагинации
    statement = statement.order_by(Event.start_date.asc()).offset(skip).limit(limit)

    # Выполнение запроса
    result = await session.execute(statement)

    # Возврат последовательности найденных ORM-моделей
    return result.scalars().all()


async def get_events_by_parent_id(
    session: AsyncSession,
    parent_id: int,
) -> Sequence[Event]:
    """
    Выборка всех исторических событий, дочерних по отношению к указанному родителю.
    Используется сервисным слоем для контроля инвариантов иерархии и предотвращения
    инверсии масштабов детализации при обновлении ранга события.
    """
    # Формирование запроса на выборку всех прямых потомков по внешнему ключу parent_id
    statement = select(Event).where(Event.parent_id == parent_id)

    # Асинхронное выполнение запроса к базе данных
    result = await session.execute(statement)

    # Возврат последовательности дочерних сущностей
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


# Явный список публичных функций слоя доступа к данным в алфавитном порядке
__all__: list[str] = [
    "create_event",
    "delete_event",
    "get_event_by_id",
    "get_events",
    "get_events_by_parent_id",
    "get_events_in_range",
    "update_event",
]
