// Simula chrome.* para probar content.js fuera de la extensión.
(() => {
  const now = Date.now(), m = 60e3;
  const seed = {
    searches: ['lofi hip hop','react server components','cómo hacer pan de masa madre','git tutorial','barcelona vs real madrid resumen','mejores atajos de vscode','rust vs go 2026','receta tortilla de patatas','visualización de datos d3','piano relajante'].map((q,i)=>({q,ts:now-i*m*30})),
    videos: {
      dQw4w9WgXcQ:{id:'dQw4w9WgXcQ',title:'Rick Astley - Never Gonna Give You Up',channel:'Rick Astley',channelKey:'/@RickAstleyYT',ts:now-5*m},
      jNQXAC9IVRw:{id:'jNQXAC9IVRw',title:'Me at the zoo',channel:'jawed',channelKey:'/@jawed',ts:now-80*m},
      kJQP7kiw5Fk:{id:'kJQP7kiw5Fk',title:'Luis Fonsi - Despacito ft. Daddy Yankee',channel:'Luis Fonsi',channelKey:'/@LuisFonsi',ts:now-26*60*m},
      '9bZkp7q19f0':{id:'9bZkp7q19f0',title:'PSY - GANGNAM STYLE',channel:'officialpsy',channelKey:'/@officialpsy',ts:now-3*86400e3},
    },
    channels: Object.fromEntries([['Rick Astley',14],['Fireship',11],['Luis Fonsi',9],['Veritasium',7],['midudev',5],['jawed',2]]
      .map(([n,c])=>['/@'+n,{key:'/@'+n,name:n,url:'/@'+n,avatar:'',count:c,ts:now}])),
  };
  seed.feed=[['jNQXAC9IVRw','Me at the zoo','jawed'],['9bZkp7q19f0','PSY - GANGNAM STYLE','officialpsy'],['kJQP7kiw5Fk','Despacito','Luis Fonsi'],['dQw4w9WgXcQ','Never Gonna Give You Up','Rick Astley']].map(([id,title,channel],i)=>({id,title,channel,ts:now-i*1000,imp:true}));
  seed.trends={geo:'ES',at:now-4*3600e3,latest:{},prev:{},seen:{angular:now-86400e3}}; seed.hidden=[]; seed.v=3; Object.values(seed.videos).forEach(v=>v.ok=true);
  const KEY='magicbar:v1';
  localStorage[KEY]=JSON.stringify(seed);
  window.chrome={
    runtime:{id:'stub',lastError:null,sendMessage:(msg,cb)=>msg.type==='trends'?setTimeout(()=>cb({ok:true,items:[{term:'react',traffic:2000},{term:'midudev',traffic:500}]}),50):setTimeout(()=>cb({ok:true,items:['','  tutorial',' para principiantes',' 2026',' en español'].map(s=>msg.q+s).slice(1)}),120)},
    storage:{local:{get:(k,cb)=>cb({[KEY]:JSON.parse(localStorage[KEY])}),set:(o)=>{localStorage[KEY]=JSON.stringify(o[KEY])}},onChanged:{addListener(){}}},
  };
})();

// ── Mock de youtubei/v1/search (misma estructura que la API real) ──
window.__MB_DEV = true; window.__MB_MOCK = true;
(() => {
  const real = window.fetch.bind(window);
  const T = (x) => ({ simpleText: x });
  const ch = (id, name, handle, subs, hue) => ({ channelRenderer: { channelId: id, title: T(name),
    navigationEndpoint: { browseEndpoint: { browseId: id, canonicalBaseUrl: '/' + handle } },
    thumbnail: { thumbnails: [{ url: '//dummyimage.com/88x88/' + hue + '/fff&text=' + name[0].toUpperCase(), width: 88 }] },
    subscriberCountText: T(handle), videoCountText: T(subs),
    ownerBadges: /midudev|fireship|mouredev/.test(handle) ? [{ metadataBadgeRenderer: { icon: { iconType: 'CHECK_CIRCLE_THICK' }, style: 'BADGE_STYLE_TYPE_VERIFIED', tooltip: 'Verificada' } }] : undefined } });
  const vid = (id, title, owner, handle, cid, views, when) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: owner, navigationEndpoint: { browseEndpoint: { browseId: cid, canonicalBaseUrl: '/' + handle } } }] },
    viewCountText: T(views), publishedTimeText: T(when),
    ownerBadges: /midudev|fireship/.test(handle) ? [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }] : undefined } });
  const VIDS = [
    ['dQw4w9WgXcQ','Aprende React desde cero 2026','midudev','@midudev','UCmidu01','234.567 visualizaciones','hace 3 días'],
    ['jNQXAC9IVRw','Next.js 15 en 20 minutos','midudev','@midudev','UCmidu01','98.120 visualizaciones','hace 1 semana'],
    ['kJQP7kiw5Fk','Curso de TypeScript completo','midudev','@midudev','UCmidu01','1,2 M de visualizaciones','hace 8 meses'],
    ['9bZkp7q19f0','React vs Angular: ¿cuál elegir?','Fazt','@fazt','UCfazt001','456.002 visualizaciones','hace 2 años'],
    ['M7lc1UVf-VE','Cómo hacer un login con React','Código Facilito','@codigofacilito','UCcf000001','78.331 visualizaciones','hace 1 año'],
    ['aqz-KE-bpKQ','Hooks de React explicados','Fireship','@fireship','UCfs000001','2,3 M de visualizaciones','hace 3 años'],
  ];
  const mk = (q, params) => {
    const channels = /midu/i.test(q) ? [ch('UCmidu01','midudev','@midudev','1,05 M de suscriptores','e53'),ch('UCmidu02','midulive','@midulive','449 K suscriptores','36c'),ch('UCmidu03','MoureDev','@mouredev','1,01 M de suscriptores','2a7')] : [ch('UCfs000001','Fireship','@fireship','3,4 M de suscriptores','f80'),ch('UCfazt001','Fazt','@fazt','1,2 M de suscriptores','07a')];
    const items = params ? channels : [...channels.slice(0,1), ...VIDS.map(v => vid(...v))];
    return { contents: { items } };
  };
  const dot = (c, l) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${c}"/><text x="48" y="64" font-size="48" text-anchor="middle" fill="#fff" font-family="Arial">${l}</text></svg>`);
  const badge = [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_VERIFIED' } }];
  const spacexSearch = (params) => {
    const chs = [
      { channelRenderer: { channelId: 'UCspx', title: T('SpaceX'), navigationEndpoint: { browseEndpoint: { browseId: 'UCspx', canonicalBaseUrl: '/@SpaceX' } }, thumbnail: { thumbnails: [{ url: dot('#000', 'X') }] }, subscriberCountText: T('@SpaceX'), videoCountText: T('7,01 M de suscriptores'), ownerBadges: badge } },
      { channelRenderer: { channelId: 'UCfake1', title: T('SpaceX'), navigationEndpoint: { browseEndpoint: { browseId: 'UCfake1', canonicalBaseUrl: '/@spacexinmcer' } }, thumbnail: { thumbnails: [{ url: dot('#a33', 'S') }] }, subscriberCountText: T('@spacexinmcer'), videoCountText: T('1,99 K suscriptores') } },
      { channelRenderer: { channelId: 'UCfake2', title: T('SpaceX en Español'), navigationEndpoint: { browseEndpoint: { browseId: 'UCfake2', canonicalBaseUrl: '/@spacexes' } }, thumbnail: { thumbnails: [{ url: dot('#36a', 'S') }] }, subscriberCountText: T('@spacexes'), videoCountText: T('138 suscriptores') } },
    ];
    if (params) return { contents: { items: chs } };
    const v = (id, title, o, h, cid, av) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, viewCountText: T('1,2 M de visualizaciones'), publishedTimeText: T('hace 2 meses'),
      ownerText: { runs: [{ text: o, navigationEndpoint: { browseEndpoint: { browseId: cid, canonicalBaseUrl: '/' + h } } }] },
      channelThumbnailSupportedRenderers: { channelThumbnailWithLinkRenderer: { thumbnail: { thumbnails: [{ url: dot(av, o[0]) }] } } }, ownerBadges: badge } });
    return { contents: { items: [chs[0], v('aaa11111111', 'Starship Flight Test', 'SpaceX', '@SpaceX', 'UCspx', '#000'), v('bbb22222222', 'Artemis II explicado', 'NASA', '@NASA', 'UCnasa', '#c00'),
      v('ccc33333333', 'Tesla y SpaceX', 'Tesla', '@tesla', 'UCtesla', '#d22'), v('ddd44444444', 'Starship vs SLS', 'NASA', '@NASA', 'UCnasa', '#c00'), v('eee55555555', 'Lanzamiento en directo', 'SpaceX', '@SpaceX', 'UCspx', '#000')] } };
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/navigation/resolve_url')) return Promise.resolve(new Response(JSON.stringify({ endpoint: { browseEndpoint: { browseId: 'UCdemo' + Math.random().toString(36).slice(2, 6) } } })));
    if (u.includes('/youtubei/v1/browse')) {
      const b = JSON.parse(opts.body);
      if (b.params) return Promise.resolve(new Response(JSON.stringify({})));
      return Promise.resolve(new Response(JSON.stringify({
        metadata: { channelMetadataRenderer: { title: 'Canal real ' + b.browseId.slice(-4), avatar: { thumbnails: [{ url: dot('#2a6', 'R') }] } } },
        header: { pageHeaderRenderer: { x: [{ content: '@real' + b.browseId.slice(-3) }, { content: '3,17 K suscriptores' }, { content: '100 vídeos' }] } },
      })));
    }
    if (u.includes('/youtubei/v1/search') && /spacex/i.test(opts.body)) {
      const b = JSON.parse(opts.body); return new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(spacexSearch(b.params)))), 300));
    }
    if (String(url).includes('/youtubei/v1/search')) {
      const b = JSON.parse(opts.body);
      return new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(mk(b.query, b.params)), { status: 200 })), 350));
    }
    return real(url, opts);
  };
})();
