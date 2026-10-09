"""
Архитектурные тесты статического анализа кодовой базы History Timeline.
Использует модуль ast для контроля соблюдения принципов Clean Architecture,
строгой изоляции слоев и соблюдения паттерна Unit of Work.
"""

import ast
from pathlib import Path

import pytest

# Определение корневой директории приложения относительно текущего файла тестов
BASE_DIR = Path(__file__).resolve().parent.parent.parent
APP_DIR = BASE_DIR / "app"


def get_imported_modules(file_path: Path) -> set[str]:
    """
    Извлекает множество всех импортируемых модулей и полных путей импорта
    из переданного файла Python с использованием синтаксического анализатора AST.

    :param file_path: Путь к анализируемому файлу исходного кода .py.
    :return: Множество строковых идентификаторов модулей и импортируемых путей.
    """
    # Чтение исходного кода файла в кодировке UTF-8
    content = file_path.read_text(encoding="utf-8")

    # Построение абстрактного синтаксического дерева
    tree = ast.parse(content, filename=str(file_path))

    imported_modules: set[str] = set()

    # Рекурсивный обход всех узлов синтаксического дерева
    for node in ast.walk(tree):
        # Обработка инструкций вида: import foo, import foo.bar as baz
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported_modules.add(alias.name)

        # Обработка инструкций вида: from foo.bar import baz
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                # Добавление базового пути импортируемого модуля
                imported_modules.add(node.module)
                # Добавление полного квалифицированного пути импортируемого объекта
                for alias in node.names:
                    imported_modules.add(f"{node.module}.{alias.name}")

    return imported_modules


@pytest.mark.unit
def test_service_layer_has_no_web_framework_dependencies() -> None:
    """
    Проверка отсутствия зависимостей сервисного слоя от веб-фреймворка и контроллеров.
    Сервисный слой не должен зависеть от fastapi, starlette или модулей app.api.
    """
    services_dir = APP_DIR / "services"
    if not services_dir.exists():
        pytest.skip("Каталог app/services еще не создан.")

    # Сбор всех файлов сервисного слоя исключая служебные директории кэша
    service_files = [
        file
        for file in services_dir.rglob("*.py")
        if "__pycache__" not in file.parts and file.name != "__init__.py"
    ]

    forbidden_frameworks = ("fastapi", "starlette", "app.api")

    for file_path in service_files:
        imports = get_imported_modules(file_path)
        for imported_module in imports:
            for forbidden in forbidden_frameworks:
                if imported_module == forbidden or imported_module.startswith(f"{forbidden}."):
                    pytest.fail(
                        f"Нарушение Clean Architecture в файле {file_path.name}: "
                        f"сервисный слой не должен зависеть от веб-фреймворка или транспортного слоя. "
                        f"Обнаружен запрещенный импорт '{imported_module}'."
                    )


@pytest.mark.unit
def test_service_layer_dependencies_contract() -> None:
    """
    Проверка контракта внутренних зависимостей сервисного слоя.
    Сервисный слой имеет право импортировать только подпакеты app.core,
    app.crud, app.schemas, app.models и смежные сервисы app.services.
    """
    services_dir = APP_DIR / "services"
    if not services_dir.exists():
        pytest.skip("Каталог app/services еще не создан.")

    service_files = [
        file
        for file in services_dir.rglob("*.py")
        if "__pycache__" not in file.parts and file.name != "__init__.py"
    ]

    allowed_internal_prefixes = (
        "app.core",
        "app.crud",
        "app.schemas",
        "app.models",
        "app.services",
    )

    for file_path in service_files:
        imports = get_imported_modules(file_path)
        for imported_module in imports:
            # Проверка только внутренних проектных импортов пакета app
            if imported_module.startswith("app."):
                is_allowed = any(
                    imported_module == prefix or imported_module.startswith(f"{prefix}.")
                    for prefix in allowed_internal_prefixes
                )
                if not is_allowed:
                    pytest.fail(
                        f"Нарушение контракта зависимостей в файле {file_path.name}: "
                        f"сервисный слой может импортировать только модули из "
                        f"app.core, app.crud, app.schemas, app.models. "
                        f"Обнаружен недопустимый внутренний импорт '{imported_module}'."
                    )


@pytest.mark.unit
def test_crud_layer_dependencies_contract() -> None:
    """
    Проверка контракта зависимостей слоя прямого доступа к данным (CRUD).
    CRUD-слой не должен импортировать app.services, app.api, fastapi, starlette.
    Разрешены зависимости от app.models, app.core, app.schemas и библиотек СУБД.
    """
    crud_dir = APP_DIR / "crud"
    if not crud_dir.exists():
        pytest.skip("Каталог app/crud еще не создан.")

    crud_files = [
        file
        for file in crud_dir.rglob("*.py")
        if "__pycache__" not in file.parts and file.name != "__init__.py"
    ]

    forbidden_prefixes = ("app.services", "app.api", "fastapi", "starlette")
    allowed_internal_prefixes = ("app.models", "app.core", "app.schemas", "app.crud")

    for file_path in crud_files:
        imports = get_imported_modules(file_path)
        for imported_module in imports:
            # Проверка запрещенных модулей веб-транспорта и верхних слоев
            for forbidden in forbidden_prefixes:
                if imported_module == forbidden or imported_module.startswith(f"{forbidden}."):
                    pytest.fail(
                        f"Нарушение Clean Architecture в слое CRUD ({file_path.name}): "
                        f"CRUD-слой не должен зависеть от сервисов или веб-транспорта. "
                        f"Обнаружен запрещенный импорт '{imported_module}'."
                    )

            # Проверка допустимости внутренних зависимостей приложения
            if imported_module.startswith("app."):
                is_allowed = any(
                    imported_module == prefix or imported_module.startswith(f"{prefix}.")
                    for prefix in allowed_internal_prefixes
                )
                if not is_allowed:
                    pytest.fail(
                        f"Нарушение контракта зависимостей в слое CRUD ({file_path.name}): "
                        f"обнаружен недопустимый внутренний импорт '{imported_module}'."
                    )


@pytest.mark.unit
def test_core_layer_isolation() -> None:
    """
    Проверка абсолютной изоляции доменного ядра приложения (app/core).
    Модули ядра не должны иметь зависимостей от app.models, app.schemas,
    app.crud, app.services, app.api.
    """
    core_dir = APP_DIR / "core"
    if not core_dir.exists():
        pytest.fail("Каталог app/core не обнаружен в проекте.")

    core_files = [
        file
        for file in core_dir.rglob("*.py")
        if "__pycache__" not in file.parts and file.name != "__init__.py"
    ]

    forbidden_core_dependencies = (
        "app.models",
        "app.schemas",
        "app.crud",
        "app.services",
        "app.api",
    )

    for file_path in core_files:
        imports = get_imported_modules(file_path)
        for imported_module in imports:
            for forbidden in forbidden_core_dependencies:
                if imported_module == forbidden or imported_module.startswith(f"{forbidden}."):
                    pytest.fail(
                        f"Нарушение изоляции ядра в файле {file_path.name}: "
                        f"модуль ядра app.core не должен импортировать внешние бизнес-слои. "
                        f"Обнаружен недопустимый восходящий импорт '{imported_module}'."
                    )


@pytest.mark.unit
def test_crud_layer_does_not_manage_transactions() -> None:
    """
    Архитектурный тест синтаксического анализа AST для паттерна Unit of Work.
    Проверяет, что слой app/crud/ не вызывает commit, rollback или refresh,
    делегируя управление транзакционными границами генератору get_db.
    """
    # Определение пути к каталогу слоя CRUD относительно корня проекта
    crud_dir = APP_DIR / "crud"
    if not crud_dir.exists():
        pytest.skip("Каталог app/crud не обнаружен в проекте.")

    # Поиск всех файлов .py в каталоге app/crud исключая __init__.py и каталоги кэша
    crud_files = [
        file
        for file in crud_dir.rglob("*.py")
        if "__pycache__" not in file.parts and file.name != "__init__.py"
    ]

    # Набор запрещенных методов управления транзакциями для слоя CRUD
    forbidden_methods = {"commit", "rollback", "refresh"}

    for file_path in crud_files:
        # Чтение содержимого файла и построение абстрактного синтаксического дерева
        content = file_path.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=str(file_path))

        # Обход всех синтаксических узлов в поисках вызовов запрещенных методов
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in forbidden_methods
            ):
                pytest.fail(
                    f"Нарушение паттерна Unit of Work в файле {file_path.name}: "
                    f"слой CRUD не должен управлять транзакциями (обнаружен вызов '{node.func.attr}'). "
                    f"Разрешено использовать только 'session.flush()'."
                )


@pytest.mark.unit
def test_media_parser_service_strict_isolation() -> None:
    """
    Проверка абсолютной архитектурной изоляции сервиса app/services/media_parser.py.
    Модуль парсинга медиа-ресурсов является чистым доменным сервисом без состояния
    и не должен зависеть от веб-фреймворков (fastapi, starlette), ORM SQLAlchemy,
    а также слоев app.crud, app.models, app.schemas, app.services и app.api.
    Единственным разрешенным внутренним импортом является пакет app.core.
    """
    media_parser_file = APP_DIR / "services" / "media_parser.py"
    if not media_parser_file.exists():
        pytest.skip("Файл app/services/media_parser.py еще не создан.")

    imports = get_imported_modules(media_parser_file)

    forbidden_dependencies = (
        "fastapi",
        "starlette",
        "sqlalchemy",
        "app.crud",
        "crud",
        "app.models",
        "app.schemas",
        "app.api",
    )

    for imported_module in imports:
        # Проверка блокировки внешних фреймворков и недопустимых слоев
        for forbidden in forbidden_dependencies:
            if imported_module == forbidden or imported_module.startswith(f"{forbidden}."):
                pytest.fail(
                    f"Нарушение строгой изоляции в сервисе media_parser.py: "
                    f"модуль не должен зависеть от веб-фреймворков, ORM или слоя CRUD. "
                    f"Обнаружен запрещенный импорт '{imported_module}'."
                )

        # Контроль внутренних проектных зависимостей: разрешен строго подпакет app.core
        if imported_module.startswith("app."):
            if not (imported_module == "app.core" or imported_module.startswith("app.core.")):
                pytest.fail(
                    f"Нарушение контракта внутренних зависимостей в media_parser.py: "
                    f"сервис может импортировать только модули из 'app.core' (доменные исключения). "
                    f"Обнаружен недопустимый внутренний импорт '{imported_module}'."
                )
