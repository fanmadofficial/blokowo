// Blokowo – serwer (bez zależności). Start: node server.js
// Publikowanie gier/assetów tylko z kluczem:  KEY=haslo node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000, KEY = process.env.KEY || '';
const GD = path.join(__dirname, 'games'), RD = path.join(__dirname, 'resources');
const MAXP = 2e6, NAME = /^[\w-]{1,32}$/, FILE = /^[\w-]{1,40}\.(png|jpe?g|gif|webp)$/i, COL = /^#[0-9a-f]{6}$/i;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
[GD, RD].forEach(d => fs.mkdirSync(d, { recursive: true }));

if (!fs.readdirSync(GD).some(f => f.endsWith('.json'))) fs.writeFileSync(path.join(GD, 'demo.json'), JSON.stringify({
  spawn: [0, 3, 0],
  parts: [
    { id: 'start', pos: [0, 0.5, 0], size: [8, 1, 8], color: '#4caf50' },
    { id: 'btn', pos: [-2, 1.15, 0], size: [1.5, 0.3, 1.5], color: '#ffeb3b' },
    { id: 'ramp', pos: [-9, 0.5, 0], size: [5, 1, 5], color: '#9c27b0' },
    { id: 'lava', pos: [5, 0.2, 7], size: [10, 0.4, 3], color: '#f44336' },
    { id: 'lift', pos: [11, 0.5, 0], size: [4, 1, 4], color: '#2196f3' },
    { id: 'goal', pos: [19, 7, 0], size: [6, 1, 6], color: '#ffc107' },
    { id: 'box', pos: [0, 8, 0], size: [2, 2, 2], color: '#ff9800', anchored: false }
  ],
  rules: [
    { on: 'start', do: [{ move: { part: 'lift', axis: 'y', to: 7, speed: 2, loop: true } }] },
    { on: 'touch', part: 'btn', once: true, do: [{ move: { part: 'ramp', axis: 'y', to: 5, speed: 2 } }, { say: 'Rampa podnosi się!' }] },
    { on: 'touch', part: 'lava', do: [{ kill: true }, { say: 'Lawa!' }] },
    { on: 'touch', part: 'goal', do: [{ change: { scope: 'score', name: 'Punkty', by: 1 } }, { say: 'Wygrana! Punkty: {@Punkty}' }, { tp: [0, 3, 0] }] }
  ]
}));

// ---------- minimalny WebSocket (RFC 6455) ----------
function accept(q, sock) {
  const k = q.headers['sec-websocket-key'];
  if (!k) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const c = { sock, buf: Buffer.alloc(0), id: nextId++, room: null, last: 0, user: null, tries: 0 }; conns.add(c);
  sock.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    let f;
    while ((f = frame(c))) {
      if (f.op === 8) return sock.end();
      if (f.op === 9) sock.write(Buffer.concat([Buffer.from([0x8a, f.p.length]), f.p]));
      if (f.op === 1) try { handle(c, f.p.toString()); } catch (e) {}
    }
  });
  sock.on('close', () => { conns.delete(c); logout(c, false); leave(c); });
  sock.on('error', () => {});
}
function frame(c) {
  const b = c.buf; if (b.length < 2) return null;
  let len = b[1] & 127, o = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); o = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); o = 10; }
  if (len > MAXP) { c.sock.destroy(); return null; }
  const masked = b[1] & 128; if (masked) o += 4;
  if (b.length < o + len) return null;
  const p = Buffer.from(b.subarray(o, o + len));
  if (masked) for (let i = 0; i < len; i++) p[i] ^= b[o - 4 + (i & 3)];
  c.buf = b.subarray(o + len);
  return { op: b[0] & 15, p };
}
function send(c, o) {
  if (c.sock.destroyed) return;
  const p = Buffer.from(JSON.stringify(o)), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) h = Buffer.from([0x81, 126, n >> 8, n & 255]);
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  c.sock.write(Buffer.concat([h, p]));
}

// ---------- pokoje i logika gier ----------
let nextId = 1;
const rooms = new Map();
const pub = c => ({ id: c.id, name: c.name, color: c.color, p: c.pos, ry: c.ry });
const bcast = (r, o, except) => r.players.forEach(c => c !== except && send(c, o));

function room(name) {
  if (rooms.has(name)) return rooms.get(name);
  let g; try { g = JSON.parse(fs.readFileSync(path.join(GD, name + '.json'), 'utf8')); } catch { return null; }
  g.rules = Array.isArray(g.rules) ? g.rules.filter(u => u && typeof u === 'object') : [];
  const r = { name, g, players: new Map(), parts: new Map(), movers: [], dirty: new Set(), touch: new Set(), done: new Set() };
  r.E = Engine({
    parts: r.parts, movers: r.movers, dirty: r.dirty, players: () => [...r.players.values()],
    kill: c => send(c, { t: 'respawn' }), tp: (c, pos) => send(c, { t: 'tp', pos }),
    say: (c, text) => (c ? [c] : [...r.players.values()]).forEach(x => send(x, { t: 'chat', name: '*', text })),
    alive: () => rooms.get(r.name) === r
  });
  for (const p of g.parts || []) r.parts.set(p.id, { id: p.id, pos: [...p.pos], size: p.size, collide: p.collide !== false, anchored: p.anchored !== false, hidden: false, vel: 0 });
  rooms.set(name, r);
  g.rules.filter(u => u.on === 'start').forEach(u => r.E.exec(u.do, null));
  return r;
}
function leave(c) {
  const r = c.room; if (!r) return;
  r.players.delete(c.id); c.room = null;
  bcast(r, { t: 'leave', id: c.id });
  if (!r.players.size) rooms.delete(r.name);
  pushLobby();
}
// ENGINE-BEGIN (silnik reguł: wyrażenia, zmienne, wyniki, timery – ten sam kod w server.js i w Studio)
function Engine(h) {
  const E = { vars: Object.create(null), timers: new Map(), acc: [] };
  const nm = n => typeof n === 'string' && /^[\w-]{1,32}$/.test(n) ? n : null;
  const left = (n, pl) => { const t = E.timers.get(n + ':' + (pl ? pl.id : '')) || E.timers.get(n + ':'); return t ? Math.max(0, t.left) : 0; };
  const ev = (x, pl, d = 0) => { // wartość: liczba | {var} | {score} | {timer} | {rand:[min,max]} | {op,a,b}
    if (typeof x === 'number') return Number.isFinite(x) ? x : 0;
    if (!x || typeof x !== 'object' || d > 12) return 0;
    if (x.var !== undefined) return +E.vars[x.var] || 0;
    if (x.score !== undefined) return pl ? +pl.sc[x.score] || 0 : 0;
    if (x.timer !== undefined) return left(String(x.timer), pl);
    if (Array.isArray(x.rand)) {
      let a = ev(x.rand[0], pl, d + 1), b = ev(x.rand[1], pl, d + 1); if (a > b) [a, b] = [b, a];
      return Number.isInteger(a) && Number.isInteger(b) ? a + Math.floor(Math.random() * (b - a + 1)) : a + Math.random() * (b - a);
    }
    if (x.op) {
      const a = ev(x.a, pl, d + 1), b = ev(x.b, pl, d + 1);
      return x.op === '+' ? a + b : x.op === '-' ? a - b : x.op === '*' ? a * b : x.op === '/' ? (b ? a / b : 0) : x.op === '%' ? (b ? a % b : 0) : 0;
    }
    return 0;
  };
  const test = (c, pl) => {
    if (!c || typeof c !== 'object') return false;
    const a = ev(c.a, pl), b = ev(c.b, pl);
    return c.cmp === '<' ? a < b : c.cmp === '>' ? a > b : c.cmp === '<=' ? a <= b : c.cmp === '>=' ? a >= b : c.cmp === '!=' ? Math.abs(a - b) >= 1e-9 : Math.abs(a - b) < 1e-9;
  };
  const fmt = (t, pl) => String(t).slice(0, 200).replace(/\{([@#]?)([\w-]{1,32})\}/g, (m, k, n) => {
    const v = k === '@' ? (pl ? pl.sc[n] : 0) : k === '#' ? left(n, pl) : E.vars[n]; return String(Math.round((+v || 0) * 100) / 100);
  });
  const step = (a, pl) => {
    if (a.move && typeof a.move === 'object') {
      const p = h.parts.get(a.move.part), ax = 'xyz'.indexOf(a.move.axis); if (!p || ax < 0) return;
      for (let k = h.movers.length; k--;) if (h.movers[k].p === p && h.movers[k].ax === ax) h.movers.splice(k, 1);
      h.movers.push({ p, ax, from: p.pos[ax], to: ev(a.move.to, pl), sp: Math.abs(ev(a.move.speed, pl)) || 2, loop: !!a.move.loop });
    } else if (a.hide !== undefined || a.show !== undefined) {
      const p = h.parts.get(a.hide !== undefined ? a.hide : a.show); if (p) { p.hidden = a.hide !== undefined; h.dirty.add(p); }
    } else if (a.kill) { if (pl) h.kill(pl); }
    else if (Array.isArray(a.tp)) { if (pl) h.tp(pl, [0, 1, 2].map(k => ev(a.tp[k], pl))); }
    else if (a.say !== undefined) h.say(pl, fmt(a.say, pl));
    else if (a.set || a.change) {
      const o = a.set || a.change, n = o && nm(o.name); if (!n) return;
      const sc = o.scope === 'score';
      for (const t of sc ? (pl ? [pl] : h.players()) : [null]) {
        const cur = sc ? t.sc : E.vars, v = ev(a.set ? o.val : o.by, t || pl);
        if (!(n in cur) && Object.keys(cur).length >= (sc ? 8 : 64)) continue;
        cur[n] = a.set ? v : (+cur[n] || 0) + v;
      }
    } else if (a.timer || a.addtime) {
      const o = a.timer || a.addtime, n = o && nm(o.name); if (!n) return;
      const k = n + ':' + (pl ? pl.id : ''), secs = Math.max(0, ev(o.secs, pl)), t = E.timers.get(k);
      if (a.addtime && t) t.left += secs; else if (E.timers.size < 64) E.timers.set(k, { name: n, left: secs, owner: pl || null });
    } else if (a.stoptimer !== undefined) E.timers.delete(String(a.stoptimer) + ':' + (pl ? pl.id : ''));
  };
  // wykonuje listę akcji; „czekaj” zawiesza resztę listy; „jeśli” uruchamia zagnieżdżoną listę i wraca
  E.exec = (acts, pl, done, i = 0, depth = 0) => {
    if (!Array.isArray(acts) || depth > 16) return done && done();
    while (i < acts.length) {
      const a = acts[i++]; if (!a || typeof a !== 'object') continue;
      if (a.wait !== undefined) {
        const ms = Math.min(600, Math.max(0, ev(a.wait, pl))) * 1000;
        setTimeout(() => { try { if (h.alive()) E.exec(acts, pl, done, i, depth); } catch (e) { } }, ms); return;
      }
      if (a.if) {
        const list = test(a.if, pl) ? a.then : a.else;
        if (Array.isArray(list) && list.length) { E.exec(list, pl, () => E.exec(acts, pl, done, i, depth), 0, depth + 1); return; }
        continue;
      }
      step(a, pl);
    }
    done && done();
  };
  E.tick = (dt, rules) => { // timery odliczają w dół; zdarzenia „co N s” i „gdy timer się skończy”
    for (const [k, t] of [...E.timers]) {
      t.left -= dt; if (t.left > 0) continue; E.timers.delete(k);
      const pl = t.owner && h.players().includes(t.owner) ? t.owner : null;
      rules.forEach(u => { if (u.on === 'timerend' && u.name === t.name) E.exec(u.do, pl); });
    }
    rules.forEach((u, i) => {
      if (u.on !== 'every') return;
      const s = Math.max(0.1, +u.secs || 1); E.acc[i] = (E.acc[i] || 0) + dt;
      if (E.acc[i] < s) return; E.acc[i] -= s;
      if (u.each) h.players().forEach(c => E.exec(u.do, c)); else E.exec(u.do, null);
    });
  };
  E.hud = pl => ({ timers: [...E.timers.values()].filter(t => !t.owner || t.owner === pl).map(t => [t.name, Math.max(0, t.left)]), me: pl.sc });
  return E;
}
// ENGINE-END

function tick(r) {
  const dt = 0.05;
  for (const m of [...r.movers]) {
    const p = m.p, d = m.to - p.pos[m.ax], st = m.sp * dt;
    if (Math.abs(d) <= st) {
      p.pos[m.ax] = m.to;
      if (m.loop) [m.to, m.from] = [m.from, m.to]; else r.movers.splice(r.movers.indexOf(m), 1);
    } else p.pos[m.ax] += Math.sign(d) * st;
    r.dirty.add(p);
  }
  // prosta fizyka części niezakotwiczonych: grawitacja + lądowanie na innych częściach
  for (const p of r.parts.values()) {
    if (p.anchored || p.hidden) continue;
    const hh = p.size[1] / 2, bot = p.pos[1] - hh;
    let sup = r.g.ground ? 0 : -1e9;
    for (const q of r.parts.values()) {
      if (q === p || !q.collide || q.hidden) continue;
      const t = q.pos[1] + q.size[1] / 2;
      if (t <= bot + 0.05 && Math.abs(p.pos[0] - q.pos[0]) < (p.size[0] + q.size[0]) / 2 && Math.abs(p.pos[2] - q.pos[2]) < (p.size[2] + q.size[2]) / 2) sup = Math.max(sup, t);
    }
    p.vel -= 30 * dt;
    let nb = bot + p.vel * dt;
    if (nb <= sup) { nb = sup; p.vel = 0; }
    if (nb !== bot) { p.pos[1] = nb + hh; r.dirty.add(p); }
    if (p.pos[1] < -200) { p.hidden = true; r.dirty.add(p); }
  }
  // wykrywanie dotknięć (gracz 1x3.4x1 vs część)
  r.g.rules.forEach((u, i) => {
    const p = u.on === 'touch' && r.parts.get(u.part); if (!p || p.hidden) return;
    for (const c of r.players.values()) {
      const k = i + '_' + c.id, [x, y, z] = c.pos;
      const o = Math.abs(x - p.pos[0]) < (p.size[0] + 1) / 2 + 0.1 && Math.abs(z - p.pos[2]) < (p.size[2] + 1) / 2 + 0.1 &&
        y + 3.4 > p.pos[1] - p.size[1] / 2 - 0.1 && y < p.pos[1] + p.size[1] / 2 + 0.1;
      if (o && !r.touch.has(k)) { r.touch.add(k); if (u.once && r.done.has(i)) continue; r.done.add(i); r.E.exec(u.do, c); }
      else if (!o) r.touch.delete(k);
    }
  });
  r.E.tick(dt, r.g.rules);
  if ((r.n = (r.n || 0) + 1) % 5 === 0) { // HUD: timery, wyniki gracza, tablica wyników (4 razy na sekundę)
    const board = [...r.players.values()].slice(0, 12).map(c => [c.name, c.sc]);
    r.players.forEach(c => send(c, { t: 'hud', ...r.E.hud(c), board }));
  }
  bcast(r, { t: 'state', p: [...r.players.values()].map(c => [c.id, ...c.pos, c.ry]), q: [...r.dirty].map(p => [p.id, ...p.pos, +p.hidden]) });
  r.dirty.clear();
}
setInterval(() => rooms.forEach(r => { try { tick(r); } catch (e) { if (!r.err) { r.err = 1; console.error('Błąd w pokoju ' + r.name + ':', e); } } }), 50);

function clean(g) {
  const v3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite), ids = new Set(), parts = [];
  if (!g || !Array.isArray(g.parts) || g.parts.length > 500) return null;
  for (const p of g.parts) {
    if (typeof p.id !== 'string' || !NAME.test(p.id) || ids.has(p.id) || !v3(p.pos) || !v3(p.size)) return null;
    ids.add(p.id);
    parts.push({ id: p.id, pos: p.pos, size: p.size.map(Math.abs), color: COL.test(p.color) ? p.color : '#888888', anchored: p.anchored !== false, collide: p.collide !== false, tex: FILE.test(p.tex || '') ? p.tex : undefined });
  }
  return { spawn: v3(g.spawn) ? g.spawn : [0, 3, 0], ground: COL.test(g.ground) ? g.ground : undefined, parts, rules: Array.isArray(g.rules) ? JSON.parse(JSON.stringify(g.rules.slice(0, 200))).filter(u => u && typeof u === 'object') : [] };
}

// ---------- konta (nick + hasło), weryfikacja „koła” i lobby ----------
const AF = path.join(__dirname, 'accounts.json'), NICK = /^[\p{L}\p{N}_-]{3,16}$/u;
const ACC = Object.assign(Object.create(null), (() => { try { return JSON.parse(fs.readFileSync(AF, 'utf8')); } catch { return {}; } })());
const saveAcc = () => { fs.writeFileSync(AF + '.tmp', JSON.stringify(ACC)); fs.renameSync(AF + '.tmp', AF); };
const online = new Map(), conns = new Set(), seen = new Set();
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex'); // hasła tylko jako scrypt+sól

// CIRCLE-BEGIN – czy punkty [x,y,t] wyglądają na koło narysowane ręcznie? (idealnie równe koło = bot)
function humanCircle(p, sz) {
  if (!Array.isArray(p) || p.length < 25 || p.length > 700 || !Array.isArray(sz) || !(sz[0] > 200) || !(sz[1] > 200) || sz[0] > 10000 || sz[1] > 10000) return 'fmt';
  const n = p.length; let cx = 0, cy = 0;
  for (const q of p) { if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)) return 'fmt'; cx += q[0]; cy += q[1]; }
  for (let i = 1; i < n; i++) if (p[i][2] < p[i - 1][2]) return 'order';
  const T = p[n - 1][2] - p[0][2]; if (T < 500 || T > 20000) return 'time';
  cx /= n; cy /= n; const m = Math.min(sz[0], sz[1]);
  const r = p.map(q => Math.hypot(q[0] - cx, q[1] - cy)), R = r.reduce((a, b) => a + b, 0) / n;
  if (R < 0.05 * m || R > 0.5 * m) return 'size';
  let tot = 0, prev = Math.atan2(p[0][1] - cy, p[0][0] - cx); // ile razy ścieżka okrąża środek
  for (let i = 1; i < n; i++) {
    const a = Math.atan2(p[i][1] - cy, p[i][0] - cx); let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; tot += d; prev = a;
  }
  if (Math.abs(tot) < 1.8 * Math.PI || Math.abs(tot) > 6.4 * Math.PI) return 'angle';
  if (Math.hypot(p[0][0] - p[n - 1][0], p[0][1] - p[n - 1][1]) > 0.7 * R) return 'closure';
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - R) ** 2, 0) / n) / R; // odchylenie promienia: za małe = zbyt idealne, za duże = nie koło
  if (sd > 0.3 || sd < 0.012) return 'roundness';
  const sp = []; for (let i = 1; i < n; i++) { const dt = p[i][2] - p[i - 1][2]; if (dt > 0) sp.push(Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) / dt); }
  if (sp.length < 15) return 'timing';
  const ms = sp.reduce((a, b) => a + b, 0) / sp.length, cv = Math.sqrt(sp.reduce((a, b) => a + (b - ms) ** 2, 0) / sp.length) / ms;
  if (cv < 0.15) return 'uniform'; // ręka zmienia prędkość, skrypt zwykle nie
  if (new Set(p.map(q => q[0] + ',' + q[1])).size < n * 0.6) return 'dupes';
  const key = sha(JSON.stringify(p)); if (seen.has(key)) return 'replay'; // ten sam ruch nie przejdzie dwa razy
  seen.add(key); if (seen.size > 5000) seen.delete(seen.values().next().value);
  return null;
}
// CIRCLE-END

function lobbyData() {
  let games = []; try { games = fs.readdirSync(GD).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch { }
  return { t: 'lobby', games: games.map(n => ({ name: n, players: rooms.has(n) ? rooms.get(n).players.size : 0 })),
    users: [...online.values()].map(c => ({ nick: c.user.nick, game: c.room ? c.room.name : null })) };
}
let lobT = 0;
function pushLobby() { // lobby odświeża się u wszystkich zalogowanych (z krótkim buforowaniem)
  if (lobT) return;
  lobT = setTimeout(() => { lobT = 0; const L = lobbyData(); conns.forEach(c => c.user && send(c, L)); }, 100);
}
const autherr = (c, code, msg, delay = 0) => setTimeout(() => send(c, { t: 'autherr', code, msg }), delay);
function loginAs(c, acc, issue) {
  const k = acc.nick.toLowerCase(), old = online.get(k);
  if (old && old !== c) { send(old, { t: 'error', msg: 'Zalogowano z innego miejsca' }); logout(old, true); }
  c.user = acc; c.name = acc.nick; online.set(k, c);
  let token; if (issue) { token = crypto.randomBytes(24).toString('hex'); acc.tok = [...(acc.tok || []), sha(token)].slice(-5); saveAcc(); }
  send(c, { t: 'authok', nick: acc.nick, token }); pushLobby();
}
function logout(c, notify) {
  if (!c.user) return;
  const k = c.user.nick.toLowerCase(); if (online.get(k) === c) online.delete(k);
  leave(c); c.user = null; if (notify) send(c, { t: 'loggedout' }); pushLobby();
}

function handle(c, raw) {
  const m = JSON.parse(raw), r = c.room;
  const auth = () => (!KEY || m.key === KEY) || (send(c, { t: 'error', msg: 'Zły klucz publikowania' }), false);
  switch (m.t) {
    case 'auth': {
      if (++c.tries > 15) { send(c, { t: 'autherr', code: 'fatal', msg: 'Za dużo prób – odśwież stronę' }); return c.sock.end(); }
      const reg = m.mode === 'register', nick = typeof m.nick === 'string' ? m.nick.normalize('NFKC').trim() : '', pw = typeof m.pass === 'string' ? m.pass : '';
      if (!NICK.test(nick)) return autherr(c, 'form', 'Nick: 3–16 znaków (litery, cyfry, _ lub -)');
      if (pw.length < 4 || pw.length > 64) return autherr(c, 'form', 'Hasło: 4–64 znaków');
      if (humanCircle(m.pts, m.size)) return autherr(c, 'circle', 'Nie rozpoznano ręcznie narysowanego koła. Spróbuj jeszcze raz.', 300);
      const k = nick.toLowerCase(), acc = ACC[k], now = Date.now();
      if (reg) {
        if (acc) return autherr(c, 'form', 'Ten nick jest już zajęty');
        const salt = crypto.randomBytes(16).toString('hex');
        ACC[k] = { nick, salt, hash: hashPw(pw, salt), created: now, tok: [] }; saveAcc();
        return loginAs(c, ACC[k], true);
      }
      if (acc && acc.until > now) return autherr(c, 'form', 'Konto tymczasowo zablokowane – spróbuj za chwilę', 400);
      const ok = acc ? crypto.timingSafeEqual(Buffer.from(hashPw(pw, acc.salt), 'hex'), Buffer.from(acc.hash, 'hex')) : (hashPw(pw, '00'), false);
      if (!ok) { if (acc && (acc.fails = (acc.fails || 0) + 1) >= 5) { acc.until = now + 60000; acc.fails = 0; } return autherr(c, 'form', 'Zły nick lub hasło', 500); }
      acc.fails = 0; return loginAs(c, acc, true);
    }
    case 'resume': { // wejście zapamiętaną sesją (bez koła)
      if (++c.tries > 15) return c.sock.end();
      const acc = typeof m.nick === 'string' ? ACC[m.nick.normalize('NFKC').toLowerCase()] : null;
      if (!acc || typeof m.token !== 'string' || !(acc.tok || []).includes(sha(m.token))) return autherr(c, 'resume', 'Sesja wygasła – zaloguj się ponownie');
      return loginAs(c, acc, false);
    }
    case 'logout':
      if (c.user && typeof m.token === 'string') { c.user.tok = (c.user.tok || []).filter(h => h !== sha(m.token)); saveAcc(); }
      logout(c, true); break;
    case 'lobby': if (c.user) send(c, lobbyData()); break;
    case 'list': send(c, { t: 'games', list: fs.readdirSync(GD).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) }); break;
    case 'get':
      try { send(c, { t: 'game', game: JSON.parse(fs.readFileSync(path.join(GD, (NAME.test(m.name) ? m.name : '') + '.json'), 'utf8')) }); }
      catch { send(c, { t: 'error', msg: 'Brak takiej gry' }); }
      break;
    case 'join': {
      if (!c.user) return send(c, { t: 'error', msg: 'Zaloguj się, aby grać' });
      leave(c);
      const nr = NAME.test(m.game) && room(m.game);
      if (!nr) return send(c, { t: 'error', msg: 'Nie można wczytać gry' });
      Object.assign(c, { name: c.user.nick, pos: [...(nr.g.spawn || [0, 3, 0])], ry: 0, color: Math.random() * 0xffffff | 0, room: nr, sc: Object.create(null) });
      nr.players.set(c.id, c);
      send(c, { t: 'load', id: c.id, game: nr.g, cur: [...nr.parts.values()].map(p => [p.id, ...p.pos, +p.hidden]), players: [...nr.players.values()].map(pub) });
      bcast(nr, { t: 'join', p: pub(c) }, c); pushLobby();
      break;
    }
    case 'leave': leave(c); break;
    case 'pos': if (r) { c.pos = m.p.slice(0, 3).map(v => Math.max(-1e3, Math.min(1e3, +v || 0))); c.ry = +m.ry || 0; } break;
    case 'chat': if (r && typeof m.text === 'string' && Date.now() - c.last > 500) { c.last = Date.now(); bcast(r, { t: 'chat', name: c.name, text: m.text.slice(0, 120) }); } break;
    case 'publish': {
      if (!auth()) return;
      const g = NAME.test(m.name) && clean(m.game);
      if (!g) return send(c, { t: 'error', msg: 'Niepoprawna gra (nazwa/id części/pozycje)' });
      const js = JSON.stringify(g); if (js.length > 400000) return send(c, { t: 'error', msg: 'Gra jest za duża (max 400 KB)' });
      fs.writeFileSync(path.join(GD, m.name + '.json'), js);
      const old = rooms.get(m.name);
      if (old) { bcast(old, { t: 'chat', name: '*', text: 'Gra zaktualizowana – wejdź ponownie.' }); old.players.forEach(p => p.room = null); rooms.delete(m.name); }
      send(c, { t: 'published', name: m.name }); pushLobby();
      break;
    }
    case 'asset': {
      if (!auth()) return;
      if (!FILE.test(m.name || '')) return send(c, { t: 'error', msg: 'Zła nazwa pliku (png/jpg/gif/webp)' });
      const buf = Buffer.from(String(m.data).replace(/^data:[^,]*,/, ''), 'base64');
      if (!buf.length || buf.length > 1e6) return send(c, { t: 'error', msg: 'Plik pusty lub >1 MB' });
      fs.writeFileSync(path.join(RD, m.name), buf);
      send(c, { t: 'asset', name: m.name });
      break;
    }
  }
}

const srv = http.createServer((q, s) => {
  s.setHeader('Access-Control-Allow-Origin', '*');
  const m = q.url.match(/^\/resources\/([\w.-]+)$/);
  if (m && FILE.test(m[1])) return fs.readFile(path.join(RD, m[1]), (e, d) => {
    if (e) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'Content-Type': MIME[path.extname(m[1]).toLowerCase()] }); s.end(d);
  });
  s.writeHead(200); s.end('Blokowo server');
});
srv.on('upgrade', accept);
srv.listen(PORT, '0.0.0.0', () => {
  console.log('Blokowo działa na porcie ' + PORT + (KEY ? ' (publikowanie chronione kluczem)' : ' (UWAGA: publikowanie bez klucza!)'));
  for (const l of Object.values(os.networkInterfaces())) for (const i of l) if (i.family === 'IPv4' && !i.internal) console.log('  LAN: ' + i.address + ':' + PORT);
});
