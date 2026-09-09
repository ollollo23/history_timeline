"""
Главный модуль приложения History Timeline API.
Настраивает жизненный цикл сервиса, централизованную обработку доменных исключений,
стек middleware, раздачу статики и изолированный fallback для SPA-маршрутизации.
"""

from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError

from app.api.router import api_router
from app.core.config.config import settings
from app.core.config.python_spec import verify_python_environment
from app.core.database.database import engine
from app.core.exceptions import (
    DomainError,
    EventNotFoundError,
    InvalidDateRangeError,
    InvalidParentRankError,
)
from app.core.logger import logger, setup_logging

# Первичная инициализация структурированного логирования приложения
setup_logging()

# Контроль окружения: аварийная остановка процесса при несоответствии версии Python 3.14.7
verify_python_environment()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    """
    Управление жизненным циклом (Lifespan) приложения FastAPI.
    Регистрирует запуск сервиса и гарантирует освобождение пула соединений СУБД при выключении.
    """
    # Фиксация события старта веб-сервиса
    logger.info(
        "Запуск сервиса %s v%s...",
        settings.app_title,
        settings.app_version,
    )

    yield

    # Корректное закрытие всех открытых сетевых соединений пула asyncpg к PostgreSQL
    await engine.dispose()
    logger.info("Сервис %s успешно остановлен, пул соединений освобожден.", settings.app_title)


# Инициализация основного экземпляра приложения FastAPI
# debug=False принудительно отключает ServerErrorMiddleware для защиты от утечки трассировок
app = FastAPI(
    title=settings.app_title,
    version=settings.app_version,
    lifespan=lifespan,
    debug=False,
)


# --- Централизованная обработка исключений ---


@app.exception_handler(EventNotFoundError)
async def event_not_found_handler(request: Request, exc: EventNotFoundError) -> JSONResponse:
    """Обработка попытки доступа к несуществующему событию (404 Not Found)."""
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"detail": exc.message},
    )


@app.exception_handler(InvalidDateRangeError)
async def invalid_date_range_handler(request: Request, exc: InvalidDateRangeError) -> JSONResponse:
    """Обработка ошибок хронологических границ и невалидных диапазонов (400 Bad Request)."""
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"detail": exc.message},
    )


@app.exception_handler(InvalidParentRankError)
async def invalid_parent_rank_handler(
    request: Request, exc: InvalidParentRankError
) -> JSONResponse:
    """Обработка нарушения иерархии рангов масштабирования событий (400 Bad Request)."""
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"detail": exc.message},
    )


@app.exception_handler(DomainError)
async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
    """
    Централизованный перехватчик базовых доменных исключений DomainError.
    Обрабатывает базовые бизнес-ошибки и любые подклассы DomainError, не имеющие
    специфического статус-кода, возвращая статус 400 Bad Request вместо непредвиденного 500.
    """
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"detail": exc.message},
    )


@app.exception_handler(IntegrityError)
async def integrity_error_handler(request: Request, exc: IntegrityError) -> JSONResponse:
    """
    Обработка аппаратных ограничений целостности базы данных (409 Conflict).
    Логирование уровня ERROR с трассировкой стека (exc_info=True) фиксирует
    точное имя нарушенного ограничения CheckConstraint, внешнего ключа или уникальности,
    предотвращая потерю диагностического контекста в тестах и CI/CD при сокрытии деталей от клиента.
    """
    # Логирование полной информации об исключении базы данных на уровне ERROR со стеком вызовов
    logger.error("Конфликт целостности данных СУБД (IntegrityError): %s", exc, exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": "Нарушение ограничений целостности данных базы данных."},
    )


@app.exception_handler(status.HTTP_500_INTERNAL_SERVER_ERROR)
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Глобальный перехватчик непредвиденных системных исключений (500 Internal Server Error).
    Зарегистрирован как на статус 500, так и на базовый класс Exception.
    Логирует полный стек вызовов и предотвращает утечку внутренней технической информации клиенту.
    """
    logger.error(
        "Необработанное исключение при обработке запроса: %s",
        exc,
        exc_info=True,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Внутренняя ошибка сервера."},
    )


# --- Стек Middleware ---


@app.middleware("http")
async def validate_request_body_size(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """
    Middleware валидации предельного размера тела HTTP-запроса для защиты от атак типа DoS.
    Отклоняет запросы, превышающие settings.max_request_body_bytes, до начала вычитывания сокета.

    Известное ограничение:
    При передаче полезной нагрузки с заголовком Transfer-Encoding: chunked заголовок
    Content-Length в HTTP-запросе отсутствует, в связи с чем предварительная проверка
    размера тела не применяется. Полноценная защита от DoS-атак с потоковой передачей
    требует итеративного подсчета прочитанных байтов на уровне ASGI-конвейера и вынесена
    в спринт оптимизации инфраструктуры.
    """
    content_length = request.headers.get("content-length")
    if (
        content_length is not None
        and content_length.isdigit()
        and int(content_length) > settings.max_request_body_bytes
    ):
        return JSONResponse(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            content={"detail": "Размер тела запроса превышает допустимый лимит."},
        )
    return await call_next(request)


# Сжатие ответов, превышающих 1000 байт, алгоритмом Gzip для экономии трафика
app.add_middleware(
    GZipMiddleware,
    minimum_size=1000,
)

# Настройка правил совместного использования ресурсов между разными источниками (CORS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Маршрутизация API и статические ресурсы ---

# Подключение центрального маршрутизатора API версионирования v1
app.include_router(
    api_router,
    prefix="/api/v1",
)

# Определение пути к клиентской директории приложения
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

# Монтирование раздачи статических файлов интерфейса (CSS, JS, иконки)
if FRONTEND_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=FRONTEND_DIR),
        name="static",
    )


@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(full_path: str, request: Request) -> Response:
    """
    Перехватчик клиентских путей для поддержки HTML5 History API (SPA-роутер).
    Изолирует системные эндпоинты API и служебные пути по первому сегменту URL,
    предотвращая ложную отдачу HTML-каркаса интерфейса вместо статуса 404 JSON.
    """
    # Нормализация входящего пути со снятием краевых слешей
    normalized_path = full_path.strip("/")
    # Разделение пути на составляющие сегменты
    segments = normalized_path.split("/") if normalized_path else []
    # Извлечение первого сегмента для точного соответствия
    first_segment = segments[0].lower() if segments else ""

    # Изоляция несуществующих маршрутов API: возвращает JSON 404
    if first_segment == "api":
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"detail": "Эндпоинт API не найден."},
        )

    # Изоляция служебных маршрутов документации и статических ресурсов: возвращает JSON 404
    if first_segment in {"static", "docs", "redoc", "openapi.json"}:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"detail": "Запрашиваемый ресурс не найден."},
        )

    # Отдача главного файла SPA для клиентской маршрутизации
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)

    # Запасной ответ при отсутствии собранного фронтенда
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={"message": "Frontend is under construction"},
    )
