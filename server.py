from __future__ import annotations

import csv
import json
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from simulator_core import (
    INSTRUMENT,
    POINT_VALUE,
    PaperPosition,
    SQLiteTickStore,
    build_tick_store,
    format_timestamp,
    parse_timestamp,
    resolve_data_dir,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TRADES_PATH = resolve_data_dir(BASE_DIR) / "paper_trades.csv"
TRADE_HEADERS = [
    "saved_at",
    "session_start",
    "replay_timestamp",
    "instrument",
    "order_type",
    "side",
    "quantity",
    "fill_price",
    "position_before",
    "position_after",
    "avg_price_after",
    "realized_pnl",
    "source",
]

STORE: SQLiteTickStore | None = None


def get_store() -> SQLiteTickStore:
    global STORE
    if STORE is None:
        STORE = build_tick_store(BASE_DIR)
    return STORE


def write_json(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def trade_headers_for_append() -> list[str]:
    if not TRADES_PATH.exists():
        return TRADE_HEADERS
    with TRADES_PATH.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        existing = next(reader, None)
    return existing or TRADE_HEADERS


def append_trade(row: dict) -> None:
    TRADES_PATH.parent.mkdir(parents=True, exist_ok=True)
    exists = TRADES_PATH.exists()
    headers = trade_headers_for_append()
    with TRADES_PATH.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        if not exists:
            writer.writeheader()
        writer.writerow({key: row.get(key, "") for key in headers})


class SimulatorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/coverage":
                write_json(self, get_store().coverage())
            elif parsed.path == "/api/seek":
                params = parse_qs(parsed.query)
                start = parse_timestamp(params.get("start", [""])[0])
                cursor = get_store().cursor_for_time(start)
                write_json(
                    self,
                    {
                        "cursor": cursor,
                        "start": format_timestamp(start),
                        "warmup_candles": [c.to_json() for c in get_store().warmup_candles(start)],
                        "warmup_tick_bars": [c.to_json() for c in get_store().warmup_tick_bars(start)],
                    },
                )
            elif parsed.path == "/api/ticks":
                params = parse_qs(parsed.query)
                cursor = int(params.get("cursor", ["0"])[0])
                limit = int(params.get("limit", ["5000"])[0])
                ticks, next_cursor, done = get_store().batch(cursor, limit)
                write_json(
                    self,
                    {
                        "ticks": [tick.to_json() for tick in ticks],
                        "next_cursor": next_cursor,
                        "done": done,
                    },
                )
            elif parsed.path == "/api/random-start":
                params = parse_qs(parsed.query)
                session = params.get("session", [""])[0].lower()
                hours = {"asia": 10, "london": 17}
                if session not in hours:
                    raise ValueError("session must be asia or london")
                result = get_store().random_session_start(hours[session])
                result["session"] = session
                result["hour"] = hours[session]
                write_json(self, result)
            else:
                super().do_GET()
        except Exception as exc:
            write_json(self, {"error": str(exc)}, status=400)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path != "/api/trades":
                write_json(self, {"error": "not found"}, status=404)
                return
            payload = read_json(self)
            row = {
                "saved_at": format_timestamp(datetime.now()),
                "session_start": payload.get("session_start", ""),
                "replay_timestamp": payload.get("replay_timestamp", ""),
                "instrument": payload.get("instrument") if payload.get("instrument") in {"NQ", "MNQ"} else INSTRUMENT,
                "order_type": payload.get("order_type") if payload.get("order_type") in {"Market", "Limit"} else "Market",
                "side": payload.get("side", ""),
                "quantity": int(payload.get("quantity", 1)),
                "fill_price": f"{float(payload.get('fill_price')):.2f}",
                "position_before": int(payload.get("position_before", 0)),
                "position_after": int(payload.get("position_after", 0)),
                "avg_price_after": f"{float(payload.get('avg_price_after', 0)):.2f}",
                "realized_pnl": f"{float(payload.get('realized_pnl', 0)):.2f}",
                "source": payload.get("source", ""),
            }
            append_trade(row)
            write_json(self, {"ok": True, "row": row})
        except Exception as exc:
            write_json(self, {"error": str(exc)}, status=400)


def main() -> None:
    store = get_store()
    coverage = store.coverage()
    server = ThreadingHTTPServer(("127.0.0.1", 8080), SimulatorHandler)
    print(f"Loaded {coverage['count']:,} ticks from {coverage['source']}")
    if coverage.get("database"):
        print(f"Database: {coverage['database']}")
    print(f"Coverage: {coverage['start']} to {coverage['end']} ({coverage['timezone']})")
    print(f'Paper trades: {TRADES_PATH}')
    print('Open http://127.0.0.1:8080')
    server.serve_forever()


if __name__ == "__main__":
    main()
