"""add_gist_range_index

Revision ID: a1b2c3d4e5f6
Revises: ed70ab76941a
Create Date: 2026-09-09 12:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

# Идентификаторы ревизий миграций Alembic
revision: str = "a1b2c3d4e5f6"
down_revision: str | Sequence[str] | None = "ed70ab76941a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """
    Применение миграции: создание функционального GiST-индекса для интервальных выборок.

    Создает специализированный GiST-индекс ix_events_int8range_gist по вычисляемому
    выражению int8range(start_date, end_date_effective, '[]'). Индекс оптимизирует
    выполнение двумерных диапазонных выборок с оператором перекрытия (&&) и устраняет
    деградацию производительности до полного последовательного сканирования (Seq Scan),
    выявленную при профилировании широких временных окон.
    Встроенный тип int8range поддерживает класс операторов range_ops нативно,
    поэтому подключение внешнего расширения btree_gist не требуется.
    """
    # Исполнение DDL-команды создания функционального GiST-индекса над замкнутым диапазоном
    op.execute(
        "CREATE INDEX ix_events_int8range_gist ON events "
        "USING gist (int8range(start_date, end_date_effective, '[]'));"
    )


def downgrade() -> None:
    """
    Откат миграции: безопасное удаление функционального GiST-индекса.
    """
    # Исполнение DDL-команды безопасного удаления индекса
    op.execute("DROP INDEX IF EXISTS ix_events_int8range_gist;")
