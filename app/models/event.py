"""
ORM-модель сущности исторического события платформы History Timeline.
Определяет реляционную схему таблицы events с ограничениями целостности,
вычисляемыми колонками и специализированными индексами для масштабируемой шкалы.
"""

from datetime import datetime

from sqlalchemy import (
    BIGINT,
    CheckConstraint,
    Computed,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import TIMELINE_MAX_TIMESTAMP, TIMELINE_MIN_TIMESTAMP
from app.core.enums import CalendarSystem, EventRank, EventStatus
from app.models.base import Base


class Event(Base):
    """
    ORM-модель исторического события.

    Поддерживает:
    - Хронологические метки от 1 млн лет до н.э. до 3000 года н.э. в формате BIGINT (секунды).
    - Точечные и интервальные события с автоматическим расчетом эффективного окончания.
    - Вычисляемую колонку end_date_effective: материализованное значение COALESCE(end_date, start_date),
      позволяющее эффективно фильтровать события по условию пересечения отрезков времени.
    - Иерархическую вложенность событий через parent_id для группировки по масштабам шкалы.
    - Аудит жизненного цикла записей с автоматической фиксацией времени создания и обновления.
    """

    # Явное закрепление имени таблицы в схеме реляционной базы данных
    __tablename__ = "events"

    # Декларативные ограничения целостности и композитные индексы таблицы
    __table_args__ = (
        # Бизнес-правило: дата окончания интервала не может быть меньше даты начала
        CheckConstraint(
            "end_date IS NULL OR end_date >= start_date",
            name="ck_events_end_after_start",
        ),
        # Контроль допустимых значений уровней детализации (рангов) события
        CheckConstraint(
            f"rank IN ("
            f"'{EventRank.CENTURY.value}', "
            f"'{EventRank.DECADE.value}', "
            f"'{EventRank.YEAR.value}', "
            f"'{EventRank.MONTH.value}', "
            f"'{EventRank.DAY.value}', "
            f"'{EventRank.HOUR.value}', "
            f"'{EventRank.MINUTE.value}', "
            f"'{EventRank.SECOND.value}')",
            name="ck_events_rank_allowed",
        ),
        # Контроль допустимых статусов модерации
        CheckConstraint(
            f"status IN ("
            f"'{EventStatus.PENDING.value}', "
            f"'{EventStatus.APPROVED.value}', "
            f"'{EventStatus.REJECTED.value}')",
            name="ck_events_status_allowed",
        ),
        # Контроль поддерживаемых календарных систем летоисчисления
        CheckConstraint(
            f"calendar_system IN ("
            f"'{CalendarSystem.GREGORIAN_PROLEPTIC.value}', "
            f"'{CalendarSystem.JULIAN.value}')",
            name="ck_events_calendar_allowed",
        ),
        # Контроль вхождения даты начала события в глобальные физические границы таймлайна
        CheckConstraint(
            f"start_date >= {TIMELINE_MIN_TIMESTAMP} AND start_date <= {TIMELINE_MAX_TIMESTAMP}",
            name="ck_events_start_date_bounds",
        ),
        # Контроль вхождения даты окончания события в глобальные физические границы таймлайна
        CheckConstraint(
            "end_date IS NULL OR ("
            f"end_date >= {TIMELINE_MIN_TIMESTAMP} AND end_date <= {TIMELINE_MAX_TIMESTAMP})",
            name="ck_events_end_date_bounds",
        ),
        # Контроль формата медиа-вложений: допустим только JSON-массив либо NULL
        CheckConstraint(
            "media_payload IS NULL OR jsonb_typeof(media_payload) = 'array'",
            name="ck_events_media_payload_is_array",
        ),
        # Индекс для комбинированной фильтрации по категории и хронологической сортировки
        Index(
            "ix_events_category_start_date",
            "category",
            "start_date",
        ),
        # Высокопроизводительный композитный индекс для пространственно-временных выборок таймлайна
        Index(
            "ix_events_start_effective",
            "start_date",
            "end_date_effective",
        ),
        # Индекс для ускорения иерархических выборок дочерних событий по идентификатору родителя
        Index(
            "ix_events_parent_id",
            "parent_id",
        ),
        # Индекс для фильтрации опубликованных или ожидающих модерацию событий по времени
        Index(
            "ix_events_status_start_date",
            "status",
            "start_date",
        ),
    )

    # Первичный суррогатный ключ сущности
    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
    )

    # Краткий заголовок исторического события
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    # Развернутое историческое описание (поддерживает текстовый формат и Markdown)
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    # Временная метка начала события в секундах от эпохи Unix (поддерживает отрицательные числа)
    start_date: Mapped[int] = mapped_column(
        BIGINT,
        nullable=False,
    )

    # Временная метка окончания события в секундах (null для точечных одномоментных событий)
    end_date: Mapped[int | None] = mapped_column(
        BIGINT,
        nullable=True,
    )

    # Хранимая вычисляемая колонка: материализует end_date либо подставляет start_date
    # Обеспечивает математическую эквивалентность точечных и интервальных событий при поиске пересечений
    end_date_effective: Mapped[int] = mapped_column(
        BIGINT,
        Computed("COALESCE(end_date, start_date)", persisted=True),
        nullable=False,
    )

    # Направление исторического процесса (культура, политика, экономика, наука)
    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
    )

    # Уровень детализации временной шкалы, на котором событие становится видимым
    rank: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        server_default=EventRank.YEAR.value,
    )

    # Внешний ключ на родительское макро-событие для реализации древовидной группировки
    # При удалении родительского события дочерние записи сохраняются с обнулением parent_id
    parent_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )

    # Библиографический источник или ссылка на подтверждающий исторический факт
    source: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    # Календарная система, в контексте которой была зафиксирована оригинальная дата
    calendar_system: Mapped[str] = mapped_column(
        String(24),
        nullable=False,
        server_default=CalendarSystem.GREGORIAN_PROLEPTIC.value,
    )

    # Неструктурированные медиа-данные, ссылки на видео и изображения в формате JSONB
    # none_as_null=True обеспечивает передачу SQL NULL при значении None вместо 'null'::jsonb
    media_payload: Mapped[dict | list | None] = mapped_column(
        JSONB(none_as_null=True),
        nullable=True,
    )

    # Текущий статус публикации и проверки контента модератором
    status: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        server_default=EventStatus.PENDING.value,
    )

    # Системная временная метка добавления записи в базу данных (с часовым поясом UTC)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    # Системная временная метка последней модификации записи. Актуализируется на уровне
    # SQLAlchemy ORM при вызовах через сессию (onupdate=func.now()). Не срабатывает при
    # прямых SQL-запросах UPDATE в обход ORM, включая ручные правки через базу данных.
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
