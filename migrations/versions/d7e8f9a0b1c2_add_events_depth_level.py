"""add_events_depth_level

Revision ID: d7e8f9a0b1c2
Revises: a1b2c3d4e5f6
Create Date: 2026-09-26 10:00:00.000000

"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

# Идентификаторы ревизий миграций Alembic
revision: str = "d7e8f9a0b1c2"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """
    Применение миграции: добавление вычисляемой колонки depth_level.

    Создает хранимую вычисляемую колонку depth_level (SMALLINT) в таблице events
    на базе выражения CASE по колонке rank. Обеспечивает числовое ранжирование
    масштаба детализации (от 0 для century до 7 для second), оптимизируя
    усечение интервальной выборки по важности и серверный контроль иерархии связей.
    Флаг nullable=True сохраняет приоритет диагностического срабатывания
    проверочного ограничения ck_events_rank_allowed при передаче некорректных рангов.
    """
    op.add_column(
        "events",
        sa.Column(
            "depth_level",
            sa.SmallInteger(),
            sa.Computed(
                "CASE rank "
                "WHEN 'century' THEN 0 "
                "WHEN 'decade' THEN 1 "
                "WHEN 'year' THEN 2 "
                "WHEN 'month' THEN 3 "
                "WHEN 'day' THEN 4 "
                "WHEN 'hour' THEN 5 "
                "WHEN 'minute' THEN 6 "
                "WHEN 'second' THEN 7 "
                "END",
                persisted=True,
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    """
    Откат миграции: удаление вычисляемой колонки depth_level.
    """
    op.drop_column("events", "depth_level")
