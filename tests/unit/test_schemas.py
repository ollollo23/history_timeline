"""
Модульные тесты схем валидации и сериализации Pydantic v2.
Проверяет контракты EventCreate, EventUpdate,
MediaItem, MediaPayload и HealthResponse без обращения к базе данных.
"""

import pytest
from pydantic import ValidationError

from app.core.constants import TIMELINE_MAX_TIMESTAMP, TIMELINE_MIN_TIMESTAMP
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.schemas.event import EventCreate, EventUpdate
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
