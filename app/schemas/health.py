from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    """
    Pydantic-схема для валидации и сериализации ответа эндпоинта мониторинга состояния сервиса.
    """
    status: str = Field(
        default="ok",
        description="Общий статус работоспособности сервиса",
    )
    db_connected: bool = Field(
        default=True,
        description="Флаг доступности подключения к базе данных PostgreSQL",
    )
    version: str = Field(
        default="1.0.0",
        description="Текущая версия сервиса History Timeline API",
    )

    # Разрешение маппинга данных из объектов с атрибутами (Pydantic v2)
    model_config = ConfigDict(from_attributes=True)