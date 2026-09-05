"""
Модульные тесты HTTP-эндпоинтов управления событиями /api/v1/events.
Проверяет маршрутизацию, HTTP-статусы, валидацию Pydantic v2 и доменные исключения
с использованием фикстуры mock_db_session без подключения к базе данных.
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import status
from httpx import AsyncClient

from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.models.event import Event


def build_mock_event(**kwargs) -> Event:
    """
    Вспомогательная фабрика для сборки экземпляра ORM-модели Event в памяти.
    Заполняет все обязательные поля сущности системными значениями по умолчанию.
    """
    now = datetime.now(UTC)
    defaults = {
        "id": 1,
        "title": "Тестовое событие",
        "description": "Описание",
        "start_date": 1000,
        "end_date": 2000,
        "end_date_effective": 2000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
        "parent_id": None,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
        "media_payload": None,
        "status": EventStatus.PENDING.value,
        "created_at": now,
        "updated_at": now,
    }
    defaults.update(kwargs)
    return Event(**defaults)


@pytest.mark.unit
async def test_create_event_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка успешного создания исторического события через POST /api/v1/events/.
    Сессия мокирует установку первичного ключа и отметок времени при flush,
    проверяется статус 201 Created и статус модерации pending.
    """

    # Настройка сайд-эффекта: присвоение id и серверных меток времени во время session.flush()
    async def mock_flush() -> None:
        if mock_db_session.add.call_args:
            added_obj = mock_db_session.add.call_args[0][0]
            if getattr(added_obj, "id", None) is None:
                added_obj.id = 1

            now = datetime.now(UTC)
            if getattr(added_obj, "created_at", None) is None:
                added_obj.created_at = now
            if getattr(added_obj, "updated_at", None) is None:
                added_obj.updated_at = now

    mock_db_session.flush.side_effect = mock_flush

    payload = {
        "title": "Основание Санкт-Петербурга",
        "description": "Заложение Петропавловской крепости",
        "start_date": -7760976000,
        "end_date": None,
        "category": EventCategory.POLITICS.value,
    }

    response = await async_client.post("/api/v1/events/", json=payload)

    assert response.status_code == status.HTTP_201_CREATED
    data = response.json()
    assert data["id"] == 1
    assert data["title"] == payload["title"]
    assert data["start_date"] == payload["start_date"]
    assert data["status"] == EventStatus.PENDING.value


@pytest.mark.unit
async def test_create_event_status_field_forbidden(
    async_client: AsyncClient,
) -> None:
    """
    Проверка запрета передачи поля status при создании события.
    Конфигурация extra='forbid' в схеме EventCreate возвращает статус 422.
    """
    payload = {
        "title": "Попытка взлома статуса",
        "start_date": 1000,
        "category": EventCategory.POLITICS.value,
        "status": EventStatus.APPROVED.value,
    }

    response = await async_client.post("/api/v1/events/", json=payload)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.unit
async def test_create_event_validation_error(
    async_client: AsyncClient,
) -> None:
    """
    Проверка валидации обязательных полей запроса на создание.
    Отсутствие title и start_date приводит к ошибке 422 Unprocessable Content.
    """
    payload = {
        "description": "Событие без обязательного заголовка и даты начала",
        "category": EventCategory.SCIENCE.value,
    }

    response = await async_client.post("/api/v1/events/", json=payload)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.unit
async def test_get_events_list_pagination(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка постраничной выборки событий через GET /api/v1/events/.
    Валидирует статус 200 OK, длину результирующего массива и вызов сессии.
    """
    mock_event = build_mock_event(id=10, title="Пагинированное событие")
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [mock_event]
    mock_db_session.execute.return_value = mock_result

    response = await async_client.get("/api/v1/events/?skip=10&limit=25")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["id"] == 10
    assert mock_db_session.execute.called


@pytest.mark.unit
async def test_get_events_in_range_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка успешного запроса интервальной выборки GET /api/v1/events/range.
    Валидирует статус 200 OK и работу фильтра по умолчанию (status='approved').
    """
    mock_event = build_mock_event(id=2, status=EventStatus.APPROVED.value)
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [mock_event]
    mock_db_session.execute.return_value = mock_result

    response = await async_client.get("/api/v1/events/range?from_date=0&to_date=5000")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["id"] == 2
    assert mock_db_session.execute.called


@pytest.mark.unit
async def test_get_events_in_range_invalid_bounds(
    async_client: AsyncClient,
) -> None:
    """
    Проверка валидации границ интервала при to_date < from_date.
    Ожидается статус 400 Bad Request с доменным текстом ошибки.
    """
    response = await async_client.get("/api/v1/events/range?from_date=5000&to_date=1000")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    data = response.json()
    assert (
        data["detail"]
        == "Конечная дата диапазона (to_date) не может быть меньше начальной даты (from_date)."
    )


@pytest.mark.unit
async def test_get_event_by_id_found(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка получения конкретного исторического события по существующему ID.
    Ожидается статус 200 OK и полное соответствие атрибутов.
    """
    mock_event = build_mock_event(id=1, title="Конкретное событие")
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_event
    mock_db_session.execute.return_value = mock_result

    response = await async_client.get("/api/v1/events/1")

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["id"] == 1
    assert data["title"] == "Конкретное событие"


@pytest.mark.unit
async def test_get_event_by_id_not_found(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка запроса несуществующего события по ID.
    Ожидается статус 404 Not Found с сообщением EventNotFoundError.
    """
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await async_client.get("/api/v1/events/999")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert "Историческое событие с ID 999 не найдено" in data["detail"]


@pytest.mark.unit
async def test_update_event_clear_end_date_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка сброса даты окончания (end_date: null) через PATCH /api/v1/events/{id}.
    Устранена тавтология мока: объект создается с end_date=2000, мутирует в памяти без refresh.
    """
    mock_event = build_mock_event(id=1, start_date=1000, end_date=2000)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_event
    mock_db_session.execute.return_value = mock_result

    response = await async_client.patch(
        "/api/v1/events/1",
        json={"end_date": None},
    )

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["end_date"] is None
    assert mock_db_session.flush.called


@pytest.mark.unit
async def test_update_event_not_found(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка попытки обновления несуществующего события.
    Ожидается статус 404 Not Found.
    """
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await async_client.patch(
        "/api/v1/events/999",
        json={"title": "Новое название"},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert "Историческое событие с ID 999 не найдено" in data["detail"]


@pytest.mark.unit
@pytest.mark.parametrize(
    "payload",
    [
        {"title": None},
        {"category": None},
        {"status": None},
    ],
)
async def test_update_event_null_non_nullable_fields(
    async_client: AsyncClient,
    payload: dict,
) -> None:
    """
    Параметризованный тест передачи явного null в поля со строгим ограничением NOT NULL.
    Валидатор EventUpdate перехватывает ошибку до обращения к базе данных со статусом 422.
    """
    response = await async_client.patch("/api/v1/events/1", json=payload)
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.unit
async def test_delete_event_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка успешного удаления события через DELETE /api/v1/events/{id}.
    Ожидается возврат пустого ответа 204 No Content.
    """
    mock_event = build_mock_event(id=1)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_event
    mock_db_session.execute.return_value = mock_result

    response = await async_client.delete("/api/v1/events/1")

    assert response.status_code == status.HTTP_204_NO_CONTENT
    assert mock_db_session.delete.called
    assert mock_db_session.flush.called


@pytest.mark.unit
async def test_delete_event_not_found(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка удаления несуществующего события через DELETE /api/v1/events/{id}.
    Ожидается статус 404 Not Found.
    """
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_db_session.execute.return_value = mock_result

    response = await async_client.delete("/api/v1/events/999")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert "Историческое событие с ID 999 не найдено" in data["detail"]


@pytest.mark.unit
async def test_unknown_api_route_not_found_json(
    async_client: AsyncClient,
) -> None:
    """
    Проверка изоляции SPA-маршрутизации для префикса /api/.
    Несуществующий ресурс API обязан возвращать JSON со статусом 404, а не HTML-каркас SPA.
    """
    response = await async_client.get("/api/v1/unknown_resource")

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "application/json" in response.headers.get("content-type", "")
    assert response.json() == {"detail": "Эндпоинт API не найден."}
