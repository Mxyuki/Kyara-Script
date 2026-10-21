// ==UserScript==
// @name         Kyara Plus
// @namespace    https://github.com/Mxyuki/Kyara-Script
// @version      1.6.2
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
    myOffers: /\/api\/trades\/offers\/mine(\?|$)/, // my own exchange offers, same format as the board
    characters: /\/api\/[^?]*characters(\?|$)/,
    wishlist: /\/api\/[^?]*wish/i,
    tradeAvailable: /\/api\/trades\/available\/([0-9a-f-]+)(?:\?|$)/i, // a player's tradable cards [{ characterId, n }]
    tradeOwned: /\/api\/trades\/owned\/([0-9a-f-]+)(?:\?|$)/i, // every card a player owns: [4, 353, …] (ids only, no count)
    prices: /\/api\/fair-play\/prices\?/, // ?ids=1,2,3 -> { "<cardId>": price }
    myTrades: /\/api\/me\/trades(\?|$)/, // { incoming: [trade…], outgoing: [trade…] } (Mes échanges › Reçues / Envoyées)
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
    pinnedFriends: 'kp-pinned-friends', // [userId, …] friends pinned at the top of the friends list
    bangerMin: 'kp-banger-min', // Exchanges › « Offres Bangers »: minimum gain (◆), kept on reload as the user asked
  };
  // Filters (albums, player collection) are NOT stored: they reset on every page load.

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
    offerActs: '.acts', // the offer's buttons (our « Masquer » goes last)
    myOffer: 'li.offer.mine',
    board: 'section.board', // Échanges tab
    marketLayout: '.layout', // market grid: .col (tabs + panel) and aside.chat-side; our « Offres Bangers » column goes last
    search: '.filters input[type="search"]',
    activeFilter: '.filters [aria-pressed="true"]', // the site's own filter pills
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
    collectionMissing: '.miss', // missing card: « ? », number, rarity (instead of the card)
    collectionCard: '.tcg', // owned card: .tcg.r-<code> › .tcg-top (.tcg-name, .gem), .art (img, .art-k, .art-n), .tcg-type, .tcg-stats
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
    tradeChipMyDupes: /mes doubles/i, // my tab: only my duplicates
    tradeChipTheyLack: /il lui manque/i, // my tab: only the cards the partner does not own
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
    // Exchange offers: the site's « Donner <name> » buttons, and the thumb title of a card I own « <name> (tu l’as) »
    giveButton: /^\s*Donner\s+/,
    giveButtonCount: '.own', // « Donner <name> <span.own>×2</span> »: my copy count, not part of the name
    giveButtonCountText: /\s*×\s*\d+\s*$/, // same count, in case the span loses its class
    thumbOwnedTitle: /\s*\(tu l.as[^)]*\)\s*$/i,
    // Home page (boosters) › « Voir les N persos » dialog (« <booster> : les persos »): one section per rarity
    boosterSection: '[role="dialog"] section',
    boosterGem: 'h3 .gem', // class rk-<code>, e.g. « rk-M »
    boosterGemRarity: /\brk-([CURELM])\b/,
    boosterTitle: 'h3', // gem + « Mythique » + span.mono « 14/203 »
    boosterGrid: 'ul.grid',
    boosterTile: 'ul.grid > li > a.tile', // href …/wiki/<id>, img, span.q « ? » when missing, span.nm
    boosterMore: 'button.more', // « Voir 120 de plus · 143 restants » (60 cards shown at first)
    // Friends page (/amis), « Amis » tab: ul.people > li › a.who[href=/profil/<uuid>] (.wn b pseudo, small status) + span.acts
    friendsPage: /^\/amis/,
    friendsTab: '.tabs [role="tab"][aria-selected="true"]', // « Amis 21 », « Messages », « Demandes », « Ajouter »
    friendsTabName: /^\s*amis\b/i,
    friendsList: 'ul.people',
    friendLink: 'a.who',
    friendName: '.wn b',
    friendActs: '.acts', // « Message » link, « Retirer » button.btn, « Bloquer » button.link (our pin goes first)
    // Market › Mon activité › Mes échanges: .body[role=tabpanel] › p.sub, then one h2.h3 + ul.trades.scroll per list
    // (« Offres du tableau », « Reçues », « Envoyées »)
    myTradesPanel: '.body[role="tabpanel"]',
    myTradesList: 'ul.trades',
    myTradesHeading: 'h2',
    // Our switch buttons, in this order (matched on the heading's text); a list matching none comes last
    myTradesBoard: /tableau/i, // heading of « Offres du tableau »
    myTradesOrder: [/re[çc]ues/i, /envoy[ée]es/i, /tableau/i],
    // « Offres du tableau » list: li.trade › .th + .sides › .side (span.sk « Tu reçois » / « Tu donnes », .thumbs › a.thumb[href=/wiki/<id>][title=name])
    boardTrade: ':scope > li.trade',
    boardSide: '.sides > .side',
    boardSideLabel: '.sk',
    boardReceive: /re[çc]ois/i,
    boardThumb: 'a.thumb',
    marketSubtabs: '.subtabs[role="tablist"]', // « Mes ventes », « Mes enchères »…: our switch copies its look (class « on » = selected)
    // Expanded trade (« Détails ▾ »): .trays › section.tray[.mine = « Tu donnes »] › ul.slots > li › a.slot[href=/wiki/<id>], span.nm, span.pr
    // Reçues / Envoyées: li.trade › .th, .compact (.end › button.more « Détails ▾ ») or the details (direct button.more.less
    // « Réduire ▴ »), .tact › button.talk « 💬 Discuter » (+ span.cnt unread count)
    myTrade: ':scope > li.trade',
    myTradeId: /^echange-(.+)$/, // li id « echange-<trade id> » (same id as in /api/me/trades)
    myTradesIncoming: /re[çc]ues/i, // heading of the incoming list (the other one is outgoing)
    tradeMessage: '.tmsg', // p.tmsg « … » the trade's message (only when there is one)
    tradeMore: 'button.more', // the site's « Détails ▾ » / « Réduire ▴ » (aria-expanded)
    tradeTalk: '.tact button.talk',
    tradeTray: 'li.trade .trays .tray',
    tradeTrayHead: ':scope > header', // h3 « Tu donnes » / « Tu reçois » + span.total « ≈ 25 ◆ »
    tradeSlotItem: '.slots > li',
    tradeSlotLink: 'a.slot',
    tradeTrayMine: '.mine',
    // Accepting an exchange offer: div.back > [role=dialog] « Confirmer l’échange » › .cf-d checkbox « Ne plus demander pendant cette session »,
    // .cf-a buttons « Annuler » / « Confirmer l’échange » (.btn-acc)
    tradeConfirmDialog: '[role="dialog"][aria-label="Confirmer l’échange"]',
    tradeConfirmSkip: '.cf-d input[type="checkbox"]',
    tradeConfirmButton: '.cf-a .btn-acc',
    // Missions page: « Séries complètes » panel › header.c-head + ul.quests > li.q(.done.claimed) (.q-label series, .q-meta « 5 persos »)
    missionsPage: /^\/missions/,
    seriesPanel: 'section[aria-labelledby="albums-t"]',
    seriesHead: 'header.c-head',
    seriesItem: 'ul.quests > li.q',
    seriesClaimed: '.claimed', // reward taken; a completed series not claimed yet keeps its site button visible
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
  /** Rarities whose booster drops get their price, sorted from the most to the least expensive. */
  const BOOSTER_PRICED = ['M'];
  /** Exchanges › « Offres Bangers »: an offered card of this rarity or rarer, against a less rare card, is a banger. */
  const BANGER_RARITY = 'L';
  /** … and so is any offer worth at least this gain (◆, offered price − given price), changed by the user (STORAGE.bangerMin). */
  const BANGER_MIN_GAIN = 500;
  /** Max width of the site's centred content (.wrap, site CSS --wrap): the « Offres Bangers » column sits in the empty space on its right. */
  const SITE_WRAP_PX = 1280;
  /** Narrowest the column may be in that space; below, it becomes a column of the market's grid instead. */
  const BANGER_SIDE_MIN_PX = 240;
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
  /** Name comparison key: folded, letters and digits only (\u00ab Kurisu  Makise \u00bb = \u00ab kurisu makise \u00bb). */
  const nameKey = (text) => fold(text).replace(/[^\p{L}\p{N}]+/gu, '');
  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  const average = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

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

  /** « il y a 3 h », « il y a 2 j » (empty for an invalid date). */
  function agoText(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!(ms >= 0)) return '';
    const m = Math.floor(ms / 6e4), h = Math.floor(ms / 36e5), d = Math.floor(ms / 864e5);
    return d ? `il y a ${d} j` : h ? `il y a ${h} h` : m ? `il y a ${m} min` : 'à l’instant';
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
    /** Set<offerId> of my own exchange offers (/api/trades/offers/mine). */
    myOfferIds: new Set(),
    /** Map<userId, Map<cardId, n>>: tradable copies of other players (trade window). */
    tradeAvailable: new Map(),
    /** Map<userId, Set<cardId>>: every card of other players (profile › « Voir sa collection »). */
    tradeOwned: new Map(),
    /** Map<cardId, price> from /api/fair-play/prices (the site's requests and ours). */
    prices: new Map(),
    /** Map<tradeId, trade> from /api/me/trades (see parseMyTrades), or null until the site loads it. */
    myTrades: null,
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
      let id, name, rarity, series, native, num, pow, aura;
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
        ({ native, num, pow, aura } = e);
      }
      if (id === undefined || id === null) continue;
      const str = (v) => (typeof v === 'string' && v ? v : null);
      map.set(String(id), {
        name: str(name), rarity: rarityFromCode(rarity), series: str(series),
        native: str(native), num: str(num), pow: pow ?? null, aura: aura ?? null,
      });
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

  /** One side of a direct trade: { chakra, cards: [...] } -> { chakra, cards: [{ id, n, name, rarity }] } (same card merged). */
  function parseTradeSide(side) {
    const byId = new Map();
    for (const c of (side && Array.isArray(side.cards) ? side.cards : [])) {
      const id = entryId(c);
      if (!id) continue;
      const obj = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
      const inner = obj.character && typeof obj.character === 'object' ? obj.character : obj;
      const prev = byId.get(id) || { id, n: 0, name: null, rarity: null };
      prev.n += +(pick(obj, COUNT_KEYS) ?? obj.n) || 1;
      if (typeof inner.name === 'string') prev.name = inner.name;
      prev.rarity = prev.rarity || rarityFromCode(inner.rarity);
      byId.set(id, prev);
    }
    return { chakra: +(side && side.chakra) || 0, cards: [...byId.values()] };
  }

  /**
   * /api/me/trades -> Map<tradeId, trade>. Each raw trade: { id, from:{id,pseudo}, to, give:{chakra,cards}, want, message,
   * status, createdAt, expiresAt, messages }, `give` being what `from` gives. Seen from my side:
   * { id, incoming, other:{id,pseudo}, mine (what I give), theirs (what I receive), message, status, createdAt, expiresAt }.
   */
  function parseMyTrades(data) {
    if (!data || (!Array.isArray(data.incoming) && !Array.isArray(data.outgoing))) return null;
    const map = new Map();
    for (const [list, incoming] of [[data.incoming, true], [data.outgoing, false]]) {
      for (const t of list || []) {
        if (!t || !t.id) continue;
        const give = parseTradeSide(t.give), want = parseTradeSide(t.want);
        map.set(String(t.id), {
          id: String(t.id),
          incoming,
          other: (incoming ? t.from : t.to) || {},
          mine: incoming ? want : give,
          theirs: incoming ? give : want,
          message: typeof t.message === 'string' && t.message.trim() ? t.message.trim() : null,
          status: String(t.status || ''),
          createdAt: t.createdAt,
          expiresAt: t.expiresAt,
          sig: JSON.stringify(t),
        });
      }
    }
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
      match: API.myOffers,
      handle(data) {
        const list = findEntries(data);
        if (!list) return;
        state.myOfferIds = new Set(list.map((o) => o && o.id).filter(Boolean).map(String));
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
      match: API.myTrades,
      handle(data) {
        const trades = parseMyTrades(data);
        if (!trades) return warn('format des échanges non reconnu', data);
        state.myTrades = trades;
        const first = (data.incoming || []).concat(data.outgoing || []).map((t) => t && t.give && t.give.cards && t.give.cards[0]).find(Boolean);
        log('échanges reçus / envoyés :', trades.size, first ? `exemple de carte : ${JSON.stringify(first).slice(0, 200)}` : '');
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
    /* Offered card as tall as the « Donner » tiles next to it (--kp-give-h measured on the first tile) */
    li.offer[style*="--kp-give-h"] .give a.big img { height: var(--kp-give-h) !important; width: auto !important; object-fit: cover; }
    .kp-give-price { font-size: 12px; font-weight: 700; color: var(--fg2, #b7b2bd); }
    /* What accepting the offer with this card is worth: offered card's price − this card's price */
    .kp-delta {
      align-self: center; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor;
      font: 700 11px/1.4 system-ui, sans-serif; white-space: nowrap;
    }
    .kp-delta.kp-gain { color: ${COLORS.duplicate}; }
    .kp-delta.kp-loss { color: #ff6b5a; }
    .kp-delta.kp-even { color: var(--fg2, #b7b2bd); }
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
    .kp-pc-value { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); font-weight: 700; white-space: nowrap; }
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

    /* ---- Booster drops: price under each card, stats next to the rarity, most expensive first ---- */
    ul[data-kp-priced] > li { order: var(--kp-order, 0); }
    .kp-bprice { display: block; font-size: 11px; font-weight: 700; text-align: center; color: var(--fg2, #b7b2bd); }
    .kp-bstats { margin-left: 10px; font-size: 12px; font-weight: 600; color: var(--fg2, #b7b2bd); }

    /* ---- Friends: search + pinned friends first (separators drawn by the gap: borders break once reordered) ---- */
    ul[data-kp-friends] { display: flex; flex-direction: column; gap: 1px; background: #1e1c24; }
    ul[data-kp-friends] > li { order: var(--kp-order, 0); border-bottom: 0 !important; }
    ul[data-kp-friends] > li[data-kp-pinned] { box-shadow: inset 3px 0 0 ${COLORS.wishlist}; }
    .kp-fa { display: block; width: 1em; height: 1em; flex: none; }
    .kp-friends-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; max-width: 880px; margin: 0 0 12px; }
    .kp-friends-search {
      position: relative; flex: 1 1 260px; min-width: 0; display: flex; align-items: center;
      color: var(--mut, #8a8592); font-size: 14px;
    }
    .kp-friends-search .kp-fa { position: absolute; left: 14px; pointer-events: none; transition: color .15s; }
    .kp-friends-search input {
      width: 100%; height: 40px; padding: 0 14px 0 40px; border-radius: 12px; outline: none;
      border: 1px solid var(--line, #25232c); background: var(--bg2, #121117); color: var(--fg, #edeae4); font: inherit;
      transition: border-color .15s, box-shadow .15s;
    }
    .kp-friends-search input::placeholder { color: var(--mut, #8a8592); }
    .kp-friends-search input:focus { border-color: ${COLORS.wishlist}; box-shadow: 0 0 0 3px rgba(245,197,24,.15); }
    .kp-friends-search:focus-within .kp-fa { color: ${COLORS.wishlist}; }
    .kp-friends-count { font-size: 12px; color: var(--fg2, #b7b2bd); }
    .kp-pin {
      display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; flex: none; cursor: pointer;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent;
      color: var(--mut, #8a8592); font-size: 13px; transition: color .15s, border-color .15s, background .15s;
    }
    .kp-pin .kp-fa { transform: rotate(45deg); transition: transform .15s; }
    .kp-pin:hover { color: var(--fg, #edeae4); border-color: var(--fg2, #b7b2bd); }
    .kp-pin[aria-pressed="true"] { color: #111; background: ${COLORS.wishlist}; border-color: ${COLORS.wishlist}; }
    .kp-pin[aria-pressed="true"] .kp-fa { transform: none; }
    .kp-pin:focus-visible { outline: 2px solid ${COLORS.wishlist}; outline-offset: 2px; }
    .kp-friends-empty { flex: 1 0 100%; margin: 0; font-size: 13px; color: var(--fg2, #b7b2bd); }

    /* ---- Exchanges: « Masquer » an offer until the page is reloaded ---- */
    .kp-block {
      display: inline-flex; align-items: center; gap: 6px; height: 30px; margin-left: auto; padding: 0 12px; cursor: pointer;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent;
      color: var(--mut, #8a8592); font: 600 12px/1 inherit; transition: color .15s, border-color .15s;
    }
    .kp-block:hover { color: #ff6b5a; border-color: #ff6b5a; }
    .kp-block:focus-visible { outline: 2px solid #ff6b5a; outline-offset: 2px; }
    .kp-blocked {
      display: flex; align-items: center; gap: 10px; margin: 0 0 10px; padding: 8px 12px; border-radius: 12px;
      border: 1px solid var(--line, #25232c); background: var(--panel, #15141a); color: var(--fg2, #b7b2bd); font-size: 13px;
    }
    .kp-blocked-reset { margin-left: auto; height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; color: var(--fg, #edeae4); font: inherit; cursor: pointer; }
    .kp-blocked-reset:hover { border-color: ${COLORS.wishlist}; color: ${COLORS.wishlist}; }

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
    /* Missing cards drawn like owned ones: frame (rarity colour) slightly dimmed, content greyed out */
    .tcg.kp-ghost { filter: saturate(.6) brightness(.8); transition: filter .15s; }
    .tcg.kp-ghost > * { filter: grayscale(1) brightness(.75); opacity: .55; transition: opacity .15s, filter .15s; }
    a.slot:hover > .tcg.kp-ghost { filter: none; }
    a.slot:hover > .tcg.kp-ghost > * { filter: grayscale(.6) brightness(.8); opacity: .85; }
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

    /* ---- Mes échanges: one list at a time, full size, switched by our buttons ---- */
    [data-kp-trades] .trades.scroll { max-height: none; overflow: visible; }
    .kp-trades-switch { display: flex; flex-wrap: wrap; gap: 6px; }
    .kp-trades-switch button .kp-n { margin-left: 6px; opacity: .7; }
    .kp-trades-switch:not(.subtabs) button {
      height: 32px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent;
      color: var(--fg3, #c9c5ce); font: 700 13px/1 inherit; cursor: pointer;
    }
    .kp-trades-switch:not(.subtabs) button.on { border-color: ${COLORS.wishlist}; color: var(--fg, #edeae4); }
    /* Trade cards: one header row (who, status, buttons), then the summary or the details (CSS order, nodes never moved) */
    [data-kp-trades] li.trade { flex-flow: row wrap !important; align-items: center; gap: 10px !important; padding: 12px 14px !important; }
    [data-kp-trades] li.trade > * { flex: 1 1 100%; min-width: 0; order: 2; }
    [data-kp-trades] li.trade > .th { flex: 1 1 auto; order: 0; justify-content: flex-start !important; align-items: center; }
    [data-kp-trades] li.trade > .tact, [data-kp-trades] li.trade > .kp-more { flex: 0 0 auto; order: 1; margin: 0 !important; }
    /* The site's « Détails » / « Réduire » move between the summary and the bottom: ours stays in the header */
    [data-kp-trades] li.trade:has(> .kp-more) .more:not(.kp-more) { display: none !important; }
    .kp-more { display: inline-flex !important; align-items: center; gap: 6px; cursor: pointer; }
    .kp-more .kp-fa { font-size: 10px; transition: transform .15s; }
    .kp-more[aria-expanded="true"] .kp-fa { transform: rotate(180deg); }
    /* « Discuter »: icon only (the site's text stays for screen readers) */
    [data-kp-trades] li.trade .talk:has(> .kp-fa) {
      position: relative; display: inline-grid !important; place-items: center; width: 32px; height: 32px; padding: 0 !important;
      font-size: 0 !important; gap: 0;
    }
    [data-kp-trades] li.trade .talk > .kp-fa { width: 14px; height: 14px; }
    [data-kp-trades] li.trade .talk .cnt { position: absolute; top: -6px; right: -6px; margin: 0 !important; font-size: 10px; }
    [data-kp-trades] li.trade .compact {
      display: grid !important; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; align-items: center; gap: 8px 16px;
    }
    [data-kp-trades] li.trade .half {
      display: grid !important; grid-template-columns: auto 1fr; grid-template-areas: "k v" "mini mini"; align-items: center; gap: 6px 10px;
    }
    [data-kp-trades] li.trade .half > .k { grid-area: k; }
    [data-kp-trades] li.trade .half > .v { grid-area: v; justify-self: end; }
    [data-kp-trades] li.trade .half > .mini { grid-area: mini; flex-wrap: wrap; min-height: 42px; }
    [data-kp-trades] li.trade .compact > .end { flex-direction: column; align-items: flex-end; gap: 6px; margin: 0; text-align: right; }
    @media (max-width: 720px) {
      [data-kp-trades] li.trade .compact { grid-template-columns: minmax(0, 1fr); }
      [data-kp-trades] li.trade .compact > .sw { justify-self: center; transform: rotate(90deg); }
      [data-kp-trades] li.trade .compact > .end { flex-direction: row; justify-content: space-between; }
    }
    /* ---- Reçues / Envoyées: our card (from /api/me/trades) inside the site's li, its own buttons kept below ---- */
    [data-kp-trades] ul.trades > li[data-kp-pending] { order: -1; }
    [data-kp-trades] li.trade[data-kp-trade] { flex-flow: row wrap !important; align-items: center; gap: 10px 8px !important; padding: 14px 16px !important; }
    [data-kp-trades] li.trade[data-kp-pending] { border-color: color-mix(in srgb, var(--cyan, #4dd0e1) 55%, var(--line, #25232c)) !important; }
    [data-kp-trades] li.trade[data-kp-trade] > * { order: 3; flex: 1 1 100%; min-width: 0; }
    [data-kp-trades] li.trade[data-kp-trade] > :is(.th, .tmsg, .compact, .trays, .verdict, .more, .kp-more) { display: none !important; }
    [data-kp-trades] li.trade[data-kp-trade] > .kp-tr { order: 0; }
    [data-kp-trades] li.trade[data-kp-trade] > .kp-tr-foot { order: 1; flex: 1 1 auto; }
    [data-kp-trades] li.trade[data-kp-trade] > .tact { order: 2; flex: 0 0 auto; margin: 0 !important; }
    .kp-tr { display: flex; flex-direction: column; gap: 12px; }
    .kp-tr-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
    .kp-tr-av {
      display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 999px;
      background: var(--panel2, #17161d); border: 1px solid var(--line2, #2e2b36); font-weight: 800; font-size: 13px; text-transform: uppercase;
    }
    .kp-tr-who { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
    .kp-tr-who small { font-size: 11px; color: var(--mut, #8a8592); }
    .kp-tr-who a { color: var(--fg, #edeae4); font-weight: 800; text-decoration: none; }
    .kp-tr-who a:hover { text-decoration: underline; }
    .kp-tr-pills { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kp-tr-pill { padding: 3px 10px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .kp-tr-pill.kp-gain { color: ${COLORS.duplicate}; }
    .kp-tr-pill.kp-loss { color: #ff6b5a; }
    .kp-tr-pill.kp-even { color: var(--fg2, #b7b2bd); }
    .kp-st-pending { color: var(--cyan, #4dd0e1); }
    .kp-st-accepted { color: var(--U, ${COLORS.duplicate}); }
    .kp-st-declined { color: #ff6b5a; }
    .kp-st-other { color: var(--mut, #8a8592); }
    .kp-tr-body { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: stretch; }
    .kp-tr-swap { align-self: center; color: var(--acc, ${COLORS.wishlist}); font-size: 14px; }
    .kp-tr-side {
      display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px 12px; border-radius: 12px;
      background: var(--bg2, #121117); border: 1px solid var(--line, #25232c);
    }
    .kp-tr-side-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .kp-tr-side-head b { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--mut, #8a8592); }
    .kp-tr-value { font-size: 12px; font-weight: 700; color: var(--fg2, #b7b2bd); }
    .kp-tr-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(66px, 1fr)); gap: 8px; }
    .kp-tr-tile { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 0; }
    .kp-tr-card { position: relative; display: block; width: 100%; max-width: 76px; }
    .kp-tr-card img {
      display: block; width: 100%; aspect-ratio: 5 / 7; object-fit: cover; object-position: 50% 20%; border-radius: 8px;
      background: #1c1a23; outline: 2px solid var(--kp-rc); outline-offset: -2px;
    }
    .kp-tr-tile.kp-had img { opacity: .45; }
    .kp-tr-price { font-size: 11px; font-weight: 700; color: var(--fg2, #b7b2bd); white-space: nowrap; }
    .kp-tr-card .kp-cnt { right: 2px; bottom: 2px; padding: 0 4px; font-size: 9px; }
    .kp-tr-card .kp-tag-new { left: 2px; top: 2px; padding: 0 3px; font-size: 8px; }
    .kp-tr-n {
      position: absolute; right: 2px; top: 2px; padding: 0 4px; border-radius: 5px; font: 700 9px/1.4 system-ui, sans-serif;
      color: #fff; background: rgba(0,0,0,.7);
    }
    .kp-tr-chakra { font-size: 12px; font-weight: 700; color: ${COLORS.wishlist}; }
    .kp-tr-nothing { font-size: 12px; color: var(--mut, #8a8592); font-style: italic; }
    .kp-tr-note { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; font-weight: 700; }
    .kp-tr-note .kp-dup, .kp-tr-note .kp-new { color: ${COLORS.duplicate}; }
    .kp-tr-note .kp-single { color: ${COLORS.single}; }
    .kp-tr-note .kp-had { color: var(--fg2, #b7b2bd); }
    .kp-tr-msg { margin: 0; padding: 6px 12px; border-left: 3px solid var(--line2, #2e2b36); color: var(--fg2, #b7b2bd); font-size: 13px; font-style: italic; }
    .kp-tr-foot { font-size: 12px; color: var(--mut, #8a8592); }
    .kp-tr-foot .kp-soon { color: ${COLORS.single}; font-weight: 700; }
    @media (max-width: 720px) {
      .kp-tr-body { grid-template-columns: minmax(0, 1fr); }
      .kp-tr-swap { justify-self: center; transform: rotate(90deg); }
    }
    .kp-trades-switch .kp-pend {
      margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 800;
      color: #111; background: var(--cyan, #4dd0e1);
    }
    /* Details: compact trays, small tiles, long lists scroll inside their tray */
    [data-kp-trades] li.trade .trays { gap: 10px; }
    [data-kp-trades] li.trade .tray { gap: 8px; padding: 10px 12px; border-radius: 14px; }
    [data-kp-trades] li.trade .tray > header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 10px; }
    [data-kp-trades] li.trade .tray > header h3 { margin: 0; font-size: 14px; }
    [data-kp-trades] li.trade .slots {
      grid-template-columns: repeat(auto-fill, minmax(68px, 1fr)) !important; gap: 8px !important;
      max-height: 330px; overflow-y: auto; padding: 6px 4px 2px 0 !important; scrollbar-width: thin;
    }
    [data-kp-trades] li.trade .slots .nm { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    [data-kp-trades] li.trade .slots .pr { font-size: 10px; }
    [data-kp-trades] li.trade .verdict { margin: 0 !important; padding: 8px 12px !important; }
    [data-kp-trades] li.trade .verdict .v-h { font-size: 13px; }
    /* « Offres du tableau »: small squares (2 cards, their price, the gain or loss), several per row */
    [data-kp-trades] ul[data-kp-board]:not([data-kp-hidden]) { display: grid !important; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px !important; align-items: start; }
    [data-kp-trades] ul[data-kp-board] > li.trade { flex-flow: column nowrap !important; gap: 8px !important; padding: 10px !important; }
    [data-kp-trades] ul[data-kp-board] > li.trade > * { flex: none; order: 0; }
    [data-kp-board] li.trade > .th { font-size: 12px; flex-wrap: nowrap !important; justify-content: space-between !important; gap: 6px; }
    [data-kp-board] li.trade > .th > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-kp-board] li.trade > .th .st { padding: 2px 8px; font-size: 11px; }
    [data-kp-board] li.trade .sides { position: relative; grid-template-columns: 1fr 1fr !important; gap: 28px !important; }
    .kp-board-swap {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none;
      display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px;
      background: var(--panel2, #17161d); border: 1px solid var(--line2, #2e2b36); color: var(--acc, ${COLORS.wishlist}); font-size: 11px;
    }
    [data-kp-board] li.trade .side { align-items: center; gap: 4px !important; padding: 8px !important; text-align: center; }
    [data-kp-board] li.trade .side .sk { font-size: 11px; color: var(--mut, #8a8592); font-weight: 700; }
    [data-kp-board] li.trade .thumbs { justify-content: center; }
    [data-kp-board] li.trade .thumb img {
      width: 68px !important; height: 95px !important; border-radius: 8px !important;
      outline: 3px solid var(--kp-rc, transparent); outline-offset: -3px;
    }
    .kp-side-name { max-width: 100%; font-size: 11px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kp-side-price { font-size: 11px; color: var(--fg2, #b7b2bd); }
    .kp-board-diff { padding: 5px 8px; border-radius: 10px; background: var(--bg2, #121117); text-align: center; font-size: 13px; font-weight: 800; }
    .kp-board-diff.kp-gain { color: ${COLORS.duplicate}; }
    .kp-board-diff.kp-loss { color: #ff6b5a; }
    .kp-board-diff.kp-even { color: var(--fg2, #b7b2bd); }
    /* Details: my copies of each card */
    li.trade .slots a.slot { position: relative; }
    li.trade .slots li[data-kp-own-state="owned"] img { opacity: .55; }
    .kp-cnt.kp-had { background: var(--fg2, #b7b2bd); }
    .kp-tag-new {
      position: absolute; left: 3px; top: 3px; padding: 1px 5px; border-radius: 6px; pointer-events: none;
      font: 700 9px/1.3 system-ui, sans-serif; color: #111; background: ${COLORS.duplicate}; box-shadow: 0 1px 3px rgba(0,0,0,.6);
    }
    .kp-tray-sum { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; font-weight: 700; }
    .kp-tray-sum .kp-dup, .kp-tray-sum .kp-new { color: ${COLORS.duplicate}; }
    .kp-tray-sum .kp-single { color: ${COLORS.single}; }
    .kp-tray-sum .kp-had { color: var(--fg2, #b7b2bd); }

    /* ---- Missions: « Séries complètes » rolled up ---- */
    [data-kp-series-head] { cursor: pointer; user-select: none; }
    .kp-series-toggle {
      display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; flex: none; cursor: pointer;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent;
      color: var(--fg, #edeae4); font: 700 12px/1 inherit; transition: border-color .15s;
    }
    .kp-series-toggle:hover, [data-kp-series-head]:hover .kp-series-toggle { border-color: ${COLORS.wishlist}; }
    .kp-series-toggle:focus-visible { outline: 2px solid ${COLORS.wishlist}; outline-offset: 2px; }
    .kp-series-toggle .kp-fa { font-size: 11px; transition: transform .15s; }
    .kp-series-toggle[aria-expanded="true"] .kp-fa { transform: rotate(180deg); }

    /* ---- Exchanges › « Offres Bangers » column (#kp-bangers, last child of the market's .layout grid) ---- */
    /* Wide screens: fixed in the empty space right of the site's centred content (.wrap) */
    @media (width >= ${SITE_WRAP_PX + 2 * (BANGER_SIDE_MIN_PX + 32)}px) {
      .kp-bangers {
        position: fixed; z-index: 20; top: 84px; right: 16px; max-height: calc(100vh - 104px);
        width: min(420px, calc((100% - ${SITE_WRAP_PX}px) / 2 - 32px));
      }
    }
    /* Narrower: one more column in the market's grid */
    @media (1100px <= width < ${SITE_WRAP_PX + 2 * (BANGER_SIDE_MIN_PX + 32)}px) {
      .layout:has(> #kp-bangers) { grid-template-columns: minmax(0, 1fr) 340px !important; }
      html.kp-show-chat .layout:has(> #kp-bangers) { grid-template-columns: minmax(0, 1fr) 320px 320px !important; }
      .kp-bangers { position: sticky; top: 84px; max-height: calc(100vh - 104px); margin-bottom: 40px; }
    }
    @media (1400px <= width < ${SITE_WRAP_PX + 2 * (BANGER_SIDE_MIN_PX + 32)}px) {
      html.kp-show-chat .layout:has(> #kp-bangers) { grid-template-columns: minmax(0, 1fr) 360px 360px !important; }
    }
    /* Phones / small windows: above the market, scrolling inside */
    @media (width < 1100px) { .kp-bangers { order: -1; max-height: 440px; } }
    .kp-bangers {
      min-width: 0; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 10px; padding: 14px;
      border: 1px solid var(--line, #25232c); background: var(--panel, #15141a); border-radius: 14px; color: var(--fg, #edeae4);
    }
    .kp-bangers-head { display: flex; align-items: center; gap: 8px; }
    .kp-bangers-head h3 { margin: 0; font-size: 16px; }
    .kp-bangers-n {
      margin-left: auto; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 700;
      background: var(--panel2, #17161d); color: ${COLORS.wishlist}; border: 1px solid var(--line2, #2e2b36);
    }
    .kp-bangers-help { margin: 0; font-size: 12px; color: var(--mut, #8b8794); }
    .kp-bangers-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg2, #b7b2bd); }
    .kp-bangers-min {
      width: 110px; height: 34px; padding: 0 10px; border-radius: 10px; box-sizing: border-box;
      border: 1px solid var(--line2, #2e2b36); background: var(--panel2, #17161d); color: var(--fg, #edeae4); font: inherit;
    }
    .kp-bangers-min:focus { outline: none; border-color: ${COLORS.wishlist}; }
    .kp-bangers-empty { margin: 0; font-size: 13px; color: var(--mut, #8b8794); }
    .kp-bangers-empty:empty { display: none; }
    .kp-bangers-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; }
    .kp-banger {
      position: relative; display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px;
      border: 1px solid var(--line, #25232c); background: var(--panel2, #17161d);
    }
    .kp-banger-cards { display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 30px; }
    /* « Voir »: eye icon in the trade's top right corner */
    .kp-banger-see {
      position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
      border-radius: 999px; border: 1px solid var(--line2, #2e2b36); background: transparent; color: var(--fg2, #b7b2bd);
      font-size: 13px; cursor: pointer; transition: color .15s, border-color .15s;
    }
    .kp-banger-see:hover { color: ${COLORS.wishlist}; border-color: ${COLORS.wishlist}; }
    .kp-banger-see:focus-visible { outline: 2px solid ${COLORS.wishlist}; outline-offset: 2px; }
    .kp-banger-cards > .kp-fa { color: var(--mut, #8b8794); font-size: 12px; }
    .kp-bthumb { position: relative; flex: none; display: block; }
    .kp-bthumb img {
      display: block; width: 64px; height: 90px; object-fit: cover; object-position: 50% 20%;
      border-radius: 7px; outline: 3px solid var(--kp-rc); outline-offset: -3px;
    }
    .kp-bthumb .kp-fa { position: absolute; top: -5px; right: -5px; font-size: 10px; padding: 4px; border-radius: 999px; background: #111; color: ${COLORS.single}; }
    .kp-banger-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; margin-left: 4px; font-size: 12px; color: var(--fg2, #b7b2bd); }
    .kp-banger-info > * { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kp-banger-info b { font-size: 13px; color: var(--fg, #edeae4); }
    .kp-banger-info .kp-sub { color: var(--mut, #8b8794); font-size: 11px; }
    .kp-banger-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kp-banger-tags .kp-cnt { position: static; transform: none; }
    .kp-banger-up { padding: 1px 8px; border-radius: 999px; font: 700 11px/1.4 system-ui, sans-serif; color: #111; background: var(--kp-rc); }
    .kp-banger-lock { display: inline-flex; align-items: center; gap: 4px; font: 700 11px/1.4 system-ui, sans-serif; color: ${COLORS.single}; }
    .kp-banger-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kp-banger .kp-give { width: 100%; height: 28px; min-height: 0; padding: 0 14px; font-size: 12px; }
    .kp-banger-sec { background: transparent; border: 1px solid var(--line2, #2e2b36); color: var(--fg, #edeae4); }
    .kp-banger-msg { flex-basis: 100%; font-size: 12px; color: var(--fg2, #b7b2bd); }
    .kp-banger-msg.kp-err { color: #ff6b5a; }

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
  function cardTile({ id, name, src, rarity, available, qty, onOpen, action, delta }) {
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
      delta !== undefined && deltaPill(delta),
      action);
  }

  /**
   * « +120 ◆ » / « −40 ◆ »: what giving this card for the offered one is worth (median prices).
   * null = prices still loading.
   */
  function deltaPill(delta) {
    if (delta === null) return el('span', { class: 'kp-delta kp-even mono', text: '… ◆' });
    return el('span', {
      class: `kp-delta mono ${delta > 0 ? 'kp-gain' : delta < 0 ? 'kp-loss' : 'kp-even'}`,
      title: 'Ce que tu gagnes (ou perds) si tu donnes cette carte : prix médian de la carte offerte − prix médian de celle-ci',
      text: delta > 0 ? `+${priceText(delta)}` : delta < 0 ? `−${priceText(-delta)}` : '= 0 ◆',
    });
  }

  /** Offered card's price − given card's price, rounded; null while one of them is unknown. */
  function tradeDelta(offeredId, givenId) {
    const a = state.prices.get(String(offeredId)), b = state.prices.get(String(givenId));
    return a === undefined || b === undefined ? null : Math.round(a - b);
  }

  /**
   * Sort of an offer's wanted cards, most valuable to give first: the cheapest one is the one whose
   * gain (offered price − its price) is the highest. Unknown prices last, in the site's order.
   */
  function cheapestFirst(a, b) {
    const price = (id) => (state.prices.has(String(id)) ? state.prices.get(String(id)) : Infinity);
    const pa = price(a), pb = price(b);
    return pa === pb ? 0 : pa - pb;
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

  /** Font Awesome 6 Free solid icons (CC BY 4.0, fontawesome.com), drawn inline: the site has no icon font. */
  const FA_ICONS = {
    thumbtack: ['0 0 384 512', 'M32 32C32 14.3 46.3 0 64 0H320c17.7 0 32 14.3 32 32s-14.3 32-32 32H290.5l11.4 148.2c36.7 19.9 65.7 53.2 79.5 94.7l1 3c3.3 9.8 1.6 20.5-4.4 28.8s-15.7 13.3-26 13.3H32c-10.3 0-19.9-4.9-26-13.3s-7.7-19.1-4.4-28.8l1-3c13.8-41.5 42.8-74.8 79.5-94.7L93.5 64H64C46.3 64 32 49.7 32 32zM160 384h64v96c0 17.7-14.3 32-32 32s-32-14.3-32-32V384z'],
    eye: ['0 0 576 512', 'M288 32c-80.8 0-145.5 36.8-192.6 80.6C48.6 156 17.3 208 2.5 243.7c-3.3 7.9-3.3 16.7 0 24.6C17.3 304 48.6 356 95.4 399.4C142.5 443.2 207.2 480 288 480s145.5-36.8 192.6-80.6c46.8-43.5 78.1-95.4 93-131.1c3.3-7.9 3.3-16.7 0-24.6c-14.9-35.7-46.2-87.7-93-131.1C433.5 68.8 368.8 32 288 32zM144 256a144 144 0 1 1 288 0 144 144 0 1 1 -288 0zm144-64c0 35.3-28.7 64-64 64c-7.1 0-13.9-1.2-20.3-3.3c-5.5-1.8-11.9 1.6-11.7 7.4c.3 6.9 1.3 13.8 3.2 20.7c13.7 51.2 66.4 81.6 117.6 67.9s81.6-66.4 67.9-117.6c-11.1-41.5-47.8-69.4-88.6-71.1c-5.8-.2-9.2 6.1-7.4 11.7c2.1 6.4 3.3 13.2 3.3 20.3z'],
    eyeSlash: ['0 0 640 512', 'M38.8 5.1C28.4-3.1 13.3-1.2 5.1 9.2S-1.2 34.7 9.2 42.9l592 464c10.4 8.2 25.5 6.3 33.7-4.1s6.3-25.5-4.1-33.7L525.6 386.7c39.6-40.6 66.4-86.1 79.9-118.4c3.3-7.9 3.3-16.7 0-24.6c-14.9-35.7-46.2-87.7-93-131.1C465.5 68.8 400.8 32 320 32c-68.2 0-125 26.3-169.3 60.8L38.8 5.1zM223.1 149.5C248.6 126.2 282.7 112 320 112c79.5 0 144 64.5 144 144c0 24.9-6.3 48.3-17.4 68.7L408 294.5c8.4-19.3 10.6-41.4 4.8-63.3c-11.1-41.5-47.8-69.4-88.6-71.1c-5.8-.2-9.2 6.1-7.4 11.7c2.1 6.4 3.3 13.2 3.3 20.3c0 10.2-2.4 19.8-6.6 28.3l-90.3-70.8zM373 389.9c-16.4 6.5-34.3 10.1-53 10.1c-79.5 0-144-64.5-144-144c0-6.9 .5-13.6 1.4-20.2L83.1 161.5C60.3 191.2 44 220.8 34.5 243.7c-3.3 7.9-3.3 16.7 0 24.6c14.9 35.7 46.2 87.7 93 131.1C174.5 443.2 239.2 480 320 480c47.8 0 89.9-12.9 126.2-32.5L373 389.9z'],
    arrowRightArrowLeft: ['0 0 448 512', 'M438.6 150.6c12.5-12.5 12.5-32.8 0-45.3l-96-96c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L338.7 96 32 96C14.3 96 0 110.3 0 128s14.3 32 32 32l306.7 0-41.4 41.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l96-96zm-333.3 352c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L109.3 416 416 416c17.7 0 32-14.3 32-32s-14.3-32-32-32l-306.7 0 41.4-41.4c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-96 96c-12.5 12.5-12.5 32.8 0 45.3l96 96z'],
    comment: ['0 0 512 512', 'M512 240c0 114.9-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9c-11.9 8.7-31.3 20.6-54.3 30.6C73.6 471.1 44.7 480 16 480c-6.5 0-12.3-3.9-14.8-9.9c-2.5-6-1.1-12.8 3.4-17.4l.3-.3c.3-.3 .7-.7 1.3-1.4c1.1-1.2 2.8-3.1 4.9-5.7c4.1-5 9.6-12.4 15.2-21.6c10-16.6 19.5-38.4 21.4-62.9C17.7 326.8 0 285.1 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208z'],
    chevronDown: ['0 0 448 512', 'M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z'],
    lock: ['0 0 448 512', 'M144 144v48H304V144c0-44.2-35.8-80-80-80s-80 35.8-80 80zM80 192V144C80 64.5 144.5 0 224 0s144 64.5 144 144v48h16c35.3 0 64 28.7 64 64V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V256c0-35.3 28.7-64 64-64H80z'],
    search: ['0 0 512 512', 'M416 208c0 45.9-14.9 88.3-40 122.7L502.6 457.4c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0L330.7 376c-34.4 25.2-76.8 40-122.7 40C93.1 416 0 322.9 0 208S93.1 0 208 0S416 93.1 416 208zM208 352a144 144 0 1 0 0-288 144 144 0 1 0 0 288z'],
  };

  /** <svg class="kp-fa"> of a FA_ICONS icon, sized by the font size and coloured by `color`. */
  function faIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const [viewBox, d] = FA_ICONS[name];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('class', `kp-fa kp-fa-${name}`);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
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

  /**
   * Full sort key of an offer (lower first): offerOrder, then inside the same group the most profitable first.
   * best = best gain among the cards I can give (offered price − given price), null while prices load,
   * undefined when I can give none (last of the group).
   */
  function offerSortKey(wish, rarity, best) {
    const tail = best === undefined ? 4.9e6 : best === null ? 4.5e6 : Math.max(-4e6, Math.min(4e6, -best));
    return offerOrder(wish, rarity) * 1e7 + Math.round(tail);
  }

  /** Best gain among the given deltas (undefined when none, null when one is still loading and none is known). */
  function bestDelta(deltas) {
    const known = deltas.filter((d) => typeof d === 'number');
    if (known.length) return Math.max(...known);
    return deltas.length ? null : undefined;
  }

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
        .find((p) => !p.hasAttribute('data-kp-refresh') && SITE.myOffersPill.test(p.textContent));
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
      return [...document.querySelectorAll(SITE.offerPill)].filter((p) => !p.hasAttribute('data-kp-refresh'));
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

  /** The site's « Donner <name> » buttons of an offer. */
  const siteGiveButtons = (offer) => [...offer.querySelectorAll(SITE.offerActionButtons)].filter((b) => SITE.giveButton.test(b.textContent));

  /** Name in a « Donner <name> » button, as a nameKey. The site appends my copy count (« ×2 ») inside it: left out. */
  function giveButtonKey(button) {
    return nameKey([...button.childNodes]
      .filter((n) => !(n.nodeType === 1 && n.matches(SITE.giveButtonCount)))
      .map((n) => n.textContent).join('')
      .replace(SITE.giveButton, '').replace(SITE.giveButtonCountText, ''));
  }

  /** Exchange offers rendered by the site: rarity, owned counts, tile grid with one "Donner" per card, wishlist. */
  const offerCards = {
    name: 'offerCards',
    run() {
      document.querySelectorAll(SITE.offer).forEach((offer) => {
        this.decorateGivenCard(offer);
        this.renderGrid(offer);
        this.markWishlist(offer);
        this.matchGivenHeight(offer);
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

      const id = wikiId(link.getAttribute('href'));
      if (info && state.collection) {
        const { text, color } = ownedLabel(ownedQty(id));
        let owned = info.querySelector(':scope > .kp-owned');
        if (!owned) info.appendChild(owned = el('span', { class: 'kp-owned' }));
        setText(owned, text);
        if (owned.style.color !== color) owned.style.color = color;
      }
      if (info && id) {
        let price = info.querySelector(':scope > .kp-give-price');
        if (!price) info.appendChild(price = el('span', { class: 'kp-give-price mono', title: 'Prix médian de la carte offerte' }));
        setText(price, state.prices.has(id) ? `≈ ${priceText(state.prices.get(id))}` : '… ◆');
      }
    },

    /** The offered card takes the height of the first « Donner » tile (re-measured on every render and on resize). */
    matchGivenHeight(offer) {
      const tile = offer.querySelector(`${SITE.offerWant} .kp-grid > .kp-tile`);
      const h = tile ? tile.offsetHeight : 0;
      const value = h ? `${h}px` : '';
      if (offer.style.getPropertyValue('--kp-give-h') === value) return;
      if (value) offer.style.setProperty('--kp-give-h', value);
      else offer.style.removeProperty('--kp-give-h');
    },

    renderGrid(offer) {
      const want = offer.querySelector(SITE.offerWant);
      const thumbs = want && want.querySelector(SITE.offerThumbs);
      const links = thumbs ? [...thumbs.querySelectorAll(SITE.offerThumb)] : [];
      if (!links.length) return;

      // The site's "Donner <name>" buttons, matched to the thumbs by name (in order, for duplicates).
      // Names are compared loosely (case, accents, spaces, punctuation): an exact match missed some buttons.
      const giveButtons = siteGiveButtons(offer);
      const buttonKey = giveButtonKey;

      const cards = links.map((a) => {
        const img = a.querySelector('img');
        const name = (img && img.alt) || (a.title || '').replace(SITE.thumbOwnedTitle, '');
        const i = giveButtons.findIndex((b) => buttonKey(b) === nameKey(name));
        const button = i >= 0 ? giveButtons.splice(i, 1)[0] : null;
        const id = wikiId(a.getAttribute('href'));
        const siteHave = a.classList.contains('have') || SITE.thumbOwnedTitle.test(a.title || '');
        return { a, img, id, name, siteHave, button, rarity: img && rarityFromImg(img) };
      });
      // A button whose name matched no thumb: pair it only when there is no doubt (one button, one owned thumb left),
      // else it stays visible in the site's own buttons (a wrong pairing would give the wrong card)
      const orphans = cards.filter((c) => !c.button && (c.siteHave || ownedQty(c.id) > 0));
      if (giveButtons.length === 1 && orphans.length === 1) orphans[0].button = giveButtons.pop();
      if (giveButtons.length) this.warnUnmatched(offer, giveButtons);

      const offeredId = wikiId(offer.querySelector(SITE.offerGiveLink)?.getAttribute('href'));
      if (offeredId) loadPrices([offeredId, ...cards.map((c) => c.id).filter(Boolean)]); // once per card
      for (const c of cards) {
        // The site shows a « Donner » button: I own it, even if our collection is stale
        c.have = c.siteHave || !!c.button;
        c.qty = c.have ? ownedQty(c.id) || null : null;
        if (c.have && state.collection && !ownedQty(c.id)) this.collectionStale();
        c.delta = c.have && offeredId ? tradeDelta(offeredId, c.id) : undefined;
      }
      cards.sort((a, b) => cheapestFirst(a.id, b.id)); // the card that brings the most on the left
      // Most profitable card I can give (a « Donner » button), for the order of the offers
      this.best.set(offer, bestDelta(cards.filter((c) => c.button && c.delta !== undefined).map((c) => c.delta)));

      const signature = state.collectionVersion + '@' + cards.map((c) =>
        [c.id, c.img && c.img.src, c.have, c.button ? (c.button.disabled ? 'd' : 'b') : '', c.rarity && c.rarity.name, c.qty, c.delta].join('|')).join('#');

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
        delta: c.delta,
        onOpen: () => c.a.click(), // let the site's router navigate
        action: c.button ? this.giveButton(c) : stateText(c.have ? 'Tu l’as (pas libre)' : 'Tu ne l’as pas'),
      })));
      thumbs.setAttribute('data-kp-hidden', '');
    },

    /** Log once per offer the site buttons we could not pair with a card (to fix the matching from the markup). */
    warned: new Set(),
    warnUnmatched(offer, buttons) {
      if (this.warned.has(offer.id)) return;
      this.warned.add(offer.id);
      warn('bouton « Donner » sans carte correspondante, laissé visible :', buttons.map((b) => b.textContent.trim()), offer.outerHTML.slice(0, 3000));
    },

    /** The site says I own a card my collection does not have (new card since the page loaded): reload it, a few times at most. */
    staleReloads: 0,
    lastStaleReload: 0,
    collectionStale() {
      if (this.staleReloads >= 3 || Date.now() - this.lastStaleReload < 30000) return;
      this.staleReloads++;
      this.lastStaleReload = Date.now();
      log('collection en retard sur le site : rechargement');
      loadCollection();
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

    /** WeakMap<offer li, best gain> filled by renderGrid (see bestDelta). */
    best: new WeakMap(),

    /**
     * data-kp-wish "2" = in wishlist and you can accept it now, "1" = in wishlist. Also sets the display order:
     * wishlist, rarity, then the most profitable offer first (offerSortKey).
     */
    markWishlist(offer) {
      const link = offer.querySelector(SITE.offerGiveLink);
      const info = offer.querySelector(SITE.offerGiveInfo);
      if (!link || !info) return;
      const wished = inWishlist(wikiId(link.getAttribute('href')));
      const wish = wished ? (offer.querySelector('.kp-give') ? 2 : 1) : 0;
      setAttr(offer, 'data-kp-wish', wish ? String(wish) : null);
      const img = link.querySelector('img');
      const order = String(offerSortKey(wish, img && rarityFromImg(img), this.best.get(offer)));
      if (offer.style.getPropertyValue('--kp-order') !== order) offer.style.setProperty('--kp-order', order);
      const tag = info.querySelector(':scope > .kp-wish-tag');
      if (wished && !tag) info.appendChild(el('span', { class: 'kp-wish-tag', text: '♥ Dans ta wishlist' }));
      else if (!wished && tag) tag.remove();
    },
  };

  /**
   * Exchanges: « Masquer » button on every offer (site's and hidden ones). A masked offer never shows again until
   * the page is reloaded (F5): kept in memory only, so it survives our refresh button but not a real reload.
   * A bar above the list counts them, with « Tout réafficher ».
   */
  const blockedOffers = {
    name: 'blockedOffers',
    ids: new Set(), // offer ids (the site's li id is « offre-<id> »)

    run() {
      const list = document.querySelector(SITE.offerList);
      for (const offer of document.querySelectorAll(`${SITE.offer}[id^="offre-"]`)) {
        const id = offer.id.slice('offre-'.length);
        setAttr(offer, 'data-kp-hidden', this.ids.has(id) ? '' : null);
        const acts = offer.querySelector(SITE.offerActs);
        if (acts && !acts.querySelector(':scope > [data-kp-block]')) acts.appendChild(this.button(id));
      }
      this.renderBar(list);
    },

    button(id) {
      return el('button', {
        type: 'button', class: 'kp-block', 'data-kp-block': '',
        title: 'Masquer cet échange (il revient quand tu recharges la page)',
        onClick: () => { this.ids.add(id); scheduleRender(); },
      }, faIcon('eyeSlash'), 'Masquer');
    },

    renderBar(list) {
      let bar = document.getElementById('kp-blocked');
      if (!list || !this.ids.size) { if (bar) bar.remove(); return; }
      if (!bar || bar.nextElementSibling !== list) {
        if (bar) bar.remove();
        bar = el('div', { id: 'kp-blocked', class: 'kp-blocked' },
          faIcon('eyeSlash'),
          el('span', { class: 'kp-blocked-n' }),
          el('button', { type: 'button', class: 'kp-blocked-reset', text: 'Tout réafficher', onClick: () => { this.ids.clear(); scheduleRender(); } }));
        list.before(bar);
      }
      const s = this.ids.size > 1 ? 's' : '';
      setText(bar.querySelector('.kp-blocked-n'), `${this.ids.size} échange${s} masqué${s} jusqu’au rechargement de la page`);
    },
  };

  /** Offers the server sends but the site does not display (it caps its list at 120). */
  const hiddenOffers = {
    name: 'hiddenOffers',
    collectionAsked: false,
    run() {
      const list = document.querySelector(SITE.offerList);
      if (!list || !state.serverOffers.length || this.filtersActive()) return this.clear();
      if (!state.collection && !this.collectionAsked) { this.collectionAsked = true; loadCollection(); } // to know which cards I can give

      const shown = new Set([...list.querySelectorAll(`${SITE.offer}[id^="offre-"]`)].map((li) => li.id.slice('offre-'.length)));
      if (!shown.size) return this.clear();

      const canGive = (o) => (o.wantIds || []).some((w) => freeCopies(w) > 0);
      const missing = state.serverOffers.filter((o) => !shown.has(o.id) && !blockedOffers.ids.has(o.id));
      const ids = missing.flatMap((o) => [o.characterId, ...(o.wantIds || [])]).map(String);
      loadPrices(ids); // for the gain / loss of each card I can give (once per card)
      // Same order as the site's list: wishlist, rarity, then the most profitable first
      const rank = (o) => offerSortKey(inWishlist(o.characterId) ? (canGive(o) ? 2 : 1) : 0, cardInfo(o.characterId).rarity,
        bestDelta((o.wantIds || []).filter((w) => freeCopies(w) > 0).map((w) => tradeDelta(o.characterId, w))));
      missing.sort((a, b) => rank(a) - rank(b));
      const priced = ids.filter((id) => state.prices.has(id)).length;
      const signature = [missing.map((o) => o.id).join(','), state.collectionVersion, state.wishlist.size, state.catalog.size, blockedOffers.ids.size, priced].join('@');
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

      const wanted = el('div', { class: 'kp-want' }, el('div', { class: 'kp-grid' }, [...(o.wantIds || [])].sort(cheapestFirst).map((wid) => {
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
          delta: free > 0 ? tradeDelta(o.characterId, wid) : undefined,
          action: stateText(!state.collection ? 'Collection en chargement…' : free > 0 ? 'Tu peux la donner' : qty ? 'Tu l’as (pas libre)' : 'Tu ne l’as pas'),
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
        el('div', { class: 'kp-xacts' }, openButton, blockedOffers.button(o.id)));
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
   * Exchanges: « Offres Bangers » column on the right of the market. Every open offer the server sent (not only the
   * site's 120) where I own one of the wanted cards and it is worth it: a card of BANGER_RARITY or rarer offered against
   * a less rare one, or a gain (offered price − given price) of at least the chosen minimum (STORAGE.bangerMin).
   * Cards I locked count too: « Donner » first asks to unlock them. Actions click the site's own buttons.
   */
  const bangerOffers = {
    name: 'bangerOffers',
    /** Map<"offerId:cardId", { stage: 'confirm' | 'busy' | 'error', text }> of the offers being acted on. */
    pending: new Map(),
    asked: false,

    run() {
      const board = document.querySelector(SITE.board);
      const layout = board && board.closest(SITE.marketLayout);
      let panel = document.getElementById('kp-bangers');
      if (!layout) { if (panel) panel.remove(); return; }
      if (!this.asked) { this.asked = true; if (!state.collection) loadCollection(); loadCatalog(); }
      if (!panel || panel.parentElement !== layout) {
        if (panel) panel.remove();
        layout.appendChild(panel = this.build());
      }

      const min = this.minGain();
      const bangers = this.find(min);
      setText(panel.querySelector('.kp-bangers-n'), String(bangers.length));
      setText(panel.querySelector('.kp-bangers-empty'), !state.collection ? 'Collection en chargement…'
        : !state.serverOffers.length ? 'Offres en chargement…'
        : bangers.length ? '' : 'Aucune offre banger pour le moment.');
      const list = panel.querySelector('.kp-bangers-list');
      const signature = [state.catalog.size, bangers.map((b) =>
        [b.key, b.gain, b.locked, b.upgrade, JSON.stringify(this.pending.get(b.key) || null)].join('|')).join('#')].join('@');
      if (list.dataset.signature === signature) return;
      list.dataset.signature = signature;
      list.replaceChildren(...bangers.map((b) => this.item(b)));
    },

    minGain() {
      const n = Number(storage.get(STORAGE.bangerMin, BANGER_MIN_GAIN));
      return Number.isFinite(n) ? n : BANGER_MIN_GAIN;
    },

    setMin(value) {
      if (value.trim() === '' || !Number.isFinite(Number(value))) return;
      storage.set(STORAGE.bangerMin, Number(value));
      scheduleRender();
    },

    build() {
      const rank = RARITY_CODES[BANGER_RARITY.toLowerCase()];
      const rare = RARITIES.slice(rank).map((r) => r.name).reverse().join(' ou ');
      return el('aside', { id: 'kp-bangers', class: 'kp-bangers', 'aria-label': 'Offres Bangers' },
        el('header', { class: 'kp-bangers-head' }, el('h3', { text: 'Offres Bangers' }), el('span', { class: 'kp-bangers-n mono' })),
        el('p', { class: 'kp-bangers-help', text: `Les offres que tu peux accepter : une ${rare} contre une carte moins rare, ou un gain d’au moins :` }),
        el('label', { class: 'kp-bangers-field' },
          el('input', {
            type: 'number', class: 'kp-bangers-min mono', min: '0', step: '50', inputmode: 'numeric',
            value: String(this.minGain()), 'aria-label': 'Gain minimum en chakra',
            onInput: (e) => this.setMin(e.target.value),
          }),
          el('span', { text: '◆ de gain' })),
        el('p', { class: 'kp-bangers-empty' }),
        el('ul', { class: 'kp-bangers-list' }));
    },

    /** My own offers: from /api/trades/offers/mine, and the ones the site marks as mine. */
    myOfferIds() {
      const ids = new Set(state.myOfferIds);
      for (const li of document.querySelectorAll(`${SITE.myOffer}[id^="offre-"]`)) ids.add(li.id.slice('offre-'.length));
      return ids;
    },

    /** 'free' if I can give a copy of this card, 'locked' if I own it but it is locked, else null. */
    usable(id) {
      const c = state.collection && state.collection.get(String(id));
      if (!c || !c.qty) return null;
      const locked = collectionLocks.confirmed.has(String(id)) ? collectionLocks.confirmed.get(String(id)) : c.locked;
      if (locked) return 'locked';
      return c.qty - (c.resaleLocked || 0) > 0 ? 'free' : null;
    },

    /** One banger per offer (its best card to give), the biggest gain first. */
    find(min) {
      if (!state.collection) return [];
      const mine = this.myOfferIds();
      const rarityRank = (id) => { const r = cardInfo(id).rarity; return r ? RARITIES.indexOf(r) : -1; };
      const minRank = RARITY_CODES[BANGER_RARITY.toLowerCase()];
      const gainOf = (b) => (b.gain === null ? -Infinity : b.gain);
      const better = (a, b) => (a.locked !== b.locked ? !a.locked : gainOf(a) > gainOf(b));
      const ids = [], out = [];
      for (const o of state.serverOffers) {
        if (mine.has(String(o.id)) || blockedOffers.ids.has(o.id)) continue;
        const offeredRank = rarityRank(o.characterId);
        let best = null;
        for (const w of o.wantIds || []) {
          const use = this.usable(w);
          if (!use) continue;
          ids.push(String(o.characterId), String(w));
          const wantRank = rarityRank(w);
          const upgrade = offeredRank >= minRank && wantRank >= 0 && wantRank < offeredRank;
          const gain = tradeDelta(o.characterId, w);
          if (!upgrade && !(gain !== null && gain >= min)) continue;
          const b = { key: `${o.id}:${w}`, offer: o, cardId: String(w), upgrade, gain, locked: use === 'locked' };
          if (!best || better(b, best)) best = b;
        }
        if (best) out.push(best);
      }
      loadPrices(ids); // once per card
      return out.sort((a, b) => gainOf(b) - gainOf(a) || b.upgrade - a.upgrade);
    },

    setPending(key, value) {
      if (value) this.pending.set(key, value); else this.pending.delete(key);
      scheduleRender();
    },

    item(b) {
      const o = b.offer, offered = cardInfo(o.characterId), given = cardInfo(b.cardId);
      const p = this.pending.get(b.key);
      const thumb = (id, card, locked) => el('a', {
        class: 'kp-bthumb', href: `/wiki/${id}`, title: card.name + (card.rarity ? ` – ${card.rarity.name}` : ''), '--kp-rc': rarityColor(card.rarity),
      }, el('img', { src: cardImage(id), alt: card.name, referrerpolicy: 'no-referrer' }), locked && faIcon('lock'));

      const button = (text, cls, onClick, title) => el('button', { type: 'button', class: `btn btn-sm ${cls}`, text, title, onClick });
      let acts;
      if (p && p.stage === 'confirm') {
        acts = [
          el('span', { class: 'kp-banger-msg', text: `« ${given.name} » est verrouillée. La déverrouiller pour l’échanger ?` }),
          button('Déverrouiller et donner', 'btn-acc', () => this.give(b, true)),
          button('Annuler', 'kp-banger-sec', () => this.setPending(b.key, null)),
        ];
      } else if (p && p.stage === 'busy') {
        acts = [el('span', { class: 'kp-banger-msg', text: p.text })];
      } else {
        acts = [
          p && p.stage === 'error' && el('span', { class: 'kp-banger-msg kp-err', text: p.text }),
          button('Donner', 'btn-acc kp-give' + (ownedQty(b.cardId) === 1 ? ' kp-warn' : ''), () => this.give(b, false),
            `Donner ${given.name} contre ${offered.name}` + (b.locked ? ' (carte verrouillée : elle sera déverrouillée)' : '')),
        ];
      }

      return el('li', { class: 'kp-banger' },
        el('button', {
          type: 'button', class: 'kp-banger-see', title: 'Afficher cette offre dans la liste du site',
          'aria-label': 'Afficher cette offre dans la liste du site', onClick: () => this.reveal(o),
        }, faIcon('eye')),
        el('div', { class: 'kp-banger-cards' },
          thumb(o.characterId, offered, false),
          faIcon('arrowRightArrowLeft'),
          thumb(b.cardId, given, b.locked),
          el('div', { class: 'kp-banger-info' },
            el('b', { text: offered.name }),
            el('span', { text: `contre ${given.name}` }),
            el('span', { class: 'kp-sub', text: [o.user && `par ${o.user.pseudo}`, expiresText(o.expiresAt)].filter(Boolean).join(' · ') }))),
        el('div', { class: 'kp-banger-tags' },
          deltaPill(b.gain),
          countBadge(b.cardId, ownedQty(b.cardId)),
          b.upgrade && el('span', { class: 'kp-banger-up', '--kp-rc': rarityColor(offered.rarity), text: `${offered.rarity.name} contre ${given.rarity.name}` }),
          b.locked && el('span', { class: 'kp-banger-lock' }, faIcon('lock'), 'Verrouillée')),
        el('div', { class: 'kp-banger-acts' }, acts));
    },

    /**
     * Bring the offer into the site's list: the site's pills off (they can hide it, and « Contre mes doublons » hides
     * some « Donner » buttons), then its card typed in the site's search (see hiddenOffers.openWithSearch).
     */
    reveal(o) {
      for (const pill of offersRefresh.sitePills()) if (pill.getAttribute('aria-pressed') === 'true') pill.click();
      hiddenOffers.openWithSearch(o);
    },

    /** The site's « Donner » button for this card in the offer, once the offer is in the site's list (or null). */
    async siteButton(b) {
      const key = nameKey(cardInfo(b.cardId).name);
      const find = () => {
        const li = document.getElementById('offre-' + b.offer.id);
        return li && (siteGiveButtons(li).find((btn) => !btn.disabled && giveButtonKey(btn) === key) || null);
      };
      if (find()) return find();
      this.reveal(b.offer);
      try { return await waitFor(find, 4000); } catch { return null; }
    },

    /** Unlock the card first if needed (asked before), then click the site's own « Donner » button. */
    async give(b, unlock) {
      if (b.locked && !unlock) return this.setPending(b.key, { stage: 'confirm' });
      const step = (text) => this.setPending(b.key, { stage: 'busy', text });
      try {
        if (b.locked) {
          step('Déverrouillage…');
          await setCardLock(b.cardId, false);
          collectionLocks.confirmed.set(b.cardId, false);
          await loadCollection();
        }
        step('Recherche de l’offre…');
        let button = await this.siteButton(b);
        if (!button && b.locked) {
          // The site's list still sees the card as locked: let it reload its data, then look again
          step('Actualisation des échanges…');
          await offersRefresh.remountExchanges();
          button = await this.siteButton(b);
        }
        if (!button) throw new Error('bouton « Donner » du site introuvable, essaie depuis l’offre');
        button.click();
        step('Échange envoyé');
        setTimeout(() => reloadCollection(), 3000);
        setTimeout(() => { reloadCollection(); this.setPending(b.key, null); }, 10000);
      } catch (err) {
        warn('échange banger impossible', err);
        this.setPending(b.key, { stage: 'error', text: `Échec : ${err.message}` });
      }
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
   * Collection page: missing cards (the site's « ? ») drawn like owned ones (name, rarity, picture, series, stats, from
   * the catalogue) but greyed out. Built with the site's global card classes (.tcg, .r-<code>, .art…); the site's
   * « ? » block is hidden, never removed. Our card is dropped as soon as the slot no longer shows a missing card.
   */
  const missingCards = {
    name: 'missingCards',
    catalogAsked: false,

    run() {
      if (!SITE.collectionPage.test(location.pathname)) return;
      const slots = [...document.querySelectorAll(SITE.collectionSlot)];
      if (!slots.length) return;
      if (!state.catalog.size && !this.catalogAsked) { this.catalogAsked = true; loadCatalog(); }
      const owned = slots.map((s) => s.querySelector(`:scope > ${SITE.collectionCard}:not(.kp-ghost) .art img`)).find(Boolean);
      for (const slot of slots) {
        const miss = slot.querySelector(`:scope > ${SITE.collectionMissing}`);
        let ghost = slot.querySelector(':scope > .kp-ghost');
        const id = wikiId(slot.getAttribute('href'));
        const card = id && state.catalog.get(id);
        if (!miss || !card || !card.name) {
          if (ghost) ghost.remove();
          if (miss) setAttr(miss, 'data-kp-hidden', null);
          continue;
        }
        const signature = `${id}@${state.catalog.size}`;
        if (!ghost || ghost.dataset.kpSignature !== signature) {
          if (ghost) ghost.remove();
          slot.appendChild(ghost = this.build(id, card, owned));
          ghost.dataset.kpSignature = signature;
        }
        setAttr(miss, 'data-kp-hidden', '');
      }
    },

    /** Same markup as the site's owned card; the picture URL is copied from an owned card when one is on screen. */
    build(id, card, ownedImg) {
      const code = card.rarity ? RARITY_LETTERS[RARITIES.indexOf(card.rarity)] : 'C';
      const src = ownedImg && SITE.cardImageId.test(ownedImg.getAttribute('src') || '')
        ? ownedImg.getAttribute('src').replace(/\/\d+([^/]*\.webp)/, `/${id}$1`)
        : cardImage(id);
      const stats = [card.pow !== null && `POW ${card.pow}`, card.aura !== null && `AURA ${card.aura}`].filter(Boolean);
      return el('div', { class: `tcg r-${code} calm${'LM'.includes(code) ? ' foil' : ''} kp-ghost`, 'aria-hidden': 'true', title: 'Tu ne l’as pas encore' },
        el('div', { class: 'tcg-top' }, el('span', { class: 'tcg-name', text: card.name }), el('span', { class: 'gem', text: code })),
        el('div', { class: 'art' },
          el('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false', loading: 'lazy', src }),
          card.native && el('span', { class: 'art-k', 'aria-hidden': 'true', text: card.native }),
          card.num && el('span', { class: 'art-n', text: card.num })),
        el('div', { class: 'tcg-type', text: card.series || '' }),
        stats.length ? el('div', { class: 'tcg-stats' }, stats.map((t) => el('span', { text: t }))) : null,
        el('div', { class: 'holo', 'aria-hidden': 'true' }));
    },
  };

  /**
   * Profile › trade window, « Cartes de <pseudo> » tab: « Ses doubles » chip after the site's chips.
   * The site's grid shows 60 cards at most, so filtering it is not enough: when on, the site's grid is hidden and
   * ours lists every card the player can trade in 2+ copies (n > 1 in /api/trades/available/<id>, read from the
   * site's own request, else fetched once). Clicking one of ours types its name in the site's search and clicks
   * the site's own tile, then restores the search. In memory only: off when the window closes.
   *
   * « Mes cartes » tab: the site's « Mes doubles » and « Il lui manque » chips are exclusive. Clicking the second one
   * while the first is pressed turns both on (`combo`): the site keeps its own chip pressed, ours is only drawn pressed,
   * and our grid lists my duplicates (qty > 1, copies free to give) that the partner does not own
   * (/api/trades/owned/<id>). Clicking either chip again leaves only the other one on.
   */
  const partnerDuplicates = {
    name: 'partnerDuplicates',
    on: false,
    busy: false,
    adding: null, // card id being added through the site's search
    userId: null,
    combo: null, // « Mes cartes » tab: site chip drawn as pressed by us while the other one is really pressed
    passing: false, // our own programmatic click on a site chip, not intercepted

    /** « Mes doubles » / « Il lui manque » chips of my tab (null if not both there). */
    myChips(shelf) {
      const chips = [...shelf.querySelectorAll(`${SITE.tradeChips} ${SITE.tradeChip}`)];
      const dupes = chips.find((c) => SITE.tradeChipMyDupes.test(c.textContent));
      const lacks = chips.find((c) => SITE.tradeChipTheyLack.test(c.textContent));
      return dupes && lacks ? [dupes, lacks] : null;
    },

    /** Installed once (see start): lets both chips of my tab be pressed together. */
    install() {
      document.addEventListener('click', (e) => {
        if (this.passing) return;
        const chip = e.target.closest ? e.target.closest(SITE.tradeChip) : null;
        const shelf = chip && chip.closest(SITE.tradeShelf);
        const pair = shelf && this.myChips(shelf);
        if (!pair || !pair.includes(chip)) return;
        const other = pair.find((c) => c !== chip);
        const pressed = (c) => c.getAttribute('aria-pressed') === 'true';
        if (!this.combo) {
          if (!pressed(other) || pressed(chip)) return; // the site's own behaviour
          e.preventDefault();
          e.stopImmediatePropagation();
          this.setCombo(chip);
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        const fake = this.combo;
        this.setCombo(null);
        // Clicking the really pressed chip: keep only the other one, through the site's own button
        if (chip !== fake) this.clickSite(fake);
      }, true);
    },

    clickSite(chip) {
      this.passing = true;
      try { chip.click(); } finally { this.passing = false; }
    },

    /** Draw a site chip as pressed (or restore the previous one) and load what our grid needs. */
    setCombo(chip) {
      if (this.combo && this.combo !== chip && this.combo.isConnected) {
        this.combo.classList.remove('on');
        this.combo.setAttribute('aria-pressed', 'false');
      }
      this.combo = chip;
      if (chip) {
        chip.classList.add('on');
        chip.setAttribute('aria-pressed', 'true');
        this.load({ owned: true, collection: true });
      }
      scheduleRender();
    },

    run() {
      const shelf = document.querySelector(SITE.tradeShelf);
      const profile = SITE.profilePage.exec(location.pathname);
      if (!shelf || !profile) { this.on = false; this.userId = null; this.combo = null; return; }
      const userId = profile[1].toLowerCase();
      if (userId !== this.userId) { this.userId = userId; this.on = false; this.setCombo(null); }

      const partnerShown = [...shelf.querySelectorAll(SITE.tradeTab)]
        .some((t) => t.getAttribute('aria-selected') === 'true' && SITE.partnerTab.test(t.textContent));
      const chips = shelf.querySelector(SITE.tradeChips);
      let chip = shelf.querySelector('[data-kp-dupes]');
      if (!partnerShown || !chips) {
        if (chip) chip.remove();
        return this.runMine(shelf, userId);
      }
      if (this.combo) this.setCombo(null);

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
      if (!this.on || !cards) return this.renderGrid(shelf, null);

      const filters = this.siteFilters(shelf);
      const known = !!state.collection; // without my collection, « Je l’ai » / « Il me manque » cannot be applied
      const entries = [...cards].filter(([, n]) => n > 1)
        .map(([id, n]) => ({ id, n, lack: known && !(ownedQty(id) > 0) }))
        .filter((c) => !known || ((!filters.owned || !c.lack) && (!filters.missing || c.lack)));
      this.renderGrid(shelf, entries, {
        lack: 'Il me manque',
        filtered: filters.owned || filters.missing,
        empty: 'Aucune carte en double à échanger.',
        emptyFiltered: 'Aucun double ne correspond à tes filtres.',
      });
    },

    /** « Mes cartes » tab: our grid while both « Mes doubles » and « Il lui manque » are on. */
    runMine(shelf, userId) {
      const pair = this.myChips(shelf);
      // The chips were re-rendered, or the site turned its own chip off: back to the site's behaviour
      if (this.combo && (!pair || !pair.includes(this.combo) || !this.combo.isConnected
        || pair.find((c) => c !== this.combo).getAttribute('aria-pressed') !== 'true')) this.setCombo(null);
      // Svelte may redraw its chip: keep ours drawn as pressed
      if (this.combo) { setAttr(this.combo, 'aria-pressed', 'true'); if (!this.combo.classList.contains('on')) this.combo.classList.add('on'); }

      const theirs = state.tradeOwned.get(userId);
      if (!this.combo || !theirs || !state.collection) return this.renderGrid(shelf, null);
      const entries = [...state.collection.keys()]
        .filter((id) => ownedQty(id) > 1 && freeCopies(id) > 0 && !theirs.has(id))
        .map((id) => ({ id, n: freeCopies(id), lack: true }));
      this.renderGrid(shelf, entries, {
        lack: 'Il lui manque',
        filtered: false,
        empty: 'Aucun de tes doubles ne lui manque.',
        emptyFiltered: 'Aucun double ne correspond à tes filtres.',
      });
    },

    /** Fetch what our grids need and this page did not load. */
    load({ available = false, owned = false, collection = false }) {
      const userId = this.userId;
      if (this.busy || !userId) return;
      const jobs = [
        available && !state.tradeAvailable.has(userId) && loadTradeAvailable(userId)
          .then((ok) => { if (!ok) warn('impossible de charger les cartes échangeables du joueur'); }),
        owned && !state.tradeOwned.has(userId) && loadTradeOwned(userId)
          .then((ok) => { if (!ok) warn('impossible de charger la collection du joueur'); }),
        !state.catalog.size && loadCatalog().then((ok) => { if (!ok) warn('impossible de charger le catalogue des cartes'); }),
        collection && !state.collection && loadCollection().then((ok) => { if (!ok) warn('impossible de charger ta collection'); }),
      ].filter(Boolean);
      if (!jobs.length) return;
      this.busy = true;
      Promise.all(jobs).finally(() => { this.busy = false; scheduleRender(); });
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

    /**
     * Our grid in place of the site's one (entries = null: back to the site's grid).
     * entries: [{ id, n, lack }]; the site's search and rarity chips are applied here.
     */
    renderGrid(shelf, entries, texts) {
      const siteGrid = shelf.querySelector(SITE.tradeGrid);
      let grid = shelf.querySelector('[data-kp-grid]');
      if (siteGrid) setAttr(siteGrid, 'data-kp-hidden', entries ? '' : null);
      if (!entries) { if (grid) grid.remove(); return; }

      // While adding a card, the search holds its name: keep filtering with the user's own query
      const search = shelf.querySelector(SITE.tradeSearch);
      const query = this.adding ? (grid && grid.dataset.kpQuery) || '' : ((search && search.value) || '').trim().toLowerCase();
      const { rarities } = this.siteFilters(shelf);
      loadPrices(entries.map((c) => c.id)); // once per card, re-renders when they arrive
      const list = entries
        .map((c) => ({ ...c, price: state.prices.has(c.id) ? priceText(state.prices.get(c.id)) : null, ...cardInfo(c.id) }))
        .filter((c) => !query || c.name.toLowerCase().includes(query))
        .filter((c) => !rarities.length || rarities.includes(c.rarity))
        .sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || a.name.localeCompare(b.name));
      const filtered = !!(query || texts.filtered || rarities.length);

      if (!grid) {
        grid = el('ul', { 'data-kp-grid': '' });
        const filters = shelf.querySelector(SITE.offerFilters);
        if (siteGrid) siteGrid.after(grid);
        else if (filters) filters.after(grid);
        else shelf.appendChild(grid);
      }
      setAttr(grid, 'class', siteGrid ? siteGrid.className : 'grid');

      const signature = [list.map((c) => `${c.id}:${c.n}:${c.lack}:${c.price || ''}`).join(','), state.catalog.size, query, filtered, this.adding, texts.lack].join('@');
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
        c.lack && el('span', { class: cls('.lack', 'lack'), text: texts.lack }),
        c.price && el('span', { class: cls(SITE.tradeTilePrice, 'pr mono'), text: c.price }),
        el('span', { class: cls('.have', 'have'), text: `×${c.n} dispo` }))))
        : [el('li', { class: 'kp-trade-empty', text: filtered ? texts.emptyFiltered : texts.empty })]));
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
      if (this.on) this.load({ available: true, collection: true }); // collection: for « Il me manque » / « Je l’ai »
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
    pricesDone: null, // player whose prices have all been asked and answered
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
      if (owned && this.pricesFor !== userId) {
        this.pricesFor = userId;
        loadPricesInTurn([...owned]).finally(() => { if (this.pricesFor === userId) { this.pricesDone = userId; scheduleRender(); } });
      }

      const list = this.cards(userId);
      const available = state.tradeAvailable.get(userId);
      const priced = owned ? [...owned].filter((id) => state.prices.has(id)).length : 0;
      setText(root.querySelector('.kp-pc-count'), !owned ? 'chargement…'
        : `${list.length} / ${plural(owned.size, 'carte')}${priced < owned.size ? ` · prix ${priced}/${owned.size}` : ''}${this.busy ? ' · chargement…' : ''}`);
      // Total value once every price was asked: median price × known tradable copies (at least 1: locked cards count once).
      const value = root.querySelector('.kp-pc-value');
      const total = owned && this.pricesDone === userId
        ? [...owned].reduce((sum, id) => sum + (state.prices.get(id) || 0) * Math.max(1, available?.get(id) || 0), 0)
        : null;
      setAttr(value, 'data-kp-hidden', total === null ? '' : null);
      setText(value, total === null ? '' : `Valeur totale : ${priceText(total)}`);

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
            el('span', { class: 'kp-pc-value mono', 'data-kp-hidden': '', title: 'Somme des prix médians de ses cartes, multipliés par ses exemplaires échangeables (une carte verrouillée compte pour 1 exemplaire)' }),
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

  /**
   * Home page › booster drops (« Voir les N persos »): for the BOOSTER_PRICED rarities, every card's median price,
   * the median / average price of the rarity next to its title, and the cards sorted from the most expensive
   * (CSS order). The site shows 60 cards per rarity: « Voir plus » is clicked until all are shown.
   * Prices: /api/fair-play/prices for every card of that rarity in the catalogue (+ the ones on screen).
   */
  const boosterPrices = {
    name: 'boosterPrices',
    lastMoreClick: 0,
    catalogAsked: false,
    requested: new Set(), // rarity codes whose catalogue prices were asked

    run() {
      for (const section of document.querySelectorAll(SITE.boosterSection)) {
        const gem = section.querySelector(SITE.boosterGem);
        const code = gem && (SITE.boosterGemRarity.exec(gem.className) || [])[1];
        if (code && BOOSTER_PRICED.includes(code)) this.renderSection(section, code);
      }
    },

    /** Prices of every card of this rarity: from the catalogue (the booster page loads it), once. */
    loadRarityPrices(code) {
      if (this.requested.has(code)) return;
      if (!state.catalog.size) { // the site's own request usually arrives first
        if (!this.catalogAsked) { this.catalogAsked = true; loadCatalog(); }
        return;
      }
      this.requested.add(code);
      const rarity = rarityFromCode(code);
      const ids = [...state.catalog].filter(([, c]) => c.rarity === rarity).map(([id]) => id);
      log(`prix des ${ids.length} cartes ${rarity.name} demandés`);
      loadPrices(ids);
    },

    renderSection(section, code) {
      this.loadRarityPrices(code);

      // Show every card, else the sort only applies to the first 60
      const more = section.querySelector(SITE.boosterMore);
      if (more && !more.disabled) {
        if (Date.now() - this.lastMoreClick > 400) { this.lastMoreClick = Date.now(); more.click(); }
        setTimeout(scheduleRender, 450);
      }

      const tiles = [...section.querySelectorAll(SITE.boosterTile)]
        .map((a) => ({ a, li: a.parentElement, id: wikiId(a.getAttribute('href')) }))
        .filter((t) => t.id);
      loadPrices(tiles.map((t) => t.id)); // cards missing from the catalogue, if any (asked once each)

      const priced = tiles.filter((t) => state.prices.has(t.id))
        .sort((x, y) => state.prices.get(y.id) - state.prices.get(x.id));
      const rank = new Map(priced.map((t, i) => [t.id, i]));
      for (const t of tiles) {
        const order = String(rank.has(t.id) ? rank.get(t.id) : tiles.length); // unknown price: last
        if (t.li.style.getPropertyValue('--kp-order') !== order) t.li.style.setProperty('--kp-order', order);
        let price = t.a.querySelector(':scope > .kp-bprice');
        if (!price) t.a.appendChild(price = el('span', { class: 'kp-bprice mono', title: 'Prix médian' }));
        setText(price, state.prices.has(t.id) ? priceText(state.prices.get(t.id)) : '… ◆');
      }
      const grid = section.querySelector(SITE.boosterGrid);
      if (grid) setAttr(grid, 'data-kp-priced', '');

      const title = section.querySelector(SITE.boosterTitle);
      if (!title) return;
      let stats = title.querySelector(':scope > .kp-bstats');
      if (!stats) title.appendChild(stats = el('span', { class: 'kp-bstats' }));
      const values = priced.map((t) => state.prices.get(t.id));
      const loading = priced.length < tiles.length ? ` · prix ${priced.length}/${tiles.length}` : '';
      setText(stats, values.length
        ? `médiane ${priceText(median(values))} · moyenne ${priceText(average(values))}${loading}`
        : 'prix en chargement…');
      setAttr(stats, 'title', `Prix médian et moyen des ${plural(values.length, 'carte')} affichées`);
    },
  };

  /**
   * Friends page (/amis), « Amis » tab: a search box on the pseudo (in memory, reset on load) and a 📌 button per friend
   * to pin them at the top of the list (CSS order; the pinned ids are a per-browser convenience in localStorage).
   */
  const friendsList = {
    name: 'friendsList',
    query: '',
    pins: new Set(storage.get(STORAGE.pinnedFriends, [])),

    run() {
      const list = SITE.friendsPage.test(location.pathname) && document.querySelector(SITE.friendsList);
      const tab = document.querySelector(SITE.friendsTab);
      const active = !!list && !!tab && SITE.friendsTabName.test(tab.textContent);
      document.querySelectorAll('[data-kp-friends]').forEach((ul) => { if (!active || ul !== list) this.reset(ul); });
      if (!active) return;
      setAttr(list, 'data-kp-friends', '');

      const tools = this.renderTools(list);
      const query = fold(this.query.trim());
      let shown = 0, total = 0;
      for (const li of list.children) {
        const link = li.querySelector(SITE.friendLink);
        const id = link && (SITE.profilePage.exec(new URL(link.getAttribute('href'), location.origin).pathname) || [])[1];
        if (!id) continue;
        total++;
        const name = (li.querySelector(SITE.friendName)?.textContent || link.textContent).trim();
        const pinned = this.pins.has(id.toLowerCase());
        const visible = !query || fold(name).includes(query);
        if (visible) shown++;
        setAttr(li, 'data-kp-hidden', visible ? null : '');
        setAttr(li, 'data-kp-pinned', pinned ? '' : null);
        const order = pinned ? '-1' : '0';
        if (li.style.getPropertyValue('--kp-order') !== order) li.style.setProperty('--kp-order', order);
        this.renderPin(li, id.toLowerCase(), name, pinned);
      }
      setText(tools.querySelector('.kp-friends-count'), query ? `${shown} / ${plural(total, 'ami')}` : '');
      setAttr(tools.querySelector('.kp-friends-empty'), 'data-kp-hidden', query && !shown ? null : '');
    },

    /** Search box right above the site's list (rebuilt with the same query if the site re-renders). */
    renderTools(list) {
      let tools = document.querySelector('.kp-friends-tools');
      if (tools && tools.nextElementSibling !== list) { tools.remove(); tools = null; }
      if (!tools) {
        tools = el('div', { class: 'kp-friends-tools' },
          el('label', { class: 'kp-friends-search' },
            faIcon('search'),
            el('input', { type: 'search', placeholder: 'Chercher un ami…', 'aria-label': 'Chercher un ami', value: this.query,
              onInput: (e) => { this.query = e.target.value; scheduleRender(); } })),
          el('span', { class: 'kp-friends-count' }),
          el('p', { class: 'kp-friends-empty', 'data-kp-hidden': '', text: 'Aucun ami ne correspond à ta recherche.' }));
        list.before(tools);
      }
      return tools;
    },

    /** Round thumbtack button first in the friend's actions (tilted and muted when not pinned). */
    renderPin(li, id, name, pinned) {
      const acts = li.querySelector(SITE.friendActs);
      if (!acts) return;
      let pin = acts.querySelector(':scope > [data-kp-pin]');
      if (!pin) acts.prepend(pin = el('button', { type: 'button', class: 'kp-pin', 'data-kp-pin': '', onClick: () => this.toggle(id) }, faIcon('thumbtack')));
      const label = pinned ? `Désépingler ${name}` : `Épingler ${name} en haut de la liste`;
      setAttr(pin, 'aria-pressed', String(pinned));
      setAttr(pin, 'aria-label', label);
      setAttr(pin, 'title', label);
    },

    toggle(id) {
      if (this.pins.has(id)) this.pins.delete(id); else this.pins.add(id);
      storage.set(STORAGE.pinnedFriends, [...this.pins]);
      scheduleRender();
    },

    /** Another tab or page: give the list back as the site renders it. */
    reset(ul) {
      ul.removeAttribute('data-kp-friends');
      for (const li of ul.children) {
        li.removeAttribute('data-kp-hidden');
        li.removeAttribute('data-kp-pinned');
        li.style.removeProperty('--kp-order');
        li.querySelector('[data-kp-pin]')?.remove();
      }
      document.querySelector('.kp-friends-tools')?.remove();
    },
  };

  /**
   * Market › Mon activité › Mes échanges: instead of the lists stacked (« Offres du tableau », « Reçues », « Envoyées »),
   * one list at a time, full size, with switch buttons « Reçues » / « Envoyées » / « Offres du tableau » above them
   * (copying the look of the site's sub-tabs). The other lists and the site's headings get data-kp-hidden (never moved).
   * Selected list in memory (« Reçues » on load). Expanded trades (« Détails ▾ »): my copy count on each card,
   * duplicates highlighted, and whether I already own the cards I would receive.
   */
  const myTrades = {
    name: 'myTrades',
    collectionAsked: false,
    selected: 0, // index in the switch's order

    run() {
      const onMarket = SITE.marketPage.test(location.pathname);
      document.querySelectorAll('[data-kp-trades]').forEach((panel) => { if (!onMarket || !this.isTradesPanel(panel)) this.reset(panel); });
      if (!onMarket) return;
      for (const panel of document.querySelectorAll(SITE.myTradesPanel)) {
        if (!this.isTradesPanel(panel)) continue;
        this.layout(panel);
        for (const list of panel.querySelectorAll(`:scope > ${SITE.myTradesList}`)) {
          this.board(list);
          for (const li of list.querySelectorAll(SITE.myTrade)) {
            const id = (SITE.myTradeId.exec(li.id) || [])[1];
            const trade = id && state.myTrades && state.myTrades.get(id);
            if (trade) this.renderTrade(li, trade);
            else this.clearTrade(li);
            this.tradeButtons(li);
          }
        }
      }
      this.details();
    },

    catalogAsked: false,

    /**
     * Reçues / Envoyées: our own card for a trade, from /api/me/trades, appended inside the site's li (whose own content is
     * hidden by CSS). The site's buttons (Accepter, Refuser, Annuler, Discuter) and its chat stay below, untouched.
     * Header: who, balance (received − given, median prices + chakra), status. Body: « Tu donnes » / « Tu reçois » with
     * every card (rarity outline, my copies), then the message and the dates.
     */
    renderTrade(li, t) {
      setAttr(li, 'data-kp-trade', '');
      setAttr(li, 'data-kp-pending', t.status === 'pending' ? '' : null);
      if (!state.collection && !this.collectionAsked) { this.collectionAsked = true; loadCollection(); }
      const all = [...t.mine.cards, ...t.theirs.cards];
      if (!state.catalog.size && all.some((c) => !c.name) && !this.catalogAsked) { this.catalogAsked = true; loadCatalog(); }
      loadPrices(all.map((c) => c.id));

      const priced = all.filter((c) => state.prices.has(c.id)).length;
      const signature = [t.sig, state.collectionVersion, state.catalog.size, priced].join('@');
      let card = li.querySelector(':scope > .kp-tr');
      if (card && card.dataset.kpSignature === signature) return;
      if (!card) li.appendChild(card = el('div', { class: 'kp-tr' }));
      card.dataset.kpSignature = signature;

      const value = (part) => part.cards.reduce((sum, c) => sum + (state.prices.get(c.id) || 0) * c.n, part.chakra);
      const known = priced === all.length;
      const gain = Math.round(value(t.theirs) - value(t.mine));
      const status = { pending: ['En attente', 'kp-st-pending'], accepted: ['Acceptée', 'kp-st-accepted'], declined: ['Refusée', 'kp-st-declined'],
        cancelled: ['Annulée', 'kp-st-other'], expired: ['Expirée', 'kp-st-other'] }[t.status] || [t.status || '?', 'kp-st-other'];
      const pseudo = t.other.pseudo || 'Joueur';

      // (replaceChildren writes null as « null »: filter the optional parts)
      card.replaceChildren(...[
        el('div', { class: 'kp-tr-head' },
          el('span', { class: 'kp-tr-av', 'aria-hidden': 'true', text: pseudo.slice(0, 1) }),
          el('span', { class: 'kp-tr-who' },
            el('small', { text: t.incoming ? 'Proposé par' : 'Proposé à' }),
            t.other.id ? el('a', { href: `/profil/${t.other.id}`, text: pseudo }) : el('b', { text: pseudo })),
          el('span', { class: 'kp-tr-pills' },
            el('span', {
              class: `kp-tr-pill mono ${!known ? 'kp-even' : gain > 0 ? 'kp-gain' : gain < 0 ? 'kp-loss' : 'kp-even'}`,
              title: 'Ce que tu reçois moins ce que tu donnes (prix médians actuels + chakra)',
              text: !known ? '… ◆' : gain > 0 ? `+${priceText(gain)} pour toi` : gain < 0 ? `−${priceText(-gain)} pour toi` : 'Équilibré',
            }),
            el('span', { class: `kp-tr-pill ${status[1]}`, text: status[0] }))),
        el('div', { class: 'kp-tr-body' },
          this.side('Tu donnes', t.mine, true),
          el('span', { class: 'kp-tr-swap', 'aria-hidden': 'true' }, faIcon('arrowRightArrowLeft')),
          this.side('Tu reçois', t.theirs, false)),
        t.message && el('p', { class: 'kp-tr-msg', text: `« ${t.message} »` }),
      ].filter(Boolean));

      let foot = li.querySelector(':scope > .kp-tr-foot');
      if (!foot) li.appendChild(foot = el('div', { class: 'kp-tr-foot' }));
      const expires = t.status === 'pending' ? expiresText(t.expiresAt) : '';
      const soon = expires && Date.parse(t.expiresAt) - Date.now() < 6 * 36e5;
      foot.replaceChildren(...[agoText(t.createdAt), expires && ' · ', expires && el('span', { class: soon ? 'kp-soon' : '', text: expires })].filter(Boolean));
    },

    /** One side: title + value, every card (20 at most) with its median price, chakra, and a summary of my copies. */
    side(title, part, mine) {
      const counts = { dup: 0, single: 0, new: 0, had: 0 };
      const tiles = part.cards.map((c) => {
        const info = cardInfo(c.id);
        const name = c.name || info.name, rarity = c.rarity || info.rarity;
        const qty = ownedQty(c.id), price = state.prices.get(c.id);
        const kind = !state.collection ? null : mine ? (qty >= 2 ? 'dup' : qty === 1 ? 'single' : null) : (qty ? 'had' : 'new');
        if (kind) counts[kind]++;
        const own = kind === 'new' ? 'Tu ne l’as pas encore' : kind === 'had' ? `Tu l’as déjà (×${qty})`
          : kind === 'dup' ? `Tu en as ${qty}` : kind === 'single' ? 'C’est ta dernière copie' : '';
        return el('div', { class: 'kp-tr-tile' + (kind === 'had' ? ' kp-had' : '') },
          el('a', {
            class: 'kp-tr-card',
            href: `/wiki/${c.id}`,
            '--kp-rc': rarityColor(rarity),
            title: [name + (c.n > 1 ? ` ×${c.n}` : ''), rarity && rarity.name, price !== undefined && priceText(price), own].filter(Boolean).join(' · '),
          },
          el('img', { src: cardImage(c.id), alt: name, loading: 'lazy', referrerpolicy: 'no-referrer' }),
          c.n > 1 && el('span', { class: 'kp-tr-n', text: `×${c.n}` }),
          kind === 'new' && el('span', { class: 'kp-tag-new', text: 'Nouv.' }),
          kind === 'had' && el('span', { class: 'kp-cnt kp-had', text: `×${qty}` }),
          (kind === 'dup' || kind === 'single') && countBadge(c.id, qty)),
          el('span', { class: 'kp-tr-price mono', title: 'Prix médian', text: price !== undefined ? priceText(price) : '… ◆' }));
      });

      const total = part.cards.reduce((sum, c) => sum + (state.prices.get(c.id) || 0) * c.n, part.chakra);
      const allPriced = part.cards.every((c) => state.prices.has(c.id));
      const notes = (mine
        ? [['dup', counts.dup, (s) => `doublon${s}`], ['single', counts.single, (s) => `dernier${s} exemplaire${s}`]]
        : [['new', counts.new, (s) => `nouvelle${s}`], ['had', counts.had, (s) => `déjà possédée${s}`]]).filter(([, n]) => n);
      const nCards = part.cards.reduce((sum, c) => sum + c.n, 0);

      return el('section', { class: 'kp-tr-side' },
        el('div', { class: 'kp-tr-side-head' },
          el('b', { text: `${title}${nCards ? ` · ${nCards}` : ''}` }),
          el('span', { class: 'kp-tr-value mono', text: allPriced ? `≈ ${priceText(total)}` : '… ◆' })),
        part.cards.length ? el('div', { class: 'kp-tr-cards' }, tiles) : null,
        part.chakra ? el('span', { class: 'kp-tr-chakra mono', text: `+ ${priceText(part.chakra)} de chakra` }) : null,
        !part.cards.length && !part.chakra ? el('span', { class: 'kp-tr-nothing', text: 'Rien' }) : null,
        notes.length ? el('div', { class: 'kp-tr-note' }, notes.map(([cls, n, word]) => el('span', { class: `kp-${cls}`, text: `${n} ${word(n > 1 ? 's' : '')}` }))) : null);
    },

    /** No data for this li (trades not loaded yet): the site's own content. */
    clearTrade(li) {
      if (!li.hasAttribute('data-kp-trade')) return;
      li.removeAttribute('data-kp-trade');
      li.removeAttribute('data-kp-pending');
      li.querySelector(':scope > .kp-tr')?.remove();
      li.querySelector(':scope > .kp-tr-foot')?.remove();
    },

    /**
     * Reçues / Envoyées: one « Détails » / « Réduire » button that stays in the header (it clicks the site's own button,
     * which is hidden: the site puts it in the summary when closed and at the bottom when open), and « Discuter » as an icon.
     */
    tradeButtons(li) {
      const siteMore = li.querySelector(`${SITE.tradeMore}:not(.kp-more)`);
      let more = li.querySelector(':scope > .kp-more');
      if (!siteMore || li.hasAttribute('data-kp-trade')) { if (more) more.remove(); } // our card shows every card: no details needed
      else {
        if (!more) {
          more = el('button', { type: 'button', onClick: () => li.querySelector(`${SITE.tradeMore}:not(.kp-more)`)?.click() },
            el('span', { class: 'kp-label' }), faIcon('chevronDown'));
          li.appendChild(more);
        }
        const open = siteMore.getAttribute('aria-expanded') === 'true';
        setAttr(more, 'class', `${siteMore.className.replace(/\bless\b/g, '').replace(/\s+/g, ' ').trim()} kp-more`);
        setAttr(more, 'aria-expanded', String(open));
        setText(more.querySelector('.kp-label'), open ? 'Réduire' : 'Détails');
      }
      const talk = li.querySelector(SITE.tradeTalk);
      if (talk && !talk.querySelector(':scope > .kp-fa')) {
        talk.prepend(faIcon('comment'));
        setAttr(talk, 'title', 'Discuter');
      }
    },

    /**
     * « Offres du tableau » (lists whose trades have .sides): grid of small squares. Under each card its name and
     * median price, and under both what the trade is worth for me: received price − given price.
     */
    board(list) {
      const trades = [...list.querySelectorAll(SITE.boardTrade)].filter((li) => li.querySelector(SITE.boardSide));
      setAttr(list, 'data-kp-board', trades.length ? '' : null);
      if (!trades.length) return;
      const sides = (li) => [...li.querySelectorAll(SITE.boardSide)].map((side) => ({
        side,
        receive: SITE.boardReceive.test(side.querySelector(SITE.boardSideLabel)?.textContent || ''),
        cards: [...side.querySelectorAll(SITE.boardThumb)].map((a) => {
          // The site's inset box-shadow does not show over the image: draw the rarity as an outline
          const img = a.querySelector('img');
          const rarity = img && rarityFromImg(img);
          if (rarity && a.style.getPropertyValue('--kp-rc') !== rgbCss(rarity)) a.style.setProperty('--kp-rc', rgbCss(rarity));
          return { id: wikiId(a.getAttribute('href')), name: (a.title || '').trim() };
        }).filter((c) => c.id),
      }));
      loadPrices(trades.flatMap((li) => sides(li).flatMap((s) => s.cards.map((c) => c.id)))); // once per card

      for (const li of trades) {
        const sidesBox = li.querySelector(SITE.boardSide).parentElement;
        if (!sidesBox.querySelector(':scope > .kp-board-swap')) sidesBox.appendChild(el('span', { class: 'kp-board-swap', 'aria-hidden': 'true' }, faIcon('arrowRightArrowLeft')));
        let gain = 0, known = true;
        for (const { side, receive, cards } of sides(li)) {
          const price = cards.reduce((sum, c) => (state.prices.has(c.id) ? sum + state.prices.get(c.id) : (known = false, sum)), 0);
          const allKnown = cards.every((c) => state.prices.has(c.id));
          gain += receive ? price : -price;
          let name = side.querySelector(':scope > .kp-side-name');
          if (!name) side.append(name = el('span', { class: 'kp-side-name' }), el('span', { class: 'kp-side-price mono' }));
          setText(name, cards.map((c) => c.name).join(', '));
          setAttr(name, 'title', name.textContent);
          setText(side.querySelector(':scope > .kp-side-price'), allKnown ? priceText(price) : '… ◆');
        }
        let diff = li.querySelector(':scope > .kp-board-diff');
        if (!diff) li.appendChild(diff = el('div', { class: 'kp-board-diff mono', title: 'Prix médian reçu − prix médian donné (prix actuels)' }));
        const rounded = Math.round(gain);
        setAttr(diff, 'class', `kp-board-diff mono ${!known ? 'kp-even' : rounded > 0 ? 'kp-gain' : rounded < 0 ? 'kp-loss' : 'kp-even'}`);
        setText(diff, !known ? 'Prix en chargement…'
          : rounded > 0 ? `+${priceText(rounded)} gagnés`
          : rounded < 0 ? `−${priceText(-rounded)} perdus`
          : 'Échange équilibré');
      }
    },

    isTradesPanel(panel) {
      return panel.querySelectorAll(`:scope > ${SITE.myTradesHeading}`).length >= 2 && !!panel.querySelector(`:scope > ${SITE.myTradesList}`);
    },

    /** Lists of the panel: { heading, nodes (heading + what follows it), title, count }, in the switch's order. */
    sections(panel) {
      const sections = [];
      for (const child of panel.children) {
        if (child.hasAttribute('data-kp-trades-switch')) continue;
        if (child.matches(SITE.myTradesHeading)) sections.push({ heading: child, nodes: [child] });
        else if (sections.length) sections[sections.length - 1].nodes.push(child);
      }
      const rank = (s) => { const i = SITE.myTradesOrder.findIndex((re) => re.test(s.heading.textContent)); return i < 0 ? SITE.myTradesOrder.length : i; };
      return sections
        .map((s, i) => ({ ...s, i, title: s.heading.textContent.trim(),
          count: s.nodes.reduce((n, node) => n + (node.matches(SITE.myTradesList) ? node.children.length : 0), 0) }))
        .sort((a, b) => rank(a) - rank(b) || a.i - b.i);
    },

    layout(panel) {
      setAttr(panel, 'data-kp-trades', '');
      const sections = this.sections(panel);
      if (this.selected >= sections.length) this.selected = 0;
      sections.forEach((s, i) => s.nodes.forEach((node) =>
        setAttr(node, 'data-kp-hidden', i === this.selected && node !== s.heading ? null : '')));

      // Switch right before the first list (rebuilt if the site re-rendered around it)
      const first = panel.querySelector(`:scope > ${SITE.myTradesHeading}`);
      let bar = panel.querySelector(':scope > [data-kp-trades-switch]');
      if (bar && bar.nextElementSibling !== first) { bar.remove(); bar = null; }
      if (!bar) first.before(bar = el('div', { 'data-kp-trades-switch': '', role: 'tablist', 'aria-label': 'Mes échanges' }));

      const subtabs = document.querySelector(SITE.marketSubtabs);
      const siteTab = subtabs && subtabs.querySelector('button');
      setAttr(bar, 'class', `${subtabs ? subtabs.className : ''} kp-trades-switch`.trim());
      const base = siteTab ? siteTab.className.replace(/\bon\b/g, '').replace(/\s+/g, ' ').trim() : '';

      const signature = sections.map((s) => s.title).join('|');
      if (bar.dataset.kpSignature !== signature) {
        bar.dataset.kpSignature = signature;
        bar.replaceChildren(...sections.map((_, i) => el('button', {
          type: 'button', role: 'tab', onClick: () => { this.selected = i; scheduleRender(); },
        }, el('span', { class: 'kp-label' }), el('span', { class: 'kp-n mono' }), el('span', { class: 'kp-pend mono', 'data-kp-hidden': '' }))));
      }
      const trades = state.myTrades ? [...state.myTrades.values()] : [];
      sections.forEach((s, i) => {
        const button = bar.children[i];
        const on = i === this.selected;
        setAttr(button, 'class', on ? `${base} on`.trim() : base);
        setAttr(button, 'aria-selected', String(on));
        setText(button.querySelector('.kp-label'), s.title);
        setText(button.querySelector('.kp-n'), String(s.count));
        // Trades waiting for an answer (Reçues: mine to give, Envoyées: theirs)
        const incoming = SITE.myTradesIncoming.test(s.title);
        const pending = SITE.myTradesBoard.test(s.title) ? 0 : trades.filter((t) => t.incoming === incoming && t.status === 'pending').length;
        const pend = button.querySelector('.kp-pend');
        setAttr(pend, 'data-kp-hidden', pending ? null : '');
        setText(pend, pending ? `${pending} en attente` : '');
      });
    },

    /**
     * Expanded trades. « Tu donnes »: ×N badge (green: duplicate, orange: my last copy). « Tu reçois »: « Nouvelle » tag
     * on the cards I do not own, the others dimmed with a grey ×N. Each tray's header sums it up.
     */
    details() {
      const trays = document.querySelectorAll(SITE.tradeTray);
      if (!trays.length) return;
      if (!state.collection) {
        if (!this.collectionAsked) { this.collectionAsked = true; loadCollection(); }
        return;
      }
      for (const tray of trays) {
        const mine = tray.matches(SITE.tradeTrayMine);
        const counts = { dup: 0, single: 0, new: 0, had: 0 };
        for (const li of tray.querySelectorAll(SITE.tradeSlotItem)) {
          const link = li.querySelector(SITE.tradeSlotLink);
          const id = link && wikiId(link.getAttribute('href'));
          if (!id) continue;
          const qty = ownedQty(id);
          const kind = mine ? (qty >= 2 ? 'dup' : qty === 1 ? 'single' : null) : (qty ? 'had' : 'new');
          if (kind) counts[kind]++;
          this.renderSlot(li, link, id, qty, kind);
        }
        this.renderSummary(tray, mine
          ? [['dup', counts.dup, (s) => `doublon${s}`], ['single', counts.single, (s) => `dernier${s} exemplaire${s}`]]
          : [['new', counts.new, (s) => `nouvelle${s}`], ['had', counts.had, (s) => `déjà possédée${s}`]]);
      }
    },

    renderSlot(li, link, id, qty, kind) {
      const signature = `${id}:${qty}:${kind}`;
      const marked = !!link.querySelector(':scope > .kp-cnt, :scope > .kp-tag-new');
      if (li.dataset.kpOwn === signature && marked === !!kind) return;
      li.dataset.kpOwn = signature;
      setAttr(li, 'data-kp-own-state', kind === 'had' ? 'owned' : null);
      link.querySelectorAll(':scope > .kp-cnt, :scope > .kp-tag-new').forEach((n) => n.remove());
      if (kind === 'new') link.appendChild(el('span', { class: 'kp-tag-new', text: 'Nouvelle', title: 'Tu ne l’as pas encore' }));
      else if (kind === 'had') link.appendChild(el('span', { class: 'kp-cnt kp-had', text: `×${qty}`, title: `Tu l’as déjà (${plural(qty, 'exemplaire')})` }));
      else if (kind) link.appendChild(countBadge(id, qty));
    },

    /** « 3 doublons · 1 dernier exemplaire » under the tray's title (only the non-zero counts). */
    renderSummary(tray, parts) {
      const head = tray.querySelector(SITE.tradeTrayHead);
      if (!head) return;
      const shown = parts.filter(([, n]) => n > 0);
      const signature = shown.map(([cls, n]) => `${cls}${n}`).join(',');
      let sum = head.querySelector(':scope > .kp-tray-sum');
      if (sum && sum.dataset.kpSignature === signature) return;
      if (!shown.length) { if (sum) sum.remove(); return; }
      if (!sum) head.appendChild(sum = el('span', { class: 'kp-tray-sum' }));
      sum.dataset.kpSignature = signature;
      sum.replaceChildren(...shown.map(([cls, n, word]) => el('span', { class: `kp-${cls}`, text: `${n} ${word(n > 1 ? 's' : '')}` })));
    },

    /** Another tab or page: give the panel back as the site renders it. */
    reset(panel) {
      panel.removeAttribute('data-kp-trades');
      panel.querySelector(':scope > [data-kp-trades-switch]')?.remove();
      for (const child of panel.children) { child.removeAttribute('data-kp-hidden'); child.removeAttribute('data-kp-board'); }
    },
  };

  /**
   * Market: the site's « Confirmer l’échange » window never shows. As soon as it opens (after a click on « Donner »),
   * it is hidden, its « Ne plus demander pendant cette session » box is ticked and its own confirm button is clicked.
   * If it is still open a few seconds later (error, server refusal…), it is shown again so the site's message is seen.
   */
  const skipTradeConfirm = {
    name: 'skipTradeConfirm',
    handled: new WeakSet(),

    run() {
      if (!SITE.marketPage.test(location.pathname)) return;
      for (const dialog of document.querySelectorAll(SITE.tradeConfirmDialog)) {
        if (this.handled.has(dialog)) continue;
        const confirm = dialog.querySelector(SITE.tradeConfirmButton);
        if (!confirm || confirm.disabled) continue; // not ready yet: the next DOM change runs this again
        this.handled.add(dialog);
        const box = dialog.parentElement && dialog.parentElement.children.length === 1 && dialog.parentElement !== document.body
          ? dialog.parentElement : dialog; // the backdrop
        setAttr(box, 'data-kp-hidden', '');
        const skip = dialog.querySelector(SITE.tradeConfirmSkip);
        if (skip && !skip.checked) skip.click();
        confirm.click();
        log('échange confirmé sans la fenêtre de confirmation');
        setTimeout(() => {
          if (!dialog.isConnected) return;
          box.removeAttribute('data-kp-hidden');
          warn('la fenêtre de confirmation est restée ouverte : elle est réaffichée');
        }, 4000);
      }
    },
  };

  /**
   * Missions page: the « Séries complètes » list is rolled up (claimed series hidden), with a button giving how many series
   * are complete. A click on it or on the panel's header unrolls / rolls it up. Rolled up again on every page load.
   * A completed series whose reward is not claimed yet always stays visible.
   */
  const completedSeries = {
    name: 'completedSeries',
    open: false,

    run() {
      const panel = SITE.missionsPage.test(location.pathname) && document.querySelector(SITE.seriesPanel);
      const head = panel && panel.querySelector(SITE.seriesHead);
      if (!head) return;
      const items = [...panel.querySelectorAll(SITE.seriesItem)];

      if (!head.hasAttribute('data-kp-series-head')) {
        head.setAttribute('data-kp-series-head', '');
        head.addEventListener('click', (e) => {
          if (e.target.closest('a, button:not([data-kp-series])')) return;
          this.open = !this.open;
          scheduleRender();
        });
      }
      let toggle = head.querySelector(':scope > [data-kp-series]');
      if (!toggle) {
        toggle = el('button', { type: 'button', class: 'kp-series-toggle', 'data-kp-series': '' },
          el('span', { class: 'kp-series-n' }), faIcon('chevronDown'));
        head.appendChild(toggle);
      }
      const n = items.length, s = n > 1 ? 's' : '';
      setText(toggle.querySelector('.kp-series-n'), `${n} série${s} complétée${s}`);
      setAttr(toggle, 'aria-expanded', String(this.open));
      setAttr(toggle, 'title', this.open ? 'Enrouler la liste' : 'Dérouler la liste');
      for (const li of items) setAttr(li, 'data-kp-hidden', this.open || !li.matches(SITE.seriesClaimed) ? null : '');
    },
  };

  const FEATURES = [chatToggle, marketChatTab, offerCards, blockedOffers, offersRefresh, hiddenOffers, bangerOffers, myTrades, skipTradeConfirm, collectionLocks, missingCards, albumFilters, albumTabs, partnerDuplicates, playerCollection, boosterPrices, friendsList, completedSeries];

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
    window.addEventListener('resize', scheduleRender); // sizes measured on our tiles (offered card height)
    albumTabs.install();
    partnerDuplicates.install();
    scheduleRender();
  }

  start();
})();
