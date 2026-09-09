"""
Интеграционные тесты валидации древовидной иерархии исторических событий.
Проверяет правила детализации масштабов EventRank, защиту от циклических ссылок
и целостность связей родитель-потомок на реальной базе данных PostgreSQL 18.
"""

import pytest
from fastapi import status
from httpx import AsyncClient

from app.core.enums import EventCategory, EventRank


@pytest.mark.integration
async def test_create_child_event_valid_hierarchy(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка успешного создания дочернего события с корректным отношением масштабов.
    Родительское событие ранга 'century' успешно принимает дочернее событие ранга 'year'.
    """
    # 1. Создание родительского макро-события крупного масштаба (век)
    parent_payload = {
        "title": "Век Просвещения",
        "start_date": -8000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # 2. Создание дочернего события более мелкого масштаба (год) с привязкой к родителю
    child_payload = {
        "title": "Издание Энциклопедии",
        "start_date": -6800000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.YEAR.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)

    # Валидация успешного создания и сохранения иерархических атрибутов
    assert child_response.status_code == status.HTTP_201_CREATED
    child_data = child_response.json()
    assert child_data["parent_id"] == parent_id
    assert child_data["rank"] == EventRank.YEAR.value


@pytest.mark.integration
async def test_create_child_event_same_rank_forbidden(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета создания дочернего события с рангом, совпадающим с рангом родителя.
    Масштаб родительского события обязан быть строго крупнее масштаба дочернего узла.
    """
    # 1. Создание родительского события ранга 'century'
    parent_payload = {
        "title": "Эпоха Возрождения",
        "start_date": -16000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # 2. Попытка создания дочернего события с идентичным рангом 'century'
    child_payload = {
        "title": "Высокое Возрождение",
        "start_date": -15000000000,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)

    # Валидация отклонения операции с доменной ошибкой 400 Bad Request
    assert child_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = child_response.json()["detail"]
    assert "Ранг родительского события" in error_detail
    assert "должен быть строго крупнее ранга дочернего события" in error_detail


@pytest.mark.integration
async def test_create_child_event_nonexistent_parent_not_found(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка отклонения создания события с указанием несуществующего parent_id.
    Сервисный слой обязан выбросить EventNotFoundError со статусом 404 Not Found.
    """
    payload = {
        "title": "Событие без существующего предка",
        "start_date": 1000,
        "category": EventCategory.POLITICS.value,
        "parent_id": 999999,
    }
    response = await integration_client.post("/api/v1/events/", json=payload)

    # Валидация корректного статуса и идентификатора отсутствующего объекта в ответе
    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "999999" in response.json()["detail"]


@pytest.mark.integration
async def test_update_event_self_parent_forbidden(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета создания циклической ссылки на самого себя через PATCH-запрос.
    Событие не может являться родителем для самого себя (parent_id == id).
    """
    # 1. Создание исходного исторического события
    create_payload = {
        "title": "Автономное событие",
        "start_date": 1000,
        "category": EventCategory.SCIENCE.value,
        "rank": EventRank.YEAR.value,
    }
    create_response = await integration_client.post("/api/v1/events/", json=create_payload)
    assert create_response.status_code == status.HTTP_201_CREATED
    event_id = create_response.json()["id"]

    # 2. Попытка установить parent_id, равный собственному идентификатору события
    patch_payload = {"parent_id": event_id}
    patch_response = await integration_client.patch(
        f"/api/v1/events/{event_id}",
        json=patch_payload,
    )

    # Валидация блокировки циклической зависимости
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    assert (
        "Событие не может быть родительским по отношению к самому себе"
        in patch_response.json()["detail"]
    )


@pytest.mark.integration
async def test_update_child_rank_larger_than_parent_forbidden(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета обновления ранга дочернего события до значения крупнее ранга родителя (Случай Б).
    Попытка сделать дочерний узел крупнее существующего предка должна пресекаться.
    """
    # 1. Создание родительского события ранга 'decade'
    parent_payload = {
        "title": "Холодная война (шестидесятые)",
        "start_date": -315576000,
        "category": EventCategory.POLITICS.value,
        "rank": EventRank.DECADE.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # 2. Создание дочернего события ранга 'year'
    child_payload = {
        "title": "Карибский кризис",
        "start_date": -228873600,
        "category": EventCategory.POLITICS.value,
        "rank": EventRank.YEAR.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)
    assert child_response.status_code == status.HTTP_201_CREATED
    child_id = child_response.json()["id"]

    # 3. Попытка изменить ранг дочернего события на 'century', который крупнее 'decade' родителя
    patch_response = await integration_client.patch(
        f"/api/v1/events/{child_id}",
        json={"rank": EventRank.CENTURY.value},
    )

    # Валидация ошибки нарушения ранговой иерархии
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = patch_response.json()["detail"]
    assert "не может быть равен или крупнее ранга существующего родителя" in error_detail


@pytest.mark.integration
async def test_update_parent_rank_smaller_than_existing_children_forbidden(
    integration_client: AsyncClient,
) -> None:
    """
    Проверка запрета обновления ранга родителя до значения мельче существующих дочерних узлов (Случай В).
    Предотвращает инверсию дерева детализации при наличии прямых потомков.
    """
    # 1. Создание родительского события крупного масштаба (век)
    parent_payload = {
        "title": "Девятнадцатый век",
        "start_date": -5364662400,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.CENTURY.value,
    }
    parent_response = await integration_client.post("/api/v1/events/", json=parent_payload)
    assert parent_response.status_code == status.HTTP_201_CREATED
    parent_id = parent_response.json()["id"]

    # 2. Создание дочернего узла среднего масштаба (десятилетие)
    child_payload = {
        "title": "Викторианская эпоха (ранний период)",
        "start_date": -4102444800,
        "category": EventCategory.CULTURE.value,
        "rank": EventRank.DECADE.value,
        "parent_id": parent_id,
    }
    child_response = await integration_client.post("/api/v1/events/", json=child_payload)
    assert child_response.status_code == status.HTTP_201_CREATED
    child_id = child_response.json()["id"]

    # 3. Попытка понизить ранг родительского узла до уровня 'day', который мельче ранга потомка 'decade'
    patch_response = await integration_client.patch(
        f"/api/v1/events/{parent_id}",
        json={"rank": EventRank.DAY.value},
    )

    # Валидация блокировки инверсии дерева с указанием ID потомка и конфликтующих рангов
    assert patch_response.status_code == status.HTTP_400_BAD_REQUEST
    error_detail = patch_response.json()["detail"]
    assert str(child_id) in error_detail
    assert EventRank.DAY.value in error_detail
    assert EventRank.DECADE.value in error_detail
