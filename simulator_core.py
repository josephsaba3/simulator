from __future__ import annotations

import csv
import os
import random
import sqlite3
from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Sequence

INSTRUMENT = "NQ"
TICK_SIZE = 0.25
POINT_VALUE = 20.0
TICK_VALUE = 5.0
MELBOURNE_UTC_OFFSET = "+10:00"
SOURCE_TIMEZONE = "UTC"
SOURCE_TO_MELBOURNE = timedelta(hours=10)
DATA_DIR_ENV = "NQ_SIMULATOR_DATA_DIR"
DEFAULT_DATA_DIR = Path.home() / "nq-simulator"


@dataclass(frozen=True)
class Tick:
    index: int
    timestamp: datetime
    price: float
    volume: int
    aggressor: str
    source_timestamp: datetime | None = None

    def to_json(self) -> dict:
        return {
            "index": self.index,
            "timestamp": format_timestamp(self.timestamp),
            "price": self.price,
            "volume": self.volume,
            "aggressor": self.aggressor,
        }


@dataclass
class Candle:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int
    ticks: int

    def update(self, tick: Tick) -> None:
        self.high = max(self.high, tick.price)
        self.low = min(self.low, tick.price)
        self.close = tick.price
        self.volume += tick.volume
        self.ticks += 1

    def to_json(self) -> dict:
        return {
            "timestamp": format_timestamp(self.timestamp),
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "ticks": self.ticks,
        }


@dataclass
class PaperPosition:
    position: int = 0
    avg_price: float = 0.0
    realized_pnl: float = 0.0

    def execute(self, side: str, quantity: int, price: float) -> dict:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        side = side.upper()
        if side not in {"BUY", "SELL"}:
            raise ValueError("side must be BUY or SELL")

        signed = quantity if side == "BUY" else -quantity
        before = self.position
        avg_before = self.avg_price
        realized_delta = 0.0

        if before == 0 or (before > 0 and signed > 0) or (before < 0 and signed < 0):
            new_position = before + signed
            self.avg_price = ((abs(before) * self.avg_price) + (quantity * price)) / abs(new_position)
            self.position = new_position
        else:
            closing = min(abs(before), quantity)
            direction = 1 if before > 0 else -1
            realized_delta = (price - self.avg_price) * closing * POINT_VALUE * direction
            self.realized_pnl += realized_delta
            new_position = before + signed
            self.position = new_position
            if new_position == 0:
                self.avg_price = 0.0
            elif (before > 0 and new_position < 0) or (before < 0 and new_position > 0):
                self.avg_price = price

        return {
            "side": side,
            "quantity": quantity,
            "fill_price": price,
            "position_before": before,
            "position_after": self.position,
            "avg_price_before": avg_before,
            "avg_price_after": self.avg_price,
            "realized_delta": realized_delta,
            "realized_pnl": self.realized_pnl,
        }

    def unrealized(self, current_price: float | None) -> float:
        if current_price is None or self.position == 0:
            return 0.0
        return (current_price - self.avg_price) * self.position * POINT_VALUE


def format_timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def parse_timestamp(value: str) -> datetime:
    value = value.strip()
    if "T" in value:
        value = value.replace("T", " ")
    if len(value) == 16:
        value = f"{value}:00"
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise ValueError(f"unsupported timestamp: {value}")


def parse_tick_row(row: dict, index: int) -> Tick:
    source_timestamp = parse_timestamp(row["Time left"])
    melbourne_timestamp = source_timestamp + SOURCE_TO_MELBOURNE
    return Tick(
        index=index,
        timestamp=melbourne_timestamp,
        price=float(row["Price"]),
        volume=int(float(row["Volume"])),
        aggressor=(row.get("Aggressor flag") or "").strip() or "None",
        source_timestamp=source_timestamp,
    )


def iter_tick_file(path: Path) -> Iterable[Tick]:
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        required = {"Aggressor flag", "Price", "Volume", "Time left"}
        if not reader.fieldnames or not required.issubset(set(reader.fieldnames)):
            raise ValueError(f"{path.name} is missing required Rithmic tick columns")
        for index, row in enumerate(reader):
            if not row.get("Time left") or not row.get("Price"):
                continue
            yield parse_tick_row(row, index)


def find_tick_csv(base_dir: Path) -> Path:
    candidates = sorted(
        p
        for p in base_dir.glob("*.csv")
        if "tick" in p.name.lower() and "rithmic" in p.name.lower()
    )
    if not candidates:
        raise FileNotFoundError("No Rithmic tick CSV found in the simulator folder")
    return max(candidates, key=lambda p: p.stat().st_size)


def resolve_data_dir(base_dir: Path) -> Path:
    configured = os.environ.get(DATA_DIR_ENV)
    if configured:
        return Path(configured).expanduser()
    if DEFAULT_DATA_DIR.exists():
        return DEFAULT_DATA_DIR
    return base_dir / "data"


def discover_tick_csvs(base_dir: Path, data_dir: Path | None = None) -> list[Path]:
    data_dir = data_dir or resolve_data_dir(base_dir)
    roots = [data_dir / "ticks"]
    if data_dir.resolve() == (base_dir / "data").resolve():
        roots.append(base_dir)
    found: dict[Path, Path] = {}
    for root in roots:
        if not root.exists():
            continue
        for path in root.glob("*.csv"):
            name = path.name.lower()
            if "tick" in name and "rithmic" in name:
                found[path.resolve()] = path
    return sorted(found.values(), key=lambda p: str(p).lower())


def ensure_tick_database(db_path: Path, csv_paths: Sequence[Path]) -> dict:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Tick DB: scanning {len(csv_paths)} CSV file(s) into {db_path}", flush=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                mtime_ns INTEGER NOT NULL,
                imported_at TEXT NOT NULL,
                rows_seen INTEGER NOT NULL,
                rows_inserted INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ticks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                source_timestamp_utc TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                price REAL NOT NULL,
                volume INTEGER NOT NULL,
                aggressor TEXT NOT NULL,
                dup_seq INTEGER NOT NULL,
                UNIQUE(symbol, source_timestamp_utc, price, volume, aggressor, dup_seq)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ticks_timestamp ON ticks(timestamp, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ticks_symbol_timestamp ON ticks(symbol, timestamp, id)")

        imported_files = 0
        skipped_files = 0
        rows_seen_total = 0
        rows_inserted_total = 0
        for file_index, path in enumerate(csv_paths, start=1):
            stat = path.stat()
            key = str(path.resolve())
            existing = conn.execute(
                "SELECT size, mtime_ns FROM files WHERE path = ?",
                (key,),
            ).fetchone()
            if existing == (stat.st_size, stat.st_mtime_ns):
                skipped_files += 1
                print(
                    f"Tick DB: [{file_index}/{len(csv_paths)}] unchanged, skipping {path.name}",
                    flush=True,
                )
                continue

            size_mb = stat.st_size / (1024 * 1024)
            print(
                f"Tick DB: [{file_index}/{len(csv_paths)}] importing {path.name} ({size_mb:.1f} MB)",
                flush=True,
            )
            seen: defaultdict[tuple[str, float, int, str], int] = defaultdict(int)
            rows_seen = 0
            rows_inserted = 0
            last_report = 0
            batch: list[tuple[str, str, str, float, int, str, int]] = []
            for tick in iter_tick_file(path):
                if tick.source_timestamp is None:
                    continue
                rows_seen += 1
                source_ts = format_timestamp(tick.source_timestamp)
                identity = (source_ts, tick.price, tick.volume, tick.aggressor)
                dup_seq = seen[identity]
                seen[identity] += 1
                batch.append(
                    (
                        INSTRUMENT,
                        source_ts,
                        format_timestamp(tick.timestamp),
                        tick.price,
                        tick.volume,
                        tick.aggressor,
                        dup_seq,
                    )
                )
                if len(batch) >= 10_000:
                    rows_inserted += _insert_tick_batch(conn, batch)
                    batch.clear()
                if rows_seen - last_report >= 250_000:
                    last_report = rows_seen
                    print(
                        f"Tick DB: {path.name}: processed {rows_seen:,} rows, inserted {rows_inserted:,}",
                        flush=True,
                    )
            if batch:
                rows_inserted += _insert_tick_batch(conn, batch)

            conn.execute(
                """
                INSERT INTO files(path, size, mtime_ns, imported_at, rows_seen, rows_inserted)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    size=excluded.size,
                    mtime_ns=excluded.mtime_ns,
                    imported_at=excluded.imported_at,
                    rows_seen=excluded.rows_seen,
                    rows_inserted=excluded.rows_inserted
                """,
                (key, stat.st_size, stat.st_mtime_ns, format_timestamp(datetime.now()), rows_seen, rows_inserted),
            )
            conn.commit()
            imported_files += 1
            rows_seen_total += rows_seen
            rows_inserted_total += rows_inserted
            print(
                f"Tick DB: finished {path.name}: processed {rows_seen:,}, inserted {rows_inserted:,}",
                flush=True,
            )

        count = conn.execute("SELECT COUNT(*) FROM ticks WHERE symbol = ?", (INSTRUMENT,)).fetchone()[0]
        print(
            f"Tick DB: ready with {count:,} total ticks "
            f"({imported_files} imported file(s), {skipped_files} skipped file(s), "
            f"{rows_inserted_total:,} new row(s))",
            flush=True,
        )
        return {
            "db_path": str(db_path),
            "csv_files": len(csv_paths),
            "imported_files": imported_files,
            "skipped_files": skipped_files,
            "rows_seen": rows_seen_total,
            "rows_inserted": rows_inserted_total,
            "count": count,
        }


def _insert_tick_batch(conn: sqlite3.Connection, batch: list[tuple[str, str, str, float, int, str, int]]) -> int:
    before = conn.total_changes
    conn.executemany(
        """
        INSERT OR IGNORE INTO ticks(symbol, source_timestamp_utc, timestamp, price, volume, aggressor, dup_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        batch,
    )
    return conn.total_changes - before


def floor_5m(value: datetime) -> datetime:
    minute = value.minute - (value.minute % 5)
    return value.replace(minute=minute, second=0, microsecond=0)


def aggregate_5m(ticks: Iterable[Tick]) -> list[Candle]:
    candles: list[Candle] = []
    current: Candle | None = None
    for tick in ticks:
        bucket = floor_5m(tick.timestamp)
        if current is None or current.timestamp != bucket:
            current = Candle(
                timestamp=bucket,
                open=tick.price,
                high=tick.price,
                low=tick.price,
                close=tick.price,
                volume=tick.volume,
                ticks=1,
            )
            candles.append(current)
        else:
            current.update(tick)
    return candles


def aggregate_tick_bars(ticks: Iterable[Tick], size: int = 100) -> list[Candle]:
    if size <= 0:
        raise ValueError("Tick bar size must be positive")
    candles: list[Candle] = []
    current: Candle | None = None
    for tick in ticks:
        if current is None or current.ticks >= size:
            current = Candle(
                timestamp=tick.timestamp,
                open=tick.price,
                high=tick.price,
                low=tick.price,
                close=tick.price,
                volume=tick.volume,
                ticks=1,
            )
            candles.append(current)
        else:
            current.update(tick)
    return candles

class TickStore:
    def __init__(self, path: Path):
        self.path = path
        self.ticks = list(iter_tick_file(path))
        if not self.ticks:
            raise ValueError(f"{path.name} has no ticks")
        self.timestamps = [tick.timestamp for tick in self.ticks]

    def coverage(self) -> dict:
        return {
            "instrument": INSTRUMENT,
            "source": self.path.name,
            "timezone": f"Source {SOURCE_TIMEZONE}, displayed as Melbourne / UTC{MELBOURNE_UTC_OFFSET}",
            "tick_size": TICK_SIZE,
            "point_value": POINT_VALUE,
            "tick_value": TICK_VALUE,
            "count": len(self.ticks),
            "start": format_timestamp(self.ticks[0].timestamp),
            "end": format_timestamp(self.ticks[-1].timestamp),
        }

    def cursor_for_time(self, value: datetime) -> int:
        return bisect_left(self.timestamps, value)

    def batch(self, cursor: int, limit: int) -> tuple[list[Tick], int, bool]:
        cursor = max(0, min(cursor, len(self.ticks)))
        limit = max(1, min(limit, 50_000))
        end = min(cursor + limit, len(self.ticks))
        return self.ticks[cursor:end], end, end >= len(self.ticks)

    def warmup_candles(self, start: datetime, minutes: int = 90) -> list[Candle]:
        warmup_start = start - timedelta(minutes=minutes)
        left = self.cursor_for_time(warmup_start)
        right = self.cursor_for_time(start)
        return aggregate_5m(self.ticks[left:right])

    def warmup_tick_bars(self, start: datetime, minutes: int = 90, size: int = 100) -> list[Candle]:
        warmup_start = start - timedelta(minutes=minutes)
        left = self.cursor_for_time(warmup_start)
        right = self.cursor_for_time(start)
        return aggregate_tick_bars(self.ticks[left:right], size)


class SQLiteTickStore:
    def __init__(self, db_path: Path, source_label: str = "SQLite tick database"):
        self.db_path = db_path
        self.source_label = source_label
        with sqlite3.connect(self.db_path) as conn:
            self.count = conn.execute(
                "SELECT COUNT(*) FROM ticks WHERE symbol = ?",
                (INSTRUMENT,),
            ).fetchone()[0]
            if not self.count:
                raise ValueError(f"{db_path.name} has no ticks")
            self.start_timestamp = conn.execute(
                "SELECT timestamp FROM ticks WHERE symbol = ? ORDER BY timestamp, id LIMIT 1",
                (INSTRUMENT,),
            ).fetchone()[0]
            self.end_timestamp = conn.execute(
                "SELECT timestamp FROM ticks WHERE symbol = ? ORDER BY timestamp DESC, id DESC LIMIT 1",
                (INSTRUMENT,),
            ).fetchone()[0]
            self.session_dates = [
                datetime.strptime(row[0], "%Y-%m-%d").date()
                for row in conn.execute(
                    "SELECT DISTINCT substr(timestamp, 1, 10) FROM ticks WHERE symbol = ? ORDER BY 1",
                    (INSTRUMENT,),
                )
            ]

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def _rows_to_ticks(self, rows: Iterable[tuple[str, float, int, str, str]], start_index: int) -> list[Tick]:
        ticks: list[Tick] = []
        for offset, row in enumerate(rows):
            source_timestamp = parse_timestamp(row[4]) if row[4] else None
            ticks.append(
                Tick(
                    index=start_index + offset,
                    timestamp=parse_timestamp(row[0]),
                    price=float(row[1]),
                    volume=int(row[2]),
                    aggressor=row[3],
                    source_timestamp=source_timestamp,
                )
            )
        return ticks

    def coverage(self) -> dict:
        return {
            "instrument": INSTRUMENT,
            "source": self.source_label,
            "database": self.db_path.name,
            "timezone": f"Source {SOURCE_TIMEZONE}, displayed as Melbourne / UTC{MELBOURNE_UTC_OFFSET}",
            "tick_size": TICK_SIZE,
            "point_value": POINT_VALUE,
            "tick_value": TICK_VALUE,
            "count": self.count,
            "start": self.start_timestamp,
            "end": self.end_timestamp,
        }

    def cursor_for_time(self, value: datetime) -> int:
        with self._connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM ticks WHERE symbol = ? AND timestamp < ?",
                (INSTRUMENT, format_timestamp(value)),
            ).fetchone()[0]

    def batch(self, cursor: int, limit: int) -> tuple[list[Tick], int, bool]:
        cursor = max(0, min(cursor, self.count))
        limit = max(1, min(limit, 50_000))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT timestamp, price, volume, aggressor, source_timestamp_utc
                FROM ticks
                WHERE symbol = ?
                ORDER BY timestamp, id
                LIMIT ? OFFSET ?
                """,
                (INSTRUMENT, limit, cursor),
            ).fetchall()
        ticks = self._rows_to_ticks(rows, cursor)
        end = cursor + len(ticks)
        return ticks, end, end >= self.count

    def _ticks_for_window(self, start: datetime, end: datetime) -> list[Tick]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT timestamp, price, volume, aggressor, source_timestamp_utc
                FROM ticks
                WHERE symbol = ? AND timestamp >= ? AND timestamp < ?
                ORDER BY timestamp, id
                """,
                (INSTRUMENT, format_timestamp(start), format_timestamp(end)),
            ).fetchall()
        start_index = self.cursor_for_time(start)
        return self._rows_to_ticks(rows, start_index)

    def warmup_candles(self, start: datetime, minutes: int = 90) -> list[Candle]:
        warmup_start = start - timedelta(minutes=minutes)
        return aggregate_5m(self._ticks_for_window(warmup_start, start))

    def warmup_tick_bars(self, start: datetime, minutes: int = 90, size: int = 100) -> list[Candle]:
        warmup_start = start - timedelta(minutes=minutes)
        return aggregate_tick_bars(self._ticks_for_window(warmup_start, start), size)

    def random_session_start(self, hour: int) -> dict:
        dates = self.session_dates[:]
        random.shuffle(dates)
        with self._connect() as conn:
            for session_date in dates:
                start = datetime.combine(session_date, datetime.min.time()).replace(hour=hour)
                row = conn.execute(
                    """
                    SELECT timestamp
                    FROM ticks
                    WHERE symbol = ? AND timestamp >= ?
                    ORDER BY timestamp, id
                    LIMIT 1
                    """,
                    (INSTRUMENT, format_timestamp(start)),
                ).fetchone()
                if row and parse_timestamp(row[0]).date() == session_date:
                    return {
                        "start": format_timestamp(start),
                        "cursor": self.cursor_for_time(start),
                        "first_tick": row[0],
                    }
        raise ValueError(f"No ticks found for random session hour {hour:02d}:00")

def build_tick_store(base_dir: Path) -> SQLiteTickStore:
    data_dir = resolve_data_dir(base_dir)
    csv_paths = discover_tick_csvs(base_dir, data_dir)
    db_path = data_dir / "ticks.sqlite3"
    if not csv_paths:
        if db_path.exists():
            print(f"Tick DB: no CSV files found; using existing {db_path}", flush=True)
            return SQLiteTickStore(db_path, source_label=f"existing {db_path.name}")
        raise FileNotFoundError(
            f"No Rithmic tick CSV found and no existing {db_path.name} database found. "
            f"Add files to {data_dir / 'ticks'} or set {DATA_DIR_ENV}."
        )
    print("Tick DB: discovered tick files:", flush=True)
    for path in csv_paths:
        print(f"  - {path}", flush=True)
    import_summary = ensure_tick_database(db_path, csv_paths)
    source_label = f"{len(csv_paths)} CSV file(s) via {db_path.name}"
    return SQLiteTickStore(db_path, source_label=source_label)
