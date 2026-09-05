"""
Схемы валидации мультимедийных ресурсов исторического события на базе Pydantic v2.
Определяет строгий контракт для атрибута media_payload в PostgreSQL JSONB.
"""

from collections.abc import Iterator
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, RootModel


class MediaItem(BaseModel):
    """
    Схема валидации отдельного мультимедийного ресурса исторического события.
    Строго ограничивает типы контента, валидирует URL и блокирует недокументированные поля.
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

    # Внешний сервис размещения для корректного выбора плеера/вставки на клиенте
    provider: Literal["youtube", "vk", "direct"] | None = Field(
        default=None,
        description="Провайдер хостинга для видео- и аудио-материалов",
    )

    # Запрет передачи любых недекларированных ключей в теле полезной нагрузки
    model_config = ConfigDict(extra="forbid")


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


# Явный экспорт публичных компонентов модуля валидации медиа
__all__: list[str] = [
    "MediaItem",
    "MediaPayload",
]
