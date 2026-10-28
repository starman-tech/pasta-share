'use strict';
// 🍝 Pasta Share : client web (téléphone ou navigateur)

const $ = s => document.querySelector(s);
const CHUNK = 16 * 1024, READ = 1 << 20, HIGH = 8 << 20, LOW = 1 << 20;

// ---------- utilitaires ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function token(n = 16) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
function fmtSize(n) {
  if (n < 1024) return Math.round(n) + ' o';
  if (n < 1 << 20) return Math.round(n / 1024) + ' Ko';
  if (n < 1 << 30) return (n / 1048576).toFixed(1).replace('.', ',') + ' Mo';
  return (n / 1073741824).toFixed(2).replace('.', ',') + ' Go';
}
function fmtDuration(s) {
  s = Math.ceil(s);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const isUrl = s => /^https?:\/\/\S+$/.test(s.trim());
const isImage = type => (type || '').startsWith('image/');
const isText = f => f.size < 65536 && (f.type.startsWith('text/') || /\.(txt|md)$/i.test(f.name));

function defaultName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Téléphone Android';
  return 'Navigateur';
}
// icônes pixel art, dessinées sur une grille 16×16
const ICON = {
  phone: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M4 1h8v14H4zM5 2v10h6V2zM7 13h2v1H7z"/></svg>',
  laptop: '<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M2 3h12v8H2zM3 4v6h10V4zM0 12h16v2H0z"/></svg>',
};
const deviceIcon = name => /iphone|ipad|android|téléphone|phone|pixel|galaxy|tablette/i.test(name) ? ICON.phone : ICON.laptop;
function fileKind(name, type = '') {
  if (isImage(type)) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (/\.(zip|rar|7z|tar|gz|xz)$/i.test(name)) return 'archive';
  if (type.startsWith('text/') || /\.(txt|md)$/i.test(name)) return 'text';
  return 'file';
}
// vignette : l'image elle-même, sinon l'extension du fichier sur un carré de couleur
function thumbHTML(name, type, url, tag = 'span') {
  if (url && isImage(type)) {
    const img = `<img src="${url}" alt="">`;
    return tag === 'a' ? `<a class="thumb" href="${url}" target="_blank" rel="noopener">${img}</a>` : `<span class="thumb">${img}</span>`;
  }
  const ext = /\.([a-z0-9]{1,4})$/i.exec(name)?.[1] || 'file';
  return `<span class="thumb" data-kind="${fileKind(name, type)}">${esc(ext.toUpperCase())}</span>`;
}
function textFile(txt) {
  const d = new Date(), hm = `${d.getHours()}h${String(d.getMinutes()).padStart(2, '0')}`;
  return new File([txt], `${isUrl(txt) ? 'lien' : 'texte'} ${hm}.txt`, { type: 'text/plain' });
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast'), b = t.querySelector('button');
  t.querySelector('span').textContent = msg;
  b.hidden = !action;
  if (action) {
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.run(); };
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2600);
}
async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: txt });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Copié !');
}

// SHA-256 → hex (crypto.subtle n'existe qu'en HTTPS, d'où la version JS de secours)
async function sha256hex(str) {
  const bytes = new TextEncoder().encode(str);
  if (crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256js(bytes);
}
function sha256js(msg) {
  const K = [], H = [];
  for (let n = 2, c = 0; c < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (c < 8) H[c] = (Math.pow(n, 1 / 2) % 1) * 4294967296 | 0;
    K[c++] = (Math.pow(n, 1 / 3) % 1) * 4294967296 | 0;
  }
  const l = msg.length, bl = ((l + 9 + 63) >> 6) << 6;
  const b = new Uint8Array(bl);
  b.set(msg); b[l] = 0x80;
  const dv = new DataView(b.buffer);
  dv.setUint32(bl - 4, (l * 8) >>> 0);
  dv.setUint32(bl - 8, Math.floor(l / 536870912));
  const w = new Int32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < bl; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], d = w[i - 2];
      w[i] = (w[i - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[i - 7] + (r(d, 17) ^ r(d, 19) ^ (d >>> 10))) | 0;
    }
    let [A, B, C, D, E, F, G, X] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (X + (r(E, 6) ^ r(E, 11) ^ r(E, 25)) + ((E & F) ^ (~E & G)) + K[i] + w[i]) | 0;
      const t2 = ((r(A, 2) ^ r(A, 13) ^ r(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      X = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    [A, B, C, D, E, F, G, X].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------- état ----------
// Deux modes. Sur le téléphone, l'appli se connecte directement aux PC appairés (WebRTC sans
// intermédiaire). Sur le PC (http://localhost:47801), elle pilote le récepteur via son API locale.
const PC_MODE = location.port === '47801' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const state = {
  name: store.get('name') || defaultName(),
  pairs: store.get('pairs', []).filter(p => p.fp),  // téléphone : [{ secret, id, name, fp, ips, host, port }]
  phones: [],                      // PC : [{ id, name, online }], fournis par le récepteur
  pending: [],                     // [{ file, url }] fichiers en attente d'un destinataire
  transfers: [],
  online: false,
  showWelcome: false,
  editing: false,
};
let pickFor = null;                  // 'queue', 'add' ou id de l'appareil choisi avant d'ouvrir le sélecteur
let unseen = 0;                      // fichiers reçus pendant que l'onglet était caché
const savePairs = () => store.set('pairs', state.pairs.map(({ secret, id, name, fp, ips, host, port }) => ({ secret, id, name, fp, ips, host, port })));

// ---------- connexion directe aux PC (mode téléphone) ----------
// Tout ce qu'il faut est dans le QR code : le PC écoute sur un port UDP fixe, son certificat
// est fixe, et les identifiants ICE des deux côtés sont dérivés du secret (même calcul dans link.go).
// On fabrique donc nous-mêmes la réponse du PC : aucun serveur pour faire l'intermédiaire.
const sessions = new Map();          // id d'appairage → { pc, ctl, online, timer }
const derive = async (secret, label, n) => (await sha256hex(`pasta-${label}:${secret}`)).slice(0, n);
async function credsOf(secret) {
  const [id, pcUfrag, pcPwd, phUfrag, phPwd] = await Promise.all([
    derive(secret, 'id', 12), derive(secret, 'pc-ufrag', 16), derive(secret, 'pc-pwd', 32),
    derive(secret, 'ph-ufrag', 16), derive(secret, 'ph-pwd', 32)]);
  return { id, pcUfrag, pcPwd, phUfrag, phPwd };
}
function pcAnswer(p, cr) {
  const cands = [...(p.ips || []), p.host].filter(Boolean)
    .map((addr, i) => `a=candidate:${i + 1} 1 udp ${2130706431 - i} ${addr} ${p.port} typ host`);
  return ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=ice-lite', 'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${cr.pcUfrag}`, `a=ice-pwd:${cr.pcPwd}`,
    `a=fingerprint:sha-256 ${p.fp.toUpperCase().match(/../g).join(':')}`,
    'a=setup:passive', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
    ...cands, 'a=end-of-candidates', ''].join('\r\n');
}
async function dial(p) {
  if (sessions.has(p.id) || document.hidden) return;
  const s = { pc: new RTCPeerConnection(), ctl: null, online: false };
  sessions.set(p.id, s);
  const { pc } = s, drop = () => hangup(p.id, pc);
  s.ctl = pc.createDataChannel('ctl');
  s.ctl.onopen = () => { s.online = true; clearTimeout(s.timer); hello(s); render(); };
  s.ctl.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== 'hello') return;
    p.name = m.name || p.name;
    if (m.ips?.length) p.ips = m.ips;
    if (m.host) p.host = m.host;
    savePairs(); render();
  };
  pc.ondatachannel = e => { if (e.channel.label === 'pasta') handleIncoming(e.channel, p.id); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop(); };
  s.timer = setTimeout(() => { if (!s.online) drop(); }, 8000);
  try {
    p.cr ||= await credsOf(p.secret);
    const offer = await pc.createOffer();
    offer.sdp = offer.sdp.replace(/a=ice-ufrag:.*\r\n/g, `a=ice-ufrag:${p.cr.phUfrag}\r\n`)
      .replace(/a=ice-pwd:.*\r\n/g, `a=ice-pwd:${p.cr.phPwd}\r\n`);
    await pc.setLocalDescription(offer);
    await pc.setRemoteDescription({ type: 'answer', sdp: pcAnswer(p, p.cr) });
  } catch (e) { console.warn(e); drop(); }
}
// fin de session : on rappelle le PC un peu plus tard (il prépare une nouvelle connexion de son côté)
function hangup(id, pc) {
  const s = sessions.get(id);
  if (!s || s.pc !== pc) return;
  clearTimeout(s.timer);
  sessions.delete(id);
  pc.close();
  render();
  setTimeout(() => { const p = state.pairs.find(p => p.id === id); if (p) dial(p); }, 2500);
}
function hangupAll() {
  for (const [id, s] of sessions) { clearTimeout(s.timer); sessions.delete(id); s.pc.close(); }
  render();
}
function hello(s) { if (s.ctl?.readyState === 'open') s.ctl.send(JSON.stringify({ type: 'hello', name: state.name })); }

// ---------- récepteur local (mode PC) ----------
const uploads = new Map();           // nom du fichier → requête en cours (pour pouvoir annuler)
let es;
function connectLocal() {
  if (es) return;
  es = new EventSource('/api/events');
  es.onopen = () => { removeTransfers(state.transfers.filter(t => t.rid)); };
  es.onerror = () => { state.online = false; render(); };
  es.addEventListener('state', e => {
    const s = JSON.parse(e.data);
    Object.assign(state, { online: true, name: s.name, phones: s.phones });
    render();
  });
  es.addEventListener('transfer', e => {
    const x = JSON.parse(e.data);
    let t = state.transfers.find(t => t.rid === x.id);
    if (!t) t = addTransfer({ rid: x.id, dir: x.dir, name: x.name, type: '', peer: x.peer, start: performance.now() });
    if (t.dir === 'out') t.cancel = () => uploads.get(t.name)?.abort();
    Object.assign(t, { size: x.size, done: x.done, status: x.status, msg: x.msg });
    if (x.dir === 'in' && x.status === 'done' && !t.notified) {
      t.notified = true;
      if (document.hidden) unseen++;
      toast('Reçu : ' + x.name);
    }
    update();
  });
}
const api = (path, body) => fetch(path, { method: 'POST', body: body && JSON.stringify(body) });

function connect() { PC_MODE ? connectLocal() : state.pairs.forEach(dial); }

function peerName(id) {
  return (PC_MODE ? state.phones : state.pairs).find(p => p.id === id)?.name || (PC_MODE ? 'Téléphone' : 'PC');
}

// ---------- réception (mode téléphone) ----------
function handleIncoming(dc, from) {
  dc.binaryType = 'arraybuffer';
  let cur = null;
  dc.onmessage = e => {
    if (typeof e.data !== 'string') {
      if (cur) { cur.chunks.push(e.data); cur.t.done += e.data.byteLength; update(); }
      return;
    }
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'meta') {
      const t = addTransfer({ dir: 'in', name: m.name || 'fichier', size: m.size || 0,
        type: m.mime || 'application/octet-stream', peer: peerName(from), start: performance.now() });
      t.cancel = () => {
        if (cur?.t === t) cur = null;
        t.status = 'error'; t.msg = 'Annulé';
        dc.close(); update();
      };
      cur = { chunks: [], t };
    } else if (m.type === 'done' && cur) {
      const t = cur.t;
      t.file = new File(cur.chunks, t.name, { type: t.type });
      t.url = URL.createObjectURL(t.file);
      t.done = t.size = t.file.size;
      t.status = 'done';
      cur = null;
      dc.send('{"type":"ok"}');
      if (isText(t.file)) t.file.text().then(s => { t.preview = s; update(); });
      if (document.hidden) unseen++;
      navigator.vibrate?.(60);
      toast('Reçu : ' + t.name);
      update();
    }
  };
  dc.onclose = () => {
    if (cur) { cur.t.status = 'error'; cur.t.msg = 'Interrompu'; update(); }
  };
}

// ---------- envoi ----------
async function sendFiles(peerId, files) {
  if (!files.length) return;
  if (PC_MODE) return sendLocal(peerId, files);
  const peer = peerName(peerId), s = sessions.get(peerId);
  if (!s?.online) return toast(peer + ' est hors ligne');
  const dc = s.pc.createDataChannel('pasta');
  let abort;
  const aborted = new Promise((_, rej) => { abort = rej; });
  aborted.catch(() => {});
  const batch = { peerId, cancelled: false };
  batch.cancel = () => { batch.cancelled = true; abort(new Error('Annulé')); dc.close(); };
  const items = files.map((f, i) => addTransfer({
    dir: 'out', name: f.name, size: f.size, type: f.type, peer, file: f, batch,
    url: isImage(f.type) ? URL.createObjectURL(f) : null, wait: i ? 'en attente' : 'ouverture…',
  }));
  const guard = (p, ms, msg) => Promise.race([withTimeout(p, ms, msg), aborted]);
  navigator.vibrate?.(20);

  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  let ack = null;
  dc.onmessage = e => { if (typeof e.data === 'string' && e.data.includes('"ok"') && ack) ack(); };
  const opened = new Promise(res => { dc.onopen = res; });
  try {
    await guard(opened, 10000, 'connexion impossible');
    for (let i = 0; i < files.length; i++) {
      const f = files[i], t = items[i];
      t.start = performance.now();
      dc.send(JSON.stringify({ type: 'meta', name: f.name, size: f.size, mime: f.type }));
      for (let off = 0; off < f.size;) {
        const buf = await f.slice(off, off + READ).arrayBuffer();
        for (let p = 0; p < buf.byteLength; p += CHUNK) {
          while (dc.bufferedAmount > HIGH) {
            if (dc.readyState !== 'open') throw new Error('connexion perdue');
            await new Promise(r => { dc.onbufferedamountlow = r; setTimeout(r, 200); });
          }
          dc.send(buf.slice(p, p + CHUNK));
        }
        off += buf.byteLength;
        t.done = off; update();
      }
      const acked = new Promise(r => { ack = r; });
      dc.send('{"type":"done"}');
      await guard(acked, 60000, 'pas de confirmation');
      t.done = t.size; t.status = 'done'; update();
    }
    navigator.vibrate?.([30, 60, 30]);
    toast(`${plural(files.length, 'fichier')} envoyé${files.length > 1 ? 's' : ''} à ${peer} ✓`);
  } catch (e) {
    const msg = batch.cancelled ? 'Annulé' : e.message;
    for (const t of items) if (t.status !== 'done') { t.status = 'error'; t.msg = msg; }
    if (!batch.cancelled) toast('Échec : ' + msg);
    update();
  } finally {
    setTimeout(() => dc.close(), 1000);
  }
}

// mode PC : le fichier part au récepteur, qui le transmet au fil de l'eau (la progression arrive par /api/events)
async function sendLocal(peerId, files) {
  const peer = peerName(peerId);
  for (const f of files) {
    const err = await new Promise(res => {
      const x = new XMLHttpRequest();
      uploads.set(f.name, x);
      x.open('POST', `/api/upload?to=${encodeURIComponent(peerId)}&name=${encodeURIComponent(f.name)}`);
      x.onload = () => res(x.status === 200 ? null : x.responseText.trim() || x.statusText);
      x.onerror = () => res('récepteur injoignable');
      x.onabort = () => res('Annulé');
      x.send(f);
    });
    uploads.delete(f.name);
    if (err) { if (err !== 'Annulé') toast('Échec : ' + err); return; }
  }
  toast(`${plural(files.length, 'fichier')} envoyé${files.length > 1 ? 's' : ''} à ${peer} ✓`);
}

function retry(batch) {
  if (!onlineDevices().some(d => d.id === batch.peerId)) return toast(peerName(batch.peerId) + ' est hors ligne');
  const failed = state.transfers.filter(t => t.batch === batch && t.status === 'error');
  removeTransfers(failed);
  sendFiles(batch.peerId, failed.map(t => t.file));
}

// Un seul appareil en ligne : on envoie tout de suite. Sinon on garde les fichiers en attente.
function queue(files) {
  if (!files.length) return;
  const online = onlineDevices();
  if (online.length === 1 && !state.pending.length) return sendFiles(online[0].id, files);
  addPending(files);
  if (online.length > 1) toast('Touche l\'appareil qui doit recevoir');
}
function addPending(files) {
  state.pending.push(...files.map(file => ({ file, url: isImage(file.type) ? URL.createObjectURL(file) : null })));
  render();
}
function takePending() {
  const files = state.pending.map(p => p.file);
  clearPending();
  return files;
}
function clearPending() {
  for (const p of state.pending) if (p.url) URL.revokeObjectURL(p.url);
  state.pending = [];
  render();
}

// ---------- appairage ----------
async function addPair(p) {
  p.cr = await credsOf(p.secret);
  p.id = p.cr.id;
  const old = state.pairs.find(x => x.id === p.id);
  if (old) Object.assign(old, p); else state.pairs.push(p);
  savePairs();
  navigator.vibrate?.([40, 80, 40]);
  toast('Appairé avec ' + p.name + ' ✅');
  state.showWelcome = false;
  render();
  dial(old || p);
}
function forget(id) {
  if (PC_MODE) {
    api('/api/forget?id=' + encodeURIComponent(id));
    return toast('Téléphone oublié');
  }
  const i = state.pairs.findIndex(p => p.id === id);
  if (i < 0) return;
  const [p] = state.pairs.splice(i, 1);
  savePairs();
  const s = sessions.get(id);
  if (s) { clearTimeout(s.timer); sessions.delete(id); s.pc.close(); }
  if (!state.pairs.length) state.editing = false;
  render();
  toast(`« ${p.name} » oublié`, { label: 'Annuler', run: () => {
    state.pairs.splice(i, 0, p); savePairs(); render(); dial(p);
  } });
}
async function handleHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('pair') || !h.get('fp')) return;
  history.replaceState(null, '', location.pathname);
  await addPair({
    secret: h.get('pair'), fp: h.get('fp'), port: +h.get('port') || 47800,
    ips: (h.get('ip') || '').split(',').filter(Boolean), host: h.get('host') || '', name: h.get('name') || 'PC',
  });
}

// mode PC : QR code d'appairage pour un nouveau téléphone (créé à la demande)
let pairLink = null;
async function showPairQR() {
  if (pairLink) return;
  pairLink = 'pending';
  try {
    const { link } = await (await api('/api/pair')).json();
    pairLink = link;
    $('#qrImg').src = '/api/qr?d=' + encodeURIComponent(link);
    $('#pairLink').textContent = link;
  } catch { pairLink = null; }
}

// ---------- fichiers partagés depuis une autre appli ----------
async function loadShared() {
  if (!('caches' in window)) return;
  const c = await caches.open('pasta-share');
  const files = [];
  for (const req of await c.keys()) {
    const res = await c.match(req);
    const name = decodeURIComponent(res.headers.get('x-name') || 'fichier');
    const blob = await res.blob();
    files.push(new File([blob], name, { type: blob.type }));
    await c.delete(req);
  }
  addPending(files);
}

// ---------- transferts ----------
let tid = 0;
function addTransfer(t) {
  t = { id: ++tid, done: 0, status: 'progress', time: hhmm(), ...t };
  state.transfers.unshift(t);
  update();
  return t;
}
function removeTransfers(list) {
  for (const t of list) if (t.url) URL.revokeObjectURL(t.url);
  state.transfers = state.transfers.filter(t => !list.includes(t));
  update();
}
let raf = 0;
function update() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderTransfers(); renderDeviceProgress(); syncTitle(); syncWakeLock();
  });
}
const busy = () => state.transfers.some(t => t.status === 'progress');

// Garde l'écran allumé pendant un transfert (sinon le téléphone coupe la connexion en se verrouillant)
let wake = null, waking = false;
async function syncWakeLock() {
  if (busy() && !wake && !waking && navigator.wakeLock && !document.hidden) {
    waking = true;
    try { wake = await navigator.wakeLock.request('screen'); wake.onrelease = () => { wake = null; }; } catch {}
    waking = false;
  } else if (!busy() && wake) wake.release().catch(() => {});
}

function syncTitle() {
  const act = state.transfers.filter(t => t.status === 'progress');
  const size = sum(act, t => t.size);
  document.title = act.length ? `${Math.floor(size ? sum(act, t => t.done) / size * 100 : 0)} % · Pasta Share`
    : unseen ? `(${unseen}) Pasta Share` : 'Pasta Share';
}

// ---------- affichage ----------
function devices() {
  if (PC_MODE) return state.phones.map(p => ({ id: p.id, name: p.name, online: p.online }));
  return state.pairs.map(p => ({ id: p.id, name: p.name, online: !!sessions.get(p.id)?.online }));
}
const onlineDevices = () => devices().filter(d => d.online);
const fine = matchMedia('(pointer: fine)').matches;

function render() {
  const me = $('#me');
  if (document.activeElement !== me) me.value = state.name;
  const list = devices(), online = list.filter(d => d.online), n = state.pending.length;
  const paired = list.length > 0, on = PC_MODE ? state.online : online.length > 0;
  const st = $('#status');
  st.classList.toggle('on', on);
  st.querySelector('b').textContent = on ? 'En ligne' : PC_MODE ? 'Connexion…' : paired ? 'Recherche…' : 'Prêt';

  $('#installCmd').textContent = `curl -fsSL ${new URL('install.sh', location.href).href} | sh`;
  const showWelcome = !paired || state.showWelcome;
  $('#welcome').hidden = PC_MODE || !showWelcome;
  $('#welcomePc').hidden = !PC_MODE || !showWelcome;
  if (PC_MODE && showWelcome && state.online) showPairQR();
  $('#addPc').textContent = state.showWelcome ? 'Fermer' : '+ Ajouter';
  $('#hero').hidden = !paired;

  renderTray(online);

  $('#devicesWrap').hidden = !paired;
  $('#editDevices').textContent = state.editing ? 'Terminé' : 'Modifier';
  $('#devices').innerHTML = list.map(d => {
    const sub = d.online ? (n ? '▶ envoyer ici' : '▶ touche pour envoyer') : PC_MODE ? 'ouvre Pasta sur le téléphone' : 'allume-le, même Wi-Fi';
    return `<li class="device cut ${d.online ? 'online' : 'offline'}" ${d.online ? `data-peer="${esc(d.id)}"` : ''} data-sub="${esc(sub)}">
      <i class="fill"></i>
      <span class="dev-top"><i class="led"></i><span class="state">${d.online ? 'EN LIGNE' : 'HORS LIGNE'}</span></span>
      <span class="ico">${deviceIcon(d.name)}</span>
      <span class="name">${esc(d.name)}</span>
      <span class="sub">${esc(sub)}</span>
      ${state.editing ? `<button class="forget" data-forget="${esc(d.id)}">Oublier</button>` : ''}
    </li>`;
  }).join('');
  const none = $('#noneOnline');
  none.hidden = !paired || online.length > 0;
  none.textContent = PC_MODE ? (state.online ? 'Aucun téléphone connecté : ouvre Pasta sur ton téléphone (même Wi-Fi).' : 'Récepteur injoignable : systemctl --user start pasta')
    : 'Aucun PC joignable : vérifie qu\'il est allumé et sur le même Wi-Fi.';

  let hint = !paired ? 'Aucune liaison : suis les étapes ↓'
    : !online.length ? 'Aucune cible en ligne'
    : n ? 'Choisis la cible qui doit recevoir ↓'
    : online.length === 1 ? `Cible : <b>${esc(online[0].name)}</b>`
    : `${online.length} cibles en ligne`;
  if (fine && paired) hint += ' · glisse ou colle (Ctrl+V)';
  $('#heroHint').innerHTML = hint;

  renderDeviceProgress();
  renderTransfers();
}

function renderTray(online) {
  const n = state.pending.length;
  $('#tray').hidden = !n;
  document.body.classList.toggle('pending', n > 0);
  if (!n) return;
  $('#trayTitle').textContent = `${plural(n, 'fichier')} · ${fmtSize(sum(state.pending, p => p.file.size))}`;
  $('#trayList').innerHTML = state.pending.map((p, i) => `<li class="chip">
      ${thumbHTML(p.file.name, p.file.type, p.url)}
      <span class="chip-name">${esc(p.file.name)}</span>
      <button data-unpend="${i}" aria-label="Retirer">×</button>
    </li>`).join('') + '<li><button class="chip add" data-pick="add">+ Ajouter</button></li>';
  const one = online.length === 1 ? online[0] : null, btn = $('#traySend');
  btn.hidden = !one;
  if (one) { btn.textContent = `Transmettre à ${one.name} ▶`; btn.dataset.peer = one.id; }
  $('#trayHint').hidden = !!one;
  $('#trayHint').textContent = online.length ? 'Touche la cible qui doit recevoir ↓'
    : 'Aucune cible en ligne : tes fichiers t\'attendent ici.';
}

// Progression affichée directement sur la carte de l'appareil destinataire
function renderDeviceProgress() {
  const active = new Set(state.transfers.filter(t => t.batch && t.status === 'progress').map(t => t.batch));
  for (const li of document.querySelectorAll('#devices [data-peer]')) {
    const ts = state.transfers.filter(t => active.has(t.batch) && t.batch.peerId === li.dataset.peer);
    const size = sum(ts, t => t.size), p = size ? sum(ts, t => t.done) / size : 0;
    li.classList.toggle('busy', ts.length > 0);
    li.style.setProperty('--p', p);
    li.querySelector('.sub').textContent = ts.length ? `Envoi… ${Math.floor(p * 100)} %` : li.dataset.sub;
  }
}

function metaText(t) {
  const way = t.dir === 'in' ? `↓ de ${t.peer}` : `↑ vers ${t.peer}`;
  if (t.status === 'error') return `${way} · ${t.msg || 'Erreur'}`;
  if (t.status === 'done') return `${way} · ${fmtSize(t.size)} · ✓`;
  if (!t.start) return `${way} · ${t.wait}`;
  const pct = t.size ? Math.floor(t.done / t.size * 100) : 0;
  const secs = (performance.now() - t.start) / 1000, rate = t.done / secs;
  let s = `${way} · ${pct} %`;
  if (secs > .5 && rate > 0) s += ` · ${fmtSize(rate)}/s · ${fmtDuration((t.size - t.done) / rate)}`;
  return s;
}

function transferHTML(t) {
  const thumb = thumbHTML(t.name, t.type, t.url, 'a');
  let tail = '', extra = '';
  if (t.status === 'progress') {
    tail = '<button class="x" data-act="cancel" aria-label="Annuler">×</button>';
    extra = '<div class="bar"><i></i></div>';
  } else if (t.status === 'error' && t.batch && t.msg !== 'Annulé') {
    extra = '<div class="actions"><button class="cut btn" data-act="retry">Réessayer</button></div>';
  } else if (t.status === 'done' && t.dir === 'in' && t.rid) {
    extra = '<div class="actions"><button class="cut btn" data-act="open">Ouvrir</button><button class="cut btn alt" data-act="folder">Dossier</button></div>';
  } else if (t.status === 'done' && t.dir === 'in') {
    const canShare = !!navigator.canShare?.({ files: [t.file] });
    const save = `<a class="cut btn${t.preview != null ? ' alt' : ''}" href="${t.url}" download="${esc(t.name)}">Enregistrer</a>`;
    const share = canShare ? '<button class="cut btn alt" data-act="share">Partager</button>' : '';
    if (t.preview != null) {
      const p = t.preview.trim();
      const link = isUrl(p) ? `<a class="cut btn alt" href="${esc(p)}" target="_blank" rel="noopener">Ouvrir le lien</a>` : '';
      extra = `<div class="preview"><p>${esc(p.length > 800 ? p.slice(0, 800) + '…' : p)}</p></div>
        <div class="actions"><button class="cut btn" data-act="copy">Copier</button>${link}${save}${share}</div>`;
    } else {
      extra = `<div class="actions">${save}${share}</div>`;
    }
  }
  return `${thumb}<div class="info"><div class="name"><span class="time">${t.time}</span>${esc(t.name)}</div><div class="meta"></div></div>${tail}${extra}`;
}

// Rendu par clé : on ne reconstruit une carte que si son état change, pour ne pas casser les clics
const tEls = new Map();
function renderTransfers() {
  const ul = $('#transfers');
  $('#transfersWrap').hidden = !state.transfers.length;
  const ids = new Set(state.transfers.map(t => t.id));
  for (const [id, el] of tEls) if (!ids.has(id)) { el.remove(); tEls.delete(id); }
  state.transfers.forEach((t, i) => {
    let el = tEls.get(t.id);
    if (!el) { el = document.createElement('li'); el.dataset.id = t.id; tEls.set(t.id, el); }
    const shape = t.status + (t.preview != null ? '+p' : '');
    if (el.dataset.shape !== shape) {
      el.dataset.shape = shape;
      el.className = 'transfer ' + t.status;
      el.innerHTML = transferHTML(t);
    }
    el.querySelector('.meta').textContent = metaText(t);
    if (t.status === 'progress') el.querySelector('.bar i').style.width = (t.size ? t.done / t.size * 100 : 0) + '%';
    if (ul.children[i] !== el) ul.insertBefore(el, ul.children[i] || null);
  });
  const received = state.transfers.filter(t => t.dir === 'in' && t.status === 'done' && t.url).length;
  $('#saveAll').hidden = received < 2;
  $('#clearTransfers').hidden = state.transfers.every(t => t.status === 'progress');
}

// ---------- interactions ----------
$('#devices').addEventListener('click', e => {
  const f = e.target.closest('[data-forget]');
  if (f) return forget(f.dataset.forget);
  const li = e.target.closest('[data-peer]');
  if (!li || state.editing) return;
  if (state.pending.length) sendFiles(li.dataset.peer, takePending());
  else { pickFor = li.dataset.peer; $('#picker').click(); }
});
$('#traySend').onclick = e => sendFiles(e.currentTarget.dataset.peer, takePending());
$('#trayClear').onclick = clearPending;
$('#trayList').addEventListener('click', e => {
  const b = e.target.closest('[data-unpend]');
  if (!b) return;
  const [p] = state.pending.splice(+b.dataset.unpend, 1);
  if (p.url) URL.revokeObjectURL(p.url);
  render();
});

function onPicked(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) {
    if (pickFor === 'queue') queue(files);
    else if (pickFor === 'add') addPending(files);
    else if (pickFor) sendFiles(pickFor, files);
  }
  pickFor = null;
}
$('#picker').addEventListener('change', onPicked);
$('#pickerMedia').addEventListener('change', onPicked);

$('#transfers').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const t = state.transfers.find(t => t.id == b.closest('[data-id]').dataset.id);
  if (!t) return;
  if (b.dataset.act === 'cancel') t.batch ? t.batch.cancel() : t.cancel?.();
  else if (b.dataset.act === 'retry') retry(t.batch);
  else if (b.dataset.act === 'copy') copyText(t.preview);
  else if (b.dataset.act === 'open') api('/api/open?id=' + t.rid);
  else if (b.dataset.act === 'folder') api('/api/open');
  else if (b.dataset.act === 'share') { try { await navigator.share({ files: [t.file] }); } catch {} }
});
$('#clearTransfers').onclick = () => removeTransfers(state.transfers.filter(t => t.status !== 'progress'));
$('#saveAll').onclick = async () => {
  for (const t of state.transfers.filter(t => t.dir === 'in' && t.status === 'done' && t.url)) {
    Object.assign(document.createElement('a'), { href: t.url, download: t.name }).click();
    await new Promise(r => setTimeout(r, 350));
  }
};
$('#addPc').onclick = () => { state.showWelcome = !state.showWelcome; render(); };
$('#editDevices').onclick = () => { state.editing = !state.editing; render(); };

const me = $('#me');
me.addEventListener('keydown', e => {
  if (e.key === 'Enter') me.blur();
  if (e.key === 'Escape') { me.value = state.name; me.blur(); }
});
me.addEventListener('blur', () => {
  const n = me.value.trim().slice(0, 40);
  if (n && n !== state.name) {
    state.name = n;
    if (PC_MODE) api('/api/name', { name: n });
    else { store.set('name', n); sessions.forEach(hello); }
    toast('Nom enregistré');
  }
  me.value = state.name;
});

// texte libre (lien, note…) envoyé comme fichier .txt
const dlg = $('#textDlg');
$('#textBtn').onclick = () => {
  const online = onlineDevices();
  $('#textOk').textContent = online.length === 1 && !state.pending.length ? `Envoyer à ${online[0].name}` : 'Ajouter';
  $('#textIn').value = '';
  $('#pasteBtn').hidden = !navigator.clipboard?.readText;
  dlg.showModal();
  $('#textIn').focus();
};
$('#pasteBtn').onclick = async () => {
  try { $('#textIn').value = await navigator.clipboard.readText(); $('#textIn').focus(); }
  catch { toast('Presse-papiers inaccessible : colle à la main'); }
};
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });
$('#textIn').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) dlg.close('ok'); });
dlg.addEventListener('close', () => {
  const txt = $('#textIn').value.trim();
  if (dlg.returnValue === 'ok' && txt) queue([textFile(txt)]);
});

document.addEventListener('click', e => {
  const pick = e.target.closest('[data-pick]');
  if (pick) {
    pickFor = pick.dataset.pick === 'media' ? 'queue' : pick.dataset.pick;
    (pick.dataset.pick === 'media' ? $('#pickerMedia') : $('#picker')).click();
    return;
  }
  const b = e.target.closest('[data-copy]');
  if (b) copyText(document.getElementById(b.dataset.copy).textContent);
});

// coller (Ctrl+V) des fichiers ou du texte
addEventListener('paste', e => {
  if (!devices().length || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  const txt = e.clipboardData?.getData('text')?.trim();
  if (files.length) queue(files);
  else if (txt) queue([textFile(txt)]);
});

// glisser-déposer (sur ordinateur) : n'importe où, ou directement sur un appareil
let dragDepth = 0;
const clearOver = keep => document.querySelectorAll('.device.over').forEach(d => d !== keep && d.classList.remove('over'));
addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('drag');
});
addEventListener('dragleave', () => {
  if (--dragDepth > 0) return;
  dragDepth = 0;
  document.body.classList.remove('drag');
  clearOver();
});
addEventListener('dragover', e => {
  e.preventDefault();
  const li = e.target.closest?.('[data-peer]');
  clearOver(li);
  li?.classList.add('over');
});
addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag');
  clearOver();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const li = e.target.closest?.('[data-peer]');
  li ? sendFiles(li.dataset.peer, files) : queue(files);
});

// En arrière-plan, on raccroche proprement (sauf transfert en cours) : le PC se prépare aussitôt
// pour la prochaine connexion, et on rappelle dès que l'appli revient au premier plan.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (!PC_MODE && !busy()) hangupAll(); return; }
  unseen = 0;
  connect(); update();
});
addEventListener('pagehide', () => { if (!PC_MODE) hangupAll(); });
addEventListener('beforeunload', e => { if (busy()) e.preventDefault(); });
addEventListener('hashchange', handleHash);

// ---------- démarrage ----------
(async () => {
  const shared = new URLSearchParams(location.search).has('shared');
  if (shared) { history.replaceState(null, '', location.pathname + location.hash); await loadShared().catch(() => {}); }
  render();
  connect();
  const tick = () => { $('#clock').textContent = hhmm(); };
  tick(); setInterval(tick, 10000);
  await handleHash();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
