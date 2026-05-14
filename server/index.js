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

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'SPKUSDC'];
const activeSymbols = new Set(DEFAULT_SYMBOLS);
const marketState = Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, { price: null, history: [] }]));
const lastAlertTime = Object.fromEntries(DEFAULT_SYMBOLS.map((symbol) => [symbol, 0]));

let ws;
let reconnectTimer;
let reconnectIntentional = false;

function buildStreamUrl() {
  const streams = [...activeSymbols].map((symbol) => `${symbol.toLowerCase()}@trade`).join('/');
  return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

function ensureSymbolState(symbol) {
  if (!marketState[symbol]) marketState[symbol] = { price: null, history: [] };
  if (lastAlertTime[symbol] == null) lastAlertTime[symbol] = 0;
}

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
      [...activeSymbols].map((symbol) => [symbol, { price: marketState[symbol]?.price ?? null }])
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

function scheduleReconnect(delay = 3000) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBinance, delay);
}

function restartBinanceStream() {
  reconnectIntentional = true;
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  } else {
    connectBinance();
  }
}

function connectBinance() {
  reconnectIntentional = false;
  const streamUrl = buildStreamUrl();
  ws = new WebSocket(streamUrl);

  ws.on('open', () => {
    console.log(`Conectado ao WebSocket da Binance com ${activeSymbols.size} símbolos`);
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

      io.emit('price_update', { symbol, price, eventTime });

      const alert = checkAlert(symbol);
      if (alert) io.emit('price_alert', alert);
    } catch (error) {
      console.error('Erro ao processar mensagem:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket Binance fechado.');
    if (reconnectIntentional) {
      reconnectIntentional = false;
      connectBinance();
      return;
    }
    console.log('Reconectando em 3 segundos...');
    scheduleReconnect(3000);
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

function cleanSymbolInput(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '')
    .replace('/', '');
}

async function symbolExistsOnBinance(symbol) {
  const url = `https://api.binance.com/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return false;
  const data = await response.json();
  return data?.symbol === symbol || data?.symbols?.some((item) => item.symbol === symbol);
}

async function resolveSymbol(input) {
  const cleaned = cleanSymbolInput(input);
  if (!cleaned) throw new Error('Digite o nome da moeda ou par. Exemplo: XRP, XRPUSDT ou SPKUSDC.');

  const candidates = cleaned.endsWith('USDT') || cleaned.endsWith('USDC')
    ? [cleaned]
    : [`${cleaned}USDT`, `${cleaned}USDC`];

  for (const candidate of candidates) {
    if (activeSymbols.has(candidate)) return { symbol: candidate, alreadyExists: true };
  }

  for (const candidate of candidates) {
    try {
      const exists = await symbolExistsOnBinance(candidate);
      if (exists) return { symbol: candidate, alreadyExists: false };
    } catch (error) {
      console.error(`Falha ao validar ${candidate}:`, error.message);
    }
  }

  throw new Error(`Par não encontrado na Binance. Tente digitar completo, exemplo: ${cleaned}USDT ou ${cleaned}USDC.`);
}

async function addSymbol(input) {
  const { symbol, alreadyExists } = await resolveSymbol(input);
  ensureSymbolState(symbol);

  if (!alreadyExists) {
    activeSymbols.add(symbol);
    io.emit('symbols_update', getSnapshot());
    restartBinanceStream();
  }

  return { symbol, alreadyExists, snapshot: getSnapshot() };
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'crypto-alerts-server' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ...getSnapshot() });
});

app.post('/symbols', async (req, res) => {
  try {
    const result = await addSymbol(req.body?.symbol);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);
  socket.emit('initial_state', getSnapshot());

  socket.on('add_symbol', async (payload, callback) => {
    try {
      const result = await addSymbol(payload?.symbol || payload);
      callback?.({ ok: true, ...result });
    } catch (error) {
      callback?.({ ok: false, message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor escutando na porta ${PORT}`);
  connectBinance();
});
