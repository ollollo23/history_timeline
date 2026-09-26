"""
Интеграционные тесты интервальной выборки исторических событий.
Проверяет поведение запроса get_events_in_range на реальной базе данных PostgreSQL 18
с учетом приоритетного ранжирования, хэш-тайбрейка Кнута, отрицательных меток времени,
точечных событий, хранимой колонки end_date_effective, динамического подсчета свернутых
потомков collapsed_children_count, а также фильтрации по рангам и категориям.
"""

from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import (
    RANGE_SAMPLE_HASH_MODULUS,
    RANGE_SAMPLE_HASH_MULTIPLIER,
)
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.crud.event import get_events_in_range
from app.models.event import Event
from app.services.event_service import list_events_in_range


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
async def test_range_query_priority_ordering(db_session: AsyncSession) -> None:
    """
    Проверка четырехуровневой приоритетной сортировки интервальной выборки:
    1. depth_level.asc() (важность: century < year < day);
    2. (end_date_effective - start_date).desc() (протяженность: 1000с > 100с > 0с);
    3. Мультипликативный хэш Кнута;
    4. Первичный ключ id.asc().
    """
    century_interval = await create_test_event(
        session=db_session,
        title="Век",
        rank=EventRank.CENTURY.value,
        start_date=0,
        end_date=10000,
    )
    year_interval_1000 = await create_test_event(
        session=db_session,
        title="Год 1000с",
        rank=EventRank.YEAR.value,
        start_date=100,
        end_date=1100,
    )
    year_interval_100 = await create_test_event(
        session=db_session,
        title="Год 100с",
        rank=EventRank.YEAR.value,
        start_date=200,
        end_date=300,
    )
    year_point = await create_test_event(
        session=db_session,
        title="Год точка",
        rank=EventRank.YEAR.value,
        start_date=500,
        end_date=None,
    )
    day_point = await create_test_event(
        session=db_session,
        title="День точка",
        rank=EventRank.DAY.value,
        start_date=600,
        end_date=None,
    )

    events = await get_events_in_range(
        session=db_session,
        from_date=-1000,
        to_date=20000,
        status=EventStatus.APPROVED.value,
    )

    assert [e.id for e in events] == [
        century_interval.id,
        year_interval_1000.id,
        year_interval_100.id,
        year_point.id,
        day_point.id,
    ]


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
    assert {e.id for e in events} == {event_1.id, event_2.id}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_filtering_by_ranks(db_session: AsyncSession) -> None:
    """
    Проверка фильтрации событий по перечню выбранных рангов детализации на уровне SQL-запроса.
    """
    # Событие 1: ранг century (подлежит включению)
    event_1 = await create_test_event(
        session=db_session,
        title="Век",
        start_date=100,
        end_date=500,
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 2: ранг year (подлежит включению)
    event_2 = await create_test_event(
        session=db_session,
        title="Год",
        start_date=200,
        end_date=600,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 3: ранг second (подлежит исключению фильтром по рангу)
    event_3 = await create_test_event(
        session=db_session,
        title="Секунда",
        start_date=300,
        end_date=700,
        rank=EventRank.SECOND.value,
        status=EventStatus.APPROVED.value,
    )

    # Выполнение запроса с фильтром по двум крупным рангам
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        ranks=["century", "year"],
        status=EventStatus.APPROVED.value,
    )

    # В выборку должны попасть ровно 2 события
    assert len(events) == 2
    assert {e.id for e in events} == {event_1.id, event_2.id}
    assert event_3.id not in {e.id for e in events}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_ranks_none_returns_all(db_session: AsyncSession) -> None:
    """
    Проверка отключения фильтрации по рангам при передаче ranks=None.
    Выборка возвращает события всех уровней детализации.
    """
    event_1 = await create_test_event(
        session=db_session,
        title="Век",
        start_date=100,
        end_date=500,
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
    )
    event_2 = await create_test_event(
        session=db_session,
        title="Год",
        start_date=200,
        end_date=600,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )
    event_3 = await create_test_event(
        session=db_session,
        title="Секунда",
        start_date=300,
        end_date=700,
        rank=EventRank.SECOND.value,
        status=EventStatus.APPROVED.value,
    )

    # Выполнение запроса с ranks=None
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        ranks=None,
        status=EventStatus.APPROVED.value,
    )

    # В выборку должны войти все три события
    assert len(events) == 3
    assert {e.id for e in events} == {event_1.id, event_2.id, event_3.id}


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_ranks_empty_returns_empty_without_db_query(
    db_session: AsyncSession,
) -> None:
    """
    Проверка обработки пустого набора рангов:
    - Сервисная функция list_events_in_range возвращает пустой список без обращения к базе данных;
    - Прямой вызов слоя CRUD get_events_in_range транслирует in_([]) в ложное условие и возвращает 0 записей.
    """
    await create_test_event(
        session=db_session,
        title="Год",
        start_date=200,
        end_date=600,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )

    # 1. Проверка сервисного слоя: вызов session.execute перехватывается шпионом
    with patch.object(db_session, "execute", wraps=db_session.execute) as spy_execute:
        events = await list_events_in_range(
            session=db_session,
            from_date=0,
            to_date=1000,
            ranks=[],
        )

        # Результат пуст, обращение к СУБД полностью отсутствует
        assert events == []
        spy_execute.assert_not_called()

    # 2. Проверка слоя CRUD: прямой вызов выполняет SQL-запрос с ложным предикатом
    crud_events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        ranks=[],
        status=EventStatus.APPROVED.value,
    )
    assert crud_events == []


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_categories_empty_returns_empty_list(
    db_session: AsyncSession,
) -> None:
    """
    Проверка единой семантики фильтрации по категориям в слое CRUD:
    - При передаче пустого списка categories=[] условие Event.category.in_([]) транслируется
      SQLAlchemy в заведомо ложный предикат (1 = 0), гарантируя пустую выдачу (0 записей);
    - При categories=None фильтрация по категориям отключается, возвращая все события диапазона.
    """
    # Создание трех подтвержденных событий в едином интервале [100, 500] с разными категориями
    event_culture = await create_test_event(
        session=db_session,
        title="Культурное событие",
        start_date=100,
        end_date=500,
        category=EventCategory.CULTURE.value,
        status=EventStatus.APPROVED.value,
    )
    event_politics = await create_test_event(
        session=db_session,
        title="Политическое событие",
        start_date=100,
        end_date=500,
        category=EventCategory.POLITICS.value,
        status=EventStatus.APPROVED.value,
    )
    event_science = await create_test_event(
        session=db_session,
        title="Научное событие",
        start_date=100,
        end_date=500,
        category=EventCategory.SCIENCE.value,
        status=EventStatus.APPROVED.value,
    )

    # 1. Прямой вызов слоя CRUD с пустым списком категорий categories=[]
    events_empty = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        categories=[],
        status=EventStatus.APPROVED.value,
    )

    # Выборка обязана быть гарантированно пустой
    assert events_empty == []

    # 2. Прямой вызов слоя CRUD с categories=None (фильтр категорий отключен)
    events_all = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        categories=None,
        status=EventStatus.APPROVED.value,
    )

    # При отсутствии фильтра возвращаются все три созданных события
    assert len(events_all) == 3
    assert {e.id for e in events_all} == {
        event_culture.id,
        event_politics.id,
        event_science.id,
    }


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_hash_tiebreak_is_deterministic(
    db_session: AsyncSession,
) -> None:
    """
    Проверка детерминированности псевдослучайного порядка сортировки Кнута
    для точечных событий с одинаковым рангом, датой и длительностью.
    """
    created_events = [
        await create_test_event(
            session=db_session,
            title=f"Точка года {i}",
            rank=EventRank.YEAR.value,
            start_date=1000,
            end_date=None,
            status=EventStatus.APPROVED.value,
        )
        for i in range(6)
    ]

    expected = sorted(
        created_events,
        key=lambda ev: (
            ((ev.id * RANGE_SAMPLE_HASH_MULTIPLIER) % RANGE_SAMPLE_HASH_MODULUS),
            ev.id,
        ),
    )

    events_run1 = await get_events_in_range(
        db_session,
        from_date=0,
        to_date=2000,
        status=EventStatus.APPROVED.value,
    )
    events_run2 = await get_events_in_range(
        db_session,
        from_date=0,
        to_date=2000,
        status=EventStatus.APPROVED.value,
    )

    assert [e.id for e in events_run1] == [e.id for e in expected]
    assert [e.id for e in events_run1] == [e.id for e in events_run2]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_truncation_keeps_coarse_events(
    db_session: AsyncSession,
) -> None:
    """
    Проверка усечения выборки: при превышении лимита гарантированно сохраняются
    крупные макрособытия высокого ранга (century) благодаря сортировке по depth_level.
    """
    century1 = await create_test_event(
        session=db_session,
        title="Век 1",
        rank=EventRank.CENTURY.value,
        start_date=0,
        end_date=5000,
        status=EventStatus.APPROVED.value,
    )
    century2 = await create_test_event(
        session=db_session,
        title="Век 2",
        rank=EventRank.CENTURY.value,
        start_date=0,
        end_date=5000,
        status=EventStatus.APPROVED.value,
    )

    for i in range(10):
        await create_test_event(
            session=db_session,
            title=f"День {i}",
            rank=EventRank.DAY.value,
            start_date=100 + i * 10,
            end_date=None,
            status=EventStatus.APPROVED.value,
        )

    events = await get_events_in_range(
        db_session,
        from_date=0,
        to_date=10000,
        status=EventStatus.APPROVED.value,
        limit=4,
    )

    assert len(events) == 4
    returned_ids = {e.id for e in events}
    assert century1.id in returned_ids and century2.id in returned_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_collapsed_children_count(
    db_session: AsyncSession,
) -> None:
    """
    Проверка корректного вычисления счетчика свернутых потомков collapsed_children_count:
    учитываются только подтвержденные потомки, чей ранг скрыт текущим масштабом.
    """
    parent = await create_test_event(
        session=db_session,
        title="Родитель год",
        rank=EventRank.YEAR.value,
        start_date=1000,
        end_date=2000,
        status=EventStatus.APPROVED.value,
    )

    # 2 одобренных потомка ранга day (будут скрыты масштабом)
    await create_test_event(
        session=db_session,
        title="Потомок день 1",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        start_date=1100,
        end_date=1200,
        status=EventStatus.APPROVED.value,
    )
    await create_test_event(
        session=db_session,
        title="Потомок день 2",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        start_date=1300,
        end_date=1400,
        status=EventStatus.APPROVED.value,
    )

    # 1 одобренный потомок ранга month (входит в ranks, не скрыт)
    child_month = await create_test_event(
        session=db_session,
        title="Потомок месяц",
        parent_id=parent.id,
        rank=EventRank.MONTH.value,
        start_date=1500,
        end_date=1600,
        status=EventStatus.APPROVED.value,
    )

    # 1 потомок ранга day на модерации (не должен учитываться)
    await create_test_event(
        session=db_session,
        title="Потомок день pending",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        start_date=1700,
        end_date=1800,
        status=EventStatus.PENDING.value,
    )

    # 1 отклоненный потомок ранга minute (не должен учитываться)
    await create_test_event(
        session=db_session,
        title="Потомок минута rejected",
        parent_id=parent.id,
        rank=EventRank.MINUTE.value,
        start_date=1900,
        end_date=1950,
        status=EventStatus.REJECTED.value,
    )

    # Вызов А: передаем фильтр по рангам
    events = await get_events_in_range(
        db_session,
        from_date=500,
        to_date=2500,
        ranks=["century", "decade", "year", "month"],
        status=EventStatus.APPROVED.value,
    )
    p_res = next(e for e in events if e.id == parent.id)
    assert p_res.collapsed_children_count == 2

    m_res = next(e for e in events if e.id == child_month.id)
    assert m_res.collapsed_children_count == 0

    # Вызов Б: ranks=None (все потомки считаются раскрытыми, счетчик равен 0)
    events_none = await get_events_in_range(
        db_session,
        from_date=500,
        to_date=2500,
        ranks=None,
        status=EventStatus.APPROVED.value,
    )
    assert all(e.collapsed_children_count == 0 for e in events_none)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_collapsed_count_populated_for_identity_map_objects(
    db_session: AsyncSession,
) -> None:
    """
    Проверка корректного заполнения динамического атрибута collapsed_children_count
    для сущностей, уже присутствующих в Identity Map сессии (благодаря populate_existing=True).
    """
    parent = await create_test_event(
        session=db_session,
        title="Родитель в Identity Map",
        rank=EventRank.YEAR.value,
        start_date=1000,
        end_date=2000,
        status=EventStatus.APPROVED.value,
    )
    await create_test_event(
        session=db_session,
        title="Потомок 1 в Identity Map",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        start_date=1100,
        end_date=1200,
        status=EventStatus.APPROVED.value,
    )
    await create_test_event(
        session=db_session,
        title="Потомок 2 в Identity Map",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        start_date=1300,
        end_date=1400,
        status=EventStatus.APPROVED.value,
    )

    # Не вызываем db_session.expunge_all() — объекты удерживаются в кэше сессии
    events = await get_events_in_range(
        db_session,
        from_date=500,
        to_date=2500,
        ranks=["year"],
        status=EventStatus.APPROVED.value,
    )
    p_res = next(e for e in events if e.id == parent.id)
    assert p_res.collapsed_children_count == 2
