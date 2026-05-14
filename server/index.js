import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import WebSocket from 'ws';

const app = express();
const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const ALERT_WINDOW_MS = Number(process.env.ALERT_WINDOW_MS || 60000);
const ALERT_THRESHOLD_PERCENT = Number(process.env.ALERT_THRESHOLD_PERCENT || 0.5);
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 20000);

const server = http.createServer(app);

app.use(cors({ origin: CLIENT_ORIGIN === '*' ? true : CLIENT_ORIGIN }));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN === '*' ? true : CLIENT_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'spkusdc'];
const STREAM_URL = `wss://stream.binance.com:9443/stream?streams=${SYMBOLS.map((s) => `${s}@trade`).join('/')}`;

const marketState = {
  BTCUSDT: { price: null, history: [] },
  ETHUSDT: { price: null, history: [] },
  SOLUSDT: { price: null, history: [] },
  BNBUSDT: { price: null, history: [] },
  SPKUSDC: { price: null, history: [] }
};

const lastAlertTime = {
  BTCUSDT: 0,
  ETHUSDT: 0,
  SOLUSDT: 0,
  BNBUSDT: 0,
  SPKUSDC: 0
};

let ws;

function pruneHistory(symbol) {
  const now = Date.now();
  const arr = marketState[symbol].history;
  while (arr.length && now - arr[0].time > ALERT_WINDOW_MS) {
    arr.shift();
  }
}

function pushHistory(symbol, price, time) {
  const arr = marketState[symbol].history;
  arr.push({ time, price });
  pruneHistory(symbol);
}

function getSnapshot() {
  return {
    symbols: Object.fromEntries(
      Object.entries(marketState).map(([symbol, value]) => [symbol, { price: value.price }])
    ),
    config: {
      alertWindowMs: ALERT_WINDOW_MS,
      alertThresholdPercent: ALERT_THRESHOLD_PERCENT,
      alertCooldownMs: ALERT_COOLDOWN_MS
    }
  };
}

function checkAlert(symbol) {
  const arr = marketState[symbol].history;
  if (arr.length < 2) return null;

  const first = arr[0].price;
  const last = arr[arr.length - 1].price;
  if (!first || !last) return null;

  const changePercent = ((last - first) / first) * 100;
  const now = Date.now();

  if (Math.abs(changePercent) < ALERT_THRESHOLD_PERCENT) return null;
  if (now - lastAlertTime[symbol] < ALERT_COOLDOWN_MS) return null;

  lastAlertTime[symbol] = now;

  return {
    symbol,
    firstPrice: first,
    lastPrice: last,
    changePercent: Number(changePercent.toFixed(3)),
    direction: changePercent > 0 ? 'up' : 'down',
    timestamp: now,
    windowMs: ALERT_WINDOW_MS
  };
}

function connectBinance() {
  ws = new WebSocket(STREAM_URL);

  ws.on('open', () => {
    console.log('Conectado ao WebSocket da Binance');
  });

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const data = parsed?.data;
      if (!data?.s || !data?.p) return;

      const symbol = data.s;
      const price = Number(data.p);
      const eventTime = Number(data.E || Date.now());

      if (!marketState[symbol] || Number.isNaN(price)) return;

      marketState[symbol].price = price;
      pushHistory(symbol, price, eventTime);

      io.emit('price_update', {
        symbol,
        price,
        eventTime
      });

      const alert = checkAlert(symbol);
      if (alert) {
        io.emit('price_alert', alert);
      }
    } catch (error) {
      console.error('Erro ao processar mensagem:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket Binance fechado. Reconectando em 3 segundos...');
    setTimeout(connectBinance, 3000);
  });

  ws.on('error', (error) => {
    console.error('Erro no WebSocket Binance:', error.message);
    try {
      ws.close();
    } catch {
      // noop
    }
  });
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'crypto-alerts-server' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ...getSnapshot() });
});

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  socket.emit('initial_state', getSnapshot());

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor escutando na porta ${PORT}`);
  connectBinance();
});
