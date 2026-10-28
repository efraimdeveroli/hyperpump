/* HYPERPUMP shared front-end logic. Every design page loads this file and supplies its own markup and CSS.
   Hooks the markup must provide (all optional unless marked):
   - .js-wallet            any number of buttons; opens the wallet dialog and shows the short address once connected
   - #ov #db #dt #dx       wallet dialog (required)
   - #sl #ss               long / short buttons         - #mk (market buttons are rendered here: every Hyperliquid perp) + #mksearch (search box) + #mkhint (count line)
   - [data-x]              take-profit tier buttons
   - [data-price="SOL"]    price text per market        - [data-lev="SOL"] leverage text per market
   - #nm #tk #img #thumb #ds #db2 #ok #go #found #sum #tpnote #tnote   launch form (required on the page that launches)
   - #cards #feed          explore grid and latest feed - [data-stat="coins|fees|ready"]  - [data-thr]  threshold text
   Designs can replace how coins render by setting window.HP.card / HP.line / HP.empty before this file runs. */
var HP = window.HP = window.HP || {};
var $ = function (i) { return document.getElementById(i); };
var WEB3 = 'https://esm.sh/@solana/web3.js@1.98.2';
var SDK = 'https://esm.sh/@pump-fun/pump-sdk@4.1.0?deps=@solana/web3.js@1.98.2';
var NATIVE_MINT = 'So11111111111111111111111111111111111111112', TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
var PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
var treasury = null, cfgLoaded = false, THR = 50, MAXMOVE = 100;
var LEV = { BTC: 40, ETH: 25, SOL: 20, HYPE: 10 }, MARKETS = [], LABEL = {}, FEATURED = ['BTC', 'ETH', 'SOL', 'HYPE'], PICK_N = 8;
var TIER = { 2: 'Chill', 5: 'Degen', 10: 'Hyper-Degen' };
var PRICE = {};
var ov = $('ov'), dbx = $('db'), dt = $('dt');
var walletBtns = [].slice.call(document.querySelectorAll('.js-wallet'));
walletBtns.forEach(function (b) { b.dataset.label = b.textContent; });
var acct = null, provider = null, lastFocus = null;

function short(a) { return a.slice(0, 4) + '…' + a.slice(-4); }
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function ago(t) { var s = Math.max(1, Math.round((Date.now() - t) / 1000)); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd'; }
function fmtPrice(k, v) {
  if (!isFinite(v) || v <= 0) return '…';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + v.toPrecision(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
function mlabel(id) { return LABEL[id] || String(id).split(':').slice(1).join(':') || id; }
function fmtUsd(v) { return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function api(path, body) {
  var ac = new AbortController(), tm = setTimeout(function () { ac.abort(); }, 30000);
  return fetch(path, body === undefined ? { signal: ac.signal } : { signal: ac.signal, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .finally(function () { clearTimeout(tm); })
    .then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) {
          var e = j.error, msg = e && typeof e === 'object' ? (e.message || JSON.stringify(e)) : (e || ('HTTP ' + r.status));
          var logs = e && e.data && e.data.logs; if (logs && logs.length) msg += ' | ' + logs.slice(-5).join(' | ');
          throw new Error(msg);
        }
        return j;
      });
    });
}
HP.u = { label: function (s) { return mlabel(s); }, esc: esc, ago: ago, short: short, fmtUsd: fmtUsd, TIER: TIER, lev: function (s) { return LEV[s]; }, price: function (s) { return PRICE[s]; } };

/* ---------- wallets (injected providers, no library) ---------- */
function walletList() {
  var w = window, list = [];
  var ph = w.phantom && w.phantom.solana && w.phantom.solana.isPhantom ? w.phantom.solana : null;
  list.push({ name: 'Phantom', p: ph, url: 'https://phantom.app' });
  list.push({ name: 'Solflare', p: w.solflare && w.solflare.isSolflare ? w.solflare : null, url: 'https://solflare.com' });
  list.push({ name: 'Backpack', p: w.backpack && w.backpack.isBackpack ? w.backpack : null, url: 'https://backpack.app' });
  var known = list.some(function (x) { return x.p === w.solana; });
  if (w.solana && !known) list.push({ name: 'Browser wallet', p: w.solana, url: '' });
  return list;
}
function renderList() {
  dt.textContent = 'Connect wallet';
  dbx.innerHTML = '<p>Choose a Solana wallet.</p>' + walletList().map(function (x, i) {
    return x.p ? '<button class="wopt" data-i="' + i + '"><i>' + x.name[0] + '</i><span>' + x.name + '</span><em>detected</em></button>'
      : '<button class="wopt" disabled><i>' + x.name[0] + '</i><span>' + x.name + '</span><em>not installed</em></button>';
  }).join('');
  var f = dbx.querySelector('.wopt:not([disabled])'); if (f) f.focus();
}
function renderMsg(title, html) { dt.textContent = title; dbx.innerHTML = html; }
function setWalletLabel() { walletBtns.forEach(function (b) { b.textContent = acct ? short(acct) : b.dataset.label; }); }
function renderAcct() {
  dt.textContent = 'Wallet';
  dbx.innerHTML = '<div class="acct"><div class="a1">Connected</div><div class="a2">' + esc(acct) + '</div></div>' +
    '<div class="drow"><button class="btn" id="cp">Copy address</button><button class="btn red" id="dc">Disconnect</button></div>';
  $('cp').onclick = function () {
    var b = $('cp'); var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy address'; }, 1200); };
    try { navigator.clipboard.writeText(acct).then(done, function () {}); } catch (x) {}
  };
  $('dc').onclick = function () {
    try { provider && provider.disconnect && provider.disconnect(); } catch (x) {}
    acct = null; provider = null; setWalletLabel(); closeM(); refresh();
  };
  $('dc').focus();
}
function openM() { lastFocus = document.activeElement; ov.hidden = false; if (acct) renderAcct(); else renderList(); }
function closeM() { ov.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
walletBtns.forEach(function (b) { b.onclick = openM; });
$('dx').onclick = closeM;
ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeM(); });
addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) closeM(); });
dbx.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('.wopt'); if (!b || b.disabled) return;
  var x = walletList()[Number(b.dataset.i)];
  renderMsg('Connecting', '<div class="cn">Connecting to ' + x.name + '…<span class="cur"></span></div><p>Approve the request in your wallet.</p>');
  Promise.resolve(x.p.connect()).then(function (r) {
    var pk = (r && r.publicKey) || x.p.publicKey; if (!pk) throw new Error('No account returned.');
    acct = pk.toString(); provider = x.p; setWalletLabel(); closeM(); refresh();
  }).catch(function (err) {
    renderMsg('Connection failed', '<p>' + esc(err && err.message || 'Connection was cancelled.') + '</p><button class="btn" id="rt">Try again</button>');
    $('rt').onclick = renderList;
  });
});

/* ---------- launch form ---------- */
var side = 'long', tpx = 2, sym = 'BTC', imgData = null, busy = false;
var HASFORM = !!$('go');
var nm = $('nm'), tk = $('tk'), ok = $('ok'), go = $('go'), found = $('found'), buy = $('db2');
function pressed(sel, fn) { document.querySelectorAll(sel).forEach(function (b) { b.setAttribute('aria-pressed', fn(b)); }); }
function buyVal() { var n = Number(String(buy.value).replace(',', '.')); return isFinite(n) && n >= 0 && n <= 5 ? n : null; }
/* ---------- market picker: every Hyperliquid perp, searchable ---------- */
var mk = $('mk'), mkq = $('mksearch'), mkhint = $('mkhint');
function mkButton(m) {
  return '<button type="button" data-sym="' + esc(m.id) + '" aria-pressed="' + (m.id === sym) + '"><b>' + esc(m.label) + '</b><span>' + esc(PRICE[m.id] || '…') + '</span><em>' + m.maxLeverage + 'x' + (m.dex ? ' ' + esc(m.dex) : '') + '</em></button>';
}
function pickList() {
  var q = mkq ? mkq.value.trim().toLowerCase() : '';
  if (q) {
    var hits = MARKETS.filter(function (m) { return m.id.toLowerCase().indexOf(q) >= 0 || (m.dex ? (m.dex + ' ' + m.label).toLowerCase().indexOf(q) >= 0 : false); });
    hits.sort(function (a, b) { var as = a.label.toLowerCase().indexOf(q) === 0 ? 0 : 1, bs = b.label.toLowerCase().indexOf(q) === 0 ? 0 : 1; return as - bs || b.vol - a.vol; });
    return { list: hits.slice(0, PICK_N * 2), total: hits.length, q: q };
  }
  var by = {}; MARKETS.forEach(function (m) { by[m.id] = m; });
  var out = [], seen = {};
  function add(m) { if (m && !seen[m.id]) { seen[m.id] = 1; out.push(m); } }
  FEATURED.forEach(function (k) { add(by[k]); });
  add(by[sym]);
  MARKETS.forEach(function (m) { if (out.length < PICK_N) add(m); });
  return { list: out, total: MARKETS.length, q: '' };
}
function renderMk() {
  if (!mk) return;
  if (!MARKETS.length) { mk.innerHTML = '<p class="mkhint">Loading markets…</p>'; return; }
  var r = pickList();
  mk.innerHTML = r.list.length ? r.list.map(mkButton).join('') : '<p class="mkhint">No Hyperliquid market matches "' + esc(r.q) + '".</p>';
  if (mkhint) mkhint.textContent = r.q ? r.total + (r.total === 1 ? ' match' : ' matches') + (r.total > r.list.length ? ', showing ' + r.list.length + '. Keep typing to narrow it.' : '.')
    : 'Showing ' + r.list.length + ' of ' + MARKETS.length + ' Hyperliquid perps. Search to find any of them, including stocks and other builder markets.';
}
function loadMarkets() {
  api('/api/markets').then(function (d) {
    MARKETS = (d.markets || []).filter(function (m) { return m && m.id; });
    MARKETS.forEach(function (m) { LEV[m.id] = m.maxLeverage; LABEL[m.id] = m.label; if (m.price) PRICE[m.id] = fmtPrice(m.id, m.price); });
    refresh();
    if (HP.afterMarkets) HP.afterMarkets(MARKETS);
  }).catch(function () { if (mk && !MARKETS.length) mk.innerHTML = '<p class="mkhint">Could not load markets. Reload to try again.</p>'; });
}
if (mk) {
  mk.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-sym]'); if (b) { sym = b.dataset.sym; refresh(); } });
}
if (mkq) mkq.addEventListener('input', function () { renderMk(); });

function refresh() {
  renderMk();
  pressed('#sl,#ss', function (b) { return (b.id === 'sl') === (side === 'long'); });
  pressed('[data-sym]', function (b) { return b.dataset.sym === sym; });
  pressed('[data-x]', function (b) { return Number(b.dataset.x) === tpx; });
  document.querySelectorAll('[data-price]').forEach(function (e) { e.textContent = PRICE[e.dataset.price] || '…'; });
  document.querySelectorAll('[data-lev]').forEach(function (e) { e.textContent = (LEV[e.dataset.lev] ? LEV[e.dataset.lev] + 'x' : '…'); });
  document.querySelectorAll('[data-thr]').forEach(function (e) { e.textContent = THR; });
  document.querySelectorAll('[data-bust]').forEach(function (e) { e.textContent = (100 / (LEV[e.dataset.bust] || 10)).toFixed(1) + '%'; });
  document.querySelectorAll('[data-pos]').forEach(function (e) { e.textContent = '$' + (THR * (LEV[e.dataset.pos] || 10)).toLocaleString('en-US'); });
  var L = LEV[sym] || 10;
  /* A tier closes at tier x margin, a price move of (tier - 1) / leverage. Tiers that need more than MAXMOVE % are switched off. */
  var okTiers = [];
  document.querySelectorAll('[data-x]').forEach(function (b) {
    var x = Number(b.dataset.x), m = (x - 1) / L * 100, off = m > MAXMOVE, sp = b.querySelector('span');
    b.disabled = off; b.title = off ? 'Needs a ' + Math.round(m) + '% move at ' + L + 'x. Pick a higher-leverage market to use this tier.' : '';
    if (sp) sp.textContent = x + 'x · ' + (m < 10 ? m.toFixed(1) : Math.round(m)) + '% move';
    if (!off) okTiers.push(x);
  });
  if (okTiers.length && okTiers.indexOf(tpx) < 0) { tpx = okTiers.filter(function (x) { return x < tpx; }).pop() || okTiers[0]; pressed('[data-x]', function (b) { return Number(b.dataset.x) === tpx; }); }
  var mv = ((tpx - 1) / L * 100).toFixed(1), bust = (100 / L).toFixed(1);
  if ($('tpnote')) $('tpnote').innerHTML = TIER[tpx] + ': closes and burns when the position is worth <b>' + tpx + 'x</b> its margin, a move of about <b>' + mv + '%</b> your way. It busts at about <b>' + bust + '%</b> against you. Roughly <b>1 in ' + tpx + '</b> positions get there first, before fees, funding and slippage.';
  if (!HASFORM) return;
  var t = tk.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TICKER', n = nm.value.trim() || 'Coin name';
  if ($('sum')) $('sum').innerHTML = '<span class="t">$' + esc(t) + '</span> · ' + esc(n) + '<br>' + side + ' ' + esc(mlabel(sym)) + ' at ' + L + 'x · ' + TIER[tpx] + ' ' + tpx + 'x<br><span class="d">$' + THR + ' of fees opens a $' + (THR * L).toLocaleString('en-US') + ' position · profit: 80% buys and burns your coin, 20% buys and burns HYPERPUMP</span>';
  go.disabled = busy || !(ok.checked && nm.value.trim() && tk.value.trim() && imgData && buyVal() !== null);
  go.textContent = !cfgLoaded ? 'Loading…' : !treasury ? 'Launching is paused' : acct ? 'Launch coin' : 'Connect wallet to launch';
  if (cfgLoaded && !treasury) go.disabled = true;
}
if (HASFORM) { $('sl').onclick = function () { side = 'long'; refresh(); }; $('ss').onclick = function () { side = 'short'; refresh(); }; }
if (HASFORM) document.querySelectorAll('[data-x]').forEach(function (b) { b.onclick = function () { tpx = Number(b.dataset.x); refresh(); }; });
if (HASFORM) [nm, tk, ok, buy].forEach(function (e) { e.addEventListener('input', refresh); e.addEventListener('change', refresh); });
if (HASFORM) $('img').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0]; imgData = null; $('thumb').style.backgroundImage = '';
  if (!f) { refresh(); return; }
  if (f.size > 1000000) { found.innerHTML = '<span class="err">Image must be under 1 MB.</span>'; e.target.value = ''; refresh(); return; }
  found.textContent = '';
  var r = new FileReader(); r.onload = function () { imgData = r.result; $('thumb').style.backgroundImage = 'url(' + r.result + ')'; refresh(); }; r.readAsDataURL(f);
});
function say(html) { found.innerHTML = html; }
function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); }
function unb64(t) { return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function rpc(method, params) { return api('/api/rpc', { jsonrpc: '2.0', id: 1, method: method, params: params }).then(function (j) { if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result; }); }

var COMPUTE_UNITS = 600000, PRIORITY_MICROLAMPORTS = 100000, MAX_TX_BYTES = 1232;
function withTimeout(p, ms, msg) { return new Promise(function (res, rej) { var t = setTimeout(function () { rej(new Error(msg)); }, ms); Promise.resolve(p).then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); }); }
async function submit(tx, label) {
  var hint = setTimeout(function () { say((label || 'Approve in your wallet') + '… No popup? Click your wallet extension icon: the request may be waiting there.'); }, 8000);
  var signed;
  try { signed = await withTimeout(provider.signTransaction(tx), 180000, 'Your wallet did not respond. Open your wallet extension, reject any pending request, then try again.'); }
  finally { clearTimeout(hint); }
  say('Sending to the network…');
  var sig = null, raw = b64(signed.serialize());
  for (var k = 0; k < 5 && !sig; k++) {
    try { sig = await rpc('sendTransaction', [raw, { encoding: 'base64', maxRetries: 5, preflightCommitment: 'confirmed' }]); }
    catch (es) {
      if (k < 4 && /Blockhash not found/i.test(String(es && es.message))) { await sleep(1500); continue; }
      throw es;
    }
  }
  for (var i = 0; i < 40; i++) {
    await sleep(1500);
    var st = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
    var s0 = st && st.value && st.value[0];
    if (s0 && s0.err) throw new Error('The transaction failed on-chain.');
    if (s0 && (s0.confirmationStatus === 'confirmed' || s0.confirmationStatus === 'finalized')) return sig;
  }
  throw new Error('Not confirmed yet. Check ' + sig.slice(0, 8) + '… on a block explorer.');
}
async function buildTx(W, ixs) {
  var bh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  var cb = [W.ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }), W.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS })];
  var msg = new W.TransactionMessage({ payerKey: new W.PublicKey(acct), recentBlockhash: bh.value.blockhash, instructions: cb.concat(ixs) }).compileToV0Message();
  return new W.VersionedTransaction(msg);
}
async function launch() {
  if (!acct) { openM(); return; }
  if (!treasury) return;
  busy = true; refresh();
  var mintAddr = null;
  try {
    var name = nm.value.trim(), symbol = tk.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!symbol) throw new Error('Ticker needs letters or numbers.');
    say('1/4 Uploading image and metadata…');
    var up = await api('/api/upload', { name: name, symbol: symbol, description: $('ds').value.trim(), image: imgData });
    say('2/4 Loading Solana tools…');
    var W = await import(WEB3), S = await import(SDK);
    var mint = W.Keypair.generate(); mintAddr = mint.publicKey.toBase58();
    var me = new W.PublicKey(acct);
    var ixCreate = await S.PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: name, symbol: symbol, uri: up.uri, creator: me, user: me, mayhemMode: false });
    var ixCfg = await S.PUMP_SDK.createFeeSharingConfig({ creator: me, mint: mint.publicKey, pool: null });
    var ixUpd = await S.PUMP_SDK.updateFeeSharesV2({ authority: me, mint: mint.publicKey, currentShareholders: [me],
      newShareholders: [{ address: new W.PublicKey(treasury), shareBps: 10000 }], quoteMint: new W.PublicKey(NATIVE_MINT), quoteTokenProgram: new W.PublicKey(TOKEN_PROGRAM) });
    /* One transaction if it fits Solana's size limit (1232 bytes), else split into the fewest steps that fit. */
    var fits = function (t) { try { return t.serialize().length <= MAX_TX_BYTES; } catch (e) { return false; } };
    var groups = [[ixCreate, ixCfg, ixUpd]];
    if (!fits(await buildTx(W, groups[0]))) {
      groups = fits(await buildTx(W, [ixCfg, ixUpd])) ? [[ixCreate], [ixCfg, ixUpd]] : [[ixCreate], [ixCfg], [ixUpd]];
    }
    var sig = null;
    for (var gi = 0; gi < groups.length; gi++) {
      say('Preparing step ' + (gi + 1) + ' of ' + groups.length + '…');
      var gtx = await buildTx(W, groups[gi]);
      say(gi === 0 ? '3/4 Approve the launch in your wallet…' : '3/4 Approve step ' + (gi + 1) + ' of ' + groups.length + ' (locks the coin\'s fees to the treasury)…');
      if (gi === 0) gtx.sign([mint]);
      try {
        var gs = await submit(gtx, gi === 0 ? '3/4 Approve the launch in your wallet' : '3/4 Approve step ' + (gi + 1) + ' of ' + groups.length);
        if (gi === 0) sig = gs;
      } catch (eg) {
        if (gi === 0) throw eg;
        throw new Error('Your coin was created, but its fees could not be locked to the treasury, so it will not be listed. ' + (eg && eg.message || '') + ' Mint: ' + mintAddr);
      }
    }
    say('4/4 Checking the fee settings on-chain…');
    var cfgPk = S.feeSharingConfigPda(mint.publicKey);
    var vault = W.PublicKey.findProgramAddressSync([new TextEncoder().encode('creator-vault'), cfgPk.toBytes()], new W.PublicKey(PUMP))[0].toBase58();
    await api('/api/launch/confirm', { mint: mintAddr, creator: acct, vault: vault, sharingConfig: cfgPk.toBase58(), signature: sig, name: name, symbol: symbol, uri: up.uri, image: up.image, market: sym, side: side, tier: tpx });
    var links = '<a href="https://pump.fun/coin/' + mintAddr + '" target="_blank" rel="noopener">View on pump.fun</a>' + (HP.exploreHref ? ' · <a href="' + HP.exploreHref + '">See it in Explore</a>' : '');
    loadCoins();
    var amt = buyVal(), note = '';
    if (amt > 0) {
      try {
        say('Launched. Approve your initial buy of ' + amt + ' SOL in your wallet…');
        var bt = await api('/api/launch/buy', { publicKey: acct, mint: mintAddr, amountSol: amt });
        await submit(W.VersionedTransaction.deserialize(unb64(bt.tx)));
      } catch (eb) { note = ' <span class="err">Initial buy did not go through: ' + esc(eb && eb.message || 'failed') + '</span>'; }
    }
    say('<span class="g">Launched.</span> ' + links + note);
  } catch (err) {
    try { console.error('launch failed', err); } catch (x) {}
    say('<span class="err">' + esc(err && err.message || 'Launch failed.') + '</span>');
  } finally { busy = false; refresh(); }
}
if (HASFORM) go.onclick = launch;

/* ---------- explore ---------- */
HP.coinHref = HP.coinHref || function (mint) { return '/coin/' + mint; };
HP.card = HP.card || function (c, d) {
  var usd = c.feeUsd, pct = usd == null ? 0 : Math.min(100, Math.round(usd / d.thresholdUsd * 100));
  var line = usd == null ? 'fees loading' : fmtUsd(usd) + ' of $' + d.thresholdUsd + ' · ' + (c.ready ? 'ready, waiting for Hyperliquid' : pct + '% to open');
  var av = c.image ? '<img class="av" alt="" src="' + esc(c.image) + '" loading="lazy" onerror="this.remove()">' : '';
  return '<a class="card" href="' + esc(HP.coinHref(c.mint)) + '"><b>' + av + '$' + esc(c.symbol) + '</b> ' + esc(c.side) + ' ' + esc(c.market) + ' ' + (c.lev || '') + 'x<div class="bar"><i style="width:' + pct + '%"></i></div><div class="to">' + esc(line) + '</div></a>';
};
HP.line = HP.line || function (c) {
  return '<div class="line"><span class="t">' + ago(c.createdAt) + '</span><span class="e g">LAUNCH</span><span class="n">$' + esc(c.symbol) + ' · ' + esc(c.market) + ' ' + esc(c.side) + '</span><span class="v d">' + esc(TIER[c.tier]) + ' ' + c.tier + 'x</span></div>';
};
HP.empty = HP.empty || function () { return '<p class="d">No coins yet. Launch the first one.</p>'; };
HP.limitCards = HP.limitCards || 12;
HP.limitFeed = HP.limitFeed || 8;
function loadCoins() {
  api('/api/coins').then(function (d) {
    if (d.thresholdUsd) THR = d.thresholdUsd;
    refresh();
    var coins = d.coins, fees = 0, ready = 0;
    coins.forEach(function (c) { c.marketId = c.market; c.market = mlabel(c.market); });
    coins.forEach(function (c) { if (c.feeUsd) fees += c.feeUsd; if (c.ready) ready++; });
    document.querySelectorAll('[data-stat]').forEach(function (e) {
      var k = e.dataset.stat; e.textContent = k === 'coins' ? coins.length : k === 'fees' ? fmtUsd(fees) : k === 'ready' ? ready : '';
    });
    var cards = $('cards'), feed = $('feed');
    if (!coins.length) { if (cards) cards.innerHTML = HP.empty(); if (feed) feed.innerHTML = '<p class="d">Nothing yet.</p>'; if (HP.afterCoins) HP.afterCoins(coins, d); return; }
    if (cards) cards.innerHTML = coins.slice(0, HP.limitCards).map(function (c) { return HP.card(c, d); }).join('');
    if (feed) feed.innerHTML = coins.slice(0, HP.limitFeed).map(function (c) { return HP.line(c, d); }).join('');
    if (HP.afterCoins) HP.afterCoins(coins, d);
  }).catch(function () { if ($('cards')) $('cards').innerHTML = '<p class="d">Could not load coins.</p>'; if ($('feed')) $('feed').innerHTML = ''; });
}
/* HYPERPUMP contract address bar: shows "Coming soon" until the server has HYPERPUMP_CA set */
function renderCa(ca) {
  var v = $('ca-v'); if (!v || !ca) return;
  v.textContent = ca; v.title = ca; v.classList.add('on');
  var cp = $('ca-copy'), lk = $('ca-link');
  if (cp) { cp.hidden = false; cp.onclick = function () {
    var done = function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy'; }, 1200); };
    try { navigator.clipboard.writeText(ca).then(done, function () { var r = document.createRange(); r.selectNodeContents(v); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }); } catch (x) {}
  }; }
  if (lk) { lk.href = 'https://pump.fun/coin/' + ca; lk.hidden = false; }
}
api('/api/config').then(function (c) {
  treasury = c.treasury; cfgLoaded = true;
  if (c.thresholdUsd) THR = c.thresholdUsd;
  if (c.maxMovePct) MAXMOVE = c.maxMovePct;
  renderCa(c.ca);
  if (treasury && $('tnote')) $('tnote').innerHTML = 'Creator fees from this coin go to the HYPERPUMP treasury: <a class="addr" href="https://solscan.io/account/' + esc(treasury) + '" target="_blank" rel="noopener">' + esc(treasury) + '</a>. That is set on-chain in the same transaction as your launch and cannot be changed afterward. You can check it on pump.fun or Solscan.';
  refresh();
}).catch(function () { cfgLoaded = true; refresh(); });
refresh(); loadMarkets(); setInterval(loadMarkets, 300000); loadCoins(); setInterval(loadCoins, 30000);

/* ---------- routing (only for designs that have #p-home, #p-launch, #p-how panels) ---------- */
function route() {
  var h = location.hash;
  var page = h === '#/launch' ? 'launch' : h === '#/how' ? 'how' : 'home';
  var any = false;
  ['home', 'launch', 'how'].forEach(function (p) { var e = $('p-' + p); if (e) { any = true; e.hidden = (p !== page); } });
  if (any && page !== 'home') { window.scrollTo(0, 0); return; }
  if (h && h.length > 1 && h.indexOf('#/') !== 0) { var el = document.getElementById(h.slice(1)); if (el) el.scrollIntoView(); }
  else if (any) window.scrollTo(0, 0);
}
addEventListener('hashchange', route); route();
