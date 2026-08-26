import os
from pathlib import Path

# запуск (python scripts/dump_project.py)

# Список исключаемых директорий (виртуальные окружения, кэш, служебные папки)
IGNORED_DIRS: set[str] = {
    ".venv",
    "venv",
    "env",
    ".git",
    ".idea",
    ".vscode",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".kilo",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".ruff_cache",
}

# Расширения бинарных файлов, баз данных, логов и медиа, исключаемые из выгрузки
IGNORED_EXTENSIONS: set[str] = {
    ".pyc",
    ".pyo",
    ".log",
    ".zip",
    ".tar",
    ".gz",
    ".sqlite3",
    ".db",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".ts",
    ".js",
    ".mjs",
    ".cjs",
    ".map",
    ".jsonc",
    ".lock",
    ".d.ts",
}

# Имена файлов, исключаемые из выгрузки
IGNORED_FILENAMES: set[str] = {
    "project_context.txt",
    "package.json",
    "package-lock.json",
    "kilo.jsonc",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "agent-manager.json",
    "History_Project_info.pdf"
}

# Маппинг расширений файлов к языкам разметки Markdown для подсветки синтаксиса
LANGUAGE_MAPPING: dict[str, str] = {
    ".py": "python",
    ".ini": "ini",
    ".txt": "text",
    ".md": "markdown",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".json": "json",
    ".mako": "mako",
    ".html": "html",
    ".css": "css",
    ".js": "javascript",
}


def should_ignore_file(file_path: Path) -> bool:
    """Определяет, должен ли файл быть исключен из обработки."""
    if file_path.name in IGNORED_FILENAMES:
        return True
    if file_path.suffix.lower() in IGNORED_EXTENSIONS:
        return True
    return False


def get_syntax_language(file_path: Path) -> str:
    """Возвращает идентификатор языка для блока Markdown-подсветки."""
    if file_path.name == ".gitignore":
        return "gitignore"
    return LANGUAGE_MAPPING.get(file_path.suffix.lower(), "text")


def generate_ascii_tree(current_dir: Path, prefix: str = "") -> list[str]:
    """Рекурсивно формирует текстовое дерево каталогов проекта (ASCII Tree)."""
    tree_lines: list[str] = []
    try:
        entries = sorted(
            list(current_dir.iterdir()),
            key=lambda item: (item.is_file(), item.name.lower()),
        )
    except PermissionError:
        return tree_lines

    # Фильтрация объектов дерева
    valid_entries: list[Path] = []
    for entry in entries:
        if entry.is_dir() and entry.name in IGNORED_DIRS:
            continue
        if entry.is_file() and should_ignore_file(entry):
            continue
        valid_entries.append(entry)

    for index, entry in enumerate(valid_entries):
        is_last = index == len(valid_entries) - 1
        connector = "└── " if is_last else "├── "
        tree_lines.append(f"{prefix}{connector}{entry.name}")

        if entry.is_dir():
            nested_prefix = prefix + ("    " if is_last else "│   ")
            tree_lines.extend(generate_ascii_tree(entry, nested_prefix))

    return tree_lines


def scan_project_files(root_dir: Path) -> list[Path]:
    """Выполняет рекурсивный сбор всех подлежащих выгрузке файлов."""
    collected_files: list[Path] = []

    for dirpath, dirnames, filenames in os.walk(root_dir):
        # Модификация списка на месте для предотвращения обхода игнорируемых папок
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]

        current_dir = Path(dirpath)
        for filename in sorted(filenames):
            file_path = current_dir / filename
            if not should_ignore_file(file_path):
                collected_files.append(file_path)

    return sorted(collected_files)


def main() -> None:
    """Точка входа: сборка контекста проекта в единый текстовый файл."""
    root_dir = Path(__file__).resolve().parent.parent
    output_file_path = root_dir / "project_context.txt"

    target_files = scan_project_files(root_dir)
    tree_structure = [f"{root_dir.name}/"] + generate_ascii_tree(root_dir)

    total_lines_count = 0

    with open(output_file_path, "w", encoding="utf-8", errors="replace") as report_file:
        # Формирование заголовка и схемы дерева файлов
        report_file.write("=" * 80 + "\n")
        report_file.write(f"СТРУКТУРА ПРОЕКТА: {root_dir.name}\n")
        report_file.write("=" * 80 + "\n\n")
        report_file.write("\n".join(tree_structure))
        report_file.write("\n\n\n")

        # Последовательная запись каждого файла проекта
        for file_path in target_files:
            relative_path = file_path.relative_to(root_dir).as_posix()
            file_extension = file_path.suffix if file_path.suffix else file_path.name
            syntax_lang = get_syntax_language(file_path)

            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
            except Exception as read_error:
                content = f"// Ошибка чтения содержимого файла: {str(read_error)}"

            file_lines = len(content.splitlines())
            total_lines_count += file_lines

            # Формирование метаданных и тела файла
            report_file.write("=" * 80 + "\n")
            report_file.write(f"Файл: {relative_path}\n")
            report_file.write(f"Формат: {file_extension}\n")
            report_file.write(f"Размер: {file_lines} строк\n")
            report_file.write("=" * 80 + "\n")
            report_file.write(f"```{syntax_lang}\n")
            report_file.write(content)
            if not content.endswith("\n"):
                report_file.write("\n")
            report_file.write("```\n\n")

    file_size_kb = output_file_path.stat().st_size / 1024

    # Вывод сводной технической информации в терминал
    print("\n" + "=" * 60)
    print("ВЫГРУЗКА КОНТЕКСТА ПРОЕКТА УСПЕШНО ЗАВЕРШЕНА")
    print("=" * 60)
    print(f"Обработано файлов     : {len(target_files)}")
    print(f"Всего строк кода      : {total_lines_count}")
    print(f"Размер выходного файла: {file_size_kb:.2f} KB")
    print(f"Расположение файла    : {output_file_path.resolve()}")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()