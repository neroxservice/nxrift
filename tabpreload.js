const { contextBridge, ipcRenderer } = require('electron');
if (location.protocol === 'file:') {
  // API nur für die interne Einstellungsseite, nie für Webseiten
  if (location.pathname.endsWith('/ui/settings.html'))
    contextBridge.exposeInMainWorld('nxs', { inv: (c, ...a) => ipcRenderer.invoke(c, ...a) });
  else if (location.pathname.endsWith('/ui/start.html'))
    contextBridge.exposeInMainWorld('nxh', { pins: () => ipcRenderer.invoke('home:pins'), theme: () => ipcRenderer.invoke('home:theme') });
} else if (location.protocol === 'https:' || location.hostname === 'localhost') autofill();

function autofill() {
  const done = new WeakSet(), wired = new WeakSet();
  let cache = null, box = null;
  const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const find = () => {
    const all = [...document.querySelectorAll('input')].filter(vis);
    const pw = all.find(i => i.type === 'password');
    const pool = pw ? all.slice(0, all.indexOf(pw)).reverse() : all;
    const user = pool.find(i => /^(text|email|tel)$/.test(i.type) && (pw || /user|mail|login|ident/i.test(i.name + i.id + i.autocomplete + i.type)));
    return { pw, user };
  };
  const hide = () => { box && box.remove(); box = null; };
  function menu(el, list, fill) {
    hide(); if (!list.length) return;
    const h = document.createElement('div'), sr = h.attachShadow({ mode: 'closed' }), r = el.getBoundingClientRect();
    const st = document.createElement('style');
    st.textContent = 'div{position:fixed;background:#12121f;border:1px solid #2de1e6;border-radius:8px;font:13px sans-serif;color:#e8e8f5;z-index:2147483647;box-shadow:0 4px 20px #000a;overflow:hidden}p{margin:0;padding:8px 12px;cursor:pointer}p:hover{background:#ff3ea5}';
    const d = document.createElement('div'); d.style.cssText = `left:${r.left}px;top:${r.bottom + 2}px;min-width:${r.width}px`;
    list.forEach(c => { const p = document.createElement('p'); p.textContent = '🔑 ' + c.user; p.onmousedown = ev => { ev.preventDefault(); fill(c); hide(); }; d.append(p); });
    sr.append(st, d); document.documentElement.append(h); box = h;
  }
  async function run() {
    try {
      cache = cache || await ipcRenderer.invoke('pw:match');
      const { list, pref } = cache; if (!list.length) return;
      const { pw, user } = find(), target = pw || user; if (!target) return;
      const fill = c => { if (user && !user.value) set(user, c.user); if (pw) set(pw, c.pw); };
      const pick = list.find(c => c.user === pref) || (list.length === 1 && list[0]);
      if (pick && !done.has(target)) { done.add(target); if (pw) fill(pick); else if (!user.value) set(user, pick.user); }
      [user, pw].filter(Boolean).forEach(el => {
        if (wired.has(el)) return; wired.add(el);
        el.addEventListener('focus', () => { if (!el.value) menu(el, list, fill); });
        el.addEventListener('blur', () => setTimeout(hide, 150));
      });
    } catch {}
  }
  const cap = () => {
    const { pw, user } = find();
    if (pw && pw.value) ipcRenderer.send('pw:cap', { user: user ? user.value : '', pw: pw.value });
    else if (user && user.value) ipcRenderer.send('pw:user', user.value);
  };
  document.addEventListener('submit', cap, true);
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('button,[role=button],input[type=submit]')) cap(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') cap(); }, true);
  let t; const sched = () => { clearTimeout(t); t = setTimeout(run, 400); };
  document.addEventListener('DOMContentLoaded', () => { sched(); new MutationObserver(sched).observe(document.documentElement, { childList: true, subtree: true }); });
}
