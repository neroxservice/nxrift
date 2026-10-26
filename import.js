// Import aus Browsern (Windows): Favoriten, Passwörter, Tabs (grob). Chromium-Familie + Firefox (nur Favoriten)
const fs = require('fs'), path = require('path'), os = require('os');
const crypto = require('crypto'), { execFileSync } = require('child_process');
const A = process.env.APPDATA || '', L = process.env.LOCALAPPDATA || '';
const ops = n => [path.join(A, 'Opera Software', n), path.join(L, 'Opera Software', n)];
const B = [
  { id: 'operagx', name: 'Opera GX', roots: ops('Opera GX Stable') },
  { id: 'opera', name: 'Opera', roots: ops('Opera Stable') },
  { id: 'chrome', name: 'Google Chrome', roots: [path.join(L, 'Google', 'Chrome', 'User Data')] },
  { id: 'chromebeta', name: 'Chrome Beta', roots: [path.join(L, 'Google', 'Chrome Beta', 'User Data')] },
  { id: 'chromium', name: 'Chromium', roots: [path.join(L, 'Chromium', 'User Data')] },
  { id: 'edge', name: 'Microsoft Edge', roots: [path.join(L, 'Microsoft', 'Edge', 'User Data')] },
  { id: 'brave', name: 'Brave', roots: [path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
  { id: 'vivaldi', name: 'Vivaldi', roots: [path.join(L, 'Vivaldi', 'User Data')] },
  { id: 'yandex', name: 'Yandex', roots: [path.join(L, 'Yandex', 'YandexBrowser', 'User Data')] },
  { id: 'firefox', name: 'Firefox (nur Favoriten)', ff: true, roots: [path.join(A, 'Mozilla', 'Firefox', 'Profiles')] }
];
const find = id => B.find(b => b.id === id);
const isProf = d => ['Bookmarks', 'Login Data', 'Preferences', 'places.sqlite'].some(f => fs.existsSync(path.join(d, f)));

function profiles(b) {
  const out = [];
  for (const r of b.roots) {
    if (!fs.existsSync(r)) continue;
    let names = {};
    try { names = JSON.parse(fs.readFileSync(path.join(r, 'Local State'), 'utf8')).profile.info_cache; } catch {}
    const subs = fs.readdirSync(r, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const cand = b.ff ? subs.map(s => path.join(r, s)) : [r, ...subs.filter(s => /^(Default|Profile \d+)$/.test(s)).map(s => path.join(r, s))];
    for (const d of cand) if (isProf(d))
      out.push({ dir: d, name: b.ff ? path.basename(d).replace(/^[^.]+\./, '') : (names[path.basename(d)] || {}).name || (d === r ? 'Standard' : path.basename(d)) });
  }
  return out;
}
exports.detect = () => B.map(b => ({ id: b.id, name: b.name, profiles: profiles(b) }));
exports.valid = (id, dir) => !!find(id) && profiles(find(id)).some(p => p.dir === dir);
exports.custom = dir => {
  let b = find('custom'); if (!b) { b = { id: 'custom', name: 'Eigener Ordner', roots: [] }; B.push(b); }
  b.roots = [dir]; return 'custom';
};

async function sql(file) {
  const SQL = await require('sql.js')({ locateFile: f => path.join(path.dirname(require.resolve('sql.js')), f) });
  const tmp = path.join(os.tmpdir(), 'nxrift-' + process.pid + '.db');
  fs.copyFileSync(file, tmp);
  const db = new SQL.Database(fs.readFileSync(tmp)); fs.unlinkSync(tmp); return db;
}

exports.bookmarks = async (id, dir) => {
  if (find(id).ff) {
    const db = await sql(path.join(dir, 'places.sqlite'));
    const r = db.exec("SELECT b.title,p.url FROM moz_bookmarks b JOIN moz_places p ON b.fk=p.id WHERE b.type=1 AND p.url LIKE 'http%'")[0];
    db.close(); return r ? r.values.map(([title, url]) => ({ title: title || url, url })) : [];
  }
  const f = path.join(dir, 'Bookmarks'); if (!fs.existsSync(f)) throw new Error('Bookmarks nicht gefunden in ' + dir);
  const out = [], j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const walk = n => { if (n.type === 'url') out.push({ title: n.name, url: n.url }); (n.children || []).forEach(walk); };
  Object.values(j.roots).forEach(r => r && typeof r === 'object' && walk(r));
  return out;
};

exports.tabs = async (id, dir) => {
  if (find(id).ff) throw new Error('Firefox-Tabs werden nicht unterstützt');
  const d = path.join(dir, 'Sessions'); if (!fs.existsSync(d)) throw new Error('Sessions-Ordner nicht gefunden in ' + dir);
  const f = fs.readdirSync(d).filter(x => /^(Session|Tabs)_/.test(x))
    .map(x => ({ x, t: fs.statSync(path.join(d, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  if (!f) return [];
  const m = fs.readFileSync(path.join(d, f.x)).toString('latin1').match(/https?:\/\/[\x21-\x7e]{4,300}/g) || [];
  return [...new Set(m)].slice(0, 40); // SNSS ist binär: grobe Extraktion, enthält evtl. Verlauf
};

function masterKey(dir) {
  const f = [path.join(dir, 'Local State'), path.join(path.dirname(dir), 'Local State')].find(fs.existsSync);
  if (!f) throw new Error('Local State nicht gefunden');
  const enc = Buffer.from(JSON.parse(fs.readFileSync(f, 'utf8')).os_crypt.encrypted_key, 'base64').subarray(5).toString('base64');
  const ps = `Add-Type -AssemblyName System.Security;[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${enc}'),$null,'CurrentUser'))`;
  return Buffer.from(execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim(), 'base64');
}

exports.passwords = async (id, dir) => {
  if (find(id).ff) throw new Error('Firefox-Passwörter werden nicht unterstützt (anderes Format)');
  const f = path.join(dir, 'Login Data'); if (!fs.existsSync(f)) throw new Error('Login Data nicht gefunden in ' + dir);
  const key = masterKey(dir), db = await sql(f);
  const res = db.exec('SELECT origin_url,username_value,password_value FROM logins')[0]; db.close();
  const out = []; out.skipped = 0;
  for (const [url, user, blob] of res ? res.values : []) {
    const v = Buffer.from(blob);
    if (!user || v.length < 31) continue;
    if (!/^v1[01]/.test(v.subarray(0, 3).toString())) { out.skipped++; continue; }
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, v.subarray(3, 15));
      d.setAuthTag(v.subarray(v.length - 16));
      out.push({ url, user, pw: Buffer.concat([d.update(v.subarray(15, v.length - 16)), d.final()]).toString('utf8') });
    } catch { out.skipped++; }
  }
  return out;
};
