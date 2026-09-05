"""
Базовый декларативный класс для всех ORM-моделей проекта History Timeline.
Использует стандарт DeclarativeBase SQLAlchemy 2.0.
"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """
    Базовый декларативный класс для всех ORM-моделей проекта.

    Каждая дочерняя модель обязана явно определять атрибут __tablename__,
    что исключает ошибки автоматической плюрализации (например,
    event_categorys вместо event_categories) и обеспечивает явный контракт
    с реляционной схемой базы данных.
    """

    pass
