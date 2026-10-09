"""
Модульные тесты схем валидации и сериализации Pydantic v2.
Проверяет контракты EventCreate, EventUpdate, EventResponse,
EventRangeResponse, EventChildrenPage, MediaItem, MediaPayload,
HealthResponse, а также параметры конфигурации Settings без обращения к базе данных.
"""

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.core.config.config import settings
from app.core.constants import (
    EVENT_DESCRIPTION_MAX_LENGTH,
    TIMELINE_MAX_TIMESTAMP,
    TIMELINE_MIN_TIMESTAMP,
)
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


@pytest.mark.unit
def test_event_create_description_boundary() -> None:
    """
    Проверка граничных условий максимальной длины описания в схеме EventCreate.
    Строка ровно EVENT_DESCRIPTION_MAX_LENGTH валидируется успешно,
    превышение на 1 символ возбуждает ValidationError, None и пустая строка допустимы.
    """
    base_payload = {
        "title": "Событие с описанием",
        "start_date": 1000,
        "category": EventCategory.CULTURE,
    }

    # 1. Граничная допустимая длина ровно EVENT_DESCRIPTION_MAX_LENGTH
    exact_description = "x" * EVENT_DESCRIPTION_MAX_LENGTH
    event_exact = EventCreate(**base_payload, description=exact_description)
    assert event_exact.description == exact_description

    # 2. Превышение лимита на 1 символ вызывает ValidationError
    oversized_description = "x" * (EVENT_DESCRIPTION_MAX_LENGTH + 1)
    with pytest.raises(ValidationError) as exc_info:
        EventCreate(**base_payload, description=oversized_description)
    assert "description" in str(exc_info.value)

    # 3. Допустимость значений None и пустой строки
    event_none = EventCreate(**base_payload, description=None)
    assert event_none.description is None

    event_empty = EventCreate(**base_payload, description="")
    assert event_empty.description == ""


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
    expected_fields = {
        "title",
        "start_date",
        "category",
        "rank",
        "calendar_system",
    }
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


@pytest.mark.unit
def test_event_update_description_boundary() -> None:
    """
    Проверка граничных условий максимальной длины описания в схеме EventUpdate.
    Строка ровно EVENT_DESCRIPTION_MAX_LENGTH валидируется успешно,
    превышение на 1 символ возбуждает ValidationError, None и пустая строка допустимы.
    """
    # 1. Граничная допустимая длина ровно EVENT_DESCRIPTION_MAX_LENGTH
    exact_description = "y" * EVENT_DESCRIPTION_MAX_LENGTH
    update_exact = EventUpdate(description=exact_description)
    assert update_exact.description == exact_description

    # 2. Превышение лимита на 1 символ вызывает ValidationError
    oversized_description = "y" * (EVENT_DESCRIPTION_MAX_LENGTH + 1)
    with pytest.raises(ValidationError) as exc_info:
        EventUpdate(description=oversized_description)
    assert "description" in str(exc_info.value)

    # 3. Допустимость значений None и пустой строки
    update_none = EventUpdate(description=None)
    assert update_none.description is None

    update_empty = EventUpdate(description="")
    assert update_empty.description == ""


# --- Тестирование устойчивости EventResponse и параметров Settings ---


@pytest.mark.unit
def test_event_response_tolerates_oversized_description() -> None:
    """
    Проверка устойчивости схемы EventResponse к десериализации описания,
    превышающего лимит EVENT_DESCRIPTION_MAX_LENGTH. Гарантирует обратную
    совместимость с ранее сохраненными в БД записями.
    """
    now = datetime.now()
    oversized_description = "A" * 25000
    payload = {
        "id": 1,
        "title": "Событие с длинным описанием",
        "description": oversized_description,
        "start_date": 1000,
        "end_date": None,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.YEAR,
        "parent_id": None,
        "source": None,
        "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC,
        "media_payload": None,
        "status": EventStatus.APPROVED,
        "created_at": now,
        "updated_at": now,
    }

    response = EventResponse.model_validate(payload)
    assert response.description == oversized_description


@pytest.mark.unit
def test_settings_description_limit_and_embed_hosts() -> None:
    """
    Проверка корректности параметров лимита описания и списка хостов в синглтоне Settings.
    """
    assert settings.event_description_max_length == 20000
    assert isinstance(settings.embed_allowed_hosts, list)
    for host in ("youtube.com", "rutube.ru", "vk.com", "music.yandex.ru"):
        assert host in settings.embed_allowed_hosts


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
    # Инициализация трех валидных медиа-элементов различных типов с доверенными адресами
    item_image = MediaItem(
        media_type="image",
        url="https://example.com/image.jpg",
        title="Фото",
    )
    item_video = MediaItem(
        media_type="video",
        url="https://youtu.be/dQw4w9WgXcQ",
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
def test_media_item_youtube_embed_generation() -> None:
    """
    Проверка генерации канонического embed-URL для YouTube.
    Проверяет сценарий с явным провайдером и автоматическое определение провайдера.
    """
    # 1. Создание с явно указанным провайдером youtube
    item_short = MediaItem(
        media_type="video",
        url="https://youtu.be/dQw4w9WgXcQ",
        provider="youtube",
    )
    assert item_short.provider == "youtube"
    assert item_short.embed_url == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"

    # 2. Создание без явного указания провайдера с автоматическим определением
    item_watch = MediaItem(
        media_type="video",
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )
    assert item_watch.provider == "youtube"
    assert item_watch.embed_url == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"


@pytest.mark.unit
def test_media_item_rutube_and_vk_video() -> None:
    """
    Проверка формирования канонических адресов встраивания для Rutube и VK Video.
    """
    # 1. Видеохостинг Rutube
    item_rutube = MediaItem(
        media_type="video",
        url="https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/",
    )
    assert item_rutube.provider == "rutube"
    assert item_rutube.embed_url == "https://rutube.ru/play/embed/a1b2c3d4e5f60718293a4b5c6d7e8f90"

    # 2. Платформа VK Video со структурой oid, id и ключом hash
    item_vk = MediaItem(
        media_type="video",
        url="https://vkvideo.ru/video-22822305_456239018?hash=abcdef1234",
    )
    assert item_vk.provider == "vk"
    assert (
        item_vk.embed_url
        == "https://vk.com/video_ext.php?oid=-22822305&id=456239018&hash=abcdef1234"
    )


@pytest.mark.unit
def test_media_item_yandex_music_and_direct_audio() -> None:
    """
    Проверка классификации аудио-ресурсов: виджет Яндекс.Музыки и прямой аудиофайл.
    """
    # 1. Трек платформы Яндекс.Музыка
    item_yandex = MediaItem(
        media_type="audio",
        url="https://music.yandex.ru/album/123/track/456",
    )
    assert item_yandex.provider == "yandex"
    assert item_yandex.embed_url == "https://music.yandex.ru/iframe/#track/456/123"

    # 2. Прямой защищенный аудиофайл через https
    item_direct = MediaItem(
        media_type="audio",
        url="https://cdn.history.org/lecture.mp3",
        provider="direct",
    )
    assert item_direct.provider == "direct"
    assert item_direct.embed_url is None


@pytest.mark.unit
def test_media_item_provider_mismatch_raises_validation_error() -> None:
    """
    Проверка блокировки подмены провайдера: несовпадение заявленного provider
    с фактически обнаруженным хостом URL обязано вызывать ValidationError.
    """
    with pytest.raises(ValidationError) as exc_info_1:
        MediaItem(
            media_type="video",
            url="https://youtu.be/dQw4w9WgXcQ",
            provider="vk",
        )
    assert "не соответствует" in str(exc_info_1.value)

    with pytest.raises(ValidationError) as exc_info_2:
        MediaItem(
            media_type="video",
            url="https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/",
            provider="youtube",
        )
    assert "не соответствует" in str(exc_info_2.value)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("url", "invalid_provider"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", "vk"),
        (
            "https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/",
            "youtube",
        ),
        ("https://vkvideo.ru/video-22822305_456239018", "rutube"),
        ("https://music.yandex.ru/album/123/track/456", "youtube"),
        ("https://cdn.example.org/audio.mp3", "vk"),
    ],
)
def test_media_item_provider_mismatch_comprehensive(url: str, invalid_provider: str) -> None:
    """
    Комплексная параметризованная проверка несовпадения заявленного провайдера с URL.
    Гарантирует возбуждение ValidationError, если переданный provider не соответствует хосту URL.
    """
    media_type = "audio" if ("audio" in url or "music" in url) else "video"
    with pytest.raises(ValidationError) as exc_info:
        MediaItem(
            media_type=media_type,
            url=url,
            provider=invalid_provider,
        )
    assert "не соответствует" in str(exc_info.value)


@pytest.mark.unit
def test_media_item_incompatible_media_type_raises_validation_error() -> None:
    """
    Проверка согласования типов контента и возможностей платформы:
    аудио под видом видео и видео под видом аудио вызывают ValidationError.
    """
    # Передача аудио-ресурса Яндекс.Музыки в категорию video
    with pytest.raises(ValidationError) as exc_info_1:
        MediaItem(
            media_type="video",
            url="https://music.yandex.ru/album/123/track/456",
        )
    assert "не является видеозаписью" in str(exc_info_1.value)

    # Передача видеохостинга YouTube в категорию audio
    with pytest.raises(ValidationError) as exc_info_2:
        MediaItem(
            media_type="audio",
            url="https://youtu.be/dQw4w9WgXcQ",
        )
    assert "не является аудиозаписью" in str(exc_info_2.value)


@pytest.mark.unit
def test_media_item_incompatible_types_and_providers_matrix() -> None:
    """
    Проверка матрицы несовместимости media_type и URL/провайдера.
    Блокирует регистрацию видео как аудио, аудио как видео,
    а также указание провайдеров для картинок и ссылок.
    """
    # 1. Видео с адресом Яндекс.Музыки (ошибка: ресурс не является видеозаписью)
    with pytest.raises(ValidationError) as exc_1:
        MediaItem(
            media_type="video",
            url="https://music.yandex.ru/album/123/track/456",
        )
    assert "не является видеозаписью" in str(exc_1.value)

    # 2. Аудио с адресом YouTube (ошибка: ресурс не является аудиозаписью)
    with pytest.raises(ValidationError) as exc_2:
        MediaItem(
            media_type="audio",
            url="https://youtu.be/dQw4w9WgXcQ",
        )
    assert "не является аудиозаписью" in str(exc_2.value)

    # 3. Видео с прямым аудио-файлом (ошибка: ресурс не является видеозаписью)
    with pytest.raises(ValidationError) as exc_3:
        MediaItem(
            media_type="video",
            url="https://cdn.example.org/audio.mp3",
        )
    assert "не является видеозаписью" in str(exc_3.value)

    # 4. Аудио с адресом Rutube (ошибка: ресурс не является аудиозаписью)
    with pytest.raises(ValidationError) as exc_4:
        MediaItem(
            media_type="audio",
            url="https://rutube.ru/video/a1b2c3d4e5f60718293a4b5c6d7e8f90/",
        )
    assert "не является аудиозаписью" in str(exc_4.value)

    # 5. Картинка со сторонним провайдером rutube (ошибка: провайдер недопустим)
    with pytest.raises(ValidationError) as exc_5:
        MediaItem(
            media_type="image",
            url="https://example.com/pic.png",
            provider="rutube",
        )
    assert "недопустим" in str(exc_5.value)

    # 6. Внешняя ссылка со сторонним провайдером vk (ошибка: провайдер недопустим)
    with pytest.raises(ValidationError) as exc_6:
        MediaItem(
            media_type="link",
            url="https://example.com/info",
            provider="vk",
        )
    assert "недопустим" in str(exc_6.value)


@pytest.mark.unit
def test_media_item_client_embed_url_is_ignored_and_overwritten() -> None:
    """
    Проверка защиты от инъекций вредоносных адресов встраивания со стороны клиента.
    Сервер обязан полностью игнорировать входящее значение embed_url и пересчитывать его заново.
    """
    # 1. Попытка передачи поддельного iframe-URL для YouTube
    video_payload = {
        "media_type": "video",
        "url": "https://youtu.be/dQw4w9WgXcQ",
        "embed_url": "https://evil-hacker.com/iframe",
    }
    item_video = MediaItem.model_validate(video_payload)
    assert item_video.embed_url == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"

    # 2. Попытка передачи embed_url для статического изображения
    image_payload = {
        "media_type": "image",
        "url": "https://example.com/pic.png",
        "embed_url": "https://evil.com",
    }
    item_image = MediaItem.model_validate(image_payload)
    assert item_image.embed_url is None


@pytest.mark.unit
def test_media_item_embed_url_tampering_protection_in_event_schemas() -> None:
    """
    Проверка защиты от подмены embed_url клиентом в MediaItem, EventCreate и EventUpdate.
    Сервер обязан полностью игнорировать клиентский embed_url и вычислять его заново
    либо сбрасывать в None для прямых файлов, картинок и ссылок.
    """
    # 1. Валидация через словарь MediaItem.model_validate с вредоносным embed_url
    item_yt = MediaItem.model_validate(
        {
            "media_type": "video",
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "embed_url": "https://evil-attacker.org/hack",
        }
    )
    assert item_yt.embed_url == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"

    # 2. Прямое аудио: сброс переданного embed_url в None
    item_audio = MediaItem.model_validate(
        {
            "media_type": "audio",
            "url": "https://cdn.example.org/audio.mp3",
            "embed_url": "https://evil.com/fake",
        }
    )
    assert item_audio.embed_url is None

    # 3. Внешняя ссылка: сброс переданного embed_url в None
    item_link = MediaItem.model_validate(
        {
            "media_type": "link",
            "url": "https://example.com/page",
            "embed_url": "https://evil.com",
        }
    )
    assert item_link.embed_url is None

    # 4. Проверка внутри EventCreate
    create_payload = {
        "title": "Событие с поддельным embed",
        "start_date": 1000,
        "category": EventCategory.CULTURE,
        "media_payload": [
            {
                "media_type": "video",
                "url": "https://youtu.be/dQw4w9WgXcQ",
                "embed_url": "https://evil.com",
            }
        ],
    }
    event_create = EventCreate.model_validate(create_payload)
    assert event_create.media_payload is not None
    assert (
        event_create.media_payload[0].embed_url
        == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    )

    # 5. Проверка внутри EventUpdate
    update_payload = {
        "media_payload": [
            {
                "media_type": "video",
                "url": "https://youtu.be/dQw4w9WgXcQ",
                "embed_url": "https://evil.com",
            }
        ]
    }
    event_update = EventUpdate.model_validate(update_payload)
    assert event_update.media_payload is not None
    assert (
        event_update.media_payload[0].embed_url
        == "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    )


@pytest.mark.unit
def test_media_payload_boundary_limits_in_payload_and_events() -> None:
    """
    Проверка граничных условий лимита коллекции media_payload (ровно 20 элементов).
    Коллекция из 20 элементов валидируется успешно, 21 элемент вызывает ValidationError.
    Проверяются модели MediaPayload, EventCreate и EventUpdate.
    """
    items_20 = [
        MediaItem(
            media_type="image",
            url=f"https://example.com/item_{i}.png",
            title=f"Элемент {i}",
        )
        for i in range(20)
    ]
    items_21 = [
        MediaItem(
            media_type="image",
            url=f"https://example.com/item_{i}.png",
            title=f"Элемент {i}",
        )
        for i in range(21)
    ]

    # 1. MediaPayload с ровно 20 элементами
    payload_20 = MediaPayload(items_20)
    assert len(payload_20) == 20

    # 2. MediaPayload с 21 элементом возбуждает ValidationError
    with pytest.raises(ValidationError):
        MediaPayload(items_21)

    # 3. Пустая коллекция MediaPayload
    payload_empty = MediaPayload([])
    assert len(payload_empty) == 0

    # 4. EventCreate со списком из 20 элементов
    event_create_20 = EventCreate(
        title="Событие с 20 медиа",
        start_date=1000,
        category=EventCategory.SCIENCE,
        media_payload=items_20,
    )
    assert event_create_20.media_payload is not None
    assert len(event_create_20.media_payload) == 20

    # 5. EventCreate со списком из 21 элемента
    with pytest.raises(ValidationError):
        EventCreate(
            title="Событие с 21 медиа",
            start_date=1000,
            category=EventCategory.SCIENCE,
            media_payload=items_21,
        )

    # 6. EventUpdate со списком из 20 элементов
    event_update_20 = EventUpdate(media_payload=items_20)
    assert event_update_20.media_payload is not None
    assert len(event_update_20.media_payload) == 20

    # 7. EventUpdate со списком из 21 элемента
    with pytest.raises(ValidationError):
        EventUpdate(media_payload=items_21)


@pytest.mark.unit
def test_media_item_image_and_link_rules() -> None:
    """
    Проверка правил валидации для статических изображений и внешних ссылок:
    встраивание во фрейм отключено (embed_url is None), сторонние провайдеры запрещены.
    """
    # 1. Валидное изображение без параметров встраивания
    item_img = MediaItem(
        media_type="image",
        url="https://example.com/banner.jpg",
    )
    assert item_img.embed_url is None

    # 2. Валидная внешняя гиперссылка
    item_link = MediaItem(
        media_type="link",
        url="https://wikipedia.org/wiki/Rome",
    )
    assert item_link.embed_url is None

    # 3. Изображение с недопустимым сторонним видео-провайдером
    with pytest.raises(ValidationError) as exc_info:
        MediaItem(
            media_type="image",
            url="https://example.com/pic.png",
            provider="youtube",
        )
    assert "недопустим" in str(exc_info.value)


# --- Тестирование служебных схем мониторинга ---


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
