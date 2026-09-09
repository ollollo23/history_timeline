"""
Модульные тесты конфигурации приложения History Timeline.
Проверяет валидацию и нормализацию переменных окружения класса Settings,
а также обработку некорректных значений и нестроковых типов.
"""

import pytest
from pydantic import ValidationError

from app.core.config.config import Settings


@pytest.fixture(autouse=True)
def setup_mandatory_db_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Автоматическая фикстура для изоляции обязательных параметров подключения к базе данных.
    Гарантирует успешное конструирование экземпляра Settings на изолированных контурах CI.
    """
    # Фиксация фиктивных значений обязательных полей конфигурации подключения к PostgreSQL
    monkeypatch.setenv("DB_HOST", "localhost")
    monkeypatch.setenv("DB_PORT", "5432")
    monkeypatch.setenv("DB_USER", "postgres")
    monkeypatch.setenv("DB_PASS", "mock_password")
    monkeypatch.setenv("DB_NAME", "timeline_db")


@pytest.mark.unit
def test_settings_app_env_normalized(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Проверка нормализации строковых значений переменной APP_ENV.
    Краевые пробельные символы, табуляция и регистр должны приводиться к нижнему регистру.
    """
    # Проверка нормализации окружения prod с краевыми пробелами и верхним регистром
    monkeypatch.setenv("APP_ENV", "   PROD  ")
    settings_prod = Settings()
    assert settings_prod.app_env == "prod"

    # Проверка нормализации окружения ci со спецсимволами табуляции и перевода строки
    monkeypatch.setenv("APP_ENV", "\t ci \n")
    settings_ci = Settings()
    assert settings_ci.app_env == "ci"


@pytest.mark.unit
def test_settings_app_env_invalid_raises_validation_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Проверка отклонения недопустимого типа окружения.
    Значения вне Literal['local', 'ci', 'prod'] должны вызывать ValidationError.
    """
    # Установка значения окружения, не входящего в список допустимых литералов
    monkeypatch.setenv("APP_ENV", "staging")

    # Конструирование объекта конфигурации должно завершиться ошибкой валидации схемы
    with pytest.raises(ValidationError) as exc_info:
        Settings()

    # Проверка указания проблемного атрибута app_env в тексте исключения
    assert "app_env" in str(exc_info.value)


@pytest.mark.unit
def test_settings_normalize_app_env_non_string_fallback() -> None:
    """
    Проверка обработки нестроковых и пустых значений в валидаторе normalize_app_env.
    Обеспечивает 100% ветвевое покрытие при передаче типов, отличных от str.
    """
    # Проверка сохранения целочисленного значения без вызова методов строки
    assert Settings.normalize_app_env(123) == 123

    # Проверка сохранения значения None без генерации AttributeError
    assert Settings.normalize_app_env(None) is None
