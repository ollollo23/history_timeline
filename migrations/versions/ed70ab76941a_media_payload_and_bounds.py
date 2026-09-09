"""media_payload_and_bounds

Revision ID: ed70ab76941a
Revises: 654f3007f389
Create Date: 2026-09-06 08:54:32.179607

"""

from collections.abc import Sequence

from alembic import op

# Идентификаторы ревизий миграций Alembic
revision: str = "ed70ab76941a"
down_revision: str | Sequence[str] | None = "654f3007f389"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """
    Применение миграции: нормализация существующих данных таблицы events
    и создание проверочных ограничений ck_events_end_date_bounds и ck_events_media_payload_is_array.
    """
    # Блок 1: Нормализация существующих данных таблицы events для предотвращения конфликтов
    # Обнуление значений media_payload, если они не являются JSON-массивами
    op.execute(
        "UPDATE events SET media_payload = NULL "
        "WHERE media_payload IS NOT NULL AND jsonb_typeof(media_payload) != 'array';"
    )
    # Обнуление значений end_date, выходящих за границы допустимого диапазона шкалы платформы
    op.execute(
        "UPDATE events SET end_date = NULL "
        "WHERE end_date IS NOT NULL AND (end_date < -31557600000000 OR end_date > 32503680000);"
    )

    # Блок 2: Создание проверочных ограничений CheckConstraint на уровне ядра СУБД
    op.create_check_constraint(
        "ck_events_end_date_bounds",
        "events",
        "end_date IS NULL OR (end_date >= -31557600000000 AND end_date <= 32503680000)",
    )
    op.create_check_constraint(
        "ck_events_media_payload_is_array",
        "events",
        "media_payload IS NULL OR jsonb_typeof(media_payload) = 'array'",
    )


def downgrade() -> None:
    """
    Откат миграции: симметричное удаление проверочных ограничений CheckConstraint.
    Внимание: значения колонок media_payload и end_date, приведенные к NULL в ходе
    нормализации данных в функции upgrade(), являются необратимыми и не подлежат восстановлению.
    """
    # Симметричное удаление проверочных ограничений в порядке, обратном их созданию
    op.drop_constraint("ck_events_media_payload_is_array", "events", type_="check")
    op.drop_constraint("ck_events_end_date_bounds", "events", type_="check")
