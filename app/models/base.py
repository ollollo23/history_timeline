import re
from sqlalchemy.orm import DeclarativeBase, declared_attr


class Base(DeclarativeBase):
    """
    Базовый декларативный класс для всех ORM-моделей проекта.
    Автоматически формирует имя таблицы на основе имени Python-класса.
    """

    @declared_attr.directive
    def __tablename__(cls) -> str:
        # Преобразование имени класса из CamelCase в snake_case с помощью регулярного выражения
        snake_case_name = re.sub(r"(?<!^)(?=[A-Z])", "_", cls.__name__).lower()
        # Добавление суффикса 's' для формирования названия таблицы во множественном числе
        return f"{snake_case_name}s"