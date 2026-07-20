# NQ Tick Replay Simulator

Local browser simulator for replaying Rithmic NQ tick data as live-forming 5-minute candles.

## Run

```powershell
py -3 server.py
```

Then open:

```text
http://127.0.0.1:8000
```

By default, the app uses `%USERPROFILE%\nq-simulator` for tick data. It scans `%USERPROFILE%\nq-simulator\ticks\*.csv`, imports new or changed files into `%USERPROFILE%\nq-simulator\ticks.sqlite3`, then serves replay data from that local database. Drop future exports into `%USERPROFILE%\nq-simulator\ticks\` so Google Drive does not sync the heavy files. Set `NQ_SIMULATOR_DATA_DIR` to use a different data folder.

## Data assumptions

- CSV timestamps are UTC source time and are displayed/replayed as Melbourne / UTC+10 time.
- Instrument is NQ futures.
- Tick size is `0.25`.
- Point value is `$20`.
- Tick value is `$5`.
- Tick CSV columns are `Aggressor flag;Price;Volume;Time left`.
- New/changed CSV files are imported on app startup. Duplicate-safe SQLite inserts preserve repeated identical ticks inside a file while skipping the same tick sequence if an overlapping export is imported again.

## Replay shortcuts

- `Random Asia` starts from a random available trading date at 10:00 Melbourne display time.
- `Random London` starts from a random available trading date at 17:00 Melbourne display time.
- The replay begins at the first tick at or after that session time.

## Paper trades

Market Buy/Sell fills use the current replay tick price. Limit orders fill when replay ticks trade through the limit price. Executions are appended to `%USERPROFILE%\nq-simulator\paper_trades.csv` by default so Google Drive does not block writes; existing rows are never rewritten or truncated by the app. `realized_pnl` is the realised PnL for that saved fill only: scale-ins/adds write `0.00`, while closes/reductions write the PnL for the contracts closed by that fill.

## Tests

```powershell
py -3 -m unittest discover -s tests
```
