"""
Константы физических и календарных единиц измерения времени,
а также глобальные хронологические ограничения шкалы History Timeline.
"""

from typing import Final

# Базовая системная единица измерения времени для всех временных меток проекта
TIME_UNIT: Final[str] = "seconds"
"""
Базовая системная единица измерения времени.
Поля start_date и end_date в системе хранят целое число секунд относительно
эпохи Unix (1970-01-01T00:00:00Z UTC), поддерживают отрицательные значения
для датировки исторических событий до нашей эры (BCE) и строго исключают дробную часть.
"""

# Целочисленные константы пересчета интервалов времени в секунды
SECONDS_PER_MINUTE: Final[int] = 60
SECONDS_PER_HOUR: Final[int] = 3600  # 60 * SECONDS_PER_MINUTE
SECONDS_PER_DAY: Final[int] = 86400  # 24 * SECONDS_PER_HOUR
SECONDS_PER_YEAR_AVG: Final[int] = (
    31557600  # Средний юлианский астрономический год: 365.25 суток по 86400 с
)
SECONDS_PER_CENTURY_AVG: Final[int] = 3155760000  # 100 * SECONDS_PER_YEAR_AVG (31557600 * 100)

# Глобальные допустимые хронологические границы временной шкалы проекта
TIMELINE_MIN_TIMESTAMP: Final[int] = -31557600000000
"""
Нижняя граница таймлайна (приблизительно 1 000 000 лет до н.э.).
Охватывает эпоху плейстоцена и появление рода Homo.
Безопасно укладывается в диапазон PostgreSQL BIGINT и JavaScript Number.MAX_SAFE_INTEGER.
"""

TIMELINE_MAX_TIMESTAMP: Final[int] = 32503680000
"""
Верхняя граница таймлайна (01.01.3000T00:00:00Z UTC).
Предельная хронологическая точка для планирования будущих событий.
"""

# Явное декларирование публичного интерфейса модуля констант
__all__: list[str] = [
    "SECONDS_PER_CENTURY_AVG",
    "SECONDS_PER_DAY",
    "SECONDS_PER_HOUR",
    "SECONDS_PER_MINUTE",
    "SECONDS_PER_YEAR_AVG",
    "TIMELINE_MAX_TIMESTAMP",
    "TIMELINE_MIN_TIMESTAMP",
    "TIME_UNIT",
]
