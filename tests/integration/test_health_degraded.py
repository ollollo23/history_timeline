"""
Интеграционный тест проверки деградации сервиса при физическом отказе подключения к СУБД.
Проверяет обработку реального сетевого сбоя драйвером asyncpg в эндпоинте /api/v1/health
без использования mock-объектов через фикстуру uow_client.
"""

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

import app.core.database.database as db_module
from app.core.config.config import settings


@pytest.mark.integration
@pytest.mark.asyncio
async def test_health_endpoint_real_db_failure_returns_503(
    uow_client: AsyncClient,
) -> None:
    """
    Верификация возврата HTTP 503 Service Unavailable при реальном сбое сетевого подключения.

    Механизм проверки:
    1. Создается реальный асинхронный движок SQLAlchemy с заведомо недоступным портом (54399);
    2. Временная подмена db_module.engine перенаправляет вызов get_db_engine() внутри
       эндпоинта health_check на неработоспособный сетевой сокет;
    3. Драйвер asyncpg выбрасывает аппаратное исключение соединения при попытке
       входа в контекст async with engine.connect(), которое перехватывается контроллером;
    4. Контроллер мутирует код ответа на 503 и возвращает схему HealthResponse(status='degraded');
    5. В блоке finally гарантированно восстанавливается исходный движок и освобождаются ресурсы.

    Архитектурное примечание:
    Временная подмена ссылки db_module.engine является потоконебезопасной операцией.
    В случае внедрения параллельного запуска тестов через расширение pytest-xdist
    данный сценарий потребует перевода на выделенный изолированный воркер
    во избежание состояния гонки с параллельными транзакциями.
    """
    # Инициализация реального асинхронного движка с недоступным сетевым адресом
    broken_engine = create_async_engine(
        "postgresql+asyncpg://postgres:wrong_pass@127.0.0.1:54399/nonexistent_db",
        pool_pre_ping=False,
    )

    # Фиксация оригинального продуктового движка для последующего восстановления
    original_engine = db_module.engine

    # Временная подмена движка в модуле базы данных
    db_module.engine = broken_engine

    try:
        # Выполнение асинхронного GET-запроса через сквозной ASGI-клиент
        response = await uow_client.get("/api/v1/health")

        # Проверка установки регламентированного кода деградации сервиса
        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE

        # Проверка полей структуры ответа согласно схеме HealthResponse
        data = response.json()
        assert data["status"] == "degraded"
        assert data["db_connected"] is False
        assert data["version"] == settings.app_version

        # Подтверждение сокрытия внутренней технической информации от клиента
        assert "detail" not in data
    finally:
        # Гарантированное восстановление исходного рабочего движка базы данных
        db_module.engine = original_engine

        # Освобождение ресурсов временного движка
        await broken_engine.dispose()
