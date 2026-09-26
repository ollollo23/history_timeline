"""
Интеграционные тесты валидации древовидной иерархии исторических событий.
Проверяет правила детализации масштабов EventRank, защиту от циклических ссылок,
требование одобренного статуса модерации родителей и корректность разрешения конфликтов
рангов на реальной базе данных PostgreSQL 18.
"""

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.models.event import Event


async def approve_event(session: AsyncSession, event_id: int) -> None:
    """
    Вспомогательная функция перевода события в подтвержденный статус (approved).
    Используется в интеграционных тестах для подготовки одобренных родителей перед привязкой.
    """
    stmt = select(Event).where(Event.id == event_id)
    event = (await session.execute(stmt)).scalar_one()
    event.status = EventStatus.APPROVED.value
    await session.flush()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_create_child_event_valid_hierarchy(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка успешного создания дочернего события с корректным отношением масштабов.
    Родительское событие ранга 'century' успешно принимает дочернее событие ранга 'year'.
    """
    # 1. Создание родительского макро-события крупного масштаба (век)
    parent_payload = {
        "title": "Век Просвещения",
        "start_date": -8000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # Одобрение родителя для разрешения привязки дочерних записей
    await approve_event(db_session, parent_id)

    # 2. Создание дочернего события более мелкого масштаба (год) с привязкой к родителю
    child_payload = {
        "title": "Издание Энциклопедии",
        "start_date": -6800000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.YEAR.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)

    # Валидация успешного создания и сохранения иерархических атрибутов
    assert child_response.status_code == status.HTTP_201_CREATED
    child_data = child_response.json()
    assert child_data["parent_id"] == parent_id
    assert child_data["rank"] == EventRank.YEAR.value


@pytest.mark.integration
@pytest.mark.asyncio
async def test_create_child_event_same_rank_forbidden(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка запрета создания дочернего события с рангом, совпадающим с рангом родителя.
    Масштаб родительского события обязан быть строго крупнее масштаба дочернего узла.
    """
    # 1. Создание родительского события ранга 'century'
    parent_payload = {
        "title": "Эпоха Возрождения",
        "start_date": -16000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # Одобрение родителя в базе данных
    await approve_event(db_session, parent_id)

    # 2. Попытка создания дочернего события с идентичным рангом 'century'
    child_payload = {
        "title": "Высокое Возрождение",
        "start_date": -15000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)

    # Валидация отклонения операции с доменной ошибкой 400 Bad Request
    assert child_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = child_response.json()["detail"]
    assert "Ранг родительского события" in error_detail
    assert "должен быть строго крупнее ранга дочернего события" in error_detail


@pytest.mark.integration
@pytest.mark.asyncio
async def test_create_child_event_nonexistent_parent_not_found(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка отклонения создания события с указанием несуществующего parent_id.
    Сервисный слой обязан выбросить EventNotFoundError со статусом 404 Not Found.
    """
    payload = {
        "title": "Событие без существующего предка",
        "start_date": 1000,
        "category": EventCategory.POLITICS.value,
        "parent_id": 999999,
    }
    response = await integration_client.post("/api/v1/events/", json=payload)

    # Валидация корректного статуса и идентификатора отсутствующего объекта в ответе
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "999999" in response.json()["detail"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_create_child_event_pending_parent_returns_not_found(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета привязки к родителю, находящемуся в статусе pending.
    Эндпоинт обязан возвращать 404 Not Found без раскрытия ранга и метаданных родителя.
    """
    # 1. Создание родительского события (по умолчанию статус pending)
    parent_payload = {
        "title": "Родитель на модерации",
        "start_date": 0,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # 2. Попытка создать дочернее событие с привязкой к неодобренному родителю
    child_payload = {
        "title": "Дочернее событие",
        "start_date": 500,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.YEAR.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)

    assert child_response.status_code == status.HTTP_404_NOT_FOUND
    assert child_response.json()["detail"] == f"Историческое событие с ID {parent_id} не найдено"
    assert EventRank.CENTURY.value not in child_response.json()["detail"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_event_self_parent_forbidden(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета создания циклической ссылки на самого себя через PATCH-запрос.
    Событие не может являться родителем для самого себя (parent_id == id).
    """
    # 1. Создание исходного исторического события
    create_payload = {
        "title": "Автономное событие",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
    }
    create_response = await integration_client.post("/api/v1/events/", json=create_payload)
    assert create_response.status_code == status.HTTP_201_CREATED
    event_id = create_response.json()["id"]

    # 2. Попытка установить parent_id, равный собственному идентификатору события
    patch_payload = {"parent_id": event_id}
    patch_response = await integration_client.patch(
        f"/api/v1/events/{event_id}",
        json=patch_payload,
    )

    # Валидация блокировки циклической зависимости
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    assert (
        "Событие не может быть родительским по отношению к самому себе"
        in patch_response.json()["detail"]
    )


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_event_link_to_pending_parent_returns_not_found(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета привязки к родителю в статусе pending через PATCH (Случай А).
    Запрос возвращает 404 Not Found без раскрытия информации о существовании записи.
    """
    # 1. Создание обновляемого события 1
    event1_payload = {
        "title": "Событие 1",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
    }
    event1_resp = await integration_client.post("/api/v1/events/", json=event1_payload)
    assert event1_resp.status_code == status.HTTP_201_CREATED
    event1_id = event1_resp.json()["id"]

    # 2. Создание события 2 (будущий родитель со статусом pending)
    event2_payload = {
        "title": "Событие 2 (родитель)",
        "start_date": 0,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    event2_resp = await integration_client.post("/api/v1/events/", json=event2_payload)
    assert event2_resp.status_code == status.HTTP_201_CREATED
    event2_id = event2_resp.json()["id"]

    # 3. Попытка привязать событие 1 к неодобренному событию 2
    patch_response = await integration_client.patch(
        f"/api/v1/events/{event1_id}",
        json={"parent_id": event2_id},
    )
    assert patch_response.status_code == status.HTTP_404_NOT_FOUND
    assert patch_response.json()["detail"] == f"Историческое событие с ID {event2_id} не найдено"
    assert EventRank.CENTURY.value not in patch_response.json()["detail"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_child_rank_larger_than_parent_forbidden(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка запрета обновления ранга дочернего события до значения крупнее ранга родителя (Случай Б).
    Попытка сделать дочерний узел крупнее существующего предка должна пресекаться.
    """
    # 1. Создание родительского события ранга 'decade'
    parent_payload = {
        "title": "Холодная война (шестидесятые)",
        "start_date": -315576000,
        "category": EventCategory.POLITICS.value,
        "rank": EventRank.DECADE.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # Одобрение родителя в базе данных
    await approve_event(db_session, parent_id)

    # 2. Создание дочернего события ранга 'year'
    child_payload = {
        "title": "Карибский кризис",
        "start_date": -228873600,
        "category": EventCategory.POLITICS.value,
        "rank": EventRank.YEAR.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)
    assert child_response.status_code == status.HTTP_201_CREATED
    child_id = child_response.json()["id"]

    # 3. Попытка изменить ранг дочернего события на 'century', который крупнее 'decade' родителя
    patch_response = await integration_client.patch(
        f"/api/v1/events/{child_id}",
        json={"rank": EventRank.CENTURY.value},
    )

    # Валидация ошибки нарушения ранговой иерархии
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = patch_response.json()["detail"]
    assert "не может быть равен или крупнее ранга существующего родителя" in error_detail


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_parent_rank_smaller_than_existing_children_forbidden(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка запрета обновления ранга родителя до значения мельче существующих дочерних узлов (Случай В).
    Предотвращает инверсию дерева детализации при наличии прямых потомков.
    """
    # 1. Создание родительского события крупного масштаба (век)
    parent_payload = {
        "title": "Девятнадцатый век",
        "start_date": -5364662400,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # Одобрение родителя в базе данных
    await approve_event(db_session, parent_id)

    # 2. Создание дочернего узла среднего масштаба (десятилетие)
    child_payload = {
        "title": "Викторианская эпоха (ранний период)",
        "start_date": -4102444800,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.DECADE.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)
    assert child_response.status_code == status.HTTP_201_CREATED
    child_id = child_response.json()["id"]

    # 3. Попытка понизить ранг родительского узла до уровня 'day', который мельче ранга потомка 'decade'
    patch_response = await integration_client.patch(
        f"/api/v1/events/{parent_id}",
        json={"rank": EventRank.DAY.value},
    )

    # Валидация блокировки инверсии дерева с указанием ID потомка и конфликтующих рангов
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = patch_response.json()["detail"]
    assert str(child_id) in error_detail
    assert EventRank.DAY.value in error_detail
    assert EventRank.DECADE.value in error_detail


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_parent_rank_conflict_detected_beyond_first_hundred_children(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка детекции конфликта рангов (Случай В) при наличии более 100 потомков.
    Одиночный запрос get_first_child_with_depth_at_most обязан выявить конфликтующий
    узел за пределами первой сотни записей без ограничений пагинации.
    """
    # 1. Создание родительского события века со статусом approved
    parent = Event(
        title="Родитель века",
        category=EventCategory.CULTURE.value,
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
        start_date=0,
        calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
    )
    db_session.add(parent)
    await db_session.flush()

    # 2. Создание 100 одобренных потомков ранга day с ранними датами начала
    children = [
        Event(
            title=f"Потомок день {i}",
            category=EventCategory.CULTURE.value,
            rank=EventRank.DAY.value,
            status=EventStatus.APPROVED.value,
            start_date=100 + i,
            parent_id=parent.id,
            calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
        )
        for i in range(100)
    ]

    # 3. Создание 101-го потомка ранга decade с поздней датой начала
    decade_child = Event(
        title="Потомок десятилетие (конфликтующий)",
        category=EventCategory.CULTURE.value,
        rank=EventRank.DECADE.value,
        status=EventStatus.APPROVED.value,
        start_date=50000,
        parent_id=parent.id,
        calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
    )
    children.append(decade_child)

    db_session.add_all(children)
    await db_session.flush()

    decade_child_id = decade_child.id

    # 4. Попытка понизить ранг родителя до year (decade крупнее year -> конфликт)
    patch_response = await integration_client.patch(
        f"/api/v1/events/{parent.id}",
        json={"rank": EventRank.YEAR.value},
    )

    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    detail = patch_response.json()["detail"]
    assert str(decade_child_id) in detail
    assert "decade" in detail


@pytest.mark.integration
@pytest.mark.asyncio
async def test_update_parent_rank_allowed_when_all_children_finer(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка успешного обновления ранга родителя при наличии более 100 потомков,
    если все потомки имеют строго более мелкий масштаб, чем целевой ранг.
    """
    # 1. Создание родительского события века
    parent = Event(
        title="Родитель века для понижения",
        category=EventCategory.CULTURE.value,
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
        start_date=0,
        calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
    )
    db_session.add(parent)
    await db_session.flush()

    # 2. Создание 101 потомка ранга day (day строго мельче month)
    children = [
        Event(
            title=f"Потомок день {i}",
            category=EventCategory.CULTURE.value,
            rank=EventRank.DAY.value,
            status=EventStatus.APPROVED.value,
            start_date=100 + i,
            parent_id=parent.id,
            calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
        )
        for i in range(101)
    ]
    db_session.add_all(children)
    await db_session.flush()

    # 3. Понижение ранга родителя до month
    patch_response = await integration_client.patch(
        f"/api/v1/events/{parent.id}",
        json={"rank": EventRank.MONTH.value},
    )

    assert patch_response.status_code == status.HTTP_200_OK
    assert patch_response.json()["rank"] == EventRank.MONTH.value
