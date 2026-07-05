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
  visibleCandles: 220,
  executions: [],
  timer: null,
  hover: null,
  tickHover: null,
  chartLayout: null,
  tickChartLayout: null,
  showTickChart: false,
  replayVersion: 0,
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
  qtyInput: document.querySelector("#qtyInput"),
  buyBtn: document.querySelector("#buyBtn"),
  sellBtn: document.querySelector("#sellBtn"),
  flattenBtn: document.querySelector("#flattenBtn"),
  tradeStatus: document.querySelector("#tradeStatus"),
  positionValue: document.querySelector("#positionValue"),
  avgValue: document.querySelector("#avgValue"),
  realizedValue: document.querySelector("#realizedValue"),
  unrealizedValue: document.querySelector("#unrealizedValue"),
  executions: document.querySelector("#executions"),
};

const ctx = els.chart.getContext("2d");
const tickCtx = els.tickChart.getContext("2d");
const NQ_DOLLARS_PER_POINT = 20;

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
  state.tickCandles = [];
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
  state.stopLossPrice = null;
  state.takeProfitPrice = null;
  state.hover = null;
  state.tickHover = null;
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
  els.flattenBtn.disabled = !state.running || state.paused || !state.lastTick || state.skipping || state.position === 0;
  els.tradeStatus.textContent = state.lastTick ? "Market orders fill at last replay price." : "Start replay to enable trading.";
  els.tickChartBtn.classList.toggle("active", state.showTickChart);
  els.tickChartBtn.setAttribute("aria-pressed", state.showTickChart ? "true" : "false");
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
    if (exited) {
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
}

function setChartZoom(nextVisibleCandles) {
  state.visibleCandles = Math.max(40, Math.min(500, Math.round(nextVisibleCandles)));
  drawChart();
}

function zoomChart(direction) {
  const factor = direction === "in" ? 0.75 : 1.35;
  setChartZoom(state.visibleCandles * factor);
}

function handleChartWheel(event) {
  event.preventDefault();
  zoomChart(event.deltaY < 0 ? "in" : "out");
}

function resizeChart() {
  const dpr = window.devicePixelRatio || 1;
  resizeCanvas(els.chart, ctx, dpr);
  if (state.showTickChart) {
    resizeCanvas(els.tickChart, tickCtx, dpr);
  }
  drawChart();
}

function resizeCanvas(canvas, context, dpr) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, Math.floor(rect.width * dpr));
  canvas.height = Math.max(360, Math.floor(rect.height * dpr));
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function chartLayoutFor(kind) {
  return kind === "tick" ? state.tickChartLayout : state.chartLayout;
}

function setChartLayout(kind, layout) {
  if (kind === "tick") {
    state.tickChartLayout = layout;
  } else {
    state.chartLayout = layout;
  }
}

function chartHoverFor(kind) {
  return kind === "tick" ? state.tickHover : state.hover;
}

function drawChart() {
  drawCandlestickChart("main", els.chart, ctx, state.candles, "Select a start time and press Start.");
  if (state.showTickChart) {
    drawCandlestickChart("tick", els.tickChart, tickCtx, state.tickCandles, "100 tick bars will appear after Start.");
  }
}

function drawCandlestickChart(kind, canvas, context, sourceCandles, emptyText) {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0b0e11";
  context.fillRect(0, 0, width, height);

  const candles = sourceCandles.slice(-state.visibleCandles);
  setChartLayout(kind, null);
  if (candles.length === 0) {
    context.fillStyle = "#8d9aa6";
    context.font = "14px Segoe UI";
    context.fillText(emptyText, 24, 42);
    return;
  }

  const pad = { left: 58, right: 18, top: 18, bottom: 34 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let visibleMax = Math.max(...highs);
  let visibleMin = Math.min(...lows);
  if (state.position !== 0) {
    visibleMax = Math.max(visibleMax, state.avgPrice);
    visibleMin = Math.min(visibleMin, state.avgPrice);
  }
  if (state.stopLossPrice !== null) {
    visibleMax = Math.max(visibleMax, state.stopLossPrice);
    visibleMin = Math.min(visibleMin, state.stopLossPrice);
  }
  if (state.takeProfitPrice !== null) {
    visibleMax = Math.max(visibleMax, state.takeProfitPrice);
    visibleMin = Math.min(visibleMin, state.takeProfitPrice);
  }
  if (visibleMax === visibleMin) {
    visibleMax += 25;
    visibleMin -= 25;
  }
  const axisStep = 50;
  let max = Math.ceil(visibleMax / axisStep) * axisStep;
  let min = Math.floor(visibleMin / axisStep) * axisStep;
  if (max === min) {
    max += axisStep;
    min -= axisStep;
  }
  const y = (v) => pad.top + ((max - v) / (max - min)) * chartH;
  const step = chartW / Math.max(candles.length, state.visibleCandles);
  const bodyW = Math.max(2, Math.min(7, step * 0.5));
  setChartLayout(kind, { candles, pad, chartW, chartH, width, height, step, bodyW, y, min, max });

  context.strokeStyle = "#1e252c";
  context.lineWidth = 1;
  for (let label = min; label <= max; label += axisStep) {
    const gy = y(label);
    context.beginPath();
    context.moveTo(pad.left, gy);
    context.lineTo(width - pad.right, gy);
    context.stroke();
    context.fillStyle = "#8d9aa6";
    context.font = "12px Segoe UI";
    context.fillText(label.toFixed(0), 8, gy + 4);
  }

  candles.forEach((c, i) => {
    const x = pad.left + i * step + step / 2;
    const up = c.close >= c.open;
    const color = up ? "#22b573" : "#e05252";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x, y(c.high));
    context.lineTo(x, y(c.low));
    context.stroke();
    const top = y(Math.max(c.open, c.close));
    const bottom = y(Math.min(c.open, c.close));
    context.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
  });

  const last = candles[candles.length - 1];
  context.strokeStyle = "#d8a441";
  context.beginPath();
  context.moveTo(pad.left, y(last.close));
  context.lineTo(width - pad.right, y(last.close));
  context.stroke();

  drawPositionOverlay(kind, context);
  drawExitOrderOverlay(kind, context, "SL", state.stopLossPrice, "#ff4d4d");
  drawExitOrderOverlay(kind, context, "TP", state.takeProfitPrice, "#22b573");
  drawHover(kind, context);
}

function drawPositionOverlay(kind, context) {
  const layout = chartLayoutFor(kind);
  if (!layout || state.position === 0 || !state.lastTick) return;
  const { pad, width, height, y } = layout;
  const entryY = y(state.avgPrice);
  if (entryY < pad.top || entryY > height - pad.bottom) return;

  const unrealized = currentUnrealized();
  const isProfit = unrealized >= 0;
  const color = isProfit ? "#22b573" : "#e05252";
  const label = money(unrealized);

  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.setLineDash([2, 3]);
  context.beginPath();
  context.moveTo(pad.left, entryY);
  context.lineTo(width - pad.right, entryY);
  context.stroke();
  context.setLineDash([]);

  context.font = "700 12px Segoe UI";
  const pnlW = Math.max(58, context.measureText(label).width + 18);
  const pnlH = 22;
  const priceLabel = price(state.avgPrice);
  const priceW = Math.max(72, context.measureText(priceLabel).width + 16);
  const x = width - pad.right - pnlW - priceW - 6;
  const yBox = Math.max(pad.top + 2, Math.min(height - pad.bottom - pnlH - 2, entryY - pnlH / 2));

  context.fillStyle = color;
  context.fillRect(x, yBox, pnlW, pnlH);
  context.fillStyle = isProfit ? "#07130d" : "#ffffff";
  context.fillText(label, x + 9, yBox + 15);

  context.fillStyle = "rgba(17, 20, 23, 0.96)";
  context.strokeStyle = color;
  context.strokeRect(x + pnlW + 6, yBox, priceW, pnlH);
  context.fillStyle = "#e8edf2";
  context.fillText(priceLabel, x + pnlW + 14, yBox + 15);
  context.restore();
}

function drawExitOrderOverlay(kind, context, labelPrefix, orderPrice, color) {
  const layout = chartLayoutFor(kind);
  if (!layout || orderPrice === null) return;
  const { pad, width, height, y } = layout;
  const orderY = y(orderPrice);
  if (orderY < pad.top || orderY > height - pad.bottom) return;

  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.setLineDash([7, 5]);
  context.beginPath();
  context.moveTo(pad.left, orderY);
  context.lineTo(width - pad.right, orderY);
  context.stroke();
  context.setLineDash([]);

  const points = state.position === 0 ? 0 : (orderPrice - state.avgPrice) * Math.sign(state.position);
  const potentialPnl = (orderPrice - state.avgPrice) * state.position * NQ_DOLLARS_PER_POINT;
  const label = `${labelPrefix} ${price(orderPrice)} | ${signedPoints(points)} | ${signedMoney(potentialPnl)}`;
  context.font = "700 12px Segoe UI";
  const boxW = Math.max(76, context.measureText(label).width + 16);
  const boxH = 22;
  const x = Math.max(pad.left + 4, width - pad.right - boxW);
  const offset = labelPrefix === "TP" && state.stopLossPrice !== null ? -26 : 0;
  const yBox = Math.max(pad.top + 2, Math.min(height - pad.bottom - boxH - 2, orderY - boxH / 2 + offset));
  context.fillStyle = color;
  context.fillRect(x, yBox, boxW, boxH);
  context.fillStyle = labelPrefix === "TP" ? "#07130d" : "#ffffff";
  context.fillText(label, x + 8, yBox + 15);
  context.restore();
}

function priceAtChartY(yPos, kind = "main") {
  const layout = chartLayoutFor(kind);
  if (!layout) return null;
  const { pad, chartH } = layout;
  if (yPos < pad.top || yPos > pad.top + chartH) return null;
  const max = layout.max;
  const min = layout.min;
  const rawPrice = max - ((yPos - pad.top) / chartH) * (max - min);
  return Math.round(rawPrice / 0.25) * 0.25;
}

function candleAtPoint(x, yPos, kind = "main") {
  const layout = chartLayoutFor(kind);
  if (!layout) return null;
  const { candles, pad, chartW, chartH, step } = layout;
  if (x < pad.left || x > pad.left + chartW || yPos < pad.top || yPos > pad.top + chartH) return null;
  const index = Math.floor((x - pad.left) / step);
  if (index < 0 || index >= candles.length) return null;
  const candle = candles[index];
  const candleX = pad.left + index * step + step / 2;
  return { candle, candleX };
}

function drawHover(kind, context) {
  const hover = chartHoverFor(kind);
  const layout = chartLayoutFor(kind);
  if (!hover || !layout) return;
  const hit = candleAtPoint(hover.x, hover.y, kind);
  if (!hit) return;
  const { candle, candleX } = hit;
  const { pad, width, height, y } = layout;
  const hoverY = hover.y;

  context.save();
  context.strokeStyle = "rgba(216, 164, 65, 0.65)";
  context.lineWidth = 1;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(candleX, pad.top);
  context.lineTo(candleX, height - pad.bottom);
  context.moveTo(pad.left, hoverY);
  context.lineTo(width - pad.right, hoverY);
  context.stroke();
  context.setLineDash([]);

  const rows = [
    candle.timestamp.slice(0, 19),
    `O ${price(candle.open)}  H ${price(candle.high)}`,
    `L ${price(candle.low)}  C ${price(candle.close)}`,
    `Vol ${candle.volume.toLocaleString()}  Ticks ${candle.ticks.toLocaleString()}`,
  ];
  context.font = "12px Segoe UI";
  const tooltipW = Math.max(...rows.map((row) => context.measureText(row).width)) + 18;
  const tooltipH = rows.length * 18 + 12;
  let tx = candleX + 14;
  if (tx + tooltipW > width - 10) tx = candleX - tooltipW - 14;
  let ty = y(candle.high) - tooltipH - 10;
  if (ty < 10) ty = y(candle.low) + 10;
  if (ty + tooltipH > height - 10) ty = height - tooltipH - 10;

  context.fillStyle = "rgba(17, 20, 23, 0.96)";
  context.strokeStyle = "rgba(216, 164, 65, 0.7)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(tx, ty, tooltipW, tooltipH, 6);
  context.fill();
  context.stroke();

  rows.forEach((row, i) => {
    context.fillStyle = i === 0 ? "#d8a441" : "#e8edf2";
    context.fillText(row, tx + 9, ty + 20 + i * 18);
  });
  context.restore();
}

function handleChartHover(event, kind = "main", canvas = els.chart) {
  const rect = canvas.getBoundingClientRect();
  const hover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (kind === "tick") {
    state.tickHover = hover;
  } else {
    state.hover = hover;
  }
  drawChart();
}

function clearChartHover(kind = "main") {
  if (kind === "tick") {
    state.tickHover = null;
  } else {
    state.hover = null;
  }
  drawChart();
}

function handleChartContextMenu(event, kind = "main", canvas = els.chart) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const y = event.clientY - rect.top;
  if (state.position === 0) {
    els.tradeStatus.textContent = "Open a position before setting exit orders.";
    return;
  }
  const orderPrice = priceAtChartY(y, kind);
  if (orderPrice === null) return;
  if (orderPrice === state.lastTick.price) {
    els.tradeStatus.textContent = "Right-click above or below the current price to set TP or SL.";
    return;
  }

  const isTakeProfit = state.position > 0
    ? orderPrice > state.lastTick.price
    : orderPrice < state.lastTick.price;

  if (isTakeProfit) {
    state.takeProfitPrice = orderPrice;
    drawChart();
    els.tradeStatus.textContent = `Take profit set at ${price(orderPrice)}.`;
  } else {
    state.stopLossPrice = orderPrice;
    drawChart();
    els.tradeStatus.textContent = `Stop loss set at ${price(orderPrice)}.`;
  }
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
    realizedDelta = (fillPrice - state.avgPrice) * closing * NQ_DOLLARS_PER_POINT * direction;
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
  return (state.lastTick.price - state.avgPrice) * state.position * NQ_DOLLARS_PER_POINT;
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

async function placeTrade(side, quantityOverride = null) {
  if (!state.lastTick) return;
  const snapshot = {
    position: state.position,
    avgPrice: state.avgPrice,
    realizedPnl: state.realizedPnl,
  };
  const requestedQuantity = quantityOverride ?? Number(els.qtyInput.value);
  const quantity = Math.max(1, Math.floor(requestedQuantity || 1));
  const execution = executeLocal(side, quantity, state.lastTick.price);
  const payload = {
    ...execution,
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
  els.tradeStatus.textContent = `${side} ${quantity} filled at ${price(state.lastTick.price)} and saved.`;
  drawChart();
  setControls();
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

function renderExecutions() {
  els.executions.innerHTML = "";
  for (const ex of state.executions) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${ex.side} ${ex.quantity} @ ${price(ex.fill_price)}</strong><span>${ex.replay_timestamp} | Pos ${ex.position_after} | R ${money(ex.realized_pnl)}</span>`;
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
els.flattenBtn.addEventListener("click", () => flattenPosition().catch(showError));
els.chart.addEventListener("mousemove", handleChartHover);
els.chart.addEventListener("mouseleave", clearChartHover);
els.chart.addEventListener("contextmenu", handleChartContextMenu);
els.chart.addEventListener("wheel", handleChartWheel, { passive: false });
els.tickChart.addEventListener("mousemove", (event) => handleChartHover(event, "tick", els.tickChart));
els.tickChart.addEventListener("mouseleave", () => clearChartHover("tick"));
els.tickChart.addEventListener("contextmenu", (event) => handleChartContextMenu(event, "tick", els.tickChart));
els.tickChart.addEventListener("wheel", handleChartWheel, { passive: false });
window.addEventListener("resize", resizeChart);

loadCoverage().catch(showError);
