// ==UserScript==
// @name         Kyara Plus
// @namespace    https://github.com/Mxyuki/Kyara-Script
// @version      1.3.0
// @description  Améliore kyara.games : rareté et exemplaires possédés sur les offres d’échange, bouton « Donner » sous chaque carte, wishlist en premier, offres cachées par le site, verrouillage depuis la collection, comptoir masquable.
// @author       Myuki
// @homepageURL  https://github.com/Mxyuki/Kyara-Script
// @supportURL   https://github.com/Mxyuki/Kyara-Script/issues
// @updateURL    https://raw.githubusercontent.com/Mxyuki/Kyara-Script/main/kyaraPlus.user.js
// @downloadURL  https://raw.githubusercontent.com/Mxyuki/Kyara-Script/main/kyaraPlus.user.js
// @icon         https://kyara.games/brand/favicon/favicon.svg
// @match        https://kyara.games/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ==========================================================================
   * 1. CONFIG — everything that depends on the site lives here
   * ======================================================================== */

  const LOG_PREFIX = '[Kyara+]';
  /** Log every request that changes something on the server (POST/PUT/PATCH/DELETE) with its body. */
  const DEBUG_REQUESTS = true;
  /** True inside the invisible wiki frame used to lock cards: only the network hook runs there. */
  const IN_FRAME = window.top !== window;
  /** postMessage type sent by the wiki frame to the collection page when its lock request finished. */
  const FRAME_LOCK_DONE = 'kyara-plus:lock-done';

  /** API requests the site makes. GETs are read; the lock POST is learned from the site (see learnLockRequest). */
  const API = {
    collection: /\/api\/me\/collection(\?|$)/,
    offers: /\/api\/[^?]*offers(\?|$)/,
    characters: /\/api\/[^?]*characters(\?|$)/,
    wishlist: /\/api\/[^?]*wish/i,
    tradeAvailable: /\/api\/trades\/available\/([0-9a-f-]+)(?:\?|$)/i, // a player's tradable cards [{ characterId, n }]
    tradeOwned: /\/api\/trades\/owned\/([0-9a-f-]+)(?:\?|$)/i, // every card a player owns: [4, 353, …] (ids only, no count)
    prices: /\/api\/fair-play\/prices\?/, // ?ids=1,2,3 -> { "<cardId>": price }
    lock: /\/api\/(?:[^?]*\/)?pin(?:[/?]|$)/, // POST, sent by the 🔒 button of a wiki page
  };

  /**
   * Lock request, as seen in DevTools: POST /api/me/collection/<cardId>/pin  body {"pinned":true|false}.
   * A request learned from the site at runtime (STORAGE.lockRequest) takes precedence, in case the site changes.
   */
  const LOCK_REQUEST = { url: '/api/me/collection/{id}/pin', stateKey: 'pinned', idKey: null };

  /** localStorage keys (per-browser conveniences only, never secrets). */
  const STORAGE = {
    wishlist: 'kp-wishlist',
    showChat: 'kp-show-chat',
    lockRequest: 'kp-lock-request', // { url: '…{id}…', stateKey, idKey } learned from the site
    catalogUrl: 'kp-catalog-url', // path of the site's card catalogue request, to load it on pages that do not
  };
  // Filters (albums, « Que j’ai en double ») are NOT stored: they reset on every page load.

  /** Site DOM selectors. The site is Svelte: never rely on the svelte-xxxx hash classes. */
  const SITE = {
    offer: 'li.offer',
    offerList: 'ul.offers',
    offerGiveLink: '.give a.big',
    offerGiveInfo: '.give .gi',
    offerWant: '.want',
    offerThumbs: '.thumbs',
    offerThumb: 'a.thumb',
    offerActionButtons: '.acts button',
    search: '.filters input[type="search"]',
    activeFilter: '.filters [aria-pressed="true"]:not([data-kp-pill])', // the site's own filter pills
    offerFilters: '.filters', // search + pills « Que je n’ai pas », « Que je peux accepter », « Mes offres »
    offerPill: '.filters .pill',
    chat: '.chat-side, .chat-fab',
    chatPage: /^\/marche\/chat/,
    marketPage: /^\/marche/,
    marketTabs: '.tabs[role="tablist"]', // Acheter, Vendre, Enchères, Échanges, Mon activité
    exchangesTab: /échanges/i, // text of the market tab showing the exchange offers
    myOffersPill: /mes offres/i, // text of the last exchange filter pill
    collectionPage: /^\/collection/,
    collectionSlot: '.cell > a.slot',
    collectionBar: '.mk',
    collectionLockIcon: '.pin',
    wikiLockButton: 'button[aria-pressed]', // text « 🔒 Verrouiller » / « 🔓 Déverrouiller », aria-pressed="true" when locked
    // Collection › Albums view (same URL /collection, toggled by the « Albums » button)
    albumList: 'ul.albums',
    album: 'button.album',
    albumName: '.a-name',
    albumMeta: '.a-meta', // « 57/195 · 29 % »
    albumRarities: '.a-rar > span', // « C 38/98 », « U 11/44 »… (a rarity the album does not have is absent)
    albumTools: '.al-tools',
    albumMore: '.more button', // « Afficher plus · 1 035 albums » (120 albums per page)
    viewButtons: '.views button', // « Cartes » / « Albums »
    // Profile › trade window (« Proposer un échange à <pseudo> »)
    profilePage: /^\/profil\/([0-9a-f-]+)/i,
    tradeShelf: '[role="dialog"] .shelf',
    tradeTab: '.tabs [role="tab"]', // « Mes cartes » / « Cartes de <pseudo> », aria-selected="true" when shown
    partnerTab: /^\s*cartes de\s/i,
    tradeChips: '.filters .chips',
    tradeSearch: '.filters input[type="search"]',
    tradeChip: 'button.only', // aria-pressed. Mine: « Mes doubles », « Il lui manque »; partner's: « Je l’ai », « Il me manque »
    tradeChipOwned: /je l.ai/i, // partner's tab: only the cards I own
    tradeChipMissing: /il me manque/i, // partner's tab: only the cards I do not own
    tradeRarityChip: '.chips button:not(.only)', // « Toutes », M L E R U C; class « on » when selected
    tradeGrid: 'ul.grid:not([data-kp-grid])', // shows 60 cards at most: the search is needed to reach the others
    // img src …/<cardId>.webp, span.r (rarity letter), span.nm (name), span.lack « Il me manque » (only if I do not own it),
    // span.pr.mono price « 1 002 ◆ », span.have « ×N dispo »
    tradeTile: 'button.tile',
    tradeTilePrice: '.pr',
    // Profile page: « Proposer un échange » button (opens the trade window)
    profileButtons: 'button, a',
    profileTradeButton: /proposer un [ée]change/i,
    cardImageId: /\/(\d+)[^/]*\.webp(?:[?#]|$)/, // card id in a card image URL
  };

  /** Trade API URL of a player's tradable cards. */
  const tradeAvailableUrl = (userId) => `/api/trades/available/${userId}`;
  /** Trade API URL of every card a player owns (ids only). */
  const tradeOwnedUrl = (userId) => `/api/trades/owned/${userId}`;
  /** Cards shown at once in a player's collection (« Afficher plus » for the next ones). */
  const PLAYER_PAGE = 120;
  /** Card prices (the « ◆ » value the site shows), by batch of ids like the site asks for them. */
  const pricesUrl = (ids) => `/api/fair-play/prices?ids=${ids.join(',')}`;
  const PRICES_BATCH = 60;
  /** My collection, as the site requests it (used when this page did not load it). */
  const COLLECTION_URL = '/api/me/collection?lean=1';

  /** Hash used to open an album in a new tab: /collection#kp-album=<name>. */
  const ALBUM_HASH = 'kp-album=';

  /** Card image URL by card id. */
  const cardImage = (id) => `/cards/sm/${id}.webp`;

  /** Rarity order, colours (the inset box-shadow the site puts on card images) and labels. */
  const RARITIES = [
    { rgb: [181, 177, 187], name: 'Commune' },
    { rgb: [63, 191, 127], name: 'Peu commune' },
    { rgb: [77, 155, 255], name: 'Rare' },
    { rgb: [176, 114, 255], name: 'Épique' },
    { rgb: [245, 197, 24], name: 'Légendaire' },
    { rgb: [255, 77, 46], name: 'Mythique' },
  ];

  /** Rarity codes as found in site data (r-C … r-M in its CSS) and full names -> RARITIES index. */
  const RARITY_CODES = {
    c: 0, common: 0, commune: 0,
    u: 1, uncommon: 1, 'peu commune': 1,
    r: 2, rare: 2,
    e: 3, epic: 3, epique: 3, 'épique': 3,
    l: 4, legendary: 4, legendaire: 4, 'légendaire': 4,
    m: 5, mythic: 5, mythique: 5,
  };

  const COLORS = {
    duplicate: '#3fbf7f',
    single: '#ffb02e',
    wishlist: '#f5c518',
  };

  /* ==========================================================================
   * 2. UTILS
   * ======================================================================== */

  const log = (...args) => console.info(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  const rgbCss = (rarity) => `rgb(${rarity.rgb.join(',')})`;
  const rarityColor = (rarity) => (rarity ? rgbCss(rarity) : 'var(--line2, #2e2b36)');
  const wikiId = (href) => { const m = /\/wiki\/(\d+)/.exec(href || ''); return m ? m[1] : null; };
  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  /** Lowercase without accents, for searches (« Épique » matches « epique »). */
  const fold = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const storage = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode, blocked storage… */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* idem */ }
    },
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Small element builder.
   * el('a', { class: 'x', href: '/', text: 'Hi', onClick: fn, '--var': 'red' }, child, …)
   */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('--')) node.style.setProperty(key, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  /** Only write to the DOM when the value changes (writes would retrigger our MutationObserver). */
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function setAttr(node, name, value) {
    if (value === null) { if (node.hasAttribute(name)) node.removeAttribute(name); }
    else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function expiresText(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return '';
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return 'expire ' + (d ? `${d} j ${h} h` : h ? `${h} h` : `${m} min`);
  }

  /* ==========================================================================
   * 3. STATE — filled from the site's own API responses
   * ======================================================================== */

  const state = {
    /** Map<cardId, { qty, locked, resaleLocked }> or null until the collection is loaded. */
    collection: null,
    collectionVersion: 0,
    /** Set<cardId> of the wishlist, cached in localStorage (only loaded on the wishlist page). */
    wishlist: new Set(storage.get(STORAGE.wishlist, storage.get('kx-wishlist', []))), // kx-: key used before Kyara Plus 1.0
    /** Map<cardId, { name, rarity }> from the card catalogue. */
    catalog: new Map(),
    /** Open exchange offers as sent by the server (the site only displays 120 of them). */
    serverOffers: [],
    offersVersion: 0,
    /** Map<userId, Map<cardId, n>>: tradable copies of other players (trade window). */
    tradeAvailable: new Map(),
    /** Map<userId, Set<cardId>>: every card of other players (profile › « Voir sa collection »). */
    tradeOwned: new Map(),
    /** Map<cardId, price> from /api/fair-play/prices (the site's requests and ours). */
    prices: new Map(),
  };

  const ownedQty = (id) => (state.collection && state.collection.get(String(id))?.qty) || 0;
  /** Copies that can actually be given: a locked card cannot be traded at all. */
  function freeCopies(id) {
    const c = state.collection && state.collection.get(String(id));
    if (!c || c.locked) return 0;
    return Math.max(0, c.qty - (c.resaleLocked || 0));
  }
  const isLocked = (id) => !!(state.collection && state.collection.get(String(id))?.locked);
  const inWishlist = (id) => state.wishlist.has(String(id));

  function cardInfo(id) {
    const c = state.catalog.get(String(id));
    return { name: (c && c.name) || `Carte #${id}`, rarity: c ? c.rarity : null, series: (c && c.series) || '', known: !!(c && c.name) };
  }

  /* ==========================================================================
   * 4. PARSERS — turn API responses into state
   * ======================================================================== */

  const ID_KEYS = ['characterId', 'character_id', 'charId', 'cardId', 'card_id', 'card', 'character', 'id'];
  const COUNT_KEYS = ['qty', 'count', 'quantity', 'copies', 'amount'];

  function pick(obj, keys) {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }

  /** Find the list of entries in a response, whatever its wrapping. */
  function findEntries(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    for (const k of ['cards', 'items', 'collection', 'wishlist', 'wishes', 'characters', 'offers', 'data', 'entries', 'ids']) {
      if (Array.isArray(data[k])) return data[k];
    }
    return Object.values(data).find(Array.isArray) || null;
  }

  function entryId(entry) {
    let id = Array.isArray(entry) ? entry[0] : (entry && typeof entry === 'object') ? pick(entry, ID_KEYS) : entry;
    if (id && typeof id === 'object') id = id.id ?? id.characterId;
    return id === undefined || id === null ? null : String(id);
  }

  function rarityFromCode(value) {
    if (value === undefined || value === null) return null;
    const idx = RARITY_CODES[String(value).trim().toLowerCase()];
    return idx === undefined ? null : RARITIES[idx];
  }

  /** Rarity from the coloured inset box-shadow the site puts on card images. */
  function rarityFromImg(img) {
    const shadow = img.style.boxShadow || getComputedStyle(img).boxShadow || '';
    const m = shadow.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const c = [+m[1], +m[2], +m[3]];
    let best = null, bestD = Infinity;
    for (const r of RARITIES) {
      const d = (r.rgb[0] - c[0]) ** 2 + (r.rgb[1] - c[1]) ** 2 + (r.rgb[2] - c[2]) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    return bestD < 3000 ? best : null; // nearest colour, tolerant to small shade changes
  }

  /** /api/me/collection?lean=1 -> [{ characterId, qty, locked, resaleLocked, ... }] */
  function parseCollection(data) {
    const entries = findEntries(data);
    if (!entries) return null;
    const map = new Map();
    for (const e of entries) {
      const id = entryId(e);
      if (!id) continue;
      const qty = (e && typeof e === 'object' && !Array.isArray(e)) ? pick(e, COUNT_KEYS) : Array.isArray(e) ? e[1] : 1;
      const prev = map.get(id) || { qty: 0, locked: false, resaleLocked: 0 };
      prev.qty += typeof qty === 'number' ? qty : 1;
      if (e && typeof e === 'object') {
        prev.locked = prev.locked || !!+e.locked;
        prev.resaleLocked += +e.resaleLocked || 0;
      }
      map.set(id, prev);
    }
    return map.size ? map : null;
  }

  /** Wishlist response -> Set of card ids. */
  function parseWishlist(data) {
    const entries = findEntries(data);
    if (!entries) return null;
    return new Set(entries.map(entryId).filter(Boolean));
  }

  /**
   * /api/characters -> Map<id, { name, rarity }>.
   * Kyara format: [{ id, name, native, image, favourites, rank, rarity: 'M', num, series, pow, aura }]
   * (arrays are handled too, in case the site switches to a compact format).
   */
  function parseCatalog(data) {
    const entries = findEntries(data);
    if (!entries || !entries.length) return null;
    const map = new Map();
    for (const e of entries) {
      let id, name, rarity, series;
      if (Array.isArray(e)) {
        id = e.find((x) => typeof x === 'number');
        rarity = e.find((x) => typeof x === 'string' && rarityFromCode(x));
        name = e.find((x) => typeof x === 'string' && x !== rarity && x.length > 1);
      } else if (e && typeof e === 'object') {
        id = e.id ?? e.characterId;
        name = e.name ?? e.nom ?? e.title;
        rarity = e.rarity ?? e.rarete ?? e.rar ?? e.r;
        series = e.series ?? e.serie;
        if (series && typeof series === 'object') series = series.name ?? series.title;
      }
      if (id === undefined || id === null) continue;
      map.set(String(id), { name: typeof name === 'string' ? name : null, rarity: rarityFromCode(rarity), series: typeof series === 'string' ? series : null });
    }
    return map.size ? { map, sample: entries[0] } : null;
  }

  /** /api/trades/available/<userId> -> Map<cardId, n> ([{ characterId, n }], n = tradable copies). */
  function parseTradeAvailable(data) {
    const entries = findEntries(data);
    if (!entries) return null;
    const map = new Map();
    for (const e of entries) {
      const id = entryId(e);
      if (id) map.set(id, (map.get(id) || 0) + (+(e && e.n) || 1));
    }
    return map;
  }

  /** /api/trades/owned/<userId> -> Set<cardId> ([4, 353, …]: ids only, no copy count). */
  function parseTradeOwned(data) {
    const entries = findEntries(data);
    return entries ? new Set(entries.map(entryId).filter(Boolean)) : null;
  }

  /** /api/fair-play/prices?ids=… -> Map<cardId, price> ({ "28331": 200, … }; a list of { id, price } is accepted too). */
  function parsePrices(data) {
    if (!data || typeof data !== 'object') return null;
    const pairs = Array.isArray(data)
      ? data.map((e) => [entryId(e), e && (e.price ?? e.value ?? e.median)])
      : Object.entries(data);
    const map = new Map();
    for (const [id, price] of pairs) if (id && Number.isFinite(+price) && price !== null) map.set(String(id), +price);
    return map;
  }

  /** /api/.../offers -> open exchange offers [{ id, user:{pseudo}, characterId, wantIds, expiresAt, ... }] */
  function parseOffers(data) {
    const list = findEntries(data);
    if (!list || !list.length || !list[0] || !('wantIds' in list[0])) return null; // not the exchange list
    const now = Date.now();
    return list.filter((o) => o.status === 'open' && !o.closedAt && (!o.expiresAt || Date.parse(o.expiresAt) > now));
  }

  /* ==========================================================================
   * 5. NETWORK — read the site's own responses. The script never sees the login token.
   * ======================================================================== */

  const HANDLERS = [
    {
      match: API.collection,
      handle(data) {
        const map = parseCollection(data);
        if (!map) return warn('format de collection non reconnu', data);
        state.collection = map;
        state.collectionVersion++;
        log('collection reçue :', map.size, 'cartes');
      },
    },
    {
      match: API.offers,
      handle(data) {
        const offers = parseOffers(data);
        if (!offers) return;
        state.serverOffers = offers;
        state.offersVersion++;
        log('offres d’échange reçues :', offers.length, 'ouvertes');
      },
    },
    {
      match: API.characters,
      handle(data, url) {
        const parsed = parseCatalog(data);
        if (!parsed) return;
        state.catalog = parsed.map;
        if (url) { const u = new URL(url, location.origin); storage.set(STORAGE.catalogUrl, u.pathname + u.search); }
        const withRarity = [...parsed.map.values()].filter((c) => c.rarity).length;
        log(`catalogue : ${parsed.map.size} cartes (${withRarity} avec rareté). Exemple :`, JSON.stringify(parsed.sample).slice(0, 300));
      },
    },
    {
      match: API.tradeAvailable,
      handle(data, url) {
        const userId = (API.tradeAvailable.exec(url) || [])[1];
        const cards = parseTradeAvailable(data);
        if (!userId || !cards) return warn('format des cartes échangeables non reconnu', data);
        state.tradeAvailable.set(userId.toLowerCase(), cards);
        log('cartes échangeables du joueur :', cards.size, 'dont', [...cards.values()].filter((n) => n > 1).length, 'en double');
      },
    },
    {
      match: API.tradeOwned,
      handle(data, url) {
        const userId = (API.tradeOwned.exec(url) || [])[1];
        const cards = parseTradeOwned(data);
        if (!userId || !cards) return warn('format de la collection du joueur non reconnu', data);
        state.tradeOwned.set(userId.toLowerCase(), cards);
        log('collection du joueur :', cards.size, 'cartes');
      },
    },
    {
      match: API.prices,
      handle(data) {
        const prices = parsePrices(data);
        if (!prices) return warn('format des prix non reconnu', data);
        for (const [id, price] of prices) state.prices.set(id, price);
      },
    },
    {
      match: API.wishlist,
      handle(data) {
        const ids = parseWishlist(data);
        if (!ids) return warn('format de wishlist non reconnu', data);
        state.wishlist = ids;
        storage.set(STORAGE.wishlist, [...ids]);
        log('wishlist reçue :', ids.size, 'cartes');
      },
    },
  ];

  const nativeFetch = window.fetch;
  let lastCollectionRequest = null; // kept in memory only, to reload the collection after a trade
  let lastOffersRequest = null; // idem, to reload the exchange offers (refresh button)

  const isRequest = (x) => typeof Request !== 'undefined' && x instanceof Request;

  /** Feed a response to its handler. Resolves true once fresh data was handled (never rejects). */
  function readResponse(promise, handler, url) {
    return promise
      .then((res) => (res.ok ? res.clone().json() : null))
      .then((data) => { if (!data) return false; handler.handle(data, String(url)); scheduleRender(); return true; })
      .catch(() => false); // not JSON, 304, network error…
  }

  window.fetch = function (input, init) {
    const promise = nativeFetch.apply(this, arguments);
    try {
      // input can be a string, a URL object or a Request
      const url = isRequest(input) ? input.url : String(input || '');
      const method = ((init && init.method) || (isRequest(input) && input.method) || 'GET').toUpperCase();
      if (method === 'GET') {
        const handler = HANDLERS.find((h) => h.match.test(url));
        if (handler) {
          const request = { input: isRequest(input) ? input.clone() : input, init };
          if (handler.match === API.collection) lastCollectionRequest = request;
          const offersBefore = state.offersVersion;
          readResponse(promise, handler, url).then(() => {
            // Other "offers" APIs exist: only keep the one that returned the exchange list
            if (handler.match === API.offers && state.offersVersion > offersBefore) lastOffersRequest = request;
          });
        }
      } else {
        const body = isRequest(input) ? input.clone().text() : Promise.resolve(init && init.body);
        if (DEBUG_REQUESTS && /\/api\//.test(url)) {
          body.then((b) => log(`requête ${method}`, new URL(url, location.origin).pathname, typeof b === 'string' ? b.slice(0, 200) : `(${typeof b})`)).catch(() => {});
        }
        if (method === 'POST' && API.lock.test(url)) {
          const cardId = wikiId(location.pathname);
          const report = (ok, status, response) => {
            if (IN_FRAME) window.parent.postMessage({ type: FRAME_LOCK_DONE, ok, status, response }, location.origin);
          };
          // Clone the response in the first callback, before the site reads it (a body can only be read once)
          const result = promise.then((res) => {
            const copy = res.clone();
            return copy.text().catch(() => '').then((response) => ({ ok: res.ok, status: res.status, response }));
          });
          Promise.all([result, body])
            .then(([res, text]) => {
              if (res.ok) learnLockRequest(url, text, cardId);
              report(res.ok, res.status, res.response);
            })
            .catch((err) => { warn('lecture de la requête de verrouillage impossible', err); report(false, 0, ''); });
        }
      }
    } catch { /* never break the site's own requests */ }
    return promise;
  };

  /**
   * Headers of the site's own collection request (kept in memory only), reused for our requests.
   * Cache validators are dropped so the server always answers with fresh data (never a 304).
   */
  function siteHeaders(request = lastCollectionRequest) {
    if (!request) return null;
    const { input, init } = request;
    const headers = new Headers(isRequest(input) ? input.headers : undefined);
    new Headers((init && init.headers) || undefined).forEach((value, key) => headers.set(key, value));
    headers.delete('if-none-match');
    headers.delete('if-modified-since');
    return headers;
  }

  /** Send a site GET again (same URL, same headers, fresh data) and feed it to its handler. Resolves true if fresh data arrived. */
  function replayRequest(request, api) {
    if (!request) return Promise.resolve(false);
    const { input, init } = request;
    const url = isRequest(input) ? input.url : input;
    const handler = HANDLERS.find((h) => h.match === api);
    return readResponse(nativeFetch(url, { ...(init || {}), headers: siteHeaders(request), cache: 'no-store' }), handler, url);
  }

  const reloadCollection = () => replayRequest(lastCollectionRequest, API.collection);
  /** GET my collection: the site's own request if seen, else its usual URL (read only). */
  function loadCollection() {
    if (lastCollectionRequest) return reloadCollection();
    const handler = HANDLERS.find((h) => h.match === API.collection);
    return readResponse(nativeFetch(COLLECTION_URL, { credentials: 'same-origin', cache: 'no-store' }), handler, COLLECTION_URL);
  }
  const reloadOffers = () => replayRequest(lastOffersRequest, API.offers);

  /** GET one of a player's card lists (read only), when the site did not load it itself. */
  function loadPlayerCards(url, api) {
    const handler = HANDLERS.find((h) => h.match === api);
    return readResponse(nativeFetch(url, { headers: siteHeaders() || undefined, credentials: 'same-origin', cache: 'no-store' }), handler, url);
  }
  const loadTradeAvailable = (userId) => loadPlayerCards(tradeAvailableUrl(userId), API.tradeAvailable);
  const loadTradeOwned = (userId) => loadPlayerCards(tradeOwnedUrl(userId), API.tradeOwned);

  /** Card ids whose price was already asked (by us), so each one is asked once per page load. */
  const pricesAsked = new Set();

  /** GET the prices of the given cards that are not known yet, by batches like the site (read only). */
  function loadPrices(ids) {
    const missing = ids.map(String).filter((id) => !state.prices.has(id) && !pricesAsked.has(id));
    if (!missing.length) return Promise.resolve(true);
    missing.forEach((id) => pricesAsked.add(id));
    const handler = HANDLERS.find((h) => h.match === API.prices);
    const batches = [];
    for (let i = 0; i < missing.length; i += PRICES_BATCH) {
      const url = pricesUrl(missing.slice(i, i + PRICES_BATCH));
      batches.push(readResponse(nativeFetch(url, { headers: siteHeaders() || undefined, credentials: 'same-origin' }), handler, url));
    }
    return Promise.all(batches).then((oks) => oks.every(Boolean));
  }

  /** Prices of many cards, a few batches at a time (a whole collection can be thousands of cards). */
  async function loadPricesInTurn(ids) {
    for (let i = 0; i < ids.length; i += PRICES_BATCH * 3) await loadPrices(ids.slice(i, i + PRICES_BATCH * 3));
  }

  /** « 1 002 ◆ », like the site. */
  const priceText = (price) => `${Math.round(price).toLocaleString('fr-FR')} ◆`;

  /** GET the card catalogue (names, rarities) like the site does, when this page did not load it. */
  function loadCatalog() {
    if (state.catalog.size) return Promise.resolve(true);
    const url = storage.get(STORAGE.catalogUrl, null) || '/api/characters';
    const handler = HANDLERS.find((h) => h.match === API.characters);
    return readResponse(nativeFetch(url, { headers: siteHeaders() || undefined, credentials: 'same-origin' }), handler, url);
  }

  /**
   * Learn the lock request from a real one sent by the site (wiki page 🔒 button):
   * the card id is replaced by {id} in the URL / body, the boolean field is the lock state.
   */
  function learnLockRequest(url, bodyText, cardId) {
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return warn('requête de verrouillage illisible', bodyText); }
    const stateKey = Object.keys(body).find((k) => typeof body[k] === 'boolean');
    const idKey = Object.keys(body).find((k) => cardId && String(body[k]) === cardId);
    const path = new URL(url, location.origin).pathname;
    const urlHasId = !!cardId && path.split('/').includes(cardId);
    if (!stateKey || (!urlHasId && !idKey)) return warn('requête de verrouillage non comprise', path, body);

    const learned = { url: urlHasId ? path.split('/').map((p) => (p === cardId ? '{id}' : p)).join('/') : path, stateKey, idKey: idKey || null };
    storage.set(STORAGE.lockRequest, learned);
    log('requête de verrouillage apprise :', `POST ${learned.url}`, `{ "${stateKey}": true|false${idKey ? `, "${idKey}": id` : ''} }`);
    scheduleRender();
  }

  /**
   * Lock or unlock a card. Resolves when the server accepted it, rejects otherwise.
   * Fast path: the request learned from the site. Otherwise (or if it failed): the site's own
   * button, clicked in an invisible frame of the card's wiki page — which also teaches us the request.
   * The server's answer to the lock request is the proof: `lockStateFromResponse` reads the new state in it.
   */
  async function setCardLock(id, locked) {
    const direct = await sendLearnedLock(id, locked);
    if (direct && direct.ok) {
      const result = lockStateFromResponse(direct.response);
      if (result === null || result === locked) return;
      warn('le serveur a répondu un autre état que celui demandé : requête apprise oubliée', direct.response);
      storage.remove(STORAGE.lockRequest);
    }
    const report = await lockThroughWikiFrame(id, locked);
    const result = report ? lockStateFromResponse(report.response) : null;
    if (result !== null && result !== locked) throw new Error('le site indique que la carte n’a pas changé');
  }

  /**
   * New lock state in the server's answer to the lock request, e.g. { characterId, pinned: true }.
   * Returns true / false, or null when the answer does not say (then we trust the HTTP status).
   */
  function lockStateFromResponse(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (typeof data === 'boolean') return data;
    if (!data || typeof data !== 'object') return null;
    const isFlag = (v) => typeof v === 'boolean' || v === 0 || v === 1;
    const keys = Object.keys(data);
    const key = keys.find((k) => /pin|lock/i.test(k) && isFlag(data[k]))
      || keys.find((k) => typeof data[k] === 'boolean' && !/^(ok|success)$/i.test(k));
    return key ? !!data[key] : null;
  }

  /** Send the lock request (learned one, else LOCK_REQUEST). Resolves { ok, status, response }, or null if it could not be sent. */
  async function sendLearnedLock(id, locked) {
    const learned = storage.get(STORAGE.lockRequest, null) || LOCK_REQUEST;
    const headers = siteHeaders();
    if (!headers) return null; // the site's collection request was not seen yet: no headers to reuse
    headers.set('content-type', 'application/json');
    const url = learned.url.replace('{id}', id);
    const body = { [learned.stateKey]: locked };
    if (learned.idKey) body[learned.idKey] = Number(id);
    try {
      const res = await nativeFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const response = await res.text().catch(() => '');
      log('verrouillage direct :', `POST ${url}`, JSON.stringify(body), `→ HTTP ${res.status}`, response);
      if (!res.ok) warn('verrouillage direct refusé, passage par la page wiki');
      return { ok: res.ok, status: res.status, response };
    } catch (err) {
      warn('verrouillage direct impossible, passage par la page wiki', err);
      return null;
    }
  }

  /** Wait until fn() returns something truthy (polling), or fail after `timeout` ms. */
  function waitFor(fn, timeout) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let value = null;
        try { value = fn(); } catch { /* frame not ready yet */ }
        if (value) resolve(value);
        else if (Date.now() - start > timeout) reject(new Error('la page wiki n’a pas répondu à temps'));
        else setTimeout(tick, 150);
      };
      tick();
    });
  }

  /**
   * Open /wiki/<id> in an invisible frame and click its lock button if needed.
   * The frame is only removed once its request has finished: our script running inside the frame
   * posts FRAME_LOCK_DONE (removing the frame earlier would cancel the request).
   * Resolves the frame's report { ok, status, response }, or null if it did not report.
   */
  async function lockThroughWikiFrame(id, locked) {
    const frame = el('iframe', { src: `/wiki/${id}`, class: 'kp-hidden-frame', 'aria-hidden': 'true', tabindex: '-1' });
    let onMessage = null;
    const requestDone = new Promise((resolve) => {
      onMessage = (e) => {
        if (e.source === frame.contentWindow && e.origin === location.origin && e.data && e.data.type === FRAME_LOCK_DONE) resolve(e.data);
      };
      window.addEventListener('message', onMessage);
    });
    document.body.appendChild(frame);

    const lockButton = () => [...frame.contentDocument.querySelectorAll(SITE.wikiLockButton)]
      .find((b) => /verrouill/i.test(b.textContent)) || null;
    const isPressed = (b) => b.getAttribute('aria-pressed') === 'true';
    try {
      // The wiki page first renders its button as "unlocked", before it has loaded the collection:
      // wait until it shows the card's current state (the opposite of the wanted one) before clicking.
      let lastSeen = null;
      let button;
      try {
        button = await waitFor(() => { const b = lockButton(); if (b) lastSeen = b; return b && isPressed(b) !== locked ? b : null; }, 20000);
      } catch (err) {
        if (lastSeen && isPressed(lastSeen) === locked) return null; // the card already is in the wanted state
        throw err;
      }
      button.click();
      const report = await Promise.race([requestDone, sleep(15000).then(() => null)]);
      if (report && !report.ok) throw new Error(`le site a refusé (HTTP ${report.status})`);
      if (report) {
        log('verrouillage via la page wiki : HTTP', report.status, report.response);
      } else {
        // Our script did not report from the frame: rely on the button, and give the request time to finish
        warn('la page wiki n’a pas confirmé sa requête, on se fie à son bouton');
        await waitFor(() => { const b = lockButton(); return b && isPressed(b) === locked; }, 10000);
        await sleep(2000);
      }
      return report;
    } finally {
      window.removeEventListener('message', onMessage);
      frame.remove();
    }
  }

  /* ==========================================================================
   * 6. STYLES — every class/attribute we add is prefixed with kp-
   * ======================================================================== */

  const CSS = `
    /* ---- Offered card: rarity badge, same size as the proposition tiles ---- */
    a[data-kp-rarity] { position: relative !important; display: inline-block; }
    a[data-kp-rarity] img { outline: 3px solid var(--kp-rc); outline-offset: -3px; }
    li.offer .give a.big img { width: 102px !important; height: auto !important; aspect-ratio: 5 / 7; }
    .kp-badge {
      position: absolute; left: 50%; bottom: 3px; transform: translateX(-50%);
      padding: 1px 6px; border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 5;
      font: 700 10px/1.3 system-ui, sans-serif; color: #111; background: var(--kp-rc);
      box-shadow: 0 1px 3px rgba(0,0,0,.6);
    }
    .kp-owned { font-size: 12px; font-weight: 700; }

    /* ---- Order: wishlist first, then rarest first (CSS order, the site's list is never reordered) ---- */
    li.offer { order: var(--kp-order, 0); }
    li.offer[data-kp-wish], .kp-xoffer.kp-wish { border-color: ${COLORS.wishlist} !important; box-shadow: 0 0 0 1px ${COLORS.wishlist}; }
    .kp-wish-tag { font-size: 12px; font-weight: 700; color: ${COLORS.wishlist}; }
    li.offer.kp-flash { box-shadow: 0 0 0 3px ${COLORS.wishlist} !important; }

    /* ---- Site elements we replace (thumbs, "Donner X" buttons, lock icon) ---- */
    [data-kp-hidden] { display: none !important; }

    /* ---- Proposition grid ---- */
    li.offer .want:has(> .kp-grid), .kp-xoffer .kp-want { flex: 1 1 420px; }
    .kp-grid { display: grid; gap: 8px; grid-template-columns: repeat(5, minmax(0, 1fr)); max-width: 620px; }
    @media (max-width: 480px) { .kp-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    .kp-tile {
      display: flex; flex-direction: column; gap: 5px; min-width: 0;
      padding: 6px; border-radius: 12px; background: var(--panel2, #17161d); border: 2px solid var(--kp-rc);
    }
    .kp-tile.kp-missing { opacity: .45; border-style: dashed; }
    .kp-tile.kp-missing:hover { opacity: .8; }
    .kp-tile a { display: block; position: relative; }
    .kp-tile img { display: block; width: 100%; aspect-ratio: 5 / 7; object-fit: cover; object-position: 50% 20%; border-radius: 8px; }
    .kp-rar, .kp-cnt {
      position: absolute; padding: 1px 6px; border-radius: 6px;
      font: 700 10px/1.3 system-ui, sans-serif; color: #111; box-shadow: 0 1px 3px rgba(0,0,0,.6);
    }
    .kp-rar { left: 4px; top: 4px; background: var(--kp-rc); }
    .kp-cnt { right: 4px; bottom: 4px; }
    .kp-cnt.kp-dup { background: ${COLORS.duplicate}; }
    .kp-cnt.kp-single { background: ${COLORS.single}; }
    .kp-name {
      font-size: 12px; font-weight: 700; line-height: 1.25; text-align: center; min-height: 2.5em;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
    }
    .kp-state { font-size: 11px; text-align: center; color: var(--fg2, #b7b2bd); }
    .kp-give { width: 100%; justify-content: center; }
    .kp-give.kp-warn { background: ${COLORS.single}; border-color: ${COLORS.single}; color: #111; }

    /* ---- Exchanges: refresh button after « Mes offres » (copies the pill's classes) ---- */
    .kp-refresh { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
    .kp-refresh svg { width: 14px; height: 14px; display: block; }
    .kp-refresh[data-kp-busy] { cursor: wait; opacity: .7; }
    .kp-refresh[data-kp-busy] svg { animation: kp-spin .8s linear infinite; }
    @keyframes kp-spin { to { transform: rotate(360deg); } }

    /* ---- Profile › trade window: « Ses doubles » chip ---- */
    [data-kp-dupes] .kp-n { margin-left: 4px; opacity: .7; }
    [data-kp-dupes][data-kp-busy] { cursor: wait; opacity: .7; }
    .kp-trade-empty { grid-column: 1 / -1; list-style: none; margin: 12px 0; text-align: center; font-size: 13px; color: var(--fg2, #b7b2bd); }
    [data-kp-grid] .kp-adding { opacity: .5; cursor: wait; }

    /* ---- Profile: « Voir sa collection » panel ---- */
    [data-kp-collection] { margin-left: 8px; }
    [data-kp-collection] .kp-n { margin-left: 6px; opacity: .7; }
    .kp-pc-backdrop {
      position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 12px;
      background: rgba(0,0,0,.6);
    }
    .kp-pc {
      display: flex; flex-direction: column; gap: 10px; width: min(1180px, 100%); max-height: calc(100vh - 24px);
      padding: 14px 16px; border-radius: 16px; border: 1px solid var(--line, #25232c);
      background: var(--panel, #15141a); color: var(--fg, #edeae4); font-size: 13px; box-shadow: 0 12px 40px rgba(0,0,0,.6);
    }
    .kp-pc-head { display: flex; align-items: center; gap: 12px; }
    .kp-pc-head h2 { margin: 0; font-size: 18px; }
    .kp-pc-count { color: var(--fg2, #b7b2bd); }
    .kp-pc-close { margin-left: auto; width: 32px; height: 32px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; color: inherit; font-size: 16px; cursor: pointer; }
    .kp-pc-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
    .kp-pc-filters input[type="search"] { flex: 1 1 220px; min-width: 0; }
    .kp-pc-filters select.kp-af-input { padding-right: 4px; }
    .kp-pc-filters option { background: var(--panel, #15141a); }
    .kp-pc-toggle {
      position: relative; display: inline-flex; align-items: center; height: 28px; padding: 0 12px; cursor: pointer; user-select: none;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); color: var(--fg3, #c9c5ce);
    }
    .kp-pc-toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .kp-pc-toggle:has(input:checked) { background: var(--fg, #edeae4); color: #111; border-color: var(--fg, #edeae4); }
    .kp-pc-toggle:has(input:focus-visible) { outline: 2px solid var(--fg, #edeae4); outline-offset: 2px; }
    .kp-pc-note { margin: 0; padding: 8px 10px; border-radius: 10px; border: 1px solid ${COLORS.single}; color: ${COLORS.single}; font-size: 12px; }
    .kp-pc-body { overflow-y: auto; min-height: 120px; }
    .kp-pc-grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
    .kp-pc-card { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 6px; border-radius: 12px; background: var(--panel2, #17161d); border: 2px solid var(--kp-rc); }
    .kp-pc-card a { display: block; position: relative; }
    .kp-pc-card img { display: block; width: 100%; aspect-ratio: 5 / 7; object-fit: cover; object-position: 50% 20%; border-radius: 8px; }
    .kp-pc-lock { position: absolute; right: 4px; top: 4px; padding: 1px 4px; border-radius: 6px; font-size: 11px; background: rgba(0,0,0,.65); }
    .kp-pc-name { font-weight: 700; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kp-pc-series { font-size: 11px; color: var(--fg2, #b7b2bd); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kp-pc-meta { display: flex; justify-content: space-between; gap: 4px; font-size: 11px; }
    .kp-pc-lack { color: ${COLORS.duplicate}; font-weight: 700; }
    .kp-pc-empty { margin: 24px 0; text-align: center; color: var(--fg2, #b7b2bd); }
    .kp-pc-more { display: block; margin: 12px auto 0; height: 32px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; color: inherit; font: inherit; cursor: pointer; }

    /* ---- Offers the site does not display ---- */
    .kp-extra { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
    .kp-extra.kp-extra-top { margin: 0 0 10px; }
    .kp-extra h3 { margin: 0; font-size: 16px; }
    .kp-extra p { margin: 2px 0 0; font-size: 12px; color: var(--fg2, #b7b2bd); }
    .kp-xlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .kp-xoffer {
      display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
      border: 1px solid var(--line, #25232c); background: var(--panel, #15141a); border-radius: 14px;
    }
    .kp-xtop { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; }
    .kp-xgive { flex: 1 1 240px; display: flex; align-items: center; gap: 10px; min-width: 0; }
    .kp-xbig { position: relative; display: inline-block; flex: none; }
    .kp-xbig img {
      display: block; width: 102px; aspect-ratio: 5 / 7; object-fit: cover; object-position: 50% 20%;
      border-radius: 10px; outline: 3px solid var(--kp-rc); outline-offset: -3px;
    }
    .kp-xinfo { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .kp-xinfo .kp-sub { font-size: 12px; color: var(--fg2, #b7b2bd); }
    .kp-xarrow { color: var(--fg2, #b7b2bd); font-size: 22px; }
    .kp-xacts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 8px; border-top: 1px solid var(--line, #25232c); }

    /* ---- Collection: lock toggle under each owned card ---- */
    .cell > a.slot { position: relative; }
    .kp-lock-icon {
      position: absolute; top: 6px; right: 6px; z-index: 6; pointer-events: none;
      padding: 2px 5px; border-radius: 8px; font-size: 13px; background: rgba(0,0,0,.65);
    }
    /* Small lock toggle next to the site's sell button / label (left untouched) */
    .kp-lock-mini {
      display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; cursor: pointer; flex: none;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; font-size: 12px;
      opacity: .55;
    }
    .kp-lock-mini:hover { border-color: ${COLORS.wishlist}; opacity: 1; }
    .kp-lock-mini[aria-pressed="true"] { border-color: ${COLORS.wishlist}; background: rgba(0,0,0,.35); opacity: 1; }
    [data-kp-control][data-kp-busy] { opacity: .6; cursor: wait; }
    .kp-hidden-frame {
      position: fixed; left: -10000px; top: 0; width: 1200px; height: 800px; /* desktop size so the site renders its button */
      border: 0; opacity: 0; pointer-events: none;
    }

    /* ---- Collection › Albums: filters ---- */
    .al-tools:has(> .kp-album-filters) { flex-wrap: wrap; }
    .kp-album-filters {
      flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 8px; padding: 10px 12px;
      border: 1px solid var(--line, #25232c); border-radius: 12px; background: var(--panel, #15141a); font-size: 13px;
    }
    .kp-af-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kp-af-label { color: var(--fg2, #b7b2bd); }
    .kp-af-input {
      height: 28px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line2, #2e2b36);
      background: transparent; color: var(--fg, #edeae4); font: inherit;
    }
    .kp-af-input[type="number"] { width: 70px; }
    .kp-af-rar {
      position: relative; display: inline-flex; align-items: center; height: 26px; padding: 0 10px; cursor: pointer; user-select: none;
      border-radius: 999px; border: 1px solid var(--kp-rc); color: var(--kp-rc); font-weight: 700;
    }
    .kp-af-rar input { position: absolute; opacity: 0; pointer-events: none; }
    .kp-af-rar:has(input:checked) { background: var(--kp-rc); color: #111; }
    .kp-af-rar:has(input:focus-visible) { outline: 2px solid var(--fg, #edeae4); outline-offset: 2px; }
    .kp-af-count { margin-left: auto; color: var(--fg2, #b7b2bd); }
    .kp-af-reset { height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; color: var(--fg3, #c9c5ce); font: inherit; cursor: pointer; }

    /* ---- Comptoir (market chat): hidden unless toggled ---- */
    html:not(.kp-show-chat):not(.kp-chat-page) .chat-side, html:not(.kp-show-chat):not(.kp-chat-page) .chat-fab { display: none !important; }
    html:not(.kp-show-chat):not(.kp-chat-page) .layout:has(.chat-side) { grid-template-columns: minmax(0, 1fr) !important; }
    #kp-chat-toggle {
      position: fixed; left: 16px; bottom: 16px; z-index: 50; padding: 8px 14px; border-radius: 999px; cursor: pointer;
      font: 700 12px system-ui, sans-serif; color: var(--fg, #edeae4); background: var(--panel2, #17161d);
      border: 1px solid var(--line2, #2e2b36); box-shadow: 0 4px 12px rgba(0,0,0,.5);
    }
  `;

  function injectStyles() {
    if (document.getElementById('kp-style')) return;
    document.head.appendChild(el('style', { id: 'kp-style', text: CSS }));
  }

  /* ==========================================================================
   * 7. COMPONENTS — shared UI pieces
   * ======================================================================== */

  function ownedLabel(qty) {
    return qty
      ? { text: `Tu l’as déjà (×${qty})`, color: 'var(--fg2, #b7b2bd)' }
      : { text: 'Tu ne l’as pas encore', color: COLORS.duplicate };
  }

  function countBadge(id, qty) {
    if (!qty) return null;
    const hint = qty >= 2
      ? `Tu en as ${qty} : tu peux l’échanger et en garder une`
      : 'C’est ta seule copie : tu ne l’auras plus après l’échange';
    return el('span', {
      class: `kp-cnt ${qty >= 2 ? 'kp-dup' : 'kp-single'}`,
      text: `×${qty}`,
      title: hint + (isLocked(id) ? ' (🔒 verrouillée)' : ''),
    });
  }

  /**
   * One proposed card: image, rarity, owned count, name, and an action (button or state text).
   * `onOpen` replaces the link's default navigation (used to go through the site's router).
   */
  function cardTile({ id, name, src, rarity, available, qty, onOpen, action }) {
    const link = el('a', {
      href: `/wiki/${id}`,
      title: name + (rarity ? ` – ${rarity.name}` : ''),
      onClick: onOpen && ((e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen();
      }),
    },
    el('img', { src, alt: name, referrerpolicy: 'no-referrer' }),
    rarity && el('span', { class: 'kp-rar', text: rarity.name }),
    countBadge(id, qty));

    return el('div', { class: 'kp-tile' + (available ? '' : ' kp-missing'), '--kp-rc': rarityColor(rarity) },
      link,
      el('div', { class: 'kp-name', text: name }),
      action);
  }

  const stateText = (text) => el('div', { class: 'kp-state', text });

  /** Refresh icon (circular arrow, like fa-refresh), drawn inline: the site has no icon font. */
  function refreshIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const d of ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 3.5v5h-5']) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  /* ==========================================================================
   * 8. FEATURES — each one is idempotent and safe to run on every DOM change
   * ======================================================================== */

  /** Hide the market chat ("le comptoir") with a toggle button to bring it back (never on the chat's own page). */
  const chatToggle = {
    name: 'chatToggle',
    run() {
      const onChatPage = SITE.chatPage.test(location.pathname);
      document.documentElement.classList.toggle('kp-chat-page', onChatPage);
      const hasChat = !onChatPage && !!document.querySelector(SITE.chat);
      let button = document.getElementById('kp-chat-toggle');
      if (!hasChat) { if (button) button.remove(); return; }

      const shown = storage.get(STORAGE.showChat, false);
      document.documentElement.classList.toggle('kp-show-chat', shown);
      if (!button) {
        button = el('button', {
          id: 'kp-chat-toggle',
          type: 'button',
          onClick: () => { storage.set(STORAGE.showChat, !storage.get(STORAGE.showChat, false)); scheduleRender(); },
        });
        document.body.appendChild(button);
      }
      setText(button, shown ? 'Masquer le comptoir' : 'Afficher le comptoir');
    },
  };

  /** Market tabs: a « Comptoir » tab after « Mon activité », opening /marche/chat (the site's tab look is copied). */
  const marketChatTab = {
    name: 'marketChatTab',
    run() {
      if (!SITE.marketPage.test(location.pathname)) return;
      const tabs = document.querySelector(SITE.marketTabs);
      if (!tabs) return;
      const siteTab = [...tabs.querySelectorAll('button')].find((b) => !b.hasAttribute('data-kp-tab'));
      let tab = tabs.querySelector(':scope > [data-kp-tab]');
      if (!tab) {
        tab = el('button', {
          type: 'button',
          'data-kp-tab': '',
          text: 'Comptoir',
          title: 'Ouvrir le comptoir (chat du marché)',
          onClick: () => navigate('/marche/chat'),
          onAuxclick: (e) => { if (e.button === 1) { e.preventDefault(); window.open('/marche/chat', '_blank'); } },
        });
        tabs.appendChild(tab);
      }
      // Same classes as an unselected site tab; selected look on the chat page itself
      const base = siteTab ? siteTab.className.replace(/\bon\b/g, '').trim() : '';
      setAttr(tab, 'class', SITE.chatPage.test(location.pathname) ? `${base} on` : base);
    },
  };

  /** Navigate inside the site (SvelteKit intercepts clicks on links: no full reload). */
  function navigate(href) {
    const link = el('a', { href, hidden: true });
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  /**
   * Display order of an offer (lower first): wishlist you can accept, wishlist, then the others;
   * inside each group, by rarity of the offered card, Mythique first. Unknown rarity: last of its group.
   */
  function offerOrder(wish, rarity) {
    const rank = rarity ? RARITIES.indexOf(rarity) + 1 : 0; // 0 unknown … 6 Mythique
    return -(wish * 10 + rank);
  }

  /** True when the offer asks for at least one card you own in 2+ copies. */
  const asksForDuplicate = (wantIds) => wantIds.some((id) => ownedQty(id) >= 2);

  /**
   * Exchanges (/marche?onglet=offres): « Que j’ai en double » pill right after the site's « Que je peux accepter ».
   * When on, only offers asking for a card you own ×2+ are shown (site offers here, hidden offers in `hiddenOffers`).
   * Off on every page load (not stored).
   */
  const duplicateFilter = {
    name: 'duplicateFilter',
    on: false,

    isOn() { return this.on && !!state.collection; },

    run() {
      this.renderPill();
      const on = this.isOn();
      document.querySelectorAll(SITE.offer).forEach((offer) => {
        const wantIds = [...offer.querySelectorAll(`${SITE.offerWant} ${SITE.offerThumb}`)].map((a) => wikiId(a.getAttribute('href'))).filter(Boolean);
        setAttr(offer, 'data-kp-hidden', on && !asksForDuplicate(wantIds) ? '' : null);
      });
    },

    renderPill() {
      // Only the exchanges filter bar has « Que je peux accepter »: other market tabs have a .filters bar too
      const anchor = [...document.querySelectorAll(SITE.offerPill)]
        .find((p) => !p.hasAttribute('data-kp-pill') && /accepter/i.test(p.textContent));
      document.querySelectorAll('[data-kp-pill]').forEach((p) => { if (!anchor || p.previousElementSibling !== anchor) p.remove(); });
      if (!anchor) return;

      let pill = anchor.nextElementSibling && anchor.nextElementSibling.hasAttribute('data-kp-pill') ? anchor.nextElementSibling : null;
      if (!pill) {
        pill = el('button', {
          type: 'button',
          'data-kp-pill': '',
          text: 'Que j’ai en double',
          title: 'N’afficher que les échanges qui demandent une carte que tu as en au moins 2 exemplaires',
          onClick: () => { this.on = !this.on; scheduleRender(); },
        });
        anchor.after(pill);
      }
      const base = anchor.className.replace(/\bon\b/g, '').replace(/\s+/g, ' ').trim();
      setAttr(pill, 'class', this.on ? `${base} on` : base);
      setAttr(pill, 'aria-pressed', String(this.on));
    },
  };

  /** A filter pill's label without its counter (« Mes offres 1 » -> « Mes offres »). */
  const pillLabel = (pill) => pill.textContent.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

  /**
   * Exchanges: refresh button right after « Mes offres ». The site's list only reloads when its exchanges
   * view is mounted again, so we switch to another site tab and back (its own buttons): the site then sends
   * its own offers request. If it does not, we replay that request ourselves (hidden offers stay fresh).
   */
  const offersRefresh = {
    name: 'offersRefresh',
    busy: false,

    run() {
      const anchor = [...document.querySelectorAll(SITE.offerPill)]
        .find((p) => !p.hasAttribute('data-kp-pill') && !p.hasAttribute('data-kp-refresh') && SITE.myOffersPill.test(p.textContent));
      document.querySelectorAll('[data-kp-refresh]').forEach((b) => { if (!anchor || b.previousElementSibling !== anchor) b.remove(); });
      if (!anchor) return;

      let button = anchor.nextElementSibling && anchor.nextElementSibling.hasAttribute('data-kp-refresh') ? anchor.nextElementSibling : null;
      if (!button) {
        button = el('button', {
          type: 'button',
          'data-kp-refresh': '',
          title: 'Actualiser les échanges',
          'aria-label': 'Actualiser les échanges',
          onClick: () => this.refresh(),
        }, refreshIcon());
        anchor.after(button);
      }
      const base = anchor.className.replace(/\bon\b/g, '').replace(/\s+/g, ' ').trim();
      setAttr(button, 'class', `${base} kp-refresh`);
      setAttr(button, 'data-kp-busy', this.busy ? '' : null);
    },

    async refresh() {
      if (this.busy) return;
      this.busy = true;
      scheduleRender();
      const before = state.offersVersion;
      const pressed = this.sitePills().filter((p) => p.getAttribute('aria-pressed') === 'true').map(pillLabel);
      try {
        await this.remountExchanges();
        await waitFor(() => state.offersVersion > before, 5000);
        log('échanges actualisés par le site');
      } catch {
        // The site did not reload its list: at least get fresh data for the hidden offers
        if (await reloadOffers()) log('échanges actualisés (requête rejouée)');
        else warn('impossible d’actualiser les échanges');
      } finally {
        await this.restorePills(pressed);
        this.busy = false;
        scheduleRender();
      }
    },

    /** The site's own filter pills (« Que je n’ai pas », « Que je peux accepter », « Mes offres »). */
    sitePills() {
      return [...document.querySelectorAll(SITE.offerPill)].filter((p) => !p.hasAttribute('data-kp-pill') && !p.hasAttribute('data-kp-refresh'));
    },

    /** Remounting resets the site's pills: press again (site's own buttons) the ones that were on. */
    async restorePills(labels) {
      if (!labels.length) return;
      try { await waitFor(() => this.sitePills().length, 3000); } catch { return warn('filtres du site introuvables après l’actualisation'); }
      for (const label of labels) {
        const pill = this.sitePills().find((p) => pillLabel(p) === label);
        if (pill && pill.getAttribute('aria-pressed') !== 'true') pill.click();
        await sleep(50); // let the site re-render before looking for the next pill
      }
    },

    /** Click another market tab, then « Échanges » again, through the site's own tab buttons. */
    async remountExchanges() {
      const tabs = () => [...document.querySelectorAll(`${SITE.marketTabs} button`)].filter((b) => !b.hasAttribute('data-kp-tab'));
      const exchanges = () => tabs().find((b) => SITE.exchangesTab.test(b.textContent));
      const other = tabs().find((b) => b !== exchanges());
      if (!exchanges() || !other) throw new Error('onglets introuvables');
      other.click();
      await waitFor(() => { const b = exchanges(); return b && !b.classList.contains('on'); }, 3000);
      exchanges().click();
      await waitFor(() => { const b = exchanges(); return b && b.classList.contains('on'); }, 3000);
    },
  };

  /** Exchange offers rendered by the site: rarity, owned counts, tile grid with one "Donner" per card, wishlist. */
  const offerCards = {
    name: 'offerCards',
    run() {
      document.querySelectorAll(SITE.offer).forEach((offer) => {
        this.decorateGivenCard(offer);
        this.renderGrid(offer);
        this.markWishlist(offer);
      });
    },

    decorateGivenCard(offer) {
      const link = offer.querySelector(SITE.offerGiveLink);
      const info = offer.querySelector(SITE.offerGiveInfo);
      if (!link) return;

      const img = link.querySelector('img');
      const rarity = img && rarityFromImg(img);
      if (rarity && link.getAttribute('data-kp-rarity') !== rarity.name) {
        link.setAttribute('data-kp-rarity', rarity.name);
        link.style.setProperty('--kp-rc', rgbCss(rarity));
        if (!link.querySelector('.kp-badge')) link.appendChild(el('span', { class: 'kp-badge' }));
        setText(link.querySelector('.kp-badge'), rarity.name);
      }

      if (info && state.collection) {
        const { text, color } = ownedLabel(ownedQty(wikiId(link.getAttribute('href'))));
        let owned = info.querySelector(':scope > .kp-owned');
        if (!owned) info.appendChild(owned = el('span', { class: 'kp-owned' }));
        setText(owned, text);
        if (owned.style.color !== color) owned.style.color = color;
      }
    },

    renderGrid(offer) {
      const want = offer.querySelector(SITE.offerWant);
      const thumbs = want && want.querySelector(SITE.offerThumbs);
      const links = thumbs ? [...thumbs.querySelectorAll(SITE.offerThumb)] : [];
      if (!links.length) return;

      // The site's "Donner <name>" buttons, matched to the thumbs by name (in order, for duplicates)
      const giveButtons = [...offer.querySelectorAll(SITE.offerActionButtons)].filter((b) => /^Donner\s/.test(b.textContent.trim()));

      const cards = links.map((a) => {
        const img = a.querySelector('img');
        const name = (img && img.alt) || (a.title || '').replace(/\s*\(tu l.as\)\s*$/, '');
        const i = giveButtons.findIndex((b) => b.textContent.trim() === `Donner ${name}`);
        const button = i >= 0 ? giveButtons.splice(i, 1)[0] : null;
        const id = wikiId(a.getAttribute('href'));
        const have = a.classList.contains('have');
        // Only show a count when it agrees with the site's own "tu l'as"
        return { a, img, id, name, have, button, qty: have ? ownedQty(id) || null : null, rarity: img && rarityFromImg(img) };
      });

      const signature = state.collectionVersion + '@' + cards.map((c) =>
        [c.id, c.img && c.img.src, c.have, c.button ? (c.button.disabled ? 'd' : 'b') : '', c.rarity && c.rarity.name, c.qty].join('|')).join('#');

      let grid = want.querySelector(':scope > .kp-grid');
      if (grid && grid.dataset.signature === signature) return;
      if (!grid) want.appendChild(grid = el('div', { class: 'kp-grid' }));
      grid.dataset.signature = signature;
      grid.replaceChildren(...cards.map((c) => cardTile({
        id: c.id,
        name: c.name,
        src: c.img ? c.img.src : cardImage(c.id),
        rarity: c.rarity,
        available: c.have,
        qty: c.qty,
        onOpen: () => c.a.click(), // let the site's router navigate
        action: c.button ? this.giveButton(c) : stateText(c.have ? 'Tu l’as (pas libre)' : 'Tu ne l’as pas'),
      })));
      thumbs.setAttribute('data-kp-hidden', '');
    },

    /** Our "Donner" button only clicks the site's own (hidden) button. */
    giveButton(card) {
      card.button.setAttribute('data-kp-hidden', '');
      return el('button', {
        type: 'button',
        class: 'btn btn-acc btn-sm kp-give' + (card.qty === 1 ? ' kp-warn' : ''),
        text: 'Donner',
        title: card.button.textContent.trim(),
        disabled: card.button.disabled,
        onClick: () => {
          card.button.click();
          setTimeout(() => reloadCollection(), 3000);
          setTimeout(() => reloadCollection(), 10000);
        },
      });
    },

    /** data-kp-wish "2" = in wishlist and you can accept it now, "1" = in wishlist. Also sets the display order. */
    markWishlist(offer) {
      const link = offer.querySelector(SITE.offerGiveLink);
      const info = offer.querySelector(SITE.offerGiveInfo);
      if (!link || !info) return;
      const wished = inWishlist(wikiId(link.getAttribute('href')));
      const wish = wished ? (offer.querySelector('.kp-give') ? 2 : 1) : 0;
      setAttr(offer, 'data-kp-wish', wish ? String(wish) : null);
      const img = link.querySelector('img');
      const order = String(offerOrder(wish, img && rarityFromImg(img)));
      if (offer.style.getPropertyValue('--kp-order') !== order) offer.style.setProperty('--kp-order', order);
      const tag = info.querySelector(':scope > .kp-wish-tag');
      if (wished && !tag) info.appendChild(el('span', { class: 'kp-wish-tag', text: '♥ Dans ta wishlist' }));
      else if (!wished && tag) tag.remove();
    },
  };

  /** Offers the server sends but the site does not display (it caps its list at 120). */
  const hiddenOffers = {
    name: 'hiddenOffers',
    run() {
      const list = document.querySelector(SITE.offerList);
      if (!list || !state.serverOffers.length || this.filtersActive()) return this.clear();

      const shown = new Set([...list.querySelectorAll(`${SITE.offer}[id^="offre-"]`)].map((li) => li.id.slice('offre-'.length)));
      if (!shown.size) return this.clear();

      const canGive = (o) => (o.wantIds || []).some((w) => freeCopies(w) > 0);
      const rank = (o) => offerOrder(inWishlist(o.characterId) ? (canGive(o) ? 2 : 1) : 0, cardInfo(o.characterId).rarity) * 2 + (canGive(o) ? 0 : 1);
      const duplicatesOnly = duplicateFilter.isOn();
      const missing = state.serverOffers
        .filter((o) => !shown.has(o.id))
        .filter((o) => !duplicatesOnly || asksForDuplicate((o.wantIds || []).map(String)))
        .sort((a, b) => rank(a) - rank(b));

      const signature = [missing.map((o) => o.id).join(','), state.collectionVersion, state.wishlist.size, state.catalog.size, duplicatesOnly].join('@');
      const bottom = document.getElementById('kp-extra');
      if (bottom && bottom.dataset.signature === signature) return;
      this.clear();
      if (!missing.length) return;

      const wished = missing.filter((o) => inWishlist(o.characterId));
      const others = missing.filter((o) => !inWishlist(o.characterId));
      const help = 'Le site n’affiche que les 120 premières offres. « Ouvrir l’offre » la fait apparaître dans la liste avec ses boutons « Donner ».';

      if (wished.length) {
        list.before(this.section('kp-extra-top', `♥ ${plural(wished.length, 'offre')} de ta wishlist que le site n’affiche pas`, help, wished));
      }
      const section = this.section('kp-extra', `${plural(others.length, 'autre offre')} que le site n’affiche pas`, help, others);
      section.dataset.signature = signature;
      if (!others.length) section.hidden = true;
      list.after(section);
    },

    clear() {
      document.getElementById('kp-extra-top')?.remove();
      document.getElementById('kp-extra')?.remove();
    },

    /** With a search or a filter, the site hides offers on purpose: do not add them back. */
    filtersActive() {
      const search = document.querySelector(SITE.search);
      return !!((search && search.value.trim()) || document.querySelector(SITE.activeFilter));
    },

    section(id, title, help, offers) {
      return el('div', { id, class: 'kp-extra' + (id === 'kp-extra-top' ? ' kp-extra-top' : '') },
        el('div', {}, el('h3', { text: title }), el('p', { text: help })),
        el('ul', { class: 'kp-xlist' }, offers.map((o) => this.offer(o))));
    },

    offer(o) {
      const give = cardInfo(o.characterId);
      const wished = inWishlist(o.characterId);
      const owned = state.collection ? ownedLabel(ownedQty(o.characterId)) : null;

      const givenCard = el('div', { class: 'kp-xgive' },
        el('a', { class: 'kp-xbig', href: `/wiki/${o.characterId}`, '--kp-rc': rarityColor(give.rarity) },
          el('img', { src: cardImage(o.characterId), alt: give.name, referrerpolicy: 'no-referrer' }),
          give.rarity && el('span', { class: 'kp-badge', text: give.rarity.name })),
        el('div', { class: 'kp-xinfo' },
          el('b', { text: give.name }),
          el('span', { class: 'kp-sub', text: [give.rarity && give.rarity.name, o.user && `par ${o.user.pseudo}`, expiresText(o.expiresAt)].filter(Boolean).join(' · ') }),
          owned && el('span', { class: 'kp-owned', text: owned.text, style: `color:${owned.color}` }),
          wished && el('span', { class: 'kp-wish-tag', text: '♥ Dans ta wishlist' })));

      const wanted = el('div', { class: 'kp-want' }, el('div', { class: 'kp-grid' }, (o.wantIds || []).map((wid) => {
        const card = cardInfo(wid);
        const qty = ownedQty(wid);
        const free = freeCopies(wid);
        return cardTile({
          id: String(wid),
          name: card.name,
          src: cardImage(wid),
          rarity: card.rarity,
          available: free > 0,
          qty: qty || null,
          action: stateText(free > 0 ? 'Tu peux la donner' : qty ? 'Tu l’as (pas libre)' : 'Tu ne l’as pas'),
        });
      })));

      const openButton = el('button', {
        type: 'button',
        class: 'btn btn-acc btn-sm',
        text: 'Ouvrir l’offre',
        title: 'Cherche cette carte dans la liste du site pour faire apparaître l’offre et ses boutons « Donner »',
        onClick: () => this.openWithSearch(o),
      });

      return el('li', { class: 'kp-xoffer' + (wished ? ' kp-wish' : '') },
        el('div', { class: 'kp-xtop' }, givenCard, el('div', { class: 'kp-xarrow', text: '⇄' }), wanted),
        el('div', { class: 'kp-xacts' }, openButton));
    },

    /** Bring a hidden offer into the site's real list by typing its card name in the site's search box. */
    openWithSearch(o) {
      const search = document.querySelector(SITE.search);
      if (!search) return;
      const card = cardInfo(o.characterId);
      search.value = card.known ? card.name : (o.user && o.user.pseudo) || '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));

      let tries = 0;
      const reveal = () => {
        const li = document.getElementById('offre-' + o.id);
        if (li) {
          li.scrollIntoView({ behavior: 'smooth', block: 'center' });
          li.classList.add('kp-flash');
          setTimeout(() => li.classList.remove('kp-flash'), 2500);
        } else if (++tries < 20) setTimeout(reveal, 150);
        else search.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      setTimeout(reveal, 150);
    },
  };

  /**
   * Collection page: lock / unlock each owned card in place (no need to open its wiki page).
   * A small 🔒 toggle next to the site's sell button / label, which stays as the site renders it.
   */
  const collectionLocks = {
    name: 'collectionLocks',
    busy: new Set(),
    /** Map<cardId, locked> confirmed by the server after our clicks (the site's icon only refreshes on reload). */
    confirmed: new Map(),

    queue: Promise.resolve(), // one lock at a time (the wiki frame is heavy)

    run() {
      if (!SITE.collectionPage.test(location.pathname)) return;
      document.querySelectorAll(SITE.collectionSlot).forEach((slot) => {
        const cell = slot.parentElement;
        const bar = cell.querySelector(`:scope > ${SITE.collectionBar}`);
        const id = wikiId(slot.getAttribute('href'));
        if (!id || !bar) return; // missing card: nothing to lock

        const locked = this.isLocked(id, slot);
        this.renderIcon(slot, locked);
        this.renderControl(bar, id, locked);
      });
    },

    /** The site's 🔒 icon on the card only refreshes on reload: show ours, driven by our state. */
    renderIcon(slot, locked) {
      const siteIcon = slot.querySelector(SITE.collectionLockIcon);
      if (siteIcon) setAttr(siteIcon, 'data-kp-hidden', '');
      const icon = slot.querySelector(':scope > .kp-lock-icon');
      if (locked && !icon) slot.appendChild(el('span', { class: 'kp-lock-icon', text: '🔒', title: 'Verrouillée' }));
      else if (!locked && icon) icon.remove();
    },

    /**
     * A small 🔒 toggle in the card's bar (.mk), next to the site's own element (sell button or label),
     * which is left untouched: it is used for other things than the lock (e.g. resale delay).
     */
    renderControl(bar, id, locked) {
      const busy = this.busy.has(id);
      let control = bar.querySelector(':scope > [data-kp-control]');
      if (!control) bar.appendChild(control = el('button', { type: 'button', class: 'kp-lock-mini', 'data-kp-control': '', onClick: () => this.toggle(id) }));
      setAttr(control, 'data-kp-busy', busy ? '' : null);
      setAttr(control, 'aria-pressed', String(locked));
      setText(control, busy ? '…' : '🔒');
      setAttr(control, 'title', locked
        ? 'Carte verrouillée : clique pour la déverrouiller'
        : 'Verrouiller cette carte : elle ne pourra plus être vendue, échangée ni recyclée');
    },

    /**
     * Source of truth: what the server confirmed after our last click, else the site's own 🔒 icon.
     * (The collection's `locked` field did not follow a confirmed lock in our tests: not used here.)
     */
    isLocked(id, slot) {
      if (this.confirmed.has(id)) return this.confirmed.get(id);
      return !!(slot && slot.querySelector(SITE.collectionLockIcon));
    },

    toggle(id) {
      if (this.busy.has(id)) return;
      this.busy.add(id);
      scheduleRender();
      this.queue = this.queue.then(() => this.applyToggle(id));
    },

    async applyToggle(id) {
      const slot = document.querySelector(`${SITE.collectionSlot}[href$="/wiki/${id}"]`);
      const locked = this.isLocked(id, slot);
      try {
        await setCardLock(id, !locked);
        this.confirmed.set(id, !locked);
        reloadCollection(); // refresh owned counts, in the background
      } catch (err) {
        warn('verrouillage impossible', err);
        alert(`Kyara Plus : impossible de ${locked ? 'déverrouiller' : 'verrouiller'} la carte (${err.message}).`);
      } finally {
        this.busy.delete(id);
        scheduleRender();
      }
    },
  };

  /**
   * Profile › trade window, « Cartes de <pseudo> » tab: « Ses doubles » chip after the site's chips.
   * The site's grid shows 60 cards at most, so filtering it is not enough: when on, the site's grid is hidden and
   * ours lists every card the player can trade in 2+ copies (n > 1 in /api/trades/available/<id>, read from the
   * site's own request, else fetched once). Clicking one of ours types its name in the site's search and clicks
   * the site's own tile, then restores the search. In memory only: off when the window closes.
   */
  const partnerDuplicates = {
    name: 'partnerDuplicates',
    on: false,
    busy: false,
    adding: null, // card id being added through the site's search
    userId: null,

    run() {
      const shelf = document.querySelector(SITE.tradeShelf);
      const profile = SITE.profilePage.exec(location.pathname);
      if (!shelf || !profile) { this.on = false; this.userId = null; return; }
      const userId = profile[1].toLowerCase();
      if (userId !== this.userId) { this.userId = userId; this.on = false; }

      const partnerShown = [...shelf.querySelectorAll(SITE.tradeTab)]
        .some((t) => t.getAttribute('aria-selected') === 'true' && SITE.partnerTab.test(t.textContent));
      const chips = shelf.querySelector(SITE.tradeChips);
      let chip = shelf.querySelector('[data-kp-dupes]');
      if (!partnerShown || !chips) {
        if (chip) chip.remove();
        return this.renderGrid(shelf, null);
      }

      const siteChips = [...chips.querySelectorAll(SITE.tradeChip)].filter((c) => !c.hasAttribute('data-kp-dupes'));
      if (!chip) {
        chip = el('button', {
          type: 'button',
          'data-kp-dupes': '',
          title: 'N’afficher que les cartes qu’il peut échanger en au moins 2 exemplaires',
          onClick: () => this.toggle(),
        }, 'Ses doubles', el('span', { class: 'kp-n' }));
        if (siteChips.length) siteChips[siteChips.length - 1].after(chip);
        else chips.prepend(chip);
      }
      const base = siteChips.length ? siteChips[0].className.replace(/\bon\b/g, '').replace(/\s+/g, ' ').trim() : '';
      setAttr(chip, 'class', this.on ? `${base} on` : base);
      setAttr(chip, 'aria-pressed', String(this.on));
      setAttr(chip, 'data-kp-busy', this.busy ? '' : null);

      const cards = state.tradeAvailable.get(userId);
      const count = cards ? [...cards.values()].filter((n) => n > 1).length : null;
      setText(chip.querySelector('.kp-n'), count === null ? '' : String(count));
      this.renderGrid(shelf, this.on && cards ? cards : null);
    },

    /** Card id of a site tile, from its image URL. */
    tileId(tile) {
      const img = tile.querySelector('img');
      return img && (SITE.cardImageId.exec(img.getAttribute('src') || '') || [])[1];
    },

    /** The site's own filters, applied to our grid too: « Je l’ai », « Il me manque », rarity chips. */
    siteFilters(shelf) {
      const chips = shelf.querySelector(SITE.tradeChips);
      const pressed = (re) => !!chips && [...chips.querySelectorAll(SITE.tradeChip)]
        .some((c) => !c.hasAttribute('data-kp-dupes') && c.getAttribute('aria-pressed') === 'true' && re.test(c.textContent));
      const rarities = chips ? [...chips.querySelectorAll(SITE.tradeRarityChip)]
        .filter((b) => b.classList.contains('on')).map((b) => rarityFromCode(b.textContent.trim())).filter(Boolean) : [];
      return { owned: pressed(SITE.tradeChipOwned), missing: pressed(SITE.tradeChipMissing), rarities };
    },

    /** Our grid of duplicates in place of the site's one (cards = null: back to the site's grid). */
    renderGrid(shelf, cards) {
      const siteGrid = shelf.querySelector(SITE.tradeGrid);
      let grid = shelf.querySelector('[data-kp-grid]');
      if (siteGrid) setAttr(siteGrid, 'data-kp-hidden', cards ? '' : null);
      if (!cards) { if (grid) grid.remove(); return; }

      // While adding a card, the search holds its name: keep filtering with the user's own query
      const search = shelf.querySelector(SITE.tradeSearch);
      const query = this.adding ? (grid && grid.dataset.kpQuery) || '' : ((search && search.value) || '').trim().toLowerCase();
      const filters = this.siteFilters(shelf);
      const known = !!state.collection; // without my collection, « Je l’ai » / « Il me manque » cannot be applied
      const dupes = [...cards].filter(([, n]) => n > 1);
      loadPrices(dupes.map(([id]) => id)); // once per card, re-renders when they arrive
      const list = dupes
        .map(([id, n]) => ({ id, n, owned: ownedQty(id) > 0, price: state.prices.has(id) ? priceText(state.prices.get(id)) : null, ...cardInfo(id) }))
        .filter((c) => !query || c.name.toLowerCase().includes(query))
        .filter((c) => !known || ((!filters.owned || c.owned) && (!filters.missing || !c.owned)))
        .filter((c) => !filters.rarities.length || filters.rarities.includes(c.rarity))
        .sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || a.name.localeCompare(b.name));
      const filtered = !!(query || filters.owned || filters.missing || filters.rarities.length);

      if (!grid) {
        grid = el('ul', { 'data-kp-grid': '' });
        const filters = shelf.querySelector(SITE.offerFilters);
        if (siteGrid) siteGrid.after(grid);
        else if (filters) filters.after(grid);
        else shelf.appendChild(grid);
      }
      setAttr(grid, 'class', siteGrid ? siteGrid.className : 'grid');

      const signature = [list.map((c) => `${c.id}:${c.n}:${known && c.owned}:${c.price || ''}`).join(','), state.catalog.size, query, filtered, this.adding].join('@');
      if (grid.dataset.kpSignature === signature) return;
      grid.dataset.kpSignature = signature;
      grid.dataset.kpQuery = query;

      // Same markup and classes as the site's tiles: img, .r, .nm, .lack, .pr, .have
      const cls = (sel, fallback) => (siteGrid && siteGrid.querySelector(`${SITE.tradeTile} ${sel}`)?.className) || fallback;
      const tileClass = (siteGrid && siteGrid.querySelector(SITE.tradeTile)?.className) || 'tile';
      grid.replaceChildren(...(list.length ? list.map((c) => el('li', { '--rc': rarityColor(c.rarity) },
        el('button', {
          type: 'button',
          class: tileClass + (this.adding === c.id ? ' kp-adding' : ''),
          'aria-label': `Ajouter ${c.name}`,
          title: c.known ? `Ajouter ${c.name}` : 'Nom inconnu : catalogue des cartes non chargé',
          onClick: () => this.add(shelf, c),
        },
        el('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', class: cls('img', ''), src: cardImage(c.id) }),
        c.rarity && el('span', { class: cls('.r', 'r'), text: RARITY_LETTERS[RARITIES.indexOf(c.rarity)] }),
        el('span', { class: cls('.nm', 'nm'), text: c.name }),
        known && !c.owned && el('span', { class: cls('.lack', 'lack'), text: 'Il me manque' }),
        c.price && el('span', { class: cls(SITE.tradeTilePrice, 'pr mono'), text: c.price }),
        el('span', { class: cls('.have', 'have'), text: `×${c.n} dispo` }))))
        : [el('li', { class: 'kp-trade-empty', text: filtered ? 'Aucun double ne correspond à tes filtres.' : 'Aucune carte en double à échanger.' })]));
    },

    /** Add a card to « Tu reçois »: bring it into the site's grid with its search, then click the site's tile. */
    async add(shelf, card) {
      if (this.adding) return;
      if (!card.known) return alert('Kyara Plus : nom de la carte inconnu (catalogue des cartes non chargé), impossible de la chercher.');
      const search = shelf.querySelector(SITE.tradeSearch);
      if (!search) return;
      const previous = search.value;
      const setSearch = (value) => { search.value = value; search.dispatchEvent(new Event('input', { bubbles: true })); };
      this.adding = card.id;
      scheduleRender();
      try {
        setSearch(card.name);
        const tile = await waitFor(() => [...shelf.querySelectorAll(`${SITE.tradeGrid} ${SITE.tradeTile}`)]
          .find((t) => this.tileId(t) === card.id), 3000);
        tile.click();
      } catch {
        warn('carte introuvable dans la liste du site :', card.name);
        alert(`Kyara Plus : « ${card.name} » n’apparaît pas dans la liste du site (un de ses filtres la cache peut-être).`);
      } finally {
        setSearch(previous);
        this.adding = null;
        scheduleRender();
      }
    },

    toggle() {
      this.on = !this.on;
      if (this.on && !this.busy && this.userId && (!state.tradeAvailable.has(this.userId) || !state.catalog.size || !state.collection)) {
        this.busy = true;
        const userId = this.userId;
        Promise.all([
          state.tradeAvailable.has(userId) ? true : loadTradeAvailable(userId),
          loadCatalog(),
          state.collection ? true : loadCollection(), // for « Il me manque » / « Je l’ai »
        ]).then(([cards, catalog, collection]) => {
          if (!cards) warn('impossible de charger les cartes échangeables du joueur');
          if (!catalog) warn('impossible de charger le catalogue des cartes');
          if (!collection) warn('impossible de charger ta collection');
        }).finally(() => { this.busy = false; scheduleRender(); });
      }
      scheduleRender();
    },
  };

  const RARITY_LETTERS = ['C', 'U', 'R', 'E', 'L', 'M'];

  /** Read an album button: { name, owned, total, rarities: { c: { owned, total }, … } }. */
  const albumCache = new WeakMap();
  function readAlbum(button) {
    const meta = button.querySelector(SITE.albumMeta)?.textContent || '';
    const cached = albumCache.get(button);
    if (cached && cached.meta === meta) return cached;
    const [, owned = 0, total = 0] = /(\d[\d\s]*)\s*\/\s*(\d[\d\s]*)/.exec(meta) || [];
    const rarities = {};
    for (const span of button.querySelectorAll(SITE.albumRarities)) {
      const m = /([CURELM])\s*(\d+)\s*\/\s*(\d+)/.exec(span.textContent);
      if (m) rarities[m[1].toLowerCase()] = { owned: +m[2], total: +m[3] };
    }
    const album = {
      meta,
      name: (button.querySelector(SITE.albumName)?.textContent || '').trim(),
      owned: +String(owned).replace(/\s/g, ''),
      total: +String(total).replace(/\s/g, ''),
      rarities,
    };
    albumCache.set(button, album);
    return album;
  }

  /**
   * Collection › Albums: filters (minimum album size, « il ne me manque que » rarities).
   * The site shows 120 albums per page: while a filter is active, « Afficher plus » is clicked until all are loaded.
   * Kept in memory only: no filter on every page load.
   */
  const albumFilters = {
    name: 'albumFilters',
    lastMoreClick: 0,
    current: { min: 0, miss: [] },

    settings() { return this.current; },
    save(patch) {
      this.current = { ...this.current, ...patch };
      scheduleRender();
    },
    reset() { this.current = { min: 0, miss: [] }; },
    isActive(s) { return s.min > 0 || s.miss.length > 0; },

    /**
     * With rarities checked, an album matches when the only cards it is missing are of those rarities
     * (check C → albums missing only commons; check C + R → albums missing only commons and/or rares).
     * Complete albums never match: they are missing nothing.
     */
    matches(album, s) {
      if (album.total < s.min) return false;
      if (!s.miss.length) return true;
      const missing = Object.keys(album.rarities).filter((letter) => album.rarities[letter].owned < album.rarities[letter].total);
      return missing.length > 0 && missing.every((letter) => s.miss.includes(letter));
    },

    run() {
      const list = document.querySelector(SITE.albumList);
      if (!list) return;
      const s = this.settings();
      const panel = this.renderPanel(s);

      let shown = 0, loaded = 0;
      for (const button of list.querySelectorAll(SITE.album)) {
        const item = button.closest('li') || button;
        const visible = !this.isActive(s) || this.matches(readAlbum(button), s);
        setAttr(item, 'data-kp-hidden', visible ? null : '');
        loaded++;
        if (visible) shown++;
      }

      // Load every page while filtering, else the filter only sees the first 120 albums
      const more = [...document.querySelectorAll(SITE.albumMore)].find((b) => /afficher plus/i.test(b.textContent));
      const loading = this.isActive(s) && !!more;
      if (loading) {
        if (Date.now() - this.lastMoreClick > 400) {
          this.lastMoreClick = Date.now();
          more.click();
        }
        setTimeout(scheduleRender, 450); // keep going even if the page does not change in between
      }
      if (panel) {
        setText(panel.querySelector('.kp-af-count'), this.isActive(s)
          ? `${plural(shown, 'album')} sur ${loaded}${loading ? ' · chargement…' : ''}`
          : `${plural(loaded, 'album')} chargés`);
      }
    },

    renderPanel(s) {
      const tools = document.querySelector(SITE.albumTools);
      if (!tools) return null;
      let panel = tools.querySelector(':scope > .kp-album-filters');
      if (!panel) {
        const rarityChips = RARITY_LETTERS.map((letter) => {
          const rarity = rarityFromCode(letter);
          return el('label', { class: 'kp-af-rar', '--kp-rc': rgbCss(rarity), title: `${rarity.name} : n’afficher que les albums où il ne te manque que les raretés cochées` },
            el('input', { type: 'checkbox', value: letter.toLowerCase(), onChange: () => this.saveFromPanel(panel) }),
            letter);
        });
        panel = el('div', { class: 'kp-album-filters' },
          el('label', { class: 'kp-af-group' },
            el('span', { class: 'kp-af-label', text: 'Min. cartes dans l’album' }),
            el('input', { class: 'kp-af-input', type: 'number', min: '0', step: '1', name: 'min', onInput: () => this.saveFromPanel(panel) })),
          el('span', { class: 'kp-af-group' },
            el('span', { class: 'kp-af-label', text: 'Il ne me manque que' }),
            rarityChips),
          el('button', { type: 'button', class: 'kp-af-reset', text: 'Réinitialiser', onClick: () => { this.reset(); this.syncPanel(panel, this.settings()); scheduleRender(); } }),
          el('span', { class: 'kp-af-count' }));
        tools.appendChild(panel);
        this.syncPanel(panel, s);
      }
      return panel;
    },

    /** Panel inputs <- saved settings (only when they differ, to keep the caret while typing). */
    syncPanel(panel, s) {
      const min = panel.querySelector('input[name="min"]');
      if (+min.value !== s.min || (s.min === 0 && min.value !== '')) min.value = s.min ? String(s.min) : '';
      for (const box of panel.querySelectorAll('input[type="checkbox"]')) box.checked = s.miss.includes(box.value);
    },

    saveFromPanel(panel) {
      this.save({
        min: Math.max(0, parseInt(panel.querySelector('input[name="min"]').value, 10) || 0),
        miss: [...panel.querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.value),
      });
    },
  };

  /**
   * Albums open in a new tab with a middle click (or Ctrl/Cmd + click).
   * Albums are buttons, not links: the new tab gets /collection#kp-album=<name>, and there
   * this feature switches to the Albums view, loads pages until it finds the album, and clicks it.
   */
  const albumTabs = {
    name: 'albumTabs',
    pending: null, // { name, since }
    lastMoreClick: 0,

    /** Installed once (see start): open the clicked album in a new tab. */
    install() {
      const albumOf = (e) => (e.target.closest ? e.target.closest(SITE.album) : null);
      const open = (button) => {
        const { name } = readAlbum(button);
        if (name) window.open(`/collection#${ALBUM_HASH}${encodeURIComponent(name)}`, '_blank');
      };
      // Middle button: prevent the autoscroll on mousedown, open on auxclick
      document.addEventListener('mousedown', (e) => { if (e.button === 1 && albumOf(e)) e.preventDefault(); }, true);
      document.addEventListener('auxclick', (e) => {
        const button = e.button === 1 && albumOf(e);
        if (!button) return;
        e.preventDefault();
        open(button);
      }, true);
      document.addEventListener('click', (e) => {
        const button = (e.ctrlKey || e.metaKey) && albumOf(e);
        if (!button) return;
        e.preventDefault();
        e.stopPropagation(); // keep this tab as it is
        open(button);
      }, true);
    },

    run() {
      if (!SITE.collectionPage.test(location.pathname)) return;
      if (!this.pending && location.hash.startsWith('#' + ALBUM_HASH)) {
        this.pending = { name: decodeURIComponent(location.hash.slice(1 + ALBUM_HASH.length)), since: Date.now() };
      }
      if (!this.pending) return;
      if (Date.now() - this.pending.since > 30000) { warn('album introuvable :', this.pending.name); this.pending = null; return; }

      const list = document.querySelector(SITE.albumList);
      if (!list) { // switch to the Albums view
        const albumsView = [...document.querySelectorAll(SITE.viewButtons)].find((b) => /^\s*albums\s*$/i.test(b.textContent));
        if (albumsView && albumsView.getAttribute('aria-pressed') !== 'true') albumsView.click();
        return this.retry();
      }
      const target = [...list.querySelectorAll(SITE.album)].find((b) => readAlbum(b).name === this.pending.name);
      if (target) {
        this.pending = null;
        history.replaceState(history.state, '', location.pathname + location.search); // drop the hash
        target.click();
        return;
      }
      const more = [...document.querySelectorAll(SITE.albumMore)].find((b) => /afficher plus/i.test(b.textContent));
      if (more && Date.now() - this.lastMoreClick > 400) { this.lastMoreClick = Date.now(); more.click(); }
      this.retry();
    },

    /** The page may not change while we wait: try again a bit later. */
    retry() { setTimeout(scheduleRender, 300); },
  };

  /** Sorts of a player's collection (cards from playerCollection.cards). */
  const rarityRank = (c) => RARITIES.indexOf(c.rarity);
  const PLAYER_SORTS = {
    rarity: { label: 'Rareté', compare: (a, b) => rarityRank(b) - rarityRank(a) || (b.price ?? -1) - (a.price ?? -1) },
    priceDesc: { label: 'Prix ↓', compare: (a, b) => (b.price ?? -1) - (a.price ?? -1) },
    priceAsc: { label: 'Prix ↑', compare: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) },
    copies: { label: 'Exemplaires', compare: (a, b) => (b.n || 0) - (a.n || 0) || rarityRank(b) - rarityRank(a) },
    name: { label: 'Nom', compare: (a, b) => a.name.localeCompare(b.name, 'fr') },
  };

  /**
   * Profile page: « Voir sa collection » button next to « Proposer un échange ». Opens a panel with every card the
   * player owns (/api/trades/owned/<id>, fetched when the profile opens): search by name or series, rarities,
   * duplicates, cards I am missing, median price range, sort. Copy counts come from /api/trades/available/<id>,
   * which only lists tradable cards: a locked card never shows as a duplicate. Filters in memory only.
   */
  const playerCollection = {
    name: 'playerCollection',
    userId: null,
    open: false,
    busy: false,
    requested: new Set(), // players whose card lists were fetched on this page load
    pricesFor: null, // player whose prices are being loaded
    filters: null,
    limit: PLAYER_PAGE,
    tiles: new Map(), // Map<cardId, { li, price, lack }> reused between renders (keeps the images loaded)
    onKey: null,

    defaults() { return { query: '', rarities: [], dupes: false, missing: false, min: '', max: '', sort: 'rarity' }; },

    run() {
      const profile = SITE.profilePage.exec(location.pathname);
      const userId = profile ? profile[1].toLowerCase() : null;
      if (userId !== this.userId) {
        this.close();
        this.userId = userId;
        this.filters = this.defaults();
        this.tiles = new Map();
      }
      if (!userId) return;
      this.load(userId);
      this.renderButton(userId);
      if (this.open) this.renderPanel(userId);
    },

    /** Both card lists of the player, once per page load (the site's own requests are read too). */
    load(userId) {
      if (this.requested.has(userId)) return;
      this.requested.add(userId);
      if (!state.tradeOwned.has(userId)) loadTradeOwned(userId).then((ok) => { if (!ok) warn('impossible de charger la collection du joueur'); });
      if (!state.tradeAvailable.has(userId)) loadTradeAvailable(userId);
    },

    pseudo() {
      const name = document.title.split(/\s[—–-]\s/)[0].trim();
      return name && !/^kyara$/i.test(name) ? name : 'ce joueur';
    },

    renderButton(userId) {
      let button = document.querySelector('[data-kp-collection]');
      const siteButton = [...document.querySelectorAll(SITE.profileButtons)]
        .find((b) => b !== button && !b.closest('[role="dialog"], .kp-pc-backdrop') && SITE.profileTradeButton.test(b.textContent));
      if (!siteButton) { if (button) button.remove(); return; }
      if (!button || button.previousElementSibling !== siteButton) {
        if (button) button.remove();
        button = el('button', { type: 'button', 'data-kp-collection': '', title: 'Voir toutes ses cartes, avec filtres', onClick: () => this.show() },
          'Voir sa collection', el('span', { class: 'kp-n' }));
        siteButton.after(button);
      }
      setAttr(button, 'class', siteButton.className);
      const owned = state.tradeOwned.get(userId);
      setText(button.querySelector('.kp-n'), owned ? String(owned.size) : '');
    },

    show() {
      this.open = true;
      this.limit = PLAYER_PAGE;
      if (!this.busy && (!state.catalog.size || !state.collection)) {
        this.busy = true;
        Promise.all([loadCatalog(), state.collection ? true : loadCollection()]).then(([catalog, collection]) => {
          if (!catalog) warn('impossible de charger le catalogue des cartes');
          if (!collection) warn('impossible de charger ta collection');
        }).finally(() => { this.busy = false; scheduleRender(); });
      }
      if (this.userId && !state.tradeOwned.has(this.userId)) { this.requested.delete(this.userId); this.load(this.userId); }
      scheduleRender();
    },

    close() {
      this.open = false;
      document.getElementById('kp-player-collection')?.remove();
      if (this.onKey) { document.removeEventListener('keydown', this.onKey, true); this.onKey = null; }
    },

    /** Owned cards of the player matching the filters, sorted. Null while the list is not loaded. */
    cards(userId) {
      const owned = state.tradeOwned.get(userId);
      if (!owned) return null;
      const available = state.tradeAvailable.get(userId) || null;
      const f = this.filters;
      const query = fold(f.query.trim());
      const min = f.min === '' ? null : +f.min;
      const max = f.max === '' ? null : +f.max;
      const rarities = f.rarities.map(rarityFromCode);
      return [...owned]
        .map((id) => ({ id, ...cardInfo(id), n: available ? available.get(id) || 0 : null, price: state.prices.get(id), mine: ownedQty(id) }))
        .filter((c) => !query || fold(c.name).includes(query) || fold(c.series).includes(query))
        .filter((c) => !rarities.length || rarities.includes(c.rarity))
        .filter((c) => !f.dupes || c.n > 1)
        .filter((c) => !f.missing || !state.collection || !c.mine)
        .filter((c) => (min === null && max === null) || (c.price !== undefined && (min === null || c.price >= min) && (max === null || c.price <= max)))
        .sort(PLAYER_SORTS[f.sort].compare);
    },

    renderPanel(userId) {
      let root = document.getElementById('kp-player-collection');
      if (!root) root = this.buildPanel();
      const owned = state.tradeOwned.get(userId);
      if (owned && this.pricesFor !== userId) { this.pricesFor = userId; loadPricesInTurn([...owned]); }

      const list = this.cards(userId);
      const available = state.tradeAvailable.get(userId);
      const priced = owned ? [...owned].filter((id) => state.prices.has(id)).length : 0;
      setText(root.querySelector('.kp-pc-count'), !owned ? 'chargement…'
        : `${list.length} / ${plural(owned.size, 'carte')}${priced < owned.size ? ` · prix ${priced}/${owned.size}` : ''}${this.busy ? ' · chargement…' : ''}`);

      const note = root.querySelector('.kp-pc-note');
      setAttr(note, 'data-kp-hidden', this.filters.dupes ? null : '');
      setText(note, available
        ? `⚠ Les cartes verrouillées par ${this.pseudo()} ne comptent pas : le site ne donne le nombre d’exemplaires que des cartes échangeables, une carte verrouillée en double n’apparaît donc pas ici.`
        : 'Chargement des exemplaires…');

      const grid = root.querySelector('.kp-pc-grid');
      const more = root.querySelector('.kp-pc-more');
      const shown = list ? list.slice(0, this.limit) : [];
      const signature = [shown.map((c) => c.id).join(','), list ? list.length : -1, state.catalog.size, state.collectionVersion, !!available].join('@');
      if (grid.dataset.kpSignature !== signature) {
        grid.dataset.kpSignature = signature;
        grid.replaceChildren(...(shown.length ? shown.map((c) => this.tile(c)) : [el('li', { class: 'kp-pc-empty', text: !list ? 'Chargement de sa collection…' : 'Aucune carte ne correspond à tes filtres.' })]));
      }
      for (const c of shown) setText(this.tiles.get(c.id).price, c.price !== undefined ? priceText(c.price) : '');
      const rest = list ? list.length - shown.length : 0;
      setAttr(more, 'data-kp-hidden', rest > 0 ? null : '');
      setText(more, `Afficher plus · ${plural(rest, 'carte')}`);
    },

    /** One card (built once per card and player, then reused). */
    tile(c) {
      const known = this.tiles.get(c.id);
      if (known && known.key === `${c.name}:${c.n}:${c.mine}`) return known.li;
      const price = el('span', { class: 'mono' });
      const locked = c.n === 0; // owned but not tradable: locked (or not tradable for another reason)
      const li = el('li', { class: 'kp-pc-card', '--kp-rc': rarityColor(c.rarity) },
        el('a', { href: `/wiki/${c.id}`, title: c.name + (c.rarity ? ` – ${c.rarity.name}` : '') },
          el('img', { src: cardImage(c.id), alt: c.name, loading: 'lazy', referrerpolicy: 'no-referrer' }),
          c.rarity && el('span', { class: 'kp-rar', text: RARITY_LETTERS[RARITIES.indexOf(c.rarity)] }),
          locked && el('span', { class: 'kp-pc-lock', text: '🔒', title: 'Pas échangeable (verrouillée ?) : son nombre d’exemplaires est inconnu' }),
          c.n > 1 && el('span', { class: 'kp-cnt kp-dup', text: `×${c.n}`, title: `${c.n} exemplaires échangeables` })),
        el('div', { class: 'kp-pc-name', text: c.name, title: c.name }),
        el('div', { class: 'kp-pc-series', text: c.series, title: c.series }),
        el('div', { class: 'kp-pc-meta' },
          price,
          state.collection && !c.mine ? el('span', { class: 'kp-pc-lack', text: 'Il me manque' }) : null));
      this.tiles.set(c.id, { li, price, key: `${c.name}:${c.n}:${c.mine}` });
      return li;
    },

    buildPanel() {
      const f = this.filters;
      const update = (patch) => { Object.assign(this.filters, patch); this.limit = PLAYER_PAGE; scheduleRender(); };
      const toggle = (key, label, title) => el('label', { class: 'kp-pc-toggle', title },
        el('input', { type: 'checkbox', checked: f[key], onChange: (e) => update({ [key]: e.target.checked }) }), label);
      const priceInput = (key, placeholder) => el('input', {
        class: 'kp-af-input', type: 'number', min: '0', step: '1', placeholder, value: f[key],
        onInput: (e) => update({ [key]: e.target.value.trim() }),
      });
      const rarityChips = RARITY_LETTERS.map((letter) => {
        const rarity = rarityFromCode(letter);
        return el('label', { class: 'kp-af-rar', '--kp-rc': rgbCss(rarity), title: rarity.name },
          el('input', { type: 'checkbox', checked: f.rarities.includes(letter), onChange: (e) => update({
            rarities: e.target.checked ? [...this.filters.rarities, letter] : this.filters.rarities.filter((l) => l !== letter),
          }) }),
          letter);
      });
      const sort = el('select', { class: 'kp-af-input', 'aria-label': 'Trier par', onChange: (e) => update({ sort: e.target.value }) },
        Object.entries(PLAYER_SORTS).map(([key, s]) => el('option', { value: key, selected: key === f.sort, text: s.label })));

      const root = el('div', { id: 'kp-player-collection', class: 'kp-pc-backdrop', onClick: (e) => { if (e.target === root) this.close(); } },
        el('section', { class: 'kp-pc', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Collection de ${this.pseudo()}` },
          el('header', { class: 'kp-pc-head' },
            el('h2', { text: `Collection de ${this.pseudo()}` }),
            el('span', { class: 'kp-pc-count' }),
            el('button', { type: 'button', class: 'kp-pc-close', 'aria-label': 'Fermer', text: '✕', onClick: () => this.close() })),
          el('div', { class: 'kp-pc-filters' },
            el('input', { class: 'kp-af-input', type: 'search', placeholder: 'Personnage ou série…', value: f.query, onInput: (e) => update({ query: e.target.value }) }),
            el('span', { class: 'kp-af-group' }, rarityChips),
            toggle('dupes', 'Doublons', 'N’afficher que les cartes qu’il peut échanger en au moins 2 exemplaires'),
            toggle('missing', 'Il me manque', 'N’afficher que les cartes que tu n’as pas'),
            el('span', { class: 'kp-af-group' },
              el('span', { class: 'kp-af-label', text: 'Prix médian' }),
              priceInput('min', 'min'), '–', priceInput('max', 'max'), '◆'),
            sort),
          el('p', { class: 'kp-pc-note', 'data-kp-hidden': '' }),
          el('div', { class: 'kp-pc-body' },
            el('ul', { class: 'kp-pc-grid' }),
            el('button', { type: 'button', class: 'kp-pc-more', 'data-kp-hidden': '', onClick: () => { this.limit += PLAYER_PAGE; scheduleRender(); } }))));
      document.body.appendChild(root);
      this.onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } };
      document.addEventListener('keydown', this.onKey, true);
      root.querySelector('input[type="search"]').focus();
      return root;
    },
  };

  const FEATURES = [chatToggle, marketChatTab, offerCards, duplicateFilter, offersRefresh, hiddenOffers, collectionLocks, albumFilters, albumTabs, partnerDuplicates, playerCollection];

  /* ==========================================================================
   * 9. CORE — render loop driven by DOM changes (the site is a Svelte SPA)
   * ======================================================================== */

  function render() {
    if (IN_FRAME || !document.head || !document.body) return;
    injectStyles();
    for (const feature of FEATURES) {
      try { feature.run(); } catch (err) { warn(`erreur dans ${feature.name}`, err); }
    }
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function start() {
    new MutationObserver(scheduleRender).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'disabled', 'aria-pressed', 'aria-selected'],
    });
    // Typing in the site's search box filters the list
    document.addEventListener('input', (e) => { if (e.target.matches?.(SITE.search)) scheduleRender(); }, true);
    // Client-side navigation
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function () { const result = original.apply(this, arguments); scheduleRender(); return result; };
    }
    window.addEventListener('popstate', scheduleRender);
    albumTabs.install();
    scheduleRender();
  }

  start();
})();
