from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Конфигурация приложения и параметры окружения.
    Считывает значения из переменных среды или .env файла с валидацией через Pydantic.
    """

    # Системные метаданные сервиса с значениями по умолчанию
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

    @property
    def database_url(self) -> str:
        """
        Формирование асинхронной строки подключения к СУБД для драйвера asyncpg.
        """
        return (
            f"postgresql+asyncpg://{self.db_user}:{self.db_pass}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    # Конфигурация парсинга переменных окружения
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


# Инициализация глобального синглтона настроек
settings = Settings()