// Las sugerencias en vivo se piden desde aquí porque un content script
// no puede hacer fetch cross-origin con las reglas CORS de la página.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'trends') {
    // Tendencias de búsqueda del país (RSS público de Google Trends).
    fetch('https://trends.google.com/trending/rss?geo=' + encodeURIComponent(msg.geo || 'US'), { signal: AbortSignal.timeout(8000) })
      .then((r) => r.text())
      .then((xml) => {
        const dec = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
        const items = [];
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1];
          const traffic = (m[1].match(/<ht:approx_traffic>([^<]*)</) || [])[1] || '';
          if (title) items.push({ term: dec(title).trim(), traffic: parseInt(traffic.replace(/\D/g, ''), 10) || 0 });
        }
        sendResponse({ ok: items.length > 0, items });
      })
      .catch(() => sendResponse({ ok: false, items: [] }));
    return true;
  }
  if (msg?.type !== 'suggest' || !msg.q) return;
  const url =
    'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=' +
    encodeURIComponent(msg.lang || 'es') +
    '&q=' +
    encodeURIComponent(msg.q);
  fetch(url, { signal: AbortSignal.timeout(6000) })
    .then((r) => r.json())
    .then((j) => sendResponse({ ok: true, items: (j[1] || []).slice(0, 8) }))
    .catch(() => sendResponse({ ok: false, items: [] }));
  return true; // respuesta asíncrona
});
