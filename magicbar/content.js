(() => {
  'use strict';
  if (window.__magicbar) return;
  window.__magicbar = true;

  const KEY = 'magicbar:v1';
  const LIMITS = { searchesShown: 10, searchesKept: 50, videosKept: 300, recentVideos: 2, feedVideos: 5, topChannels: 4 };
  const REWATCH_GAP = 30 * 60 * 1000;
  const SYNC_EVERY = 30 * 60 * 1000;

  /* ───────────── Almacenamiento (solo en este dispositivo) ───────────── */

  const emptyData = () => ({ searches: [], videos: {}, channels: {}, feed: [], visited: [], trends: null, hidden: [], lastSync: 0, syncStat: null });
  let data = emptyData();
  let saveTimer;
  const onYouTube = () => /(^|\.)youtube\.com$/.test(location.hostname) || !!window.__MB_DEV;
  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };
  function load(cb) {
    if (!alive()) return;
    chrome.storage.local.get(KEY, (r) => {
      if (r && r[KEY]) data = Object.assign(emptyData(), r[KEY]);
      if (data.v !== 3) { // v3: canales reconstruidos desde oEmbed (datos fiables)
        data.v = 3; data.channels = {}; data.lastSync = 0;
        Object.values(data.videos).forEach((v) => { if (v.imp) { v.ok = false; v.bad = false; } });
        save();
      }
      cb && cb();
    });
  }
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => { try { if (alive()) chrome.storage.local.set({ [KEY]: data }); } catch { /* contexto invalidado */ } };
    if (now) run(); else saveTimer = setTimeout(run, 250);
  }
  // si la pestaña se cierra o navega con un guardado pendiente, se vuelca en el acto
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); });
  if (alive()) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch[KEY] && ch[KEY].newValue) {
        data = ch[KEY].newValue;
        if (state.open) render();
      }
    });
  }

  function recordSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    data.searches = data.searches.filter((s) => s.q.toLowerCase() !== q.toLowerCase());
    data.searches.unshift({ q, ts: Date.now() });
    data.searches.length = Math.min(data.searches.length, LIMITS.searchesKept);
    save(true);
  }

  function findChannel(key, id, name) {
    if (key && data.channels[key]) return data.channels[key];
    const n = (name || '').toLowerCase();
    return Object.values(data.channels).find((c) => (id && c.id === id) || (n && c.name.toLowerCase() === n));
  }

  function bumpChannel(v, now, bump) {
    if (!v.channel) return;
    let ch = findChannel(v.channelKey, v.channelId, v.channel);
    if (!ch) {
      const key = v.channelKey || 'name:' + v.channel;
      ch = data.channels[key] = { key, name: v.channel, url: v.channelKey || '', id: v.channelId || '', avatar: '', count: 0, ts: 0 };
    }
    if (bump) ch.count += 1;
    ch.ts = Math.max(ch.ts, now);
    if (v.channelId && !ch.id) ch.id = v.channelId;
    if (v.avatar) ch.avatar = v.avatar;
  }

  function pruneVideos() {
    const ids = Object.keys(data.videos);
    if (ids.length > LIMITS.videosKept) {
      ids.sort((a, b) => data.videos[a].ts - data.videos[b].ts)
        .slice(0, ids.length - LIMITS.videosKept)
        .forEach((id) => delete data.videos[id]);
    }
  }

  function recordVideo(v, ts) {
    const now = ts || Date.now();
    const prev = data.videos[v.id];
    const bump = !prev || now - prev.ts > REWATCH_GAP;
    data.videos[v.id] = {
      id: v.id, title: v.title, channel: v.channel,
      channelKey: v.channelKey || '', short: !!v.short, ts: Math.max(now, prev ? prev.ts : 0), imp: false, ok: !!v.channelKey,
    };
    pruneVideos();
    rebuildChannels();
    save();
  }

  /* ───────────── Captura de lo que el usuario hace en YouTube ───────────── */

  let lastHref = '';
  let loaded = false; // hasta leer el almacenamiento no se registra nada (evita pisar datos guardados)
  function currentVideo() {
    const u = new URL(location.href);
    if (u.pathname === '/watch' && u.searchParams.get('v')) return { id: u.searchParams.get('v'), short: false };
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? { id: m[1], short: true } : null;
  }

  async function trackCurrentVideo(vid) {
    const watchUrl = `https://www.youtube.com/${vid.short ? 'shorts/' : 'watch?v='}${vid.id}`;
    let title = '', channel = '', channelKey = '';
    try {
      const r = await fetch(location.origin + '/oembed?format=json&url=' + encodeURIComponent(watchUrl));
      const j = await r.json();
      title = j.title; channel = j.author_name;
      if (j.author_url) channelKey = decodeURIComponent(new URL(j.author_url).pathname);
    } catch {
      title = document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
      const a = document.querySelector('ytd-watch-metadata ytd-channel-name a');
      if (a) { channel = a.textContent.trim(); channelKey = a.getAttribute('href') || ''; }
    }
    if (!title) return;
    if (currentVideo()?.id !== vid.id) return;
    recordVideo({ id: vid.id, title, channel, channelKey, short: vid.short });
    if (!vid.short) grabAvatar(channelKey, channel, 6);
  }

  function grabAvatar(channelKey, channel, tries) {
    const img = document.querySelector('ytd-watch-metadata #owner img, ytd-watch-metadata ytd-video-owner-renderer img');
    let src = img && img.src;
    if (src && /^https:\/\/yt3\./.test(src)) {
      src = normAvatar(src);
      const ch = data.channels[channelKey || 'name:' + channel];
      if (ch && ch.avatar !== src) { ch.avatar = src; save(); }
    } else if (tries > 0) {
      setTimeout(() => grabAvatar(channelKey, channel, tries - 1), 1500);
    }
  }

  // Importa lo que ya aparece en /feed/history para arrancar con datos reales.
  function seedFromHistoryPage() {
    const items = [...document.querySelectorAll('ytd-video-renderer')];
    let n = items.length, changed = false;
    for (const el of items) {
      n--;
      const a = el.querySelector('a#video-title');
      const id = a && (new URL(a.href, location.origin).searchParams.get('v') || '');
      if (!id || data.videos[id]) continue;
      const cha = el.querySelector('ytd-channel-name a');
      recordVideo({
        id, title: (a.getAttribute('title') || a.textContent).trim(),
        channel: cha ? cha.textContent.trim() : '',
        channelKey: cha ? cha.getAttribute('href') || '' : '',
      }, 1 + n);
      changed = true;
    }
    return changed;
  }


  /* ───────────── Sincronización con la cuenta ─────────────
     Lee las mismas páginas que ve el usuario (/feed/history, /feed/channels)
     con su sesión y extrae los datos de ytInitialData. */

  let lastDbg = '';
  const dbg = (m) => { lastDbg = m; try { console.warn('[MagicBar]', m); } catch { /* sin consola */ } };
  async function fetchPage(path, signal) {
    let r;
    try { r = await fetch(location.origin + path, { credentials: 'include', signal }); }
    catch (e) { dbg(path + ' fetch error: ' + (e && e.message)); throw e; }
    if (!r.ok) { dbg(path + ' HTTP ' + r.status); return { json: null, html: '' }; }
    const html = await r.text();
    const m = html.match(/ytInitialData["']?\]?\s*=\s*(\{.+?\})\s*;\s*(?:<\/script>|var )/s);
    let json = null;
    if (m) { try { json = JSON.parse(m[1]); } catch (e) { dbg(path + ' JSON ' + e.message); } }
    else dbg(path + ' sin ytInitialData (' + html.length + ' bytes)');
    return { json, html };
  }

  async function sapisidHash() {
    const m = document.cookie.match(/(?:^|; )(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return '';
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${m[1]} https://www.youtube.com`));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  // Pide las páginas siguientes del historial (la primera trae pocos vídeos).
  async function fetchMore(json, html, pages) {
    const out = [];
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const version = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
    if (!key || !version) return out;
    const auth = await sapisidHash();
    let cur = json;
    for (let i = 0; i < pages; i++) {
      let token = null;
      walk(cur, (n) => { if (!token && n.continuationCommand && n.continuationCommand.token) token = n.continuationCommand.token; });
      if (!token) break;
      const r = await fetch(`${location.origin}/youtubei/v1/browse?prettyPrint=false&key=${key}`, {
        method: 'POST', credentials: 'include',
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Goog-AuthUser': '0', 'X-Origin': location.origin },
          auth ? { Authorization: auth } : {}),
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: document.documentElement.lang || 'es' } }, continuation: token }),
      });
      if (!r.ok) break;
      cur = await r.json();
      out.push(cur);
    }
    return out;
  }

  function walk(o, fn) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, fn)); return; }
    fn(o);
    for (const k in o) walk(o[k], fn);
  }
  const textOf = (t) => (t && (t.simpleText || t.content || (t.runs && t.runs.map((r) => r.text).join('')))) || '';
  function firstBrowse(o) {
    let found = null;
    walk(o, (n) => { if (!found && n.browseEndpoint && /^UC/.test(n.browseEndpoint.browseId || '')) found = n.browseEndpoint; });
    return found || {};
  }

  function normAvatar(u) {
    if (!u) return '';
    if (u.startsWith('//')) u = 'https:' + u;
    return /^https:\/\//.test(u) ? u.replace(/=s\d+(-[^?]*)?$/, '=s96-c-k-c0x00ffffff-no-rj') : '';
  }
  function lockupAvatar(lk) {
    let src = '';
    walk(lk, (n) => { if (!src && n.avatarViewModel && n.avatarViewModel.image && n.avatarViewModel.image.sources) {
      const ss = n.avatarViewModel.image.sources; src = ss[ss.length - 1].url; } });
    return normAvatar(src);
  }

  const isVerified = (badges) => (badges || []).some((b) => {
    const m = b && b.metadataBadgeRenderer;
    return !!m && /VERIFIED|OFFICIAL_ARTIST/.test((m.style || '') + (m.icon && m.icon.iconType || ''));
  });

  function extractVideos(json) {
    const out = [], seen = new Set();
    const push = (v) => { if (v.id && v.title && !seen.has(v.id)) { seen.add(v.id); out.push(v); } };
    walk(json, (o) => {
      const vr = o.videoRenderer || o.gridVideoRenderer || o.compactVideoRenderer;
      if (vr && vr.videoId) {
        const by = vr.ownerText || vr.longBylineText || vr.shortBylineText;
        const be = firstBrowse(by);
        const ths = vr.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails;
        push({ id: vr.videoId, title: textOf(vr.title), channel: (by && by.runs && by.runs[0] && by.runs[0].text) || '',
               channelKey: be.canonicalBaseUrl || '', channelId: be.browseId || '', avatar: normAvatar(ths && ths[ths.length - 1].url),
               views: textOf(vr.viewCountText) || textOf(vr.shortViewCountText), published: textOf(vr.publishedTimeText), verified: isVerified(vr.ownerBadges), trusted: !!(be.canonicalBaseUrl && by && by.runs && by.runs[0]) });
      }
      const lk = o.lockupViewModel;
      if (lk && /VIDEO/.test(lk.contentType || '') && lk.contentId) {
        const md = (lk.metadata && lk.metadata.lockupMetadataViewModel) || {};
        const rows = md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows;
        const be = firstBrowse(md);
        push({ id: lk.contentId, title: textOf(md.title), channel: textOf(rows && rows[0] && rows[0].metadataParts && rows[0].metadataParts[0] && rows[0].metadataParts[0].text),
               channelKey: be.canonicalBaseUrl || '', channelId: be.browseId || '', avatar: lockupAvatar(lk) });
      }
      const ss = o.shortsLockupViewModel;
      if (ss) {
        const id = ss.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || (ss.entityId || '').replace('shorts-shelf-item-', '');
        push({ id, title: textOf(ss.overlayMetadata?.primaryText), channel: '', short: true });
      }
      const rr = o.reelItemRenderer;
      if (rr && rr.videoId) push({ id: rr.videoId, title: textOf(rr.headline), channel: '', short: true });
    });
    return out;
  }

  function extractChannels(json) {
    const out = [];
    walk(json, (o) => {
      const lk = o.lockupViewModel;
      if (lk && /CHANNEL/.test(lk.contentType || '') && /^UC/.test(lk.contentId || '')) {
        const md = (lk.metadata && lk.metadata.lockupMetadataViewModel) || {};
        const rows = (md.metadata && md.metadata.contentMetadataViewModel && md.metadata.contentMetadataViewModel.metadataRows) || [];
        const texts = rows.flatMap((r) => (r.metadataParts || []).map((p) => textOf(p.text))).filter(Boolean);
        const handle = texts.find((x) => x.startsWith('@')) || '';
        const subs = texts.find((x) => !x.startsWith('@') && /\d/.test(x)) || '';
        const be = firstBrowse(lk);
        out.push({ handle, subs, verified: /VERIFIED/.test(JSON.stringify(md)), meta: [handle, subs].filter(Boolean).join(' · '), id: lk.contentId, name: textOf(md.title),
                   url: be.canonicalBaseUrl || (handle ? '/' + handle : '/channel/' + lk.contentId), avatar: lockupAvatar(lk) });
      }
      const c = o.channelRenderer || o.gridChannelRenderer;
      if (!c || !c.channelId) return;
      const th = (c.thumbnail && c.thumbnail.thumbnails) || [];
      const src = th.length ? th[th.length - 1].url : '';
      // YouTube devuelve @handle en uno de los dos campos y «N suscriptores» en el otro
      const texts = [textOf(c.subscriberCountText), textOf(c.videoCountText)].filter(Boolean);
      const url0 = (c.navigationEndpoint && c.navigationEndpoint.browseEndpoint && c.navigationEndpoint.browseEndpoint.canonicalBaseUrl) || '';
      const handle = texts.find((x) => x.startsWith('@')) || (url0.startsWith('/@') ? url0.slice(1) : '');
      const rest = texts.filter((x) => !x.startsWith('@') && /\d/.test(x)).slice(0, 1);
      out.push({
        handle, subs: rest[0] || '', verified: isVerified(c.ownerBadges),
        meta: [handle, rest[0]].filter(Boolean).join(' · '),
        id: c.channelId, name: textOf(c.title),
        url: url0,
        avatar: normAvatar(src),
      });
    });
    return out;
  }

  function importVideo(v, ts) {
    if (data.videos[v.id]) return false;
    data.videos[v.id] = { id: v.id, title: v.title, channel: v.channel, channelKey: v.channelKey || '', short: !!v.short, ts, imp: true, ok: !!(v.trusted && v.channelKey) };
    return true;
  }

  function mergeSub(c) {
    let ch = findChannel(c.url, c.id, c.name);
    if (!ch) {
      const key = c.url || 'name:' + c.name;
      ch = data.channels[key] = { key, name: c.name, url: c.url, id: c.id, avatar: '', count: 0, ts: 0 };
    }
    ch.sub = true;
    if (c.verified) ch.verified = true;
    ch.id = ch.id || c.id;
    ch.url = ch.url || c.url;
    if (c.avatar) ch.avatar = c.avatar;
  }

  async function ogAvatar(ch, path) {
    try {
      const r = await fetch(location.origin + path, { credentials: 'include' });
      if (!r.ok) return false;
      const html = await r.text();
      const m = html.match(/<meta property="og:image" content="([^"]+)"/);
      const id = html.match(/"channelId":"(UC[\w-]{22})"/);
      if (id && !ch.id) ch.id = id[1];
      const src = m && normAvatar(m[1].replace(/&amp;/g, '&'));
      if (src) { ch.avatar = src; return true; }
    } catch { /* sin red */ }
    return false;
  }

  async function fetchChannelAvatar(ch) {
    const path = ch.url && ch.url.startsWith('/') ? ch.url : ch.id ? '/channel/' + ch.id : '';
    if (path && (await ogAvatar(ch, path))) return true;
    // Muchos canales del historial vienen solo con el nombre: se buscan por nombre entre los canales de YouTube.
    try {
      const { json } = await fetchPage('/results?search_query=' + encodeURIComponent(ch.name) + '&sp=EgIQAg%253D%253D');
      const n = ch.name.trim().toLowerCase();
      const list = json ? extractChannels(json) : [];
      const hit = list.find((c) => c.name.trim().toLowerCase() === n) ||
        list.find((c) => n.length > 6 && c.name.toLowerCase().startsWith(n.slice(0, 12)));
      if (!hit) return false;
      if (!ch.id) ch.id = hit.id;
      if (!ch.url) ch.url = hit.url;
      if (hit.avatar) { ch.avatar = hit.avatar; return true; }
      if (hit.url) return await ogAvatar(ch, hit.url);
    } catch { /* sin red */ }
    return false;
  }

  let avatarsBusy = false;
  // Ficha real del canal (la de su página): foto, @usuario, suscriptores y número total de vídeos.
  async function enrichChannel(ch) {
    try {
      let id = ch.id;
      if (!id && ch.url && ch.url.startsWith('/')) {
        const rs = await innertube('navigation/resolve_url', { url: 'https://www.youtube.com' + ch.url });
        id = rs && rs.endpoint && rs.endpoint.browseEndpoint && rs.endpoint.browseEndpoint.browseId;
      }
      if (!id) return false;
      const j = await innertube('browse', { browseId: id });
      const cm = j && j.metadata && j.metadata.channelMetadataRenderer;
      if (!cm) return false;
      const texts = [];
      walk(j.header, (n) => { if (typeof n.content === 'string' && n.content.length < 60) texts.push(n.content); });
      const handle = texts.find((x) => x.startsWith('@')) || '';
      const nums = texts.filter((x) => !x.startsWith('@') && /\d/.test(x) && !/^\.\.\./.test(x));
      const th = (cm.avatar && cm.avatar.thumbnails) || [];
      let av = th.length ? normAvatar(th[th.length - 1].url) : '';
      if (!av) walk(j.header, (n) => { if (!av && n.avatarViewModel && n.avatarViewModel.image && n.avatarViewModel.image.sources) av = normAvatar(n.avatarViewModel.image.sources.slice(-1)[0].url); });
      ch.id = id;
      if (cm.title) ch.name = cm.title;
      if (av) ch.avatar = av;
      if (handle) ch.handle = handle;
      ch.subs = nums.length >= 2 ? nums[0] : '';
      ch.videosTotal = nums.length >= 2 ? nums[1] : (nums[0] || '');
      ch.stats = [ch.subs, ch.videosTotal].filter(Boolean).join(' · ');
      if (/CHECK_CIRCLE|VERIFIED|OFFICIAL_ARTIST/.test(JSON.stringify(j.header || {}))) ch.verified = true;
      ch.enrichedAt = Date.now();
      return !!av;
    } catch { return false; }
  }

  async function fillAvatars() {
    if (avatarsBusy || !alive() || !onYouTube()) return;
    const now = Date.now();
    const todo = Object.values(data.channels)
      .filter((c) => (!c.avatar || !c.enrichedAt) && (c.avT3 || 0) < now - 15 * 60e3)
      .sort((a, b) => b.count - a.count || (b.sub ? 1 : 0) - (a.sub ? 1 : 0) || b.ts - a.ts)
      .slice(0, 12);
    if (!todo.length) return;
    avatarsBusy = true;
    todo.forEach((c) => { c.avT3 = now; });
    try {
      const got = await Promise.all(todo.map(async (c) => (await enrichChannel(c)) || (!c.avatar && (await fetchChannelAvatar(c)))));
      console.debug('[MagicBar] fotos de canal', todo.map((c, i) => c.name + (got[i] ? ' ✓' : ' ✗')));
      save();
    } finally {
      avatarsBusy = false;
      if (state.open) render();
    }
  }

  // Los feeds de YouTube cambian de formato y a veces el «canal» sale mal. oEmbed devuelve
  // título, canal y enlace del canal de forma fiable para cualquier vídeo.
  async function resolveInfo(v) {
    try {
      const r = await fetch(location.origin + '/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + v.id));
      if (!r.ok) throw 0;
      const j = await r.json();
      v.title = j.title || v.title;
      v.channel = j.author_name || v.channel;
      v.channelKey = j.author_url ? decodeURIComponent(new URL(j.author_url).pathname) : v.channelKey;
      v.ok = true;
    } catch { v.bad = true; }
  }

  async function resolveAll(list, max) {
    const todo = list.filter((v) => !v.ok && !v.bad).slice(0, max);
    for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(resolveInfo));
  }

  // Los canales se recalculan desde los vídeos ya resueltos: nombre, enlace y recuento reales.
  function rebuildChannels() {
    const old = data.channels, next = {};
    Object.values(old).forEach((c) => { if (c.sub) next[c.key] = Object.assign({}, c, { count: 0 }); });
    const find = (key, name) => Object.values(next).find((c) =>
      (key && c.key.toLowerCase() === key.toLowerCase()) || c.name.toLowerCase() === name.toLowerCase());
    for (const v of Object.values(data.videos)) {
      if (!v.ok || !v.channel) continue;
      let ch = find(v.channelKey, v.channel);
      if (!ch) {
        const key = v.channelKey || 'name:' + v.channel;
        const prev = old[key] || {};
        ch = next[key] = Object.assign({}, prev, { key, name: prev.enrichedAt && prev.name ? prev.name : v.channel, url: v.channelKey || '', id: prev.id || '', avatar: prev.avatar || '', count: 0, ts: 0 });
      }
      ch.count += 1;
      ch.ts = Math.max(ch.ts, v.ts);
    }
    data.channels = next;
  }

  async function syncAccount(force) {
    if (syncing || !alive() || !onYouTube()) return;
    if (!force && Date.now() - (data.lastSync || 0) < SYNC_EVERY) return;
    syncing = true;
    if (state.open) render();
    try {
      const [hist, subs, feed] = await Promise.all([
        fetchPage('/feed/history').catch(() => ({ json: null, html: '' })),
        fetchPage('/feed/channels').catch(() => ({ json: null, html: '' })),
        fetchPage('/feed/subscriptions').catch(() => ({ json: null, html: '' })),
      ]);
      const t0 = Date.now();
      // solo el contenido principal de la pestaña (sin barras laterales ni recomendaciones)
      const histMain = hist.json && ((hist.json.contents && hist.json.contents.twoColumnBrowseResultsRenderer &&
        hist.json.contents.twoColumnBrowseResultsRenderer.tabs && hist.json.contents.twoColumnBrowseResultsRenderer.tabs[0] &&
        hist.json.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer && hist.json.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content) || hist.json);
      let vids = histMain ? extractVideos(histMain) : [];
      if (hist.json) {
        const more = await fetchMore(hist.json, hist.html, 4).catch(() => []);
        const seenIds = new Set(vids.map((v) => v.id));
        more.forEach((j) => extractVideos(j).forEach((v) => { if (!seenIds.has(v.id)) { seenIds.add(v.id); vids.push(v); } }));
      }
      const chans = subs.json ? extractChannels(subs.json) : [];
      const news = feed.json ? extractVideos(feed.json).filter((v) => !v.short).slice(0, 12) : [];
      vids.forEach((v, i) => importVideo(v, t0 - i * 1000));
      chans.forEach(mergeSub);
      // respaldo: si no hay historial legible, las novedades de suscripciones alimentan el panel
      data.feed = news.map((v, i) => ({ ...v, ts: t0 - i * 1000, imp: true, ok: !!(v.trusted && v.channelKey) }));
      pruneVideos();
      await resolveAll(data.feed, 8);
      // quienes publican en tu feed de suscripciones son canales a los que sigues
      data.feed.forEach((v) => {
        if (!v.ok && !v.trusted) return;
        if (!v.channel || !v.channelKey) return;
        mergeSub({ id: v.channelId || '', name: v.channel, url: v.channelKey, avatar: v.avatar || '' });
      });
      await resolveAll(Object.values(data.videos).sort((a, b) => b.ts - a.ts), 60);
      rebuildChannels();
      data.lastSync = t0;
      data.syncStat = { videos: vids.length, channels: chans.length, news: news.length };
      save();
    } finally {
      syncing = false;
      if (state.open) render();
      fillAvatars();
    }
  }

  // Las búsquedas de la cuenta no están en ninguna página de YouTube: se leen
  // del desplegable nativo, que con el campo vacío lista las búsquedas recientes.
  function harvestNativeSearches() {
    if (!state.open || state.query.trim()) return;
    const nodes = document.querySelectorAll('yt-searchbox [role="option"], ytd-searchbox [role="option"], .sbsb_c');
    const native = [];
    nodes.forEach((n) => {
      const left = n.querySelector('.ytSuggestionComponentLeftContainer, .ytSearchboxComponentSuggestionText, .sbqs_c');
      const t = ((left && left.textContent) || n.getAttribute('aria-label') || n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 120 && !native.includes(t) && !data.hidden.includes(t.toLowerCase())) native.push(t);
    });
    if (!native.length) return;
    const now = Date.now();
    const known = new Map(data.searches.map((s) => [s.q.toLowerCase(), s]));
    // YouTube lista las recientes de más nueva a más antigua: se respeta ese orden con marcas de tiempo decrecientes,
    // y las búsquedas locales que aún no aparecen allí conservan su hora real.
    let prevTs = now;
    const merged = native.map((q) => {
      const k = known.get(q.toLowerCase());
      const ts = Math.min(k ? k.ts : prevTs - 1000, prevTs - 1);
      prevTs = ts;
      return { q: k ? k.q : q, ts };
    });
    const nl = new Set(native.map((q) => q.toLowerCase()));
    const rest = data.searches.filter((s) => !nl.has(s.q.toLowerCase()));
    const next = merged.concat(rest).sort((a, b) => b.ts - a.ts).slice(0, LIMITS.searchesKept);
    if (JSON.stringify(next.map((s) => s.q)) === JSON.stringify(data.searches.map((s) => s.q))) return;
    data.searches = next;
    save();
    if (state.open && !state.query.trim()) render();
  }

  const CHANNEL_PATH = /^\/(@[^/]+|channel\/(UC[\w-]{22})|c\/[^/]+|user\/[^/]+)/;

  // Entrar en una cuenta justo después de una búsqueda (desde YouTube o desde el panel) la guarda en el historial.
  async function visitFromChannelPage(pathname) {
    const m = pathname.match(CHANNEL_PATH);
    if (!m) return;
    const ch = { name: '', url: m[2] ? '' : decodeURIComponent(m[0]), id: m[2] || '', avatar: '', verified: false };
    await enrichChannel(ch);
    if (!ch.name) return;
    ch.url = ch.handle ? '/' + ch.handle : '/channel/' + ch.id;
    recordVisit(ch);
  }

  function onNavigate() {
    if (!loaded || location.href === lastHref) return;
    const from = lastHref || document.referrer || '';
    lastHref = location.href;
    const u = new URL(location.href);
    if (u.pathname === '/results') {
      const q = u.searchParams.get('search_query');
      if (q) recordSearch(q);
    }
    if (CHANNEL_PATH.test(u.pathname) && /\/results/.test(from)) setTimeout(() => visitFromChannelPage(u.pathname), 1200);
    const vid = currentVideo();
    if (vid) setTimeout(() => currentVideo()?.id === vid.id && trackCurrentVideo(vid), 3000);
    if (u.pathname === '/feed/history') {
      setTimeout(seedFromHistoryPage, 2500);
      setTimeout(seedFromHistoryPage, 6000);
    }
  }

  /* ───────────── Interfaz ───────────── */

  const state = { open: false, input: null, pending: false, remote: null, query: '', suggestions: [], active: -1 };
  let host, root, panel, navEls = [], suggestSeq = 0, suggestTimer, syncing = false;
  const suggestCache = new Map();

  const ICONS = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    lsearch: '<path d="m21 21-4.34-4.34" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    user: '<path d="M17.925 20.056a6 6 0 0 0-11.851.001" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="11" r="4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    up: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16 7 22 7 22 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="16 17 22 17 22 11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    clock: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 1.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Zm-.75 3v5.06l3.72 2.23.78-1.29-3-1.8V7.5h-1.5Z"/>',
    search: '<path d="m20.87 20.17-5.59-5.59A6.96 6.96 0 0 0 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.66 0 3.18-.58 4.38-1.54l5.59 5.59.9-.88ZM10 16a6 6 0 1 1 0-12 6 6 0 0 1 0 12Z"/>',
    close: '<path d="m12.7 12 6.6 6.6-.7.7-6.6-6.6-6.6 6.6-.7-.7 6.6-6.6-6.6-6.6.7-.7 6.6 6.6 6.6-6.6.7.7-6.6 6.6Z"/>',
    fill: '<path d="M18 6v1.5L8.6 17H15v1.5H6V9.5h1.5v6.4L16.9 6H18Z" transform="rotate(0 12 12)"/>',
  };
  const icon = (name, cls = 'ic') => {
    const s = document.createElement('span');
    s.className = cls;
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
    return s;
  };

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };


  /* ───────────── Idioma: sigue el idioma de la interfaz de YouTube ───────────── */

  // Orden: 0 búsquedas recientes · 1 buscar · 2 de tu historial · 3 de quienes sigues · 4 historial ·
  // 5 más vistos · 6 ver más · 7 sin búsquedas · 8 leyendo búsquedas · 9 sin novedades · 10 leyendo suscripciones ·
  // 11 sin historial · 12 leyendo historial · 13 vídeos vistos · 14 canales tuyos · 15 suscrito · 16 vídeo ·
  // 17 vídeos · 18 usar en el buscador · 19 quitar
  const STR = {
    en: ['Recent searches','Search','From your history','From people you follow','Your history','Most watched','See more','Your latest searches will appear here.','Reading your searches…','No news from your subscriptions.','Reading your subscriptions…','Your history will appear here.','Reading your history…',"Videos you've watched",'Your channels','Subscribed','video','videos','Use in search','Remove'],
    es: ['Búsquedas recientes','Buscar','De tu historial','De quienes sigues','Tu historial','Los que más ves','Ver más','Aquí aparecerán tus últimas búsquedas.','Leyendo tus búsquedas…','No hay novedades de tus suscripciones.','Leyendo tus suscripciones…','Tu historial aparecerá aquí.','Leyendo tu historial…','Vídeos que ya viste','Canales tuyos','Suscrito','vídeo','vídeos','Usar en el buscador','Quitar'],
    pt: ['Pesquisas recentes','Pesquisar','Do seu histórico','De quem você segue','Seu histórico','Mais assistidos','Ver mais','Suas últimas pesquisas aparecerão aqui.','Lendo suas pesquisas…','Sem novidades das suas inscrições.','Lendo suas inscrições…','Seu histórico aparecerá aqui.','Lendo seu histórico…','Vídeos que você já viu','Seus canais','Inscrito','vídeo','vídeos','Usar na pesquisa','Remover'],
    fr: ['Recherches récentes','Rechercher','Dans votre historique','De vos abonnements','Votre historique','Les plus regardées','Voir plus','Vos dernières recherches apparaîtront ici.','Lecture de vos recherches…','Aucune nouveauté de vos abonnements.','Lecture de vos abonnements…','Votre historique apparaîtra ici.','Lecture de votre historique…','Vidéos déjà vues','Vos chaînes','Abonné','vidéo','vidéos','Utiliser dans la recherche','Supprimer'],
    de: ['Letzte Suchanfragen','Suchen','Aus deinem Verlauf','Von deinen Abos','Dein Verlauf','Am meisten gesehen','Mehr ansehen','Deine letzten Suchanfragen erscheinen hier.','Suchanfragen werden gelesen…','Keine Neuigkeiten aus deinen Abos.','Abos werden gelesen…','Dein Verlauf erscheint hier.','Verlauf wird gelesen…','Bereits angesehene Videos','Deine Kanäle','Abonniert','Video','Videos','In Suche übernehmen','Entfernen'],
    it: ['Ricerche recenti','Cerca','Dalla tua cronologia','Da chi segui','La tua cronologia','I più guardati','Mostra altro','Qui compariranno le tue ultime ricerche.','Lettura delle ricerche…','Nessuna novità dalle tue iscrizioni.','Lettura delle iscrizioni…','La tua cronologia comparirà qui.','Lettura della cronologia…','Video già visti','I tuoi canali','Iscritto','video','video','Usa nella ricerca','Rimuovi'],
    nl: ['Recente zoekopdrachten','Zoeken','Uit je geschiedenis','Van je abonnementen','Je geschiedenis','Meest bekeken','Meer weergeven','Je laatste zoekopdrachten verschijnen hier.','Zoekopdrachten lezen…','Geen nieuws van je abonnementen.','Abonnementen lezen…','Je geschiedenis verschijnt hier.','Geschiedenis lezen…',"Video's die je hebt bekeken",'Je kanalen','Geabonneerd','video',"video's",'Gebruiken in zoekopdracht','Verwijderen'],
    pl: ['Ostatnie wyszukiwania','Szukaj','Z Twojej historii','Od subskrybowanych','Twoja historia','Najczęściej oglądane','Zobacz więcej','Tu pojawią się Twoje ostatnie wyszukiwania.','Wczytywanie wyszukiwań…','Brak nowości z subskrypcji.','Wczytywanie subskrypcji…','Tu pojawi się Twoja historia.','Wczytywanie historii…','Obejrzane filmy','Twoje kanały','Subskrybujesz','film','filmów','Użyj w wyszukiwaniu','Usuń'],
    ru: ['Недавние запросы','Поиск','Из вашей истории','От ваших подписок','Ваша история','Чаще всего смотрите','Ещё','Здесь появятся ваши последние запросы.','Чтение запросов…','Нет новинок из ваших подписок.','Чтение подписок…','Здесь появится ваша история.','Чтение истории…','Просмотренные видео','Ваши каналы','Вы подписаны','видео','видео','Вставить в поиск','Удалить'],
    uk: ['Нещодавні пошуки','Пошук','З вашої історії','Від ваших підписок','Ваша історія','Найчастіше дивитесь','Більше','Тут з’являться ваші останні пошуки.','Читання пошуків…','Немає новинок із підписок.','Читання підписок…','Тут з’явиться ваша історія.','Читання історії…','Переглянуті відео','Ваші канали','Підписано','відео','відео','Вставити в пошук','Видалити'],
    tr: ['Son aramalar','Ara','Geçmişinizden','Takip ettiklerinizden','Geçmişiniz','En çok izlenenler','Daha fazla','Son aramalarınız burada görünecek.','Aramalar okunuyor…','Aboneliklerinizden yeni bir şey yok.','Abonelikler okunuyor…','Geçmişiniz burada görünecek.','Geçmiş okunuyor…','İzlediğiniz videolar','Kanallarınız','Abone olundu','video','video','Aramada kullan','Kaldır'],
    sv: ['Senaste sökningar','Sök','Från din historik','Från dina prenumerationer','Din historik','Mest sedda','Visa mer','Dina senaste sökningar visas här.','Läser sökningar…','Inget nytt från dina prenumerationer.','Läser prenumerationer…','Din historik visas här.','Läser historik…','Videor du har sett','Dina kanaler','Prenumererar','video','videor','Använd i sökning','Ta bort'],
    id: ['Penelusuran terbaru','Telusuri','Dari histori Anda','Dari langganan Anda','Histori Anda','Paling sering ditonton','Lihat selengkapnya','Penelusuran terakhir Anda akan muncul di sini.','Membaca penelusuran…','Tidak ada yang baru dari langganan Anda.','Membaca langganan…','Histori Anda akan muncul di sini.','Membaca histori…','Video yang pernah Anda tonton','Channel Anda','Subscribe','video','video','Gunakan di penelusuran','Hapus'],
    vi: ['Tìm kiếm gần đây','Tìm kiếm','Từ lịch sử của bạn','Từ kênh bạn theo dõi','Lịch sử của bạn','Xem nhiều nhất','Xem thêm','Các lượt tìm kiếm gần đây sẽ hiện ở đây.','Đang đọc lượt tìm kiếm…','Không có nội dung mới từ kênh đăng ký.','Đang đọc kênh đăng ký…','Lịch sử của bạn sẽ hiện ở đây.','Đang đọc lịch sử…','Video bạn đã xem','Kênh của bạn','Đã đăng ký','video','video','Dùng để tìm kiếm','Xóa'],
    th: ['การค้นหาล่าสุด','ค้นหา','จากประวัติของคุณ','จากช่องที่คุณติดตาม','ประวัติของคุณ','ดูบ่อยที่สุด','ดูเพิ่มเติม','การค้นหาล่าสุดของคุณจะแสดงที่นี่','กำลังอ่านการค้นหา…','ไม่มีอะไรใหม่จากช่องที่ติดตาม','กำลังอ่านการติดตาม…','ประวัติของคุณจะแสดงที่นี่','กำลังอ่านประวัติ…','วิดีโอที่คุณดูแล้ว','ช่องของคุณ','ติดตามแล้ว','วิดีโอ','วิดีโอ','ใช้ในการค้นหา','นำออก'],
    ja: ['最近の検索','検索','履歴から','登録チャンネルの新着','視聴履歴','よく見るチャンネル','もっと見る','最近の検索がここに表示されます。','検索履歴を読み込み中…','登録チャンネルの新着はありません。','登録チャンネルを読み込み中…','視聴履歴がここに表示されます。','視聴履歴を読み込み中…','視聴済みの動画','あなたのチャンネル','登録済み','動画','動画','検索に入力','削除'],
    ko: ['최근 검색','검색','내 기록에서','구독 중인 채널','시청 기록','가장 많이 본 채널','더보기','최근 검색어가 여기에 표시됩니다.','검색 기록을 읽는 중…','구독 채널의 새 소식이 없습니다.','구독 정보를 읽는 중…','시청 기록이 여기에 표시됩니다.','시청 기록을 읽는 중…','시청한 동영상','내 채널','구독 중','동영상','동영상','검색에 입력','삭제'],
    zh: ['最近搜索','搜索','来自你的历史记录','你关注的频道','观看记录','最常观看','查看更多','你最近的搜索会显示在这里。','正在读取搜索记录…','订阅频道暂无新内容。','正在读取订阅…','你的观看记录会显示在这里。','正在读取观看记录…','你看过的视频','你的频道','已订阅','个视频','个视频','用于搜索','移除'],
    ar: ['عمليات البحث الأخيرة','بحث','من سجلك','من اشتراكاتك','سجل المشاهدة','الأكثر مشاهدة','عرض المزيد','ستظهر عمليات بحثك الأخيرة هنا.','جارٍ قراءة عمليات البحث…','لا جديد من اشتراكاتك.','جارٍ قراءة الاشتراكات…','سيظهر سجل مشاهدتك هنا.','جارٍ قراءة السجل…','مقاطع شاهدتها','قنواتك','مشترك','فيديو','فيديوهات','استخدام في البحث','إزالة'],
    he: ['חיפושים אחרונים','חיפוש','מההיסטוריה שלך','ממי שאתה עוקב','ההיסטוריה שלך','הנצפים ביותר','עוד','החיפושים האחרונים שלך יופיעו כאן.','קורא חיפושים…','אין חדש מהמנויים שלך.','קורא מנויים…','ההיסטוריה שלך תופיע כאן.','קורא היסטוריה…','סרטונים שצפית בהם','הערוצים שלך','מנוי','סרטון','סרטונים','השתמש בחיפוש','הסר'],
    hi: ['हाल की खोजें','खोजें','आपके इतिहास से','आपकी सदस्यताओं से','आपका इतिहास','सबसे ज़्यादा देखे गए','और देखें','आपकी हाल की खोजें यहाँ दिखेंगी.','खोजें पढ़ी जा रही हैं…','आपकी सदस्यताओं से कुछ नया नहीं.','सदस्यताएँ पढ़ी जा रही हैं…','आपका इतिहास यहाँ दिखेगा.','इतिहास पढ़ा जा रहा है…','आपके देखे हुए वीडियो','आपके चैनल','सदस्यता ली गई','वीडियो','वीडियो','खोज में उपयोग करें','हटाएं'],
  };
  const RTL = ['ar', 'he', 'fa', 'ur'];
  const uiLang = () => (document.documentElement.lang || navigator.language || 'en').toLowerCase();
  const baseLang = () => uiLang().split('-')[0];
  // 20 vídeos más vistos · 21 canales · 22 vídeos · 23 vídeos de este canal · 24 canales relacionados · 25 otros vídeos
  // 26 sugerencias · 27 vídeos populares · 28 canales destacados · 29 canal · 30 sin resultados
  const EXTRA = {
    en: ['Most viewed videos','Channels','Videos','Videos from this channel','Related channels','Other videos','Suggestions','Popular videos','Featured channels','Channel','No results'],
    es: ['Vídeos más vistos','Canales','Vídeos','Vídeos de este canal','Canales relacionados','Otros vídeos','Sugerencias','Vídeos populares','Canales destacados','Canal','Sin resultados'],
    pt: ['Vídeos mais vistos','Canais','Vídeos','Vídeos deste canal','Canais relacionados','Outros vídeos','Sugestões','Vídeos populares','Canais em destaque','Canal','Sem resultados'],
    fr: ['Vidéos les plus vues','Chaînes','Vidéos','Vidéos de cette chaîne','Chaînes associées','Autres vidéos','Suggestions','Vidéos populaires','Chaînes à la une','Chaîne','Aucun résultat'],
    de: ['Meistgesehene Videos','Kanäle','Videos','Videos dieses Kanals','Ähnliche Kanäle','Weitere Videos','Vorschläge','Beliebte Videos','Empfohlene Kanäle','Kanal','Keine Ergebnisse'],
    it: ['Video più visti','Canali','Video','Video di questo canale','Canali correlati','Altri video','Suggerimenti','Video popolari','Canali in evidenza','Canale','Nessun risultato'],
    nl: ["Meest bekeken video's",'Kanalen',"Video's","Video's van dit kanaal",'Gerelateerde kanalen',"Andere video's",'Suggesties',"Populaire video's",'Uitgelichte kanalen','Kanaal','Geen resultaten'],
    pl: ['Najczęściej oglądane filmy','Kanały','Filmy','Filmy z tego kanału','Powiązane kanały','Inne filmy','Podpowiedzi','Popularne filmy','Polecane kanały','Kanał','Brak wyników'],
    ru: ['Самые популярные видео','Каналы','Видео','Видео с этого канала','Похожие каналы','Другие видео','Подсказки','Популярные видео','Рекомендуемые каналы','Канал','Нет результатов'],
    uk: ['Найпопулярніші відео','Канали','Відео','Відео з цього каналу','Схожі канали','Інші відео','Підказки','Популярні відео','Рекомендовані канали','Канал','Немає результатів'],
    tr: ['En çok izlenen videolar','Kanallar','Videolar','Bu kanalın videoları','İlgili kanallar','Diğer videolar','Öneriler','Popüler videolar','Öne çıkan kanallar','Kanal','Sonuç yok'],
    sv: ['Mest sedda videor','Kanaler','Videor','Videor från den här kanalen','Relaterade kanaler','Andra videor','Förslag','Populära videor','Utvalda kanaler','Kanal','Inga resultat'],
    id: ['Video terpopuler','Channel','Video','Video dari channel ini','Channel terkait','Video lainnya','Saran','Video populer','Channel unggulan','Channel','Tidak ada hasil'],
    vi: ['Video xem nhiều nhất','Kênh','Video','Video của kênh này','Kênh liên quan','Video khác','Gợi ý','Video phổ biến','Kênh nổi bật','Kênh','Không có kết quả'],
    th: ['วิดีโอยอดนิยม','ช่อง','วิดีโอ','วิดีโอจากช่องนี้','ช่องที่เกี่ยวข้อง','วิดีโออื่นๆ','คำแนะนำ','วิดีโอยอดนิยม','ช่องแนะนำ','ช่อง','ไม่พบผลลัพธ์'],
    ja: ['再生回数の多い動画','チャンネル','動画','このチャンネルの動画','関連チャンネル','その他の動画','候補','人気の動画','おすすめチャンネル','チャンネル','結果なし'],
    ko: ['조회수 높은 동영상','채널','동영상','이 채널의 동영상','관련 채널','다른 동영상','추천 검색어','인기 동영상','추천 채널','채널','결과 없음'],
    zh: ['观看最多的视频','频道','视频','此频道的视频','相关频道','其他视频','搜索建议','热门视频','精选频道','频道','无结果'],
    ar: ['الفيديوهات الأكثر مشاهدة','القنوات','فيديوهات','فيديوهات من هذه القناة','قنوات ذات صلة','فيديوهات أخرى','اقتراحات','فيديوهات رائجة','قنوات مميزة','القناة','لا نتائج'],
    he: ['הסרטונים הנצפים ביותר','ערוצים','סרטונים','סרטונים מהערוץ הזה','ערוצים קשורים','סרטונים אחרים','הצעות','סרטונים פופולריים','ערוצים מומלצים','ערוץ','אין תוצאות'],
    hi: ['सबसे ज़्यादा देखे गए वीडियो','चैनल','वीडियो','इस चैनल के वीडियो','संबंधित चैनल','अन्य वीडियो','सुझाव','लोकप्रिय वीडियो','चुनिंदा चैनल','चैनल','कोई नतीजा नहीं'],
  };
  // 31 en tendencia · 32 ha caído en tendencia · 33 copiar
  const EXTRA2 = {"en": ["Trending up", "Trending down", "Copy"], "es": ["En tendencia", "Ha caído en tendencia", "Copiar"], "pt": ["Em alta", "Em queda", "Copiar"], "fr": ["Tendance à la hausse", "Tendance à la baisse", "Copier"], "de": ["Im Trend", "Trend fallend", "Kopieren"], "it": ["In tendenza", "In calo", "Copia"], "nl": ["Trending omhoog", "Trending omlaag", "Kopiëren"], "pl": ["Rośnie popularność", "Spada popularność", "Kopiuj"], "ru": ["В тренде", "Теряет популярность", "Копировать"], "uk": ["У тренді", "Втрачає популярність", "Копіювати"], "tr": ["Trend yükseliyor", "Trend düşüyor", "Kopyala"], "sv": ["Stigande trend", "Fallande trend", "Kopiera"], "id": ["Sedang tren", "Tren menurun", "Salin"], "vi": ["Đang thịnh hành", "Giảm xu hướng", "Sao chép"], "th": ["กำลังมาแรง", "กระแสลดลง", "คัดลอก"], "ja": ["急上昇", "下降中", "コピー"], "ko": ["급상승", "하락 중", "복사"], "zh": ["趋势上升", "趋势下降", "复制"], "ar": ["رائج", "في تراجع", "نسخ"], "he": ["במגמת עלייה", "במגמת ירידה", "העתק"], "hi": ["ट्रेंड में", "ट्रेंड गिर रहा", "कॉपी करें"]};
  const t = (i) => i < 20 ? (STR[baseLang()] || STR.en)[i] : i < 31 ? (EXTRA[baseLang()] || EXTRA.en)[i - 20] : (EXTRA2[baseLang()] || EXTRA2.en)[i - 31];
  const countLabel = (n) => `${n} ${t(n === 1 ? 16 : 17)}`;

  function ago(ts, imported) {
    if (ts < 1e10 || imported) return '';
    const s = (Date.now() - ts) / 1000;
    let rtf;
    try { rtf = new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto', style: 'short' }); }
    catch { rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' }); }
    if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
    return rtf.format(-Math.round(s / 86400 / 30), 'month');
  }

  const searchUrl = (q) => '/results?search_query=' + encodeURIComponent(q);
  const channelUrl = (c) => (c.url && c.url.startsWith('/') ? c.url : '/results?search_query=' + encodeURIComponent(c.name));

  function go(q) {
    recordSearch(q);
    close();
    location.href = searchUrl(q);
  }

  // MagicBar sustituye al desplegable de YouTube (sugerencias e historial): se oculta siempre,
  // pero sigue en el DOM porque de ahí se leen las búsquedas recientes de la cuenta.
  function injectPageStyle() {
    if (document.getElementById('magicbar-page-style')) return;
    const style = document.createElement('style');
    style.id = 'magicbar-page-style';
    style.textContent = `
      yt-searchbox > :not(.ytSearchboxComponentInputWrapper):not(input),
      yt-searchbox [role="listbox"], ytd-searchbox [role="listbox"],
      ytd-searchbox .sbdd_a, ytd-searchbox #search-suggestions { display: none !important; }
      html.mb-open yt-searchbox .ytSearchboxComponentInputBox,
      html.mb-open ytd-searchbox #container { box-shadow: 0 0 0 2px rgba(62,166,255,.55) !important; }`;
    (document.head || document.documentElement).append(style);
  }
  injectPageStyle();

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'magicbar-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>`;
    panel = h('div', { class: 'panel', role: 'listbox' });
    // evita que el input pierda el foco al pulsar dentro del panel
    panel.addEventListener('mousedown', (e) => e.preventDefault());
    panel.addEventListener('click', (e) => {
      if (!e.defaultPrevented && e.composedPath().some((n) => n.tagName === 'A')) close();
    });
    root.append(panel);
    document.documentElement.append(host);
    new MutationObserver(() => panel.classList.toggle('dark', isDark())).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

  }

  function isDark() {
    const de = document.documentElement;
    if (de.hasAttribute('dark')) return true;
    const probe = (v) => { const m = (v || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/); return m ? (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 : null; };
    for (const el of [document.querySelector('ytd-app'), de, document.body]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { const lum = probe(bg); if (lum !== null) return lum < 0.45; }
    }
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  const anchorBox = () => state.input && (state.input.closest('ytd-searchbox') || state.input.closest('yt-searchbox') || state.input.closest('form') || state.input);

  function place() {
    const box = anchorBox() || state.input;
    if (!box) return;
    const r = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = Math.min(1120, vw - 24);
    const left = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12));
    panel.style.width = w + 'px';
    panel.style.left = left + 'px';
    panel.style.top = r.bottom + 8 + 'px';
    panel.style.maxHeight = `calc(100vh - ${r.bottom + 8 + 16}px)`;
    panel.classList.toggle('narrow', w < 860);
  }

  function open(input) {
    if (state.open && state.input === input && panel && panel.classList.contains('shown')) return;
    ensureHost();
    state.open = true;
    state.input = input;
    state.remote = null;
    state.query = input.value || '';
    state.active = -1;
    state.suggestions = [];
    panel.classList.toggle('dark', isDark());
    document.documentElement.classList.add('mb-open');
    panel.classList.remove('shown');
    void panel.offsetWidth; // reinicia la animación
    panel.classList.add('shown');
    // primero se cargan las sugerencias/resultados (si están en caché se aplican al instante) y después se pinta
    if (state.query.trim()) fetchSuggestions();
    else [200, 500, 1000, 2000].forEach((ms) => setTimeout(harvestNativeSearches, ms));
    place();
    render();
    syncAccount(!Object.keys(data.videos).length && !data.feed.length);
    refreshTrends();
    fillAvatars();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    document.documentElement.classList.remove('mb-open');
    panel.classList.remove('shown');
  }

  /* ───────────── Búsqueda enriquecida (canales + vídeos) ───────────── */

  const normTxt = (x) => (x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^@/, '').trim();
  function similarity(a, b) {
    a = normTxt(a); b = normTxt(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }
  // consulta ≈ nombre de canal: parecido directo o la consulta es parte del nombre («midu» ⊂ «midudev»)
  function nameSim(q, name) {
    const a = normTxt(q), b = normTxt(name);
    return Math.max(similarity(a, b), a.length >= 3 && b.includes(a) ? 0.85 : 0);
  }

  let itCfg = null;
  function innertubeCfg() {
    if (itCfg) return itCfg;
    for (const sc of document.scripts) {
      const txt = sc.textContent;
      if (!txt || txt.indexOf('INNERTUBE_API_KEY') < 0) continue;
      const key = (txt.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
      const version = (txt.match(/"INNERTUBE_(?:CONTEXT_)?CLIENT_VERSION":"([^"]+)"/) || [])[1];
      const gl = (txt.match(/"GL":"([^"]+)"/) || [])[1];
      if (key && version) return (itCfg = { key, version, gl });
    }
    return null;
  }

  async function innertube(endpoint, body, signal) {
    const cfg = innertubeCfg();
    if (!cfg) return null;
    const auth = await sapisidHash().catch(() => '');
    const r = await fetch(`${location.origin}/youtubei/v1/${endpoint}?prettyPrint=false&key=${cfg.key}`, {
      method: 'POST', credentials: 'include', signal,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Goog-AuthUser': '0', 'X-Origin': location.origin }, auth ? { Authorization: auth } : {}),
      body: JSON.stringify(Object.assign({ context: { client: { clientName: 'WEB', clientVersion: cfg.version, hl: document.documentElement.lang || 'es', gl: cfg.gl || undefined } } }, body)),
    });
    return r.ok ? r.json() : null;
  }

  const SP_CHANNELS = 'EgIQAg==';
  // 1º Innertube (formato estable); 2º página HTML de resultados como respaldo.
  async function richSearch(q, sp, signal) {
    try {
      const j = await innertube('search', Object.assign({ query: q }, sp ? { params: sp } : {}), signal);
      if (j && (extractVideos(j).length || extractChannels(j).length)) return j;
    } catch (e) { if (e.name === 'AbortError') throw e; }
    const { json } = await fetchPage('/results?search_query=' + encodeURIComponent(q) + (sp ? '&sp=' + encodeURIComponent(encodeURIComponent(sp)) : ''), signal);
    return json;
  }

  const isSub = (c) => !!findChannel(c.url, c.id, c.name) && !!findChannel(c.url, c.id, c.name).sub;
  const ownedBy = (v, c) => !!c && (
    (v.channelId && c.id && v.channelId === c.id) ||
    (v.channelKey && c.url && v.channelKey.toLowerCase() === c.url.toLowerCase()) ||
    (v.channel && normTxt(v.channel) === normTxt(c.name)));

  function rankChannels(q, list) {
    return list.map((c, i) => ({
      c, score: Math.max(nameSim(q, c.name), nameSim(q, c.handle || '')) * 10 + (isSub(c) ? 3 : 0) - i * 0.2,
    })).sort((a, b) => b.score - a.score).map((x) => x.c);
  }

  function detectIntent(q, channels) {
    const clean = q.trim(), n = normTxt(clean), words = n.split(/\s+/).filter(Boolean);
    if (clean.length <= 2) return 'short';
    const top = channels[0];
    if (top && words.length <= 3 && Math.max(nameSim(n, top.name), nameSim(n, top.handle || '')) >= 0.75) return 'channel';
    if (top && words.length >= 2) {
      const w0 = words[0], nm = normTxt(top.name);
      if (nm.split(' ')[0] === w0 || normTxt(top.handle || '').includes(w0) || similarity(w0, nm.split(' ')[0]) >= 0.8) return 'channel_topic';
    }
    if (words.length >= 3 || /\b(como|tutorial|guia|hacer|vs|mejores?|curso|aprend\w*|review|how|best)\b/.test(n)) return 'video_topic';
    return 'broad';
  }

  const resultsCache = new Map();
  const RESULTS_TTL = 3 * 60 * 1000;
  let resultsTimer, resultsCtrl;
  function fetchResults() {
    clearTimeout(resultsTimer);
    const q = state.query.trim();
    if (!q || q.length <= 2 || !onYouTube()) { state.pending = false; return; }
    const hit = resultsCache.get(q);
    if (hit && Date.now() - hit.at < RESULTS_TTL) { state.remote = hit; state.pending = false; return; }
    state.pending = true;
    resultsTimer = setTimeout(async () => {
      if (resultsCtrl) resultsCtrl.abort();
      const ctrl = resultsCtrl = new AbortController();
      const to = setTimeout(() => { ctrl.timedOut = true; ctrl.abort(); }, 10000);
      try {
        const [mixed, chJson] = await Promise.all([richSearch(q, '', ctrl.signal), richSearch(q, SP_CHANNELS, ctrl.signal)]);
        const seenC = new Set();
        let channels = [...(chJson ? extractChannels(chJson) : []), ...(mixed ? extractChannels(mixed) : [])]
          .filter((x) => x.id && !seenC.has(x.id) && seenC.add(x.id)).map((x) => ({ ...x, key: x.url || x.id, count: 0, remote: true }));
        channels = rankChannels(q, channels);
        let videos = (mixed ? extractVideos(mixed) : []).filter((x) => !x.short);
        const intent = detectIntent(q, channels);
        const main = channels[0];
        // canal claro con pocos vídeos propios en los resultados: se piden los suyos aparte
        if ((intent === 'channel' || intent === 'channel_topic') && main && videos.filter((v) => ownedBy(v, main)).length < 3) {
          const more = await richSearch(main.handle || main.name, '', ctrl.signal);
          const ids = new Set(videos.map((v) => v.id));
          (more ? extractVideos(more) : []).filter((v) => !v.short && ownedBy(v, main) && !ids.has(v.id)).forEach((v) => videos.push(v));
        }
        // cuentas vinculadas al canal principal: sus «canales destacados» y, si no los tiene, los canales verificados
        // que aparecen en los vídeos de la propia búsqueda (nunca imitaciones sin verificar)
        let related = [];
        if ((intent === 'channel' || intent === 'channel_topic') && main) {
          const feat = main.id ? await innertube('browse', { browseId: main.id, params: 'EghjaGFubmVscw==' }, ctrl.signal).catch(() => null) : null;
          const featured = (feat ? extractChannels(feat) : []).filter((c) => c.id && c.id !== main.id)
            .map((x) => ({ ...x, key: x.url || x.id, count: 0, remote: true }));
          const byId = new Map();
          videos.forEach((v) => {
            if (!v.verified || !v.channelId || v.channelId === main.id || ownedBy(v, main) || nameSim(v.channel, main.name) >= 0.6) return;
            const e = byId.get(v.channelId) || { n: 0, v }; e.n++; byId.set(v.channelId, e);
          });
          const fromVideos = [...byId.values()].sort((a, b) => b.n - a.n).map((e) => {
            const handle = (e.v.channelKey || '').startsWith('/@') ? e.v.channelKey.slice(1) : '';
            return { id: e.v.channelId, name: e.v.channel, url: e.v.channelKey, handle, meta: handle, avatar: e.v.avatar || '',
                     verified: true, key: e.v.channelKey || e.v.channelId, count: 0, remote: true };
          });
          const seenR = new Set();
          related = [...featured, ...fromVideos].filter((c) => !seenR.has(c.id) && seenR.add(c.id)).slice(0, 6);
        }
        const res = { q, at: Date.now(), videos: videos.map((x) => ({ ...x, imp: true })), channels, related, error: !mixed && !chJson };
        console.debug('[MagicBar] resultados', q, { intent, videos: res.videos.length, channels: channels.length, error: res.error });
        if (!res.error) resultsCache.set(q, res);
        if (ctrl !== resultsCtrl) return;
        state.remote = res;
        state.pending = false;
        if (state.open) render();
      } catch (e) {
        if (e && e.name === 'AbortError' && !ctrl.timedOut) return;
        if (ctrl !== resultsCtrl) return;
        state.remote = { q, at: Date.now(), videos: [], channels: [], error: true };
        state.pending = false;
        if (state.open) render();
      } finally { clearTimeout(to); }
    }, 280);
  }

  function fetchSuggestions() {
    fetchResults();
    clearTimeout(suggestTimer);
    const q = state.query.trim();
    if (!q) { state.suggestions = []; return; }
    if (suggestCache.has(q)) { state.suggestions = suggestCache.get(q); return; }
    const seq = ++suggestSeq;
    suggestTimer = setTimeout(() => {
      if (!alive()) return;
      try {
        chrome.runtime.sendMessage({ type: 'suggest', q, lang: document.documentElement.lang || 'es' }, (res) => {
          if (chrome.runtime.lastError || !res || seq !== suggestSeq) return;
          suggestCache.set(q, res.items);
          state.suggestions = res.items;
          if (state.open && state.query.trim() === q) render();
        });
      } catch { /* contexto de extensión invalidado */ }
    }, 110);
  }

  /* — piezas — */

  function avatar(c) {
    const hue = [...c.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
    const box = h('span', { class: 'avatar', style: `background:hsl(${hue} 45% 42%)` }, (c.name[0] || '?').toUpperCase());
    if (c.avatar) {
      const img = h('img', { src: c.avatar, alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  const morePill = (href) => h('a', { class: 'pill', href, 'data-nav': '' }, t(6));

  function sectionTitle(text, action) {
    return h('div', { class: 'title' }, h('span', { text }), action);
  }

  /* ───────────── Tendencias (Google Trends, país del usuario) ─────────────
     «Sube» = el término está en las tendencias ahora. «Cae» = estuvo en tendencias estos días y ya no está,
     o su volumen bajó más de un 25 % entre dos lecturas. Las lecturas se acumulan en este navegador. */
  const TREND_EVERY = 3 * 3600e3, TREND_KEEP = 7 * 86400e3;
  let trendsBusy = false;
  function trendGeo() {
    const cfg = innertubeCfg();
    const reg = (document.documentElement.lang || '').split('-')[1];
    return ((cfg && cfg.gl) || (reg && reg.length === 2 ? reg : '') || 'US').toUpperCase();
  }
  function refreshTrends() {
    if (trendsBusy || !alive() || !onYouTube()) return;
    const tr = data.trends;
    if (tr && Date.now() - tr.at < TREND_EVERY && tr.geo === trendGeo()) return;
    trendsBusy = true;
    try {
      chrome.runtime.sendMessage({ type: 'trends', geo: trendGeo() }, (res) => {
        trendsBusy = false;
        if (chrome.runtime.lastError || !res || !res.ok) return;
        const now = Date.now(), geo = trendGeo();
        const old = data.trends && data.trends.geo === geo ? data.trends : null;
        const latest = {};
        res.items.forEach((x) => { latest[normTxt(x.term)] = x.traffic; });
        const seen = Object.assign({}, old ? old.seen : {});
        Object.keys(latest).forEach((k) => { seen[k] = now; });
        Object.keys(seen).forEach((k) => { if (now - seen[k] > TREND_KEEP) delete seen[k]; });
        data.trends = { geo, at: now, latest, prev: old ? old.latest : {}, seen };
        save();
        if (state.open) render();
      });
    } catch { trendsBusy = false; }
  }
  // 'up' | 'down' | ''
  function trendOf(text) {
    const tr = data.trends;
    if (!tr) return '';
    const n = normTxt(text);
    if (n.length < 3) return '';
    // coincidencia estricta: igual, parte de la tendencia, o contiene una tendencia de varias palabras
    const hit = (k) => n === k || (n.length >= 4 && k.includes(n)) || (k.includes(' ') && n.includes(k));
    const up = Object.keys(tr.latest).find(hit);
    if (up) {
      const before = tr.prev[up];
      return before && tr.latest[up] < before * 0.75 ? 'down' : 'up';
    }
    return Object.keys(tr.seen).some(hit) ? 'down' : '';
  }
  const trendBadge = (text) => {
    const k = trendOf(text);
    if (!k) return null;
    const el = icon(k, 'ic trend ' + k);
    el.title = t(k === 'up' ? 31 : 32);
    return el;
  };

  const verifiedIcon = () => {
    const el = h('span', { class: 'vb', title: 'Verificado' });
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    return el;
  };

  function recordVisit(c) {
    if (!c || !c.name) return;
    const key = (c.id || c.url || c.name).toLowerCase();
    data.visited = (data.visited || []).filter((v) => (v.id || v.url || v.name).toLowerCase() !== key);
    data.visited.unshift({ id: c.id || '', name: c.name, handle: c.handle || '', url: c.url || '', avatar: c.avatar || '',
      verified: !!c.verified, ts: Date.now() });
    data.visited.length = Math.min(data.visited.length, 30);
    save(true);
  }

  // Historial unificado: búsquedas escritas y cuentas visitadas, de la más reciente a la más antigua.
  function historyItems(filter) {
    const all = data.searches.map((x) => ({ type: 'q', q: x.q, ts: x.ts }))
      .concat((data.visited || []).map((c) => ({ type: 'ch', c, ts: c.ts })));
    return all.filter((x) => !filter || filter(x)).sort((a, b) => b.ts - a.ts);
  }

  function historyRow(item) {
    if (item.type === 'q') return searchRow(item.q, { history: true });
    const c = item.c;
    // cuenta visitada: icono de usuario y @usuario en lugar del texto de una búsqueda
    const label = c.handle || ((c.url || '').startsWith('/@') ? c.url.slice(1) : '') || c.name;
    return h('a', { class: 'row', href: channelUrl(c), 'data-nav': '', onclick: () => recordVisit(c) },
      icon('user'),
      h('span', { class: 'txt' }, label, c.verified && verifiedIcon()),
      h('button', { class: 'mini', title: t(19), onclick: (e) => {
        e.preventDefault(); e.stopPropagation();
        data.visited = data.visited.filter((v) => v !== c);
        save(); render();
      } }, icon('close')));
  }

  function searchRow(q, { history = false, query = '' } = {}) {
    const label = h('span', { class: 'txt' });
    if (query && q.toLowerCase().startsWith(query.toLowerCase()) && q.length > query.length) {
      label.append(q.slice(0, query.length), h('b', { text: q.slice(query.length) }));
    } else label.textContent = q;
    const row = h('a', { class: 'row', href: searchUrl(q), 'data-nav': '', onclick: () => recordSearch(q) },
      icon('lsearch'), label, trendBadge(q),
      h('button', {
        class: 'mini', title: t(18),
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); setQuery(q); },
      }, icon('fill')),
      h('button', {
        class: 'mini', title: t(33),
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          const btn = e.currentTarget;
          navigator.clipboard.writeText(q).then(() => {
            btn.replaceChildren(icon('check'));
            setTimeout(() => btn.replaceChildren(icon('copy')), 1200);
          }).catch(() => {});
        },
      }, icon('copy')),
      history && h('button', {
        class: 'mini', title: t(19),
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          data.searches = data.searches.filter((s) => s.q !== q);
          data.hidden.push(q.toLowerCase());
          save(); render();
        },
      }, icon('close')));
    return row;
  }

  function videoCard(v) {
    const line2 = [v.views, v.published || ago(v.ts, v.imp)].filter(Boolean).join(' · ');
    return h('a', { class: 'vcard', href: v.short ? `/shorts/${v.id}` : `/watch?v=${v.id}`, 'data-nav': '' },
      h('span', { class: 'thumb' },
        h('img', { src: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, alt: '', loading: 'lazy' }),
        v.short && h('span', { class: 'badge', text: 'Short' })),
      h('span', { class: 'vinfo' },
        h('span', { class: 'vt', text: v.title }),
        h('span', { class: 'vm' }, v.channel || '', v.verified && verifiedIcon()),
        line2 && h('span', { class: 'vm', text: line2 })));
  }

  function skeleton(kind, n) {
    return h('div', { class: 'grid2' }, Array.from({ length: n }, () =>
      h('div', { class: 'sk ' + kind }, h('span', { class: 'sk-a' }), h('span', { class: 'sk-t' }))));
  }

  function channelCard(c, big) {
    const sub = c.sub || isSub(c);
    return h('a', { class: 'ch' + (big ? ' big' : ''), href: channelUrl(c), 'data-nav': '', title: c.count ? countLabel(c.count) : null, onclick: () => { if (c.remote || state.query.trim()) recordVisit(c); } },
      avatar(c),
      h('span', { class: 'cinfo' },
        h('span', { class: 'cn' }, c.name, c.verified && verifiedIcon(), sub && c.remote !== undefined && h('span', { class: 'tag', text: t(15) })),
        h('span', { class: 'cm', text: c.meta || c.stats || (c.count ? countLabel(c.count) : (sub ? t(15) : '')) })));
  }

  const topChannels = (list) =>
    list.sort((a, b) => b.count - a.count || (b.sub ? 1 : 0) - (a.sub ? 1 : 0) || b.ts - a.ts).slice(0, LIMITS.topChannels);

  function setQuery(q) {
    const input = state.input;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    state.query = q;
    state.active = -1;
    fetchSuggestions();
    render();
  }

  function render() {
    try { renderInner(); } catch (e) {
      console.error('[MagicBar] error al pintar', e);
      try { panel.replaceChildren(h('div', { class: 'empty', text: t(30) + ' · ' + (e && e.message) + ((e && e.stack) ? ' @ ' + String(e.stack).split('\n')[0].slice(0, 80) : '') })); navEls = []; } catch { /* sin panel */ }
    }
  }

  function renderInner() {
    const q = state.query.trim();
    const ql = q.toLowerCase();
    const videos = Object.values(data.videos).sort((a, b) => b.ts - a.ts);
    const channels = Object.values(data.channels);
    panel.dir = RTL.includes(baseLang()) ? 'rtl' : 'ltr';
    const hit = (v) => (v.title + ' ' + v.channel).toLowerCase().includes(ql);

    /* columna 1: lo escrito / historial de búsquedas */
    const c1 = h('div', { class: 'col' });
    if (!q) {
      c1.append(sectionTitle(t(0)));
      const recent = historyItems().slice(0, LIMITS.searchesShown);
      if (recent.length) recent.forEach((x) => c1.append(historyRow(x)));
      else c1.append(h('div', { class: 'empty', text: syncing ? t(8) : t(7) }));
    } else {
      c1.append(sectionTitle(t(1)));
      c1.append(searchRow(q));
      state.suggestions.filter((s) => s.toLowerCase() !== ql).forEach((s) => c1.append(searchRow(s, { query: q })));
      const mine = data.searches.filter((s) => s.q.toLowerCase().includes(ql) && s.q.toLowerCase() !== ql &&
        !state.suggestions.includes(s.q)).slice(0, 3);
      if (mine.length) {
        c1.append(sectionTitle(t(2)));
        mine.forEach((s) => c1.append(searchRow(s.q, { history: true })));
      }
    }

    /* al escribir: texto a la izquierda y canales/vídeos a la derecha, ordenados según la intención */
    if (q) {
      const r = state.remote;
      const fresh = !!r && r.q === q;
      const local = (() => {
        const chs = topChannels(channels.filter((c) => normTxt(c.name).includes(normTxt(q)) || normTxt(c.url).includes(normTxt(q))));
        return { chs, vids: videos.filter(hit).slice(0, 4) };
      })();
      let remoteCh = r && r.channels.length ? r.channels.slice() : [];
      // suscritos que coinciden y YouTube no devolvió: se añaden con su foto
      local.chs.filter((c) => c.sub && !remoteCh.some((x) => x.id === c.id || (x.url && x.url.toLowerCase() === (c.url || '').toLowerCase())))
        .forEach((c) => remoteCh.push({ ...c, remote: true }));
      remoteCh = remoteCh.length ? rankChannels(q, remoteCh) : local.chs;
      const intent = q.length <= 2 ? 'short' : detectIntent(q, remoteCh);
      const main = remoteCh[0];
      const pool = (r && r.videos.length ? r.videos : []).map((v, i) => ({
        v, score: -i * 0.5 + (findChannel(v.channelKey, v.channelId, v.channel)?.sub ? 4 : 0) + (ownedBy(v, main) && /^channel/.test(intent) ? 3 : 0),
      })).sort((a, b) => b.score - a.score).map((x) => x.v);
      const vids = pool.length ? pool : (r ? local.vids : []);

      /* columna izquierda: sugerencias / historial */
      const nq = normTxt(q);
      const hist = historyItems((x) => x.type === 'q'
        ? normTxt(x.q) !== nq && (intent === 'short' ? normTxt(x.q).startsWith(nq) : similarity(q, x.q) >= 0.6 || normTxt(x.q).includes(nq))
        : normTxt(x.c.name).includes(nq) || normTxt(x.c.handle).includes(nq) || (intent !== 'short' && similarity(q, x.c.name) >= 0.7)
      ).slice(0, intent === 'short' ? 5 : 4);
      const sugg = state.suggestions.filter((x) => normTxt(x) !== normTxt(q)).slice(0, 8);
      const left = h('div', { class: 'col' });
      const addHist = () => { if (hist.length) { left.append(sectionTitle(intent === 'short' ? t(0) : t(2))); hist.forEach((x) => left.append(historyRow(x))); } };
      if (intent === 'short') addHist();
      left.append(sectionTitle(t(26)));
      left.append(searchRow(q));
      sugg.forEach((x) => left.append(searchRow(x, { query: q })));
      if (intent !== 'short') addHist();

      /* columna derecha: secciones en el orden de la intención */
      const right = h('div', { class: 'col span2' + (r && !fresh ? ' stale' : '') });
      const section = (title, nodes) => { if (nodes && (!Array.isArray(nodes) || nodes.length)) right.append(sectionTitle(title), nodes); };
      const chGrid = (list, bigFirst) => h('div', { class: 'grid2' }, list.map((c, i) => channelCard(c, bigFirst && i === 0)));
      const vGrid = (list) => h('div', { class: 'grid2' }, list.map((v) => videoCard(v)));
      const loading = !r;
      const mine = vids.filter((v) => ownedBy(v, main));
      const others = vids.filter((v) => !ownedBy(v, main));

      const official = !!(main && main.verified);
      const rel = r && r.related ? r.related.filter((c) => !main || c.id !== main.id) : [];
      const channelBlock = (title, max) => {
        if (!main) { if (loading) section(title, skeleton('ch', 2)); return; }
        const linked = official || rel.length > 0;
        if (!linked) { section(title, chGrid(remoteCh.slice(0, max + 1), true)); return; }
        const seenO = new Set([main.id]);
        const alts = remoteCh.slice(1).filter((c) => official && c.verified && nameSim(c.name, main.name) < 0.6);
        const others = [...rel, ...alts].filter((c) => !seenO.has(c.id) && seenO.add(c.id)).slice(0, max);
        section(title, chGrid([main], true));
        if (others.length) section(t(24), chGrid(others, false));
      };
      if (intent === 'short') {
        if (local.chs.length) section(t(21), chGrid(local.chs.slice(0, 4), false));
      } else if (intent === 'channel') {
        channelBlock(t(21), 4);
        const list = (mine.length ? mine : vids).slice(0, 4);
        if (list.length) section(t(23), vGrid(list)); else if (loading) section(t(23), skeleton('v', 4));
      } else if (intent === 'channel_topic') {
        channelBlock(t(29), 3);
        const topic = normTxt(q).split(/\s+/).slice(1).join(' ');
        const ownTop = mine.slice().sort((a, b) => (normTxt(b.title).includes(topic) ? 1 : 0) - (normTxt(a.title).includes(topic) ? 1 : 0)).slice(0, 4);
        if (ownTop.length) section(t(23), vGrid(ownTop)); else if (loading) section(t(23), skeleton('v', 4));
        if (others.length) section(t(25), vGrid(others.slice(0, 3)));
      } else if (intent === 'video_topic') {
        if (vids.length) section(t(22), vGrid(vids.slice(0, 6))); else if (loading) section(t(22), skeleton('v', 4));
        if (remoteCh.length) section(t(24), chGrid(remoteCh.slice(0, 3), false));
      } else { // broad
        if (vids.length) section(t(27), vGrid(vids.slice(0, 4))); else if (loading) section(t(27), skeleton('v', 4));
        if (remoteCh.length) section(t(28), chGrid(remoteCh.slice(0, 3), false)); else if (loading) section(t(28), skeleton('ch', 2));
      }
      if (intent !== 'short' && !loading && !right.children.length) right.append(h('div', { class: 'empty', text: t(30) }));

      panel.classList.toggle('loading', !!state.pending);
      panel.replaceChildren(h('div', { class: 'cols' }, left, right));
      navEls = [...panel.querySelectorAll('[data-nav]')];
      state.active = -1;
      place();
      return;
    }
    panel.classList.remove('loading');

    /* columna 2: últimos vídeos de a quienes sigues */
    const c2 = h('div', { class: 'col' });
    const news = data.feed.slice(0, LIMITS.feedVideos);
    c2.append(sectionTitle(t(3), morePill('/feed/subscriptions')));
    if (news.length) news.forEach((v) => c2.append(videoCard(v)));
    else c2.append(h('div', { class: 'empty', text: syncing ? t(10) : t(9) + (lastDbg ? ' · ' + lastDbg : '') }));

    /* columna 3: últimos 3 vídeos del historial + 4 canales más vistos */
    const c3 = h('div', { class: 'col' });
    const vids = videos.slice(0, LIMITS.recentVideos);
    const chs = topChannels(channels);
    c3.append(sectionTitle(t(4), morePill('/feed/history')));
    if (vids.length) vids.forEach((v) => c3.append(videoCard(v)));
    else c3.append(h('div', { class: 'empty', text: syncing ? t(12) : t(11) }));
    if (chs.length) {
      c3.append(sectionTitle(t(5), morePill('/feed/channels')));
      c3.append(h('div', { class: 'grid2' }, chs.map((c) => channelCard(c, false))));
    }

    panel.replaceChildren(h('div', { class: 'cols' }, c1, c2, c3));
    navEls = [...panel.querySelectorAll('[data-nav]')];
    state.active = -1;
    place();
  }

  function setActive(i) {
    navEls.forEach((el) => el.classList.remove('active'));
    state.active = i;
    const el = navEls[i];
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }
  }

  /* ───────────── Eventos globales ───────────── */

  const SEARCH_BOX = 'yt-searchbox, ytd-searchbox';
  const isSearchInput = (el) => el instanceof HTMLInputElement && el.type !== 'file' && el.type !== 'hidden' &&
    (el.name === 'search_query' || el.id === 'search' || (!!el.closest(SEARCH_BOX) && el.getAttribute('role') === 'combobox'));
  const inputIn = (box) => {
    const host2 = box.closest(SEARCH_BOX) || box;
    return [...host2.querySelectorAll('input')].find(isSearchInput) || null;
  };

  document.addEventListener('click', (e) => {
    const t = e.composedPath()[0];
    if (!t || !t.closest) return;
    if (isSearchInput(t)) { open(t); return; }
    // botón de buscar de YouTube: la búsqueda se guarda aunque la navegación sea instantánea
    if (t.closest('.ytSearchboxComponentSearchButton, #search-icon-legacy')) {
      const inp = inputIn(t);
      if (inp && inp.value.trim()) recordSearch(inp.value);
      return;
    }
    // clic en el hueco de la caja (fuera del <input>) también cuenta como «clic en la barra»
    const box = t.closest('.ytSearchboxComponentInputBox, .ytSearchboxComponentInputContainer, ytd-searchbox #container');
    if (box && !t.closest('button, [role="button"]')) {
      const inp = inputIn(box);
      if (inp) { inp.focus(); open(inp); }
    }
  }, true);
  document.addEventListener('input', (e) => {
    // escribir en la barra (acción del usuario) la abre de nuevo si se había cerrado
    if (!state.open && e.isTrusted && isSearchInput(e.target)) { open(e.target); return; }
    if (!state.open || e.target !== state.input) return;
    state.query = state.input.value;
    fetchSuggestions();
    render();
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (!state.open) return;
    const path = e.composedPath();
    if (path.includes(host) || path.includes(state.input)) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!state.open) return;
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    if (e.target !== state.input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!navEls.length) return;
      e.preventDefault(); e.stopPropagation();
      const n = navEls.length;
      setActive(e.key === 'ArrowDown' ? (state.active + 1) % n : (state.active - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (state.active >= 0) {
        e.preventDefault(); e.stopPropagation();
        const el = navEls[state.active];
        close();
        el.click();
      } else {
        recordSearch(state.input.value); // se guarda en el acto, antes de que YouTube navegue
        close(); // YouTube lanza la búsqueda por su cuenta
      }
    }
  }, true);
  document.addEventListener('submit', (e) => {
    const inp = e.target && e.target.querySelector && e.target.querySelector('input[name="search_query"]');
    if (inp && inp.value.trim()) recordSearch(inp.value);
    if (state.open && e.target.contains(state.input)) close();
  }, true);
  document.addEventListener('focusout', (e) => {
    if (state.open && e.target === state.input) setTimeout(() => { if (document.activeElement !== state.input) close(); }, 0);
  }, true);
  window.addEventListener('resize', () => state.open && place());
  window.addEventListener('scroll', () => state.open && place(), true);
  window.addEventListener('yt-navigate-start', close);
  window.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);
  // red de seguridad: si YouTube cambia de página sin lanzar ningún evento, la URL se vigila
  setInterval(() => { if (location.href !== lastHref) onNavigate(); }, 800);

  /* ───────────── Estilos del panel ───────────── */

  const CSS = `
    :host { all: initial; }
    .panel {
      --bg:var(--yt-spec-menu-background,#fff); --fg:var(--yt-spec-text-primary,#0f0f0f); --sub:var(--yt-spec-text-secondary,#606060);
      --hover:var(--yt-spec-badge-chip-background,rgba(0,0,0,.06)); --line:var(--yt-spec-10-percent-layer,rgba(0,0,0,.1));
      --chip:var(--yt-spec-badge-chip-background,rgba(0,0,0,.05)); --accent:var(--yt-spec-call-to-action,#065fd4); --thumb:#e5e5e5;
      position:fixed; z-index:2147483000; display:none; flex-direction:column; box-sizing:border-box;
      background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:20px;
      box-shadow:0 18px 50px rgba(0,0,0,.28); overflow:hidden;
      font:400 14px/1.35 Roboto,Arial,sans-serif; transform-origin:top center; color-scheme:light;
    }
    .panel.dark {
      --bg:var(--yt-spec-menu-background,#282828); --fg:var(--yt-spec-text-primary,#f1f1f1); --sub:var(--yt-spec-text-secondary,#aaa);
      --hover:var(--yt-spec-badge-chip-background,rgba(255,255,255,.1)); --line:var(--yt-spec-10-percent-layer,rgba(255,255,255,.12));
      --chip:var(--yt-spec-badge-chip-background,rgba(255,255,255,.1)); --accent:var(--yt-spec-call-to-action,#3ea6ff); --thumb:#333;
      color-scheme:dark;
    }
    .panel.shown { display:flex; animation:grow .22s cubic-bezier(.2,.8,.2,1); }
    @keyframes grow {
      from { opacity:0; transform:translateY(-8px) scaleY(.9); clip-path:inset(0 10% 85% 10% round 20px); }
      to   { opacity:1; transform:none; clip-path:inset(0 0 0 0 round 20px); }
    }
    * { box-sizing:border-box; }
    a { color:inherit; text-decoration:none; }
    button { font:inherit; color:inherit; background:none; border:0; cursor:pointer; padding:0; }
    .cols { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:0 20px; padding:8px 16px 14px; overflow-y:auto; }
    .narrow .span2 { grid-column:auto; }
    .narrow .cols { grid-template-columns:minmax(0,1fr); }
    .title { display:flex; justify-content:flex-start; gap:10px; align-items:center; margin:12px 0 6px; font-size:12px;
             font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--sub); }
    .pill { padding:2px 10px; border-radius:999px; background:var(--chip); color:var(--fg); text-transform:none; letter-spacing:0;
            font-size:11px; font-weight:500; }
    .pill:hover { background:var(--hover); }
    .link { color:var(--accent); font-size:12px; text-transform:none; letter-spacing:0; font-weight:500; }
    .link:hover { text-decoration:underline; }
    .row { display:flex; align-items:center; gap:12px; padding:0 8px; height:38px; border-radius:10px; }
    .row .avatar { width:26px; height:26px; font-size:12px; }
    .row:hover, .row.active, .vcard:hover, .vcard.active, .ch:hover, .ch.active { background:var(--hover); }
    .ic { display:inline-flex; width:20px; height:20px; flex:none; color:var(--sub); }
    .ic svg { width:20px; height:20px; }
    .txt { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .txt b { font-weight:700; }
    .mini { display:none; width:28px; height:28px; border-radius:50%; align-items:center; justify-content:center; flex:none; }
    .mini:hover { background:var(--hover); }
    .mini + .mini { margin-left:-6px; }
    .mini .ic { width:16px; height:16px; } .mini .ic svg { width:16px; height:16px; }
    .row:hover .mini, .row.active .mini { display:inline-flex; }
    .span2 { grid-column:span 2; }
    .stale { opacity:.55; transition:opacity .15s; }
    .trend { width:18px; height:18px; flex:none; } .trend svg { width:18px; height:18px; }
    .trend.up { color:#16a34a; } .trend.down { color:#dc2626; }
    .panel.dark .trend.up { color:#4ade80; } .panel.dark .trend.down { color:#f87171; }
    .vb { display:inline-flex; width:14px; height:14px; margin-left:5px; vertical-align:-2px; color:var(--sub); flex:none; }
    .vb svg { width:14px; height:14px; }
    .hd { margin-left:8px; color:var(--sub); font-size:12px; }
    .tag { margin-left:8px; padding:1px 7px; border-radius:999px; background:var(--chip); font-size:11px; font-weight:500; color:var(--sub); }
    .panel.loading::before { content:''; position:absolute; left:0; top:0; height:2px; width:35%; background:var(--accent);
      animation:slide 1s ease-in-out infinite; z-index:1; }
    @keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(300%); } }
    .grid2 > .ch.big { grid-column:1 / -1; }
    .ch.big { padding:14px 16px; gap:16px; background:var(--hover); border-radius:16px; margin-bottom:4px; }
    .ch.big .avatar { width:72px; height:72px; font-size:28px; }
    .ch.big .cn { font-size:19px; font-weight:600; }
    .ch.big .cm { font-size:13.5px; margin-top:2px; }
    .ch.big .vb, .ch.big .vb svg { width:17px; height:17px; }
    .ch.big .tag { font-size:12px; padding:2px 9px; }
    .sk { display:flex; gap:10px; align-items:center; padding:8px; }
    .sk-a { width:48px; height:48px; border-radius:50%; background:var(--hover); flex:none; animation:pulse 1.2s ease-in-out infinite; }
    .sk.v .sk-a { width:120px; height:68px; border-radius:8px; }
    .sk-t { flex:1; height:12px; border-radius:6px; background:var(--hover); animation:pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity:.45; } }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .vcard { display:flex; gap:10px; padding:6px; border-radius:12px; min-width:0; margin-bottom:2px; }
    .thumb { position:relative; display:block; width:120px; flex:none; aspect-ratio:16/9; border-radius:8px; background:var(--thumb); overflow:hidden; }
    .vinfo { display:flex; flex-direction:column; gap:2px; min-width:0; justify-content:center; }
    .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
    .badge { position:absolute; right:6px; bottom:6px; padding:1px 5px; border-radius:4px; background:rgba(0,0,0,.8); color:#fff; font-size:11px; font-weight:500; }
    .vt { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; font-weight:500; font-size:13px; }
    .vm { color:var(--sub); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; }
    .chgrid { gap:4px 8px; }
    .ch { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:12px; min-width:0; }
    .avatar { position:relative; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; flex:none;
              border-radius:50%; color:#fff; font-weight:600; overflow:hidden; }
    .avatar img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
    .cinfo { display:flex; flex-direction:column; min-width:0; }
    .cn { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cm { color:var(--sub); font-size:12px; }
    .empty { color:var(--sub); padding:10px 8px; font-size:13px; }
    .empty.hero { display:flex; flex-direction:column; gap:6px; padding:28px 12px; }
    .empty.hero b { color:var(--fg); font-size:15px; }
  `;

  /* ───────────── Arranque ───────────── */

  load(() => { loaded = true; onNavigate(); setTimeout(() => syncAccount(false), 1500); });
})();
