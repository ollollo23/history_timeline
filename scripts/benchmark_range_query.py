"""
Консольная утилита нагрузочного профилирования и анализа планов выполнения
диапазонных запросов к таблице events в тестовой базе данных PostgreSQL 18.
Сравнивает эффективность композитного B-Tree индекса и функционального GiST-индекса,
измеряет буферные попадания (Shared Buffers) и селективность предикатов.
"""

import argparse
import asyncio
import json
import random
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

# Добавление корневого каталога репозитория в sys.path для импорта модулей ядра приложения
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.core.config.config import settings  # noqa: E402
from app.core.constants import TIMELINE_MAX_TIMESTAMP, TIMELINE_MIN_TIMESTAMP  # noqa: E402
from app.core.enums import CalendarSystem, EventCategory, EventRank, EventStatus  # noqa: E402
from app.models.event import Event  # noqa: E402

# Определение тестовых диапазонов выборки: широкий (10%), средний (1%) и точечный (0.01%)
BENCHMARK_RANGES: list[dict[str, Any]] = [
    {
        "name": "Широкий диапазон (~10% диапазона)",
        "from_date": -10_000_000_000,
        "to_date": 10_000_000_000,
        "description": "Интервал 20 млрд секунд (~634 года)",
    },
    {
        "name": "Средний диапазон (~1% диапазона)",
        "from_date": 0,
        "to_date": 2_000_000_000,
        "description": "Интервал 2 млрд секунд (~63 года)",
    },
    {
        "name": "Точечный диапазон (~0.01% диапазона)",
        "from_date": 1_000_000_000,
        "to_date": 1_020_000_000,
        "description": "Интервал 20 млн секунд (~231 день)",
    },
]

# SQL-выражение для замера производительности с предикатом B-Tree индекса
BTREE_EXPLAIN_QUERY = text(
    """
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, title, start_date, end_date_effective
    FROM events
    WHERE start_date <= :to_date
      AND end_date_effective >= :from_date
      AND status = 'approved';
    """
)

# SQL-выражение для замера производительности с предикатом GiST-индекса через оператор &&
GIST_EXPLAIN_QUERY = text(
    """
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, title, start_date, end_date_effective
    FROM events
    WHERE int8range(start_date, end_date_effective, '[]') && int8range(:from_date, :to_date, '[]')
      AND status = 'approved';
    """
)


def parse_arguments() -> argparse.Namespace:
    """
    Разбор аргументов командной строки утилиты профилирования.
    """
    parser = argparse.ArgumentParser(
        description="Нагрузочное профилирование интервальных запросов в PostgreSQL 18."
    )
    parser.add_argument(
        "--size",
        type=int,
        default=10000,
        help="Количество генерируемых тестовых записей (по умолчанию 10 000).",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=50,
        help="Число итераций выборки для усреднения замеров (по умолчанию 50).",
    )
    parser.add_argument(
        "--keep-data",
        action="store_true",
        default=False,
        help="Сохранить сгенерированные синтетические данные в базе данных после завершения замеров (по умолчанию данные автоматически удаляются).",
    )
    return parser.parse_args()


async def check_gist_index_exists(conn: AsyncConnection) -> bool:
    """
    Проверка наличия функционального GiST-индекса по int8range в таблице events.
    """
    query = text(
        """
        SELECT 1
        FROM pg_indexes
        WHERE tablename = 'events'
          AND indexdef ILIKE '%gist%'
          AND indexdef ILIKE '%int8range%';
        """
    )
    result = await conn.execute(query)
    return result.scalar() is not None


async def populate_dataset(
    engine: AsyncEngine,
    total_rows: int,
    batch_size: int = 5000,
) -> None:
    """
    Генерация и пакетная вставка синтетического набора данных в таблицу events.
    Поле end_date_effective вычисляется СУБД автоматически и не передается во вставке.
    Диапазоны дат математически согласованы с CheckConstraint ограничениями таблицы.
    """
    print(f"[*] Инициализация наполнения таблицы events ({total_rows} записей)...")
    start_time = time.perf_counter()
    now = datetime.now(UTC)

    categories = [cat.value for cat in EventCategory]
    ranks = [rnk.value for rnk in EventRank]

    # Безопасные границы генерации стартовой даты для строгого соблюдения ограничений целостности
    min_start = max(TIMELINE_MIN_TIMESTAMP, -50_000_000_000)
    max_start = TIMELINE_MAX_TIMESTAMP - 5_000_000

    # Очистка таблицы перед загрузкой синтетики
    async with engine.begin() as conn:
        print("[*] Очистка предыдущих данных (TRUNCATE)...")
        await conn.execute(text("TRUNCATE TABLE events RESTART IDENTITY CASCADE;"))

    inserted_count = 0
    insert_stmt = insert(Event)

    # Генерация синтетических данных с гарантией отсутствия инверсии дат
    for batch_offset in range(0, total_rows, batch_size):
        current_batch_size = min(batch_size, total_rows - batch_offset)
        batch: list[dict[str, Any]] = []

        for i in range(current_batch_size):
            idx = batch_offset + i + 1
            # Генерация даты начала в безопасных пределах шкалы
            s_date = random.randint(min_start, max_start)
            # Длительность события от 0 (точечное) до 5 000 000 секунд (~58 дней)
            duration = random.randint(0, 5_000_000)
            # Прямой расчет end_date без усечений, исключающий нарушение end_date >= start_date
            e_date = None if duration == 0 else s_date + duration

            batch.append(
                {
                    "title": f"Бенчмарк-событие #{idx}",
                    "description": "Синтетическая запись для нагрузочного замера индексов",
                    "start_date": s_date,
                    "end_date": e_date,
                    "category": random.choice(categories),
                    "rank": random.choice(ranks),
                    "parent_id": None,
                    "source": "Synthetic Benchmark Generator",
                    "calendar_system": CalendarSystem.GREGORIAN_PROLEPTIC.value,
                    "media_payload": None,
                    "status": EventStatus.APPROVED.value,
                    "created_at": now,
                    "updated_at": now,
                }
            )

        async with engine.begin() as conn:
            await conn.execute(insert_stmt, batch)

        inserted_count += current_batch_size
        print(f"    Загружено: {inserted_count}/{total_rows} строк...")

    elapsed = time.perf_counter() - start_time
    rate = int(inserted_count / elapsed) if elapsed > 0 else 0
    print(f"[+] Синтетический датасет сформирован за {elapsed:.2f} сек. ({rate} строк/сек).")

    # Принудительное обновление статистики планировщика запросов
    print("[*] Обновление статистики оптимизатора (ANALYZE events)...")
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE events;"))
    print("[+] Статистика оптимизатора PostgreSQL 18 актуализирована.")


def extract_plan_metrics(plan_raw: Any) -> dict[str, Any]:
    """
    Разбор JSON-дерева плана EXPLAIN ANALYZE и извлечение метрик времени и буферов.
    """
    if isinstance(plan_raw, str):
        plan_root = json.loads(plan_raw)
    else:
        plan_root = plan_raw

    if isinstance(plan_root, list):
        plan_root = plan_root[0]

    execution_time = float(plan_root.get("Execution Time", 0.0))
    planning_time = float(plan_root.get("Planning Time", 0.0))
    top_plan = plan_root.get("Plan", {})

    all_nodes: list[dict[str, Any]] = []

    def traverse(node: dict[str, Any]) -> None:
        all_nodes.append(node)
        for child in node.get("Plans", []):
            traverse(child)

    traverse(top_plan)

    # Поиск узлов сканирования таблицы events
    scan_nodes = [n for n in all_nodes if "Scan" in n.get("Node Type", "")]
    scan_types = [n.get("Node Type", "Unknown") for n in scan_nodes] or [
        top_plan.get("Node Type", "Unknown")
    ]

    # Сбор буферной статистики и отфильтрованных строк
    shared_hit = sum(int(n.get("Shared Hit Blocks", 0)) for n in all_nodes)
    shared_read = sum(int(n.get("Shared Read Blocks", 0)) for n in all_nodes)
    rows_removed = sum(int(n.get("Rows Removed by Filter", 0)) for n in scan_nodes)
    actual_rows = int(top_plan.get("Actual Rows", 0))

    return {
        "execution_time_ms": execution_time,
        "planning_time_ms": planning_time,
        "scan_types": scan_types,
        "shared_hit": shared_hit,
        "shared_read": shared_read,
        "rows_removed": rows_removed,
        "actual_rows": actual_rows,
    }


async def warmup_buffers(engine: AsyncEngine) -> None:
    """
    Прогрев буферного пула Shared Buffers перед началом фиксации замеров.
    """
    print("[*] Выполнение серии прогревочных запросов (Warm-up)...")
    async with engine.connect() as conn:
        for rng in BENCHMARK_RANGES:
            for _ in range(5):
                await conn.execute(
                    BTREE_EXPLAIN_QUERY,
                    {"from_date": rng["from_date"], "to_date": rng["to_date"]},
                )
    print("[+] Буферный пул прогрет, дисковые задержки холодного старта исключены.")


async def benchmark_query_suite(
    engine: AsyncEngine,
    query_stmt: Any,
    query_label: str,
    iterations: int,
) -> list[dict[str, Any]]:
    """
    Исполнение тестовых замеров по набору интервалов с вычислением средних метрик.
    """
    suite_results: list[dict[str, Any]] = []
    print(f"\n{'=' * 90}")
    print(f"ТЕСТИРОВАНИЕ СТРАТЕГИИ: {query_label} (Итераций на диапазон: {iterations})")
    print(f"{'=' * 90}")

    async with engine.connect() as conn:
        for rng in BENCHMARK_RANGES:
            exec_times: list[float] = []
            plan_times: list[float] = []
            shared_hits: list[int] = []
            shared_reads: list[int] = []
            removed_rows: list[int] = []
            actual_rows_list: list[int] = []
            all_scans: set[str] = set()

            for _ in range(iterations):
                res = await conn.execute(
                    query_stmt,
                    {"from_date": rng["from_date"], "to_date": rng["to_date"]},
                )
                metrics = extract_plan_metrics(res.scalar())
                exec_times.append(metrics["execution_time_ms"])
                plan_times.append(metrics["planning_time_ms"])
                shared_hits.append(metrics["shared_hit"])
                shared_reads.append(metrics["shared_read"])
                removed_rows.append(metrics["rows_removed"])
                actual_rows_list.append(metrics["actual_rows"])
                all_scans.update(metrics["scan_types"])

            avg_exec = sum(exec_times) / len(exec_times)
            avg_plan = sum(plan_times) / len(plan_times)
            avg_hit = int(sum(shared_hits) / len(shared_hits))
            avg_read = int(sum(shared_reads) / len(shared_reads))
            avg_removed = int(sum(removed_rows) / len(removed_rows))
            avg_actual = int(sum(actual_rows_list) / len(actual_rows_list))

            total_candidates = avg_actual + avg_removed
            filter_ratio = (avg_removed / total_candidates * 100.0) if total_candidates > 0 else 0.0

            result_entry = {
                "strategy": query_label,
                "range_name": rng["name"],
                "avg_exec_ms": avg_exec,
                "avg_plan_ms": avg_plan,
                "scan_node": ", ".join(sorted(all_scans)),
                "shared_hit": avg_hit,
                "shared_read": avg_read,
                "avg_actual": avg_actual,
                "avg_removed": avg_removed,
                "filter_ratio": filter_ratio,
            }
            suite_results.append(result_entry)

            print(f"[*] {rng['name']}:")
            print(f"    - Время выполнения (avg): {avg_exec:.3f} мс (план: {avg_plan:.3f} мс)")
            print(f"    - Узлы сканирования:      {result_entry['scan_node']}")
            print(f"    - Буферы Shared Hit/Read: {avg_hit} / {avg_read} блоков")
            print(
                f"    - Возвращено / Отброшено: {avg_actual} / {avg_removed} строк "
                f"(доля отсева: {filter_ratio:.1f}%)"
            )

    return suite_results


def output_summary_table(all_results: list[dict[str, Any]]) -> None:
    """
    Вывод структурированной итоговой таблицы результатов профилирования.
    """
    print("\n" + "=" * 115)
    print("ИТОГОВАЯ СВОДНАЯ ТАБЛИЦА ПРОФИЛИРОВАНИЯ ИНТЕРВАЛЬНЫХ ВЫБОРОК")
    print("=" * 115)
    header = (
        f"{'Стратегия':<16} | {'Диапазон':<32} | {'Тип узла':<22} | "
        f"{'Время, мс':<10} | {'Hit/Read':<10} | {'Отброшено':<10} | {'Отсев, %':<8}"
    )
    print(header)
    print("-" * 115)

    for r in all_results:
        hit_read_str = f"{r['shared_hit']}/{r['shared_read']}"
        row = (
            f"{r['strategy']:<16} | "
            f"{r['range_name']:<32} | "
            f"{r['scan_node']:<22} | "
            f"{r['avg_exec_ms']:<10.3f} | "
            f"{hit_read_str:<10} | "
            f"{r['avg_removed']:<10} | "
            f"{r['filter_ratio']:<8.1f}"
        )
        print(row)
    print("-" * 115)


def evaluate_architecture_verdict(btree_results: list[dict[str, Any]]) -> None:
    """
    Формирование автоматического инженерного заключения об эффективности B-Tree индекса.
    """
    print("\nАРХИТЕКТУРНОЕ ЗАКЛЮЧЕНИЕ ЭКСПЛУАТАЦИОННОЙ НАДЕЖНОСТИ:")

    # Проверка условий достаточности B-Tree индекса
    has_seq_scan = any("Seq Scan" in r["scan_node"] for r in btree_results)
    max_exec_time = max(r["avg_exec_ms"] for r in btree_results)
    max_filter_ratio = max(r["filter_ratio"] for r in btree_results)

    is_time_optimal = max_exec_time < 5.0
    is_index_scanned = not has_seq_scan
    is_filter_selective = max_filter_ratio <= 15.0

    if is_time_optimal and is_index_scanned and is_filter_selective:
        print(
            "[+] ВЕРДИКТ: Составной B-Tree индекс ix_events_start_effective ПОЛНОСТЬЮ ДОСТАТОЧЕН."
        )
        print(f"    - Среднее время выборки не превышает 5 мс (максимум: {max_exec_time:.3f} мс);")
        print("    - Полное сканирование таблицы (Seq Scan) полностью отсутствует во всех окнах;")
        print(
            f"    - Доля строк, отброшенных фильтром после индексного чтения, "
            f"составляет {max_filter_ratio:.1f}% (порог: <= 15%);"
        )
        print("    - Внедрение функционального GiST-индекса на данном этапе не требуется.")
    else:
        print("[!] ВЕРДИКТ: Зафиксирована субоптимальная селективность B-Tree индекса:")
        if not is_time_optimal:
            print(f"    - Превышен лимит времени выполнения (> 5 мс): {max_exec_time:.3f} мс;")
        if has_seq_scan:
            print("    - Обнаружена деградация до последовательного чтения (Seq Scan);")
        if not is_filter_selective:
            print(
                f"    - Высокая доля отброшенных фильтром строк: {max_filter_ratio:.1f}% "
                f"(превышает норматив 15%);"
            )
        print(
            "    - Рекомендация: внедрить функциональный GiST-индекс по int8range в спринте масштабирования."
        )
    print("=" * 115 + "\n")


async def cleanup_database(engine: AsyncEngine) -> None:
    """
    Очистка тестовой таблицы events после проведения профилирования.
    """
    print("[*] Автоматическая очистка синтетических данных...")
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE TABLE events RESTART IDENTITY CASCADE;"))
    print("[+] Тестовая таблица events успешно очищена.")


async def run_benchmark() -> None:
    """
    Координирующая функция сценария профилирования.
    """
    args = parse_arguments()
    engine = create_async_engine(settings.test_database_url, echo=False)

    try:
        # 1. Наполнение синтетическим датасетом
        await populate_dataset(engine, total_rows=args.size)

        # 2. Прогрев дискового кэша СУБД
        await warmup_buffers(engine)

        all_results: list[dict[str, Any]] = []

        # 3. Замер производительности B-Tree индекса
        btree_results = await benchmark_query_suite(
            engine,
            query_stmt=BTREE_EXPLAIN_QUERY,
            query_label="B-Tree (AND)",
            iterations=args.iterations,
        )
        all_results.extend(btree_results)

        # 4. Проверка наличия и замер GiST-индекса при его наличии
        async with engine.connect() as conn:
            gist_present = await check_gist_index_exists(conn)

        if gist_present:
            gist_results = await benchmark_query_suite(
                engine,
                query_stmt=GIST_EXPLAIN_QUERY,
                query_label="GiST (&&)",
                iterations=args.iterations,
            )
            all_results.extend(gist_results)
        else:
            print("\n[*] Функциональный GiST-индекс int8range не обнаружен в схеме базы данных.")
            print("    Замеры выполнены для целевого B-Tree индекса ix_events_start_effective.")

        # 5. Вывод отчетов и инженерного вердикта
        output_summary_table(all_results)
        evaluate_architecture_verdict(btree_results)

        # 6. Очистка базы данных по умолчанию или сохранение при передаче --keep-data
        if not args.keep_data:
            await cleanup_database(engine)
        else:
            print("[*] Данные сохранены в timeline_test_db (передан флаг --keep-data).")

    finally:
        # Гарантированное освобождение сетевых соединений пула asyncpg
        await engine.dispose()
        print("[*] Пул соединений с базой данных успешно освобожден.")


def main() -> None:
    """
    Точка входа скрипта с обработкой прерывания Ctrl+C.
    """
    try:
        asyncio.run(run_benchmark())
    except KeyboardInterrupt:
        print("\n[!] Прерывание работы пользователем (Ctrl+C). Аварийный выход.")
        sys.exit(130)


if __name__ == "__main__":
    main()
