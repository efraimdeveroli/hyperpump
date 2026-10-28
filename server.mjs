// HYPERPUMP early-access server. Zero npm dependencies (Node >= 22.5).
// Coins launch on pump.fun with creator fees locked to a treasury. Fees are meant to fund a leveraged
// Hyperliquid perp position (not built yet: this server only lists coins and tracks fee progress).
// Env: PORT, DATA_DIR (sqlite location, mount a volume here), RPC_URL (use a paid RPC),
//      PINATA_JWT (metadata/image pinning), MOCK=1 (no external calls, for local testing)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkFeesLockedToTreasury } from './verify.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dir, 'public');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dir, 'data');
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PINATA_JWT = process.env.PINATA_JWT || '';
const MOCK = process.env.MOCK === '1';
const THRESHOLD_USD = 50;
// Shown only if Hyperliquid's market list cannot be fetched. BTC 40x and ETH 25x match Pump.fun's announcement;
// SOL and HYPE are placeholders. The live list from Hyperliquid replaces this whenever it loads.
const FALLBACK_MARKETS = [
  { id: 'BTC', label: 'BTC', dex: null, maxLeverage: 40, price: null, vol: 0 },
  { id: 'ETH', label: 'ETH', dex: null, maxLeverage: 25, price: null, vol: 0 },
  { id: 'SOL', label: 'SOL', dex: null, maxLeverage: 20, price: null, vol: 0 },
  { id: 'HYPE', label: 'HYPE', dex: null, maxLeverage: 10, price: null, vol: 0 },
];
const MARKET_ID_RE = /^[A-Za-z0-9:_.\-]{1,40}$/;
const TREASURY = (process.env.TREASURY_ADDRESS || '').trim();
const FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

fs.mkdirSync(DATA_DIR, { recursive: true });
const IMG_DIR = path.join(DATA_DIR, 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_RE = /^\/img\/[a-f0-9]{40}\.(png|jpeg|gif|webp)$/;
const db = new DatabaseSync(path.join(DATA_DIR, 'hyperpump.db'));
db.exec(`create table if not exists coins(
  mint text primary key, creator text not null, vault text, name text not null, symbol text not null,
  uri text, image text, market text not null, side text not null, tier integer not null,
  signature text not null, created_at integer not null)`);
// Leverage is stored at launch so a later change on Hyperliquid cannot rewrite a coin's bet.
try { db.exec('alter table coins add column lev integer'); } catch { /* column already exists */ }

// MOCK=1 only: fill an empty local database with demo coins so the designs have something to show.
if (process.env.MOCK === '1' && !db.prepare('select 1 from coins limit 1').get()) {
  const demo = [
    ['HODLBTC', 'Diamond Hands', 'BTC', 'long', 10, 5], ['FADEIT', 'Fade It', 'ETH', 'short', 2, 20],
    ['HYPEBEAST', 'Hype Beast', 'HYPE', 'long', 5, 40], ['SOLSTICE', 'Solstice', 'SOL', 'long', 2, 75],
    ['BEARISH', 'Bearish Bob', 'xyz:TSLA', 'short', 10, 130], ['MOONCAT', 'Moon Cat', 'DOGE', 'long', 5, 300],
    ['LIQUID', 'Liquid Gold', 'ETH', 'long', 2, 600], ['PERPPEPE', 'Perp Pepe', 'kPEPE', 'short', 10, 1200],
  ];
  const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const fake = (seed, n) => { let s = ''; for (let i = 0; i < n; i++) s += b58[(seed * 7 + i * 13 + i * i) % b58.length]; return s; };
  const demoLev = { BTC: 40, ETH: 25, SOL: 20, HYPE: 10, 'xyz:TSLA': 10, DOGE: 10, kPEPE: 10 };
  demo.forEach(([symbol, name, market, side, tier, mins], i) => {
    db.prepare('insert into coins(mint,creator,vault,name,symbol,uri,image,market,side,tier,signature,created_at,lev) values(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(fake(i + 1, 40) + 'pump', fake(i + 20, 44), fake(i + 50, 44), name, symbol, null, null, market, side, tier, fake(i + 80, 88), Date.now() - mins * 60_000, demoLev[market]);
  });
}

const SIDES = ['long', 'short'];
const TIERS = [2, 5, 10];
// A tier closes at (tier x margin), a price move of (tier - 1) / leverage. Past this move the position can sit for months, so the tier is not offered.
const MAX_MOVE_PCT = 100;
// The HYPERPUMP token's contract address, shown on the site once it launches. Leave HYPERPUMP_CA unset until then.
const HP_CA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(process.env.HYPERPUMP_CA || '') ? process.env.HYPERPUMP_CA : null;
if (process.env.HYPERPUMP_CA && !HP_CA) console.error('HYPERPUMP_CA is not a valid Solana address, ignoring it.');
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_OK_TREASURY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const treasuryOk = B58_OK_TREASURY.test(TREASURY);
const B58SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// ---------- helpers ----------
const UPLOADS_PER_IP_HOUR = Number(process.env.UPLOADS_PER_IP_HOUR || 5);
const UPLOADS_PER_DAY = Number(process.env.UPLOADS_PER_DAY || 300);
let dayCount = { day: '', n: 0 };
function dailyCapHit() {
  const d = new Date().toISOString().slice(0, 10);
  if (dayCount.day !== d) dayCount = { day: d, n: 0 };
  return ++dayCount.n > UPLOADS_PER_DAY;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3_600_000)) hits.delete(k); }, 600_000).unref();
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readJson(req, limit = 2_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too_large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc_error');
  return j.result;
}

// ---------- Hyperliquid markets (cached) ----------
// Every perp on Hyperliquid can be picked: the main exchange plus builder-deployed exchanges (HIP-3, e.g. stocks).
// Builder markets are named "dex:COIN" (for example "xyz:TSLA"). Each builder exchange is fetched on its own so
// one failure only hides that exchange. If everything fails we serve the last good list, then a short fallback.
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const MARKETS_TTL = 5 * 60_000;
let marketCache = { at: 0, list: null, source: 'fallback' };
async function hl(body) {
  const r = await fetch(HL_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Hyperliquid answered ' + r.status);
  return r.json();
}
function parseUniverse(res, dex) {
  const meta = res && res[0], ctxs = (res && res[1]) || [];
  if (!meta || !Array.isArray(meta.universe)) return [];
  const out = [];
  meta.universe.forEach((u, i) => {
    if (!u || !u.name || u.isDelisted) return;
    const id = dex && !String(u.name).includes(':') ? dex + ':' + u.name : String(u.name);
    if (!MARKET_ID_RE.test(id)) return;
    const c = ctxs[i] || {};
    out.push({ id, label: id.includes(':') ? id.split(':').slice(1).join(':') : id, dex: dex || null,
      maxLeverage: Math.max(1, Math.floor(Number(u.maxLeverage) || 1)), price: Number(c.markPx) || null, vol: Number(c.dayNtlVlm) || 0 });
  });
  return out;
}
function mockMarkets() {
  const main = 'BTC:40:81556 ETH:25:2422.5 SOL:20:104.42 HYPE:10:47.31 DOGE:10:0.1832 XRP:20:2.41 AVAX:10:31.2 LINK:10:15.8 SUI:10:3.62 ARB:10:0.54 OP:10:1.12 APT:10:7.4 TIA:10:4.9 INJ:10:19.3 SEI:10:0.31 WIF:5:1.94 kPEPE:10:0.0126 kBONK:10:0.0211 kSHIB:10:0.0148 PENDLE:10:4.8 ENA:10:0.62 AAVE:10:212 UNI:10:7.9 NEAR:10:3.3 TON:10:2.9 FARTCOIN:10:0.82 POPCAT:5:0.41 TRUMP:10:8.6 PUMP:10:0.0041 JUP:10:0.52 ONDO:10:0.94 TAO:10:318 ZEC:10:58 LTC:10:88 BNB:10:640 ADA:10:0.62 DOT:10:4.1'.split(' ');
  const xyz = 'TSLA:10:312 NVDA:20:171 AAPL:20:236 MSFT:20:455 XYZ100:25:24500 GOLD:25:3980 SILVER:10:48.2'.split(' ');
  const row = (s, dex) => { const [n, l, p] = s.split(':'); const id = dex ? dex + ':' + n : n; return { id, label: n, dex: dex || null, maxLeverage: Number(l), price: Number(p), vol: (id.length * 7919 % 1000) * 1e6 + (n === 'BTC' ? 9e9 : n === 'ETH' ? 5e9 : 0) }; };
  return main.map(s => row(s)).concat(xyz.map(s => row(s, 'xyz')));
}
async function markets() {
  if (MOCK) return { list: mockMarkets(), source: 'mock' };
  if (marketCache.list && Date.now() - marketCache.at < MARKETS_TTL) return marketCache;
  try {
    const [main, dexs] = await Promise.all([hl({ type: 'metaAndAssetCtxs' }), hl({ type: 'perpDexs' }).catch(() => [])]);
    let list = parseUniverse(main, null);
    if (!list.length) throw new Error('empty market list');
    const names = (Array.isArray(dexs) ? dexs : []).filter(d => d && d.name).map(d => String(d.name));
    const extra = await Promise.allSettled(names.map(n => hl({ type: 'metaAndAssetCtxs', dex: n }).then(r => parseUniverse(r, n))));
    extra.forEach(r => { if (r.status === 'fulfilled') list = list.concat(r.value); });
    const seen = new Set(); list = list.filter(m => !seen.has(m.id) && seen.add(m.id));
    list.sort((a, b) => b.vol - a.vol);
    marketCache = { at: Date.now(), list, source: 'hyperliquid' };
  } catch (e) {
    console.error('markets:', e.message || e);
    if (marketCache.list) marketCache = { ...marketCache, at: Date.now() - MARKETS_TTL + 30_000 }; // keep stale list, retry in 30s
    else marketCache = { at: Date.now() - MARKETS_TTL + 30_000, list: FALLBACK_MARKETS, source: 'fallback' };
  }
  return marketCache;
}

// ---------- SOL price for converting fee balances (cached) ----------
let solCache = { at: 0, v: null };
async function solUsd() {
  if (MOCK) return 104.42;
  if (solCache.v && Date.now() - solCache.at < 60_000) return solCache.v;
  try {
    const m = (await markets()).list.find(x => x.id === 'SOL');
    if (m && m.price) { solCache = { at: Date.now(), v: m.price }; return m.price; }
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); solCache = { at: Date.now(), v: j.solana.usd }; return j.solana.usd;
  } catch { return solCache.v; } // may be null, UI handles it
}

// ---------- creator fee balance (cached per vault) ----------
const feeCache = new Map();
async function vaultSol(vault) {
  if (!vault) return null;
  if (MOCK) return Number('0.' + (parseInt(vault.slice(0, 4), 36) % 90 + 5)) / 1.4;
  const c = feeCache.get(vault);
  if (c && Date.now() - c.at < 30_000) return c.v;
  try {
    const r = await rpc('getBalance', [vault, { commitment: 'confirmed' }]);
    // The vault is a program-owned account, so subtract rent-exempt minimum for a 0-data account.
    const v = Math.max(0, (r.value - 890880) / 1e9);
    feeCache.set(vault, { at: Date.now(), v }); return v;
  } catch { return c ? c.v : null; }
}

// ---------- API ----------
async function coinsApi() {
  const rows = db.prepare('select * from coins order by created_at desc limit 60').all();
  const sp = await solUsd();
  const byId = new Map((await markets()).list.map(m => [m.id, m]));
  const out = [];
  for (const r of rows) out.push(await coinOut(r, sp, byId));
  return { thresholdUsd: THRESHOLD_USD, coins: out };
}
async function coinOut(r, sp, byId) {
  const sol = await vaultSol(r.vault);
  const usd = sol != null && sp ? sol * sp : null;
  return { mint: r.mint, creator: r.creator, name: r.name, symbol: r.symbol, image: r.image,
    market: r.market, side: r.side, tier: r.tier, lev: r.lev || (byId.get(r.market) || {}).maxLeverage || null, createdAt: r.created_at,
    feeSol: sol, feeUsd: usd, ready: usd != null && usd >= THRESHOLD_USD };
}
async function coinApi(mint) {
  const r = db.prepare('select * from coins where mint = ?').get(mint);
  if (!r) return null;
  const byId = new Map((await markets()).list.map(m => [m.id, m]));
  return { thresholdUsd: THRESHOLD_USD, coin: await coinOut(r, await solUsd(), byId) };
}

async function upload(body) {
  if (!treasuryOk) throw new Error('Launching is paused.');
  const { name, symbol, description, image } = body;
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) throw new Error('Image must be a PNG, JPG, GIF or WEBP.');
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 1_000_000) throw new Error('Image must be under 1 MB.');
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const local = '/img/' + hash + '.' + m[2];
  fs.writeFileSync(path.join(IMG_DIR, hash + '.' + m[2]), bytes);
  if (MOCK) return { uri: 'https://example.invalid/meta.json', image: local };
  if (!PINATA_JWT) throw new Error('Server is missing PINATA_JWT.');
  const auth = { Authorization: 'Bearer ' + PINATA_JWT };
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: m[1] }), 'coin.' + m[2]);
  const r1 = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: auth, body: fd });
  const j1 = await r1.json(); if (!j1.IpfsHash) throw new Error('Image upload failed.');
  const imgUrl = 'https://ipfs.io/ipfs/' + j1.IpfsHash;
  const meta = { name, symbol, description: description || '', image: imgUrl, showName: true, createdOn: 'https://pump.fun' };
  const r2 = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', { method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pinataContent: meta }) });
  const j2 = await r2.json(); if (!j2.IpfsHash) throw new Error('Metadata upload failed.');
  return { uri: 'https://ipfs.io/ipfs/' + j2.IpfsHash, image: local };
}

async function buyTx(body) {
  const { publicKey, mint, amountSol } = body;
  if (!B58.test(publicKey || '') || !B58.test(mint || '')) throw new Error('Bad key.');
  const amt = Number(amountSol);
  if (!(amt > 0 && amt <= 5)) throw new Error('Buy must be above 0 and at most 5 SOL.');
  if (!db.prepare('select 1 from coins where mint = ?').get(mint)) throw new Error('Unknown coin.');
  if (MOCK) return Buffer.from('mock-transaction').toString('base64');
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount: amt, slippage: 10, priorityFee: 0.0005, pool: 'pump' }),
    signal: AbortSignal.timeout(20000) });
  if (r.status !== 200) throw new Error('pump.fun refused the buy request (' + r.status + ').');
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function confirmLaunch(body) {
  const { mint, creator, vault, sharingConfig, signature, name, symbol, uri, image, market, side, tier } = body;
  if (!treasuryOk) throw new Error('Launching is paused.');
  if (!B58.test(sharingConfig || '')) throw new Error('Missing fee-sharing config.');
  if (!B58.test(mint || '') || !B58.test(creator || '') || !B58SIG.test(signature || '')) throw new Error('Bad input.');
  if (vault && !B58.test(vault)) throw new Error('Bad vault.');
  if (!SIDES.includes(side) || !TIERS.includes(Number(tier))) throw new Error('Bad settings.');
  if (!MARKET_ID_RE.test(market || '')) throw new Error('Bad market.');
  const mk = (await markets()).list.find(m => m.id === market);
  if (!mk) throw new Error("That market isn't on Hyperliquid's list right now.");
  if ((Number(tier) - 1) / mk.maxLeverage * 100 > MAX_MOVE_PCT) throw new Error('That take-profit needs too big a move at ' + mk.maxLeverage + 'x. Pick a lower tier or a higher-leverage market.');
  if (!name || name.length > 32 || !symbol || symbol.length > 10) throw new Error('Bad name or ticker.');
  if (!MOCK) {
    let why = 'unchecked';
    for (let i = 0; i < 4 && why; i++) {
      if (i) await new Promise(r => setTimeout(r, 1500));
      const info = await rpc('getAccountInfo', [sharingConfig, { encoding: 'base64', commitment: 'confirmed' }]);
      why = checkFeesLockedToTreasury(info && info.value, mint, TREASURY, FEES_PROGRAM);
    }
    if (why) throw new Error(why + " This coin can't be listed because its fees aren't locked to the treasury.");
  }
  if (!MOCK) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!tx || tx.meta?.err) throw new Error('That transaction did not succeed.');
    const keys = tx.transaction.message.accountKeys;
    const has = (k, signer) => keys.some(a => a.pubkey === k && (!signer || a.signer));
    if (!has(mint, true) || !has(creator, true)) throw new Error('Transaction does not match this launch.');
  }
  db.prepare(`insert or ignore into coins(mint,creator,vault,name,symbol,uri,image,market,side,tier,signature,created_at,lev)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(mint, creator, vault || null, name, symbol.toUpperCase(), uri || null,
    image && IMG_RE.test(image) ? image : null, market, side, Number(tier), signature, Date.now(), mk.maxLeverage);
  return { ok: true };
}

const RPC_ALLOW = new Set(['sendTransaction', 'getSignatureStatuses', 'getLatestBlockhash', 'getBalance', 'getBlockHeight']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // PAUSED=1: take the whole site offline (a plain page, no API, no launches). Unset the variable to bring it back.
    if (process.env.PAUSED === '1') {
      if (url.pathname.startsWith('/api/')) return send(res, 503, { error: 'paused' });
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '3600', 'cache-control': 'no-store' });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HYPERPUMP</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#081114;color:#E4F5F1;font:600 20px system-ui,sans-serif;text-align:center;padding:24px"><div><div style="font-weight:900;font-size:34px;letter-spacing:-.02em">HYPER<span style="color:#97FCE4">PUMP</span></div><p style="margin-top:14px;color:#82A69E">Paused for now. Back soon.</p></div>');
    }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',').pop().trim();
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname.startsWith('/api/coin/')) {
        const mint = decodeURIComponent(url.pathname.slice(10));
        if (!/^[A-Za-z0-9]{20,64}$/.test(mint)) return send(res, 404, { error: 'not found' });
        const d = await coinApi(mint);
        return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/coins') return send(res, 200, await coinsApi());
      if (req.method === 'GET' && url.pathname === '/api/vault') {
        const row = db.prepare('select vault, creator from coins where mint = ?').get(url.searchParams.get('mint') || '');
        if (!row) return send(res, 404, { error: 'unknown mint' });
        if (MOCK) return send(res, 200, { vault: row.vault, creator: row.creator, mock: true });
        const info = await rpc('getAccountInfo', [row.vault, { encoding: 'base64', commitment: 'confirmed' }]);
        const v = info && info.value;
        return send(res, 200, { vault: row.vault, creator: row.creator, exists: !!v,
          lamports: v ? v.lamports : 0, owner: v ? v.owner : null, dataBytes: v ? Buffer.from(v.data[0], 'base64').length : 0 });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { treasury: treasuryOk ? TREASURY : null, thresholdUsd: THRESHOLD_USD, maxMovePct: MAX_MOVE_PCT, ca: HP_CA });
      if (req.method === 'GET' && url.pathname === '/api/markets') { const m = await markets(); return send(res, 200, { source: m.source, markets: m.list }); }
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, mock: MOCK, pinata: !!PINATA_JWT, treasury: treasuryOk });
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      if (limited(ip, 'p', 60, 60_000)) return send(res, 429, { error: 'Slow down.' });
      if (url.pathname === '/api/upload') {
        if (limited(ip, 'u', UPLOADS_PER_IP_HOUR, 3_600_000)) return send(res, 429, { error: 'Too many launches from your connection. Try again in an hour.' });
        if (dailyCapHit()) return send(res, 429, { error: 'Launch limit reached for today. Try again tomorrow.' });
      }
      if (url.pathname === '/api/launch/buy' && limited(ip, 't', 10, 3_600_000)) return send(res, 429, { error: 'Too many launch attempts. Try again in an hour.' });
      const body = await readJson(req, 3_000_000);
      if (url.pathname === '/api/upload') return send(res, 200, await upload(body));
      if (url.pathname === '/api/launch/buy') return send(res, 200, { tx: await buyTx(body) });
      if (url.pathname === '/api/launch/confirm') return send(res, 200, await confirmLaunch(body));
      if (url.pathname === '/api/rpc') {
        if (!RPC_ALLOW.has(body.method)) return send(res, 400, { error: 'method not allowed' });
        if (MOCK) return send(res, 200, { jsonrpc: '2.0', id: body.id, result: mockRpc(body) });
        const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params }) });
        return send(res, r.status, await r.text());
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && IMG_RE.test(url.pathname)) {
      const f = path.join(IMG_DIR, path.basename(url.pathname));
      if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      const ext = path.extname(f).slice(1);
      res.writeHead(200, { 'content-type': 'image/' + ext, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(f));
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname.startsWith('/coin/') ? '/coin.html' : url.pathname === '/docs' ? '/docs.html' : url.pathname === '/launch' ? '/launch.html' : url.pathname;
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    if (path.extname(f) === '.html') {
      // share-card tags need absolute URLs: PUBLIC_URL if set, else the host this request came in on
      const origin = (process.env.PUBLIC_URL || (req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host).replace(/\/$/, '');
      return send(res, 200, fs.readFileSync(f, 'utf8').replaceAll('__ORIGIN__', origin.replace(/[<>"&]/g, '')), types['.html']);
    }
    send(res, 200, fs.readFileSync(f), types[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});
function mockRpc(b) {
  if (b.method === 'sendTransaction') return '5'.repeat(88);
  if (b.method === 'getLatestBlockhash') return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 } };
  if (b.method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
  return null;
}
server.listen(PORT, () => console.log(`hyperpump on :${PORT}${MOCK ? ' (MOCK)' : ''}`));
