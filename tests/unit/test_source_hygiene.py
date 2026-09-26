"""
Модульный тест проверки чистоты и гигиены исходного кода проекта (Source Code Hygiene).
Сканирует текстовые файлы кодовой базы (Python, JavaScript, CSS, HTML) на предмет
отсутствия паразитных текстовых меток цитирования нейросетевых моделей.
"""

import re
from pathlib import Path

import pytest

# Целевые корневые директории репозитория для рекурсивного сканирования
TARGET_DIRS = ("app", "migrations", "frontend", "tests", "scripts")

# Проверяемые расширения текстовых файлов исходного кода и разметки
TARGET_EXTENSIONS = (".py", ".js", ".css", ".html")

# Служебные каталоги и виртуальные окружения, исключаемые из проверки
EXCLUDED_DIRS = {
    "node_modules",
    ".venv",
    "__pycache__",
    ".git",
    ".pytest_cache",
    ".idea",
}


@pytest.mark.unit
def test_no_citation_artifacts_in_source_code():
    """
    Проверка отсутствия паразитных артефактов цитирования во всех исходных файлах проекта.
    Сканирует кодовую базу и завершается сбоем при обнаружении синтаксических меток цитирования.
    """
    # Определение абсолютного пути к корню репозитория относительно tests/unit/
    project_root = Path(__file__).resolve().parents[2]
    current_file = Path(__file__).resolve()

    # Динамическая сборка регулярных выражений для предотвращения ложного срабатывания на себе
    citation_prefix = r"\[" + r"cite:"
    artifact_pattern = re.compile(r"\[" + r"cite:\s*[^\]]+\]")

    violations: list[str] = []

    for dir_name in TARGET_DIRS:
        target_dir = project_root / dir_name
        if not target_dir.exists():
            continue

        for file_path in target_dir.rglob("*"):
            # Пропуск каталогов и ссылок на директории
            if not file_path.is_file():
                continue

            # Фильтрация только целевых типов файлов
            if file_path.suffix not in TARGET_EXTENSIONS:
                continue

            # Пропуск служебных и виртуальных папок
            if any(part in EXCLUDED_DIRS for part in file_path.parts):
                continue

            # Исключение самого исполняемого тестового файла
            if file_path.resolve() == current_file:
                continue

            rel_path = file_path.relative_to(project_root)

            try:
                with open(file_path, encoding="utf-8", errors="ignore") as f:
                    for line_no, line in enumerate(f, start=1):
                        # Проверка на наличие полного шаблона либо открывающего префикса
                        if artifact_pattern.search(line) or citation_prefix in line:
                            violations.append(f"{rel_path}:{line_no}: {line.strip()}")
            except OSError as err:
                violations.append(f"{rel_path}:0: Ошибка доступа к файлу ({err})")

    if violations:
        pytest.fail(
            f"Обнаружены паразитные артефакты цитирования в исходных файлах ({len(violations)}):\n"
            + "\n".join(violations)
        )
