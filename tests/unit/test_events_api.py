"""
Модульные тесты HTTP-эндпоинтов управления событиями /api/v1/events и сервисного слоя.
Проверяет маршрутизацию, HTTP-статусы, валидацию Pydantic v2, защитные middleware,
прямые контракты сервисных функций и централизованную обработку доменных исключений.
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import status
from httpx import ASGITransport, AsyncClient

from app.core.config.config import settings
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.core.exceptions import DomainError
from app.main import app
from app.models.event import Event
from app.services.event_service import list_events_in_range


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
) -> None:
    """
    Проверка постраничной выборки событий через GET /api/v1/events/.
    Верифицирует соблюдение политики публичной видимости (status='approved'),
    корректную передачу смещения skip и лимита limit в слой данных crud_get_events
    и возврат HTTP 200 OK со списком сущностей.
    """
    # Изоляция слоя доступа к данным для верификации контракта сервисного вызова
    with patch(
        "app.services.event_service.crud_get_events",
        new_callable=AsyncMock,
    ) as mock_crud_get_events:
        mock_event = build_mock_event(
            id=10,
            title="Пагинированное событие",
            status=EventStatus.APPROVED.value,
        )
        mock_crud_get_events.return_value = [mock_event]

        # Выполнение GET-запроса с параметрами пагинации
        response = await async_client.get("/api/v1/events/?skip=10&limit=25")

        # Проверка успешного HTTP-статуса и структуры полученных данных
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["id"] == 10

        # Верификация соблюдения политики публичной видимости и передачи параметров
        mock_crud_get_events.assert_awaited_once()
        assert mock_crud_get_events.call_args.kwargs.get("status") == EventStatus.APPROVED.value
        assert mock_crud_get_events.call_args.kwargs.get("skip") == 10
        assert mock_crud_get_events.call_args.kwargs.get("limit") == 25


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
async def test_get_events_in_range_invalid_category(
    async_client: AsyncClient,
) -> None:
    """
    Проверка валидации категорий в запросе выборки по диапазону.
    Передача неизвестного значения категории приводит к возврату 422 Unprocessable Content.
    """
    response = await async_client.get(
        "/api/v1/events/range?from_date=0&to_date=1000&categories=religion"
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.unit
async def test_get_events_in_range_invalid_rank(
    async_client: AsyncClient,
) -> None:
    """
    Проверка валидации рангов в запросе выборки по диапазону GET /api/v1/events/range.
    Передача неизвестного значения ранга отклоняется на уровне FastAPI со статусом 422.
    """
    response = await async_client.get(
        "/api/v1/events/range?from_date=0&to_date=1000&ranks=invalid_rank"
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    data = response.json()
    assert isinstance(data.get("detail"), list)
    # Проверка фиксации ошибки валидации в поле ranks
    assert any("ranks" in str(err.get("loc", [])) for err in data["detail"])


@pytest.mark.unit
async def test_get_events_in_range_multiple_ranks_delegation(
    async_client: AsyncClient,
) -> None:
    """
    Проверка делегирования множественных параметров ranks в сервисный слой в виде списка строк.
    Валидирует статус 200 OK, вызов list_events_in_range и передачу регламентированных аргументов.
    """
    with patch(
        "app.api.endpoints.events.list_events_in_range",
        new_callable=AsyncMock,
    ) as mock_list_events:
        mock_list_events.return_value = []

        # Запрос с передачей двух повторяющихся параметров ranks
        response = await async_client.get(
            "/api/v1/events/range?from_date=0&to_date=1000&ranks=century&ranks=year"
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

        # Проверка одиночного вызова сервисного метода и значений переданных именованных параметров
        mock_list_events.assert_awaited_once()
        kwargs = mock_list_events.call_args.kwargs
        assert kwargs.get("ranks") == ["century", "year"]
        assert kwargs.get("from_date") == 0
        assert kwargs.get("to_date") == 1000
        assert kwargs.get("categories") is None
        assert kwargs.get("status") == EventStatus.APPROVED.value
        assert kwargs.get("skip") == 0
        assert kwargs.get("limit") == 500


@pytest.mark.unit
async def test_get_events_in_range_ignores_status_query_param(
    async_client: AsyncClient,
) -> None:
    """
    Проверка игнорирования клиентского параметра status в маршруте GET /range.
    Публичная лента принудительно передает в сервисный слой status='approved'.
    """
    with patch(
        "app.api.endpoints.events.list_events_in_range",
        new_callable=AsyncMock,
    ) as mock_list_events:
        mock_list_events.return_value = []

        response = await async_client.get(
            "/api/v1/events/range?from_date=0&to_date=1000&status=pending"
        )

        assert response.status_code == status.HTTP_200_OK
        mock_list_events.assert_awaited_once()
        assert mock_list_events.call_args.kwargs.get("status") == EventStatus.APPROVED.value


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
async def test_update_event_start_date_later_than_existing_end_date(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка валидации хронологии при неявном конфликте дат: переданный start_date
    оказывается позже уже сохраненного в базе данных значения end_date.
    Ожидается статус 400 Bad Request с доменным сообщением об ошибке.
    """
    mock_event = build_mock_event(id=1, start_date=1000, end_date=2000)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_event
    mock_db_session.execute.return_value = mock_result

    response = await async_client.patch(
        "/api/v1/events/1",
        json={"start_date": 3000},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    data = response.json()
    assert data["detail"] == "Дата окончания события не может быть меньше даты начала."


@pytest.mark.unit
async def test_update_event_parent_not_found(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка валидации существования родительского события при частичном обновлении.
    Попытка привязать событие к несуществующему parent_id возвращает статус 404 Not Found.
    """
    mock_event = build_mock_event(id=1)
    res_event = MagicMock()
    res_event.scalar_one_or_none.return_value = mock_event

    res_parent = MagicMock()
    res_parent.scalar_one_or_none.return_value = None

    mock_db_session.execute.side_effect = [res_event, res_parent]

    response = await async_client.patch(
        "/api/v1/events/1",
        json={"parent_id": 999},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    data = response.json()
    assert "Историческое событие с ID 999 не найдено" in data["detail"]


@pytest.mark.unit
async def test_update_event_parent_rank_invalid(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка валидации иерархии рангов детализации при назначении нового родителя.
    Попытка назначить родителем событие с более мелким рангом возвращает статус 400 Bad Request.
    """
    mock_event = build_mock_event(id=1, rank=EventRank.CENTURY.value)
    mock_parent = build_mock_event(id=2, rank=EventRank.YEAR.value)

    res_event = MagicMock()
    res_event.scalar_one_or_none.return_value = mock_event

    res_parent = MagicMock()
    res_parent.scalar_one_or_none.return_value = mock_parent

    mock_db_session.execute.side_effect = [res_event, res_parent]

    response = await async_client.patch(
        "/api/v1/events/1",
        json={"parent_id": 2},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    data = response.json()
    assert "Ранг родительского события" in data["detail"]
    assert "должен быть строго крупнее" in data["detail"]


@pytest.mark.unit
async def test_update_event_unlink_parent_success(
    async_client: AsyncClient,
    mock_db_session: AsyncMock,
) -> None:
    """
    Проверка успешного сброса родительской связи (parent_id: null) через PATCH /api/v1/events/{id}.
    Валидирует отвязку от иерархии без дополнительных проверок рангов и возврат HTTP 200 OK.
    """
    mock_event = build_mock_event(id=1, parent_id=5)
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_event
    mock_db_session.execute.return_value = mock_result

    response = await async_client.patch(
        "/api/v1/events/1",
        json={"parent_id": None},
    )

    assert response.status_code == status.HTTP_200_OK
    data = response.json()
    assert data["parent_id"] is None
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
async def test_update_event_status_field_forbidden(
    async_client: AsyncClient,
) -> None:
    """
    Проверка запрета передачи поля status при частичном обновлении (PATCH).
    Конфигурация extra='forbid' в EventUpdate возвращает статус 422.
    """
    response = await async_client.patch(
        "/api/v1/events/1",
        json={"status": EventStatus.APPROVED.value},
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.unit
@pytest.mark.parametrize(
    "payload",
    [
        {"title": None},
        {"category": None},
        {"rank": None},
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


@pytest.mark.unit
async def test_request_body_size_limit_exceeded(
    async_client: AsyncClient,
) -> None:
    """
    Проверка middleware ограничения размера входящего HTTP-запроса (413 Content Too Large).
    При превышении max_request_body_bytes запрос отклоняется до вычитывания сокета.
    """
    oversized_size = settings.max_request_body_bytes + 100
    oversized_payload = "x" * oversized_size

    response = await async_client.post(
        "/api/v1/events/",
        content=oversized_payload,
        headers={"content-length": str(oversized_size)},
    )

    assert response.status_code == status.HTTP_413_CONTENT_TOO_LARGE
    assert response.json() == {"detail": "Размер тела запроса превышает допустимый лимит."}


@pytest.mark.unit
async def test_domain_error_fallback_handler(
    async_client: AsyncClient,
) -> None:
    """
    Проверка централизованного перехватчика базового DomainError (400 Bad Request).
    Любое непрофильное доменное исключение перехватывается с возвратом статуса 400.
    """
    with patch(
        "app.api.endpoints.events.get_event",
        side_effect=DomainError("Базовая ошибка домена"),
    ):
        response = await async_client.get("/api/v1/events/1")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json() == {"detail": "Базовая ошибка домена"}


@pytest.mark.unit
async def test_unhandled_exception_returns_500_without_traceback(
    async_client: AsyncClient,
) -> None:
    """
    Проверка глобального перехватчика необработанных системных исключений (500 Internal Server Error).
    Использует raise_app_exceptions=False в ASGITransport для предотвращения проброса исключения
    из ServerErrorMiddleware в тестовый раннер и проверки сформированного JSON-ответа.
    """
    # Изоляция транспорта для подавления аварийного raise exc со стороны ServerErrorMiddleware
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        with patch(
            "app.api.endpoints.events.get_event",
            side_effect=RuntimeError("Непредвиденный сбой ядра"),
        ):
            response = await client.get("/api/v1/events/1")

    assert response.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    data = response.json()
    assert data == {"detail": "Внутренняя ошибка сервера."}
    assert "Непредвиденный сбой ядра" not in response.text


@pytest.mark.unit
async def test_service_list_events_in_range_invalid_rank_raises_domain_error() -> None:
    """
    Проверка прямой контрактной валидации недопустимых рангов в сервисном слое.
    При передаче неизвестного значения ранга ('era') функция обязана выбросить DomainError
    до выполнения запроса к базе данных, не затрагивая сессию СУБД.
    """
    # Создание изолированного мока асинхронной сессии базы данных
    mock_session = AsyncMock()

    # Проверка возбуждения доменного исключения при передаче некорректного ранга
    with pytest.raises(DomainError) as exc_info:
        await list_events_in_range(
            session=mock_session,
            from_date=0,
            to_date=1000,
            ranks=["year", "era"],
        )

    # Верификация наличия имени недопустимого ранга в сообщении об ошибке
    assert "era" in str(exc_info.value)

    # Подтверждение отсутствия обращений к методам выполнения запросов базы данных
    mock_session.execute.assert_not_called()


@pytest.mark.unit
async def test_service_list_events_in_range_empty_ranks_returns_empty_list() -> None:
    """
    Проверка раннего возврата сервисного слоя при передаче пустого набора рангов.
    При ranks=[] функция обязана немедленно вернуть пустой список без выполнения SQL-запроса.
    """
    # Создание изолированного мока асинхронной сессии базы данных
    mock_session = AsyncMock()

    # Выполнение сервисного вызова с пустым списком рангов
    result = await list_events_in_range(
        session=mock_session,
        from_date=0,
        to_date=1000,
        ranks=[],
    )

    # Проверка возврата пустого результата
    assert result == []

    # Подтверждение, что SQL-запрос к базе данных не отправлялся
    mock_session.execute.assert_not_called()
