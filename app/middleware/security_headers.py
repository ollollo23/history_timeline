"""
Промежуточный слой (middleware) установки HTTP-заголовков безопасности
и динамической политики защиты контента (Content Security Policy).
Обеспечивает защиту от атак межсайтового скриптинга (XSS), кликджекинга
и недоверенного внедрения мультимедиа.
"""

from collections.abc import Awaitable, Callable
from typing import Final

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from app.core.config.config import settings

# Маршруты документации OpenAPI, исключаемые из политики жесткого CSP
DOCS_PATHS: Final[tuple[str, ...]] = ("/docs", "/redoc", "/openapi.json")


def build_csp_header(embed_hosts: list[str]) -> str:
    """
    Формирует строку заголовка Content-Security-Policy на основе доверенных хостов.

    Параметры:
    embed_hosts: Список доверенных доменов для встраивания во фреймы.

    Возвращает:
    Строку скомпилированной политики CSP с разделителем '; '.
    """
    # Сборка источников для директивы frame-src с добавлением корневого домена и поддоменов
    frame_sources: list[str] = ["'self'"]
    for host in embed_hosts:
        cleaned_host = host.strip().lower()
        if cleaned_host:
            frame_sources.append(f"https://{cleaned_host}")
            frame_sources.append(f"https://*.{cleaned_host}")

    # Формирование упорядоченного перечня директив безопасности
    directives = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' https: data:",
        "media-src https: 'self'",
        f"frame-src {' '.join(frame_sources)}",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ]

    return "; ".join(directives)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Middleware для внедрения стандартных заголовков безопасности HTTP
    и избирательного применения CSP к ответам сервера.
    """

    def __init__(
        self,
        app: ASGIApp,
        embed_hosts: list[str] | None = None,
    ) -> None:
        """
        Инициализация middleware с компиляцией заголовка Content-Security-Policy.

        Параметры:
        app: Экземпляр ASGI-приложения.
        embed_hosts: Пользовательский список доверенных хостов (по умолчанию из settings).
        """
        super().__init__(app)
        hosts_to_use = embed_hosts if embed_hosts is not None else settings.embed_allowed_hosts
        self.csp_header: str = build_csp_header(hosts_to_use)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        """
        Перехват входящего HTTP-запроса и добавление заголовков безопасности к ответу.

        Параметры:
        request: Объект входящего запроса Starlette/FastAPI.
        call_next: Следующий обработчик в конвейере middleware.

        Возвращает:
        Модифицированный объект Response с установленными заголовками безопасности.
        """
        response = await call_next(request)

        # Базовые заголовки защиты от сниффинга MIME-типов и утечки реферера
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"

        # Наложение политики CSP только на пользовательские маршруты, исключая документацию
        path = request.url.path
        if not any(path.startswith(docs_path) for docs_path in DOCS_PATHS):
            response.headers["Content-Security-Policy"] = self.csp_header

        return response


# Явное декларирование публичного интерфейса модуля
__all__: list[str] = [
    "SecurityHeadersMiddleware",
    "build_csp_header",
]
