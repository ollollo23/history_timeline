import sys
from typing import Final

# Системное константное объявление поддерживаемой ветки среды исполнения
TARGET_PYTHON_BRANCH: Final[str] = "3.14"


def verify_python_environment() -> None:
    """
    Проверка соответствия версии интерпретатора установленным системным требованиям.
    Вызывается при старте FastAPI-приложения в рамках менеджера жизненного цикла lifespan.
    """
    # Считывание параметров мажорной и минорной версии CPython
    current_major: int = sys.version_info.major
    current_minor: int = sys.version_info.minor

    # Валидация запуска на целевой ветке Python 3.14 или выше
    if (current_major, current_minor) < (3, 14):
        raise RuntimeError(
            f"Несовместимая версия Python: {sys.version}. "
            f"Для работы сервиса требуется Python {TARGET_PYTHON_BRANCH} или выше."
        )


if __name__ == "__main__":
    # Локальный запуск проверки окружения из командной строки
    verify_python_environment()
    print(f"Среда успешно валидирована для ветки Python {TARGET_PYTHON_BRANCH}+.")