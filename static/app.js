const state = {
  coverage: null,
  cursor: 0,
  nextCursor: 0,
  running: false,
  paused: false,
  loading: false,
  skipping: false,
  done: false,
  queue: [],
  candles: [],
  tickCandles: [],
  lastTick: null,
  sessionStart: "",
  position: 0,
  avgPrice: 0,
  realizedPnl: 0,
  stopLossPrice: null,
  takeProfitPrice: null,
  limitOrders: [],
  nextLimitOrderId: 1,
  visibleCandles: 220,
  executions: [],
  timer: null,
  chartData: [],
  tickChartData: [],
  showTickChart: false,
  replayVersion: 0,
  instrument: "NQ",
};

const els = {
  coverageText: document.querySelector("#coverageText"),
  replayTime: document.querySelector("#replayTime"),
  lastPrice: document.querySelector("#lastPrice"),
  candleInfo: document.querySelector("#candleInfo"),
  startInput: document.querySelector("#startInput"),
  speedInput: document.querySelector("#speedInput"),
  startBtn: document.querySelector("#startBtn"),
  randomAsiaBtn: document.querySelector("#randomAsiaBtn"),
  randomLondonBtn: document.querySelector("#randomLondonBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  skipBtn: document.querySelector("#skipBtn"),
  tickChartBtn: document.querySelector("#tickChartBtn"),
  zoomOutBtn: document.querySelector("#zoomOutBtn"),
  zoomInBtn: document.querySelector("#zoomInBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  chartGrid: document.querySelector("#chartGrid"),
  chart: document.querySelector("#chart"),
  tickChartPanel: document.querySelector("#tickChartPanel"),
  tickChart: document.querySelector("#tickChart"),
  mnqToggle: document.querySelector("#mnqToggle"),
  qtyInput: document.querySelector("#qtyInput"),
  limitPriceInput: document.querySelector("#limitPriceInput"),
  buyBtn: document.querySelector("#buyBtn"),
  sellBtn: document.querySelector("#sellBtn"),
  buyLimitBtn: document.querySelector("#buyLimitBtn"),
  sellLimitBtn: document.querySelector("#sellLimitBtn"),
  flattenBtn: document.querySelector("#flattenBtn"),
  tradeStatus: document.querySelector("#tradeStatus"),
  positionValue: document.querySelector("#positionValue"),
  avgValue: document.querySelector("#avgValue"),
  realizedValue: document.querySelector("#realizedValue"),
  unrealizedValue: document.querySelector("#unrealizedValue"),
  pendingOrders: document.querySelector("#pendingOrders"),
  executions: document.querySelector("#executions"),
};

const DOLLARS_PER_POINT = {
  NQ: 20,
  MNQ: 2,
};

const chartState = {
  main: null,
  tick: null,
};

const SERIES_OPTIONS = {
  upColor: "#22b573",
  downColor: "#e05252",
  borderUpColor: "#22b573",
  borderDownColor: "#e05252",
  wickUpColor: "#22b573",
  wickDownColor: "#e05252",
};

const CHART_OPTIONS = {
  autoSize: true,
  layout: {
    background: { type: "solid", color: "#0b0e11" },
    textColor: "#8d9aa6",
  },
  grid: {
    vertLines: { color: "#151a20" },
    horzLines: { color: "#1e252c" },
  },
  rightPriceScale: {
    borderColor: "#2f3942",
    autoScale: true,
    scaleMargins: { top: 0.1, bottom: 0.12 },
  },
  timeScale: {
    borderColor: "#2f3942",
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 8,
    barSpacing: 6,
  },
  crosshair: {
    mode: 0,
  },
  handleScroll: {
    mouseWheel: true,
    pressedMouseMove: true,
    horzTouchDrag: true,
    vertTouchDrag: true,
  },
  handleScale: {
    axisPressedMouseMove: true,
    mouseWheel: true,
    pinch: true,
  },
};

function dollarsPerPoint() {
  return DOLLARS_PER_POINT[state.instrument] || DOLLARS_PER_POINT.NQ;
}

function dollarsPerTick() {
  return dollarsPerPoint() * 0.25;
}

function money(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function signedMoney(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function price(value) {
  return value == null ? "--" : Number(value).toFixed(2);
}

function signedPoints(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(2)} pts`;
}

function roundToTick(value) {
  return Math.round(value / 0.25) * 0.25;
}

function numberFromInput(input) {
  if (input.value.trim() === "") return null;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : null;
}

function niceAxisStep(range) {
  const targetLines = 6;
  const rawStep = Math.max(0.25, range / targetLines);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  for (const multiplier of [1, 2, 5, 10]) {
    const step = multiplier * magnitude;
    if (step >= rawStep) return Math.max(0.25, step);
  }
  return Math.max(0.25, 10 * magnitude);
}

function toDatetimeLocal(value) {
  return value.replace(" ", "T").slice(0, 19);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

function parseTimestampParts(timestamp) {
  const match = String(timestamp).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) throw new Error(`Unsupported timestamp: ${timestamp}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond: Number((match[7] || "0").padEnd(3, "0")),
  };
}

function bucket5m(timestamp) {
  const parts = parseTimestampParts(timestamp);
  const minute = parts.minute - (parts.minute % 5);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(minute)}:00.000`;
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

async function loadCoverage() {
  state.coverage = await api("/api/coverage");
  els.coverageText.textContent = `${state.coverage.source} | ${state.coverage.count.toLocaleString()} ticks | ${state.coverage.start} to ${state.coverage.end} | ${state.coverage.timezone}`;
  els.startInput.min = toDatetimeLocal(state.coverage.start);
  els.startInput.max = toDatetimeLocal(state.coverage.end);
  els.startInput.value = toDatetimeLocal(state.coverage.start);
  resizeChart();
}

async function startReplay(startOverride = null) {
  resetReplay(false);
  const replayVersion = state.replayVersion;
  const startValue = startOverride ? toDatetimeLocal(startOverride) : els.startInput.value;
  els.startInput.value = startValue;
  state.sessionStart = startValue.replace("T", " ");
  const seek = await api(`/api/seek?start=${encodeURIComponent(startValue)}`);
  if (replayVersion !== state.replayVersion) return;
  state.cursor = seek.cursor;
  state.nextCursor = seek.cursor;
  state.candles = seek.warmup_candles || [];
  state.tickCandles = seek.warmup_tick_bars || [];
  state.running = true;
  state.paused = false;
  state.done = false;
  els.pauseBtn.textContent = "Pause";
  setControls();
  drawChart();
  await fillQueue(replayVersion);
  scheduleReplay(replayVersion).catch(showError);
}

function resetReplay(resetInput = true) {
  state.replayVersion += 1;
  state.running = false;
  state.paused = false;
  state.loading = false;
  state.skipping = false;
  state.done = false;
  state.queue = [];
  state.candles = [];
  state.tickCandles = [];
  state.lastTick = null;
  state.position = 0;
  state.avgPrice = 0;
  state.realizedPnl = 0;
  state.executions = [];
  state.limitOrders = [];
  state.nextLimitOrderId = 1;
  state.stopLossPrice = null;
  state.takeProfitPrice = null;
  state.chartData = [];
  state.tickChartData = [];
  state.cursor = 0;
  state.nextCursor = 0;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  els.replayTime.textContent = "--";
  els.lastPrice.textContent = "--";
  els.candleInfo.textContent = "--";
  if (resetInput && state.coverage) {
    els.startInput.value = toDatetimeLocal(state.coverage.start);
  }
  setControls();
  renderPendingOrders();
  drawChart();
}

function setControls() {
  els.startBtn.disabled = state.running && !state.done;
  els.randomAsiaBtn.disabled = state.running && !state.done;
  els.randomLondonBtn.disabled = state.running && !state.done;
  els.pauseBtn.disabled = !state.running || state.done || state.skipping;
  els.skipBtn.disabled = !state.running || state.done || !state.lastTick || state.skipping;
  els.resetBtn.disabled = (!state.running && state.candles.length === 0) || state.skipping;
  els.buyBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping;
  els.sellBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping;
  els.buyLimitBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping;
  els.sellLimitBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping;
  els.flattenBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping || state.position === 0;
  els.tradeStatus.textContent = state.lastTick ? "Market orders fill at last replay price." : "Start replay to enable trading.";
  els.tickChartBtn.classList.toggle("active", state.showTickChart);
  els.tickChartBtn.setAttribute("aria-pressed", state.showTickChart ? "true" : "false");
  els.mnqToggle.checked = state.instrument === "MNQ";
}

async function fillQueue(replayVersion = state.replayVersion) {
  if (state.loading || state.done || state.queue.length > 5000) return;
  state.loading = true;
  try {
    const data = await api(`/api/ticks?cursor=${state.nextCursor}&limit=10000`);
    if (replayVersion !== state.replayVersion) return;
    state.queue.push(...data.ticks);
    state.nextCursor = data.next_cursor;
    state.done = data.done && state.queue.length === 0;
  } finally {
    if (replayVersion === state.replayVersion) {
      state.loading = false;
    }
  }
}

function tickMillis(tick) {
  const parts = parseTimestampParts(tick.timestamp);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function delayToNextTick(currentTick, nextTick) {
  if (!currentTick || !nextTick) return 0;
  const speed = Math.max(0.1, Number(els.speedInput.value) || 1);
  const rawDelay = Math.max(0, tickMillis(nextTick) - tickMillis(currentTick));
  return Math.round(rawDelay / speed);
}

async function scheduleReplay(replayVersion = state.replayVersion) {
  if (replayVersion !== state.replayVersion) return;
  if (!state.running || state.paused) return;
  if (state.queue.length < 2000) {
    await fillQueue(replayVersion).catch(showError);
    if (replayVersion !== state.replayVersion) return;
  }

  const tick = state.queue.shift();
  if (!tick) {
    if (state.nextCursor >= state.coverage.count) {
      state.done = true;
      state.running = false;
      setControls();
      return;
    }
    state.timer = setTimeout(() => scheduleReplay(replayVersion).catch(showError), 100);
    return;
  }

  applyTick(tick);
  await checkExitOrders();
  await checkLimitOrders();
  updateReadouts();
  drawChart();
  updatePositionPanel();
  setControls();

  const nextTick = state.queue[0];
  const delay = delayToNextTick(tick, nextTick);
  state.timer = setTimeout(() => scheduleReplay(replayVersion).catch(showError), delay);
}

function applyTick(tick) {
  state.lastTick = tick;
  const bucket = bucket5m(tick.timestamp);
  let candle = state.candles[state.candles.length - 1];
  if (!candle || candle.timestamp !== bucket) {
    candle = {
      timestamp: bucket,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume,
      ticks: 1,
    };
    state.candles.push(candle);
  } else {
    candle.high = Math.max(candle.high, tick.price);
    candle.low = Math.min(candle.low, tick.price);
    candle.close = tick.price;
    candle.volume += tick.volume;
    candle.ticks += 1;
  }

  let tickCandle = state.tickCandles[state.tickCandles.length - 1];
  if (!tickCandle || tickCandle.ticks >= 100) {
    tickCandle = {
      timestamp: tick.timestamp,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume,
      ticks: 1,
    };
    state.tickCandles.push(tickCandle);
  } else {
    tickCandle.high = Math.max(tickCandle.high, tick.price);
    tickCandle.low = Math.min(tickCandle.low, tick.price);
    tickCandle.close = tick.price;
    tickCandle.volume += tick.volume;
    tickCandle.ticks += 1;
  }
}

async function skipCandle() {
  if (!state.running || !state.lastTick || state.skipping) return;
  const replayVersion = state.replayVersion;
  const wasPaused = state.paused;
  const currentBucket = bucket5m(state.lastTick.timestamp);
  state.skipping = true;
  state.paused = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  setControls();
  els.tradeStatus.textContent = `Skipping ${currentBucket.slice(11, 16)} candle...`;

  let processed = 0;
  while (state.running && !state.done) {
    if (state.queue.length === 0) {
      await fillQueue(replayVersion);
      if (replayVersion !== state.replayVersion) return;
    }
    const tick = state.queue.shift();
    if (!tick) {
      if (state.nextCursor >= state.coverage.count) {
        state.done = true;
        state.running = false;
      }
      break;
    }
    applyTick(tick);
    processed += 1;
    const exited = await checkExitOrders();
    const limitFilled = await checkLimitOrders();
    if (exited || limitFilled) {
      break;
    }
    if (bucket5m(tick.timestamp) !== currentBucket) {
      break;
    }
    if (processed % 5000 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  updateReadouts();
  drawChart();
  updatePositionPanel();
  state.skipping = false;
  state.paused = wasPaused;
  setControls();
  els.tradeStatus.textContent = processed > 0 ? `Skipped ${processed.toLocaleString()} ticks to next candle.` : "No more ticks to skip.";
  if (state.running && !state.paused && !state.done) {
    scheduleReplay(replayVersion).catch(showError);
  }
}

function updateReadouts() {
  const tick = state.lastTick;
  const candle = state.candles[state.candles.length - 1];
  els.replayTime.textContent = tick ? tick.timestamp : "--";
  els.lastPrice.textContent = tick ? price(tick.price) : "--";
  els.candleInfo.textContent = candle ? `${candle.timestamp.slice(11, 16)} | ${candle.ticks} ticks | ${candle.volume} vol` : "--";
  if (tick && !els.limitPriceInput.value && document.activeElement !== els.limitPriceInput) {
    els.limitPriceInput.value = price(tick.price);
  }
}

function setChartZoom(nextVisibleCandles) {
  state.visibleCandles = Math.max(40, Math.min(500, Math.round(nextVisibleCandles)));
  drawChart();
}

function zoomChart(direction) {
  const factor = direction === "in" ? 0.75 : 1.35;
  setChartZoom(state.visibleCandles * factor);
}

function ensureLightweightCharts() {
  if (!window.LightweightCharts) {
    throw new Error("Lightweight Charts did not load. Check your internet connection or CDN access.");
  }
}

function addCandlestickSeries(chart) {
  if (typeof chart.addCandlestickSeries === "function") {
    return chart.addCandlestickSeries(SERIES_OPTIONS);
  }
  return chart.addSeries(LightweightCharts.CandlestickSeries, SERIES_OPTIONS);
}

function makeChart(container) {
  ensureLightweightCharts();
  const chart = LightweightCharts.createChart(container, CHART_OPTIONS);
  const series = addCandlestickSeries(chart);
  const lines = [];
  chart.subscribeCrosshairMove((param) => updateCrosshairReadout(param, series));
  return { chart, series, lines };
}

function initCharts() {
  if (!chartState.main) {
    chartState.main = makeChart(els.chart);
  }
  if (!chartState.tick) {
    chartState.tick = makeChart(els.tickChart);
  }
}

function timestampSeconds(timestamp) {
  const parts = parseTimestampParts(timestamp);
  return Math.floor(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  ) / 1000);
}

function candlesToSeries(candles, options = {}) {
  const { ensureUniqueTimes = false } = options;
  const seen = new Map();
  const deduped = [];
  for (const candle of candles) {
    if (ensureUniqueTimes) {
      // Lightweight Charts only supports whole-second timestamps. A busy
      // 100-tick chart can form several bars in the same second, so preserve
      // every bar here and assign unique display times below.
      deduped.push({ ...candle });
      continue;
    }
    const key = candle.timestamp;
    if (seen.has(key)) {
      // merge into existing candle — last write wins for close/high/low, accumulate volume/ticks
      const existing = seen.get(key);
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume = (existing.volume || 0) + (candle.volume || 0);
      existing.ticks = (existing.ticks || 0) + (candle.ticks || 0);
    } else {
      const entry = { ...candle };
      seen.set(key, entry);
      deduped.push(entry);
    }
  }
  let previousTime = null;
  return deduped.map((candle) => {
    let time = timestampSeconds(candle.timestamp);
    if (ensureUniqueTimes && previousTime !== null && time <= previousTime) {
      time = previousTime + 1;
    }
    previousTime = time;
    return {
      time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };
  });
}

function visibleRangeFor(data) {
  if (data.length === 0) return null;
  const fromIndex = Math.max(0, data.length - state.visibleCandles);
  return {
    from: data[fromIndex].time,
    to: data[data.length - 1].time,
  };
}

function applyVisibleRange(slot, data) {
  const range = visibleRangeFor(data);
  if (!range) return;
  window.requestAnimationFrame(() => {
    slot.chart.timeScale().setVisibleRange(range);
  });
}

function clearPriceLines(slot) {
  while (slot.lines.length > 0) {
    slot.series.removePriceLine(slot.lines.pop());
  }
}

function lineStyle(style) {
  return LightweightCharts.LineStyle?.[style] ?? LightweightCharts.LineStyle.Solid;
}

function addPriceLine(slot, options) {
  slot.lines.push(slot.series.createPriceLine({
    axisLabelVisible: true,
    lineWidth: 1,
    lineStyle: lineStyle("Solid"),
    ...options,
  }));
}

function exitLineTitle(prefix, orderPrice) {
  const points = state.position === 0 ? 0 : (orderPrice - state.avgPrice) * Math.sign(state.position);
  const potentialPnl = state.position === 0 ? 0 : (orderPrice - state.avgPrice) * state.position * dollarsPerPoint();
  return `${prefix} ${price(orderPrice)} ${signedPoints(points)} ${signedMoney(potentialPnl)}`;
}

function updatePriceLines(slot) {
  clearPriceLines(slot);
  if (!state.lastTick) return;

  addPriceLine(slot, {
    price: state.lastTick.price,
    color: "#d8a441",
    title: `Last ${price(state.lastTick.price)}`,
  });

  if (state.position !== 0) {
    const unrealized = currentUnrealized();
    addPriceLine(slot, {
      price: state.avgPrice,
      color: unrealized >= 0 ? "#22b573" : "#e05252",
      lineStyle: lineStyle("Dashed"),
      title: `Entry ${price(state.avgPrice)} ${signedMoney(unrealized)}`,
    });
  }

  if (state.stopLossPrice !== null) {
    addPriceLine(slot, {
      price: state.stopLossPrice,
      color: "#ff4d4d",
      lineStyle: lineStyle("LargeDashed"),
      title: exitLineTitle("SL", state.stopLossPrice),
    });
  }

  if (state.takeProfitPrice !== null) {
    addPriceLine(slot, {
      price: state.takeProfitPrice,
      color: "#22b573",
      lineStyle: lineStyle("LargeDashed"),
      title: exitLineTitle("TP", state.takeProfitPrice),
    });
  }

  for (const order of state.limitOrders) {
    addPriceLine(slot, {
      price: order.price,
      color: order.side === "BUY" ? "#58a6ff" : "#d8a441",
      lineStyle: lineStyle("Dashed"),
      title: `LMT ${order.side} ${order.quantity} @ ${price(order.price)}`,
    });
  }
}

function updateSeriesData(slot, data, options = {}) {
  const { fitRange = false, resetSeries = false } = options;
  if (data.length === 0) {
    if (slot.dataLength !== 0 || resetSeries) {
      slot.series.setData([]);
      slot.dataLength = 0;
      slot.lastTime = null;
    }
    return;
  }

  const lastBar = data[data.length - 1];

  // During a skip, always use setData to avoid Lightweight Charts internal state
  // corruption from incremental updates applied to a partially-built series.
  const forceSet = state.skipping || resetSeries;

  const canIncrement = !forceSet
    && slot.dataLength > 0
    && data.length === slot.dataLength
    && lastBar.time === slot.lastTime;

  if (canIncrement) {
    // Updating the currently-forming last bar in place (same candle, new tick).
    slot.series.update(lastBar);
  } else if (!forceSet && slot.dataLength > 0 && data.length === slot.dataLength + 1 && lastBar.time > slot.lastTime) {
    // A new candle just opened — append it.
    slot.series.update(lastBar);
  } else {
    slot.series.setData(data);
  }

  slot.dataLength = data.length;
  slot.lastTime = lastBar.time;
  if (fitRange) {
    applyVisibleRange(slot, data);
  }
}

function drawChart(options = {}) {
  initCharts();
  state.chartData = candlesToSeries(state.candles);
  updateSeriesData(chartState.main, state.chartData, options);
  updatePriceLines(chartState.main);

  if (state.showTickChart) {
    state.tickChartData = candlesToSeries(state.tickCandles, { ensureUniqueTimes: true });
    updateSeriesData(chartState.tick, state.tickChartData, options);
    updatePriceLines(chartState.tick);
  }
}

function resizeChart() {
  initCharts();
  chartState.main.chart.resize(els.chart.clientWidth, els.chart.clientHeight);
  if (state.showTickChart) {
    chartState.tick.chart.resize(els.tickChart.clientWidth, els.tickChart.clientHeight);
  }
  drawChart();
}

function updateCrosshairReadout(param, series) {
  if (!param?.time || !param.seriesData) return;
  const bar = param.seriesData.get(series);
  if (!bar) return;
  els.candleInfo.textContent = `O ${price(bar.open)} | H ${price(bar.high)} | L ${price(bar.low)} | C ${price(bar.close)}`;
}

function handleChartContextMenu(event, kind = "main") {
  event.preventDefault();
  if (state.position === 0) {
    els.tradeStatus.textContent = "Open a position before setting exit orders.";
    return;
  }

  const slot = kind === "tick" ? chartState.tick : chartState.main;
  if (!slot || !state.lastTick) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const rawPrice = slot.series.coordinateToPrice(event.clientY - rect.top);
  if (rawPrice === null) return;
  const orderPrice = roundToTick(rawPrice);

  const isTakeProfit = state.position > 0
    ? orderPrice > state.lastTick.price
    : orderPrice < state.lastTick.price;

  if (isTakeProfit) {
    state.takeProfitPrice = orderPrice;
    els.tradeStatus.textContent = `Take profit set at ${price(orderPrice)}.`;
  } else {
    state.stopLossPrice = orderPrice;
    els.tradeStatus.textContent = `Stop loss set at ${price(orderPrice)}.`;
  }
  drawChart();
}

function executeLocal(side, quantity, fillPrice) {
  const signed = side === "BUY" ? quantity : -quantity;
  const before = state.position;
  const avgBefore = state.avgPrice;
  let realizedDelta = 0;

  if (before === 0 || Math.sign(before) === Math.sign(signed)) {
    const next = before + signed;
    state.avgPrice = ((Math.abs(before) * state.avgPrice) + (quantity * fillPrice)) / Math.abs(next);
    state.position = next;
  } else {
    const closing = Math.min(Math.abs(before), quantity);
    const direction = before > 0 ? 1 : -1;
    realizedDelta = (fillPrice - state.avgPrice) * closing * dollarsPerPoint() * direction;
    state.realizedPnl += realizedDelta;
    const next = before + signed;
    state.position = next;
    if (next === 0) {
      state.avgPrice = 0;
    } else if (Math.sign(next) !== Math.sign(before)) {
      state.avgPrice = fillPrice;
    }
  }

  return {
    side,
    quantity,
    fill_price: fillPrice,
    position_before: before,
    position_after: state.position,
    avg_price_before: avgBefore,
    avg_price_after: state.avgPrice,
    realized_pnl: realizedDelta,
  };
}

function currentUnrealized() {
  if (!state.lastTick || state.position === 0) return 0;
  return (state.lastTick.price - state.avgPrice) * state.position * dollarsPerPoint();
}

function limitOrderTriggered(order) {
  if (!state.lastTick) return false;
  return order.side === "BUY"
    ? state.lastTick.price <= order.price
    : state.lastTick.price >= order.price;
}

async function checkLimitOrders() {
  if (!state.lastTick || state.limitOrders.length === 0) return false;

  let filled = 0;
  for (const order of [...state.limitOrders]) {
    if (!limitOrderTriggered(order)) continue;
    await placeTrade(order.side, order.quantity, order.price, "Limit");
    state.limitOrders = state.limitOrders.filter((pending) => pending.id !== order.id);
    filled += 1;
  }

  if (filled > 0) {
    renderPendingOrders();
    drawChart();
    els.tradeStatus.textContent = `${filled} limit order${filled === 1 ? "" : "s"} filled.`;
    return true;
  }
  return false;
}

async function checkExitOrders() {
  if (state.position === 0 || !state.lastTick) return false;

  const stopTriggered = state.stopLossPrice !== null && (state.position > 0
    ? state.lastTick.price <= state.stopLossPrice
    : state.lastTick.price >= state.stopLossPrice);
  const profitTriggered = state.takeProfitPrice !== null && (state.position > 0
    ? state.lastTick.price >= state.takeProfitPrice
    : state.lastTick.price <= state.takeProfitPrice);

  if (!stopTriggered && !profitTriggered) return false;

  const triggerType = stopTriggered ? "Stop loss" : "Take profit";
  const triggerPrice = stopTriggered ? state.stopLossPrice : state.takeProfitPrice;
  const side = state.position > 0 ? "SELL" : "BUY";
  const quantity = Math.abs(state.position);
  state.stopLossPrice = null;
  state.takeProfitPrice = null;
  await placeTrade(side, quantity);
  els.tradeStatus.textContent = `${triggerType} triggered at ${price(triggerPrice)}; filled ${side} ${quantity} at ${price(state.lastTick.price)}.`;
  return true;
}

async function placeTrade(side, quantityOverride = null, fillPriceOverride = null, orderType = "Market") {
  if (!state.lastTick) return;
  const snapshot = {
    position: state.position,
    avgPrice: state.avgPrice,
    realizedPnl: state.realizedPnl,
  };
  const requestedQuantity = quantityOverride ?? Number(els.qtyInput.value);
  const quantity = Math.max(1, Math.floor(requestedQuantity || 1));
  const fillPrice = fillPriceOverride ?? state.lastTick.price;
  const execution = executeLocal(side, quantity, fillPrice);
  const payload = {
    ...execution,
    instrument: state.instrument,
    order_type: orderType,
    session_start: state.sessionStart,
    replay_timestamp: state.lastTick.timestamp,
    source: state.coverage.source,
  };

  try {
    await api("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    state.position = snapshot.position;
    state.avgPrice = snapshot.avgPrice;
    state.realizedPnl = snapshot.realizedPnl;
    updatePositionPanel();
    throw error;
  }

  if (state.position === 0) {
    state.stopLossPrice = null;
    state.takeProfitPrice = null;
  } else if (execution.position_before !== 0 && Math.sign(execution.position_before) !== Math.sign(state.position)) {
    state.stopLossPrice = null;
    state.takeProfitPrice = null;
  }

  state.executions.unshift({ ...payload });
  state.executions = state.executions.slice(0, 40);
  renderExecutions();
  updatePositionPanel();
  drawChart();
  setControls();
  els.tradeStatus.textContent = `${orderType} ${side} ${quantity} filled at ${price(fillPrice)} and saved.`;
}

function limitPriceFromInput() {
  const raw = Number(els.limitPriceInput.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return roundToTick(raw);
}

function placeLimitOrder(side) {
  if (!state.lastTick) return;
  const orderPrice = limitPriceFromInput();
  if (orderPrice === null) {
    els.tradeStatus.textContent = "Enter a valid limit price.";
    return;
  }

  const quantity = Math.max(1, Math.floor(Number(els.qtyInput.value) || 1));
  const order = {
    id: state.nextLimitOrderId,
    side,
    quantity,
    price: orderPrice,
    instrument: state.instrument,
    created_at: state.lastTick.timestamp,
  };
  state.nextLimitOrderId += 1;
  state.limitOrders.push(order);
  els.limitPriceInput.value = price(orderPrice);
  renderPendingOrders();
  drawChart();
  els.tradeStatus.textContent = `${side} limit ${quantity} @ ${price(orderPrice)} placed.`;
}

function cancelLimitOrder(orderId) {
  const before = state.limitOrders.length;
  state.limitOrders = state.limitOrders.filter((order) => order.id !== orderId);
  if (state.limitOrders.length !== before) {
    renderPendingOrders();
    drawChart();
    els.tradeStatus.textContent = "Limit order cancelled.";
  }
}

async function flattenPosition() {
  if (state.position === 0 || !state.lastTick) return;
  const side = state.position > 0 ? "SELL" : "BUY";
  const quantity = Math.abs(state.position);
  await placeTrade(side, quantity);
  els.tradeStatus.textContent = `Flattened ${quantity} contract${quantity === 1 ? "" : "s"} at ${price(state.lastTick.price)}.`;
}

function updatePositionPanel() {
  els.positionValue.textContent = String(state.position);
  els.avgValue.textContent = state.position === 0 ? "--" : price(state.avgPrice);
  els.realizedValue.textContent = money(state.realizedPnl);
  els.unrealizedValue.textContent = money(currentUnrealized());
}

function renderPendingOrders() {
  els.pendingOrders.innerHTML = "";
  for (const order of state.limitOrders) {
    const li = document.createElement("li");
    li.innerHTML = `<div><strong>${order.side} ${order.quantity} @ ${price(order.price)}</strong><span>${order.instrument} limit</span></div><button type="button" data-cancel-limit="${order.id}">X</button>`;
    els.pendingOrders.appendChild(li);
  }
}

function renderExecutions() {
  els.executions.innerHTML = "";
  for (const ex of state.executions) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${ex.order_type || "Market"} ${ex.side} ${ex.quantity} @ ${price(ex.fill_price)}</strong><span>${ex.replay_timestamp} | Pos ${ex.position_after} | R ${money(ex.realized_pnl)}</span>`;
    els.executions.appendChild(li);
  }
}

async function startRandomSession(session) {
  const label = session === "asia" ? "Asia" : "London";
  els.tradeStatus.textContent = `Finding random ${label} session...`;
  const data = await api(`/api/random-start?session=${encodeURIComponent(session)}`);
  await startReplay(data.start);
  els.tradeStatus.textContent = `${label} session ${data.start.slice(0, 16)} started; first tick ${data.first_tick.slice(11, 19)}.`;
}

function togglePause() {
  state.paused = !state.paused;
  els.pauseBtn.textContent = state.paused ? "Resume" : "Pause";
  setControls();
  if (!state.paused) scheduleReplay().catch(showError);
}

function toggleTickChart() {
  state.showTickChart = !state.showTickChart;
  els.tickChartPanel.hidden = !state.showTickChart;
  els.chartGrid.classList.toggle("split", state.showTickChart);
  setControls();
  window.requestAnimationFrame(resizeChart);
}

function setInstrument(instrument) {
  state.instrument = instrument;
  updatePositionPanel();
  drawChart();
  setControls();
  els.tradeStatus.textContent = `${instrument} mode: ${money(dollarsPerPoint())}/pt, ${money(dollarsPerTick())}/tick.`;
}

function showError(error) {
  els.tradeStatus.textContent = error.message;
  console.error(error);
}

els.startBtn.addEventListener("click", () => startReplay().catch(showError));
els.randomAsiaBtn.addEventListener("click", () => startRandomSession("asia").catch(showError));
els.randomLondonBtn.addEventListener("click", () => startRandomSession("london").catch(showError));
els.pauseBtn.addEventListener("click", togglePause);
els.skipBtn.addEventListener("click", () => skipCandle().catch(showError));
els.tickChartBtn.addEventListener("click", toggleTickChart);
els.zoomOutBtn.addEventListener("click", () => zoomChart("out"));
els.zoomInBtn.addEventListener("click", () => zoomChart("in"));
els.resetBtn.addEventListener("click", () => resetReplay(false));
els.buyBtn.addEventListener("click", () => placeTrade("BUY").catch(showError));
els.sellBtn.addEventListener("click", () => placeTrade("SELL").catch(showError));
els.buyLimitBtn.addEventListener("click", () => placeLimitOrder("BUY"));
els.sellLimitBtn.addEventListener("click", () => placeLimitOrder("SELL"));
els.flattenBtn.addEventListener("click", () => flattenPosition().catch(showError));
els.mnqToggle.addEventListener("change", () => setInstrument(els.mnqToggle.checked ? "MNQ" : "NQ"));
els.pendingOrders.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cancel-limit]");
  if (!button) return;
  cancelLimitOrder(Number(button.dataset.cancelLimit));
});
els.chart.addEventListener("contextmenu", handleChartContextMenu);
els.tickChart.addEventListener("contextmenu", (event) => handleChartContextMenu(event, "tick"));
window.addEventListener("resize", resizeChart);

loadCoverage().catch(showError);
