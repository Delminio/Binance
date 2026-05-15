import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'SPKUSDC'];
const CHART_HEIGHT = 520;

const TIMEFRAMES = [
  { label: '1s', value: '1s', seconds: 1 },
  { label: '15m', value: '15m', seconds: 900 },
  { label: '1H', value: '1h', seconds: 3600 },
  { label: '4H', value: '4h', seconds: 14400 },
  { label: '1D', value: '1d', seconds: 86400 },
  { label: '1W', value: '1w', seconds: 604800 }
];

const SYMBOL_LABELS = {
  BTCUSDT: 'BTC/USDT',
  ETHUSDT: 'ETH/USDT',
  SOLUSDT: 'SOL/USDT',
  BNBUSDT: 'BNB/USDT',
  SPKUSDC: 'SPK/USDC'
};

const PRICE_FORMATS = {
  BTCUSDT: { precision: 2, minMove: 0.01 },
  ETHUSDT: { precision: 2, minMove: 0.01 },
  SOLUSDT: { precision: 4, minMove: 0.0001 },
  BNBUSDT: { precision: 2, minMove: 0.01 },
  SPKUSDC: { precision: 6, minMove: 0.000001 }
};

function labelSymbol(symbol) {
  return SYMBOL_LABELS[symbol] || symbol.replace('USDT', '/USDT').replace('USDC', '/USDC');
}

function getPriceFormat(symbol, latestPrice) {
  if (PRICE_FORMATS[symbol]) return PRICE_FORMATS[symbol];
  const price = Number(latestPrice);
  if (price > 0 && price < 0.01) return { precision: 8, minMove: 0.00000001 };
  if (price > 0 && price < 1) return { precision: 6, minMove: 0.000001 };
  if (price > 0 && price < 100) return { precision: 4, minMove: 0.0001 };
  return { precision: 2, minMove: 0.01 };
}

function formatPrice(value, symbol) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  const num = Number(value);
  const fixedFormat = symbol ? getPriceFormat(symbol, num) : null;
  const decimals = fixedFormat ? fixedFormat.precision : num >= 100 ? 2 : num >= 1 ? 4 : 6;
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatCompact(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  const num = Number(value);
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toFixed(2);
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  const num = Number(value);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)}%`;
}

function getTrendLabel(change) {
  if (change == null) return 'Aguardando dados';
  if (change > 0.35) return 'Força compradora';
  if (change < -0.35) return 'Pressão vendedora';
  return 'Mercado lateral';
}

function getMarketTone(change) {
  if (change == null) return 'neutral';
  if (change > 0.15) return 'bull';
  if (change < -0.15) return 'bear';
  return 'neutral';
}

function getTimeframe(value) {
  return TIMEFRAMES.find((item) => item.value === value) || TIMEFRAMES[0];
}

function bucketLiveCandles(candles, timeframeValue) {
  const tf = getTimeframe(timeframeValue);
  const map = new Map();

  candles.forEach((item) => {
    const bucket = Math.floor(item.time / tf.seconds) * tf.seconds;
    const current = map.get(bucket);
    const volume = Number(item.volume || 0);

    if (!current) {
      map.set(bucket, {
        time: bucket,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume
      });
      return;
    }

    current.high = Math.max(current.high, item.high);
    current.low = Math.min(current.low, item.low);
    current.close = item.close;
    current.volume += volume;
  });

  return [...map.values()].sort((a, b) => a.time - b.time);
}

function mergeHistoricalWithLive(historical, live, timeframeValue) {
  const base = new Map();
  historical.forEach((item) => base.set(item.time, { ...item }));
  bucketLiveCandles(live, timeframeValue).forEach((item) => {
    const current = base.get(item.time);
    if (!current) {
      base.set(item.time, { ...item });
      return;
    }

    current.high = Math.max(current.high, item.high);
    current.low = Math.min(current.low, item.low);
    current.close = item.close;
    current.volume = Number(current.volume || 0) + Number(item.volume || 0);
  });

  return [...base.values()].sort((a, b) => a.time - b.time).slice(-320);
}

function movingAverage(candles, length) {
  if (!candles.length) return [];
  const result = [];
  let sum = 0;

  candles.forEach((candle, index) => {
    sum += candle.close;
    if (index >= length) sum -= candles[index - length].close;
    if (index >= length - 1) {
      result.push({ time: candle.time, value: sum / length });
    }
  });

  return result;
}

function calculateRsi(candles, period = 14) {
  if (candles.length <= period) return null;
  let gains = 0;
  let losses = 0;
  const slice = candles.slice(-(period + 1));

  for (let i = 1; i < slice.length; i += 1) {
    const delta = slice[i].close - slice[i - 1].close;
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }

  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateMarketScore(summary, rsi, volumeBoost) {
  let score = 50;
  if (summary.deltaPercent != null) score += Math.max(-30, Math.min(30, summary.deltaPercent * 8));
  if (rsi != null) score += rsi > 55 ? 8 : rsi < 45 ? -8 : 0;
  if (volumeBoost > 1.5) score += 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function summarizeSymbol(symbol, candles) {
  if (!candles.length) {
    return {
      symbol,
      current: null,
      deltaPercent: null,
      high: null,
      low: null,
      volume: null,
      trend: 'Aguardando dados',
      tone: 'neutral',
      narrative: `${labelSymbol(symbol)} ainda está formando histórico. O painel começou a receber dados agora.`
    };
  }

  const last = candles[candles.length - 1];
  const reference = candles[Math.max(0, candles.length - 12)] || candles[0];
  const deltaPercent = ((last.close - reference.open) / reference.open) * 100;
  const visible = candles.slice(-48);
  const high = Math.max(...visible.map((c) => c.high));
  const low = Math.min(...visible.map((c) => c.low));
  const volume = visible.reduce((sum, c) => sum + Number(c.volume || 0), 0);
  const trend = getTrendLabel(deltaPercent);
  const tone = getMarketTone(deltaPercent);
  const direction = deltaPercent > 0.15 ? 'subindo' : deltaPercent < -0.15 ? 'recuando' : 'lateralizando';

  return {
    symbol,
    current: last.close,
    deltaPercent,
    high,
    low,
    volume,
    trend,
    tone,
    narrative: `${labelSymbol(symbol)} está ${direction}. Último preço em ${formatPrice(last.close, symbol)}, faixa recente entre ${formatPrice(low, symbol)} e ${formatPrice(high, symbol)}.`
  };
}

function AlertList({ alerts }) {
  if (!alerts.length) {
    return (
      <section className="alerts empty">
        Nenhum alerta disparado ainda. O sistema vai notificar quando houver movimentação relevante nas moedas monitoradas.
      </section>
    );
  }

  return (
    <section className="alerts">
      {alerts.map((alert) => {
        const rising = alert.direction === 'up';
        return (
          <div key={`${alert.symbol}-${alert.timestamp}`} className={`alert-card ${rising ? 'up' : 'down'}`}>
            <strong>{labelSymbol(alert.symbol)}</strong>
            <span>
              {rising ? 'movimento de alta' : 'movimento de queda'} de {Math.abs(alert.changePercent).toFixed(3)}% em{' '}
              {Math.round(alert.windowMs / 1000)}s.
            </span>
          </div>
        );
      })}
    </section>
  );
}

function ChartTabs() {
  return (
    <div className="chart-tabs">
      <button className="active" type="button">Chart</button>
      <button type="button">Info</button>
      <button type="button">Trading Data</button>
      <button type="button">Audit</button>
      <button type="button">Square</button>
    </div>
  );
}

function TimeframeToolbar({ timeframe, onChange, onFit, onFullscreen, showMA, onToggleMA, showVolume, onToggleVolume }) {
  return (
    <div className="binance-toolbar">
      <div className="timeframe-group">
        <span>Time</span>
        {TIMEFRAMES.map((item) => (
          <button
            key={item.value}
            type="button"
            className={timeframe === item.value ? 'active' : ''}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="tool-group">
        <button type="button" className={showMA ? 'active' : ''} onClick={onToggleMA}>MA</button>
        <button type="button" className={showVolume ? 'active' : ''} onClick={onToggleVolume}>Vol</button>
        <button type="button" onClick={onFit}>Ajustar</button>
        <button type="button" onClick={onFullscreen}>Tela cheia</button>
      </div>
    </div>
  );
}

function CoinChartCard({ symbol, latestPrice, liveCandles, onToggleFullscreen }) {
  const chartContainerRef = useRef(null);
  const cardRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const ma7Ref = useRef(null);
  const ma25Ref = useRef(null);
  const ma99Ref = useRef(null);
  const [timeframe, setTimeframe] = useState('1s');
  const [historicalCandles, setHistoricalCandles] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showMA, setShowMA] = useState(true);
  const [showVolume, setShowVolume] = useState(true);

  const displayCandles = useMemo(
    () => mergeHistoricalWithLive(historicalCandles, liveCandles, timeframe),
    [historicalCandles, liveCandles, timeframe]
  );
  const summary = useMemo(() => summarizeSymbol(symbol, displayCandles), [symbol, displayCandles]);
  const lastCandle = displayCandles[displayCandles.length - 1] || null;
  const rsi = useMemo(() => calculateRsi(displayCandles), [displayCandles]);
  const volumeData = useMemo(
    () => displayCandles.map((candle) => ({
      time: candle.time,
      value: Number(candle.volume || 0),
      color: candle.close >= candle.open ? 'rgba(33,199,122,0.55)' : 'rgba(255,91,91,0.55)'
    })),
    [displayCandles]
  );
  const recentVolume = displayCandles.slice(-20).reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const previousVolume = displayCandles.slice(-40, -20).reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const volumeBoost = previousVolume > 0 ? recentVolume / previousVolume : 1;
  const marketScore = calculateMarketScore(summary, rsi, volumeBoost);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      setLoadingHistory(true);
      try {
        const response = await fetch(`${API_URL}/klines/${symbol}?interval=${timeframe}&limit=240`);
        const data = await response.json();
        if (!cancelled && data?.ok && Array.isArray(data.candles)) {
          setHistoricalCandles(data.candles);
        }
      } catch {
        if (!cancelled) setHistoricalCandles([]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: CHART_HEIGHT,
      autoSize: false,
      layout: {
        background: { color: '#0b0f17' },
        textColor: '#9da8ba',
        attributionLogo: false
      },
      grid: {
        vertLines: { color: 'rgba(132,142,156,0.13)' },
        horzLines: { color: 'rgba(132,142,156,0.13)' }
      },
      rightPriceScale: {
        borderColor: 'rgba(132,142,156,0.25)',
        scaleMargins: {
          top: 0.08,
          bottom: showVolume ? 0.26 : 0.12
        }
      },
      timeScale: {
        borderColor: 'rgba(132,142,156,0.25)',
        timeVisible: true,
        secondsVisible: timeframe === '1s',
        barSpacing: timeframe === '1s' ? 7 : 9,
        rightOffset: 8,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(240,185,11,0.42)', width: 1, labelBackgroundColor: '#181a20' },
        horzLine: { color: 'rgba(240,185,11,0.42)', width: 1, labelBackgroundColor: '#181a20' }
      }
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
      priceLineColor: '#0ecb81',
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: {
        type: 'price',
        ...getPriceFormat(symbol, latestPrice)
      }
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.76, bottom: 0 },
      borderVisible: false
    });

    const ma7 = chart.addSeries(LineSeries, { color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma25 = chart.addSeries(LineSeries, { color: '#e843c4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma99 = chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ma7Ref.current = ma7;
    ma25Ref.current = ma25;
    ma99Ref.current = ma99;

    const resize = () => {
      if (!chartContainerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: CHART_HEIGHT
      });
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(chartContainerRef.current);
    window.addEventListener('resize', resize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: showVolume ? 0.26 : 0.12 } },
      timeScale: {
        secondsVisible: timeframe === '1s',
        barSpacing: timeframe === '1s' ? 7 : 9
      }
    });
  }, [timeframe, showVolume]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    candleSeriesRef.current.applyOptions({
      priceFormat: {
        type: 'price',
        ...getPriceFormat(symbol, latestPrice)
      }
    });
  }, [symbol, latestPrice]);

  useEffect(() => {
    if (!candleSeriesRef.current || !chartRef.current) return;
    if (!displayCandles.length) return;

    candleSeriesRef.current.setData(displayCandles);
    volumeSeriesRef.current?.setData(showVolume ? volumeData : []);
    ma7Ref.current?.setData(showMA ? movingAverage(displayCandles, 7) : []);
    ma25Ref.current?.setData(showMA ? movingAverage(displayCandles, 25) : []);
    ma99Ref.current?.setData(showMA ? movingAverage(displayCandles, 99) : []);

    chartRef.current.timeScale().fitContent();
  }, [displayCandles, volumeData, showMA, showVolume]);

  async function handleFullscreen() {
    if (!cardRef.current) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await cardRef.current.requestFullscreen();
    onToggleFullscreen?.(symbol);
  }

  return (
    <article ref={cardRef} className={`coin-card trading-card tone-${summary.tone}`}>
      <div className="trading-card-header">
        <div>
          <div className="symbol-row">
            <h2>{labelSymbol(symbol)}</h2>
            <span className={`trend-chip ${summary.tone}`}>{summary.trend}</span>
            <span className="market-score">Score {marketScore}</span>
          </div>
          <p className="coin-subtitle">Candles com timeframes, volume, médias móveis, zoom, tela cheia e leitura automática.</p>
        </div>
        <div className="coin-price-block">
          <span className="coin-price">{formatPrice(latestPrice, symbol)}</span>
          <span className={`price-change ${summary.tone}`}>{formatPercent(summary.deltaPercent)}</span>
        </div>
      </div>

      <div className="coin-stats pro-stats">
        <div><span>Máx. recente</span><strong>{formatPrice(summary.high, symbol)}</strong></div>
        <div><span>Mín. recente</span><strong>{formatPrice(summary.low, symbol)}</strong></div>
        <div><span>Volume</span><strong>{formatCompact(summary.volume)}</strong></div>
        <div><span>RSI 14</span><strong>{rsi == null ? '-' : rsi.toFixed(1)}</strong></div>
        <div><span>Último candle</span><strong>{lastCandle ? `${formatPrice(lastCandle.open, symbol)} → ${formatPrice(lastCandle.close, symbol)}` : 'Aguardando'}</strong></div>
      </div>

      <div className="chart-shell">
        <ChartTabs />
        <TimeframeToolbar
          timeframe={timeframe}
          onChange={setTimeframe}
          onFit={() => chartRef.current?.timeScale().fitContent()}
          onFullscreen={handleFullscreen}
          showMA={showMA}
          onToggleMA={() => setShowMA((value) => !value)}
          showVolume={showVolume}
          onToggleVolume={() => setShowVolume((value) => !value)}
        />

        <div className="chart-meta-row">
          <span>{loadingHistory ? 'Carregando candles...' : `${displayCandles.length} candles`}</span>
          {lastCandle && (
            <>
              <span>Open <b>{formatPrice(lastCandle.open, symbol)}</b></span>
              <span>High <b className="positive">{formatPrice(lastCandle.high, symbol)}</b></span>
              <span>Low <b className="negative">{formatPrice(lastCandle.low, symbol)}</b></span>
              <span>Close <b>{formatPrice(lastCandle.close, symbol)}</b></span>
            </>
          )}
        </div>

        <div className="ma-legend">
          <span>MA(7) <b className="ma7">{movingAverage(displayCandles, 7).at(-1)?.value ? formatPrice(movingAverage(displayCandles, 7).at(-1).value, symbol) : '-'}</b></span>
          <span>MA(25) <b className="ma25">{movingAverage(displayCandles, 25).at(-1)?.value ? formatPrice(movingAverage(displayCandles, 25).at(-1).value, symbol) : '-'}</b></span>
          <span>MA(99) <b className="ma99">{movingAverage(displayCandles, 99).at(-1)?.value ? formatPrice(movingAverage(displayCandles, 99).at(-1).value, symbol) : '-'}</b></span>
        </div>

        <div ref={chartContainerRef} className="chart-box trading-chart" />
      </div>

      <div className="live-summary-box pro-summary">
        <strong>Leitura ao vivo</strong>
        <p>{summary.narrative} RSI em {rsi == null ? 'formação' : rsi.toFixed(1)} e volume recente {volumeBoost > 1.4 ? 'acima da média' : 'normal'}.</p>
      </div>
    </article>
  );
}

function MarketOverview({ marketSummaries, connectionStatus, alertCount }) {
  const active = marketSummaries.filter((item) => item.current != null);
  const strongestBull = [...active].sort((a, b) => (b.deltaPercent ?? -Infinity) - (a.deltaPercent ?? -Infinity))[0];
  const strongestBear = [...active].sort((a, b) => (a.deltaPercent ?? Infinity) - (b.deltaPercent ?? Infinity))[0];
  const bullish = active.filter((item) => item.tone === 'bull').length;
  const bearish = active.filter((item) => item.tone === 'bear').length;
  const marketMood = bullish > bearish ? 'Mercado com viés comprador' : bearish > bullish ? 'Mercado com pressão vendedora' : 'Mercado misto/lateral';

  return (
    <section className="overview-panel">
      <div className="overview-header">
        <div>
          <h3>Central de leitura dos gráficos</h3>
          <p>
            Esta caixa resume automaticamente o que está acontecendo nas moedas adicionadas com base nos candles, volume, força relativa e variação recente.
          </p>
        </div>
        <div className="overview-badges">
          <span>{connectionStatus}</span>
          <span>{alertCount} alertas recentes</span>
          <span>{marketMood}</span>
        </div>
      </div>

      <div className="overview-highlight-row">
        <div className="overview-highlight bull">
          <span>Maior força compradora</span>
          <strong>{strongestBull ? labelSymbol(strongestBull.symbol) : 'Aguardando'}</strong>
          <p>{strongestBull ? formatPercent(strongestBull.deltaPercent) : 'Sem dados suficientes.'}</p>
        </div>
        <div className="overview-highlight bear">
          <span>Maior pressão vendedora</span>
          <strong>{strongestBear ? labelSymbol(strongestBear.symbol) : 'Aguardando'}</strong>
          <p>{strongestBear ? formatPercent(strongestBear.deltaPercent) : 'Sem dados suficientes.'}</p>
        </div>
      </div>

      <div className="overview-grid">
        {marketSummaries.map((item) => (
          <div key={item.symbol} className={`overview-card tone-${item.tone}`}>
            <div className="overview-card-head">
              <h4>{labelSymbol(item.symbol)}</h4>
              <span className={`price-change ${item.tone}`}>{formatPercent(item.deltaPercent)}</span>
            </div>
            <p>{item.narrative}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddSymbolPanel({ socket, symbols, onAddSymbol }) {
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  function submit(event) {
    event.preventDefault();
    const typed = value.trim().toUpperCase();
    if (!typed) {
      setMessage('Digite uma moeda. Exemplo: XRP, DOGE, SPKUSDC.');
      return;
    }

    setLoading(true);
    setMessage('Buscando par na Binance...');

    socket.emit('add_symbol', { symbol: typed }, (response) => {
      setLoading(false);

      if (!response?.ok) {
        setMessage(response?.message || 'Não consegui adicionar essa moeda.');
        return;
      }

      onAddSymbol(response.symbol, response.snapshot);
      setValue('');
      setMessage(response.alreadyExists ? `${labelSymbol(response.symbol)} já estava no painel.` : `${labelSymbol(response.symbol)} adicionada ao painel.`);
    });
  }

  const suggestions = ['XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'PEPE', 'SPKUSDC'];

  return (
    <section className="add-symbol-panel terminal-panel">
      <div>
        <h3>Adicionar moeda ao painel</h3>
        <p>Pesquise pelo ticker. O sistema tenta encontrar automaticamente o par em USDT ou USDC e cria o card em tempo real.</p>
      </div>

      <form onSubmit={submit} className="add-symbol-form">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Ex: XRP, DOGE, PEPE, SPKUSDC"
          disabled={loading}
        />
        <button type="submit" disabled={loading}>{loading ? 'Adicionando...' : 'Adicionar'}</button>
      </form>

      <div className="quick-symbols">
        {suggestions.map((item) => (
          <button
            key={item}
            type="button"
            disabled={loading || symbols.includes(item) || symbols.includes(`${item}USDT`) || symbols.includes(`${item}USDC`)}
            onClick={() => setValue(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {message && <p className="add-symbol-message">{message}</p>}
    </section>
  );
}

export default function App() {
  const [symbols, setSymbols] = useState(DEFAULT_SYMBOLS);
  const [prices, setPrices] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState('Conectando...');
  const [candlesBySymbol, setCandlesBySymbol] = useState(() =>
    Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, []]))
  );

  const socket = useMemo(() => io(API_URL, { transports: ['websocket', 'polling'] }), []);

  useEffect(() => {
    function handleConnect() {
      setStatus('Conectado em tempo real');
    }

    function handleDisconnect() {
      setStatus('Reconectando...');
    }

    function applySnapshot(payload) {
      const incomingSymbols = Object.keys(payload.symbols || {});
      if (incomingSymbols.length) {
        setSymbols(incomingSymbols);
        setCandlesBySymbol((current) => ({
          ...Object.fromEntries(incomingSymbols.map((symbol) => [symbol, current[symbol] || []])),
          ...current
        }));
      }

      const initialPrices = Object.fromEntries(
        Object.entries(payload.symbols || {}).map(([symbol, value]) => [symbol, value.price])
      );
      setPrices((current) => ({ ...current, ...initialPrices }));
    }

    function handlePriceUpdate({ symbol, price, eventTime, quantity }) {
      setPrices((current) => ({ ...current, [symbol]: price }));

      setCandlesBySymbol((current) => {
        const symbolCandles = current[symbol] || [];
        const bucket = Math.floor((eventTime || Date.now()) / 1000);
        const last = symbolCandles[symbolCandles.length - 1];
        let nextCandles;

        if (!last || last.time !== bucket) {
          const newCandle = {
            time: bucket,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: Number(quantity || 0)
          };
          nextCandles = [...symbolCandles, newCandle].slice(-900);
        } else {
          const updatedLast = {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volume: Number(last.volume || 0) + Number(quantity || 0)
          };
          nextCandles = [...symbolCandles.slice(0, -1), updatedLast];
        }

        return {
          ...current,
          [symbol]: nextCandles
        };
      });
    }

    function handlePriceAlert(alert) {
      setAlerts((current) => [alert, ...current].slice(0, 8));

      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(`Alerta ${alert.symbol}`, {
          body: `${alert.direction === 'up' ? 'Alta' : 'Queda'} de ${Math.abs(alert.changePercent).toFixed(3)}%`
        });
      }

      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        oscillator.type = 'sine';
        oscillator.frequency.value = 880;
        gainNode.gain.setValueAtTime(0.08, ctx.currentTime);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.12);
      } catch {
        // noop
      }
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('initial_state', applySnapshot);
    socket.on('symbols_update', applySnapshot);
    socket.on('price_update', handlePriceUpdate);
    socket.on('price_alert', handlePriceAlert);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('initial_state', applySnapshot);
      socket.off('symbols_update', applySnapshot);
      socket.off('price_update', handlePriceUpdate);
      socket.off('price_alert', handlePriceAlert);
      socket.disconnect();
    };
  }, [socket]);

  function handleAddedSymbol(symbol, snapshot) {
    setSymbols((current) => (current.includes(symbol) ? current : [...current, symbol]));
    setCandlesBySymbol((current) => ({ ...current, [symbol]: current[symbol] || [] }));

    if (snapshot?.symbols) {
      const snapshotPrices = Object.fromEntries(
        Object.entries(snapshot.symbols).map(([item, value]) => [item, value.price])
      );
      setPrices((current) => ({ ...current, ...snapshotPrices }));
    }
  }

  const marketSummaries = useMemo(
    () => symbols.map((symbol) => summarizeSymbol(symbol, candlesBySymbol[symbol] || [])),
    [symbols, candlesBySymbol]
  );

  return (
    <div className="page terminal-page">
      <header className="hero terminal-hero">
        <div>
          <h1>Crypto Alerts Pro Terminal</h1>
          <p>Painel profissional em preto com timeframes, volume, médias móveis, busca dinâmica, zoom, tela cheia e leitura automática do mercado.</p>
        </div>
        <div className="status-chip">{status}</div>
      </header>

      <AlertList alerts={alerts} />
      <AddSymbolPanel socket={socket} symbols={symbols} onAddSymbol={handleAddedSymbol} />

      <section className="grid trading-grid">
        {symbols.map((symbol) => (
          <CoinChartCard
            key={symbol}
            symbol={symbol}
            latestPrice={prices[symbol]}
            liveCandles={candlesBySymbol[symbol] || []}
          />
        ))}
      </section>

      <MarketOverview marketSummaries={marketSummaries} connectionStatus={status} alertCount={alerts.length} />
    </div>
  );
}
