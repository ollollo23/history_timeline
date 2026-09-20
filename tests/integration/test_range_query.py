"""
Интеграционные тесты интервальной выборки исторических событий.
Проверяет поведение запроса get_events_in_range на реальной базе данных PostgreSQL 18
с учетом отрицательных меток времени, точечных событий, хранимой колонки end_date_effective,
фильтрации по уровням детализации (рангам) и категориям[cite: 19].
"""

from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

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
    генерируемой колонки end_date_effective и возвращает созданный объект Event[cite: 19].
    """
    # Базовые валидные значения для соблюдения CheckConstraint таблицы events[cite: 19]
    attributes = {
        "title": "Тестовое событие",
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
        "status": EventStatus.APPROVED.value,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
    }
    # Переопределение атрибутов переданными параметрами теста[cite: 19]
    attributes.update(kwargs)

    event = Event(**attributes)
    session.add(event)

    # Вызов flush отправляет INSERT в PostgreSQL для вычисления end_date_effective[cite: 19]
    await session.flush()
    return event


@pytest.mark.integration
@pytest.mark.asyncio
async def test_negative_timestamps_bce_range(db_session: AsyncSession) -> None:
    """
    Проверка выборки событий с отрицательными метками времени (до нашей эры).
    Событие А попадает в диапазон, событие Б находится за его пределами[cite: 19].
    """
    # Событие А: [-100 000, -50 000] — пересекает диапазон [-150 000, -40 000][cite: 19]
    event_a = await create_test_event(
        session=db_session,
        title="Событие А (до н.э.)",
        start_date=-100000,
        end_date=-50000,
    )
    # Событие Б: [-300 000, -250 000] — завершилось до начала диапазона [-150 000, -40 000][cite: 19]
    await create_test_event(
        session=db_session,
        title="Событие Б (до н.э.)",
        start_date=-300000,
        end_date=-250000,
    )

    # Выполнение интервальной выборки[cite: 19]
    events = await get_events_in_range(
        session=db_session,
        from_date=-150000,
        to_date=-40000,
        status=EventStatus.APPROVED.value,
    )

    # В выборку должно попасть только событие А[cite: 19]
    event_ids = [event.id for event in events]
    assert event_ids == [event_a.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_point_event_inside_range(db_session: AsyncSession) -> None:
    """
    Проверка включения точечного события (end_date is None) внутрь диапазона.
    Поведение обеспечивается хранимой колонкой end_date_effective = start_date[cite: 19].
    """
    # Точечное событие в точке 500 внутри диапазона [0, 1000][cite: 19]
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
    Проверка исключения точечных событий, находящихся слева и справа от диапазона[cite: 19].
    """
    # Точечное событие левее диапазона [0, 1000][cite: 19]
    await create_test_event(
        session=db_session,
        title="Точечное событие слева",
        start_date=-500,
        end_date=None,
    )
    # Точечное событие правее диапазона [0, 1000][cite: 19]
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

    # Ни одно точечное событие вне диапазона не должно вернуться[cite: 19]
    assert len(events) == 0


@pytest.mark.integration
@pytest.mark.asyncio
async def test_interval_crossing_left_boundary(db_session: AsyncSession) -> None:
    """
    Проверка пересечения левой границы диапазона:
    событие началось до from_date, но завершилось внутри диапазона[cite: 19].
    """
    # Интервал [-200, 300] пересекает левую границу диапазона [0, 1000][cite: 19]
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
    событие началось внутри диапазона, но завершилось после to_date[cite: 19].
    """
    # Интервал [800, 1500] пересекает правую границу диапазона [0, 1000][cite: 19]
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
    началось до from_date и закончилось после to_date[cite: 19].
    """
    # Интервал [-500, 2000] полностью накрывает диапазон [0, 1000][cite: 19]
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
    Оба граничных события должны попадать в нестрогое условие пересечения[cite: 19].
    """
    # Событие касается левой границы: окончание ровно в from_date (0)[cite: 19]
    touch_left = await create_test_event(
        session=db_session,
        title="Касание левой границы",
        start_date=-500,
        end_date=0,
    )
    # Точечное событие касается правой границы: начало ровно в to_date (1000)[cite: 19]
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
    сначала по start_date.asc(), затем по end_date_effective.asc()[cite: 19].
    """
    # Событие 1: start=500, effective=1500[cite: 19]
    event_1 = await create_test_event(
        session=db_session,
        title="Событие 1 (500, 1500)",
        start_date=500,
        end_date=1500,
    )
    # Событие 2: start=100, effective=100[cite: 19]
    event_2 = await create_test_event(
        session=db_session,
        title="Событие 2 (100, point)",
        start_date=100,
        end_date=None,
    )
    # Событие 3: start=500, effective=800[cite: 19]
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

    # Ожидаемый хронологический порядок: event_2 (100), event_3 (500, 800), event_1 (500, 1500)[cite: 19]
    event_ids = [e.id for e in events]
    assert event_ids == [event_2.id, event_3.id, event_1.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_filtering_category_and_status(db_session: AsyncSession) -> None:
    """
    Проверка фильтрации по нескольким категориям и строгому статусу модерации[cite: 19].
    """
    # Событие 1: подходит по категории (SCIENCE) и статусу (APPROVED)[cite: 19]
    event_1 = await create_test_event(
        session=db_session,
        title="Наука Одобрено",
        start_date=100,
        end_date=200,
        category=EventCategory.SCIENCE.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 2: подходит по категории (CULTURE) и статусу (APPROVED)[cite: 19]
    event_2 = await create_test_event(
        session=db_session,
        title="Культура Одобрено",
        start_date=200,
        end_date=300,
        category=EventCategory.CULTURE.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 3: не подходит по статусу (PENDING)[cite: 19]
    await create_test_event(
        session=db_session,
        title="Наука На модерации",
        start_date=300,
        end_date=400,
        category=EventCategory.SCIENCE.value,
        status=EventStatus.PENDING.value,
    )
    # Событие 4: не подходит по категории (POLITICS)[cite: 19]
    await create_test_event(
        session=db_session,
        title="Политика Одобрено",
        start_date=400,
        end_date=500,
        category=EventCategory.POLITICS.value,
        status=EventStatus.APPROVED.value,
    )

    # Запрос с фильтрацией по двум категориям и статусу 'approved'[cite: 19]
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        categories=[EventCategory.SCIENCE.value, EventCategory.CULTURE.value],
        status=EventStatus.APPROVED.value,
    )

    # В результат должны войти только событие 1 и событие 2[cite: 19]
    event_ids = [e.id for e in events]
    assert event_ids == [event_1.id, event_2.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_filtering_by_ranks(db_session: AsyncSession) -> None:
    """
    Проверка фильтрации событий по перечню выбранных рангов детализации на уровне SQL-запроса[cite: 19].
    """
    # Событие 1: ранг century (подлежит включению)[cite: 19]
    event_1 = await create_test_event(
        session=db_session,
        title="Век",
        start_date=100,
        end_date=500,
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 2: ранг year (подлежит включению)[cite: 19]
    event_2 = await create_test_event(
        session=db_session,
        title="Год",
        start_date=200,
        end_date=600,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )
    # Событие 3: ранг second (подлежит исключению фильтром по рангу)[cite: 19]
    event_3 = await create_test_event(
        session=db_session,
        title="Секунда",
        start_date=300,
        end_date=700,
        rank=EventRank.SECOND.value,
        status=EventStatus.APPROVED.value,
    )

    # Выполнение запроса с фильтром по двум крупным рангам[cite: 19]
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        ranks=["century", "year"],
        status=EventStatus.APPROVED.value,
    )

    # В выборку должны попасть ровно 2 события[cite: 19]
    assert len(events) == 2
    event_ids = [event.id for event in events]
    assert event_1.id in event_ids
    assert event_2.id in event_ids
    assert event_3.id not in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_ranks_none_returns_all(db_session: AsyncSession) -> None:
    """
    Проверка отключения фильтрации по рангам при передаче ranks=None.
    Выборка возвращает события всех уровней детализации[cite: 19].
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

    # Выполнение запроса с ranks=None[cite: 19]
    events = await get_events_in_range(
        session=db_session,
        from_date=0,
        to_date=1000,
        ranks=None,
        status=EventStatus.APPROVED.value,
    )

    # В выборку должны войти все три события[cite: 19]
    assert len(events) == 3
    event_ids = [event.id for event in events]
    assert event_1.id in event_ids
    assert event_2.id in event_ids
    assert event_3.id in event_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_range_query_ranks_empty_returns_empty_without_db_query(
    db_session: AsyncSession,
) -> None:
    """
    Проверка обработки пустого набора рангов:
    - Сервисная функция list_events_in_range возвращает пустой список без обращения к базе данных;
    - Прямой вызов слоя CRUD get_events_in_range транслирует in_([]) в ложное условие и возвращает 0 записей[cite: 19].
    """
    await create_test_event(
        session=db_session,
        title="Год",
        start_date=200,
        end_date=600,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )

    # 1. Проверка сервисного слоя: вызов session.execute перехватывается шпионом[cite: 19]
    with patch.object(db_session, "execute", wraps=db_session.execute) as spy_execute:
        events = await list_events_in_range(
            session=db_session,
            from_date=0,
            to_date=1000,
            ranks=[],
        )

        # Результат пуст, обращение к СУБД полностью отсутствует[cite: 19]
        assert events == []
        spy_execute.assert_not_called()

    # 2. Проверка слоя CRUD: прямой вызов выполняет SQL-запрос с ложным предикатом[cite: 19]
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
    event_ids = [event.id for event in events_all]
    assert event_culture.id in event_ids
    assert event_politics.id in event_ids
    assert event_science.id in event_ids
