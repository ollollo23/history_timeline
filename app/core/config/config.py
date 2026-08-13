from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Системная информация
    app_title: str = "History Timeline API"
    app_version: str = "1.0.0"
    debug: bool = False

    # Параметры подключения к PostgreSQL, считываемые из файла .env
    db_host: str
    db_port: int
    db_user: str
    db_pass: str
    db_name: str

    @property
    def database_url(self) -> str:
        # Формирование строки подключения по схеме postgresql+asyncpg://
        return f"postgresql+asyncpg://{self.db_user}:{self.db_pass}@{self.db_host}:{self.db_port}/{self.db_name}"

    # Конфигурация модели для корректного поиска и парсинга файла .env
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


# Создание глобального экземпляра настроек для импорта в других модулях
settings = Settings()