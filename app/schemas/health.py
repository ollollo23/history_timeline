"""
Схема валидации и сериализации данных эндпоинта проверки работоспособности сервиса.
Соответствует стандартам Pydantic v2 и регламентирует строгий контракт мониторинга.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    """
    Pydantic-схема ответа мониторинга состояния (Health Check) сервиса History Timeline API.

    Поля схемы:
    - status: строгий статус состояния ('ok' при доступности всех систем, 'degraded' при сбое соединения с СУБД);
    - db_connected: булев индикатор фактической доступности подключения к PostgreSQL;
    - version: валидированная непустая строка версии приложения из конфигурации.
    """

    # Общий статус работоспособности сервиса
    status: Literal["ok", "degraded"] = Field(
        ...,
        description="Общий статус работоспособности сервиса (ok при доступной СУБД, degraded при сбое соединения)",
    )

    # Флаг фактической доступности подключения к базе данных PostgreSQL
    db_connected: bool = Field(
        ...,
        description="Флаг фактической доступности подключения к базе данных PostgreSQL",
    )

    # Текущая версия сервиса History Timeline API из конфигурации приложения
    version: str = Field(
        ...,
        min_length=1,
        description="Текущая версия сервиса History Timeline API из конфигурации приложения",
    )

    # Запрет передачи лишних полей и поддержка маппинга из объектов с атрибутами
    model_config = ConfigDict(
        from_attributes=True,
        extra="forbid",
    )


# Публичный интерфейс модуля валидации мониторинга
__all__: list[str] = ["HealthResponse"]
