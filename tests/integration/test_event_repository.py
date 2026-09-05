"""
Интеграционные тесты уровня репозитория и целостности реляционной схемы таблицы events.
Проверяет аппаратные ограничения CheckConstraint PostgreSQL 18, корректность
вычисления колонки end_date_effective и каскадное поведение внешнего ключа parent_id.
"""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.models.event import Event


def make_base_event(**kwargs) -> Event:
    """
    Вспомогательная фабрика для создания экземпляра ORM-модели Event.
    Инициализирует объект валидными базовыми атрибутами в оперативной памяти
    без автоматического добавления в сессию базы данных.
    """
    attributes = {
        "title": "Репозиторный тест",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
        "status": EventStatus.APPROVED.value,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
    }
    # Переопределение значений по умолчанию параметрами конкретного теста
    attributes.update(kwargs)
    return Event(**attributes)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_check_constraint_end_after_start(db_session: AsyncSession) -> None:
    """
    Проверка аппаратного ограничения ck_events_end_after_start:
    дата окончания интервала не может предшествовать дате его начала.
    """
    # Создание сущности с заведомо некорректным хронологическим интервалом
    invalid_event = make_base_event(
        start_date=2000,
        end_date=1000,
    )
    db_session.add(invalid_event)

    # Отправка INSERT в PostgreSQL: ожидается ошибка нарушения CheckConstraint
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()

    # Проверка регистрации конкретного имени ограничения СУБД в тексте исключения
    assert "ck_events_end_after_start" in str(exc_info.value)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_check_constraint_rank_allowed(db_session: AsyncSession) -> None:
    """
    Проверка аппаратного ограничения ck_events_rank_allowed:
    уровень детализации (ранг) обязан входить в фиксированный перечень значений EventRank.
    """
    # Создание сущности с незарегистрированным в системе рангом
    invalid_event = make_base_event(rank="millennium")
    db_session.add(invalid_event)

    # Отправка INSERT в PostgreSQL: ожидается отклонение транзакции
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()

    assert "ck_events_rank_allowed" in str(exc_info.value)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_computed_column_end_date_effective_point_event(
    db_session: AsyncSession,
) -> None:
    """
    Проверка расчета материализованной вычисляемой колонки end_date_effective
    для точечного события (end_date=None): значение обязано равняться start_date.
    """
    # Создание точечного события без даты окончания
    event = make_base_event(
        start_date=12345,
        end_date=None,
    )
    db_session.add(event)
    await db_session.flush()

    # Чтение сохраненного объекта из PostgreSQL для проверки материализованной колонки
    statement = select(Event).where(Event.id == event.id)
    result = await db_session.execute(statement)
    db_event = result.scalar_one()

    # СУБД должна вычислить COALESCE(end_date, start_date) = 12345
    assert db_event.end_date_effective == 12345


@pytest.mark.integration
@pytest.mark.asyncio
async def test_computed_column_end_date_effective_interval_event(
    db_session: AsyncSession,
) -> None:
    """
    Проверка расчета материализованной вычисляемой колонки end_date_effective
    для интервального события: значение обязано равняться явному end_date.
    """
    # Создание события с явным интервалом
    event = make_base_event(
        start_date=10000,
        end_date=20000,
    )
    db_session.add(event)
    await db_session.flush()

    # Чтение сохраненного объекта из PostgreSQL
    statement = select(Event).where(Event.id == event.id)
    result = await db_session.execute(statement)
    db_event = result.scalar_one()

    # СУБД должна вычислить COALESCE(end_date, start_date) = 20000
    assert db_event.end_date_effective == 20000


@pytest.mark.integration
@pytest.mark.asyncio
async def test_cascade_set_null_parent_id_on_parent_deletion(
    db_session: AsyncSession,
) -> None:
    """
    Проверка каскадного действия внешнего ключа ON DELETE SET NULL:
    при физическом удалении родительского события дочерняя запись сохраняется,
    а ее поле parent_id автоматически переводится СУБД в значение NULL.
    """
    # 1. Создание родительского макро-события
    parent = make_base_event(
        title="Родитель",
        rank=EventRank.CENTURY.value,
    )
    db_session.add(parent)
    await db_session.flush()

    # 2. Создание дочернего события, привязанного к родителю
    child = make_base_event(
        title="Потомок",
        rank=EventRank.YEAR.value,
        parent_id=parent.id,
    )
    db_session.add(child)
    await db_session.flush()

    assert child.parent_id == parent.id

    # Фиксация первичного ключа дочернего события до операций удаления и отвязки объектов
    child_id: int = child.id

    # 3. Физическое удаление родительского события в СУБД
    await db_session.delete(parent)
    await db_session.flush()

    # 4. Полное исключение сущностей из Identity Map без перевода в expired-состояние
    # Исключает ошибку MissingGreenlet при обращении к полям в асинхронном контексте
    db_session.expunge_all()

    # 5. Повторная выборка дочернего события через явный асинхронный SQL-запрос
    statement = select(Event).where(Event.id == child_id)
    result = await db_session.execute(statement)
    updated_child = result.scalar_one()

    # Запись потомка должна существовать, а parent_id сброшен в None внешним ключом СУБД
    assert updated_child is not None
    assert updated_child.parent_id is None
