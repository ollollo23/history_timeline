"""
Схемы валидации мультимедийных ресурсов исторического события на базе Pydantic v2.
Определяет строгий контракт для атрибута media_payload в PostgreSQL JSONB
с автоматической классификацией провайдеров и генерацией канонических embed-URL.
"""

from collections.abc import Iterator
from typing import Literal

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    model_validator,
)

from app.services.media_parser import MediaParserError, parse_media_url


class MediaItem(BaseModel):
    """
    Схема валидации отдельного мультимедийного ресурса исторического события.
    Строго ограничивает типы контента, валидирует URL, определяет провайдера
    и формирует безопасный канонический embed_url для встраивания во фрейм.
    """

    # Тип подключаемого медиа-контента
    media_type: Literal["image", "video", "audio", "link"] = Field(
        ...,
        description="Тип медиа-ресурса",
    )

    # Веб-адрес ресурса с протоколом http или https
    url: AnyHttpUrl = Field(
        ...,
        description="Валидный веб-адрес медиа-ресурса с протоколом http или https",
    )

    # Заголовок или подпись под медиа-материалом
    title: str | None = Field(
        default=None,
        max_length=255,
        description="Название или краткая подпись к медиа-файлу",
    )

    # Внешний сервис размещения или прямой источник для видео- и аудио-материалов
    provider: Literal["youtube", "vk", "rutube", "yandex", "direct"] | None = Field(
        default=None,
        description="Внешний сервис размещения или прямой источник для видео- и аудио-материалов",
    )

    # Канонический адрес для безопасного встраивания ресурса в iframe (формируется сервером)
    embed_url: str | None = Field(
        default=None,
        description="Канонический URL для безопасного встраивания ресурса в iframe (формируется исключительно сервером)",
    )

    # Запрет передачи любых недекларированных ключей в теле полезной нагрузки
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_media_resource(self) -> MediaItem:
        """
        Модельный валидатор согласования медиа-ресурса с сервисом media_parser:
        - Для video и audio: проверяет хост по белому списку, валидирует идентификатор,
          сверяет заявленный провайдер и генерирует доверенный embed_url.
        - Для image и link: сбрасывает embed_url в None и запрещает сторонних провайдеров.
        """
        raw_url = str(self.url)

        if self.media_type in ("video", "audio"):
            # Вызов изолированного сервиса синтаксического анализа и классификации URL
            try:
                parsed = parse_media_url(raw_url)
            except (MediaParserError, Exception) as error:
                raise ValueError(str(error)) from error

            # Проверка соответствия заявленного типа контента фактически обнаруженному ресурсу
            if self.media_type == "video" and parsed.media_type != "video":
                raise ValueError(
                    "Указан media_type='video', но переданный ресурс не является видеозаписью."
                )
            if self.media_type == "audio" and parsed.media_type != "audio":
                raise ValueError(
                    "Указан media_type='audio', но переданный ресурс не является аудиозаписью."
                )

            # Проверка допустимости провайдера для видеозаписей
            if self.media_type == "video" and parsed.provider not in (
                "youtube",
                "vk",
                "rutube",
            ):
                raise ValueError(
                    f"Для media_type='video' провайдер '{parsed.provider}' не поддерживается."
                )

            # Проверка допустимости провайдера для аудиозаписей
            if self.media_type == "audio" and parsed.provider not in (
                "yandex",
                "direct",
                "vk",
            ):
                raise ValueError(
                    f"Для media_type='audio' провайдер '{parsed.provider}' не поддерживается."
                )

            # Защита от подмены провайдера клиентом при несовпадении с фактическим хостом
            if self.provider is not None and self.provider != parsed.provider:
                raise ValueError(
                    f"Заявленный провайдер '{self.provider}' не соответствует "
                    f"фактическому домену URL '{parsed.provider}'."
                )

            # Автоматическое заполнение провайдера при его отсутствии во входящих данных
            if self.provider is None:
                self.provider = parsed.provider

            # Принудительная запись канонического адреса встраивания
            self.embed_url = parsed.embed_url

        elif self.media_type in ("image", "link"):
            # Для статических изображений и ссылок встраивание во фрейм отключено
            self.embed_url = None

            # Изображения и ссылки не поддерживают провайдеров сторонних видео- и аудиоплееров
            if self.provider is not None and self.provider != "direct":
                raise ValueError(
                    f"Для media_type='{self.media_type}' провайдер '{self.provider}' недопустим. "
                    "Допускается только direct или null."
                )

        return self


class MediaPayload(RootModel[list[MediaItem]]):
    """
    Корневая схема коллекции медиа-вложений исторического события.
    Ограничивает максимальный объем коллекции до 20 элементов и предоставляет
    прозрачный интерфейс доступа по индексу, длины и итерации.
    """

    # Корневой список элементов медиа с ограничением максимального количества
    root: list[MediaItem] = Field(
        default_factory=list,
        max_length=20,
        description="Список медиа-вложений события (не более 20 элементов)",
    )

    def __iter__(self) -> Iterator[MediaItem]:
        """
        Делегирует итерацию внутреннему списку элементов.
        Позволяет выполнять цикл `for item in media_payload:`.
        """
        return self.root.__iter__()

    def __getitem__(self, item: int | slice) -> MediaItem | list[MediaItem]:
        """
        Делегирует доступ по индексу или срезу внутреннему списку элементов.
        Позволяет обращаться по синтаксису `media_payload[0]`.
        """
        return self.root[item]

    def __len__(self) -> int:
        """
        Возвращает количество медиа-вложений в коллекции.
        Позволяет использовать стандартную функцию `len(media_payload)`.
        """
        return len(self.root)


# Явный экспорт публичных компонентов модуля валидации медиа в алфавитном порядке
__all__: list[str] = [
    "MediaItem",
    "MediaPayload",
]
