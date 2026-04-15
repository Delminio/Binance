import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { createChart, CandlestickSeries } from 'lightweight-charts';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

function formatPrice(value) {
  if (value == null) return '-';
  return Number(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 1000 ? 2 : 6
  });
}

function AlertList({ alerts }) {
  if (!alerts.length) {
    return (
      <section className="alerts empty">
        Nenhum alerta disparado ainda. O sistema vai notificar quando houver movimentação relevante.
      </section>
    );
  }

  return (
    <section className="alerts">
      {alerts.map((alert) => {
        const rising = alert.direction === 'up';
        return (
          <div key={`${alert.symbol}-${alert.timestamp}`} className={`alert-card ${rising ? 'up' : 'down'}`}>
            <strong>{alert.symbol}</strong>
            <span>
              {rising ? 'subiu' : 'caiu'} {Math.abs(alert.changePercent).toFixed(3)}% em {Math.round(alert.windowMs / 1000)}s
            </span>
          </div>
        );
      })}
    </section>
  );
}

function CoinChart({ symbol, latestPrice }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const lastCandleRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 280,
      layout: {
        background: { color: '#10141f' },
        textColor: '#d8e1ff'
      },
      grid: {
        vertLines: { color: '#1c2438' },
        horzLines: { color: '#1c2438' }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: true
      },
      rightPriceScale: {
        borderColor: '#293454'
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      borderUpColor: '#22c55e',
      wickUpColor: '#22c55e',
      downColor: '#ef4444',
      borderDownColor: '#ef4444',
      wickDownColor: '#ef4444'
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ['websocket', 'polling']
    });

    const updateCandle = ({ symbol: incomingSymbol, price, eventTime }) => {
      if (incomingSymbol !== symbol || !seriesRef.current) return;

      const bucket = Math.floor(eventTime / 1000 / 5) * 5;
      let candle = lastCandleRef.current;

      if (!candle || candle.time !== bucket) {
        candle = {
          time: bucket,
          open: price,
          high: price,
          low: price,
          close: price
        };
      } else {
        candle = {
          ...candle,
          high: Math.max(candle.high, price),
          low: Math.min(candle.low, price),
          close: price
        };
      }

      lastCandleRef.current = candle;
      seriesRef.current.update(candle);
    };

    socket.on('price_update', updateCandle);
    return () => socket.disconnect();
  }, [symbol]);

  return (
    <div className="coin-card">
      <div className="coin-header">
        <div>
          <h2>{symbol.replace('USDT', '/USDT')}</h2>
          <p>Preço atual</p>
        </div>
        <span>{formatPrice(latestPrice)}</span>
      </div>
      <div ref={containerRef} className="chart-box" />
    </div>
  );
}

export default function App() {
  const [prices, setPrices] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [status, setStatus] = useState('Conectando...');

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

    function handlePriceUpdate({ symbol, price }) {
      setPrices((current) => ({ ...current, [symbol]: price }));
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
        gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.15);
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

  return (
    <div className="page">
      <header className="hero">
        <div>
          <h1>Crypto Alerts</h1>
          <p>Monitoramento em tempo real de BTC, ETH, SOL e BNB com alertas automáticos.</p>
        </div>
        <div className="status-chip">{status}</div>
      </header>

      <AlertList alerts={alerts} />

      <section className="grid">
        {SYMBOLS.map((symbol) => (
          <CoinChart key={symbol} symbol={symbol} latestPrice={prices[symbol]} />
        ))}
      </section>
    </div>
  );
}
