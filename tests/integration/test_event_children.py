"""
Интеграционные тесты эндпоинта выборки дочерних событий GET /api/v1/events/{event_id}/children.
Проверяет постраничную структуру ответа EventChildrenPage, хронологическую сортировку потомков,
изоляцию неодобренных записей, корректность подсчета поля total и защиту приватных веток
дерева на реальной базе данных PostgreSQL 18.
"""

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.models.event import Event


async def create_test_event(
    session: AsyncSession,
    **kwargs,
) -> Event:
    """
    Вспомогательная фабрика создания тестовых событий в реальной базе данных.
    Заполняет дефолтные валидные значения полей, переопределяет их переданными аргументами,
    отправляет INSERT через flush для расчета end_date_effective и возвращает объект Event.
    """
    attributes = {
        "title": "Тестовое событие",
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
        "status": EventStatus.APPROVED.value,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
        "start_date": 1000,
        "end_date": None,
    }
    attributes.update(kwargs)

    event = Event(**attributes)
    session.add(event)

    # Вызов flush генерирует первичный ключ id без фиксации транзакции
    await session.flush()
    return event


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_event_children_success_ordering(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка успешного получения страницы дочерних событий со структурой EventChildrenPage.
    Потомки в массиве items обязаны возвращаться упорядоченными по возрастанию start_date.
    """
    # Создание подтвержденного родительского события верхнего ранга
    parent = await create_test_event(
        session=db_session,
        title="Родительское событие века",
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
        start_date=0,
        end_date=10000,
    )

    # Создание трех подтвержденных дочерних событий с возрастающими датами начала
    child1 = await create_test_event(
        session=db_session,
        title="Потомок 1 (Десятилетие)",
        parent_id=parent.id,
        rank=EventRank.DECADE.value,
        status=EventStatus.APPROVED.value,
        start_date=100,
        end_date=200,
    )
    child2 = await create_test_event(
        session=db_session,
        title="Потомок 2 (Год)",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        start_date=300,
        end_date=400,
    )
    child3 = await create_test_event(
        session=db_session,
        title="Потомок 3 (День)",
        parent_id=parent.id,
        rank=EventRank.DAY.value,
        status=EventStatus.APPROVED.value,
        start_date=500,
        end_date=None,
    )

    # Запрос дочерних событий через публичный REST API с реальной сессией БД
    response = await integration_client.get(f"/api/v1/events/{parent.id}/children")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert isinstance(data, dict)
    assert data["total"] == 3
    assert data["skip"] == 0
    assert data["limit"] == 100

    items = data["items"]
    assert isinstance(items, list)
    assert len(items) == 3

    # Проверка строгой хронологической последовательности идентификаторов в ответе
    assert [item["id"] for item in items] == [child1.id, child2.id, child3.id]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_event_children_filters_non_approved(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка фильтрации немодерированных дочерних событий.
    В публичную выдачу и в счетчик total должны попадать только потомки со статусом approved.
    """
    # Создание подтвержденного родителя
    parent = await create_test_event(
        session=db_session,
        title="Родительское событие",
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
    )

    # Создание двух потомков: подтвержденного и ожидающего модерации
    child_approved = await create_test_event(
        session=db_session,
        title="Одобренный потомок",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        start_date=100,
        end_date=200,
    )
    await create_test_event(
        session=db_session,
        title="Потомок на модерации",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.PENDING.value,
        start_date=300,
        end_date=400,
    )

    response = await integration_client.get(f"/api/v1/events/{parent.id}/children")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert isinstance(data, dict)

    # Поле total обязано учитывать только одобренных потомков со статусом approved
    assert data["total"] == 1
    assert len(data["items"]) == 1
    assert data["items"][0]["id"] == child_approved.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_event_children_parent_not_found(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запроса дочерних событий для несуществующего родителя.
    Ожидается возврат HTTP 404 Not Found со стандартизированным сообщением.
    """
    response = await integration_client.get("/api/v1/events/999999/children")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert "detail" in data
    assert "Историческое событие с ID 999999 не найдено" in data["detail"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_event_children_parent_pending_returns_404(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка защиты приватных веток: запрос потомков родителя в статусе pending.
    Эндпоинт обязан возвращать 404 Not Found, предотвращая утечку информации о немодерированных данных.
    """
    # Создание родительского события, ожидающего проверки модератором
    parent = await create_test_event(
        session=db_session,
        title="Родитель на модерации",
        rank=EventRank.CENTURY.value,
        status=EventStatus.PENDING.value,
    )

    # Создание одобренного дочернего события для немодерированного родителя
    await create_test_event(
        session=db_session,
        title="Одобренный потомок",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
    )

    response = await integration_client.get(f"/api/v1/events/{parent.id}/children")

    # Проверка возбуждения 404 Not Found вместо 200 OK с пустым списком
    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert f"Историческое событие с ID {parent.id} не найдено" in data["detail"]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_get_event_children_pagination(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка корректной работы параметров пагинации (skip и limit).
    Запрос со смещением skip=1 и ограничением limit=1 обязан вернуть второй по хронологии элемент,
    сохраняя общее количество подтвержденных потомков в поле total.
    """
    parent = await create_test_event(
        session=db_session,
        title="Родитель века",
        rank=EventRank.CENTURY.value,
        status=EventStatus.APPROVED.value,
    )

    # Создание трех последовательных потомков
    await create_test_event(
        session=db_session,
        title="Первый потомок",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        start_date=100,
    )
    child2 = await create_test_event(
        session=db_session,
        title="Второй потомок",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        start_date=200,
    )
    await create_test_event(
        session=db_session,
        title="Третий потомок",
        parent_id=parent.id,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        start_date=300,
    )

    # Выполнение запроса пагинации со смещением на один элемент через integration_client
    response = await integration_client.get(f"/api/v1/events/{parent.id}/children?skip=1&limit=1")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert isinstance(data, dict)
    assert data["total"] == 3
    assert data["skip"] == 1
    assert data["limit"] == 1
    assert len(data["items"]) == 1
    assert data["items"][0]["id"] == child2.id
