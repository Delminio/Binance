import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createChart, CandlestickSeries } from 'lightweight-charts';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const CHART_HEIGHT = 420;

function formatPrice(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  const num = Number(value);
  const decimals = num >= 1000 ? 2 : num >= 100 ? 2 : 4;
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
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

function summarizeSymbol(symbol, candles) {
  if (!candles.length) {
    return {
      symbol,
      current: null,
      deltaPercent: null,
      high: null,
      low: null,
      trend: 'Aguardando dados',
      tone: 'neutral',
      narrative: `${symbol.replace('USDT', '/USDT')} ainda está formando histórico. O painel começou a receber dados agora.`
    };
  }

  const last = candles[candles.length - 1];
  const reference = candles[Math.max(0, candles.length - 12)] || candles[0];
  const deltaPercent = ((last.close - reference.open) / reference.open) * 100;
  const visible = candles.slice(-24);
  const high = Math.max(...visible.map((c) => c.high));
  const low = Math.min(...visible.map((c) => c.low));
  const trend = getTrendLabel(deltaPercent);
  const tone = getMarketTone(deltaPercent);
  const direction = deltaPercent > 0.15 ? 'subindo' : deltaPercent < -0.15 ? 'recuando' : 'oscila sem direção forte';

  return {
    symbol,
    current: last.close,
    deltaPercent,
    high,
    low,
    trend,
    tone,
    narrative: `${symbol.replace('USDT', '/USDT')} está ${direction}. Último preço em ${formatPrice(last.close)}, faixa recente entre ${formatPrice(low)} e ${formatPrice(high)}.`
  };
}

function AlertList({ alerts }) {
  if (!alerts.length) {
    return (
      <section className="alerts empty">
        Nenhum alerta disparado ainda. O sistema vai notificar quando houver movimentação relevante nas quatro moedas.
      </section>
    );
  }

  return (
    <section className="alerts">
      {alerts.map((alert) => {
        const rising = alert.direction === 'up';
        return (
          <div key={`${alert.symbol}-${alert.timestamp}`} className={`alert-card ${rising ? 'up' : 'down'}`}>
            <strong>{alert.symbol.replace('USDT', '/USDT')}</strong>
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

function CoinChartCard({ symbol, latestPrice, candles, onToggleFullscreen }) {
  const chartContainerRef = useRef(null);
  const cardRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const [barSpacing, setBarSpacing] = useState(14);
  const summary = useMemo(() => summarizeSymbol(symbol, candles), [symbol, candles]);
  const lastCandle = candles[candles.length - 1] || null;

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: CHART_HEIGHT,
      autoSize: false,
      layout: {
        background: { color: '#050505' },
        textColor: '#d7dde9',
        attributionLogo: false
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.07)' },
        horzLines: { color: 'rgba(255,255,255,0.07)' }
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.14)',
        scaleMargins: {
          top: 0.14,
          bottom: 0.14
        }
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.14)',
        timeVisible: true,
        secondsVisible: true,
        barSpacing,
        rightOffset: 4,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.2)', labelBackgroundColor: '#101010' },
        horzLine: { color: 'rgba(255,255,255,0.2)', labelBackgroundColor: '#101010' }
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#21c77a',
      downColor: '#ff5b5b',
      borderVisible: false,
      wickUpColor: '#21c77a',
      wickDownColor: '#ff5b5b',
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: {
        type: 'price',
        precision: latestPrice && latestPrice < 100 ? 4 : 2,
        minMove: latestPrice && latestPrice < 100 ? 0.0001 : 0.01
      }
    });

    chartRef.current = chart;
    seriesRef.current = series;

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
      timeScale: { barSpacing }
    });
  }, [barSpacing]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;

    const precision = latestPrice && latestPrice < 100 ? 4 : 2;
    const minMove = latestPrice && latestPrice < 100 ? 0.0001 : 0.01;

    seriesRef.current.applyOptions({
      priceFormat: {
        type: 'price',
        precision,
        minMove
      }
    });
  }, [latestPrice]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (!candles.length) return;

    seriesRef.current.setData(candles);
    chartRef.current.timeScale().fitContent();
  }, [candles]);

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
    <article ref={cardRef} className={`coin-card tone-${summary.tone}`}>
      <div className="coin-card-top">
        <div>
          <div className="symbol-row">
            <h2>{symbol.replace('USDT', '/USDT')}</h2>
            <span className={`trend-chip ${summary.tone}`}>{summary.trend}</span>
          </div>
          <p className="coin-subtitle">Acompanhamento em tempo real com candle, zoom e tela cheia.</p>
        </div>
        <div className="coin-price-block">
          <span className="coin-price">{formatPrice(latestPrice)}</span>
          <span className={`price-change ${summary.tone}`}>{formatPercent(summary.deltaPercent)}</span>
        </div>
      </div>

      <div className="coin-stats">
        <div>
          <span>Máx. recente</span>
          <strong>{formatPrice(summary.high)}</strong>
        </div>
        <div>
          <span>Mín. recente</span>
          <strong>{formatPrice(summary.low)}</strong>
        </div>
        <div>
          <span>Último candle</span>
          <strong>
            {lastCandle ? `${formatPrice(lastCandle.open)} → ${formatPrice(lastCandle.close)}` : 'Aguardando'}
          </strong>
        </div>
      </div>

      <div className="chart-toolbar">
        <button type="button" onClick={() => setBarSpacing((value) => Math.max(6, value - 2))}>− Zoom</button>
        <button type="button" onClick={() => setBarSpacing((value) => Math.min(34, value + 2))}>+ Zoom</button>
        <button type="button" onClick={() => chartRef.current?.timeScale().fitContent()}>Ajustar</button>
        <button type="button" onClick={handleFullscreen}>Tela cheia</button>
      </div>

      <div ref={chartContainerRef} className="chart-box" />

      <div className="live-summary-box">
        <strong>Leitura ao vivo</strong>
        <p>{summary.narrative}</p>
      </div>
    </article>
  );
}

function MarketOverview({ marketSummaries, connectionStatus, alertCount }) {
  const active = marketSummaries.filter((item) => item.current != null);
  const strongestBull = [...active].sort((a, b) => (b.deltaPercent ?? -Infinity) - (a.deltaPercent ?? -Infinity))[0];
  const strongestBear = [...active].sort((a, b) => (a.deltaPercent ?? Infinity) - (b.deltaPercent ?? Infinity))[0];

  return (
    <section className="overview-panel">
      <div className="overview-header">
        <div>
          <h3>Central de leitura dos 4 gráficos</h3>
          <p>
            Esta caixa resume automaticamente o que está acontecendo no BTC, ETH, SOL e BNB com base nos candles mais recentes.
          </p>
        </div>
        <div className="overview-badges">
          <span>{connectionStatus}</span>
          <span>{alertCount} alertas recentes</span>
        </div>
      </div>

      <div className="overview-highlight-row">
        <div className="overview-highlight bull">
          <span>Maior força compradora</span>
          <strong>{strongestBull ? strongestBull.symbol.replace('USDT', '/USDT') : 'Aguardando'}</strong>
          <p>{strongestBull ? formatPercent(strongestBull.deltaPercent) : 'Sem dados suficientes.'}</p>
        </div>
        <div className="overview-highlight bear">
          <span>Maior pressão vendedora</span>
          <strong>{strongestBear ? strongestBear.symbol.replace('USDT', '/USDT') : 'Aguardando'}</strong>
          <p>{strongestBear ? formatPercent(strongestBear.deltaPercent) : 'Sem dados suficientes.'}</p>
        </div>
      </div>

      <div className="overview-grid">
        {marketSummaries.map((item) => (
          <div key={item.symbol} className={`overview-card tone-${item.tone}`}>
            <div className="overview-card-head">
              <h4>{item.symbol.replace('USDT', '/USDT')}</h4>
              <span className={`price-change ${item.tone}`}>{formatPercent(item.deltaPercent)}</span>
            </div>
            <p>{item.narrative}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [prices, setPrices] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState('Conectando...');
  const [candlesBySymbol, setCandlesBySymbol] = useState(() =>
    Object.fromEntries(SYMBOLS.map((symbol) => [symbol, []]))
  );

  const socket = useMemo(() => io(API_URL, { transports: ['websocket', 'polling'] }), []);

  useEffect(() => {
    function handleConnect() {
      setStatus('Conectado em tempo real');
    }

    function handleDisconnect() {
      setStatus('Reconectando...');
    }

    function handleInitialState(payload) {
      const initialPrices = Object.fromEntries(
        Object.entries(payload.symbols || {}).map(([symbol, value]) => [symbol, value.price])
      );
      setPrices(initialPrices);
    }

    function handlePriceUpdate({ symbol, price, eventTime }) {
      setPrices((current) => ({ ...current, [symbol]: price }));

      setCandlesBySymbol((current) => {
        const symbolCandles = current[symbol] || [];
        const bucket = Math.floor((eventTime || Date.now()) / 1000 / 5) * 5;
        const last = symbolCandles[symbolCandles.length - 1];
        let nextCandles;

        if (!last || last.time !== bucket) {
          const newCandle = {
            time: bucket,
            open: price,
            high: price,
            low: price,
            close: price
          };
          nextCandles = [...symbolCandles, newCandle].slice(-180);
        } else {
          const updatedLast = {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price
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
    socket.on('initial_state', handleInitialState);
    socket.on('price_update', handlePriceUpdate);
    socket.on('price_alert', handlePriceAlert);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('initial_state', handleInitialState);
      socket.off('price_update', handlePriceUpdate);
      socket.off('price_alert', handlePriceAlert);
      socket.disconnect();
    };
  }, [socket]);

  const marketSummaries = useMemo(
    () => SYMBOLS.map((symbol) => summarizeSymbol(symbol, candlesBySymbol[symbol] || [])),
    [candlesBySymbol]
  );

  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>Crypto Alerts Pro</h1>
          <p>Painel profissional em preto com BTC, ETH, SOL e BNB em tempo real, zoom, tela cheia e leitura automática do mercado.</p>
        </div>
        <div className="status-chip">{status}</div>
      </header>

      <AlertList alerts={alerts} />

      <section className="grid">
        {SYMBOLS.map((symbol) => (
          <CoinChartCard
            key={symbol}
            symbol={symbol}
            latestPrice={prices[symbol]}
            candles={candlesBySymbol[symbol] || []}
          />
        ))}
      </section>

      <MarketOverview marketSummaries={marketSummaries} connectionStatus={status} alertCount={alerts.length} />
    </div>
  );
}
