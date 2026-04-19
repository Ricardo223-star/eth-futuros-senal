const SYMBOL = "ETHUSDT";
const BASE_URL = "https://fapi.binance.com";
const KLINE_LIMIT = 260;
const REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;

const SIGNALS = {
  WAIT: "ESPERAR",
  OPERABLE_LONG: "OPERABLE LONG",
  OPERABLE_SHORT: "OPERABLE SHORT",
  LONG_NOW: "LONG YA",
  SHORT_NOW: "SHORT YA",
  OVERBOUGHT_EXTREME: "SOBRECOMPRA EXTREMA",
  OVERSOLD_EXTREME: "SOBREVENTA EXTREMA"
};

const THRESHOLDS = {
  volumePoor: 0.55,
  volumeAcceptable: 0.72,
  volumeGood: 0.95,
  lateDistanceMin: 0.009,
  extremeDistanceMin: 0.012,
  emaSpreadMin: 0.0016
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
  const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
  const volumePoor = volumeRatio < THRESHOLDS.volumePoor;
  const volumeAcceptable = volumeRatio >= THRESHOLDS.volumeAcceptable;
  const volumeOk = volumeRatio >= THRESHOLDS.volumeGood;
  const ema21Value = ema21[index];
  const ema50Value = ema50[index];
  const ema200Value = ema200[index];
  const emaStackLong = ema21Value > ema50Value && ema50Value > ema200Value;
  const emaStackShort = ema21Value < ema50Value && ema50Value < ema200Value;
  const priceAboveAll = price > ema21Value && price > ema50Value && price > ema200Value;
  const priceBelowAll = price < ema21Value && price < ema50Value && price < ema200Value;
  const rsiValue = rsi14[index];
  const atrValue = atr(closedCandles.slice(-15));
  const previousRange = closedCandles.slice(-13, -1);
  const recentHigh = Math.max(...closedCandles.slice(-12).map((candle) => candle.high));
  const recentLow = Math.min(...closedCandles.slice(-12).map((candle) => candle.low));
  const previousRecentHigh = Math.max(...previousRange.map((candle) => candle.high));
  const previousRecentLow = Math.min(...previousRange.map((candle) => candle.low));
  const distanceFromEma21 = Math.abs(price - ema21Value) / price;
  const distanceFromEma50 = Math.abs(price - ema50Value) / price;
  const atrPercent = atrValue / price;
  const emaSpread = Math.abs(ema21Value - ema50Value) / price;
  const priceBetweenEma21And50 = isBetween(price, ema21Value, ema50Value);
  const emaUsefulLong = price > ema21Value && price > ema50Value && (ema21Value > ema50Value || ema21Value > ema200Value);
  const emaUsefulShort = price < ema21Value && price < ema50Value && (ema21Value < ema50Value || ema21Value < ema200Value);
  const emaMixed = !emaUsefulLong && !emaUsefulShort;
  const lateral = (priceBetweenEma21And50 && emaSpread < 0.0032) || (!emaUsefulLong && !emaUsefulShort && distanceFromEma50 < 0.003);
  const bounceConfirmed = isBounceConfirmed(last, previous, ema21Value, ema50Value, "long");
  const rejectionConfirmed = isBounceConfirmed(last, previous, ema21Value, ema50Value, "short");
  const bodyRatio = candleBodyRatio(last);
  const clearLongContinuation = last.close > previousRecentHigh || (last.close > last.open && bodyRatio >= 0.34 && price > ema21Value);
  const clearShortContinuation = last.close < previousRecentLow || (last.close < last.open && bodyRatio >= 0.34 && price < ema21Value);
  // Extensión objetiva: se compara distancia a EMA 21 contra un mínimo fijo y contra ATR.
  const lateDistance = Math.max(THRESHOLDS.lateDistanceMin, atrPercent * 1.05);
  const extremeDistance = Math.max(THRESHOLDS.extremeDistanceMin, atrPercent * 1.35);
  const lateEntry = distanceFromEma21 > lateDistance && (priceAboveAll || priceBelowAll);
  const extremeExtension = distanceFromEma21 > extremeDistance;
  const falseBreakoutRisk = (last.close > previousRecentHigh || last.close < previousRecentLow) && !volumeAcceptable;
  const longBias = emaUsefulLong && rsiValue >= 48 && rsiValue <= 71;
  const shortBias = emaUsefulShort && rsiValue >= 29 && rsiValue <= 52;

  // Score LONG: máximo 8 puntos según EMA, RSI, volumen y rebote.
  let longScore = 0;
  longScore += Number(price > ema21Value);
  longScore += Number(price > ema50Value);
  longScore += Number(price > ema200Value);
  longScore += Number(ema21Value > ema50Value);
  longScore += Number(ema50Value > ema200Value);
  longScore += Number(rsiValue >= 50 && rsiValue <= 68);
  longScore += Number(volumeAcceptable);
  longScore += Number(bounceConfirmed || clearLongContinuation);

  // Score SHORT: máximo 8 puntos según EMA, RSI, volumen y rechazo.
  let shortScore = 0;
  shortScore += Number(price < ema21Value);
  shortScore += Number(price < ema50Value);
  shortScore += Number(price < ema200Value);
  shortScore += Number(ema21Value < ema50Value);
  shortScore += Number(ema50Value < ema200Value);
  shortScore += Number(rsiValue >= 32 && rsiValue <= 50);
  shortScore += Number(volumeAcceptable);
  shortScore += Number(rejectionConfirmed || clearShortContinuation);

  const trend = getTrend({ emaStackLong, emaStackShort, emaUsefulLong, emaUsefulShort, priceAboveAll, priceBelowAll, lateral });
  const scoreDiff = Math.abs(longScore - shortScore);
  const closeScores = scoreDiff <= 1;
  const balancedScores = scoreDiff <= 2;
  const risk = getRisk({ lateral, volumePoor, lateEntry, rsiValue, longScore, shortScore, atrValue, price });
  const strength = getStrength(longScore, shortScore, volumeAcceptable, lateral);
  const decision = decideSignal({
    longScore,
    shortScore,
    emaMixed,
    lateral,
    volumePoor,
    volumeAcceptable,
    volumeOk,
    rsiValue,
    trend,
    priceBetweenEma21And50,
    emaStackLong,
    emaStackShort,
    priceAboveAll,
    priceBelowAll,
    emaUsefulLong,
    emaUsefulShort,
    longBias,
    shortBias,
    bounceConfirmed,
    rejectionConfirmed,
    clearLongContinuation,
    clearShortContinuation,
    closeScores,
    balancedScores,
    lateEntry,
    extremeExtension
  });

  const observations = buildObservations({
    decision,
    longScore,
    shortScore,
    emaMixed,
    lateral,
    volumePoor,
    volumeAcceptable,
    volumeOk,
    volumeRatio,
    rsiValue,
    priceBetweenEma21And50,
    bounceConfirmed,
    rejectionConfirmed,
    clearLongContinuation,
    clearShortContinuation,
    closeScores,
    balancedScores,
    lateEntry,
    falseBreakoutRisk,
    longBias,
    shortBias
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
    volumePoor,
    volumeAcceptable,
    priceBetweenEma21And50,
    closeScores,
    balancedScores,
    lateEntry,
    falseBreakoutRisk,
    longBias,
    shortBias
  });
  const mainReason = buildMainReason({
    decision,
    emaMixed,
    lateral,
    volumePoor,
    volumeAcceptable,
    volumeOk,
    closeScores,
    balancedScores,
    lateEntry,
    falseBreakoutRisk,
    rsiValue,
    priceBetweenEma21And50,
    longBias,
    shortBias,
    bounceConfirmed,
    rejectionConfirmed,
    clearLongContinuation,
    clearShortContinuation
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
    volumeAcceptable,
    volumeOk,
    bounceConfirmed,
    rejectionConfirmed,
    clearLongContinuation,
    clearShortContinuation
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
    volumeAcceptable,
    volumePoor,
    volumeRatio,
    atrValue,
    recentHigh,
    recentLow,
    distanceFromEma21,
    priceBetweenEma21And50,
    emaUsefulLong,
    emaUsefulShort,
    longBias,
    shortBias,
    clearLongContinuation,
    clearShortContinuation,
    trend,
    risk,
    strength,
    longScore,
    shortScore,
    scoreDiff,
    closeScores,
    balancedScores,
    lateEntry,
    extremeExtension,
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
    volumePoor,
    volumeAcceptable,
    volumeOk,
    rsiValue,
    trend,
    priceBetweenEma21And50,
    emaStackLong,
    emaStackShort,
    priceAboveAll,
    priceBelowAll,
    emaUsefulLong,
    emaUsefulShort,
    longBias,
    shortBias,
    bounceConfirmed,
    rejectionConfirmed,
    clearLongContinuation,
    clearShortContinuation,
    closeScores,
    balancedScores,
    lateEntry,
    extremeExtension
  } = context;

  // Solo bloquea por RSI cuando además el precio está objetivamente extendido de EMA 21.
  if (rsiValue > 72 && extremeExtension) {
    return { label: SIGNALS.OVERBOUGHT_EXTREME, confidence: "BAJA", side: "NONE" };
  }

  if (rsiValue < 28 && extremeExtension) {
    return { label: SIGNALS.OVERSOLD_EXTREME, confidence: "BAJA", side: "NONE" };
  }

  const noTradeZone = closeScores || volumePoor || lateEntry || (priceBetweenEma21And50 && !longBias && !shortBias);
  const strongLongStructure = priceAboveAll && emaStackLong;
  const strongShortStructure = priceBelowAll && emaStackShort;
  const cleanLong = strongLongStructure && rsiValue >= 50 && rsiValue <= 68 && volumeOk && clearLongContinuation && !lateEntry;
  const cleanShort = strongShortStructure && rsiValue >= 32 && rsiValue <= 50 && volumeOk && clearShortContinuation && !lateEntry;

  if (cleanLong && longScore >= 6 && longScore - shortScore >= 3) {
    return { label: SIGNALS.LONG_NOW, confidence: "ALTA", side: "LONG" };
  }

  if (cleanShort && shortScore >= 6 && shortScore - longScore >= 3) {
    return { label: SIGNALS.SHORT_NOW, confidence: "ALTA", side: "SHORT" };
  }

  const operableLong = emaUsefulLong
    && longBias
    && volumeAcceptable
    && !noTradeZone
    && !lateral
    && !emaMixed
    && longScore >= 5
    && longScore > shortScore
    && (clearLongContinuation || bounceConfirmed || trend === "ALCISTA");

  if (operableLong) {
    return { label: SIGNALS.OPERABLE_LONG, confidence: balancedScores ? "BAJA" : "MEDIA", side: "LONG" };
  }

  const operableShort = emaUsefulShort
    && shortBias
    && volumeAcceptable
    && !noTradeZone
    && !lateral
    && !emaMixed
    && shortScore >= 5
    && shortScore > longScore
    && (clearShortContinuation || rejectionConfirmed || trend === "BAJISTA");

  if (operableShort) {
    return { label: SIGNALS.OPERABLE_SHORT, confidence: balancedScores ? "BAJA" : "MEDIA", side: "SHORT" };
  }

  return { label: SIGNALS.WAIT, confidence: noTradeZone || lateral || emaMixed ? "BAJA" : "MEDIA", side: "NONE" };
}

function getTrend(context) {
  if (context.lateral) return "LATERAL";
  if (context.emaStackLong && context.priceAboveAll) return "ALCISTA";
  if (context.emaStackShort && context.priceBelowAll) return "BAJISTA";
  if (context.emaUsefulLong) return "ALCISTA";
  if (context.emaUsefulShort) return "BAJISTA";
  return "LATERAL";
}

function getStrength(longScore, shortScore, volumeAcceptable, lateral) {
  const bestScore = Math.max(longScore, shortScore);
  if (lateral || !volumeAcceptable) return "DÉBIL";
  if (bestScore >= 7) return "FUERTE";
  if (bestScore >= 5) return "MEDIA";
  return "DÉBIL";
}

function getRisk(context) {
  const atrPercent = context.atrValue / context.price;
  if (context.lateral || context.volumePoor || context.lateEntry) return "ALTO";
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
  const volumeState = context.volumeOk ? "bueno" : context.volumeAcceptable ? "aceptable" : context.volumePoor ? "pobre" : "débil";
  const volumeText = `volumen actual ${formatCompact(context.currentVolume)} vs promedio ${formatCompact(context.avgVolume)} (${volumeState}, ${formatPercent(context.volumeRatio)} del promedio)`;
  const structureText = context.longBias
    ? "hay sesgo alcista razonable"
    : context.shortBias
      ? "hay sesgo bajista razonable"
      : context.lateral
    ? "hay lateralidad o poca separación entre EMA"
    : `la tendencia se lee ${context.trend.toLowerCase()}`;
  const scoreText = `score LONG ${context.longScore} contra SHORT ${context.shortScore}`;
  const cautionText = [
    context.closeScores ? "scores casi iguales" : "",
    context.balancedScores && !context.closeScores ? "scores cercanos" : "",
    context.lateEntry ? "precio alejado de EMA 21: posible entrada tardía" : "",
    context.falseBreakoutRisk ? "ruptura sin volumen suficiente" : "",
    context.rsiValue > 70 ? "RSI alto como advertencia" : "",
    context.rsiValue < 30 ? "RSI bajo como advertencia" : ""
  ].filter(Boolean).join("; ");
  const cautionSentence = cautionText ? ` Señal de prudencia: ${cautionText}.` : "";

  if (context.decision.label === SIGNALS.LONG_NOW) {
    return `LONG YA: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. La estructura está limpia y hay continuación/ruptura confirmada. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.SHORT_NOW) {
    return `SHORT YA: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. La estructura está limpia y hay continuación/ruptura confirmada. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.OPERABLE_LONG) {
    return `OPERABLE LONG: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. No está perfecto, pero hay ventaja suficiente para una entrada moderada/agresiva con SL claro. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.OPERABLE_SHORT) {
    return `OPERABLE SHORT: ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. No está perfecto, pero hay ventaja suficiente para una entrada moderada/agresiva con SL claro. ${scoreText}.${cautionSentence}`;
  }

  if (context.decision.label === SIGNALS.OVERBOUGHT_EXTREME) {
    return `SOBRECOMPRA EXTREMA: ${rsiText} y el precio está demasiado alejado de EMA 21. ${emaText}; ${volumeText}. No se opera: esperar enfriamiento o retroceso.`;
  }

  if (context.decision.label === SIGNALS.OVERSOLD_EXTREME) {
    return `SOBREVENTA EXTREMA: ${rsiText} y el precio está demasiado alejado de EMA 21. ${emaText}; ${volumeText}. No se opera: esperar recuperación o rebote confirmado.`;
  }

  const waitReason = context.volumePoor
    ? "el volumen es demasiado pobre"
    : context.priceBetweenEma21And50
      ? "el precio está en zona confusa entre EMA 21 y EMA 50"
      : context.closeScores
        ? "los scores están casi iguales"
        : context.lateEntry
          ? "la entrada llega tarde por distancia a EMA 21"
          : context.lateral && !context.longBias && !context.shortBias
            ? "no hay dirección útil"
            : "la ventaja no alcanza para justificar entrada prudente";

  return `ESPERAR porque ${waitReason}. ${emaText}; ${rsiText}; ${volumeText}; ${structureText}. ${scoreText}.${cautionSentence}`;
}

function buildMainReason(context) {
  if (context.decision.label === SIGNALS.LONG_NOW) {
    return "Motivo principal: estructura alcista limpia + RSI útil + volumen bueno + continuación confirmada.";
  }

  if (context.decision.label === SIGNALS.SHORT_NOW) {
    return "Motivo principal: estructura bajista limpia + RSI útil + volumen bueno + continuación confirmada.";
  }

  if (context.decision.label === SIGNALS.OPERABLE_LONG) {
    return "Motivo principal: sesgo alcista operable, aunque no perfecto.";
  }

  if (context.decision.label === SIGNALS.OPERABLE_SHORT) {
    return "Motivo principal: sesgo bajista operable, aunque no perfecto.";
  }

  if (context.decision.label === SIGNALS.OVERBOUGHT_EXTREME) {
    return "Motivo principal: RSI mayor a 72 y precio demasiado extendido sobre EMA 21.";
  }

  if (context.decision.label === SIGNALS.OVERSOLD_EXTREME) {
    return "Motivo principal: RSI menor a 28 y precio demasiado extendido bajo EMA 21.";
  }

  if (context.volumePoor) return "Motivo principal: volumen demasiado pobre para operar.";
  if (context.priceBetweenEma21And50) return "Motivo principal: precio atrapado entre EMA 21 y EMA 50.";
  if (context.closeScores) return "Motivo principal: scores casi iguales y señales contradictorias.";
  if (context.lateEntry) return "Motivo principal: posible entrada tardía, precio alejado de EMA 21.";
  if (context.falseBreakoutRisk) return "Motivo principal: riesgo de falsa ruptura por volumen débil.";
  if (context.longBias) return "Motivo principal: hay sesgo alcista, pero aún no alcanza para entrada prudente.";
  if (context.shortBias) return "Motivo principal: hay sesgo bajista, pero aún no alcanza para entrada prudente.";
  if (context.emaMixed || context.lateral) return "Motivo principal: no hay dirección útil.";
  return "Motivo principal: ventaja insuficiente para operar.";
}

function buildObservations(context) {
  const messages = [];

  if (context.volumePoor) messages.push(`Volumen demasiado pobre: ${formatPercent(context.volumeRatio)} del promedio.`);
  else if (!context.volumeAcceptable) messages.push(`Volumen débil: ${formatPercent(context.volumeRatio)} del promedio.`);
  if (context.priceBetweenEma21And50) messages.push("Precio entre EMA 21 y EMA 50: zona confusa.");
  if (context.emaMixed && !context.longBias && !context.shortBias) messages.push("EMA sin dirección útil.");
  if (context.lateral && !context.longBias && !context.shortBias) messages.push("Mercado lateral claro.");
  if (context.closeScores) messages.push("Scores casi iguales: forzar ESPERAR.");
  else if (context.balancedScores) messages.push("Scores cercanos: operar solo con mucha cautela.");
  if (context.lateEntry) messages.push("Entrada tardía: precio demasiado alejado de EMA 21.");
  if (context.falseBreakoutRisk) messages.push("Riesgo de falsa ruptura: movimiento sin volumen.");
  if (context.rsiValue > 70) messages.push("RSI alto: advertencia de sobrecompra, no bloqueo salvo extremo.");
  if (context.rsiValue < 30) messages.push("RSI bajo: advertencia de sobreventa, no bloqueo salvo extremo.");
  if (context.longBias && context.longScore >= 5 && !context.bounceConfirmed && !context.clearLongContinuation) {
    messages.push("Sesgo LONG, pero falta cierre más claro.");
  }
  if (context.shortBias && context.shortScore >= 5 && !context.rejectionConfirmed && !context.clearShortContinuation) {
    messages.push("Sesgo SHORT, pero falta cierre más claro.");
  }

  if (!messages.length) messages.push("Lectura operable; mantener gestión de riesgo.");
  if (context.decision.label === SIGNALS.WAIT) messages.unshift("Esperar es la señal principal.");

  return [...new Set(messages)].slice(0, 6);
}

function buildOperationPlan(context) {
  const buffer = Math.max(context.atrValue * 0.18, context.price * 0.0012);

  if (context.decision.label === SIGNALS.LONG_NOW) {
    const entry = context.price;
    const slBase = Math.min(context.ema50Value, context.recentLow);
    const sl = slBase - buffer;
    const risk = entry - sl;
    const tp = entry + risk * 1.45;

    return {
      mode: "confirmed",
      type: "LONG YA",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "long"),
      note: "Entrada LONG YA porque la estructura está limpia. El SL queda debajo de EMA 50/swing reciente: si pierde esa zona, la lectura alcista se invalida. TP prudente cerca de 1,45R."
    };
  }

  if (context.decision.label === SIGNALS.SHORT_NOW) {
    const entry = context.price;
    const slBase = Math.max(context.ema50Value, context.recentHigh);
    const sl = slBase + buffer;
    const risk = sl - entry;
    const tp = entry - risk * 1.45;

    return {
      mode: "confirmed",
      type: "SHORT YA",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "short"),
      note: "Entrada SHORT YA porque la estructura está limpia. El SL queda arriba de EMA 50/swing reciente: si recupera esa zona, la lectura bajista se invalida. TP prudente cerca de 1,45R."
    };
  }

  if (context.decision.label === SIGNALS.OPERABLE_LONG) {
    const entry = Math.max(context.ema21Value, Math.min(context.price, context.price - context.atrValue * 0.18));
    const sl = Math.min(context.ema50Value, context.recentLow) - buffer;
    const risk = entry - sl;
    const tp = entry + risk * 1.3;

    return {
      mode: "tentative",
      type: "OPERABLE LONG",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "long"),
      note: "Entrada operable pero no perfecta. Conviene no perseguir precio: entrada moderada cerca del cierre o pequeño retroceso hacia EMA 21. El SL invalida si pierde EMA 50/swing reciente. TP prudente cerca de 1,30R."
    };
  }

  if (context.decision.label === SIGNALS.OPERABLE_SHORT) {
    const entry = Math.min(context.ema21Value, Math.max(context.price, context.price + context.atrValue * 0.18));
    const sl = Math.max(context.ema50Value, context.recentHigh) + buffer;
    const risk = sl - entry;
    const tp = entry - risk * 1.3;

    return {
      mode: "tentative",
      type: "OPERABLE SHORT",
      entry,
      sl,
      tp,
      rr: calculateRiskReward(entry, sl, tp, "short"),
      note: "Entrada operable pero no perfecta. Conviene no perseguir precio: entrada moderada cerca del cierre o pequeño retroceso hacia EMA 21. El SL invalida si recupera EMA 50/swing reciente. TP prudente cerca de 1,30R."
    };
  }

  const watchAbove = Math.max(context.recentHigh, context.ema21Value, context.ema50Value) + buffer;
  const watchBelow = Math.min(context.recentLow, context.ema21Value, context.ema50Value) - buffer;
  const reason = context.decision.label === SIGNALS.OVERBOUGHT_EXTREME || context.decision.label === SIGNALS.OVERSOLD_EXTREME
    ? "RSI extremo con precio muy alejado de EMA 21: no operar directo."
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
  if (label === SIGNALS.LONG_NOW) return "signal-long";
  if (label === SIGNALS.SHORT_NOW) return "signal-short";
  if (label === SIGNALS.OPERABLE_LONG || label === SIGNALS.OPERABLE_SHORT) return "signal-operable";
  if (label === SIGNALS.OVERBOUGHT_EXTREME) return "signal-overbought";
  if (label === SIGNALS.OVERSOLD_EXTREME) return "signal-oversold";
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

function isBetween(value, first, second) {
  return value >= Math.min(first, second) && value <= Math.max(first, second);
}

function candleBodyRatio(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = Math.max(candle.high - candle.low, 0.0001);
  return body / range;
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
