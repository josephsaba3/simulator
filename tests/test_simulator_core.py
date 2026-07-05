from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from simulator_core import (
    POINT_VALUE,
    PaperPosition,
    Tick,
    SQLiteTickStore,
    TickStore,
    aggregate_5m,
    aggregate_tick_bars,
    discover_tick_csvs,
    ensure_tick_database,
    floor_5m,
    parse_tick_row,
    parse_timestamp,
)


class SimulatorCoreTests(unittest.TestCase):
    def temp_dir(self):
        scratch = Path(__file__).resolve().parent / ".tmp"
        scratch.mkdir(exist_ok=True)
        return tempfile.TemporaryDirectory(dir=scratch, ignore_cleanup_errors=True)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(Path(__file__).resolve().parent / ".tmp", ignore_errors=True)

    def test_parse_tick_row(self) -> None:
        tick = parse_tick_row(
            {
                "Aggressor flag": "Sell",
                "Price": "30577.25",
                "Volume": "2",
                "Time left": "2026-06-21 22:00:00.191",
            },
            7,
        )
        self.assertEqual(tick.index, 7)
        self.assertEqual(tick.aggressor, "Sell")
        self.assertEqual(tick.price, 30577.25)
        self.assertEqual(tick.volume, 2)
        self.assertEqual(tick.timestamp, datetime(2026, 6, 22, 8, 0, 0, 191000))

    def test_floor_5m(self) -> None:
        self.assertEqual(
            floor_5m(parse_timestamp("2026-06-21 22:04:59.999")),
            datetime(2026, 6, 21, 22, 0),
        )
        self.assertEqual(
            floor_5m(parse_timestamp("2026-06-21 22:05:00.000")),
            datetime(2026, 6, 21, 22, 5),
        )

    def test_aggregate_5m(self) -> None:
        ticks = [
            Tick(0, parse_timestamp("2026-06-21 22:00:00.000"), 100.0, 1, "Buy"),
            Tick(1, parse_timestamp("2026-06-21 22:02:00.000"), 101.0, 3, "Buy"),
            Tick(2, parse_timestamp("2026-06-21 22:04:59.000"), 99.5, 2, "Sell"),
            Tick(3, parse_timestamp("2026-06-21 22:05:00.000"), 100.5, 4, "Sell"),
        ]
        candles = aggregate_5m(ticks)
        self.assertEqual(len(candles), 2)
        self.assertEqual(candles[0].open, 100.0)
        self.assertEqual(candles[0].high, 101.0)
        self.assertEqual(candles[0].low, 99.5)
        self.assertEqual(candles[0].close, 99.5)
        self.assertEqual(candles[0].volume, 6)
        self.assertEqual(candles[0].ticks, 3)
        self.assertEqual(candles[1].timestamp, datetime(2026, 6, 21, 22, 5))

    def test_aggregate_tick_bars(self) -> None:
        ticks = [
            Tick(i, parse_timestamp(f"2026-06-21 22:00:0{i}.000"), 100.0 + i, i + 1, "Buy")
            for i in range(5)
        ]
        candles = aggregate_tick_bars(ticks, size=2)
        self.assertEqual(len(candles), 3)
        self.assertEqual(candles[0].open, 100.0)
        self.assertEqual(candles[0].close, 101.0)
        self.assertEqual(candles[0].volume, 3)
        self.assertEqual(candles[0].ticks, 2)
        self.assertEqual(candles[2].open, 104.0)
        self.assertEqual(candles[2].ticks, 1)

    def test_tick_store_seek_and_batch(self) -> None:
        path = Path(__file__).resolve().parent / "fixtures" / "sample_ticks.csv"
        store = TickStore(path)
        self.assertEqual(store.coverage()["count"], 3)
        self.assertEqual(store.cursor_for_time(parse_timestamp("2026-06-22 08:00:01.000")), 1)
        batch, next_cursor, done = store.batch(1, 2)
        self.assertEqual([tick.price for tick in batch], [101.0, 102.0])
        self.assertEqual(next_cursor, 3)
        self.assertTrue(done)

    def test_external_tick_data_dir_does_not_scan_repo_data(self) -> None:
        with self.temp_dir() as tmp:
            base = Path(tmp) / "repo"
            external = Path(tmp) / "external"
            repo_tick_dir = base / "data" / "ticks"
            external_tick_dir = external / "ticks"
            repo_tick_dir.mkdir(parents=True)
            external_tick_dir.mkdir(parents=True)
            (repo_tick_dir / "NQ Rithmic Tick repo.csv").write_text(
                "Aggressor flag;Price;Volume;Time left;\n",
                encoding="utf-8",
            )
            external_csv = external_tick_dir / "NQ Rithmic Tick external.csv"
            external_csv.write_text(
                "Aggressor flag;Price;Volume;Time left;\n",
                encoding="utf-8",
            )

            csvs = discover_tick_csvs(base, external)

            self.assertEqual(csvs, [external_csv])
    def test_sqlite_import_dedupes_reimport_but_keeps_repeated_ticks(self) -> None:
        with self.temp_dir() as tmp:
            base = Path(tmp)
            tick_dir = base / "data" / "ticks"
            tick_dir.mkdir(parents=True)
            csv_path = tick_dir / "NQ Rithmic Tick sample.csv"
            csv_path.write_text(
                "Aggressor flag;Price;Volume;Time left;\n"
                "Buy;100;1;2026-06-21 22:00:00.000\n"
                "Buy;100;1;2026-06-21 22:00:00.000\n"
                "Sell;101;2;2026-06-21 22:00:01.000\n",
                encoding="utf-8",
            )
            db_path = base / "data" / "ticks.sqlite3"
            csvs = discover_tick_csvs(base, base / "data")

            first = ensure_tick_database(db_path, csvs)
            second = ensure_tick_database(db_path, csvs)

            self.assertEqual(first["count"], 3)
            self.assertEqual(first["rows_inserted"], 3)
            self.assertEqual(second["count"], 3)
            self.assertEqual(second["rows_inserted"], 0)
            with sqlite3.connect(db_path) as conn:
                dup_seqs = [row[0] for row in conn.execute("SELECT dup_seq FROM ticks ORDER BY id LIMIT 2")]
            self.assertEqual(dup_seqs, [0, 1])

    def test_sqlite_store_random_session_start(self) -> None:
        with self.temp_dir() as tmp:
            base = Path(tmp)
            tick_dir = base / "data" / "ticks"
            tick_dir.mkdir(parents=True)
            csv_path = tick_dir / "NQ Rithmic Tick sample.csv"
            csv_path.write_text(
                "Aggressor flag;Price;Volume;Time left;\n"
                "Buy;100;1;2026-06-21 00:00:00.000\n"
                "Sell;101;2;2026-06-21 07:00:00.000\n",
                encoding="utf-8",
            )
            db_path = base / "data" / "ticks.sqlite3"
            ensure_tick_database(db_path, discover_tick_csvs(base, base / "data"))
            store = SQLiteTickStore(db_path)

            asia = store.random_session_start(10)
            london = store.random_session_start(17)

            self.assertEqual(asia["start"], "2026-06-21 10:00:00.000")
            self.assertEqual(asia["first_tick"], "2026-06-21 10:00:00.000")
            self.assertEqual(london["start"], "2026-06-21 17:00:00.000")
            self.assertEqual(london["first_tick"], "2026-06-21 17:00:00.000")

    def test_paper_position_long_short_and_flip(self) -> None:
        ledger = PaperPosition()
        ledger.execute("BUY", 1, 100.0)
        self.assertEqual(ledger.position, 1)
        self.assertEqual(ledger.avg_price, 100.0)
        close = ledger.execute("SELL", 1, 101.0)
        self.assertEqual(close["realized_delta"], POINT_VALUE)
        self.assertEqual(ledger.realized_pnl, POINT_VALUE)
        self.assertEqual(ledger.position, 0)

        ledger.execute("SELL", 2, 200.0)
        self.assertEqual(ledger.position, -2)
        flip = ledger.execute("BUY", 3, 198.0)
        self.assertEqual(flip["realized_delta"], 80.0)
        self.assertEqual(ledger.position, 1)
        self.assertEqual(ledger.avg_price, 198.0)


if __name__ == "__main__":
    unittest.main()
