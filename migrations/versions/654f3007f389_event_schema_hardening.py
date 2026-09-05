"""event_schema_hardening

Revision ID: 654f3007f389
Revises: 8b2cb551f884
Create Date: 2026-09-04 07:32:46.697385

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# Идентификаторы ревизий миграций Alembic
revision: str = "654f3007f389"
down_revision: Union[str, Sequence[str], None] = "8b2cb551f884"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Применение изменений: добавление атрибутов масштабирования, аудита,
    генерируемой колонки, ограничений целостности и перестройка индексов.
    """
    # а) Добавление новых колонок таблицы events со значениями по умолчанию
    op.add_column(
        "events", sa.Column("rank", sa.String(length=16), nullable=False, server_default="year")
    )
    op.add_column("events", sa.Column("parent_id", sa.Integer(), nullable=True))
    op.add_column("events", sa.Column("source", sa.Text(), nullable=True))
    op.add_column(
        "events",
        sa.Column(
            "calendar_system",
            sa.String(length=24),
            nullable=False,
            server_default="gregorian_proleptic",
        ),
    )
    op.add_column(
        "events",
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.add_column(
        "events",
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # б) Добавление материализованной генерируемой колонки эффективной даты окончания
    op.add_column(
        "events",
        sa.Column(
            "end_date_effective",
            sa.BIGINT(),
            sa.Computed("COALESCE(end_date, start_date)", persisted=True),
            nullable=False,
        ),
    )

    # в) Создание внешнего ключа для древовидной иерархии событий с обнулением при удалении предка
    op.create_foreign_key(
        "fk_events_parent_id", "events", "events", ["parent_id"], ["id"], ondelete="SET NULL"
    )

    # г) Нормализация существующих данных для исключения конфликтов с CHECK-ограничениями
    # Корректировка невалидных статусов модерации
    op.execute(
        "UPDATE events SET status = 'pending' WHERE status NOT IN ('pending', 'approved', 'rejected') OR status IS NULL;"
    )
    # Корректировка уровней детализации (рангов)
    op.execute(
        "UPDATE events SET rank = 'year' WHERE rank NOT IN ('century', 'decade', 'year', 'month', 'day', 'hour', 'minute', 'second') OR rank IS NULL;"
    )
    # Корректировка календарных систем
    op.execute(
        "UPDATE events SET calendar_system = 'gregorian_proleptic' WHERE calendar_system NOT IN ('gregorian_proleptic', 'julian') OR calendar_system IS NULL;"
    )
    # Сброс даты окончания в NULL, если она меньше даты начала
    op.execute(
        "UPDATE events SET end_date = NULL WHERE end_date IS NOT NULL AND end_date < start_date;"
    )
    # Приведение дат за пределами хронологической шкалы платформы к нулевой отметке
    op.execute(
        "UPDATE events SET start_date = 0 WHERE start_date < -31557600000000 OR start_date > 32503680000;"
    )

    # д) Создание пяти проверочных ограничений CHECK на уровне ядра СУБД
    op.create_check_constraint(
        "ck_events_end_after_start", "events", "end_date IS NULL OR end_date >= start_date"
    )
    op.create_check_constraint(
        "ck_events_rank_allowed",
        "events",
        "rank IN ('century', 'decade', 'year', 'month', 'day', 'hour', 'minute', 'second')",
    )
    op.create_check_constraint(
        "ck_events_status_allowed", "events", "status IN ('pending', 'approved', 'rejected')"
    )
    op.create_check_constraint(
        "ck_events_calendar_allowed",
        "events",
        "calendar_system IN ('gregorian_proleptic', 'julian')",
    )
    op.create_check_constraint(
        "ck_events_start_date_bounds",
        "events",
        "start_date >= -31557600000000 AND start_date <= 32503680000",
    )

    # е) Удаление устаревших одиночных и неоптимальных композитных индексов
    op.drop_index("ix_events_start_date", table_name="events")
    op.drop_index("ix_events_category", table_name="events")
    op.drop_index("ix_events_end_date", table_name="events")
    op.drop_index("ix_events_start_end_date", table_name="events")

    # ж) Создание новых оптимизированных индексов под интервальные выборки и иерархию
    op.create_index(
        "ix_events_start_effective", "events", ["start_date", "end_date_effective"], unique=False
    )
    op.create_index("ix_events_parent_id", "events", ["parent_id"], unique=False)
    op.create_index("ix_events_status_start_date", "events", ["status", "start_date"], unique=False)


def downgrade() -> None:
    """
    Откат изменений: симметричное удаление новых индексов, ограничений, внешнего ключа,
    генерируемой колонки и добавленных атрибутов, восстановление старых индексов.
    """
    # а) Удаление новых специализированных индексов
    op.drop_index("ix_events_status_start_date", table_name="events")
    op.drop_index("ix_events_parent_id", table_name="events")
    op.drop_index("ix_events_start_effective", table_name="events")

    # б) Восстановление ранее удаленных индексов старой схемы
    op.create_index("ix_events_start_end_date", "events", ["start_date", "end_date"], unique=False)
    op.create_index("ix_events_end_date", "events", ["end_date"], unique=False)
    op.create_index("ix_events_category", "events", ["category"], unique=False)
    op.create_index("ix_events_start_date", "events", ["start_date"], unique=False)

    # в) Удаление пяти проверочных ограничений CHECK
    op.drop_constraint("ck_events_start_date_bounds", "events", type_="check")
    op.drop_constraint("ck_events_calendar_allowed", "events", type_="check")
    op.drop_constraint("ck_events_status_allowed", "events", type_="check")
    op.drop_constraint("ck_events_rank_allowed", "events", type_="check")
    op.drop_constraint("ck_events_end_after_start", "events", type_="check")

    # г) Удаление внешнего ключа связи parent_id
    op.drop_constraint("fk_events_parent_id", "events", type_="foreignkey")

    # д) Удаление материализованной вычисляемой колонки
    op.drop_column("events", "end_date_effective")

    # е) Удаление добавленных информационных и аудит-колонок таблицы
    op.drop_column("events", "updated_at")
    op.drop_column("events", "created_at")
    op.drop_column("events", "calendar_system")
    op.drop_column("events", "source")
    op.drop_column("events", "parent_id")
    op.drop_column("events", "rank")
