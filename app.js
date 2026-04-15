const SYMBOL = "ETHUSDT";
const BASE_URL = "https://fapi.binance.com";
const KLINE_LIMIT = 260;
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;

const SIGNALS = {
  LONG: "LONG",
  SHORT: "SHORT",
  WAIT: "ESPERAR",
  LONG_FORMING: "LONG EN FORMACIÓN",
  SHORT_FORMING: "SHORT EN FORMACIÓN",
  OVERBOUGHT: "SOBRECOMPRA",
  OVERSOLD: "SOBREVENTA"
};

const state = {
  candles: [],
  analysis: null,
  refreshTimer: null
};

const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", () => {
  $("#refreshButton").addEventListener("click", loadMarketData);
  $("#intervalSelect").addEventListener("change", loadMarketData);
  loadMarketData();
  state.refreshTimer = setInterval(loadMarketData, REFRESH_MS);
});

async function loadMarketData() {
  const interval = $("#intervalSelect").value;
  setStatus("Actualizando datos de futuros...");

  try {
    const candles = await fetchKlines(interval);
    if (candles.length < 220) throw new Error("Datos insuficientes");

    state.candles = candles;
    state.analysis = analyzeMarket(candles);
    renderAnalysis(state.analysis, interval);
    drawChart(candles, state.analysis);
  } catch (error) {
    renderError(error);
  }
}

async function fetchKlines(interval) {
  const params = new URLSearchParams({
    symbol: SYMBOL,
    interval,
    limit: String(KLINE_LIMIT)
  });

  const data = await fetchJson(`${BASE_URL}/fapi/v1/klines?${params}`);

  return data.map((item) => ({
    openTime: item[0],
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5]),
    closeTime: item[6]
  }));
}

function analyzeMarket(candles) {
  // Se descarta la vela actual porque puede estar incompleta y dar falsas entradas.
  const closedCandles = candles.slice(0, -1);
  const closes = closedCandles.map((candle) => candle.close);
  const volumes = closedCandles.map((candle) => candle.volume);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const index = closedCandles.length - 1;
  const last = closedCandles[index];
  const previous = closedCandles[index - 1];
  const price = last.close;
  const currentVolume = last.volume;
  const avgVolume = average(volumes.slice(-20));
  const volumeOk = currentVolume >= avgVolume;
  const ema21Value = ema21[index];
  const ema50Value = ema50[index];
  const ema200Value = ema200[index];
  const emaStackLong = ema21Value > ema50Value && ema50Value > ema200Value;
  const emaStackShort = ema21Value < ema50Value && ema50Value < ema200Value;
  const priceAboveAll = price > ema21Value && price > ema50Value && price > ema200Value;
  const priceBelowAll = price < ema21Value && price < ema50Value && price < ema200Value;
  const emaMixed = !emaStackLong && !emaStackShort;
  const rsiValue = rsi14[index];
  const atrValue = atr(closedCandles.slice(-15));
  const recentHigh = Math.max(...closedCandles.slice(-12).map((candle) => candle.high));
  const recentLow = Math.min(...closedCandles.slice(-12).map((candle) => candle.low));
  const distanceFromEma21 = Math.abs(price - ema21Value) / price;
  const distanceFromEma50 = Math.abs(price - ema50Value) / price;
  const lateral = emaMixed || distanceFromEma50 < 0.0025 || Math.abs(ema21Value - ema50Value) / price < 0.0018;
  const bounceConfirmed = isBounceConfirmed(last, previous, ema21Value, ema50Value, "long");
  const rejectionConfirmed = isBounceConfirmed(last, previous, ema21Value, ema50Value, "short");
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
  const lateEntry = distanceFromEma21 > 0.0085 && (priceAboveAll || priceBelowAll);
  const falseBreakoutRisk = (priceAboveAll || priceBelowAll) && !volumeOk;

  // Score LONG: máximo 8 puntos según EMA, RSI, volumen y rebote.
  let longScore = 0;
  longScore += Number(price > ema21Value);
  longScore += Number(price > ema50Value);
  longScore += Number(price > ema200Value);
  longScore += Number(ema21Value > ema50Value);
  longScore += Number(ema50Value > ema200Value);
  longScore += Number(rsiValue >= 52 && rsiValue <= 68);
  longScore += Number(volumeOk);
  longScore += Number(bounceConfirmed);

  // Score SHORT: máximo 8 puntos según EMA, RSI, volumen y rechazo.
  let shortScore = 0;
  shortScore += Number(price < ema21Value);
  shortScore += Number(price < ema50Value);
  shortScore += Number(price < ema200Value);
  shortScore += Number(ema21Value < ema50Value);
  shortScore += Number(ema50Value < ema200Value);
  shortScore += Number(rsiValue >= 32 && rsiValue <= 48);
  shortScore += Number(volumeOk);
  shortScore += Number(rejectionConfirmed);

  const trend = getTrend({ emaStackLong, emaStackShort, priceAboveAll, priceBelowAll, lateral });
  const scoreDiff = Math.abs(longScore - shortScore);
  const closeScores = scoreDiff <= 3;
  const risk = getRisk({ lateral, volumeOk, rsiValue, longScore, shortScore, atrValue, price });
  const strength = getStrength(longScore, shortScore, volumeOk, lateral);
  const decision = decideSignal({
    longScore,
    shortScore,
    emaMixed,
    lateral,
    volumeOk,
    rsiValue,
    trend,
    bounceConfirmed,
    rejectionConfirmed,
    closeScores,
    lateEntry
  });

  const observations = buildObservations({
    decision,
    longScore,
    shortScore,
    emaMixed,
    lateral,
    volumeOk,
    volumeRatio,
    rsiValue,
    bounceConfirmed,
    rejectionConfirmed,
    closeScores,
    lateEntry,
    falseBreakoutRisk
  });

  const why = buildWhy({
    decision,
    price,
    ema21: ema21Value,
    ema50: ema50Value,
    ema200: ema200Value,
    rsiValue,
    currentVolume,
    avgVolume,
    volumeRatio,
    volumeOk,
    trend,
    longScore,
    shortScore,
    emaMixed,
    lateral,
    closeScores,
    lateEntry,
    falseBreakoutRisk
  });
  const mainReason = buildMainReason({
    decision,
    emaMixed,
    lateral,
    volumeOk,
    closeScores,
    lateEntry,
    falseBreakoutRisk,
    rsiValue,
    bounceConfirmed,
    rejectionConfirmed
  });
  const operation = buildOperationPlan({
    decision,
    price,
    last,
    ema21Value,
    ema50Value,
    recentHigh,
    recentLow,
    atrValue,
    trend,
    volumeOk,
    bounceConfirmed,
    rejectionConfirmed
  });

  return {
    last,
    price,
    ema21,
    ema50,
    ema200,
    rsi14,
    ema21Value,
    ema50Value,
    ema200Value,
    rsiValue,
    currentVolume,
    avgVolume,
    volumeOk,
    atrValue,
    recentHigh,
    recentLow,
    trend,
    risk,
    strength,
    longScore,
    shortScore,
    scoreDiff,
    closeScores,
    lateEntry,
    falseBreakoutRisk,
    decision,
    observations,
    why,
    mainReason,
    operation,
    analyzedIndex: index
  };
}

function decideSignal(context) {
  const {
    longScore,
    shortScore,
    emaMixed,
    lateral,
    volumeOk,
    rsiValue,
    trend,
    bounceConfirmed,
    rejectionConfirmed,
    closeScores,
    lateEntry
  } = context;

  // Sobrecompra/sobreventa son alertas de riesgo, no entradas automáticas.
  if (rsiValue > 70) return { label: SIGNALS.OVERBOUGHT, confidence: "BAJA" };
  if (rsiValue < 30) return { label: SIGNALS.OVERSOLD, confidence: "BAJA" };

  const confusing = closeScores || emaMixed || lateral || !volumeOk || lateEntry;
  const longRsiOk = rsiValue >= 52 && rsiValue <= 68;
  const shortRsiOk = rsiValue >= 32 && rsiValue <= 48;
  const longAllowed = trend === "ALCISTA" && !confusing && bounceConfirmed && longRsiOk;
  const shortAllowed = trend === "BAJISTA" && !confusing && rejectionConfirmed && shortRsiOk;

  // Señales reales solo salen si puntaje, tendencia, RSI, volumen y confirmación coinciden.
  if (longScore >= 7 && shortScore <= 2 && longAllowed) {
    return { label: SIGNALS.LONG, confidence: "ALTA" };
  }

  if (shortScore >= 7 && longScore <= 2 && shortAllowed) {
    return { label: SIGNALS.SHORT, confidence: "ALTA" };
  }

  if (longScore >= 5 && longScore <= 6 && !closeScores && longScore - shortScore >= 4 && trend === "ALCISTA" && volumeOk && !emaMixed && rsiValue > 50) {
    return { label: SIGNALS.LONG_FORMING, confidence: "MEDIA" };
  }

  if (shortScore >= 5 && shortScore <= 6 && !closeScores && shortScore - longScore >= 4 && trend === "BAJISTA" && volumeOk && !emaMixed && rsiValue < 50) {
    return { label: SIGNALS.SHORT_FORMING, confidence: "MEDIA" };
  }

  return { label: SIGNALS.WAIT, confidence: confusing ? "BAJA" : "MEDIA" };
}

function getTrend(context) {
  if (context.lateral) return "LATERAL";
  if (context.emaStackLong && context.priceAboveAll) return "ALCISTA";
  if (context.emaStackShort && context.priceBelowAll) return "BAJISTA";
  return "LATERAL";
}

function getStrength(longScore, shortScore, volumeOk, lateral) {
  const bestScore = Math.max(longScore, shortScore);
  if (lateral || !volumeOk) return "DÉBIL";
  if (bestScore >= 7) return "FUERTE";
  if (bestScore >= 5) return "MEDIA";
  return "DÉBIL";
}

function getRisk(context) {
  const atrPercent = context.atrValue / context.price;
  if (context.lateral || !context.volumeOk) return "ALTO";
  if (context.rsiValue > 68 || context.rsiValue < 32 || atrPercent > 0.018) return "ALTO";
  if (Math.max(context.longScore, context.shortScore) >= 7) return "MEDIO";
  return "MEDIO";
}

function buildWhy(context) {
  const emaText = [
    `Precio ${formatPrice(context.price)}`,
    `${comparePrice(context.price, context.ema21)} EMA 21 ${formatPrice(context.ema21)}`,
    `${comparePrice(context.price, context.ema50)} EMA 50 ${formatPrice(context.ema50)}`,
    `${comparePrice(context.price, context.ema200)} EMA 200 ${formatPrice(context.ema200)}`
  ].join("; ");
  const rsiText = `RSI 14 en ${formatNumber(context.rsiValue, 1)}`;
  const volumeText = `volumen actual ${formatCompact(context.currentVolume)} vs promedio ${formatCompact(context.avgVolume)} (${context.volumeRatio >= 1 ? "arriba" : "abajo"} del promedio)`;
  const structureText = context.lateral
    ? "hay lateralidad o poca separación entre EMA"
    : `la tendencia se lee ${context.trend.toLowerCase()}`;
  const scoreText = `score LONG ${context.longScore} contra SHORT ${context.shortScore}`;
  const cautionText = [
    context.closeScores ? "scores muy parejos" : "",
    context.lateEntry ? "precio alejado de EMA 21: posible entrada tardía" : "",
    context.falseBreakoutRisk ? "ruptura sin volumen suficiente" : ""
  ].filter(Boolean).join("; ");
  const cautionSentence = cautionText ? ` Señal de prudencia: ${cautionText}.` : "";

  if (context.decision.label === SIGNALS.LONG) {
    return `LONG porque ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.SHORT) {
    return `SHORT porque ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.LONG_FORMING) {
    return `LONG en formación: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. Falta confirmación completa. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.SHORT_FORMING) {
    return `SHORT en formación: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. Falta confirmación completa. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.OVERBOUGHT) {
    return `SOBRECOMPRA porque ${rsiText}, supera 70. ${emaText}; ${volumeText}. No es venta directa: conviene esperar rechazo, pérdida de EMA o confirmación de volumen.`;
  }

  if (context.decision.label === SIGNALS.OVERSOLD) {
    return `SOBREVENTA porque ${rsiText}, está debajo de 30. ${emaText}; ${volumeText}. No es compra directa: conviene esperar rebote confirmado y recuperación de EMA.`;
  }

  return `ESPERAR. ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. La lectura no es suficientemente limpia. ${scoreText}.${cautionSentence}`;
}

function buildMainReason(context) {
  if (context.decision.label === SIGNALS.LONG) {
    return "Motivo principal: EMA alineadas + RSI alcista + volumen suficiente + rebote confirmado.";
  }

  if (context.decision.label === SIGNALS.SHORT) {
    return "Motivo principal: EMA alineadas bajistas + RSI bajista + volumen suficiente + rechazo confirmado.";
  }

  if (context.decision.label === SIGNALS.LONG_FORMING) {
    return "Motivo principal: estructura alcista parcial, pero falta confirmación para LONG.";
  }

  if (context.decision.label === SIGNALS.SHORT_FORMING) {
    return "Motivo principal: estructura bajista parcial, pero falta confirmación para SHORT.";
  }

  if (context.decision.label === SIGNALS.OVERBOUGHT) {
    return "Motivo principal: RSI mayor a 70; zona de sobrecompra, no venta directa.";
  }

  if (context.decision.label === SIGNALS.OVERSOLD) {
    return "Motivo principal: RSI menor a 30; zona de sobreventa, no compra directa.";
  }

  if (context.closeScores) return "Motivo principal: scores muy parejos y señales contradictorias.";
  if (context.emaMixed || context.lateral) return "Motivo principal: mercado lateral o EMA mezcladas.";
  if (!context.volumeOk) return "Motivo principal: falta volumen para validar la señal.";
  if (context.lateEntry) return "Motivo principal: posible entrada tardía, precio alejado de EMA 21.";
  if (context.falseBreakoutRisk) return "Motivo principal: riesgo de falsa ruptura por volumen débil.";
  return "Motivo principal: falta una estructura suficientemente limpia.";
}

function buildObservations(context) {
  const messages = [];

  if (context.emaMixed) messages.push("EMA mezcladas: evitar entrada.");
  if (context.lateral) messages.push("Mercado lateral.");
  if (!context.volumeOk) messages.push(`Falta volumen: ${formatPercent(context.volumeRatio)} del promedio.`);
  if (context.closeScores) messages.push("Scores muy parejos: forzar ESPERAR.");
  if (context.lateEntry) messages.push("Entrada tardía: precio demasiado alejado de EMA 21.");
  if (context.falseBreakoutRisk) messages.push("Riesgo de falsa ruptura: movimiento sin volumen.");
  if (context.rsiValue > 70) messages.push("RSI en sobrecompra: no vender sin confirmación.");
  if (context.rsiValue < 30) messages.push("RSI en sobreventa: no comprar sin confirmación.");
  if (context.longScore >= 5 && !context.bounceConfirmed) messages.push("Esperar cierre más claro para LONG.");
  if (context.shortScore >= 5 && !context.rejectionConfirmed) messages.push("Esperar cierre más claro para SHORT.");

  if (!messages.length) messages.push("Lectura limpia, pero mantener gestión de riesgo.");
  if (context.decision.label === SIGNALS.WAIT) messages.unshift("Esperar es la señal principal.");

  return [...new Set(messages)].slice(0, 6);
}

function buildOperationPlan(context) {
  const buffer = Math.max(context.atrValue * 0.18, context.price * 0.0012);

  if (context.decision.label === SIGNALS.LONG) {
    const entry = context.price;
    const slBase = Math.min(context.ema50Value, context.recentLow);
    const sl = slBase - buffer;
    const risk = entry - sl;
    const tp = entry + risk * 1.45;

    return {
      mode: "confirmed",
      type: "Confirmada",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "long"),
      note: "Entrada LONG solo porque la señal ya está confirmada. El SL queda debajo de EMA 50/swing reciente: si pierde esa zona, la estructura alcista se invalida. TP prudente cerca de 1,45R."
    };
  }

  if (context.decision.label === SIGNALS.SHORT) {
    const entry = context.price;
    const slBase = Math.max(context.ema50Value, context.recentHigh);
    const sl = slBase + buffer;
    const risk = sl - entry;
    const tp = entry - risk * 1.45;

    return {
      mode: "confirmed",
      type: "Confirmada",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "short"),
      note: "Entrada SHORT solo porque la señal ya está confirmada. El SL queda arriba de EMA 50/swing reciente: si recupera esa zona, la estructura bajista se invalida. TP prudente cerca de 1,45R."
    };
  }

  if (context.decision.label === SIGNALS.LONG_FORMING) {
    const entry = Math.max(context.ema21Value, Math.min(context.price, context.ema21Value + context.atrValue * 0.25));
    const sl = Math.min(context.ema50Value, context.recentLow) - buffer;
    const risk = entry - sl;
    const tp = entry + risk * 1.25;

    return {
      mode: "tentative",
      type: "Tentativa",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "long"),
      note: "Todavía no entrar. Entrada tentativa tipo límite cerca de EMA 21 solo si aparece cierre claro, rebote y volumen. El SL invalida la idea si pierde EMA 50/swing reciente."
    };
  }

  if (context.decision.label === SIGNALS.SHORT_FORMING) {
    const entry = Math.min(context.ema21Value, Math.max(context.price, context.ema21Value - context.atrValue * 0.25));
    const sl = Math.max(context.ema50Value, context.recentHigh) + buffer;
    const risk = sl - entry;
    const tp = entry - risk * 1.25;

    return {
      mode: "tentative",
      type: "Tentativa",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "short"),
      note: "Todavía no entrar. Entrada tentativa tipo límite cerca de EMA 21 solo si aparece cierre claro, rechazo y volumen. El SL invalida la idea si recupera EMA 50/swing reciente."
    };
  }

  const watchAbove = Math.max(context.recentHigh, context.ema21Value, context.ema50Value) + buffer;
  const watchBelow = Math.min(context.recentLow, context.ema21Value, context.ema50Value) - buffer;
  const reason = context.decision.label === SIGNALS.OVERBOUGHT || context.decision.label === SIGNALS.OVERSOLD
    ? "RSI extremo: no operar directo; esperar normalización y confirmación."
    : "Sin estructura limpia: no hay entrada operativa.";

  return {
    mode: "watch",
    type: "Sin operación",
    entry: null,
    sl: null,
    tp: null,
    rr: null,
    watchAbove,
    watchBelow,
    note: `${reason} Vigilar ruptura arriba de ${formatPrice(watchAbove)} o pérdida debajo de ${formatPrice(watchBelow)}, siempre con cierre claro y volumen.`
  };
}

function calculateRiskReward(entry, sl, tp, side) {
  const risk = side === "long" ? entry - sl : sl - entry;
  const reward = side === "long" ? tp - entry : entry - tp;

  if (risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function isBounceConfirmed(last, previous, ema21, ema50, side) {
  const body = Math.abs(last.close - last.open);
  const candleRange = Math.max(last.high - last.low, 0.0001);
  const bodyRatio = body / candleRange;

  if (side === "long") {
    const touchedZone = last.low <= ema21 || last.low <= ema50 || previous.low <= ema21;
    const closedStrong = last.close > last.open && last.close > ema21 && bodyRatio >= 0.35;
    return touchedZone && closedStrong;
  }

  const touchedZone = last.high >= ema21 || last.high >= ema50 || previous.high >= ema21;
  const closedStrong = last.close < last.open && last.close < ema21 && bodyRatio >= 0.35;
  return touchedZone && closedStrong;
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const result = [];
  let previous = values[0];

  values.forEach((value, index) => {
    if (index === 0) {
      previous = value;
    } else {
      previous = value * multiplier + previous * (1 - multiplier);
    }

    result.push(previous);
  });

  return result;
}

function rsi(values, period) {
  const result = Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = calculateRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = calculateRsi(avgGain, avgLoss);
  }

  return result;
}

function calculateRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles) {
  const ranges = candles.slice(1).map((candle, index) => {
    const previous = candles[index];
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    );
  });

  return average(ranges);
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function renderAnalysis(analysis, interval) {
  const signalClass = getSignalClass(analysis.decision.label);
  const signalCard = $("#signalCard");
  const updatedAt = new Date();
  signalCard.className = `signal-card ${signalClass}`;

  setText("#signalTitle", analysis.decision.label);
  setText("#signalSubtitle", `Análisis conservador en ${interval}. Última vela cerrada.`);
  setText("#finalSignalValue", analysis.decision.label);
  setText("#confidenceValue", analysis.decision.confidence);
  setText("#trendValue", analysis.trend);
  setText("#scoreValue", `LONG ${analysis.longScore} / SHORT ${analysis.shortScore}`);
  setText("#longScoreValue", `${analysis.longScore}/8`);
  setText("#shortScoreValue", `${analysis.shortScore}/8`);
  setText("#timeframeValue", interval);
  setText("#mainUpdatedAt", formatDateTime(updatedAt));
  updateScoreBar(analysis.longScore, analysis.shortScore);

  setText("#mainReasonText", analysis.mainReason);
  setText("#whyText", analysis.why);
  setText("#priceValue", formatPrice(analysis.price));
  setText("#ema21Value", formatPrice(analysis.ema21Value));
  setText("#ema50Value", formatPrice(analysis.ema50Value));
  setText("#ema200Value", formatPrice(analysis.ema200Value));
  setText("#rsiValue", formatNumber(analysis.rsiValue, 1));
  setText("#volumeValue", formatCompact(analysis.currentVolume));
  setText("#avgVolumeValue", formatCompact(analysis.avgVolume));
  setText("#marketTrend", analysis.trend);
  setText("#marketStrength", analysis.strength);
  setText("#marketRisk", analysis.risk);
  setText("#updatedAt", `Actualizado ${formatDateTime(updatedAt)}`);
  setStatus("Datos reales de Binance USD-M Futures. No es recomendación financiera.");
  renderObservations(analysis.observations);
  renderOperation(analysis.operation);
  hideSplash();
}

function renderObservations(observations) {
  const list = $("#observationsList");
  list.innerHTML = "";

  observations.forEach((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    list.append(item);
  });
}

function renderOperation(operation) {
  const note = $("#operationNote");
  note.className = `operation-note ${operation.mode}`;
  setText("#operationType", operation.type);

  if (operation.mode === "watch") {
    setText("#operationEntry", "No sugerida");
    setText("#operationSl", "--");
    setText("#operationTp", "--");
    setText("#operationRr", "--");
  } else {
    setText("#operationEntry", formatPrice(operation.entry));
    setText("#operationSl", formatPrice(operation.sl));
    setText("#operationTp", formatPrice(operation.tp));
    setText("#operationRr", operation.rr ? `1:${formatNumber(operation.rr, 2)}` : "--");
  }

  note.textContent = operation.note;
}

function updateScoreBar(longScore, shortScore) {
  const total = longScore + shortScore;
  const longWidth = total > 0 ? longScore / total * 100 : 50;
  const shortWidth = total > 0 ? shortScore / total * 100 : 50;

  $("#longScoreBar").style.width = `${longWidth}%`;
  $("#shortScoreBar").style.width = `${shortWidth}%`;
}

function renderError(error) {
  const signalCard = $("#signalCard");
  signalCard.className = "signal-card signal-wait";
  setText("#signalTitle", SIGNALS.WAIT);
  setText("#signalSubtitle", "No se pudo actualizar. Mejor esperar.");
  setText("#finalSignalValue", SIGNALS.WAIT);
  setText("#confidenceValue", "BAJA");
  setText("#trendValue", "--");
  setText("#scoreValue", "LONG -- / SHORT --");
  setText("#longScoreValue", "--");
  setText("#shortScoreValue", "--");
  setText("#timeframeValue", $("#intervalSelect").value);
  setText("#mainUpdatedAt", "--");
  updateScoreBar(0, 0);
  setText("#mainReasonText", "Motivo principal: no hay datos actualizados.");
  setText("#whyText", "ESPERAR porque no hay datos actualizados suficientes para analizar con prudencia.");
  renderOperation({
    mode: "watch",
    type: "Sin operación",
    entry: null,
    sl: null,
    tp: null,
    rr: null,
    note: "No hay datos actualizados. No sugerir operación hasta recuperar conexión y confirmar estructura."
  });
  renderObservations(["Error de datos o conexión.", "No tomar entrada sin actualización.", error.message || "Intentar nuevamente."]);
  setStatus("No se pudo cargar Binance Futures. La app queda en ESPERAR.");
  hideSplash();
}

function getSignalClass(label) {
  if (label === SIGNALS.LONG) return "signal-long";
  if (label === SIGNALS.SHORT) return "signal-short";
  if (label === SIGNALS.LONG_FORMING || label === SIGNALS.SHORT_FORMING) return "signal-forming";
  if (label === SIGNALS.OVERBOUGHT) return "signal-overbought";
  if (label === SIGNALS.OVERSOLD) return "signal-oversold";
  return "signal-wait";
}

function drawChart(candles, analysis) {
  // Mini gráfico propio en canvas para evitar dependencias externas.
  const canvas = $("#priceChart");
  const ctx = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  canvas.width = Math.floor(cssWidth * pixelRatio);
  canvas.height = Math.floor(cssHeight * pixelRatio);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const visibleCandles = candles.slice(-70, -1);
  const offset = candles.length - 1 - visibleCandles.length;
  const ema21 = analysis.ema21.slice(offset, offset + visibleCandles.length);
  const ema50 = analysis.ema50.slice(offset, offset + visibleCandles.length);
  const ema200 = analysis.ema200.slice(offset, offset + visibleCandles.length);
  const allPrices = visibleCandles.flatMap((candle, index) => [
    candle.high,
    candle.low,
    ema21[index],
    ema50[index],
    ema200[index]
  ]).filter((value) => Number.isFinite(value));

  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const padding = 18;
  const chartHeight = cssHeight - padding * 2;
  const chartWidth = cssWidth - padding * 2;
  const step = chartWidth / visibleCandles.length;
  const candleWidth = Math.max(3, Math.min(8, step * 0.55));
  const y = (price) => padding + (max - price) / (max - min || 1) * chartHeight;
  const x = (index) => padding + index * step + step / 2;

  drawGrid(ctx, cssWidth, cssHeight, padding);

  visibleCandles.forEach((candle, index) => {
    const isUp = candle.close >= candle.open;
    const color = isUp ? "#36d27a" : "#ff5f68";
    const xPos = x(index);
    const openY = y(candle.open);
    const closeY = y(candle.close);
    const highY = y(candle.high);
    const lowY = y(candle.low);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xPos, highY);
    ctx.lineTo(xPos, lowY);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.fillRect(
      xPos - candleWidth / 2,
      Math.min(openY, closeY),
      candleWidth,
      Math.max(2, Math.abs(closeY - openY))
    );
  });

  drawLine(ctx, ema21, x, y, "#6bd3ff");
  drawLine(ctx, ema50, x, y, "#f0c75d");
  drawLine(ctx, ema200, x, y, "#9f8cff");
}

function drawGrid(ctx, width, height, padding) {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
  ctx.lineWidth = 1;

  for (let i = 1; i <= 4; i += 1) {
    const y = padding + (height - padding * 2) * (i / 5);
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }
}

function drawLine(ctx, values, x, y, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (index === 0) ctx.moveTo(x(index), y(value));
    else ctx.lineTo(x(index), y(value));
  });

  ctx.stroke();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function setStatus(message) {
  setText("#statusText", message);
}

function hideSplash() {
  $("#splashScreen")?.classList.add("hidden");
}

function setText(selector, value) {
  $(selector).textContent = value;
}

function comparePrice(price, reference) {
  return price >= reference ? "arriba de" : "debajo de";
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatNumber(value, digits) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("es-AR", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    maximumFractionDigits: 0
  }).format(value);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}
