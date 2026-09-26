"""
Консольная утилита нагрузочного профилирования и анализа планов выполнения
диапазонных запросов к таблице events в тестовой базе данных PostgreSQL 18.
Сравнивает эффективность композитного B-Tree индекса, функционального GiST-индекса
и целевого запроса Priority GiST (с подзапросом свернутых потомков и хэш-тайбрейком),
измеряет буферные попадания (Shared Buffers), селективность предикатов, методы сортировки
и число циклов выполнения подпланов.
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

from alembic import command
from alembic.config import Config
from sqlalchemy import insert, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

# Добавление корневого каталога репозитория в sys.path для импорта модулей ядра приложения
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.core.config.config import settings  # noqa: E402
from app.core.constants import (  # noqa: E402
    RANGE_SAMPLE_HASH_MODULUS,
    RANGE_SAMPLE_HASH_MULTIPLIER,
    TIMELINE_MAX_TIMESTAMP,
    TIMELINE_MIN_TIMESTAMP,
)
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

# SQL-выражение для замера производительности B-Tree индекса с предикатом по рангам
BTREE_EXPLAIN_QUERY = text(
    """
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, title, start_date, end_date_effective, rank
    FROM events
    WHERE start_date <= :to_date
      AND end_date_effective >= :from_date
      AND rank = ANY(:ranks)
      AND status = 'approved';
    """
)

# SQL-выражение для замера производительности базового GiST-индекса с предикатом по рангам
GIST_EXPLAIN_QUERY = text(
    """
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, title, start_date, end_date_effective, rank
    FROM events
    WHERE int8range(start_date, end_date_effective, '[]') && int8range(:from_date, :to_date, '[]')
      AND rank = ANY(:ranks)
      AND status = 'approved';
    """
)

# SQL-выражение целевого продакшн-запроса с подзапросом потомков, хэш-сортировкой и лимитом 501
PRIORITY_EXPLAIN_QUERY = text(
    """
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT
        e.id,
        e.title,
        e.start_date,
        e.end_date_effective,
        e.rank,
        e.depth_level,
        (
            SELECT count(*)
            FROM events AS child
            WHERE child.parent_id = e.id
              AND child.status = 'approved'
              AND child.rank != ALL(:ranks)
        ) AS collapsed_children_count
    FROM events AS e
    WHERE int8range(e.start_date, e.end_date_effective, '[]') && int8range(:from_date, :to_date, '[]')
      AND e.rank = ANY(:ranks)
      AND e.status = 'approved'
    ORDER BY
        e.depth_level ASC,
        (e.end_date_effective - e.start_date) DESC,
        ((e.id::BIGINT * :hash_multiplier) % :hash_modulus) ASC,
        e.id ASC
    LIMIT 501;
    """
)


def ensure_test_database_schema(target_url: str) -> None:
    """
    Синхронный накат миграций схемы базы данных через Alembic до ревизии head.

    Выполняется до запуска цикла событий asyncio для предотвращения конфликта
    вложенных вызовов asyncio.run() внутри migrations/env.py.
    Передача целевой строки подключения через alembic_cfg.attributes['target_url']
    изолирует операцию в тестовой базе данных без затрагивания основной БД.
    """
    print(f"[*] Проверка и актуализация схемы тестовой базы данных: {target_url}...")
    alembic_cfg = Config(str(BASE_DIR / "alembic.ini"))
    alembic_cfg.attributes["target_url"] = target_url

    command.upgrade(alembic_cfg, "head")
    print("[+] Схема тестовой базы данных успешно обновлена до ревизии head.")


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
        "--ranks",
        type=str,
        default="century,decade,year",
        help="Список рангов через запятую для фильтрации в бенчмарке (по умолчанию: century,decade,year).",
    )
    parser.add_argument(
        "--keep-data",
        action="store_true",
        default=False,
        help="Сохранить сгенерированные синтетические данные в базе данных после завершения замеров.",
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
    Очистка через RESTART IDENTITY CASCADE гарантирует нумерацию id строго от 1.
    Около 30% записей мелких рангов привязываются к ранее сгенерированным событиям ранга century.
    """
    print(f"[*] Инициализация наполнения таблицы events ({total_rows} записей)...")
    start_time = time.perf_counter()
    now = datetime.now(UTC)

    categories = [cat.value for cat in EventCategory]
    ranks = [rnk.value for rnk in EventRank]

    # Накопительный список первичных ключей событий ранга century для формирования связей parent_id
    century_ids: list[int] = []
    fine_ranks = {
        EventRank.DAY.value,
        EventRank.HOUR.value,
        EventRank.MINUTE.value,
        EventRank.SECOND.value,
    }

    # Безопасные границы генерации стартовой даты для строгого соблюдения ограничений целостности
    min_start = max(TIMELINE_MIN_TIMESTAMP, -50_000_000_000)
    max_start = TIMELINE_MAX_TIMESTAMP - 5_000_000

    # Очистка таблицы с обнулением счетчика последовательности идентификаторов
    async with engine.begin() as conn:
        print("[*] Очистка предыдущих данных (TRUNCATE RESTART IDENTITY)...")
        await conn.execute(text("TRUNCATE TABLE events RESTART IDENTITY CASCADE;"))

    inserted_count = 0
    insert_stmt = insert(Event)

    # Генерация синтетических данных пакетами
    for batch_offset in range(0, total_rows, batch_size):
        current_batch_size = min(batch_size, total_rows - batch_offset)
        batch: list[dict[str, Any]] = []

        for i in range(current_batch_size):
            idx = batch_offset + i + 1
            s_date = random.randint(min_start, max_start)
            duration = random.randint(0, 5_000_000)
            e_date = None if duration == 0 else s_date + duration
            chosen_rank = random.choice(ranks)

            # Формирование иерархических связей родитель-потомок
            if chosen_rank == EventRank.CENTURY.value:
                century_ids.append(idx)
                p_id = None
            elif chosen_rank in fine_ranks and century_ids and random.random() < 0.3:
                p_id = random.choice(century_ids)
            else:
                p_id = None

            batch.append(
                {
                    "title": f"Бенчмарк-событие #{idx}",
                    "description": "Синтетическая запись для нагрузочного замера индексов",
                    "start_date": s_date,
                    "end_date": e_date,
                    "category": random.choice(categories),
                    "rank": chosen_rank,
                    "parent_id": p_id,
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
        print(
            f"    Загружено: {inserted_count}/{total_rows} строк "
            f"(вековых родителей: {len(century_ids)})..."
        )

    elapsed = time.perf_counter() - start_time
    rate = int(inserted_count / elapsed) if elapsed > 0 else 0
    print(f"[+] Синтетический датасет сформирован за {elapsed:.2f} сек. ({rate} строк/сек).")

    # Принудительное обновление статистики оптимизатора PostgreSQL
    print("[*] Обновление статистики оптимизатора (ANALYZE events)...")
    async with engine.begin() as conn:
        await conn.execute(text("ANALYZE events;"))
    print("[+] Статистика оптимизатора PostgreSQL 18 актуализирована.")


def extract_plan_metrics(plan_raw: Any) -> dict[str, Any]:
    """
    Разбор JSON-дерева плана EXPLAIN ANALYZE и извлечение метрик времени,
    буферов, метода сортировки и циклов выполнения подпланов.
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

    # Поиск узлов сканирования таблицы events с сохранением имени индекса
    scan_nodes = [n for n in all_nodes if "Scan" in n.get("Node Type", "")]
    scan_types: list[str] = []
    for n in scan_nodes:
        n_type = n.get("Node Type", "Unknown")
        idx_name = n.get("Index Name")
        if idx_name:
            scan_types.append(f"{n_type} ({idx_name})")
        else:
            scan_types.append(n_type)
    if not scan_types:
        scan_types = [top_plan.get("Node Type", "Unknown")]

    # Сбор буферной статистики и отфильтрованных строк
    shared_hit = sum(int(n.get("Shared Hit Blocks", 0)) for n in all_nodes)
    shared_read = sum(int(n.get("Shared Read Blocks", 0)) for n in all_nodes)
    rows_removed = sum(int(n.get("Rows Removed by Filter", 0)) for n in scan_nodes)
    actual_rows = int(top_plan.get("Actual Rows", 0))

    # Извлечение метода сортировки (по умолчанию N/A)
    sort_method = "N/A"
    for node in all_nodes:
        if node.get("Node Type") == "Sort" and "Sort Method" in node:
            sort_method = str(node.get("Sort Method"))
            break

    # Подсчет суммарного количества циклов выполнения подпланов (Actual Loops)
    subplan_loops = 0
    for node in all_nodes:
        if "Subplan Name" in node or "SubPlan" in node.get("Node Type", ""):
            subplan_loops += int(node.get("Actual Loops", 0))

    return {
        "execution_time_ms": execution_time,
        "planning_time_ms": planning_time,
        "scan_types": scan_types,
        "shared_hit": shared_hit,
        "shared_read": shared_read,
        "rows_removed": rows_removed,
        "actual_rows": actual_rows,
        "sort_method": sort_method,
        "subplan_loops": subplan_loops,
    }


async def warmup_buffers(engine: AsyncEngine, ranks: list[str]) -> None:
    """
    Прогрев буферного пула Shared Buffers перед началом фиксации замеров.
    """
    print("[*] Выполнение серии прогревочных запросов (Warm-up)...")
    async with engine.connect() as conn:
        for rng in BENCHMARK_RANGES:
            for _ in range(5):
                await conn.execute(
                    BTREE_EXPLAIN_QUERY,
                    {
                        "from_date": rng["from_date"],
                        "to_date": rng["to_date"],
                        "ranks": ranks,
                    },
                )
                await conn.execute(
                    PRIORITY_EXPLAIN_QUERY,
                    {
                        "from_date": rng["from_date"],
                        "to_date": rng["to_date"],
                        "ranks": ranks,
                        "hash_multiplier": RANGE_SAMPLE_HASH_MULTIPLIER,
                        "hash_modulus": RANGE_SAMPLE_HASH_MODULUS,
                    },
                )
    print("[+] Буферный пул прогрет, дисковые задержки холодного старта исключены.")


async def benchmark_query_suite(
    engine: AsyncEngine,
    query_stmt: Any,
    query_label: str,
    iterations: int,
    ranks: list[str],
    extra_params: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Исполнение тестовых замеров по набору интервалов с вычислением средних метрик.
    """
    suite_results: list[dict[str, Any]] = []
    print(f"\n{'=' * 115}")
    print(f"ТЕСТИРОВАНИЕ СТРАТЕГИИ: {query_label} (Итераций на диапазон: {iterations})")
    print(f"{'=' * 115}")

    async with engine.connect() as conn:
        for rng in BENCHMARK_RANGES:
            exec_times: list[float] = []
            plan_times: list[float] = []
            shared_hits: list[int] = []
            shared_reads: list[int] = []
            removed_rows: list[int] = []
            actual_rows_list: list[int] = []
            all_scans: set[str] = set()
            sort_methods: list[str] = []
            subplan_loops_list: list[int] = []

            params: dict[str, Any] = {
                "from_date": rng["from_date"],
                "to_date": rng["to_date"],
                "ranks": ranks,
            }
            if extra_params:
                params.update(extra_params)

            for _ in range(iterations):
                res = await conn.execute(query_stmt, params)
                metrics = extract_plan_metrics(res.scalar())
                exec_times.append(metrics["execution_time_ms"])
                plan_times.append(metrics["planning_time_ms"])
                shared_hits.append(metrics["shared_hit"])
                shared_reads.append(metrics["shared_read"])
                removed_rows.append(metrics["rows_removed"])
                actual_rows_list.append(metrics["actual_rows"])
                all_scans.update(metrics["scan_types"])
                sort_methods.append(metrics["sort_method"])
                subplan_loops_list.append(metrics["subplan_loops"])

            avg_exec = sum(exec_times) / len(exec_times)
            avg_plan = sum(plan_times) / len(plan_times)
            avg_hit = int(sum(shared_hits) / len(shared_hits))
            avg_read = int(sum(shared_reads) / len(shared_reads))
            avg_removed = int(sum(removed_rows) / len(removed_rows))
            avg_actual = int(sum(actual_rows_list) / len(actual_rows_list))
            max_loops = max(subplan_loops_list) if subplan_loops_list else 0
            most_common_sort = sort_methods[0] if sort_methods else "N/A"

            total_candidates = avg_actual + avg_removed
            filter_ratio = (avg_removed / total_candidates * 100.0) if total_candidates > 0 else 0.0

            result_entry = {
                "strategy": query_label,
                "range_name": rng["name"],
                "avg_exec_ms": avg_exec,
                "avg_plan_ms": avg_plan,
                "scan_node": ", ".join(sorted(all_scans)),
                "sort_method": most_common_sort,
                "subplan_loops": max_loops,
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
            print(f"    - Метод сортировки:       {result_entry['sort_method']}")
            print(f"    - Циклы SubPlan:          {result_entry['subplan_loops']}")
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
    sep_len = 168
    print("\n" + "=" * sep_len)
    print("ИТОГОВАЯ СВОДНАЯ ТАБЛИЦА ПРОФИЛИРОВАНИЯ ИНТЕРВАЛЬНЫХ ВЫБОРОК")
    print("=" * sep_len)
    header = (
        f"{'Стратегия':<26} | {'Диапазон':<32} | {'Тип узла':<26} | "
        f"{'Sort Method':<18} | {'SubPlan Loops':<14} | {'Время, мс':<10} | "
        f"{'Hit/Read':<10} | {'Отброшено':<10} | {'Отсев, %':<8}"
    )
    print(header)
    print("-" * sep_len)

    for r in all_results:
        hit_read_str = f"{r['shared_hit']}/{r['shared_read']}"
        row = (
            f"{r['strategy']:<26} | "
            f"{r['range_name']:<32} | "
            f"{r['scan_node']:<26} | "
            f"{r.get('sort_method', 'N/A'):<18} | "
            f"{str(r.get('subplan_loops', 0)):<14} | "
            f"{r['avg_exec_ms']:<10.3f} | "
            f"{hit_read_str:<10} | "
            f"{r['avg_removed']:<10} | "
            f"{r['filter_ratio']:<8.1f}"
        )
        print(row)
    print("-" * sep_len)


def evaluate_architecture_verdict(all_results: list[dict[str, Any]]) -> None:
    """
    Формирование автоматического инженерного заключения об архитектурной эффективности
    и эксплуатационной готовности целевого запроса Priority GiST (Limit 501).
    """
    print("\n" + "=" * 115)
    print("АРХИТЕКТУРНОЕ ЗАКЛЮЧЕНИЕ ЭКСПЛУАТАЦИОННОЙ ГОТОВНОСТИ (Target: Priority GiST)")
    print("=" * 115)

    target_results = [r for r in all_results if r["strategy"] == "Priority GiST (Limit 501)"]

    if not target_results:
        print("[!] ОШИБКА: Результаты для стратегии 'Priority GiST (Limit 501)' не найдены.")
        print("=" * 115 + "\n")
        return

    # Критерий 1: Среднее время выполнения avg_exec_ms < 50.0 на каждом диапазоне
    max_exec_time = max(r["avg_exec_ms"] for r in target_results)
    crit_1_ok = all(r["avg_exec_ms"] < 50.0 for r in target_results)
    status_1 = "OK" if crit_1_ok else "FAIL"

    # Критерий 2: Максимальное число циклов subplan_loops <= 501
    max_subplan_loops = max(r.get("subplan_loops", 0) for r in target_results)
    crit_2_ok = max_subplan_loops <= 501
    status_2 = "OK" if crit_2_ok else "FAIL"

    # Критерий 3: Оперативная сортировка (top-N heapsort при усечении, quicksort без сброса на диск)
    sort_methods = [r.get("sort_method", "N/A") for r in target_results]
    broad_result = next((r for r in target_results if "Широкий" in r["range_name"]), None)
    has_heapsort_on_truncation = (
        broad_result is not None and broad_result.get("sort_method") == "top-N heapsort"
    )
    no_disk_spill = all(sm in ("top-N heapsort", "quicksort") for sm in sort_methods)
    crit_3_ok = has_heapsort_on_truncation and no_disk_spill
    status_3 = "OK" if crit_3_ok else "FAIL"

    # Критерий 4: В узлах сканирования присутствует Bitmap Index Scan по ix_events_int8range_gist
    crit_4_ok = all(
        "Bitmap Index Scan" in r["scan_node"] and "ix_events_int8range_gist" in r["scan_node"]
        for r in target_results
    )
    status_4 = "OK" if crit_4_ok else "FAIL"

    print(
        f"[{status_1}] Критерий 1: Среднее время выполнения < 50.0 мс на всех диапазонах "
        f"(максимальное: {max_exec_time:.3f} мс)"
    )
    print(
        f"[{status_2}] Критерий 2: Максимальное число циклов SubPlan <= 501 (отложенный расчет) "
        f"(фактический максимум: {max_subplan_loops})"
    )
    print(
        f"[{status_3}] Критерий 3: Оперативная сортировка (top-N heapsort при усечении, quicksort без сброса на диск) "
        f"(фактические методы: {', '.join(sorted(set(sort_methods)))})"
    )
    print(
        f"[{status_4}] Критерий 4: Наличие 'Bitmap Index Scan' по индексу ix_events_int8range_gist"
    )

    all_passed = crit_1_ok and crit_2_ok and crit_3_ok and crit_4_ok

    print("-" * 115)
    if all_passed:
        print("[+] ИТОГОВЫЙ ВЕРДИКТ: ЦЕЛЕВОЙ ЗАПРОС PRIORITY GIST ПОЛНОСТЬЮ ГОТОВ К ПРОДАКШЕНУ.")
        print(
            "    - Индексное сканирование, отложенное вычисление подзапроса и оперативная сортировка"
        )
        print(
            "      обеспечивают максимальную производительность выборки на промышленных масштабах данных."
        )
    else:
        print("[!] ИТОГОВЫЙ ВЕРДИКТ: ОБНАРУЖЕНЫ ОТКЛОНЕНИЯ ОТ АРХИТЕКТУРНЫХ ТРЕБОВАНИЙ.")
        print(
            "    - Рекомендуется выполнить ручной аудит плана EXPLAIN ANALYZE и настроек планировщика СУБД."
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

    target_ranks = [r.strip() for r in args.ranks.split(",") if r.strip()]

    try:
        # 1. Наполнение синтетическим датасетом с иерархическими связями
        await populate_dataset(engine, total_rows=args.size)

        print(f"[*] Целевой набор рангов для фильтрации: {target_ranks}")

        # 2. Прогрев дискового кэша СУБД с передачей параметров рангов
        await warmup_buffers(engine, ranks=target_ranks)

        all_results: list[dict[str, Any]] = []

        # 3. Замер производительности B-Tree индекса
        btree_results = await benchmark_query_suite(
            engine,
            query_stmt=BTREE_EXPLAIN_QUERY,
            query_label="B-Tree (AND)",
            iterations=args.iterations,
            ranks=target_ranks,
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
                ranks=target_ranks,
            )
            all_results.extend(gist_results)

            # Замер целевого продакшн-запроса с подзапросом потомков и хэш-сортировкой
            priority_results = await benchmark_query_suite(
                engine,
                query_stmt=PRIORITY_EXPLAIN_QUERY,
                query_label="Priority GiST (Limit 501)",
                iterations=args.iterations,
                ranks=target_ranks,
                extra_params={
                    "hash_multiplier": RANGE_SAMPLE_HASH_MULTIPLIER,
                    "hash_modulus": RANGE_SAMPLE_HASH_MODULUS,
                },
            )
            all_results.extend(priority_results)
        else:
            print("\n[*] Функциональный GiST-индекс int8range не обнаружен в схеме базы данных.")
            print("    Замеры выполнены для целевого B-Tree индекса ix_events_start_effective.")

        # 5. Вывод структурированных отчетов и инженерного вердикта
        output_summary_table(all_results)
        evaluate_architecture_verdict(all_results)

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
    Точка входа скрипта с синхронным накатом миграций и обработкой прерывания Ctrl+C.
    """
    try:
        # Синхронная актуализация схемы тестовой базы данных до запуска asyncio-раннера
        ensure_test_database_schema(settings.test_database_url)
        asyncio.run(run_benchmark())
    except KeyboardInterrupt:
        print("\n[!] Прерывание работы пользователем (Ctrl+C). Аварийный выход.")
        sys.exit(130)


if __name__ == "__main__":
    main()
