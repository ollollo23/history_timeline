"""Универсальная консольная утилита сквозного запуска всех проверок качества платформы.

Последовательно выполняет полный цикл проверок серверного и клиентского контуров:
1. Предварительная валидация окружения (pre-flight checks: package-lock.json, frontend/)
2. Статический анализ Python (ruff check .)
3. Проверка форматирования Python (ruff format --check .)
4. Статический анализ JavaScript (npm run lint)
5. Модульное тестирование фронтенда (npm test / Vitest)
6. Серверные тесты с контролем покрытия (pytest)

Очищает консольные потоки от управляющих escape-последовательностей ANSI,
замеряет хронометраж каждого этапа, выводит диагностический фрагмент ошибки
при сбоях и формирует итоговую сводную таблицу в терминале.
"""

import pathlib
import re
import subprocess
import sys
import time

# Корневая директория репозитория (на один уровень выше каталога scripts)
ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent

# Целевой каталог для сохранения долговременных отчетов аудита
PROJECT_INFO_DIR = ROOT_DIR / "project_info"

# Пути к результирующим файлам протоколов проверок
RUFF_CHECK_REPORT_PATH = PROJECT_INFO_DIR / "ruff_check_last_run.txt"
RUFF_FORMAT_REPORT_PATH = PROJECT_INFO_DIR / "ruff_format_last_run.txt"
ESLINT_REPORT_PATH = PROJECT_INFO_DIR / "eslint_last_run.txt"
NPM_TEST_REPORT_PATH = PROJECT_INFO_DIR / "npm_test_last_run.txt"
PYTEST_REPORT_PATH = PROJECT_INFO_DIR / "pytest_last_run.txt"

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


def verify_preflight_environment() -> bool:
    """Выполняет предварительную валидацию целостности рабочего дерева.

    Проверяет физическое наличие файла package-lock.json и каталога frontend.
    Предотвращает ложноположительные прогоны, исключая сбои npm ci в CI/CD.

    Returns:
        True, если все критические артефакты присутствуют, иначе False.
    """
    lockfile_path = ROOT_DIR / "package-lock.json"
    if not lockfile_path.is_file():
        print(
            "[!] Ошибка pre-flight проверки: Файл 'package-lock.json' не найден в корне проекта.\n"
            "    Отсутствие манифеста блокировок приведет к аварийной остановке шага 'npm ci' "
            "в конвейере непрерывной интеграции GitHub Actions.\n"
            "    Выполните 'npm install' для генерации актуального 'package-lock.json'.",
            file=sys.stderr,
        )
        return False

    frontend_dir = ROOT_DIR / "frontend"
    if not frontend_dir.is_dir():
        print(
            "[!] Ошибка pre-flight проверки: Каталог клиентского кода 'frontend' не найден.",
            file=sys.stderr,
        )
        return False

    return True


def execute_command(
    command: str, output_file: pathlib.Path | None, description: str
) -> tuple[int, float, str]:
    """Запускает системную команду проверки, замеряет время и управляет протоколами.

    Args:
        command: Исполняемая системная команда (например, 'ruff check .').
        output_file: Целевой путь для записи текстового отчета или None для pytest,
            где первичное логирование возложено на внутреннюю фикстуру.
        description: Человекочитаемое наименование шага для терминала.

    Returns:
        Кортеж (код возврата, затраченное время в секундах, очищенный вывод).
    """
    print(f"[*] Запуск: {description} ('{command}')...")
    start_time = time.perf_counter()

    try:
        # Объединение потоков stdout и stderr для фиксации полной хронологии процесса
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
        returncode = result.returncode
        raw_output = result.stdout or ""
    except FileNotFoundError:
        elapsed = time.perf_counter() - start_time
        print(
            f"[!] Критическая ошибка: Не удалось запустить команду '{command}'. "
            "Проверьте доступность исполняемого файла в системной переменной PATH.",
            file=sys.stderr,
        )
        return (1, elapsed, "")

    elapsed = time.perf_counter() - start_time
    cleaned_output = strip_ansi(raw_output)

    # Запись в файл для стандартных команд (ruff, eslint, vitest)
    if output_file is not None:
        output_file.write_text(cleaned_output, encoding="utf-8")
        if returncode == 0:
            print(
                f"[+] {description} успешно завершен ({elapsed:.2f} с, код 0). "
                f"Отчет сохранен в '{output_file.relative_to(ROOT_DIR)}'."
            )
        else:
            print(
                f"[-] {description} завершился с ошибкой ({elapsed:.2f} с, код {returncode}). "
                f"Протокол зафиксирован в '{output_file.relative_to(ROOT_DIR)}'.",
                file=sys.stderr,
            )
    else:
        # Обработка команды pytest (где запись протокола выполняет фикстура TeeWriter)
        if returncode == 0:
            print(
                f"[+] {description} успешно завершен ({elapsed:.2f} с, код 0). "
                f"Протокол обновлен фикстурой в '{PYTEST_REPORT_PATH.relative_to(ROOT_DIR)}'."
            )
        else:
            # Страховочная запись вывода, если pytest упал до инициализации фикстуры
            if not PYTEST_REPORT_PATH.exists() or PYTEST_REPORT_PATH.stat().st_size == 0:
                PYTEST_REPORT_PATH.write_text(cleaned_output, encoding="utf-8")

            print(
                f"[-] {description} завершился с ошибкой ({elapsed:.2f} с, код {returncode}). "
                f"Диагностический отчет доступен в '{PYTEST_REPORT_PATH.relative_to(ROOT_DIR)}'.",
                file=sys.stderr,
            )

    # Вывод диагностического фрагмента ошибки при ненулевом коде возврата
    if returncode != 0:
        lines = [line for line in cleaned_output.strip().splitlines() if line.strip()]
        tail_lines = lines[-20:] if len(lines) > 20 else lines

        print("\n--- Фрагмент диагностического вывода ошибки ---", file=sys.stderr)
        for error_line in tail_lines:
            print(f"  {error_line}", file=sys.stderr)
        print("-----------------------------------------------\n", file=sys.stderr)

    return (returncode, elapsed, cleaned_output)


def main() -> None:
    """Точка входа универсального раннера проверки качества проекта."""
    overall_start_time = time.perf_counter()

    # 1. Предварительная проверка окружения
    if not verify_preflight_environment():
        sys.exit(1)

    # Гарантированное создание каталога хранения отчетов
    PROJECT_INFO_DIR.mkdir(parents=True, exist_ok=True)

    # Список шагов конвейера: (команда, путь к отчету, описание)
    pipeline_steps: list[tuple[str, pathlib.Path | None, str]] = [
        (
            "ruff check .",
            RUFF_CHECK_REPORT_PATH,
            "Статический анализ бэкенда (Ruff Check)",
        ),
        (
            "ruff format --check .",
            RUFF_FORMAT_REPORT_PATH,
            "Проверка форматирования бэкенда (Ruff Format)",
        ),
        (
            "npm run lint",
            ESLINT_REPORT_PATH,
            "Статический анализ фронтенда (ESLint)",
        ),
        (
            "npm test",
            NPM_TEST_REPORT_PATH,
            "Модульные тесты клиентского ядра (Vitest)",
        ),
        (
            "pytest",
            None,
            "Серверный тестовый контур и ведомость покрытия (Pytest)",
        ),
    ]

    # Коллектор результатов для формирования итоговой таблицы
    summary_results: list[dict[str, str | float | int]] = []

    # Последовательное исполнение проверок с принципом ранней остановки (fail-fast)
    for idx, (command, output_file, description) in enumerate(pipeline_steps, start=1):
        return_code, elapsed_sec, _ = execute_command(
            command=command,
            output_file=output_file,
            description=description,
        )

        resolved_report_path = (
            output_file.relative_to(ROOT_DIR)
            if output_file is not None
            else PYTEST_REPORT_PATH.relative_to(ROOT_DIR)
        )

        summary_results.append(
            {
                "step": idx,
                "description": description,
                "elapsed": elapsed_sec,
                "returncode": return_code,
                "report": str(resolved_report_path),
            }
        )

        if return_code != 0:
            print(
                f"[!] Сбой конвейера: этап №{idx} '{description}' завершился с ошибкой (код {return_code}).\n"
                f"    Подробный протокол сохранен в '{resolved_report_path}'.",
                file=sys.stderr,
            )
            sys.exit(1)

    total_duration = time.perf_counter() - overall_start_time

    # Формирование и вывод итоговой ведомости
    print("\n" + "=" * 106)
    print("СВОДНАЯ ВЕДОМОСТЬ СКВОЗНОГО КОНТРОЛЯ КАЧЕСТВА (QUALITY GATE)")
    print("=" * 106)
    print(
        f"{'№':<3} | {'Наименование проверки':<56} | {'Время':<9} | {'Статус':<8} | {'Файл отчета'}"
    )
    print("-" * 106)

    for item in summary_results:
        print(
            f"{item['step']:<3} | "
            f"{str(item['description']):<56} | "
            f"{float(item['elapsed']):>6.2f} с | "
            f"{'OK (0)':<8} | "
            f"{item['report']}"
        )

    print("-" * 106)
    print(f"Суммарное время выполнения полного цикла: {total_duration:.2f} с")
    print("[+] Все этапы контроля качества успешно пройдены (5/5).")
    print("=" * 106 + "\n")

    sys.exit(0)


if __name__ == "__main__":
    main()
