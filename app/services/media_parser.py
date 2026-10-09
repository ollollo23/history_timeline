"""
Изолированный сервис разбора, классификации и канонизации медиа-ресурсов.
Выполняет валидацию пользовательских URL, сопоставление хостов с белым списком,
строгую валидацию идентификаторов контента и генерацию безопасных адресов встраивания (embed_url).
Не содержит зависимостей от веб-фреймворков, ORM и баз данных.
"""

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Final
from urllib.parse import SplitResult, parse_qs, urlsplit

from app.core.exceptions import DomainError

# --- Доменные исключения разбора медиа-ресурсов ---


class MediaParserError(DomainError):
    """Базовое исключение доменного сервиса разбора медиа-ресурсов."""

    pass


class UnsupportedMediaProviderError(MediaParserError):
    """
    Исключение, возникающее при передаче URL с неизвестным
    или отсутствующим в белом списке доменным именем.
    """

    pass


class InvalidMediaUrlError(MediaParserError):
    """
    Исключение, возникающее при некорректной структуре URL-адреса,
    наличии управляющих символов, отсутствии обязательных параметров
    или невалидном идентификаторе контента.
    """

    pass


# --- Перечисления и структуры данных ---


class MediaProvider(StrEnum):
    """Регламентированные провайдеры мультимедийного контента платформы."""

    YOUTUBE = "youtube"
    VK = "vk"
    RUTUBE = "rutube"
    YANDEX = "yandex"
    DIRECT = "direct"


class MediaType(StrEnum):
    """Типы поддерживаемых мультимедийных вложений."""

    VIDEO = "video"
    AUDIO = "audio"
    IMAGE = "image"
    LINK = "link"


@dataclass(frozen=True, slots=True)
class ParsedMediaResource:
    """
    Канонический результат синтаксического анализа и валидации медиа-ресурса.

    provider: Строковый идентификатор определенного провайдера.
    media_type: Тип медиа-контента (video или audio).
    embed_url: Сформированный доверенный адрес для iframe-вставки или None для прямого файла.
    raw_url: Исходный валидированный пользовательский URL.
    resource_id: Извлеченный уникальный идентификатор ресурса в системе провайдера.
    """

    provider: str
    media_type: str
    embed_url: str | None
    raw_url: str
    resource_id: str | None


# --- Нормативные константы доверенных доменов и расширений ---


ALLOWED_HOSTS_BY_PROVIDER: Final[dict[MediaProvider, tuple[str, ...]]] = {
    MediaProvider.YOUTUBE: (
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
    ),
    MediaProvider.VK: (
        "vk.com",
        "www.vk.com",
        "vkvideo.ru",
        "www.vkvideo.ru",
    ),
    MediaProvider.RUTUBE: (
        "rutube.ru",
        "www.rutube.ru",
    ),
    MediaProvider.YANDEX: (
        "music.yandex.ru",
        "www.music.yandex.ru",
    ),
}

DIRECT_AUDIO_EXTENSIONS: Final[tuple[str, ...]] = (
    ".mp3",
    ".ogg",
    ".m4a",
    ".wav",
    ".opus",
)


# --- Вспомогательные функции нормализации и сопоставления ---


def normalize_url_host(url_or_host: str) -> str:
    """
    Нормализует строковый URL или доменное имя: извлекает хост,
    отсекает учетные данные пользователя (userinfo), сетевые порты,
    преобразует интернационализированные домены IDN в Punycode/ASCII
    и приводит к нижнему регистру.

    Параметры:
    url_or_host: Полный URL или имя хоста.

    Возвращает:
    Нормализованную строку хоста в нижнем регистре.
    """
    if not isinstance(url_or_host, str):
        return ""

    cleaned = url_or_host.strip()
    if not cleaned:
        return ""

    # Извлечение сетевого адреса (netloc) или сегмента до первого слэша
    cleaned_lower = cleaned.lower()
    if cleaned_lower.startswith(("http://", "https://")):
        try:
            target = urlsplit(cleaned).netloc
        except Exception:
            target = cleaned.split("/", 1)[0]
    else:
        target = cleaned.split("/", 1)[0]

    # Отсечение учетных данных пользователя (user:password@host)
    if "@" in target:
        target = target.rsplit("@", 1)[1]

    # Отсечение сетевого порта с учетом IPv6 в квадратных скобках
    if target.startswith("["):
        closing_bracket = target.find("]")
        if closing_bracket != -1:
            target = target[1:closing_bracket]
    elif ":" in target:
        target = target.split(":", 1)[0]

    # Снятие замыкающей точки FQDN-нотации
    normalized = target.rstrip(".").lower()
    if not normalized:
        return ""

    # Преобразование международных доменных имен IDN в Punycode
    try:
        ascii_host = normalized.encode("idna").decode("ascii").lower()
    except Exception:
        ascii_host = normalized

    return ascii_host


def match_provider_by_host(host: str) -> MediaProvider | None:
    """
    Проверяет принадлежность нормализованного хоста к белому списку доменов провайдеров.

    Параметры:
    host: Нормализованное доменное имя в нижнем регистре.

    Возвращает:
    Значение перечисления MediaProvider либо None, если хост не входит в доверенный перечень.
    """
    if not host:
        return None

    for provider, domains in ALLOWED_HOSTS_BY_PROVIDER.items():
        for domain in domains:
            # Разрешено точное совпадение либо поддомен через разделительную точку
            if host == domain or host.endswith(f".{domain}"):
                return provider
    return None


def is_direct_audio_url(url_or_scheme: str, path: str | None = None) -> bool:
    """
    Проверяет, ссылается ли URL на прямой аудиофайл доверенного формата.
    Поддерживает вызов с одним полным URL либо с парой (scheme, path).

    Параметры:
    url_or_scheme: Полный строковый URL либо схема протокола.
    path: Опциональный путь к файлу без параметров query и fragment.

    Возвращает:
    True, если схема равна строго https и расширение файла входит в DIRECT_AUDIO_EXTENSIONS.
    """
    if path is None:
        try:
            parsed = urlsplit(url_or_scheme)
            scheme = parsed.scheme
            path_val = parsed.path
        except Exception:
            return False
    else:
        scheme = url_or_scheme
        path_val = path

    # Прямые медиа-файлы разрешены исключительно по защищенному протоколу https
    if scheme.lower() != "https":
        return False

    if not path_val:
        return False

    path_lower = path_val.lower()
    return any(path_lower.endswith(ext) for ext in DIRECT_AUDIO_EXTENSIONS)


# --- Специализированные обработчики провайдеров мультимедиа ---


def _parse_youtube(parsed: SplitResult, raw_url: str, host: str) -> ParsedMediaResource:
    """
    Разбор ссылок платформы YouTube (полные ссылки, shorts, embed и youtu.be).

    Параметры:
    parsed: Распарсенная структура SplitResult.
    raw_url: Исходный адрес ресурса.
    host: Нормализованное имя хоста.

    Возвращает:
    ParsedMediaResource со ссылкой на защищенный iframe youtube-nocookie.com.

    Исключения:
    InvalidMediaUrlError: При отсутствии или несоответствии идентификатора формату ^[a-zA-Z0-9_-]{11}$.
    """
    video_id: str | None = None

    if host == "youtu.be" or host.endswith(".youtu.be"):
        # Формат коротких ссылок: https://youtu.be/{video_id}
        path_segments = [seg for seg in parsed.path.split("/") if seg]
        if path_segments:
            video_id = path_segments[0]
    else:
        # Форматы стандартного видео watch, shorts и iframe-вставки embed
        path = parsed.path
        if path == "/watch" or path.startswith("/watch/"):
            query_params = parse_qs(parsed.query)
            v_param = query_params.get("v")
            if v_param:
                video_id = v_param[0]
        elif path.startswith("/shorts/") or path.startswith("/embed/"):
            path_segments = [seg for seg in parsed.path.split("/") if seg]
            if len(path_segments) >= 2 and path_segments[0] in (
                "shorts",
                "embed",
            ):
                video_id = path_segments[1]

    if not video_id:
        raise InvalidMediaUrlError(
            f"Не удалось извлечь идентификатор видео из ссылки YouTube: '{raw_url}'."
        )

    # Строгая проверка длины и символов: ровно 11 допустимых ASCII-знаков
    if not re.fullmatch(r"^[a-zA-Z0-9_-]{11}$", video_id):
        raise InvalidMediaUrlError(
            f"Некорректный формат идентификатора видео YouTube: '{video_id}'."
        )

    # Формирование канонического адреса встраивания без трекинговых параметров
    canonical_embed = f"https://www.youtube-nocookie.com/embed/{video_id}"

    return ParsedMediaResource(
        provider=MediaProvider.YOUTUBE,
        media_type=MediaType.VIDEO,
        embed_url=canonical_embed,
        raw_url=raw_url,
        resource_id=video_id,
    )


def _parse_vk(parsed: SplitResult, raw_url: str) -> ParsedMediaResource:
    """
    Разбор ссылок платформы VK Video (vk.com и vkvideo.ru).

    Параметры:
    parsed: Распарсенная структура SplitResult.
    raw_url: Исходный адрес ресурса.

    Возвращает:
    ParsedMediaResource со ссылкой на плеер video_ext.php.

    Исключения:
    InvalidMediaUrlError: При нечисловых значениях oid/id или невалидном ключе hash.
    """
    oid: str | None = None
    video_id: str | None = None
    hash_val: str | None = None

    path = parsed.path
    query_params = parse_qs(parsed.query)

    if path == "/video_ext.php" or path.startswith("/video_ext.php"):
        # Ссылка на встраиваемый виджет: /video_ext.php?oid={oid}&id={id}&hash={hash}
        oid_param = query_params.get("oid")
        id_param = query_params.get("id")
        oid = oid_param[0] if oid_param else None
        video_id = id_param[0] if id_param else None
        hash_param = query_params.get("hash")
        hash_val = hash_param[0] if hash_param else None
    else:
        # Стандартные ссылки вида /video{oid}_{id} или /video12345_67890
        match = re.match(r"^/video([^_/?#]+)_([^/?#]+)", path)
        if match:
            oid = match.group(1)
            video_id = match.group(2)
            hash_param = query_params.get("hash")
            hash_val = hash_param[0] if hash_param else None

    if not oid or not video_id:
        raise InvalidMediaUrlError(
            f"Не удалось извлечь параметры oid и id для VK Video из ссылки: '{raw_url}'. "
            "Ожидается формат /video{oid}_{id} или /video_ext.php."
        )

    # Идентификатор владельца (oid) обязан быть целым числом (допускается отрицательное для сообществ)
    if not re.fullmatch(r"^-?\d+$", oid):
        raise InvalidMediaUrlError(
            f"Некорректный формат идентификатора владельца (oid) VK: '{oid}'."
        )

    # Идентификатор видеозаписи (id) обязан быть положительным числом
    if not re.fullmatch(r"^\d+$", video_id):
        raise InvalidMediaUrlError(
            f"Некорректный формат идентификатора видео (id) VK: '{video_id}'."
        )

    # Проверка формата опционального параметра hash (алфавитно-цифровой токен доступа)
    if hash_val is not None and not re.fullmatch(r"^[a-zA-Z0-9]+$", hash_val):
        raise InvalidMediaUrlError(
            f"Недопустимый формат параметра hash для VK Video: '{hash_val}'."
        )

    # Канонический URL встраивания
    canonical_embed = f"https://vk.com/video_ext.php?oid={oid}&id={video_id}"
    if hash_val:
        canonical_embed = f"{canonical_embed}&hash={hash_val}"

    return ParsedMediaResource(
        provider=MediaProvider.VK,
        media_type=MediaType.VIDEO,
        embed_url=canonical_embed,
        raw_url=raw_url,
        resource_id=f"{oid}_{video_id}",
    )


def _parse_rutube(parsed: SplitResult, raw_url: str) -> ParsedMediaResource:
    """
    Разбор ссылок видеохостинга Rutube.

    Параметры:
    parsed: Распарсенная структура SplitResult.
    raw_url: Исходный адрес ресурса.

    Возвращает:
    ParsedMediaResource со ссылкой на канонический плеер /play/embed/{video_id}.

    Исключения:
    InvalidMediaUrlError: При отсутствии или невалидном 32-значном hex-идентификаторе.
    """
    path_segments = [seg for seg in parsed.path.split("/") if seg]
    video_id: str | None = None

    if len(path_segments) >= 2 and path_segments[0] == "video":
        video_id = path_segments[1]
    elif len(path_segments) >= 3 and path_segments[0] == "play" and path_segments[1] == "embed":
        video_id = path_segments[2]

    # Идентификатор обязан строго состоять из 32 шестнадцатеричных символов
    if not video_id or not re.fullmatch(r"^[a-fA-F0-9]{32}$", video_id):
        raise InvalidMediaUrlError(
            f"Некорректный формат ссылки Rutube: '{raw_url}'. "
            "Ожидается 32-значный шестнадцатеричный идентификатор видео."
        )

    video_id = video_id.lower()
    canonical_embed = f"https://rutube.ru/play/embed/{video_id}"

    return ParsedMediaResource(
        provider=MediaProvider.RUTUBE,
        media_type=MediaType.VIDEO,
        embed_url=canonical_embed,
        raw_url=raw_url,
        resource_id=video_id,
    )


def _parse_yandex(parsed: SplitResult, raw_url: str) -> ParsedMediaResource:
    """
    Разбор ссылок музыкального сервиса Яндекс.Музыка.

    Параметры:
    parsed: Распарсенная структура SplitResult.
    raw_url: Исходный адрес ресурса.

    Возвращает:
    ParsedMediaResource со ссылкой на iframe-виджет трека или альбома.

    Исключения:
    InvalidMediaUrlError: При некорректной структуре альбома/трека или нечисловых ID.
    """
    path = parsed.path

    # Трек внутри альбома: /album/{album_id}/track/{track_id}
    track_match = re.match(r"^/album/([^/?#]+)/track/([^/?#]+)(?:/.*)?$", path)
    if track_match:
        album_id = track_match.group(1)
        track_id = track_match.group(2)
        if not re.fullmatch(r"^\d+$", album_id) or not re.fullmatch(r"^\d+$", track_id):
            raise InvalidMediaUrlError(
                f"Идентификаторы альбома и трека Яндекс.Музыки обязаны состоять только из цифр: '{raw_url}'."
            )
        canonical_embed = f"https://music.yandex.ru/iframe/#track/{track_id}/{album_id}"
        return ParsedMediaResource(
            provider=MediaProvider.YANDEX,
            media_type=MediaType.AUDIO,
            embed_url=canonical_embed,
            raw_url=raw_url,
            resource_id=f"track:{track_id}:{album_id}",
        )

    # Альбом целиком: /album/{album_id}
    album_match = re.match(r"^/album/([^/?#]+)(?:/.*)?$", path)
    if album_match:
        album_id = album_match.group(1)
        if not re.fullmatch(r"^\d+$", album_id):
            raise InvalidMediaUrlError(
                f"Идентификатор альбома Яндекс.Музыки обязан состоять только из цифр: '{raw_url}'."
            )
        canonical_embed = f"https://music.yandex.ru/iframe/#album/{album_id}"
        return ParsedMediaResource(
            provider=MediaProvider.YANDEX,
            media_type=MediaType.AUDIO,
            embed_url=canonical_embed,
            raw_url=raw_url,
            resource_id=f"album:{album_id}",
        )

    raise InvalidMediaUrlError(
        f"Некорректная структура ссылки Яндекс.Музыки: '{raw_url}'. "
        "Ожидается формат /album/{album_id} или /album/{album_id}/track/{track_id}."
    )


# --- Главная точка входа сервиса ---


def parse_media_url(url: str) -> ParsedMediaResource:
    """
    Выполняет синтаксический анализ, классификацию и построение адреса встраивания медиа-ресурса.

    Параметры:
    url: Пользовательский URL-адрес для обработки.

    Возвращает:
    Полностью валидированный объект ParsedMediaResource.

    Исключения:
    InvalidMediaUrlError: При синтаксических ошибках, пустом значении, управляющих символах или невалидных ID.
    UnsupportedMediaProviderError: Если хост не относится к доверенному белому списку доменов.
    """
    # 1. Проверка типа и пустого ввода
    if not isinstance(url, str) or not url.strip():
        raise InvalidMediaUrlError("URL медиа-ресурса не может быть пустым.")

    # 2. Защита от управляющих символов ASCII (0x00-0x1F, 0x7F), включая нулевые байты и переносы строк
    if re.search(r"[\x00-\x1f\x7f]", url):
        raise InvalidMediaUrlError("URL содержит недопустимые управляющие символы.")

    # 3. Разбор схемы и структуры URL
    try:
        parsed = urlsplit(url.strip())
    except Exception as exc:
        raise InvalidMediaUrlError(f"Синтаксическая ошибка разбора URL: {exc}") from exc

    scheme = parsed.scheme.lower()
    if not scheme or scheme not in ("http", "https"):
        raise InvalidMediaUrlError(
            f"Недопустимая схема URL: '{parsed.scheme}'. Разрешены только протоколы http и https."
        )

    if not parsed.netloc:
        raise InvalidMediaUrlError("В переданном URL отсутствует доменное имя (хост).")

    # 4. Нормализация хоста
    host = normalize_url_host(parsed.netloc)
    if not host:
        raise InvalidMediaUrlError("Имя хоста не может быть пустым.")

    # 5. Определение провайдера по нормализованному хосту
    provider = match_provider_by_host(host)

    # 6. Обработка недоверенных хостов и прямых HTTPS-аудиофайлов
    if provider is None:
        if is_direct_audio_url(parsed.scheme, parsed.path):
            return ParsedMediaResource(
                provider=MediaProvider.DIRECT,
                media_type=MediaType.AUDIO,
                embed_url=None,
                raw_url=url,
                resource_id=None,
            )
        raise UnsupportedMediaProviderError(
            f"Хост '{host}' не поддерживается для безопасного встраивания медиа-ресурсов."
        )

    # 7. Делегирование разбора специализированным парсерам платформ
    if provider == MediaProvider.YOUTUBE:
        return _parse_youtube(parsed, url, host)
    if provider == MediaProvider.VK:
        return _parse_vk(parsed, url)
    if provider == MediaProvider.RUTUBE:
        return _parse_rutube(parsed, url)
    if provider == MediaProvider.YANDEX:
        return _parse_yandex(parsed, url)

    raise UnsupportedMediaProviderError(f"Неизвестный провайдер мультимедиа: '{provider}'.")


# Явное декларирование публичного интерфейса модуля
__all__: list[str] = [
    "ALLOWED_HOSTS_BY_PROVIDER",
    "DIRECT_AUDIO_EXTENSIONS",
    "InvalidMediaUrlError",
    "MediaParserError",
    "MediaProvider",
    "MediaType",
    "ParsedMediaResource",
    "UnsupportedMediaProviderError",
    "is_direct_audio_url",
    "match_provider_by_host",
    "normalize_url_host",
    "parse_media_url",
]
