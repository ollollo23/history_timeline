from sqlalchemy import BIGINT, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Event(Base):
    """
    ORM-модель сущности исторического события.
    Хранит атрибуты временной шкалы, текстовые описания, категории и медиа-данные в формате JSONB.
    """

    # Уникальный первичный ключ события с индексом
    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
    )

    # Заголовок исторического события
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
    )

    # Развернутое описание исторического контекста (опционально)
    description: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    # Временная метка начала события (поддерживает отрицательные числа для эпохи до н.э.)
    start_date: Mapped[int] = mapped_column(
        BIGINT,
        nullable=False,
        index=True,
    )

    # Временная метка окончания события (для событий с длительной протяженностью)
    end_date: Mapped[int | None] = mapped_column(
        BIGINT,
        nullable=True,
        index=True,
    )

    # Категория события (например: политика, наука, культура)
    category: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        index=True,
    )

    # Неструктурированные медиа-данные в оптимизированном бинарном формате PostgreSQL JSONB
    media_payload: Mapped[dict | list | None] = mapped_column(
        JSONB,
        nullable=True,
    )

    # Статус модерации события в системе (по умолчанию 'pending')
    status: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        server_default="pending",
    )