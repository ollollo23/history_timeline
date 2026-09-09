"""
Модуль централизованной конфигурации окружения и настроек приложения History Timeline.
Считывает переменные среды и значения из файла .env, выполняет предварительную
нормализацию и валидацию через Pydantic v2 и pydantic-settings.
"""

from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Определение абсолютного пути к корневой директории проекта (history_timeline)
BASE_DIR: Path = Path(__file__).resolve().parent.parent.parent.parent


class Settings(BaseSettings):
    """
    Централизованная конфигурация приложения и параметров инфраструктуры.
    Считывает переменные окружения и значения из корневого файла .env с валидацией через Pydantic v2.
    """

    # Системное окружение и метаданные сервиса
    app_env: Literal["local", "ci", "prod"] = Field(
        default="local",
        description="Тип текущего окружения",
    )
    app_title: str = Field(
        default="History Timeline API",
        description="Название сервиса",
    )
    app_version: str = Field(
        default="1.0.0",
        description="Текущая версия API",
    )
    debug: bool = Field(
        default=False,
        description="Режим отладки и расширенного логирования",
    )

    # Безопасность: CORS и лимиты входящих данных
    cors_origins: list[str] = Field(
        default=["http://localhost:8000", "http://127.0.0.1:8000"],
        description="Список разрешенных источников для CORS-запросов",
    )
    max_request_body_bytes: int = Field(
        default=2097152,
        description="Максимальный размер тела входящего запроса в байтах (2 МБ)",
    )

    # Обязательные параметры подключения к PostgreSQL
    db_host: str = Field(
        ...,
        description="Хост базы данных PostgreSQL",
    )
    db_port: int = Field(
        ...,
        description="Порт базы данных PostgreSQL",
    )
    db_user: str = Field(
        ...,
        description="Имя пользователя PostgreSQL",
    )
    db_pass: str = Field(
        ...,
        description="Пароль пользователя PostgreSQL",
    )
    db_name: str = Field(
        ...,
        description="Имя базы данных PostgreSQL",
    )

    # Конфигурация пула асинхронных соединений SQLAlchemy (asyncpg)
    db_pool_size: int = Field(
        default=5,
        description="Базовый размер пула соединений SQLAlchemy",
    )
    db_max_overflow: int = Field(
        default=10,
        description="Максимальное количество дополнительных соединений сверх пула",
    )
    db_pool_recycle: int = Field(
        default=1800,
        description="Время жизни соединения в пуле в секундах до переподключения",
    )
    db_echo: bool = Field(
        default=False,
        description="Логирование SQL-запросов движка",
    )

    # Параметры изолированного тестового окружения
    test_db_name: str = Field(
        default="timeline_test_db",
        description="Имя тестовой базы данных",
    )

    @field_validator("app_env", mode="before")
    @classmethod
    def normalize_app_env(cls, value: object) -> object:
        """
        Валидатор предварительной обработки значения APP_ENV.
        Очищает строку от пробелов и приводит к нижнему регистру перед передачей
        на проверку соответствия аннотации Literal['local', 'ci', 'prod'].
        """
        if isinstance(value, str):
            return value.strip().lower()
        return value

    @property
    def database_url(self) -> str:
        """
        Формирование асинхронной строки подключения к основной СУБД для драйвера asyncpg.
        """
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_pass}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def test_database_url(self) -> str:
        """
        Формирование асинхронной строки подключения к тестовой СУБД для драйвера asyncpg.
        """
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_pass}"
            f"@{self.db_host}:{self.db_port}/{self.test_db_name}"
        )

    # Конфигурация парсинга переменных окружения из корневого файла .env
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


# Инициализация глобального синглтона настроек сервиса
settings = Settings()
