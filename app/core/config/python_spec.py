# Фиксация стандартов разработки под Python 3.14.7
from typing import Final

# Системное константное объявление поддерживаемой версии среды исполнения
TARGET_PYTHON_VERSION: Final[str] = "3.14.7"


def verify_python_environment() -> None:
    """
    Проверка соответствия версии интерпретатора установленным системным требованиям.
    Вызывается при старте FastAPI-приложения.
    """
    import sys

    # Считывание текущих параметров версии CPython
    current_major: int = sys.version_info.major
    current_minor: int = sys.version_info.minor

    # Валидация запуска на целевой ветке Python 3.14+
    if (current_major, current_minor) < (3, 14):
        raise RuntimeError(
            f"Несовместимая версия Python: {sys.version}. "
            f"Для работы сервиса требуется Python {TARGET_PYTHON_VERSION} или выше."
        )


if __name__ == "__main__":
    # Локальный запуск скрипта проверки
    verify_python_environment()
    print(f"Среда успешно валидирована для Python {TARGET_PYTHON_VERSION}.")