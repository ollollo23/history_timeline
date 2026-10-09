"""
Корневой конфигурационный модуль фикстур и хуков pytest для проекта History Timeline.
Обеспечивает перехват и протоколирование системного вывода в файл project_info/pytest_last_run.txt,
принудительную цветную подсветку консоли, запуск ASGI-приложения через LifespanManager,
автоматическую очистку пула соединений SQLAlchemy и изоляцию тестового контура от внешней БД.
"""

import atexit
import re
import sys
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any, TextIO
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.core.database.database import engine, get_db, get_db_engine
from app.main import app

# Регулярное выражение стандарта ECMA-48 для удаления ANSI-последовательностей форматирования терминала
ANSI_ESCAPE_REGEX = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

# Реестр активных потоков-разветвителей и флаг защиты от повторной установки перехватчиков
_tee_writers: list[Any] = []
_tee_installed: bool = False


# Механизм потокового разветвителя TeeWriter опирается на то, что стандартный поток вывода
# не перехвачен pytest. Работоспособность логирования критически зависит от наличия
# флага -s (--capture=no) в строке addopts файла pyproject.toml.
# Удаление данного флага приведет к блокировке передачи вывода в файловый дескриптор отчета.
class TeeWriter:
    """
    Поток-разветвитель вывода (Tee Stream) для параллельной записи
    в исходный системный поток и файл отчета с очисткой от ANSI-кодов.
    """

    def __init__(
        self,
        file_path: Path,
        original_stream: TextIO,
        shared_file: TextIO | None = None,
    ) -> None:
        """
        Инициализация потока-разветвителя и открытие файла отчета в режиме перезаписи.

        :param file_path: Абсолютный путь к целевому текстовому файлу отчета.
        :param original_stream: Исходный системный текстовый поток (sys.stdout или sys.stderr).
        :param shared_file: Существующий дескриптор файла для совместного использования потоками.
        """
        self.file_path = file_path
        self.original_stream = original_stream

        if shared_file is not None:
            self.file = shared_file
            self._owns_file = False
        else:
            # Открытие файла с полной очисткой содержимого ('w'), UTF-8 и построчной буферизацией
            self.file = open(file_path, "w", encoding="utf-8", buffering=1)
            self._owns_file = True

    def write(self, s: str) -> int:
        """
        Трансляция строки в терминал без изменений и запись в файл с немедленным сбросом буфера.
        """
        # Передача исходной строки в оригинальный поток консоли с сохранением цветов
        self.original_stream.write(s)

        # Очистка текста от управляющих ANSI-последовательностей и запись в файл отчета
        if hasattr(self, "file") and not self.file.closed:
            clean_text = ANSI_ESCAPE_REGEX.sub("", s)
            self.file.write(clean_text)
            self.file.flush()

        return len(s)

    def flush(self) -> None:
        """
        Синхронизация буферов обоих потоков вывода.
        """
        self.original_stream.flush()
        if hasattr(self, "file") and not self.file.closed:
            self.file.flush()

    def isatty(self) -> bool:
        """
        Безусловное подтверждение интерактивного терминала для активации цветного вывода pytest.
        """
        return True

    def fileno(self) -> int:
        """
        Безопасное получение дескриптора файла для совместимости с системными вызовами.
        """
        if hasattr(self.original_stream, "fileno"):
            try:
                return self.original_stream.fileno()
            except Exception:
                pass
        return self.file.fileno()

    def close(self) -> None:
        """
        Корректное закрытие дескриптора файла отчета с защитой от повторного вызова.
        """
        if hasattr(self, "file") and not self.file.closed:
            self.file.flush()
            if getattr(self, "_owns_file", True):
                self.file.close()


def _close_tee_writers() -> None:
    """Корректное закрытие всех зарегистрированных потоков-разветвителей."""
    for writer in _tee_writers:
        writer.flush()
        writer.close()


# Механизм потокового разветвителя TeeWriter опирается на то, что стандартный поток вывода
# не перехвачен pytest. Работоспособность логирования критически зависит от наличия
# флага -s (--capture=no) в строке addopts файла pyproject.toml.
# Удаление данного флага приведет к блокировке передачи вывода в файловый дескриптор отчета.
def _install_tee_logger() -> None:
    """
    Глобальная инициализация перехвата стандартных потоков вывода sys.stdout и sys.stderr.
    Создает директорию project_info при ее отсутствии, открывает файл отчета
    в режиме перезаписи и подменяет системные потоки разветвителями TeeWriter.
    """
    global _tee_installed
    if _tee_installed:
        return

    # Определение пути к файлу отчета относительно корня проекта
    project_root = Path(__file__).resolve().parent.parent
    output_dir = project_root / "project_info"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / "pytest_last_run.txt"

    # Инициализация потоков-разветвителей с разделяемым файловым дескриптором
    stdout_writer = TeeWriter(file_path=output_file, original_stream=sys.stdout)
    stderr_writer = TeeWriter(
        file_path=output_file,
        original_stream=sys.stderr,
        shared_file=stdout_writer.file,
    )

    # Подмена системных потоков вывода Python
    sys.stdout = stdout_writer
    sys.stderr = stderr_writer

    # Регистрация разветвителей в модульном реестре и хуках завершения процесса
    _tee_writers.extend([stdout_writer, stderr_writer])
    atexit.register(_close_tee_writers)
    _tee_installed = True


# Немедленная активация перехвата потоков при импорте конфигурационного модуля
_install_tee_logger()


def pytest_configure(config: pytest.Config) -> None:
    """
    Хук инициализации конфигурации pytest.
    Принудительно активирует генерацию цветного терминального вывода (ANSI).
    """
    config.option.color = "yes"


def pytest_terminal_summary(
    terminalreporter: Any,
    exitstatus: int,
    config: pytest.Config,
) -> None:
    """
    Хук промежуточного формирования терминального отчета pytest.
    Выполняет исключительно сброс буферов потоков без закрытия файла,
    предотвращая отсечение вывода плагина pytest-cov и финальной статистики.
    """
    for writer in _tee_writers:
        writer.flush()


def pytest_unconfigure(config: pytest.Config) -> None:
    """
    Хук завершения работы pytest.
    Гарантирует финальный сброс буферов и закрытие файловых дескрипторов после отработки всех репортеров.
    """
    _close_tee_writers()


@pytest_asyncio.fixture(autouse=True, scope="function")
async def dispose_engine_after_test() -> AsyncGenerator[None]:
    """
    Автоматическая асинхронная фикстура для освобождения ресурсов пула соединений SQLAlchemy.
    Выполняет явный сброс engine.dispose(close=True) после каждого теста, предотвращая
    утечку асинхронных сокетов asyncpg и появление предупреждения
    RuntimeWarning: coroutine 'Connection._cancel' was never awaited.
    """
    yield
    if engine is not None:
        await engine.dispose(close=True)


@pytest_asyncio.fixture
async def mock_db_session() -> AsyncMock:
    """
    Асинхронная фикстура для создания объекта-заглушки (mock) транзакционной сессии базы данных.

    Имитирует методы SQLAlchemy AsyncSession, предотвращая выполнение
    реальных сетевых запросов к PostgreSQL 18.
    """
    # Инициализация базового асинхронного мок-объекта сессии
    session = AsyncMock()

    # Синхронный метод добавления сущности в Identity Map сессии переопределяется как MagicMock,
    # что исключает появление RuntimeWarning о невызванной корутине при session.add()
    session.add = MagicMock()

    # Явная настройка асинхронных методов сессии для корректной работы с await
    session.execute = AsyncMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.rollback = AsyncMock()
    session.close = AsyncMock()

    return session


@pytest_asyncio.fixture
async def mock_db_engine() -> MagicMock:
    """
    Асинхронная фикстура для эмуляции объекта асинхронного движка AsyncEngine.

    Настраивает метод engine.connect() на возврат асинхронного контекстного менеджера,
    внутри которого предоставляется настраиваемый мок-объект подключения connection.
    Ссылка на мок соединения сохраняется в атрибут _mock_connection для удобной
    конфигурации исключений в юнит-тестах эндпоинта /health.
    """
    # Создание базового мок-объекта движка базы данных
    mock_engine = MagicMock()

    # Инициализация мок-объекта асинхронного сетевого соединения
    connection = AsyncMock()
    connection.execute = AsyncMock()
    connection.close = AsyncMock()

    # Настройка асинхронного контекстного менеджера: async with engine.connect() as connection
    mock_engine.connect.return_value.__aenter__.return_value = connection
    mock_engine.connect.return_value.__aexit__.return_value = None

    # Фиксация прямой ссылки на соединение для настройки поведения в тестах
    mock_engine._mock_connection = connection

    return mock_engine


@pytest_asyncio.fixture
async def async_client(
    mock_db_session: AsyncMock,
    mock_db_engine: MagicMock,
) -> AsyncGenerator[AsyncClient]:
    """
    Асинхронная фикстура тестового HTTP-клиента с управлением полным жизненным циклом.

    - Подменяет зависимость get_db генератором, возвращающим mock_db_session;
    - Подменяет синхронную зависимость get_db_engine фабрикой, возвращающей mock_db_engine;
    - Запускает startup и shutdown хуки приложения через LifespanManager;
    - Создает изолированный транспорт ASGITransport без привязки к TCP-портам;
    - Гарантированно очищает app.dependency_overrides после завершения каждого теста.
    """

    # Локальный генератор-заглушка для внедрения зависимости транзакционной сессии
    async def _override_get_db() -> AsyncGenerator[AsyncMock]:
        yield mock_db_session

    # Регистрация переопределений зависимостей в приложении FastAPI
    app.dependency_overrides[get_db] = _override_get_db
    app.dependency_overrides[get_db_engine] = lambda: mock_db_engine

    try:
        # Управление жизненным циклом приложения (выполнение lifespan startup/shutdown)
        async with LifespanManager(app):
            # Создание асинхронного HTTP-клиента с виртуальным ASGI-транспортом
            async with AsyncClient(
                transport=ASGITransport(app=app),
                base_url="http://test",
            ) as client:
                yield client
    finally:
        # Гарантированный сброс всех переопределений зависимостей для изоляции тестов
        app.dependency_overrides.clear()
