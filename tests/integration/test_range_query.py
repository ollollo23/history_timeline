"""
Интеграционные тесты интервальной выборки исторических событий.
Проверяет поведение запроса get_events_in_range на реальной базе данных PostgreSQL 18
с учетом отрицательных меток времени, точечных событий и хранимой колонки end_date_effective.
"""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.crud.event import get_events_in_range
from app.models.event import Event


async def create_test_event(
    session: AsyncSession,
    **kwargs,
) -> Event:
    """
    Вспомогательная фабрика для создания тестовых событий в реальной базе данных.
    Заполняет обязательные поля значениями по умолчанию, выполняет flush для расчета
    генерируемой колонки end_date_effective и возвращает созданный объект Event.
    """
    # Базовые валидные значения для соблюдения CheckConstraint таблицы events
    attributes = {
        "title": "Тестовое событие",
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
        "status": EventStatus.APPROVED.value,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
    }
    # Переопределение атрибутов переданными параметрами теста
    attributes.update(kwargs)

    event = Event(**attributes)
    session.add(event)

    # Вызов flush отправляет INSERT в PostgreSQL для вычисления end_date_effective
    await session.flush()
    return event


@pytest.mark.integration
@pytest.mark.asyncio
async def test_negative_timestamps_bce_range(db_session: AsyncSession) -> None:
    """
    Проверка выборки событий с отрицательными метками времени (до нашей эры).
    Событие А попадает в диапазон, событие Б находится за его пределами.
    """
    # Событие А: [-100 000, -50 000] — пересекает диапазон [-150 000, -40 000]
    event_a = await create_test_event(
        session=db_session,
        title="Событие А (до н.э.)",
        start_date=-100000,
        end_date=-50000,
    )
    # Событие Б: [-300 000, -250 000] — завершилось до начала диапазона [-150 000, -40 000]
    await create_test_event(
        session=db_session,
        title="Событие Б (до н.э.)",
        start_date=-300000,
        end_date=-250000,
    )

    # Выполнение интервальной выборки
    events = await get_events_in_range(
        session=db_session,
        from_date=-150000,
        to_date=-40000,
        status=EventStatus.APPROVED.value,
    )

    # В выборку должно попасть только событие А
    event_ids = [event.id for event in events]
    assert event_ids == [event_a.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_point_event_inside_range(db_session: AsyncSession) -> None:
    """
    Проверка включения точечного события (end_date is None) внутрь диапазона.
    Поведение обеспечивается хранимой колонкой end_date_effective = start_date.
    """
    # Точечное событие в точке 500 внутри диапазона [0, 1000]
    point_event = await create_test_event(
        session=db_session,
        title="Точечное событие внутри",
        start_date=500,
        end_date=None,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    event_ids = [event.id for event in events]
    assert point_event.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_point_event_outside_range(db_session: AsyncSession) -> None:
    """
    Проверка исключения точечных событий, находящихся слева и справа от диапазона.
    """
    # Точечное событие левее диапазона [0, 1000]
    await create_test_event(
        session=db_session,
        title="Точечное событие слева",
        start_date=-500,
        end_date=None,
    )
    # Точечное событие правее диапазона [0, 1000]
    await create_test_event(
        session=db_session,
        title="Точечное событие справа",
        start_date=1500,
        end_date=None,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    # Ни одно точечное событие вне диапазона не должно вернуться
    assert len(events) == 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_interval_crossing_left_boundary(db_session: AsyncSession) -> None:
    """
    Проверка пересечения левой границы диапазона:
    событие началось до from_date, но завершилось внутри диапазона.
    """
    # Интервал [-200, 300] пересекает левую границу диапазона [0, 1000]
    event = await create_test_event(
        session=db_session,
        title="Пересечение левой границы",
        start_date=-200,
        end_date=300,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    event_ids = [e.id for e in events]
    assert event.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_interval_crossing_right_boundary(db_session: AsyncSession) -> None:
    """
    Проверка пересечения правой границы диапазона:
    событие началось внутри диапазона, но завершилось после to_date.
    """
    # Интервал [800, 1500] пересекает правую границу диапазона [0, 1000]
    event = await create_test_event(
        session=db_session,
        title="Пересечение правой границы",
        start_date=800,
        end_date=1500,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    event_ids = [e.id for e in events]
    assert event.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_interval_completely_covering_range(db_session: AsyncSession) -> None:
    """
    Проверка масштабного события, полностью покрывающего диапазон:
    началось до from_date и закончилось после to_date.
    """
    # Интервал [-500, 2000] полностью накрывает диапазон [0, 1000]
    covering_event = await create_test_event(
        session=db_session,
        title="Полное покрытие диапазона",
        start_date=-500,
        end_date=2000,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    event_ids = [e.id for e in events]
    assert covering_event.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_event_touching_exact_boundary(db_session: AsyncSession) -> None:
    """
    Проверка граничных условий: событие касается ровно границы from_date или to_date.
    Оба граничных события должны попадать в нестрогое условие пересечения.
    """
    # Событие касается левой границы: окончание ровно в from_date (0)
    touch_left = await create_test_event(
        session=db_session,
        title="Касание левой границы",
        start_date=-500,
        end_date=0,
    )
    # Точечное событие касается правой границы: начало ровно в to_date (1000)
    touch_right = await create_test_event(
        session=db_session,
        title="Касание правой границы",
        start_date=1000,
        end_date=None,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        status=EventStatus.APPROVED.value,
    )

    event_ids = [e.id for e in events]
    assert touch_left.id in event_ids
    assert touch_right.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_ordering(db_session: AsyncSession) -> None:
    """
    Проверка детерминированной сортировки выдачи:
    сначала по start_date.asc(), затем по end_date_effective.asc().
    """
    # Событие 1: start=500, effective=1500
    event_1 = await create_test_event(
        session=db_session,
        title="Событие 1 (500, 1500)",
        start_date=500,
        end_date=1500,
    )
    # Событие 2: start=100, effective=100
    event_2 = await create_test_event(
        session=db_session,
        title="Событие 2 (100, point)",
        start_date=100,
        end_date=None,
    )
    # Событие 3: start=500, effective=800
    event_3 = await create_test_event(
        session=db_session,
        title="Событие 3 (500, 800)",
        start_date=500,
        end_date=800,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=2000,
        status=EventStatus.APPROVED.value,
    )

    # Ожидаемый хронологический порядок: event_2 (100), event_3 (500, 800), event_1 (500, 1500)
    event_ids = [e.id for e in events]
    assert event_ids == [event_2.id, event_3.id, event_1.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_filtering_category_and_status(db_session: AsyncSession) -> None:
    """
    Проверка фильтрации по нескольким категориям и строгому статусу модерации.
    """
    # Событие 1: подходит по категории (SCIENCE) и статусу (APPROVED)
    event_1 = await create_test_event(
        session=db_session,
        title="Наука Одобрено",
        start_date=100,
        end_date=200,
        category=EventCategory.SCIENCE.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 2: подходит по категории (CULTURE) и статусу (APPROVED)
    event_2 = await create_test_event(
        session=db_session,
        title="Культура Одобрено",
        start_date=200,
        end_date=300,
        category=EventCategory.CULTURE.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 3: не подходит по статусу (PENDING)
    await create_test_event(
        session=db_session,
        title="Наука На модерации",
        start_date=300,
        end_date=400,
        category=EventCategory.SCIENCE.value,
        status=EventStatus.PENDING.value,
    )
    # Событие 4: не подходит по категории (POLITICS)
    await create_test_event(
        session=db_session,
        title="Политика Одобрено",
        start_date=400,
        end_date=500,
        category=EventCategory.POLITICS.value,
        status=EventStatus.APPROVED.value,
    )

    # Запрос с фильтрацией по двум категориям и статусу 'approved'
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        categories=[EventCategory.SCIENCE.value, EventCategory.CULTURE.value],
        status=EventStatus.APPROVED.value,
    )

    # В результат должны войти только событие 1 и событие 2
    event_ids = [e.id for e in events]
    assert event_ids == [event_1.id, event_2.id]
