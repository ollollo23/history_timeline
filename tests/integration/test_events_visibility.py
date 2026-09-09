"""
Интеграционные тесты политики публичной видимости исторических событий.
Проверяет сокрытие немодерированных записей (status='pending') из публичной выдачи
и их доступность в списке после перевода в статус 'approved'.
"""

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventCategory, EventRank, EventStatus
from app.models.event import Event


@pytest.mark.integration
@pytest.mark.asyncio
async def test_created_event_is_pending_and_hidden_from_public_list(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка сокрытия созданного события со статусом pending из публичного списка.
    Создает запись через POST /api/v1/events/ и убеждается, что эндпоинт
    GET /api/v1/events/ фильтрует немодерированный контент.
    """
    # Полезная нагрузка создания нового события
    payload = {
        "title": "Черновое событие",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
    }

    # Создание записи через API
    create_response = await integration_client.post("/api/v1/events/", json=payload)
    assert create_response.status_code == status.HTTP_201_CREATED

    # Проверка фиксации начального статуса pending
    created_data = create_response.json()
    assert created_data["status"] == EventStatus.PENDING.value
    event_id = created_data["id"]

    # Запрос публичного списка событий
    list_response = await integration_client.get("/api/v1/events/")
    assert list_response.status_code == status.HTTP_200_OK

    # Проверка отсутствия чернового события в публичной выдаче
    returned_ids = [item["id"] for item in list_response.json()]
    assert event_id not in returned_ids


@pytest.mark.integration
@pytest.mark.asyncio
async def test_approved_event_becomes_visible_in_public_list(
    integration_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """
    Проверка появления события в публичном списке после перевода в статус approved.
    Создает событие со статусом pending, переводит его в approved напрямую
    через транзакционную сессию db_session и проверяет его выдачу в GET /api/v1/events/.
    """
    # Создание исходного события со статусом pending через API
    payload = {
        "title": "Событие для одобрения",
        "start_date": 2000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
    }
    create_response = await integration_client.post("/api/v1/events/", json=payload)
    assert create_response.status_code == status.HTTP_201_CREATED

    event_id = create_response.json()["id"]

    # Получение объекта из общей сессии интеграционного теста
    db_event = await db_session.get(Event, event_id)
    assert db_event is not None

    # Имитация действия модератора: перевод статуса в approved
    db_event.status = EventStatus.APPROVED.value
    await db_session.flush()

    # Запрос публичного списка событий
    list_response = await integration_client.get("/api/v1/events/")
    assert list_response.status_code == status.HTTP_200_OK

    # Подтверждение присутствия одобренного события в публичной выдаче
    returned_ids = [item["id"] for item in list_response.json()]
    assert event_id in returned_ids
