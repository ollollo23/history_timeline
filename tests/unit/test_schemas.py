"""
Модульные тесты схем валидации и сериализации Pydantic v2.
Проверяет контракты EventCreate, EventUpdate, EventResponse,
EventRangeResponse, EventChildrenPage, MediaItem, MediaPayload
и HealthResponse без обращения к базе данных.
"""

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.core.constants import TIMELINE_MAX_TIMESTAMP, TIMELINE_MIN_TIMESTAMP
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.models.event import Event
from app.schemas.event import (
    EventChildrenPage,
    EventCreate,
    EventRangeResponse,
    EventResponse,
    EventUpdate,
)
from app.schemas.health import HealthResponse
from app.schemas.media import MediaItem, MediaPayload

# --- Тестирование схемы создания события EventCreate ---


@pytest.mark.unit
def test_event_create_success() -> None:
    """
    Проверка успешного создания схемы EventCreate с валидными обязательными полями.
    Убеждается в корректной установке системных значений по умолчанию.
    """
    payload = {
        "title": "Основание Академии наук",
        "start_date": -7760976000,
        "category": EventCategory.SCIENCE,
    }

    event = EventCreate(**payload)

    # Проверка переданных атрибутов
    assert event.title == "Основание Академии наук"
    assert event.start_date == -7760976000
    assert event.category == EventCategory.SCIENCE

    # Проверка значений по умолчанию согласно контракту платформы
    assert event.rank == EventRank.YEAR
    assert event.calendar_system == CalendarSystem.GREGORIAN_PROLEPTIC
    assert event.end_date is None
    assert event.description is None
    assert event.parent_id is None
    assert event.source is None
    assert event.media_payload is None


@pytest.mark.unit
def test_event_create_extra_field_status_forbidden() -> None:
    """
    Проверка запрета передачи поля status при создании события.
    Конфигурация extra='forbid' обязана выбросить ValidationError.
    """
    payload = {
        "title": "Куликовская битва",
        "start_date": -18600000000,
        "category": EventCategory.POLITICS,
        "status": EventStatus.APPROVED.value,  # Запрещенное поле
    }

    with pytest.raises(ValidationError) as exc_info:
        EventCreate(**payload)

    error_str = str(exc_info.value)
    assert "extra_forbidden" in error_str or "status" in error_str


@pytest.mark.unit
def test_event_create_invalid_date_order() -> None:
    """
    Проверка бизнес-валидатора хронологического порядка дат:
    end_date не может быть меньше start_date.
    """
    payload = {
        "title": "Некорректный интервал",
        "start_date": 2000,
        "end_date": 1000,
        "category": EventCategory.CULTURE,
    }

    with pytest.raises(ValidationError) as exc_info:
        EventCreate(**payload)

    assert "Дата окончания события не может быть меньше даты начала" in str(exc_info.value)


@pytest.mark.unit
def test_event_create_out_of_bounds() -> None:
    """
    Проверка валидации глобальных физических границ шкалы времени платформы
    [TIMELINE_MIN_TIMESTAMP, TIMELINE_MAX_TIMESTAMP] для поля start_date.
    """
    # 1. Проверка выхода за нижнюю границу (ранее 1 млн лет до н.э.)
    with pytest.raises(ValidationError) as exc_min:
        EventCreate(
            title="Событие вне нижней границы",
            start_date=TIMELINE_MIN_TIMESTAMP - 1,
            category=EventCategory.SCIENCE,
        )
    assert "Дата начала события выходит за допустимые границы платформы" in str(exc_min.value)

    # 2. Проверка выхода за верхнюю границу (позже 3000 года н.э.)
    with pytest.raises(ValidationError) as exc_max:
        EventCreate(
            title="Событие вне верхней границы",
            start_date=TIMELINE_MAX_TIMESTAMP + 1,
            category=EventCategory.SCIENCE,
        )
    assert "Дата начала события выходит за допустимые границы платформы" in str(exc_max.value)


@pytest.mark.unit
@pytest.mark.parametrize(
    "invalid_end_date",
    [
        TIMELINE_MIN_TIMESTAMP - 1,
        TIMELINE_MAX_TIMESTAMP + 1,
    ],
)
def test_event_create_end_date_out_of_bounds(invalid_end_date: int) -> None:
    """
    Параметризованная проверка валидации выхода даты окончания (end_date)
    за допустимые физические границы шкалы времени в схеме EventCreate.
    """
    with pytest.raises(ValidationError) as exc_info:
        EventCreate(
            title="Событие с недопустимым end_date",
            start_date=0,
            end_date=invalid_end_date,
            category=EventCategory.SCIENCE,
        )

    assert "Дата окончания события выходит за допустимые границы платформы" in str(exc_info.value)


# --- Тестирование схемы обновления события EventUpdate ---


@pytest.mark.unit
def test_event_update_success() -> None:
    """
    Проверка успешного формирования схемы частичного обновления.
    Фиксирует только переданные поля в множестве model_fields_set.
    """
    update = EventUpdate(
        description="Уточненное описание исторического процесса",
        rank=EventRank.CENTURY,
    )

    assert update.description == "Уточненное описание исторического процесса"
    assert update.rank == EventRank.CENTURY
    assert "description" in update.model_fields_set
    assert "rank" in update.model_fields_set
    assert "title" not in update.model_fields_set


@pytest.mark.unit
def test_event_update_clear_end_date_allowed() -> None:
    """
    Проверка возможности сброса даты окончания события (end_date: null)
    для трансформации интервального события в точечное.
    """
    update = EventUpdate(end_date=None)

    assert update.end_date is None
    assert "end_date" in update.model_fields_set


@pytest.mark.unit
def test_event_update_non_nullable_fields_composition() -> None:
    """
    Проверка эталонного состава множества NON_NULLABLE_UPDATE_FIELDS.
    Гарантирует присутствие ровно пяти обязательных непустых полей
    и подтверждает отсутствие атрибута status в перечне.
    """
    expected_fields = {"title", "start_date", "category", "rank", "calendar_system"}
    assert EventUpdate.NON_NULLABLE_UPDATE_FIELDS == expected_fields


@pytest.mark.unit
def test_event_update_extra_field_status_forbidden() -> None:
    """
    Проверка запрета передачи поля status при частичном обновлении события.
    Конфигурация extra='forbid' в EventUpdate обязана отклонять поле status ошибкой ValidationError.
    """
    payload = {"status": EventStatus.APPROVED.value}
    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(**payload)

    error_str = str(exc_info.value)
    assert "extra_forbidden" in error_str or "status" in error_str


@pytest.mark.unit
@pytest.mark.parametrize(
    "field_name",
    sorted(EventUpdate.NON_NULLABLE_UPDATE_FIELDS),
)
def test_event_update_non_nullable_fields_forbidden(field_name: str) -> None:
    """
    Параметризованная проверка запрета передачи явного null для обязательных колонок таблицы.
    Предотвращает падение СУБД с ошибкой 500, возвращая 422 Unprocessable Entity.
    """
    payload = {field_name: None}

    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(**payload)

    assert f"Поле '{field_name}' не может быть пустым (null)" in str(exc_info.value)


@pytest.mark.unit
def test_event_update_invalid_dates_combination() -> None:
    """
    Проверка согласованности дат при их одновременной передаче в PATCH-запросе:
    новое значение end_date не может быть меньше нового start_date.
    """
    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(start_date=2000, end_date=1000)

    assert "Дата окончания события не может быть меньше даты начала" in str(exc_info.value)


@pytest.mark.unit
@pytest.mark.parametrize(
    "invalid_start_date",
    [
        TIMELINE_MIN_TIMESTAMP - 1,
        TIMELINE_MAX_TIMESTAMP + 1,
    ],
)
def test_event_update_start_date_out_of_bounds(invalid_start_date: int) -> None:
    """
    Параметризованная проверка валидации выхода даты начала (start_date)
    за допустимые физические границы шкалы времени платформы в схеме EventUpdate.
    """
    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(start_date=invalid_start_date)

    assert "Дата начала события выходит за допустимые границы платформы" in str(exc_info.value)


@pytest.mark.unit
@pytest.mark.parametrize(
    "invalid_end_date",
    [
        TIMELINE_MIN_TIMESTAMP - 1,
        TIMELINE_MAX_TIMESTAMP + 1,
    ],
)
def test_event_update_end_date_out_of_bounds(invalid_end_date: int) -> None:
    """
    Параметризованная проверка валидации выхода даты окончания (end_date)
    за допустимые физические границы шкалы времени платформы в схеме EventUpdate.
    """
    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(end_date=invalid_end_date)

    assert "Дата окончания события выходит за допустимые границы платформы" in str(exc_info.value)


# --- Тестирование схем медиа-данных и мониторинга ---


@pytest.mark.unit
def test_media_payload_max_length() -> None:
    """
    Проверка аппаратного лимита коллекции медиа-ресурсов (не более 20 элементов).
    """
    # Генерация списка из 21 валидного элемента
    overflow_items = [
        MediaItem(
            media_type="image",
            url=f"https://example.com/artifacts/item_{i}.png",
            title=f"Артефакт {i}",
        )
        for i in range(21)
    ]

    with pytest.raises(ValidationError) as exc_info:
        MediaPayload(overflow_items)

    error_text = str(exc_info.value)
    assert "List should have at most 20 items" in error_text or "too_long" in error_text


@pytest.mark.unit
def test_media_item_invalid_url() -> None:
    """
    Проверка отклонения невалидных веб-адресов без указания протокола http/https.
    """
    with pytest.raises(ValidationError) as exc_info:
        MediaItem(
            media_type="image",
            url="ftp://invalid-server.org/image.png",  # Запрещенная схема протокола
        )

    assert "url" in str(exc_info.value).lower()


@pytest.mark.unit
def test_media_payload_sequence_protocol() -> None:
    """
    Проверка поддержки методов протокола последовательности (__len__, __getitem__, __iter__)
    корневой моделью MediaPayload для прозрачной работы с коллекцией медиа-ресурсов.
    """
    # Инициализация трех валидных медиа-элементов различных типов
    item_image = MediaItem(
        media_type="image",
        url="https://example.com/image.jpg",
        title="Фото",
    )
    item_video = MediaItem(
        media_type="video",
        url="https://example.com/video.mp4",
        title="Видео",
    )
    item_link = MediaItem(
        media_type="link",
        url="https://example.com/article",
        title="Ссылка",
    )

    # Сборка экземпляра корневой модели MediaPayload
    payload = MediaPayload([item_image, item_video, item_link])

    # 1. Проверка работы метода __len__
    assert len(payload) == 3

    # 2. Проверка работы метода __getitem__ по единичным индексам
    assert payload[0].media_type == "image"
    assert payload[1].media_type == "video"

    # Проверка работы метода __getitem__ при получении диапазона (среза)
    sliced = payload[1:]
    assert isinstance(sliced, list)
    assert len(sliced) == 2
    assert sliced[0].media_type == "video"

    # 3. Проверка работы метода __iter__ при прямой итерации через списковое включение
    extracted_types = [item.media_type for item in payload]
    assert extracted_types == ["image", "video", "link"]


@pytest.mark.unit
def test_health_response_missing_fields() -> None:
    """
    Проверка обязательности всех трех диагностических полей схемы HealthResponse.
    Удаление дефолтов гарантирует фиксацию рассинхронизации контракта мониторинга.
    """
    with pytest.raises(ValidationError) as exc_info:
        HealthResponse.model_validate({})

    errors = exc_info.value.errors()
    missing_fields = {error["loc"][0] for error in errors if error["type"] == "missing"}

    assert {"status", "db_connected", "version"}.issubset(missing_fields)


@pytest.mark.unit
def test_health_response_invalid_status_literal() -> None:
    """
    Проверка строгого перечисления Literal['ok', 'degraded'] в схеме HealthResponse.
    Любые произвольные строки должны отклоняться.
    """
    with pytest.raises(ValidationError) as exc_info:
        HealthResponse(
            status="error",  # Недопустимое значение статуса
            db_connected=False,
            version="1.0.0",
        )

    error_text = str(exc_info.value)
    assert "Input should be 'ok' or 'degraded'" in error_text or "literal_error" in error_text


# --- Тестирование схем интервальной выборки и пагинации дочерних записей ---


@pytest.mark.unit
def test_event_range_response_defaults_none_collapsed_count_to_zero() -> None:
    """
    Проверка нормализации поля collapsed_children_count в схеме EventRangeResponse.
    При валидации экземпляра ORM-модели Event (где атрибут равен None)
    или словаря с явным значением None поле обязано устанавливаться в 0.
    """
    now = datetime.now()
    event = Event(
        id=1,
        title="Событие",
        start_date=1000,
        end_date=None,
        category=EventCategory.SCIENCE.value,
        rank=EventRank.YEAR.value,
        status=EventStatus.APPROVED.value,
        calendar_system=CalendarSystem.GREGORIAN_PROLEPTIC.value,
        created_at=now,
        updated_at=now,
    )

    schema = EventRangeResponse.model_validate(event)
    assert schema.collapsed_children_count == 0

    # Проверка валидации из словаря с явным collapsed_children_count: None
    payload = {
        "id": 1,
        "title": "Событие",
        "description": None,
        "start_date": 1000,
        "end_date": None,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR,
        "parent_id": None,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC,
        "media_payload": None,
        "status": EventStatus.APPROVED,
        "created_at": now,
        "updated_at": now,
        "collapsed_children_count": None,
    }
    schema_dict = EventRangeResponse.model_validate(payload)
    assert schema_dict.collapsed_children_count == 0


@pytest.mark.unit
def test_event_range_response_negative_collapsed_count_raises_error() -> None:
    """
    Проверка валидации числовой границы ge=0 для collapsed_children_count:
    отрицательные значения обязаны вызывать ValidationError.
    """
    now = datetime.now()
    payload = {
        "id": 1,
        "title": "Событие",
        "description": None,
        "start_date": 1000,
        "end_date": None,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR,
        "parent_id": None,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC,
        "media_payload": None,
        "status": EventStatus.APPROVED,
        "created_at": now,
        "updated_at": now,
        "collapsed_children_count": -1,
    }

    with pytest.raises(ValidationError) as exc_info:
        EventRangeResponse.model_validate(payload)

    assert "collapsed_children_count" in str(exc_info.value)


@pytest.mark.unit
def test_event_children_page_serialization_and_bounds() -> None:
    """
    Проверка сериализации страницы дочерних записей EventChildrenPage,
    типизации элементов items как EventResponse и числовых ограничений total, skip, limit.
    """
    now = datetime.now()
    child1_dict = {
        "id": 10,
        "title": "Дочернее событие 1",
        "description": None,
        "start_date": 1100,
        "end_date": None,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR,
        "parent_id": 1,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC,
        "media_payload": None,
        "status": EventStatus.APPROVED,
        "created_at": now,
        "updated_at": now,
    }
    child2_dict = {
        "id": 11,
        "title": "Дочернее событие 2",
        "description": None,
        "start_date": 1200,
        "end_date": None,
        "category": EventCategory.POLITICS.value,
        "rank": EventRank.MONTH,
        "parent_id": 1,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC,
        "media_payload": None,
        "status": EventStatus.APPROVED,
        "created_at": now,
        "updated_at": now,
    }

    page_data = {
        "items": [child1_dict, child2_dict],
        "total": 10,
        "skip": 0,
        "limit": 50,
    }

    page = EventChildrenPage.model_validate(page_data)

    assert len(page.items) == 2
    assert all(isinstance(item, EventResponse) for item in page.items)
    assert page.total == 10
    assert page.skip == 0
    assert page.limit == 50

    # Валидация ограничения total >= 0
    with pytest.raises(ValidationError):
        EventChildrenPage.model_validate({**page_data, "total": -1})

    # Валидация ограничения skip >= 0
    with pytest.raises(ValidationError):
        EventChildrenPage.model_validate({**page_data, "skip": -1})

    # Валидация ограничения limit >= 1 (limit=0 недопустим)
    with pytest.raises(ValidationError):
        EventChildrenPage.model_validate({**page_data, "limit": 0})
