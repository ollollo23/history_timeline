"""
Схемы валидации и сериализации исторических событий на базе Pydantic v2.
Определяет строгие контракты создания (EventCreate), частичного обновления (EventUpdate)
и сериализации ответа API (EventResponse).
"""

from datetime import datetime
from typing import ClassVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.constants import TIMELINE_MAX_TIMESTAMP, TIMELINE_MIN_TIMESTAMP
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus
from app.schemas.media import MediaPayload


class EventCreate(BaseModel):
    """
    Схема валидации входящих данных для создания нового исторического события.
    Исключает поле статуса модерации (назначается системой автоматически)
    и запрещает передачу недокументированных атрибутов.
    """

    # Заголовок исторического события
    title: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Заголовок события",
    )

    # Подробное историческое описание (опционально)
    description: str | None = Field(
        default=None,
        description="Развернутое описание исторического контекста",
    )

    # Временная метка начала события в секундах Unix (поддерживает даты до н.э.)
    start_date: int = Field(
        ...,
        description="Временная метка начала события в секундах Unix",
    )

    # Временная метка окончания события в секундах Unix (null для одномоментных событий)
    end_date: int | None = Field(
        default=None,
        description="Временная метка окончания события в секундах Unix",
    )

    # Доменная категория события для группировки и фильтрации
    category: EventCategory = Field(
        ...,
        description="Категория события",
    )

    # Уровень детализации временной шкалы, на котором событие становится видимым
    rank: EventRank = Field(
        default=EventRank.YEAR,
        description="Ранг детализации события",
    )

    # Идентификатор родительского макро-события для древовидной иерархии
    parent_id: int | None = Field(
        default=None,
        description="Идентификатор родительского события",
    )

    # Первоисточник данных или библиографическая ссылка
    source: str | None = Field(
        default=None,
        description="Первоисточник или библиографическая ссылка",
    )

    # Календарная система летоисчисления для фиксации оригинальной даты
    calendar_system: CalendarSystem = Field(
        default=CalendarSystem.GREGORIAN_PROLEPTIC,
        description="Календарная система",
    )

    # Типизированный массив медиа-вложений (до 20 проверенных элементов)
    media_payload: MediaPayload | None = Field(
        default=None,
        description="Типизированный массив медиа-вложений",
    )

    # Запрет передачи любых нерегламентированных полей в теле запроса
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_date_boundaries_and_order(self) -> "EventCreate":
        """
        Проверяет хронологическую корректность дат:
        - Вхождение start_date и end_date в глобальные границы шкалы платформы;
        - Соответствие условию end_date >= start_date при наличии даты окончания.
        """
        # Валидация диапазона допустимых значений даты начала события
        if not (TIMELINE_MIN_TIMESTAMP <= self.start_date <= TIMELINE_MAX_TIMESTAMP):
            raise ValueError(
                f"Дата начала события выходит за допустимые границы платформы "
                f"[{TIMELINE_MIN_TIMESTAMP}, {TIMELINE_MAX_TIMESTAMP}]."
            )

        # Валидация даты окончания при ее наличии
        if self.end_date is not None:
            if not (TIMELINE_MIN_TIMESTAMP <= self.end_date <= TIMELINE_MAX_TIMESTAMP):
                raise ValueError(
                    f"Дата окончания события выходит за допустимые границы платформы "
                    f"[{TIMELINE_MIN_TIMESTAMP}, {TIMELINE_MAX_TIMESTAMP}]."
                )

            # Проверка хронологической последовательности границ интервала
            if self.end_date < self.start_date:
                raise ValueError("Дата окончания события не может быть меньше даты начала.")

        return self


class EventUpdate(BaseModel):
    """
    Схема валидации для частичного обновления (PATCH) исторического события.
    Все поля опциональны, однако передача null в обязательные поля запрещена.
    """

    # Список полей таблицы, для которых запрещена установка значения null в базе данных
    NON_NULLABLE_UPDATE_FIELDS: ClassVar[set[str]] = {
        "title",
        "start_date",
        "category",
        "rank",
        "calendar_system",
        "status",
    }

    # Опциональное обновление заголовка
    title: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        description="Заголовок события",
    )

    # Опциональное обновление описания
    description: str | None = Field(
        default=None,
        description="Развернутое описание",
    )

    # Опциональное обновление даты начала
    start_date: int | None = Field(
        default=None,
        description="Временная метка начала",
    )

    # Опциональное обновление даты окончания (передача явного null сбрасывает дату)
    end_date: int | None = Field(
        default=None,
        description="Временная метка окончания (передача null сбрасывает дату окончания)",
    )

    # Опциональное обновление категории события
    category: EventCategory | None = Field(
        default=None,
        description="Категория события",
    )

    # Опциональное обновление ранга детализации
    rank: EventRank | None = Field(
        default=None,
        description="Ранг детализации",
    )

    # Опциональное обновление идентификатора родительского события
    parent_id: int | None = Field(
        default=None,
        description="Родительское событие",
    )

    # Опциональное обновление источника данных
    source: str | None = Field(
        default=None,
        description="Источник данных",
    )

    # Опциональное обновление календарной системы
    calendar_system: CalendarSystem | None = Field(
        default=None,
        description="Календарная система",
    )

    # Опциональное обновление медиа-вложений
    media_payload: MediaPayload | None = Field(
        default=None,
        description="Медиа-вложения",
    )

    # Опциональное обновление статуса модерации (доступно администратору/модератору)
    status: EventStatus | None = Field(
        default=None,
        description="Статус модерации события",
    )

    # Запрет передачи неизвестных полей при обновлении
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_patch_rules(self) -> "EventUpdate":
        """
        Проверяет бизнес-правила частичного обновления:
        - Защиту от установки null в колонки со строгим ограничением NOT NULL;
        - Попадание измененных меток дат в системные границы шкалы;
        - Корректность соотношения end_date >= start_date при их одновременной передаче.
        """
        # Проверка попытки сброса обязательных полей в null через явную передачу в payload
        for field_name in self.model_fields_set:
            if field_name in self.NON_NULLABLE_UPDATE_FIELDS and getattr(self, field_name) is None:
                raise ValueError(f"Поле '{field_name}' не может быть пустым (null).")

        # Проверка границ даты начала при ее передаче (объединенное условие SIM102)
        if (
            "start_date" in self.model_fields_set
            and self.start_date is not None
            and not (TIMELINE_MIN_TIMESTAMP <= self.start_date <= TIMELINE_MAX_TIMESTAMP)
        ):
            raise ValueError(
                f"Дата начала события выходит за допустимые границы платформы "
                f"[{TIMELINE_MIN_TIMESTAMP}, {TIMELINE_MAX_TIMESTAMP}]."
            )

        # Проверка границ даты окончания при ее передаче (объединенное условие SIM102)
        if (
            "end_date" in self.model_fields_set
            and self.end_date is not None
            and not (TIMELINE_MIN_TIMESTAMP <= self.end_date <= TIMELINE_MAX_TIMESTAMP)
        ):
            raise ValueError(
                f"Дата окончания события выходит за допустимые границы платформы "
                f"[{TIMELINE_MIN_TIMESTAMP}, {TIMELINE_MAX_TIMESTAMP}]."
            )

        # Проверка согласованности интервала при обновлении обоих полей (объединенное условие SIM102)
        if (
            "start_date" in self.model_fields_set
            and "end_date" in self.model_fields_set
            and self.start_date is not None
            and self.end_date is not None
            and self.end_date < self.start_date
        ):
            raise ValueError("Дата окончания события не может быть меньше даты начала.")

        return self


class EventResponse(BaseModel):
    """
    Схема ответа API с полными атрибутами исторического события.
    Исключает служебную колонку end_date_effective и поддерживает маппинг из ORM.
    """

    # Уникальный суррогатный идентификатор события в базе данных
    id: int = Field(
        ...,
        description="Первичный ключ события",
    )

    # Краткий заголовок события
    title: str = Field(
        ...,
        description="Заголовок события",
    )

    # Полный исторический контекст (null при отсутствии)
    description: str | None = Field(
        ...,
        description="Описание события",
    )

    # Временная метка начала события в секундах Unix
    start_date: int = Field(
        ...,
        description="Метка начала в секундах Unix",
    )

    # Временная метка окончания события в секундах Unix
    end_date: int | None = Field(
        ...,
        description="Метка окончания в секундах Unix",
    )

    # Категория события
    category: EventCategory = Field(
        ...,
        description="Категория события",
    )

    # Ранг детализации временной шкалы
    rank: EventRank = Field(
        ...,
        description="Ранг детализации",
    )

    # Идентификатор родительского события
    parent_id: int | None = Field(
        ...,
        description="Идентификатор родителя",
    )

    # Первоисточник информации
    source: str | None = Field(
        ...,
        description="Источник",
    )

    # Календарная система летоисчисления
    calendar_system: CalendarSystem = Field(
        ...,
        description="Календарная система",
    )

    # Типизированный массив медиа-ресурсов
    media_payload: MediaPayload | None = Field(
        ...,
        description="Медиа-данные",
    )

    # Текущий статус модерации события
    status: EventStatus = Field(
        ...,
        description="Статус модерации",
    )

    # Системная временная метка создания записи
    created_at: datetime = Field(
        ...,
        description="Метка времени создания записи",
    )

    # Системная временная метка последнего изменения записи
    updated_at: datetime = Field(
        ...,
        description="Метка времени последнего обновления",
    )

    # Включение режима автоматического считывания атрибутов из ORM-моделей SQLAlchemy
    model_config = ConfigDict(from_attributes=True)


# Декларирование публичного контракта модуля схем событий
__all__: list[str] = [
    "EventCreate",
    "EventResponse",
    "EventUpdate",
]
