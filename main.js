const { app, BrowserWindow, BrowserView, ipcMain, session, safeStorage, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto'), os = require('os');
const { pathToFileURL } = require('url');
const imp = require('./import');

// Chromium-Rauschen (Mojo-Fehler) ausblenden; Listener-Limit anheben (Adblock-Scriptlets hängen viele did-stop-loading-Listener an)
app.commandLine.appendSwitch('log-level', '3');
app.on('web-contents-created', (_, wc) => wc.setMaxListeners(50));

const SIDE = 60, PANEL = 360;
const HOME = pathToFileURL(path.join(__dirname, 'ui', 'start.html')).href;
const SETTINGS = pathToFileURL(path.join(__dirname, 'ui', 'settings.html')).href;
const cfg = { adblock: true, sleep: true, sleepMin: 5, netMbit: 0, favbar: true, scroll: true, ramOn: false, ramGb: 4, netOn: false, netDown: 10, netUp: 10, lockMin: 15, restore: true, bg: '', bgV: 0, bgDim: 45, bgX: 50, bgY: 50, bgFit: 'cover', bgZoom: 100, search: 'google', dlDir: '', dlAsk: false, theme: { p: '#ff3ea5', c: '#2de1e6' } };
const scrollCss = () => `::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:linear-gradient(180deg,${cfg.theme.p},${cfg.theme.c});border-radius:10px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-corner{background:transparent}`;

const topH = () => (cfg.favbar ? 120 : 88);
let data = { favs: [], pws: [], hist: [], dls: [], master: null, icons: {}, extDirs: [], groups: [], session: null,
  workspaces: [{ id: 1, name: 'Allgemein', icon: '🏠' }, { id: 2, name: 'Gaming', icon: '🎮' }, { id: 3, name: 'Arbeit', icon: '💼' }, { id: 4, name: 'Streams', icon: '📺' }] };
const tabs = new Map(), closed = [];
let win, active = null, nextId = 1, panelOpen = false, blocker = null, blocked = 0, curWs = 1, pv = null, pvUrl = null;

const dbf = () => path.join(app.getPath('userData'), 'data.json');
const load = () => { try { const d = JSON.parse(fs.readFileSync(dbf(), 'utf8')); data = Object.assign(data, d); Object.assign(cfg, d.cfg); data.dls.forEach(x => { if (x.state === 'läuft' || x.state === 'pausiert') x.state = 'unterbrochen'; }); } catch {} };
const save = () => fs.writeFileSync(dbf(), JSON.stringify({ ...data, cfg }));
let saveT; const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 3000); };

// Adblock: uBlock-Origin-Filterlisten (EasyList, uBO-Filter, Tracker) via Ghostery-Engine
async function setAdblock(on) {
  try {
    if (on) {
      if (!blocker) {
        const { ElectronBlocker } = require('@ghostery/adblocker-electron');
        blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
          path: path.join(app.getPath('userData'), 'adblock.bin'),
          read: fs.promises.readFile, write: fs.promises.writeFile
        });
        // Scriptlets abgesichert ausführen: Fehler in der Seite (z.B. YouTube) landen sonst als unhandled rejection in der Konsole
        const orig = blocker.onInjectCosmeticFilters;
        blocker.onInjectCosmeticFilters = (event, url, msg) => orig({
          frameId: event.frameId, processId: event.processId,
          sender: {
            insertCSS: (...x) => event.sender.insertCSS(...x).catch(() => {}),
            executeJavaScript: code => event.sender.executeJavaScript('try{' + code + '\n}catch(e){}', true).catch(() => {})
          }
        }, url, msg);
        blocker.on('request-blocked', () => { blocked++; });
      }
      try { blocker.enableBlockingInSession(session.defaultSession); }
      catch (e) { console.error('adblock cosmetic aus:', e.message); session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, blocker.onBeforeRequest); }
    } else if (blocker) blocker.disableBlockingInSession(session.defaultSession);
  } catch (e) { console.error('adblock:', e.message); }
}

// ---- Verlauf ----
function addHist(u) {
  if (!/^https?:/i.test(u)) return;
  const h = data.hist; if (h[0] && h[0].url === u) { h[0].ts = Date.now(); return; }
  h.unshift({ url: u, title: u, ts: Date.now() }); if (h.length > 5000) h.length = 5000; saveSoon();
}
function histTitle(u, title) { const e = data.hist.slice(0, 5).find(x => x.url === u); if (e) { e.title = title; saveSoon(); } }

// ---- Tresor (Master-Passwort): AES-256-GCM mit scrypt-Schlüssel; ohne Master: Windows-DPAPI ----
let vk = null, lastUse = 0;
const locked = () => !!data.master && !vk;
const kdf = (pw, salt) => crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: 16384 });
function aesEnc(key, txt) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(txt, 'utf8'), c.final()]);
  return 'm1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function aesDec(key, s) {
  const b = Buffer.from(s.slice(3), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const enc = t => (vk ? aesEnc(vk, t) : safeStorage.encryptString(t).toString('base64'));
const dec = p => {
  lastUse = Date.now();
  if (p.pw.startsWith('m1:')) { if (!vk) throw new Error('locked'); return aesDec(vk, p.pw); }
  return safeStorage.decryptString(Buffer.from(p.pw, 'base64'));
};

// ---- Downloads ----
const live = new Map(); let dlSeq = 0;
let saveAsNext = false, dlShow = false, dlT = 0;
function sendDl(force) {
  if (!win || win.isDestroyed()) return;
  const n = Date.now(); if (!force && n - dlT < 300) return; dlT = n;
  const run = data.dls.filter(d => d.state === 'läuft' || d.state === 'pausiert');
  const tot = run.reduce((a, d) => a + (d.total > 0 ? d.total : 0), 0), got = run.reduce((a, d) => a + (d.total > 0 ? d.got : 0), 0);
  win.webContents.send('dl', { show: dlShow, act: run.length, pct: tot ? got / tot : 0 });
}
function dlMenu(pos) {
  const T = data.dls.slice(0, 6).map(d => ({
    label: `${d.name.length > 38 ? d.name.slice(0, 35) + '…' : d.name} — ${d.state === 'läuft' && d.total > 0 ? Math.round(d.got / d.total * 100) + ' %' : d.state}`,
    submenu: [
      { label: 'Öffnen', enabled: d.state === 'fertig', click: () => shell.openPath(d.path) },
      { label: 'Im Ordner zeigen', enabled: !!d.path && fs.existsSync(d.path), click: () => shell.showItemInFolder(d.path) },
      { label: 'Abbrechen', enabled: d.state === 'läuft' || d.state === 'pausiert', click: () => { const i = live.get(d.id); if (i) i.cancel(); } }
    ]
  }));
  if (!T.length) T.push({ label: 'Keine Downloads', enabled: false });
  T.push({ type: 'separator' }, { label: 'Alle Downloads anzeigen', click: () => act('settings', 'dl') },
    { label: 'Download-Ordner öffnen', click: () => shell.openPath(cfg.dlDir || app.getPath('downloads')) });
  Menu.buildFromTemplate(T).popup({ window: win, x: pos.x, y: pos.y });
}
function hookDownloads() {
  session.defaultSession.on('will-download', (_, item) => {
    const MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };
    let fn = item.getFilename(); if (!path.extname(fn)) fn += MIME[item.getMimeType()] || '';
    const dir = cfg.dlDir || app.getPath('downloads'), ask = cfg.dlAsk || saveAsNext; saveAsNext = false;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const d = { id: Date.now() * 1000 + (dlSeq++ % 1000), name: fn, path: '', url: item.getURL(), total: item.getTotalBytes(), got: 0, state: 'läuft' };
    if (ask) item.setSaveDialogOptions({ defaultPath: path.join(dir, fn), title: 'Speichern unter' });
    else {
      const ext = path.extname(fn), base = path.basename(fn, ext); let p = path.join(dir, fn), n = 1;
      while (fs.existsSync(p)) p = path.join(dir, `${base} (${n++})${ext}`);
      item.setSavePath(p); d.path = p; d.name = path.basename(p); toast('Download gestartet: ' + d.name);
    }
    data.dls.unshift(d); if (data.dls.length > 200) data.dls.length = 200; live.set(d.id, item); dlShow = true; sendDl(true);
    item.on('updated', (_, st) => {
      const sp = item.getSavePath(); if (sp && !d.path) { d.path = sp; d.name = path.basename(sp); toast('Download gestartet: ' + d.name); }
      d.got = item.getReceivedBytes(); d.total = item.getTotalBytes();
      d.state = st === 'interrupted' ? 'unterbrochen' : item.isPaused() ? 'pausiert' : 'läuft'; sendDl();
    });
    item.once('done', (_, st) => {
      live.delete(d.id);
      if (st === 'cancelled' && !item.getSavePath()) { data.dls = data.dls.filter(x => x !== d); sendDl(true); return; }
      d.state = st === 'completed' ? 'fertig' : st === 'cancelled' ? 'abgebrochen' : 'fehlgeschlagen'; d.got = item.getReceivedBytes();
      if (!d.path) { d.path = item.getSavePath(); d.name = path.basename(d.path); }
      saveSoon(); sendDl(true);
      toast(d.state === 'fertig' ? 'Download fertig: ' + d.name : 'Download ' + d.state + ': ' + d.name);
    });
  });
}

function mkView(t) {
  const v = new BrowserView({ webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'tabpreload.js') } });
  const wc = v.webContents;
  if (ext) ext.addTab(wc, win);
  wc.setWindowOpenHandler(({ url, disposition }) => { newTab(url, disposition === 'background-tab'); return { action: 'deny' }; });
  wc.on('before-input-event', key);
  wc.on('context-menu', (_, p) => ctxMenu(wc, p));
  wc.on('dom-ready', () => { if (cfg.scroll) wc.insertCSS(scrollCss(), { cssOrigin: 'user' }).catch(() => {}); });
  wc.on('page-title-updated', (_, title) => { t.title = title; histTitle(t.url, title); push(); });
  wc.on('page-favicon-updated', (_, f) => { t.icon = f[0]; knownIcon[hostOf(t.url)] = f[0]; push(); });
  wc.on('did-navigate', (_, u) => { t.url = u; addHist(u); push(); });
  wc.on('did-navigate-in-page', (_, u) => { t.url = u; addHist(u); push(); });
  wc.on('did-start-loading', push); wc.on('did-stop-loading', push);
  wc.loadURL(t.url);
  t.view = v; t.sleeping = false;
}

function newTab(url = HOME, bg = false, lazy = false, ex = {}) {
  const id = nextId++;
  const t = { url, title: ex.title || (lazy ? url : 'Neuer Tab'), icon: '', view: null, sleeping: lazy, last: Date.now(), ws: ex.ws || curWs, g: ex.g || null };
  tabs.set(id, t);
  if (!bg) show(id); else { if (!lazy) mkView(t); push(); }
  return id;
}

function show(id) {
  const t = tabs.get(id); if (!t) return;
  const cur = tabs.get(active);
  if (cur && cur.view) win.removeBrowserView(cur.view);
  active = id; curWs = t.ws;
  if (!t.view) mkView(t);
  t.last = Date.now();
  win.addBrowserView(t.view);
  if (ext) ext.selectTab(t.view.webContents);
  layout(); push();
}

function closeTab(id) {
  const t = tabs.get(id); if (!t) return;
  if (t.url !== HOME) closed.push(t.url);
  if (t.view) { win.removeBrowserView(t.view); t.view.webContents.close(); }
  tabs.delete(id);
  data.groups = data.groups.filter(g => [...tabs.values()].some(x => x.g === g.id));
  if (id === active) { active = null; const ids = [...tabs].filter(([, x]) => x.ws === curWs).map(([i]) => i); ids.length ? show(ids[ids.length - 1]) : newTab(); } else push();
}

const PV = 420;
function layout() {
  const [w, h] = win.getContentSize(), pw = pv ? PV : 0;
  if (pv) pv.setBounds({ x: SIDE, y: topH(), width: PV, height: h - topH() });
  const t = tabs.get(active); if (!t || !t.view) return;
  t.view.setBounds({ x: SIDE + pw, y: topH(), width: w - SIDE - pw - (panelOpen ? PANEL : 0), height: h - topH() });
}

function push() {
  if (!win || win.isDestroyed()) return;
  snap();
  ensureIcons(data.favs.filter(f => f.pin).map(f => f.url));
  const a = tabs.get(active), wc = a && a.view ? a.view.webContents : null;
  win.webContents.send('state', {
    active, cfg, home: HOME, loading: wc ? wc.isLoading() : false,
    canBack: wc ? wc.navigationHistory.canGoBack() : false, canFwd: wc ? wc.navigationHistory.canGoForward() : false,
    pins: data.favs.filter(f => f.pin).map(({ title, url }) => ({ title, url, icon: data.icons[hostOf(url)] || '' })),
    faved: !!a && data.favs.some(f => f.url === a.url),
    groups: data.groups.filter(g => g.ws === curWs), ws: data.workspaces, curWs, panel: pvUrl,
    tabs: [...tabs].filter(([, t]) => t.ws === curWs).map(([id, t]) => ({ id, title: t.title, url: t.url, icon: t.icon, sleeping: t.sleeping, g: t.g }))
  });
}

function applyNet() {
  const on = cfg.netOn, d = on ? cfg.netDown * 125000 : 0, u = on ? cfg.netUp * 125000 : 0;
  session.defaultSession.enableNetworkEmulation({ offline: false, latency: 0, downloadThroughput: d, uploadThroughput: u });
}

function sleepTab(t) { t.view.webContents.close(); t.view = null; t.sleeping = true; }

const toast = m => { if (win && !win.isDestroyed()) win.webContents.send('toast', m); };
const GCOL = ['#ff3ea5', '#2de1e6', '#b36bff', '#ffcc33', '#00ff7f', '#ff7a3d'];

// ---- Session ----
function snap() {
  if (!tabs.size) return;
  data.session = { cur: curWs, active, tabs: [...tabs].map(([id, t]) => ({ id, url: t.url, title: t.title, ws: t.ws, g: t.g })) }; saveSoon();
}
function restore() {
  const s = data.session; if (!s || !s.tabs || !s.tabs.length) return newTab();
  const map = {}; curWs = 1; data.groups.forEach(g => { g.ws = 1; });
  s.tabs.forEach(x => { map[x.id] = newTab(x.url, true, true, { title: x.title, ws: 1, g: x.g }); });
  show(map[s.active] || Object.values(map)[0]);
}

// ---- Workspaces & Gruppen ----
function setWs(w) {
  if (w === curWs) return; curWs = w;
  const c = [...tabs].filter(([, t]) => t.ws === w).sort((a, b) => b[1].last - a[1].last)[0];
  c ? show(c[0]) : newTab();
}
function regroup() {
  const arr = [...tabs], out = [], seen = new Set();
  for (const e of arr) {
    const g = e[1].g;
    if (!g) { out.push(e); continue; }
    if (seen.has(g)) continue; seen.add(g);
    arr.filter(x => x[1].g === g).forEach(x => out.push(x));
  }
  tabs.clear(); out.forEach(([id, t]) => tabs.set(id, t));
}
function setGroup(id, g) {
  const t = tabs.get(id); if (!t) return; t.g = g; regroup();
  data.groups = data.groups.filter(x => [...tabs.values()].some(y => y.g === x.id)); save(); push();
}
function moveWs(id, w) {
  const t = tabs.get(id); if (!t) return; const was = id === active; t.ws = w; t.g = null; regroup();
  if (was) { if (t.view) win.removeBrowserView(t.view); active = null; const o = [...tabs].find(([, x]) => x.ws === curWs); o ? show(o[0]) : newTab(); } else push();
}
function tabMenu(id) {
  const t = tabs.get(id); if (!t) return;
  const mine = data.groups.filter(g => g.ws === curWs);
  Menu.buildFromTemplate([
    { label: 'Neue Gruppe mit diesem Tab', click: () => { const g = { id: Date.now(), name: 'Gruppe ' + (data.groups.length + 1), color: GCOL[data.groups.length % GCOL.length], ws: curWs }; data.groups.push(g); setGroup(id, g.id); } },
    ...(mine.length ? [{ label: 'Zu Gruppe hinzufügen', submenu: mine.map(g => ({ label: g.name, click: () => setGroup(id, g.id) })) }] : []),
    ...(t.g ? [{ label: 'Aus Gruppe entfernen', click: () => setGroup(id, null) }, { label: 'Gruppe schließen', click: () => [...tabs].filter(([, x]) => x.g === t.g).forEach(([k]) => closeTab(k)) }] : []),
    { type: 'separator' },
    { label: 'Duplizieren', click: () => newTab(t.url, false, false, { ws: t.ws, g: t.g }) },
    { type: 'separator' },
    { label: 'Andere Tabs schließen', click: () => [...tabs].filter(([k, x]) => k !== id && x.ws === t.ws).forEach(([k]) => closeTab(k)) },
    { label: 'Tab schließen', click: () => closeTab(id) }
  ]).popup({ window: win });
}

// ---- Seitenfenster (Discord, Twitch, ... neben dem Tab) ----
function sidePanel(url) {
  const same = pvUrl === url;
  if (pv) { win.removeBrowserView(pv); pv.webContents.close(); pv = null; pvUrl = null; }
  if (!url || same) { layout(); push(); return; }
  pv = new BrowserView({ webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'tabpreload.js') } });
  pv.webContents.setWindowOpenHandler(({ url: u }) => { newTab(u); return { action: 'deny' }; });
  pv.webContents.on('before-input-event', key);
  pv.webContents.on('context-menu', (_, p) => ctxMenu(pv.webContents, p));
  pv.webContents.loadURL(url); pvUrl = url; win.addBrowserView(pv); layout(); push();
}

// ---- Gaming-Modus & Screenshot ----
function prio() {
  const lv = cfg.gaming ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  for (const m of app.getAppMetrics()) { try { os.setPriority(m.pid, lv); } catch {} }
}
function setGaming(on) {
  if (on && !cfg.gaming) { cfg.prev = { sleep: cfg.sleep, sleepMin: cfg.sleepMin, ramOn: cfg.ramOn }; Object.assign(cfg, { gaming: true, sleep: true, sleepMin: 1, ramOn: true }); }
  else if (!on && cfg.gaming) { Object.assign(cfg, cfg.prev || {}, { gaming: false }); delete cfg.prev; }
  prio(); save(); push(); toast(on ? 'Gaming-Modus an' : 'Gaming-Modus aus');
}
async function shot() {
  const t = tabs.get(active); if (!t || !t.view) return;
  const img = await t.view.webContents.capturePage(), dir = path.join(app.getPath('pictures'), 'nxRift');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'Screenshot-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
  fs.writeFileSync(f, img.toPNG()); toast('Screenshot gespeichert'); shell.showItemInFolder(f);
}

// ---- Auto-Update (nur im installierten Build) ----
function updater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-available', () => toast('Update gefunden – wird geladen…'));
    autoUpdater.on('update-downloaded', () => toast('Update bereit – wird beim Beenden installiert'));
    autoUpdater.on('error', e => console.error('updater:', e.message));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check(); setInterval(check, 4 * 3600 * 1000);
  } catch (e) { console.error('updater:', e.message); }
}

// ---- Rechtsklick-Menü auf Webseiten (Link, Bild, Text, Eingabefeld, Seite) ----
function ctxMenu(wc, p, ui) {
  const T = [];
  const sep = () => { if (T.length && T[T.length - 1].type !== 'separator') T.push({ type: 'separator' }); };
  if (p.misspelledWord) {
    (p.dictionarySuggestions || []).slice(0, 5).forEach(sg => T.push({ label: sg, click: () => wc.replaceMisspelling(sg) }));
    T.push({ label: 'Zum Wörterbuch hinzufügen', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }); sep();
  }
  if (p.isEditable) {
    const f = p.editFlags;
    T.push({ label: 'Rückgängig', enabled: f.canUndo, click: () => wc.undo() }, { label: 'Wiederholen', enabled: f.canRedo, click: () => wc.redo() }, { type: 'separator' },
      { label: 'Ausschneiden', enabled: f.canCut, click: () => wc.cut() }, { label: 'Kopieren', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Einfügen', enabled: f.canPaste, click: () => wc.paste() }, { label: 'Alles auswählen', enabled: f.canSelectAll, click: () => wc.selectAll() });
  } else if (p.selectionText && p.selectionText.trim()) {
    const sel = p.selectionText.trim();
    T.push({ label: 'Kopieren', click: () => wc.copy() }, { label: `„${sel.slice(0, 28)}${sel.length > 28 ? '…' : ''}“ im Web suchen`, click: () => newTab((SEARCH[cfg.search] || SEARCH.google) + encodeURIComponent(sel)) });
  }
  if (ui) { if (T.length) Menu.buildFromTemplate(T).popup({ window: win }); return; }
  if (p.linkURL) {
    sep(); T.push({ label: 'Link in neuem Tab öffnen', click: () => newTab(p.linkURL) }, { label: 'Link im Hintergrund öffnen', click: () => newTab(p.linkURL, true) },
      { label: 'Link speichern unter…', click: () => { saveAsNext = true; wc.downloadURL(p.linkURL); } },
      { label: 'Linkadresse kopieren', click: () => clipboard.writeText(p.linkURL) });
  }
  if (p.mediaType === 'image' && p.srcURL) {
    sep(); T.push({ label: 'Bild in neuem Tab öffnen', click: () => newTab(p.srcURL) }, { label: 'Bild speichern', click: () => wc.downloadURL(p.srcURL) },
      { label: 'Bild speichern unter…', click: () => { saveAsNext = true; wc.downloadURL(p.srcURL); } },
      { label: 'Bild kopieren', click: () => wc.copyImageAt(p.x, p.y) }, { label: 'Bildadresse kopieren', click: () => clipboard.writeText(p.srcURL) },
      { label: 'Bild mit Google suchen', click: () => newTab('https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(p.srcURL)) });
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && /^https?:/i.test(p.srcURL || '')) {
    sep(); T.push({ label: 'Medium speichern', click: () => wc.downloadURL(p.srcURL) }, { label: 'Medium speichern unter…', click: () => { saveAsNext = true; wc.downloadURL(p.srcURL); } }, { label: 'Medienadresse kopieren', click: () => clipboard.writeText(p.srcURL) });
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !(p.selectionText || '').trim()) {
    const h = wc.navigationHistory;
    T.push({ label: 'Zurück', enabled: h.canGoBack(), click: () => h.goBack() }, { label: 'Vor', enabled: h.canGoForward(), click: () => h.goForward() }, { label: 'Neu laden', click: () => wc.reload() },
      { type: 'separator' }, { label: 'Als Favorit speichern', click: () => act('fav') }, { label: 'Screenshot', click: () => shot() }, { label: 'Seitenadresse kopieren', click: () => clipboard.writeText(p.pageURL) });
  }
  if (ext) { try { const it = ext.getContextMenuItems(wc, p); if (it.length) { sep(); T.push(...it); } } catch {} }
  sep(); T.push({ label: 'Element untersuchen', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(T).popup({ window: win });
}

// ---- Suchmaschinen ----
const SEARCH = {
  google: 'https://www.google.com/search?q=', duckduckgo: 'https://duckduckgo.com/?q=', bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=', ecosia: 'https://www.ecosia.org/search?q=', startpage: 'https://www.startpage.com/do/search?q='
};

// ---- Favicons: über saubere Session laden (kein Adblock), als Data-URL cachen ----
const knownIcon = {}, iconMiss = new Set(); let icBusy = false;
async function fetchIcon(h) {
  const ses = session.fromPartition('nxicons');
  const cand = [knownIcon[h], `https://${h}/favicon.ico`, `https://icons.duckduckgo.com/ip3/${h}.ico`, `https://www.google.com/s2/favicons?domain=${h}&sz=64`].filter(Boolean);
  for (const u of cand) {
    if (u.startsWith('data:')) { if (u.length < 80000) return u; continue; }
    try {
      const r = await ses.fetch(u, { signal: AbortSignal.timeout(4000) });
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      if (!r.ok || !/^image\//.test(ct)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 60 && buf.length < 80000) return `data:${ct};base64,${buf.toString('base64')}`;
    } catch {}
  }
  return null;
}
const iconable = h => !!h && h !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(h);
async function ensureIcons(urls) {
  const miss = [...new Set(urls.map(hostOf))].filter(h => iconable(h) && !(h in data.icons) && !iconMiss.has(h));
  if (!miss.length || icBusy) return; icBusy = true;
  for (const h of miss) { const i = await fetchIcon(h); if (i) data.icons[h] = i; else iconMiss.add(h); }
  icBusy = false; saveSoon(); push();
}

const bgUrl = () => (cfg.bg ? pathToFileURL(path.join(app.getPath('userData'), cfg.bg)).href + '?v=' + cfg.bgV : '');

// ---- Chrome-Erweiterungen (electron-chrome-extensions + Chrome Web Store) ----
let ext = null;
const tabByWc = wc => [...tabs].find(([, t]) => t.view && t.view.webContents === wc);
async function confirmExt(d) {
  const m = d.manifest || {}, perms = [...(m.permissions || []), ...(m.host_permissions || [])].filter(x => typeof x === 'string');
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Hinzufügen', 'Abbrechen'], defaultId: 1, cancelId: 1, title: 'Erweiterung hinzufügen', message: `„${d.localizedName}“ hinzufügen?`,
    detail: perms.length ? 'Diese Erweiterung darf:\n• ' + perms.slice(0, 12).join('\n• ') + (perms.length > 12 ? `\n… und ${perms.length - 12} weitere` : '') : 'Es werden keine besonderen Berechtigungen angefordert.'
  });
  return { action: r.response === 0 ? 'allow' : 'deny' };
}
async function initExtensions() {
  try {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    const { installChromeWebStore } = require('electron-chrome-web-store');
    const ses = session.defaultSession;
    ElectronChromeExtensions.handleCRXProtocol(ses);
    ext = new ElectronChromeExtensions({
      session: ses,
      createTab: async d => { const id = newTab(d.url || HOME, d.active === false); const t = tabs.get(id); if (!t.view) mkView(t); return [t.view.webContents, win]; },
      selectTab: wc => { const e = tabByWc(wc); if (e) show(e[0]); },
      removeTab: wc => { const e = tabByWc(wc); if (e) closeTab(e[0]); },
      createWindow: async d => { [].concat(d.url || []).forEach(u => newTab(u)); return win; }
    });
    await installChromeWebStore({ session: ses, autoUpdate: true, beforeInstall: confirmExt });
    for (const dir of data.extDirs) { try { await ses.extensions.loadExtension(dir, { allowFileAccess: true }); } catch (e) { console.error('ext:', dir, e.message); } }
  } catch (e) { console.error('Erweiterungen deaktiviert:', e.message); ext = null; }
}

function act(c, a) {
  const t = tabs.get(active), wc = t && t.view ? t.view.webContents : null;
  const ids = [...tabs].filter(([, x]) => x.ws === curWs).map(([k]) => k), i = ids.indexOf(active);
  switch (c) {
    case 'new': newTab(a); break;
    case 'switch': show(a); break;
    case 'close': closeTab(a ?? active); break;
    case 'reopen': closed.length && newTab(closed.pop()); break;
    case 'next': show(ids[(i + (a || 1) + ids.length) % ids.length]); break;
    case 'nth': ids.length && show(a === 9 ? ids[ids.length - 1] : ids[a - 1] ?? ids[ids.length - 1]); break;
    case 'go': if (wc) { t.url = a; wc.loadURL(a); } break;
    case 'back': wc && wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(); break;
    case 'fwd': wc && wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(); break;
    case 'reload': wc && (wc.isLoading() ? wc.stop() : wc.reload()); break;
    case 'devtools': wc && wc.toggleDevTools(); break;
    case 'addr': win.webContents.focus(); win.webContents.send('focus-addr'); break;
    case 'settings': {
      const url = SETTINGS + (a ? '#' + a : ''), e = [...tabs].find(([, x]) => x.url.split('#')[0] === SETTINGS);
      if (!e) { newTab(url); break; }
      e[1].url = url; if (e[1].view) e[1].view.webContents.loadURL(url); show(e[0]); break;
    }
    case 'fav': if (t) {
      const k = data.favs.findIndex(f => f.url === t.url);
      k >= 0 ? data.favs.splice(k, 1) : data.favs.push({ title: t.title, url: t.url, pin: true });
      save(); push();
    } break;
    case 'pwsave': if (pending) {
      const e2 = enc(pending.pw);
      pending.ex ? (pending.ex.pw = e2) : data.pws.push({ url: pending.url, user: pending.user, pw: e2 });
      save();
    } // fallthrough
    case 'pwno': pending = null; clearTimeout(pTimer); prompt(null); break;
    case 'tabmenu': tabMenu(a); break;
    case 'grpname': { const g = data.groups.find(x => x.id === a.id); if (g) { g.name = String(a.name || '').slice(0, 24) || g.name; save(); push(); } break; }
    case 'grptoggle': { const g = data.groups.find(x => x.id === a); if (g) { g.collapsed = !g.collapsed; save(); push(); } break; }
    case 'sidepanel': sidePanel(a); break;
    case 'gaming': setGaming(!!a); break;
    case 'shot': shot(); break;
    case 'dlmenu': dlMenu(a); break;
    case 'panel': panelOpen = !!a; layout(); break;
    case 'cfg': {
      if (a.theme && !(/^#[0-9a-f]{6}$/i.test(a.theme.p) && /^#[0-9a-f]{6}$/i.test(a.theme.c))) delete a.theme;
      if (a.search && !SEARCH[a.search]) delete a.search;
      if (a.bgDim !== undefined) a.bgDim = Math.min(85, Math.max(0, +a.bgDim || 0));
      for (const k of ['bgX', 'bgY']) if (a[k] !== undefined) a[k] = Math.min(100, Math.max(0, +a[k] || 0));
      if (a.bgZoom !== undefined) a.bgZoom = Math.min(300, Math.max(100, +a.bgZoom || 100));
      if (a.bgFit !== undefined && !['cover', 'contain'].includes(a.bgFit)) delete a.bgFit;
      const was = cfg.adblock; Object.assign(cfg, a); applyNet(); layout(); save();
      if (was !== cfg.adblock) setAdblock(cfg.adblock);
      push(); break;
    }
    case 'min': win.minimize(); break;
    case 'max': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
    case 'quit': win.close(); break;
  }
}

// Keybinds (gelten im UI und in jeder Webseite)
function key(e, i) {
  if (i.type !== 'keyDown') return;
  const k = i.key.toLowerCase(), c = i.control, s = i.shift;
  let h = true;
  if (c && k === 't') { act(s ? 'reopen' : 'new'); if (!s) act('addr'); }
  else if (c && k === 'w') act('close');
  else if (c && k === 'tab') act('next', s ? -1 : 1);
  else if (c && /^[1-9]$/.test(k)) act('nth', +k);
  else if ((c && k === 'l') || (i.alt && k === 'd')) act('addr');
  else if (k === 'f5' || (c && k === 'r')) act('reload');
  else if (c && k === 'd') act('fav');
  else if (c && k === ',') act('settings');
  else if (c && k === 'h') act('settings', 'hist');
  else if (c && k === 'j') act('settings', 'dl');
  else if (c && s && k === 's') act('shot');
  else if (k === 'f12') act('devtools');
  else if (i.alt && k === 'arrowleft') act('back');
  else if (i.alt && k === 'arrowright') act('fwd');
  else h = false;
  if (h) e.preventDefault();
}

ipcMain.on('cmd', (_, c, a) => act(c, a));
ipcMain.handle('stats', () => {
  const m = app.getAppMetrics(), by = new Map(m.map(x => [x.pid, x])), per = {}, perCpu = {};
  for (const [id, t] of tabs) if (t.view) {
    const p = by.get(t.view.webContents.getOSProcessId());
    per[id] = p ? Math.round(p.memory.workingSetSize / 1024) : 0; perCpu[id] = p ? p.cpu.percentCPUUsage : 0;
  }
  return { ramMB: Math.round(m.reduce((a, x) => a + x.memory.workingSetSize, 0) / 1024), cpu: +m.reduce((a, x) => a + x.cpu.percentCPUUsage, 0).toFixed(1), per, perCpu, blocked };
});

// Autofill: Host wird aus dem Sender bestimmt, nie aus Seiten-Argumenten
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const secure = u => { try { const x = new URL(u); return x.protocol === 'https:' || x.hostname === 'localhost'; } catch { return false; } };
const lastUser = {}; let pending = null, pTimer = null;
const prompt = v => { win.webContents.send('pwprompt', v); };
ipcMain.handle('pw:match', e => {
  const u = e.senderFrame.url; if (!secure(u) || locked()) return { list: [], pref: null };
  const h = hostOf(u);
  return { list: data.pws.filter(p => hostOf(p.url) === h).map(p => ({ user: p.user, pw: dec(p) })), pref: lastUser[h] || null };
});
ipcMain.on('pw:user', (e, v) => { if (secure(e.senderFrame.url) && typeof v === 'string') lastUser[hostOf(e.senderFrame.url)] = v.slice(0, 200); });
ipcMain.on('pw:cap', (e, c) => {
  const u = e.senderFrame.url; if (!secure(u) || !c || !c.pw || locked()) return;
  const h = hostOf(u), user = String(c.user || lastUser[h] || '').slice(0, 200);
  const ex = data.pws.find(p => hostOf(p.url) === h && p.user === user);
  if (ex && dec(ex) === c.pw) return;
  pending = { url: new URL(u).origin, user, pw: String(c.pw), ex };
  prompt({ host: h, user, update: !!ex });
  clearTimeout(pTimer); pTimer = setTimeout(() => { pending = null; prompt(null); }, 90000);
});

// Einstellungsseite: nur von settings.html aufrufbar
const H = (n, f) => ipcMain.handle(n, (e, ...a) => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith(SETTINGS)) throw new Error('denied');
  return f(...a);
});
H('imp:detect', () => imp.detect());
H('imp:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Profil- oder "User Data"-Ordner des Browsers wählen' });
  return r.canceled ? null : imp.custom(r.filePaths[0]);
});
H('imp:run', async (id, dir, kinds) => {
  const r = { fav: 0, pw: 0, tabs: 0, err: [] };
  if (!imp.valid(id, dir)) { r.err.push('Ungültiges Profil'); return r; }
  if (kinds.includes('fav')) try {
    for (const b of await imp.bookmarks(id, dir)) if (!data.favs.some(f => f.url === b.url)) { data.favs.push(b); r.fav++; }
  } catch (e) { r.err.push('Favoriten: ' + e.message); }
  if (kinds.includes('pw')) try {
    if (locked()) throw new Error('Tresor ist gesperrt – erst entsperren');
    const l = await imp.passwords(id, dir);
    for (const p of l) if (!data.pws.some(x => x.url === p.url && x.user === p.user)) {
      data.pws.push({ url: p.url, user: p.user, pw: enc(p.pw) }); r.pw++;
    }
    if (l.skipped) r.err.push(l.skipped + ' Passwörter nicht entschlüsselbar (neueres Verschlüsselungsformat)');
  } catch (e) { r.err.push('Passwörter: ' + e.message + (/EBUSY|EPERM|EACCES/.test(e.code || '') ? ' (Browser komplett schließen!)' : '')); }
  if (kinds.includes('tabs')) try {
    const u = await imp.tabs(id, dir); u.forEach(x => newTab(x, true, true)); r.tabs = u.length;
  } catch (e) { r.err.push('Tabs: ' + e.message); }
  save(); push(); return r;
});
H('fav:list', () => data.favs);
H('fav:pin', (u, on) => { const f = data.favs.find(x => x.url === u); if (f) { f.pin = !!on; save(); push(); } });
H('fav:add', (t, u) => {
  u = String(u || '').trim(); if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!data.favs.some(f => f.url === u)) { data.favs.push({ title: String(t || '').trim() || hostOf(u), url: u, pin: true }); save(); push(); }
});
ipcMain.handle('home:pins', async e => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith(HOME)) throw new Error('denied');
  const l = data.favs.filter(f => f.pin);
  await Promise.race([ensureIcons(l.map(f => f.url)), new Promise(r => setTimeout(r, 3500))]);
  return l.map(({ title, url }) => ({ title, url, icon: data.icons[hostOf(url)] || '' }));
});
H('fav:del', u => { data.favs = data.favs.filter(f => f.url !== u); save(); push(); });
H('fav:open', u => newTab(u));
H('pw:list', () => data.pws.map(({ url, user }) => ({ url, user })));
H('pw:get', i => dec(data.pws[i]));
H('pw:del', i => { data.pws.splice(i, 1); save(); });
H('vault:status', () => ({ master: !!data.master, locked: locked() }));
H('vault:set', pw => {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('zu kurz');
  const plain = data.pws.map(dec), salt = crypto.randomBytes(16).toString('base64'), key = kdf(pw, salt);
  data.master = { salt, check: aesEnc(key, 'nxrift-ok') }; vk = key; lastUse = Date.now();
  data.pws.forEach((p, i) => { p.pw = aesEnc(vk, plain[i]); }); save();
});
H('vault:unlock', pw => {
  if (!data.master) return true;
  try { const k = kdf(String(pw), data.master.salt); if (aesDec(k, data.master.check) !== 'nxrift-ok') return false; vk = k; lastUse = Date.now(); return true; } catch { return false; }
});
H('vault:lock', () => { vk = null; });
H('vault:remove', () => {
  const plain = data.pws.map(dec); data.master = null; vk = null;
  data.pws.forEach((p, i) => { p.pw = enc(plain[i]); }); save();
});
H('hist:list', () => data.hist);
H('hist:del', ts => { data.hist = data.hist.filter(x => x.ts !== ts); save(); });
H('hist:clear', () => { data.hist = []; save(); });
H('dl:list', () => data.dls);
H('dl:open', id => { const d = data.dls.find(x => x.id === id); if (d) shell.openPath(d.path); });
H('dl:show', id => { const d = data.dls.find(x => x.id === id); if (d) shell.showItemInFolder(d.path); });
H('dl:cancel', id => { const i = live.get(id); if (i) i.cancel(); });
H('dl:clear', () => { data.dls = data.dls.filter(x => x.state === 'läuft' || x.state === 'pausiert'); save(); });
ipcMain.handle('home:theme', e => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith(HOME)) throw new Error('denied');
  return { ...cfg.theme, q: SEARCH[cfg.search] || SEARCH.google, bg: bgUrl(), dim: cfg.bgDim, x: cfg.bgX, y: cfg.bgY, fit: cfg.bgFit, zoom: cfg.bgZoom };
});
H('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
H('app:update', async () => {
  if (!app.isPackaged) return 'Nur im installierten Build verfügbar';
  try { const r = await require('electron-updater').autoUpdater.checkForUpdates(); return r && r.updateInfo ? 'Neueste Version: ' + r.updateInfo.version : 'Kein Update gefunden'; }
  catch (e) { return 'Prüfung fehlgeschlagen: ' + String(e.message).slice(0, 120); }
});
H('dl:dir', () => cfg.dlDir || app.getPath('downloads'));
H('dl:pickdir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Download-Ordner wählen', defaultPath: cfg.dlDir || app.getPath('downloads') });
  if (!r.canceled) { cfg.dlDir = r.filePaths[0]; save(); }
  return cfg.dlDir || app.getPath('downloads');
});
H('dl:resetdir', () => { cfg.dlDir = ''; save(); return app.getPath('downloads'); });
H('icon:get', async hosts => {
  const out = {};
  await Promise.all((Array.isArray(hosts) ? hosts : []).slice(0, 40).map(async h => {
    if (typeof h !== 'string' || !/^[\w.-]+$/.test(h) || !iconable(h)) return;
    if (!(h in data.icons) && !iconMiss.has(h)) { const i = await fetchIcon(h); if (i) data.icons[h] = i; else iconMiss.add(h); }
    out[h] = data.icons[h] || null;
  }));
  saveSoon(); return out;
});
H('bg:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'Hintergrundbild wählen', filters: [{ name: 'Bilder', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }] });
  if (r.canceled) return cfg.bg;
  const ext = path.extname(r.filePaths[0]).toLowerCase(), dir = app.getPath('userData');
  if (cfg.bg) try { fs.unlinkSync(path.join(dir, cfg.bg)); } catch {}
  cfg.bg = 'startbg' + ext; fs.copyFileSync(r.filePaths[0], path.join(dir, cfg.bg)); cfg.bgV = Date.now(); cfg.bgX = 50; cfg.bgY = 50; cfg.bgZoom = 100; save(); return cfg.bg;
});
H('bg:url', () => bgUrl());
H('bg:clear', () => { if (cfg.bg) try { fs.unlinkSync(path.join(app.getPath('userData'), cfg.bg)); } catch {} cfg.bg = ''; save(); return ''; });
const exts = () => session.defaultSession.extensions;
H('ext:list', () => exts().getAllExtensions().map(e => {
  const m = e.manifest || {};
  return { id: e.id, name: e.name, version: e.version, desc: m.description || '', opts: !!(m.options_page || (m.options_ui && m.options_ui.page)), unpacked: data.extDirs.includes(e.path) };
}));
H('ext:store', () => { newTab('https://chromewebstore.google.com/'); });
H('ext:options', id => {
  const e = exts().getExtension(id), m = e && e.manifest, p = m && (m.options_page || (m.options_ui && m.options_ui.page));
  if (p) newTab(`chrome-extension://${id}/${p}`);
});
H('ext:remove', async id => {
  const e = exts().getExtension(id); if (!e) return;
  if (data.extDirs.includes(e.path)) { data.extDirs = data.extDirs.filter(x => x !== e.path); save(); exts().removeExtension(id); }
  else await require('electron-chrome-web-store').uninstallExtension(id, { session: session.defaultSession });
});
H('ext:loaddir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Ordner einer entpackten Erweiterung wählen (mit manifest.json)' });
  if (r.canceled) return null;
  try { const e = await exts().loadExtension(r.filePaths[0], { allowFileAccess: true }); if (!data.extDirs.includes(r.filePaths[0])) data.extDirs.push(r.filePaths[0]); save(); return e.name; }
  catch (er) { return 'Fehler: ' + er.message; }
});
H('ext:update', async () => {
  try { await require('electron-chrome-web-store').updateExtensions({ session: session.defaultSession }); return 'Updates geprüft'; }
  catch (e) { return 'Fehler: ' + e.message; }
});
H('cfg:get', () => cfg);
H('cfg:set', o => act('cfg', o));

app.whenReady().then(() => {
  load(); if (cfg.gaming) { Object.assign(cfg, cfg.prev || {}, { gaming: false }); delete cfg.prev; }
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent().replace(/\s(Electron|nxRift)\/\S+/g, ''));
  applyNet(); hookDownloads(); updater();
  setInterval(() => { if (cfg.gaming) prio(); }, 10000); if (cfg.adblock) setAdblock(true);
  setInterval(() => { if (vk && Date.now() - lastUse > cfg.lockMin * 60000) vk = null; }, 30000);
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 560, frame: false, backgroundColor: '#0a0a12',
    title: 'nxRift', icon: path.join(__dirname, 'ui', 'logo.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.on('before-input-event', key);
  win.webContents.on('context-menu', (_, p) => ctxMenu(win.webContents, p, true));
  try { session.defaultSession.setSpellCheckerLanguages(['de-DE', 'en-US']); } catch {}
  win.webContents.once('did-finish-load', async () => { await initExtensions(); if (cfg.restore) restore(); else newTab(); });
  win.on('resize', layout); win.on('maximize', layout); win.on('unmaximize', layout);
  win.on('app-command', (_, c) => { if (c === 'browser-backward') act('back'); if (c === 'browser-forward') act('fwd'); });

  setInterval(() => {
    if (!cfg.sleep) return;
    for (const [id, t] of tabs) if (id !== active && t.view && Date.now() - t.last > cfg.sleepMin * 60000) {
      sleepTab(t); push();
    }
  }, 30000);

  // RAM-Limiter (weich): über dem Limit werden die speicherhungrigsten inaktiven Tabs eingeschläfert
  setInterval(() => {
    if (!cfg.ramOn) return;
    const m = app.getAppMetrics(), by = new Map(m.map(x => [x.pid, x.memory.workingSetSize / 1024]));
    let total = [...by.values()].reduce((a, b) => a + b, 0); const lim = cfg.ramGb * 1024;
    if (total <= lim) return;
    const c = [...tabs].filter(([id, t]) => id !== active && t.view)
      .map(([, t]) => [t, by.get(t.view.webContents.getOSProcessId()) || 0]).sort((a, b) => b[1] - a[1]);
    for (const [t, mb] of c) { if (total <= lim) break; sleepTab(t); total -= mb; }
    push();
  }, 5000);
});
app.on('before-quit', () => { snap(); save(); });
app.on('window-all-closed', () => app.quit());
