"""
Интеграционные тесты паттерна Unit of Work и генератора зависимостей get_db.
Проверяет реальный жизненный цикл сессии SQLAlchemy: успешную фиксацию (commit)
и автоматический откат (rollback) при доменных сбоях и ошибках целостности СУБД.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.enums import EventCategory, EventRank
from app.models.event import Event


@pytest.mark.integration
async def test_uow_commit_persists_event(
    uow_client: AsyncClient,
    test_engine: AsyncEngine,
) -> None:
    """
    Проверка успешной фиксации изменений (commit) в базе данных через генератор get_db.
    Убеждается, что после ответа 201 Created сущность доступна через независимую сессию.
    """
    payload = {
        "title": "Событие фиксации UoW",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
    }

    # Выполнение запроса на создание события через клиент со сквозным вызовом get_db
    response = await uow_client.post("/api/v1/events/", json=payload)

    # Валидация успешного HTTP-статуса создания записи
    assert response.status_code == status.HTTP_201_CREATED
    event_id = response.json()["id"]

    # Открытие полностью изолированной сессии напрямую через движок базы данных
    async with AsyncSession(test_engine) as independent_session:
        db_event = await independent_session.get(Event, event_id)

    # Подтверждение фактического сохранения объекта в СУБД после завершения запроса
    assert db_event is not None
    assert db_event.title == "Событие фиксации UoW"


@pytest.mark.integration
async def test_uow_rollback_on_not_found(
    uow_client: AsyncClient,
    test_engine: AsyncEngine,
) -> None:
    """
    Проверка автоматического отката транзакции (rollback) при доменной ошибке 404 Not Found.
    Убеждается, что при генерации EventNotFoundError в базу не записываются остаточные данные.
    """
    payload = {
        "title": "Событие с несуществующим родителем",
        "start_date": 1000,
        "category": EventCategory.POLITICS.value,
        "parent_id": 999999,
    }

    # Отправка запроса с заведомо отсутствующим идентификатором предка
    response = await uow_client.post("/api/v1/events/", json=payload)

    # Проверка получения регламентированного статуса отсутствия ресурса
    assert response.status_code == status.HTTP_404_NOT_FOUND

    # Контрольная проверка количества записей в таблице events через прямое подключение
    async with test_engine.connect() as conn:
        result = await conn.execute(text("SELECT count(*) FROM events"))
        assert result.scalar() == 0


@pytest.mark.integration
async def test_uow_rollback_on_integrity_error(
    uow_client: AsyncClient,
    test_engine: AsyncEngine,
) -> None:
    """
    Проверка автоматического отката транзакции (rollback) при нарушении ограничений целостности СУБД.
    Эмулирует обход проверки родителя в сервисе для провокации реального сбоя внешнего ключа в PostgreSQL.
    """
    # Создание фиктивного объекта родителя для прохождения валидации масштабов в сервисном слое
    fake_parent = Event(
        id=999999,
        rank=EventRank.CENTURY.value,
        start_date=1000,
        end_date_effective=1000,
        category="science",
        calendar_system="gregorian_proleptic",
        status="approved",
        title="Фиктивный предок",
    )

    payload = {
        "title": "Событие с нарушением внешнего ключа",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "parent_id": 999999,
        "rank": EventRank.YEAR.value,
    }

    # Подмена выборки предка в сервисе для передачи несуществующего parent_id на этап flush в базу
    with patch(
        "app.services.event_service.crud_get_event_by_id",
        new_callable=AsyncMock,
    ) as mock_get_parent:
        mock_get_parent.return_value = fake_parent

        # Выполнение POST-запроса, вызывающего ошибку внешнего ключа в PostgreSQL 18
        response = await uow_client.post("/api/v1/events/", json=payload)

    # Проверка перехвата ошибки целостности централизованным обработчиком со статусом 409
    assert response.status_code == status.HTTP_409_CONFLICT

    # Проверка чистоты базы данных: транзакция откатана, записи в таблице отсутствуют
    async with test_engine.connect() as conn:
        result = await conn.execute(text("SELECT count(*) FROM events"))
        assert result.scalar() == 0
