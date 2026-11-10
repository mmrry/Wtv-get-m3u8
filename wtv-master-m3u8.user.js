// ==UserScript==
// @name         W.tv — master m3u8
// @namespace    wtv-master-m3u8
// @version      1.1.0
// @author       mmrry
// @description  master.m3u8 для записей стримеров на w.tv
// @match        https://w.tv/*
// @match        https://*.w.tv/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==


(() => {
  'use strict';

  const W = window;
  const ofetch = W.fetch.bind(W);
  const store = new Map(); // master -> { master, id, title, state }
  const M3U8_RE = /https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
  const IVS_MEDIA_RE = /\/media\/(?:hls|thumbnails|latest_thumbnail)(?:\/|$)/i;
  const MAX_BODY = 3 * 1024 * 1024;

  // ---------- нормализация в master ----------
  // IVS auto-record в S3: <prefix>/media/hls/master.m3u8,
  // рядом <prefix>/media/hls/<rendition>/playlist.m3u8 и <prefix>/media/thumbnails/thumbN.jpg
  function toMaster(raw) {
    try {
      const u = new URL(String(raw).replace(/\\\//g, '/').replace(/\\u0026/g, '&'), location.href);
      const m = u.pathname.match(/^(.*\/media)\/(?:hls|thumbnails|latest_thumbnail)(?:\/.*)?$/i);
      if (m) {
        u.pathname = m[1] + '/hls/master.m3u8';
        return u.href;
      }
      if (/\.m3u8$/i.test(u.pathname)) return u.href;
    } catch (_) { /* ignore */ }
    return null;
  }

  function isLikelyVariant(url) {
    return /\/(chunklist|playlist)[^/]*\.m3u8/i.test(url) && !/\/media\/hls\/master\.m3u8/i.test(url);
  }

  function add(raw, meta) {
    const master = toMaster(raw);
    if (!master) return null;
    let e = store.get(master);
    if (!e) {
      e = { master, id: null, title: null, state: isLikelyVariant(master) ? 'media' : 'new' };
      store.set(master, e);
      verify(e);
      scheduleRender();
    }
    if (meta) {
      if (!e.id && meta.id != null) e.id = String(meta.id);
      if (!e.title && meta.title) e.title = String(meta.title).slice(0, 120);
    }
    return e;
  }

  // проверяем, что это действительно master (есть EXT-X-STREAM-INF)
  async function verify(e) {
    try {
      const r = await ofetch(e.master, { credentials: 'omit' });
      const t = await r.text();
      if (!r.ok || !t.startsWith('#EXTM3U')) e.state = 'bad';
      else if (t.includes('#EXT-X-STREAM-INF')) e.state = 'master';
      else e.state = 'media';
    } catch (_) {
      e.state = 'unknown';
    }
    document.querySelectorAll('.wtv-m3u8-btn').forEach((b) => {
      if (b.dataset.master === e.master) {
        b.dataset.state = e.state;
        b.title = TITLES[e.state] || 'Копировать master.m3u8';
      }
    });
  }

  // ---------- разбор ответов ----------
  function handleString(s, meta) {
    if (s.length > 4096 || !/^https?:|\.m3u8/i.test(s)) return;
    if (s.includes('.m3u8')) {
      for (const m of s.matchAll(M3U8_RE)) add(m[0], meta);
    } else if (/^https?:\/\//i.test(s) && IVS_MEDIA_RE.test(s)) {
      add(s, meta);
    }
  }

  function walk(o, ctx, depth) {
    if (o == null || depth > 14) return;
    if (typeof o === 'string') return handleString(o, ctx);
    if (Array.isArray(o)) { for (const x of o) walk(x, ctx, depth + 1); return; }
    if (typeof o !== 'object') return;
    const id = o.id ?? o.uuid ?? o.videoId ?? o.video_id ?? o.recordId ?? o.slug;
    const title = o.title ?? o.name ?? o.streamTitle;
    const meta = (id != null || title) ? { id, title: typeof title === 'string' ? title : null } : ctx;
    for (const k in o) walk(o[k], meta, depth + 1);
  }

  function inspectText(text, url) {
    if (!text || text.length > MAX_BODY) return;
    if (/\.m3u8(\?|$)/i.test(url)) {
      // сам плейлист: если в нём есть варианты — это master
      const e = add(url);
      if (e && text.includes('#EXT-X-STREAM-INF')) e.state = 'master';
      return;
    }
    const t = text.trimStart();
    if (t[0] === '{' || t[0] === '[') {
      try { walk(JSON.parse(t), null, 0); return; } catch (_) { /* not json */ }
    }
    if (text.includes('.m3u8') || IVS_MEDIA_RE.test(text)) {
      for (const m of text.matchAll(M3U8_RE)) add(m[0]);
    }
  }

  const urlOf = (x) => (typeof x === 'string' ? x : (x && x.url) || String(x));

  // fetch
  W.fetch = async function (...args) {
    const res = await ofetch(...args);
    try {
      const url = urlOf(args[0]);
      const ct = res.headers.get('content-type') || '';
      if (/\.m3u8(\?|$)/i.test(url)) add(url);
      if (/json|text|mpegurl|javascript/i.test(ct) || /\.m3u8(\?|$)/i.test(url)) {
        res.clone().text().then((t) => inspectText(t, url)).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return res;
  };

  // XHR (hls.js / IVS player)
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      const u = String(url);
      this.addEventListener('load', () => {
        try {
          if (/\.m3u8(\?|$)/i.test(u)) add(u);
          const rt = this.responseType;
          if (rt === '' || rt === 'text') inspectText(this.responseText, u);
          else if (rt === 'json' && this.response) walk(this.response, null, 0);
        } catch (_) { /* ignore */ }
      });
    } catch (_) { /* ignore */ }
    return XO.call(this, method, url, ...rest);
  };

  // всё, что грузится как ресурс (в т.ч. из воркеров плеера не видно, но картинки/плейлисты — да)
  try {
    new PerformanceObserver((list) => {
      for (const en of list.getEntries()) {
        if (/\.m3u8(\?|$)/i.test(en.name) || IVS_MEDIA_RE.test(en.name)) add(en.name);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (_) { /* ignore */ }

  // ---------- DOM: карточки записей ----------
  function cardOf(el) {
    return el.closest('a[href]') || el.parentElement;
  }

  const CSS = `
    .wtv-m3u8-btn{position:absolute;top:6px;right:6px;z-index:20;padding:3px 7px;border:0;border-radius:6px;
      background:rgba(0,0,0,.75);color:#fff;font:600 11px/1.2 system-ui,sans-serif;cursor:pointer}
    .wtv-m3u8-btn:hover{background:#9146ff}
    .wtv-m3u8-btn[data-state="media"],.wtv-m3u8-btn[data-state="bad"]{color:#fbbf24}`;
  let cssDone = false;
  function ensureCss() {
    if (cssDone || !document.head) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    cssDone = true;
  }

  const TITLES = {
    master: 'Копировать master.m3u8',
    media: 'Внимание: это плейлист одного качества, не master',
    bad: 'Плейлист недоступен',
  };

  function attachBtn(card, entry) {
    ensureCss();
    if (!card || card.dataset.wtvM3u8 === entry.master) return;
    card.dataset.wtvM3u8 = entry.master;
    card.querySelectorAll(':scope > .wtv-m3u8-btn').forEach((b) => b.remove());
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const b = document.createElement('button');
    b.className = 'wtv-m3u8-btn';
    b.type = 'button';
    b.textContent = 'm3u8';
    b.title = TITLES[entry.state] || 'Копировать master.m3u8';
    b.dataset.state = entry.state;
    b.dataset.master = entry.master;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      copy(entry.master, b);
    }, true);
    card.appendChild(b);
  }

  function scanDom() {
    if (!document.body) return;
    // превью записей IVS: .../media/thumbnails/thumbN.jpg -> master рядом
    document.querySelectorAll('img, source, video').forEach((el) => {
      const srcs = [el.currentSrc, el.src, el.getAttribute('src'), el.getAttribute('data-src')];
      const ss = el.getAttribute('srcset');
      if (ss) ss.split(',').forEach((p) => srcs.push(p.trim().split(/\s+/)[0]));
      for (const s of srcs) {
        if (s && (IVS_MEDIA_RE.test(s) || /\.m3u8/i.test(s))) {
          const e = add(s);
          if (e && el.tagName === 'IMG') attachBtn(cardOf(el), e);
          break;
        }
      }
    });
    // фоны-превью
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const m = el.style.backgroundImage && el.style.backgroundImage.match(/url\(["']?([^"')]+)/);
      if (m && IVS_MEDIA_RE.test(m[1])) {
        const e = add(m[1]);
        if (e) attachBtn(cardOf(el), e);
      }
    });
    // ссылки на записи, для которых id пришёл из API
    const byId = new Map();
    for (const e of store.values()) if (e.id) byId.set(e.id, e);
    if (byId.size) {
      document.querySelectorAll('a[href]').forEach((a) => {
        const segs = new URL(a.href, location.href).pathname.split('/').filter(Boolean);
        for (const s of segs) {
          const e = byId.get(s);
          if (e) { attachBtn(a, e); break; }
        }
      });
    }
  }

  // ---------- копирование ----------
  async function copy(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = ok ? 'Скопировано' : 'Ошибка';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
    if (!ok) prompt('Скопируйте ссылку:', text);
  }

  let rt = 0;
  function scheduleRender() {
    clearTimeout(rt);
    rt = setTimeout(scanDom, 300);
  }

  // ---------- старт + SPA-навигация ----------
  function boot() {
    // встроенное состояние SSR (Nuxt/Next), если есть
    try { if (W.__NUXT__) walk(W.__NUXT__, null, 0); } catch (_) { /* ignore */ }
    try {
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) walk(JSON.parse(nd.textContent), null, 0);
    } catch (_) { /* ignore */ }
    new MutationObserver(scheduleRender).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'href'],
    });
    scheduleRender();
  }

  for (const k of ['pushState', 'replaceState']) {
    const o = history[k];
    history[k] = function (...a) { const r = o.apply(this, a); scheduleRender(); return r; };
  }
  W.addEventListener('popstate', scheduleRender);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
