"""Утилита автоматической фиксации протоколов проверок клиентского контура.

Последовательно запускает статический анализ ESLint (npm run lint) и модульные
тесты Vitest (npm test), выполняет очистку потоков от управляющих ANSI-кодов
и сохраняет детерминированные текстовые отчеты в каталог project_info в кодировке UTF-8.
"""

import pathlib
import re
import subprocess
import sys

# Корневая директория репозитория (на один уровень выше каталога scripts)
ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent

# Целевой каталог для сохранения долговременных отчетов аудита
PROJECT_INFO_DIR = ROOT_DIR / "project_info"

# Пути к результирующим файлам протоколов
ESLINT_REPORT_PATH = PROJECT_INFO_DIR / "eslint_last_run.txt"
NPM_TEST_REPORT_PATH = PROJECT_INFO_DIR / "npm_test_last_run.txt"

# Регулярное выражение для удаления терминальных ANSI/VT100 escape-последовательностей
ANSI_ESCAPE_PATTERN = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(text: str) -> str:
    """Очищает переданный текст от цветовых и курсорных управляющих кодов ANSI.

    Args:
        text: Исходная строка терминального вывода.

    Returns:
        Очищенная строка без управляющих байтовых последовательностей.
    """
    return ANSI_ESCAPE_PATTERN.sub("", text)


def execute_check(command: str, output_file: pathlib.Path, description: str) -> int:
    """Запускает внешнюю команду проверки, сохраняет чистый отчет и возвращает код завершения.

    Args:
        command: Исполняемая системная команда (например, 'npm run lint').
        output_file: Целевой путь для записи текстового отчета.
        description: Человекочитаемое описание шага для вывода в консоль.

    Returns:
        Код возврата завершенного процесса (0 — успешно, ненулевой — ошибка).
    """
    print(f"[*] Запуск: {description} ('{command}')...")

    try:
        # Объединение stdout и stderr в единый поток для сохранения хронологии сообщений
        result = subprocess.run(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=ROOT_DIR,
        )
    except FileNotFoundError:
        print(
            f"[!] Критическая ошибка: Не удалось запустить команду '{command}'. "
            "Убедитесь, что Node.js и пакетный менеджер npm установлены и доступны в переменной PATH.",
            file=sys.stderr,
        )
        return 1

    # Очистка вывода от escape-кодов подсветки синтаксиса и прогресс-баров
    cleaned_output = strip_ansi(result.stdout or "")

    # Атомарная запись очищенного протокола в файл в кодировке UTF-8
    output_file.write_text(cleaned_output, encoding="utf-8")

    if result.returncode == 0:
        print(
            f"[+] {description} успешно завершен (код 0). "
            f"Отчет сохранен в '{output_file.relative_to(ROOT_DIR)}'."
        )
    else:
        print(
            f"[-] {description} завершился с ошибкой (код {result.returncode}). "
            f"Протокол зафиксирован в '{output_file.relative_to(ROOT_DIR)}'.",
            file=sys.stderr,
        )

    return result.returncode


def main() -> None:
    """Точка входа скрипта протоколирования проверок фронтенда."""
    # Гарантированное создание каталога project_info при его отсутствии
    PROJECT_INFO_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Запуск статического анализатора клиентского кода (ESLint)
    eslint_status = execute_check(
        command="npm run lint",
        output_file=ESLINT_REPORT_PATH,
        description="Статический анализ клиентского кода (ESLint)",
    )

    # 2. Запуск модульного тестирования клиентского контура (Vitest)
    test_status = execute_check(
        command="npm test",
        output_file=NPM_TEST_REPORT_PATH,
        description="Модульные тесты математического ядра (Vitest)",
    )

    # Валидация суммарного результата прогона
    if eslint_status != 0 or test_status != 0:
        print(
            "\n[!] Ошибка: одна или несколько клиентских проверок не пройдены. "
            "Ознакомьтесь с сохраненными логами в каталоге 'project_info'.",
            file=sys.stderr,
        )
        sys.exit(1)

    print("\n[+] Все клиентские проверки успешно пройдены и зафиксированы в 'project_info'.")
    sys.exit(0)


if __name__ == "__main__":
    main()
