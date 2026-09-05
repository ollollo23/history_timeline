import logging
import sys

from app.core.config.config import settings

# Создание именованного логгера для логирования событий бизнес-логики сервиса
logger: logging.Logger = logging.getLogger("timeline_app")


def setup_logging() -> None:
    """
    Централизованная инициализация конфигурации логирования приложения.
    Настраивает корневой логгер, поток вывода sys.stdout, форматирование и фильтрацию шумных библиотек.
    """
    # Выбор базового уровня логирования в зависимости от режима отладки
    log_level = logging.DEBUG if settings.debug else logging.INFO

    # Шаблон форматирования: дата/время | уровень | модуль:строка - сообщение
    log_format = "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d - %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    # Применение базовой конфигурации с принудительным переопределением обработчиков (force=True)
    logging.basicConfig(
        level=log_level,
        format=log_format,
        datefmt=date_format,
        stream=sys.stdout,
        force=True,
    )

    # Подавление избыточных информационных сообщений доступа сервера Uvicorn
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    # Отключение подробного SQL-трейсинга SQLAlchemy Engine в боевом режиме
    if not settings.debug:
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
