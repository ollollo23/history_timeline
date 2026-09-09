"""
Доменные перечисления (Enums) сущностей, статусов модерации,
категорий и календарных систем проекта History Timeline.
"""

from enum import StrEnum


class EventRank(StrEnum):
    """
    Ранг (уровень детализации) исторического события на оси времени.
    Определяет минимальный масштаб отображения маркера события на таймлайне.
    """

    CENTURY = "century"
    DECADE = "decade"
    YEAR = "year"
    MONTH = "month"
    DAY = "day"
    HOUR = "hour"
    MINUTE = "minute"
    SECOND = "second"

    def depth_level(self) -> int:
        """
        Возвращает порядковый номер глубины детализации от крупного к мелкому.
        Используется для проверки корректности иерархических связей родитель-потомок:
        century=0, decade=1, year=2, month=3, day=4, hour=5, minute=6, second=7.
        """
        # Фиксация строгой числовой иерархии для математического сравнения масштабов
        depth_mapping: dict[EventRank, int] = {
            EventRank.CENTURY: 0,
            EventRank.DECADE: 1,
            EventRank.YEAR: 2,
            EventRank.MONTH: 3,
            EventRank.DAY: 4,
            EventRank.HOUR: 5,
            EventRank.MINUTE: 6,
            EventRank.SECOND: 7,
        }
        return depth_mapping[self]


class EventStatus(StrEnum):
    """
    Жизненный цикл и статус модерации исторического события в системе.
    """

    # Событие создано пользователем и ожидает проверки модератором
    PENDING = "pending"

    # Событие одобрено модератором и доступно в публичном таймлайне
    APPROVED = "approved"

    # Заявка на добавление или изменение события отклонена
    REJECTED = "rejected"


class EventCategory(StrEnum):
    """
    Тематическая категория исторического события для визуальной фильтрации
    и цветового кодирования слоев таймлайна.
    """

    # Культура, искусство, религия, архитектура
    CULTURE = "culture"

    # Политика, войны, революции, государственные институты
    POLITICS = "politics"

    # Экономика, торговля, промышленность, финансы
    ECONOMY = "economy"

    # Наука, образование, технологии, географические открытия
    SCIENCE = "science"


class CalendarSystem(StrEnum):
    """
    Система летоисчисления, используемая для пересчета исторических дат.
    """

    # Пролептический григорианский календарь (базовый стандарт ISO 8601)
    GREGORIAN_PROLEPTIC = "gregorian_proleptic"

    # Юлианский календарь (старый стиль, актуален для истории до реформ)
    JULIAN = "julian"


# Декларирование публичного интерфейса модуля ядра
__all__: list[str] = [
    "CalendarSystem",
    "EventCategory",
    "EventRank",
    "EventStatus",
]
