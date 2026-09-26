"""
Сервисный слой управления сущностями исторических событий платформы History Timeline.
Реализует бизнес-логику, валидацию иерархических связей и проверку хронологических диапазонов.
Изолирован от веб-транспорта (FastAPI) и не управляет транзакционными границами.
"""

from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventRank, EventStatus
from app.core.exceptions import (
    DomainError,
    EventNotFoundError,
    InvalidDateRangeError,
    InvalidParentRankError,
)
from app.crud.event import (
    count_events_by_parent_id as crud_count_events_by_parent_id,
)
from app.crud.event import (
    create_event as crud_create_event,
)
from app.crud.event import (
    delete_event as crud_delete_event,
)
from app.crud.event import (
    get_event_by_id as crud_get_event_by_id,
)
from app.crud.event import (
    get_events as crud_get_events,
)
from app.crud.event import (
    get_events_by_parent_id as crud_get_events_by_parent_id,
)
from app.crud.event import (
    get_events_in_range as crud_get_events_in_range,
)
from app.crud.event import (
    get_first_child_with_depth_at_most as crud_get_first_child_with_depth_at_most,
)
from app.crud.event import (
    update_event as crud_update_event,
)
from app.models.event import Event
from app.schemas.event import EventCreate, EventUpdate


async def create_event(
    session: AsyncSession,
    event_in: EventCreate,
) -> Event:
    """
    Создание нового исторического события с валидацией иерархии предков.

    Перед сохранением выполняется валидация существования родителя (если указан parent_id)
    строго со статусом approved и проверка отношения масштабов детализации (ранг родителя
    обязан быть строго крупнее). Если родитель не найден или ожидает модерации, выбрасывается
    EventNotFoundError, что исключает утечку метаданных о немодерированных ветках.
    Начальный статус модерации 'pending' явно передается в слой данных до выполнения
    SQL INSERT, что гарантирует конструирование сущности с обязательным полем status,
    предотвращает генерацию вторичного оператора UPDATE и рассинхронизацию меток времени
    created_at и updated_at.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param event_in: Валидированные входные данные создания события.
    :return: Созданный экземпляр ORM-модели Event со статусом pending.
    :raises EventNotFoundError: Если указанный parent_id не найден или не одобрен.
    :raises InvalidParentRankError: Если ранг родительского события не строго крупнее дочернего.
    """
    # Проверка наличия и иерархической корректности родительского события
    if event_in.parent_id is not None:
        parent = await crud_get_event_by_id(
            session,
            event_in.parent_id,
            status=EventStatus.APPROVED.value,
        )
        if parent is None:
            raise EventNotFoundError(event_in.parent_id)

        # Проверка отношения масштабов: ранг родителя должен быть строго крупнее (меньший depth_level)
        parent_rank = EventRank(parent.rank)
        if parent_rank.depth_level() >= event_in.rank.depth_level():
            raise InvalidParentRankError(
                f"Ранг родительского события '{parent_rank.value}' должен быть строго "
                f"крупнее ранга дочернего события '{event_in.rank.value}'."
            )

    # Делегирование создания сущности в слой CRUD с явной передачей начального статуса модерации
    return await crud_create_event(
        session=session,
        event_in=event_in,
        status=EventStatus.PENDING.value,
    )


async def get_event(
    session: AsyncSession,
    event_id: int,
    require_approved: bool = True,
) -> Event:
    """
    Получение исторического события по его первичному ключу.

    По умолчанию требует наличия подтвержденного статуса модерации (approved)
    для безопасной публичной выдачи. При отсутствии записи или несоответствии
    статусу возбуждается доменное исключение EventNotFoundError, транслируемое
    на уровне HTTP в статус 404 Not Found, что исключает утечку информации
    о существовании немодерированных или отклоненных событий.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param event_id: Уникальный идентификатор исторического события.
    :param require_approved: Флаг требования одобренного статуса модерации (по умолчанию True).
    :return: Экземпляр ORM-модели Event.
    :raises EventNotFoundError: Если событие с указанным ID отсутствует в базе данных
        или не соответствует требуемому статусу модерации.
    """
    # Определение строкового фильтра статуса для слоя доступа к данным
    status_filter = EventStatus.APPROVED.value if require_approved else None

    # Запрос сущности из базы данных с опциональным фильтром статуса
    event = await crud_get_event_by_id(session, event_id, status=status_filter)
    if event is None:
        raise EventNotFoundError(event_id)
    return event


async def list_event_children(
    session: AsyncSession,
    event_id: int,
    skip: int = 0,
    limit: int = 100,
) -> tuple[Sequence[Event], int]:
    """
    Получение списка одобренных дочерних событий и их общего количества для указанного родителя.

    Перед выборкой проверяет существование и доступность родительского события
    (require_approved=True). Если родитель отсутствует или не имеет статуса
    approved, выбрасывается EventNotFoundError(event_id).
    Выборка потомков строго ограничена одобренным контентом (status='approved'),
    отсортирована хронологически и поддерживает пагинацию через skip и limit.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param event_id: Уникальный идентификатор родительского события.
    :param skip: Смещение пагинации.
    :param limit: Максимальное количество возвращаемых дочерних записей.
    :return: Кортеж из последовательности одобренных дочерних событий Event
             и общего количества подтвержденных потомков (total).
    :raises EventNotFoundError: Если родительское событие не найдено или не одобрено.
    """
    # 1. Валидация существования и одобренного статуса родительского события
    await get_event(session=session, event_id=event_id, require_approved=True)

    # 2. Выборка страницы одобренных дочерних событий со смещением и лимитом
    items = await crud_get_events_by_parent_id(
        session=session,
        parent_id=event_id,
        status=EventStatus.APPROVED.value,
        skip=skip,
        limit=limit,
    )

    # 3. Подсчет общего количества одобренных дочерних событий
    total = await crud_count_events_by_parent_id(
        session=session,
        parent_id=event_id,
        status=EventStatus.APPROVED.value,
    )

    return items, total


async def list_events(
    session: AsyncSession,
    skip: int = 0,
    limit: int = 100,
) -> Sequence[Event]:
    """
    Постраничное получение списка одобренных исторических событий.

    Публичная выдача строго ограничена проверенным контентом (status='approved').
    Модераторская выборка всех событий без фильтрации по статусу будет реализована
    отдельной сервисной функцией на шаге 5 дорожной карты вместе с ролевой моделью (RBAC).

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param skip: Количество пропускаемых записей выборки.
    :param limit: Максимальное количество возвращаемых записей.
    :return: Последовательность опубликованных экземпляров Event.
    """
    return await crud_get_events(
        session=session,
        status=EventStatus.APPROVED.value,
        skip=skip,
        limit=limit,
    )


async def list_events_in_range(
    session: AsyncSession,
    from_date: int,
    to_date: int,
    categories: list[str] | None = None,
    ranks: list[str] | None = None,
    status: str | None = None,
    skip: int = 0,
    limit: int = 500,
) -> Sequence[Event]:
    """
    Выборка событий в заданном временном диапазоне с валидацией границ и уровней детализации.

    Особенности выборки:
    - Усечение результирующей выборки на уровне базы данных выполняется по важности (depth_level),
      хронологической длительности, детерминированному псевдослучайному хэш-ключу Кнута и первичному
      ключу id при достижении лимита выборки, что исключает мерцание маркеров при панорамировании;
    - Каждая возвращаемая сущность Event содержит вычисленный атрибут collapsed_children_count
      (количество скрытых текущим масштабом прямых подтвержденных потомков);
    - Ограничение выборки по параметру ranks фильтрует события теми уровнями детализации,
      которые соответствуют текущему масштабу отображения таймлайна на клиенте.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param from_date: Начальная временная метка диапазона (в секундах).
    :param to_date: Конечная временная метка диапазона (в секундах).
    :param categories: Список категорий для фильтрации.
    :param ranks: Список допустимых рангов детализации событий.
    :param status: Статус модерации события.
    :param skip: Смещение пагинации.
    :param limit: Лимит выборки событий.
    :return: Последовательность найденных событий с заполненным collapsed_children_count.
    :raises InvalidDateRangeError: Если to_date меньше from_date.
    :raises DomainError: Если в переданном наборе ranks присутствует неизвестный ранг.
    """
    # Доменная валидация корректности запрошенного временного интервала
    if to_date < from_date:
        raise InvalidDateRangeError(
            "Конечная дата диапазона (to_date) не может быть меньше начальной даты (from_date)."
        )

    # Доменная валидация и применение политики фильтрации по рангам
    if ranks is not None:
        # Случай А: передан пустой список рангов — немедленный возврат без обращения к СУБД
        if len(ranks) == 0:
            return []

        # Случай Б: валидация допустимости каждого переданного строкового ранга
        allowed_ranks = {rank.value for rank in EventRank}
        for rank_value in ranks:
            if rank_value not in allowed_ranks:
                raise DomainError(
                    f"Недопустимый ранг исторического события: '{rank_value}'. "
                    f"Допустимые значения: {sorted(allowed_ranks)}."
                )

    # Делегирование запроса слою доступа к данным
    return await crud_get_events_in_range(
        session,
        from_date=from_date,
        to_date=to_date,
        categories=categories,
        ranks=ranks,
        status=status,
        skip=skip,
        limit=limit,
    )


async def update_event(
    session: AsyncSession,
    event_id: int,
    event_in: EventUpdate,
) -> Event:
    """
    Частичное обновление параметров события с валидацией хронологии и дерева связей.

    Бизнес-правила валидации иерархии:
    1. Проверка циклических ссылок: событие не может указывать само себя в качестве родителя;
    2. Случай А: при смене parent_id ранг выбранного родителя обязан быть строго крупнее ранга события.
       Родитель ищется строго со статусом approved во избежание утечки приватных веток;
    3. Случай Б: при сохранении родителя и смене ранга новый ранг обязан оставаться строго мельче ранга родителя;
    4. Случай В: при смене ранга проверяются существующие дочерние узлы через get_first_child_with_depth_at_most.
       Новый ранг родителя обязан оставаться строго крупнее ранга любого существующего потомка.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param event_id: Идентификатор обновляемого события.
    :param event_in: Схема с перечнем модифицируемых полей.
    :return: Обновленный экземпляр Event.
    :raises EventNotFoundError: Если обновляемое событие или новый родитель не найдены.
    :raises InvalidDateRangeError: Если новая дата окончания меньше даты начала.
    :raises InvalidParentRankError: Если нарушена иерархия рангов или событие ссылается на себя.
    """
    # Получение текущего состояния сущности из базы данных напрямую без фильтрации по статусу
    db_event = await crud_get_event_by_id(session, event_id)
    if db_event is None:
        raise EventNotFoundError(event_id)

    # 1. Валидация соотношения дат с учетом текущих значений в базе данных
    target_start_date = (
        event_in.start_date
        if ("start_date" in event_in.model_fields_set and event_in.start_date is not None)
        else db_event.start_date
    )
    target_end_date = (
        event_in.end_date if "end_date" in event_in.model_fields_set else db_event.end_date
    )

    if target_end_date is not None and target_end_date < target_start_date:
        raise InvalidDateRangeError("Дата окончания события не может быть меньше даты начала.")

    # 2. Определение целевого ранга события для проверки иерархических правил
    target_rank = (
        event_in.rank
        if ("rank" in event_in.model_fields_set and event_in.rank is not None)
        else EventRank(db_event.rank)
    )

    # Случай А: клиент явно передает parent_id на обновление
    if "parent_id" in event_in.model_fields_set:
        if event_in.parent_id is not None:
            # Защита от создания циклических ссылок на самого себя
            if event_in.parent_id == event_id:
                raise InvalidParentRankError(
                    "Событие не может быть родительским по отношению к самому себе."
                )

            parent = await crud_get_event_by_id(
                session,
                event_in.parent_id,
                status=EventStatus.APPROVED.value,
            )
            if parent is None:
                raise EventNotFoundError(event_in.parent_id)

            # Проверка, что ранг родителя строго крупнее целевого ранга события
            if EventRank(parent.rank).depth_level() >= target_rank.depth_level():
                raise InvalidParentRankError(
                    f"Ранг родительского события '{parent.rank}' должен быть строго "
                    f"крупнее ранга обновляемого события '{target_rank.value}'."
                )

    # Случай Б: parent_id не изменяется, но изменяется ранг при существующем родителе
    elif "rank" in event_in.model_fields_set and db_event.parent_id is not None:
        # Инвариант иерархии проверяется относительно уже привязанного родителя любого статуса
        # (включая pending), так как связь уже зафиксирована в базе данных, и изменение
        # собственного ранга не должно нарушать дерево, даже если родитель ожидает проверки модератором.
        parent = await crud_get_event_by_id(session, db_event.parent_id)
        if parent and EventRank(parent.rank).depth_level() >= target_rank.depth_level():
            raise InvalidParentRankError(
                f"Новый ранг события '{target_rank.value}' не может быть равен "
                f"или крупнее ранга существующего родителя '{parent.rank}'."
            )

    # Случай В: валидация отношения масштабов с существующими дочерними событиями при изменении ранга
    if "rank" in event_in.model_fields_set and event_in.rank is not None:
        conflicting_child = await crud_get_first_child_with_depth_at_most(
            session,
            parent_id=event_id,
            max_depth_level=target_rank.depth_level(),
        )
        if conflicting_child is not None:
            raise InvalidParentRankError(
                f"Ранг обновляемого события '{target_rank.value}' не может быть равен "
                f"или мельче ранга существующего дочернего события с ID {conflicting_child.id} ('{conflicting_child.rank}')."
            )

    # Передача проверенных изменений в слой базы данных
    return await crud_update_event(session, db_event=db_event, event_in=event_in)


async def delete_event(
    session: AsyncSession,
    event_id: int,
) -> None:
    """
    Удаление исторического события по его идентификатору.

    :param session: Активная асинхронная сессия SQLAlchemy.
    :param event_id: Уникальный идентификатор удаляемого события.
    :raises EventNotFoundError: Если событие с указанным ID не найдено.
    """
    db_event = await crud_get_event_by_id(session, event_id)
    if db_event is None:
        raise EventNotFoundError(event_id)

    await crud_delete_event(session, db_event=db_event)


# Явное декларирование публичного интерфейса сервисного слоя в алфавитном порядке
__all__: list[str] = [
    "create_event",
    "delete_event",
    "get_event",
    "list_event_children",
    "list_events",
    "list_events_in_range",
    "update_event",
]
