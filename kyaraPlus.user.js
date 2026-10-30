// ==UserScript==
// @name         Kyara Plus
// @namespace    https://github.com/Mxyuki/Kyara-Script
// @version      2.34.3
// @description  Améliore kyara.games : rareté et exemplaires possédés sur les offres d’échange, bouton « Donner » sous chaque carte, wishlist en premier, offres cachées par le site, verrouillage depuis la collection, comptoir masquable, offres bangers et rentables en direct, auto-accept par rareté ou par gain.
// @author       Myuki
// @homepageURL  https://github.com/Mxyuki/Kyara-Script
// @supportURL   https://github.com/Mxyuki/Kyara-Script/issues
// @updateURL    https://github.com/Mxyuki/Kyara-Script/raw/refs/heads/main/kyaraPlus.user.js
// @downloadURL  https://github.com/Mxyuki/Kyara-Script/raw/refs/heads/main/kyaraPlus.user.js
// @icon         https://kyara.games/brand/favicon/favicon.svg
// @match        https://kyara.games/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  // src/config.js
  var config_default = {
    api: {
      minGapMs: 250,
      jitterMs: 150,
      maxRetries: 4,
      backoffMs: 2e3
    },
    offers: {
      pageSize: 60,
      maxPages: 40,
      renderStep: 40,
      priorityRarities: ["M", "L"],
      idsPerQuery: 400
    },
    live: {
      // multiplied by x-kyara-rush; the search lists newest offers first, so page 1 is usually all a poll reads.
      // Auto-accept races other players for the same offers, so it polls faster (~20 requests/min at rush 2,
      // well under the 300/min general limit).
      pollMs: 6e3,
      autoPollMs: 1500,
      jitterMs: 500,
      wakeSliceMs: 250,
      maxPages: 5,
      maxFailures: 5,
      newBadgeMs: 10 * 6e4,
      maxToasts: 3
    },
    autoAccept: {
      // offer accepts count against the market bucket (x-ratelimit-limit-market: 20 per minute)
      maxPerMinute: 10,
      gapMs: 1500,
      defaultMinGain: 1e3,
      logLimit: 8
    },
    ledger: {
      // the fair-play windows are 48 h (pairDays / receivedDays = 2); one extra hour covers clock drift
      keepMs: 49 * 36e5,
      shownReleases: 6,
      // on the trades page only, multiplied by x-kyara-rush (3 light GETs per sync)
      syncMs: 6e4
    },
    fairPlay: {
      // the limits use a rolling window, so the remaining margin is re-read now and then, not only after a trade
      refreshMs: 6e4
    },
    sorting: {
      // how long the cards on screen must stay the same before they are sorted (the site loads them in bursts)
      settleMs: 500
    },
    packs: {
      // the site's open-many never takes more than 10 packs
      maxPerOpen: 10,
      // the site keeps retrying a failed open for 2 minutes with the same request
      overrideMs: 12e4
    },
    autoOpen: {
      defaultBatch: [3, 10],
      // just under the 10 min it takes a free pack to come back, so the wait never skips a whole pack
      defaultDelayMs: [1e4, 59e4],
      maxDelayMs: 3599e3,
      wakeSliceMs: 1e3,
      // the free-pack count is predicted from nextFreeAt; this re-reads it now and then (multiplied by x-kyara-rush)
      resyncMs: 15 * 6e4,
      // when the server reports fewer packs than predicted (clock difference, packs used elsewhere)
      recheckMs: 3e4,
      gapMs: 1500,
      jitterMs: 1e3,
      maxFailures: 3,
      backoffMs: 6e4,
      uiTickMs: 1e3,
      logLimit: 8
    },
    market: {
      // GET /config does not carry them; they are constants of the site's client (chunk CV6oCC-s.js)
      saleTaxPct: 5,
      listingFeePct: 2,
      listingFeeMin: 1
    },
    activity: {
      refreshMs: 6e4,
      renderStep: 30,
      historyPageSize: 50,
      historyMaxPages: 60,
      loadingRenderMs: 800,
      compactThumbLimit: 2,
      focusMs: 2600,
      withdrawConfirmMs: 4e3
    },
    prices: {
      batchSize: 300,
      ttlMs: 10 * 6e4
    },
    side: {
      defaultMinGain: 500,
      listLimit: 30
    },
    collection: {
      maxExpandClicks: 100,
      expandDelayMs: 60
    },
    profile: {
      duplicateMin: 2,
      renderStep: 120
    },
    profileBackground: {
      userId: "2766a197-9905-4dd8-8583-a0ec324d5ec7",
      video: "https://eudist.animemusicquiz.com/havboiqa2v48ktz0.webm",
      volume: 0.15
    },
    tradeLab: {
      historyLimit: 30,
      logLimit: 20,
      lookupDelayMs: 400,
      messageMaxLength: 200
    },
    ui: {
      toastMs: 4e3,
      iconsCss: "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css"
    }
  };

  // src/lib/time.js
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var jitter = (maxMs) => Math.random() * maxMs;

  // src/api/errors.js
  var ErrorCode = {
    NETWORK: "network",
    PASS_REQUIRED: "pass_required",
    QUEUED: "queued",
    GIFT_LIMIT: "gift_limit"
  };
  var ApiError = class extends Error {
    constructor(status, code, message) {
      super(message ?? code);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  };
  var CODE_MESSAGES = {
    [ErrorCode.NETWORK]: "Serveur injoignable.",
    [ErrorCode.PASS_REQUIRED]: "Le site demande une vérification : désactive Kyara Plus, fais un échange sur le site, puis réessaie."
  };
  var STATUS_MESSAGES = {
    401: "Session expirée : recharge la page.",
    402: "Pas assez de chakra.",
    404: "Introuvable : l’offre a sans doute déjà été prise.",
    429: "Trop de requêtes, patiente quelques secondes.",
    503: "Le serveur est surchargé, réessaie dans un instant."
  };
  function describeError(error) {
    if (!(error instanceof ApiError)) return "Erreur inattendue.";
    const serverMessage = error.message !== error.code ? error.message : null;
    return CODE_MESSAGES[error.code] ?? serverMessage ?? STATUS_MESSAGES[error.status] ?? `Erreur ${error.status} (${error.code}).`;
  }
  var isGiftLimit = (error) => error instanceof ApiError && error.code === ErrorCode.GIFT_LIMIT;
  var isGone = (error) => error instanceof ApiError && ([404, 410].includes(error.status) || error.status === 409 && !isGiftLimit(error));
  var isTransient = (error) => error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);

  // src/api/client.js
  var RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 503]);
  var rushFactor = 1;
  var lastStart = 0;
  var queue = Promise.resolve();
  var rush = () => rushFactor;
  function waitForTurn() {
    const turn = queue.then(async () => {
      const gap = config_default.api.minGapMs * rushFactor + jitter(config_default.api.jitterMs);
      const wait = lastStart + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    queue = turn.catch(() => {
    });
    return turn;
  }
  function readPass() {
    try {
      const pass = JSON.parse(localStorage.getItem("kyara_pass"));
      return pass && pass.expiresAt > Date.now() ? pass.pass : null;
    } catch {
      return null;
    }
  }
  function buildHeaders({ hasBody, withPass, extra }) {
    const headers = { ...extra, "x-device-id": localStorage.getItem("kyara_device") ?? "" };
    const token = localStorage.getItem("kyara_token");
    const pass = withPass ? readPass() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    if (hasBody) headers["content-type"] = "application/json";
    if (pass) headers["x-pass"] = pass;
    return headers;
  }
  async function send(path, { method, body, withPass, headers }) {
    await waitForTurn();
    try {
      return await fetch(`/api${path}`, {
        method,
        headers: buildHeaders({ hasBody: body !== void 0, withPass, extra: headers }),
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, ErrorCode.NETWORK);
    }
  }
  async function request(path, { method = "GET", body, withPass = false, headers } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await send(path, { method, body, withPass, headers });
      rushFactor = Number(response.headers.get("x-kyara-rush")) || 1;
      const data = await response.json().catch(() => null);
      if (response.ok) return data;
      const code = data?.error ?? `http_${response.status}`;
      const retryable = RETRYABLE_STATUS.has(response.status) && code !== ErrorCode.QUEUED;
      if (!retryable || attempt >= config_default.api.maxRetries) throw new ApiError(response.status, code, data?.message);
      await sleep(config_default.api.backoffMs * 2 ** attempt + jitter(config_default.api.jitterMs));
    }
  }

  // src/api/endpoints.js
  function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== void 0 && value !== null) search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : "";
  }
  var catalogApi = {
    characters: () => request("/characters")
  };
  var meApi = {
    bootstrap: () => request("/me/bootstrap")
  };
  var configApi = {
    get: () => request("/config")
  };
  var packsApi = {
    list: () => request("/packs"),
    // The request id is the server's idempotency key: a retry with the same id cannot open the packs twice.
    openMany: (packId, { count, maxChakra, requestId }) => request(`/packs/${encodeURIComponent(packId)}/open-many`, {
      method: "POST",
      body: { count, maxChakra },
      withPass: true,
      headers: { "x-request-id": requestId }
    })
  };
  var marketApi = {
    mine: () => request("/me/market"),
    history: (kind, page, size) => request(`/me/market/history${query({ kind, page, size })}`),
    cancelListing: (listingId) => request(`/market/listings/${encodeURIComponent(listingId)}/cancel`, { method: "POST" }),
    cancelOrder: (orderId) => request(`/market/buy-orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" }),
    withdrawAll: () => request("/me/market/withdraw-all", { method: "POST" })
  };
  var collectionApi = {
    mine: () => request("/me/collection?lean=1"),
    prices: (ids) => request(`/me/collection/prices?ids=${ids.join(",")}`),
    setPinned: (characterId, pinned) => request(`/me/collection/${characterId}/pin`, { method: "POST", body: { pinned } }),
    // Response shape inferred from the site's wiki page (never captured): { user, entry, gained? }.
    recycle: (characterId, qty) => request(`/me/collection/${characterId}/recycle`, { method: "POST", body: { qty } })
  };
  var fairPlayApi = {
    withPlayer: (userId2) => request(`/fair-play/with/${encodeURIComponent(userId2)}`),
    prices: (ids) => request(`/fair-play/prices?ids=${ids.join(",")}`)
  };
  var notificationsApi = {
    list: () => request("/me/notifications")
  };
  var tradesApi = {
    mine: () => request("/me/trades"),
    // Board offers you posted or took, with closedAt, taker and takenWith once accepted.
    offersMine: () => request("/trades/offers/mine"),
    cancelOffer: (offerId) => request(`/trades/offers/${encodeURIComponent(offerId)}/cancel`, { method: "POST" }),
    propose: (body) => request("/trades", { method: "POST", body, withPass: true }),
    // Only accept is pass-protected on the site; decline and cancel are plain POSTs without a body.
    act: (tradeId, action) => request(`/trades/${encodeURIComponent(tradeId)}/${action}`, { method: "POST", withPass: action === "accept" }),
    custom: ({ method, path, body }) => request(path, { method, body, withPass: method !== "GET" }),
    availableFrom: (userId2) => request(`/trades/available/${encodeURIComponent(userId2)}`),
    ownedBy: (userId2) => request(`/trades/owned/${encodeURIComponent(userId2)}`),
    searchOffers: ({ takeable, ids, ...params }) => request(`/trades/offers/search${query({ ...params, takeable: takeable ? 1 : void 0, ids: ids?.join(",") })}`),
    acceptOffer: (offerId, withId) => request(`/trades/offers/${encodeURIComponent(offerId)}/accept`, {
      method: "POST",
      body: { withId },
      withPass: true
    })
  };

  // src/lib/rarity.js
  var RARITIES = ["M", "L", "E", "R", "U", "C"];
  var RARITY_LABELS = {
    M: "Mythique",
    L: "Légendaire",
    E: "Épique",
    R: "Rare",
    U: "Peu commune",
    C: "Commune"
  };
  function rarityRank(rarity) {
    const index = RARITIES.indexOf(rarity);
    return index === -1 ? RARITIES.length : index;
  }
  var rarityColor = (rarity) => `var(--${rarity}, var(--line3))`;

  // src/data/packs.js
  var usesFreePacks = (pack) => pack.usesFreePacks ?? pack.price === 0;
  function freeOpensLeft(pack, me) {
    if (!pack || !me) return 0;
    const granted = me.grants?.[pack.id] ?? 0;
    return granted + (usesFreePacks(pack) ? (me.freePacks ?? 0) + (me.bonusPacks ?? 0) : 0);
  }
  var withFreeCount = (body, count) => JSON.stringify({ ...JSON.parse(body), count, maxChakra: 0 });
  var newRequestId = () => crypto.randomUUID().replace(/-/g, "");
  var pulledCards = (results) => results.flatMap((result) => result.cards ?? []);
  function countByRarity(cards) {
    const counts = new Map(RARITIES.map((rarity) => [rarity, 0]));
    for (const card of cards) counts.set(card.rarity, (counts.get(card.rarity) ?? 0) + 1);
    return [...counts].filter(([, count]) => count > 0);
  }

  // src/lib/dom.js
  function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "class") element.className = value;
      else if (key === "style") for (const [name, style] of Object.entries(value)) element.style.setProperty(name, style);
      else element.setAttribute(key, value === true ? "" : value);
    }
    element.append(...children.flat().filter((child) => child != null && child !== false));
    return element;
  }
  function fill(parent, ...children) {
    parent.replaceChildren(...children.flat().filter((child) => child != null && child !== false));
  }
  function keepAttached(node, anchorSelector, place) {
    let anchor = null;
    const check = () => {
      const current = document.querySelector(anchorSelector);
      if (!current || current === anchor && node.isConnected) return;
      anchor = current;
      place(current, node);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => observer.disconnect();
  }
  function injectStylesheet(href) {
    document.head.append(h("link", { rel: "stylesheet", href }));
  }
  function injectStyles(css) {
    document.head.append(h("style", { "data-kyara-plus": "" }, css));
  }

  // src/lib/store.js
  function createStore(initialState4) {
    const state = { ...initialState4 };
    const listeners = /* @__PURE__ */ new Set();
    return {
      get: () => state,
      set(patch) {
        Object.assign(state, patch);
        for (const listener of listeners) listener(state);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

  // src/lib/site.js
  var profileIdFromPath = () => location.pathname.match(/^\/profil\/([^/]+)/)?.[1];
  var cardIdFromLink = (link2) => Number(link2?.getAttribute("href")?.match(/\/wiki\/(\d+)/)?.[1]);
  var cardImageUrl = (cardId) => `/cards/sm/${cardId}.webp`;
  var packIdFromPath = () => location.pathname.match(/^\/ouvrir\/([^/]+)/)?.[1];

  // src/lib/toast.js
  var container = null;
  function toast(message, tone2 = "info") {
    if (!container?.isConnected) {
      container = h("div", { class: "kp-toasts", role: "status" });
      document.body.append(container);
    }
    const item = h("div", { class: `kp-toast kp-toast--${tone2}` }, message);
    container.append(item);
    setTimeout(() => item.remove(), config_default.ui.toastMs);
  }
  var FLASH_KEY = "kyara-plus:flash";
  function flashToast(message, tone2 = "info") {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, tone: tone2 }));
  }
  function showFlashToast() {
    const stored = sessionStorage.getItem(FLASH_KEY);
    if (!stored) return;
    sessionStorage.removeItem(FLASH_KEY);
    const { message, tone: tone2 } = JSON.parse(stored);
    toast(message, tone2);
  }

  // src/lib/format.js
  var numberFormat = new Intl.NumberFormat("fr-FR");
  var formatNumber = (value) => numberFormat.format(value);
  var formatChakra = (value) => value == null ? "? ◆" : `${formatNumber(value)} ◆`;
  var formatPrice = (value) => value == null ? "prix inconnu" : `≈ ${formatNumber(value)}`;
  function formatGain(value) {
    if (value == null) return "?";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
    return `${sign}${formatNumber(Math.abs(value))}`;
  }
  function formatRemaining(isoDate) {
    const ms = new Date(isoDate).getTime() - Date.now();
    if (ms <= 0) return "terminé";
    const hours = Math.floor(ms / 36e5);
    if (hours >= 24) return `${Math.floor(hours / 24)} j ${hours % 24} h`;
    return `${hours} h ${Math.floor(ms / 6e4) % 60} min`;
  }
  var clockFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  var dayClockFormat = new Intl.DateTimeFormat("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  function formatClock(ms) {
    const today = (/* @__PURE__ */ new Date()).toDateString() === new Date(ms).toDateString();
    return (today ? clockFormat : dayClockFormat).format(ms);
  }
  function formatCountdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1e3));
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
    return minutes > 0 ? `${minutes} min ${rest} s` : `${seconds} s`;
  }
  var plural = (count, word) => `${formatNumber(count)} ${word}${count > 1 ? "s" : ""}`;
  var searchKey = (text) => text.normalize("NFD").replace(new RegExp("\\p{Diacritic}", "gu"), "").toLowerCase();

  // src/features/auto-open/schedule.js
  var SECOND_MS = 1e3;
  var MINUTE_SECONDS = 60;
  var CLOCK_PATTERN = /^(\d{1,3}):([0-5]\d)$/;
  var SECONDS_PATTERN = /^\d{1,4}$/;
  var randomInt = (min, max, random = Math.random) => min + Math.floor(random() * (max - min + 1));
  var randomBetween = (min, max, random = Math.random) => min + random() * (max - min);
  function normalizeRange([first, second], { min, max }) {
    const clamp = (value) => Math.min(max, Math.max(min, value));
    return [clamp(Math.min(first, second)), clamp(Math.max(first, second))];
  }
  function parseDuration(text) {
    const value = String(text).trim();
    const clock = value.match(CLOCK_PATTERN);
    if (clock) return (Number(clock[1]) * MINUTE_SECONDS + Number(clock[2])) * SECOND_MS;
    return SECONDS_PATTERN.test(value) ? Number(value) * SECOND_MS : null;
  }
  function formatDuration(ms) {
    const seconds = Math.round(ms / SECOND_MS);
    return `${Math.floor(seconds / MINUTE_SECONDS)}:${String(seconds % MINUTE_SECONDS).padStart(2, "0")}`;
  }
  function rollCycle({ batchMin, batchMax, delayMinMs, delayMaxMs }, random = Math.random) {
    return {
      target: randomInt(batchMin, batchMax, random),
      delayMs: Math.round(randomBetween(delayMinMs, delayMaxMs, random))
    };
  }
  function regeneratedStock(me, now, regenMs) {
    const have = me.freePacks ?? 0;
    const max = me.freePacksMax ?? have;
    const next = Date.parse(me.nextFreeAt);
    if (have >= max || !Number.isFinite(next) || now < next) return have;
    return Math.min(max, have + 1 + Math.floor((now - next) / regenMs));
  }
  function planOpening({ pack, me, now, regenMs, cycle }) {
    const regenerates = usesFreePacks(pack);
    const have = regenerates ? me.freePacks ?? 0 : 0;
    const max = regenerates ? me.freePacksMax ?? have : 0;
    const fixed = freeOpensLeft(pack, { ...me, freePacks: 0 });
    const target = Math.min(cycle.target, fixed + max);
    const needed = target - fixed;
    const next = Date.parse(me.nextFreeAt);
    const arrivalOf = (count) => Number.isFinite(next) ? next + (count - have - 1) * regenMs : Infinity;
    const reachedAt = needed <= have ? -Infinity : arrivalOf(needed);
    const fullAt = have >= max ? -Infinity : arrivalOf(max);
    const base = Math.max(reachedAt, now);
    const openAt = Math.max(base, Math.min(base + cycle.delayMs, fullAt));
    return { target, reachedAt, openAt, leftNow: fixed + (regenerates ? regeneratedStock(me, now, regenMs) : 0) };
  }

  // src/lib/settings.js
  var STORAGE_KEY = "kyara-plus:settings";
  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
      return {};
    }
  }
  var readSetting = (name, fallback) => readAll()[name] ?? fallback;
  function writeSetting(name, value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [name]: value }));
  }

  // src/features/auto-open/settings.js
  var BATCH_LIMITS = { min: 1, max: config_default.packs.maxPerOpen };
  var DELAY_LIMITS = { min: 0, max: config_default.autoOpen.maxDelayMs };
  function readAutoOpenSettings() {
    const [batchMin, batchMax] = normalizeRange(readSetting("autoOpenBatch", config_default.autoOpen.defaultBatch), BATCH_LIMITS);
    const [delayMinMs, delayMaxMs] = normalizeRange(
      readSetting("autoOpenDelayMs", config_default.autoOpen.defaultDelayMs),
      DELAY_LIMITS
    );
    return { batchMin, batchMax, delayMinMs, delayMaxMs };
  }
  function saveAutoOpenSettings({ batchMin, batchMax, delayMinMs, delayMaxMs }) {
    const [lowBatch, highBatch] = normalizeRange([batchMin, batchMax], BATCH_LIMITS);
    const [lowDelay, highDelay] = normalizeRange([delayMinMs, delayMaxMs], DELAY_LIMITS);
    writeSetting("autoOpenBatch", [lowBatch, highBatch]);
    writeSetting("autoOpenDelayMs", [lowDelay, highDelay]);
    return readAutoOpenSettings();
  }

  // src/features/auto-open/controller.js
  var SECONDS_PER_HOUR = 3600;
  var SECOND_MS2 = 1e3;
  var Phase = {
    IDLE: "idle",
    WAITING: "waiting",
    OPENING: "opening",
    BACKOFF: "backoff"
  };
  var initialState = () => ({
    ready: false,
    unavailable: null,
    enabled: false,
    phase: Phase.IDLE,
    target: null,
    openAt: null,
    leftNow: 0,
    opened: 0,
    log: [],
    stopReason: null,
    settings: readAutoOpenSettings()
  });
  function createAutoOpen({ store, api: api3, clock, notify: notify3, currentPackId }) {
    let pack = null;
    let regenMs = 0;
    let runId = 0;
    const state = () => store.get();
    const patch = (changes) => store.set(changes);
    const isCurrent = (id) => id === runId && state().enabled;
    async function load() {
      const packId = currentPackId();
      const [packs, serverConfig, me] = await Promise.all([api3.listPacks(), api3.getConfig(), api3.loadMe()]);
      pack = packs.find((candidate) => candidate.id === packId) ?? null;
      regenMs = Math.round(serverConfig.freePacks.regenHours * SECONDS_PER_HOUR) * SECOND_MS2;
      const unavailable = !pack ? "Booster introuvable." : !usesFreePacks(pack) ? "Ce booster n’utilise pas les boosters gratuits." : null;
      patch({ ready: true, unavailable, leftNow: freeOpensLeft(pack, me) });
    }
    async function sleepUntil(at, id, maxMs) {
      const end = Math.min(at, clock.now() + maxMs);
      while (isCurrent(id) && clock.now() < end) {
        if (currentPackId() !== pack.id) return stop("Tu as changé de booster.");
        await clock.sleep(Math.min(config_default.autoOpen.wakeSliceMs, end - clock.now()));
      }
    }
    function stop(reason = null) {
      runId++;
      patch({ enabled: false, phase: Phase.IDLE, openAt: null, stopReason: reason });
      if (reason) notify3.error(`Auto-ouverture arrêtée : ${reason}`);
    }
    function record(opened, cards) {
      if (opened === 0) return;
      const rarities = countByRarity(cards);
      const entry = { at: clock.now(), opened, rarities };
      patch({ opened: state().opened + opened, log: [entry, ...state().log].slice(0, config_default.autoOpen.logLimit) });
      const summary = rarities.map(([rarity, count]) => `${rarity}×${count}`).join(" ");
      notify3.success(`Auto-ouverture : ${plural(opened, "booster")} (${summary}).`);
    }
    async function openAll(id, known) {
      let me = known;
      let left = freeOpensLeft(pack, me);
      let opened = 0;
      const cards = [];
      while (left > 0 && isCurrent(id)) {
        const count = Math.min(left, config_default.packs.maxPerOpen);
        const { results = [], stopped = null } = await api3.openMany(pack.id, count);
        if (results.length === 0) {
          stop(stopped?.message ?? stopped?.code ?? "Le serveur n’a ouvert aucun booster.");
          break;
        }
        me = results.at(-1).user;
        notify3.pulled(results.at(-1));
        opened += results.length;
        cards.push(...pulledCards(results));
        left = stopped || results.length < count ? 0 : freeOpensLeft(pack, me);
        if (left > 0) await clock.sleep(config_default.autoOpen.gapMs * rush() + jitter(config_default.autoOpen.jitterMs));
      }
      record(opened, cards);
      return me;
    }
    async function cycleOnce(id, cycle, known) {
      const me = known ?? await api3.loadMe();
      if (!isCurrent(id)) return { me };
      const plan = planOpening({ pack, me, now: clock.now(), regenMs, cycle });
      patch({ phase: Phase.WAITING, target: plan.target, openAt: plan.openAt, leftNow: plan.leftNow });
      await sleepUntil(plan.openAt, id, config_default.autoOpen.resyncMs * rush());
      if (!isCurrent(id)) return { me };
      if (clock.now() < plan.openAt) return { me: null };
      const fresh = await api3.loadMe();
      if (freeOpensLeft(pack, fresh) < plan.target) {
        await sleepUntil(clock.now() + config_default.autoOpen.recheckMs, id, config_default.autoOpen.recheckMs);
        return { me: null };
      }
      patch({ phase: Phase.OPENING, openAt: null });
      return { me: await openAll(id, fresh), opened: true };
    }
    async function backoff(id, failures) {
      const wait = config_default.autoOpen.backoffMs * 2 ** (failures - 1) * rush() + jitter(config_default.autoOpen.jitterMs);
      patch({ phase: Phase.BACKOFF, openAt: clock.now() + wait });
      await sleepUntil(clock.now() + wait, id, wait);
    }
    async function run(id) {
      let cycle = rollCycle(state().settings);
      let me = null;
      let failures = 0;
      while (isCurrent(id)) {
        try {
          const result = await cycleOnce(id, cycle, me);
          me = result.me;
          failures = 0;
          if (result.opened) cycle = rollCycle(state().settings);
        } catch (error) {
          if (!isCurrent(id)) return;
          if (!(error instanceof ApiError)) console.error("[Kyara Plus] auto-open", error);
          if (!isTransient(error)) return stop(describeError(error));
          failures++;
          if (failures >= config_default.autoOpen.maxFailures) return stop(`${describeError(error)} (échecs répétés)`);
          me = null;
          await backoff(id, failures);
        }
      }
    }
    function start() {
      if (state().enabled || !state().ready || state().unavailable) return;
      const id = ++runId;
      patch({ enabled: true, stopReason: null, phase: Phase.WAITING });
      run(id);
    }
    function setSettings(settings) {
      patch({ settings: saveAutoOpenSettings(settings) });
    }
    function dispose() {
      runId++;
      patch({ enabled: false });
    }
    return { load, start, stop: () => stop(), setSettings, dispose };
  }

  // src/lib/icon.js
  var icon = (name) => h("i", { class: `fa-solid fa-${name}`, "aria-hidden": "true" });

  // src/data/collection.js
  var GiveStatus = {
    AVAILABLE: "available",
    PINNED: "pinned",
    BLOCKED: "blocked",
    MISSING: "missing"
  };
  async function loadCollection() {
    const entries = await collectionApi.mine();
    return new Map(entries.map((entry) => [entry.characterId, entry]));
  }
  function giveStatus(entry) {
    if (!entry || entry.qty <= 0) return GiveStatus.MISSING;
    if ((entry.listable ?? 0) > 0) return GiveStatus.AVAILABLE;
    const freeOnceUnpinned = entry.qty - (entry.locked ?? 0) - (entry.resaleLocked ?? 0) > 0;
    return entry.pinned && freeOnceUnpinned ? GiveStatus.PINNED : GiveStatus.BLOCKED;
  }
  var recyclableCopies = (entry) => entry && !entry.pinned ? Math.max(0, entry.qty - (entry.locked ?? 0) - 1) : 0;
  var unpinCard = (characterId) => collectionApi.setPinned(characterId, false);

  // src/features/market-offers/widgets.js
  function cardArt(card, size = "md", overlays = []) {
    return h(
      "a",
      {
        class: `kp-art kp-art--${size}`,
        href: `/wiki/${card.id}`,
        title: card.name,
        style: { "--kp-rarity": rarityColor(card.rarity) }
      },
      h("img", {
        src: cardImageUrl(card.id),
        alt: card.name,
        loading: "lazy",
        referrerpolicy: "no-referrer",
        onError: (event) => {
          if (card.image && event.target.src !== card.image) event.target.src = card.image;
        }
      }),
      overlays
    );
  }
  var gem = (rarity) => h("span", { class: "kp-gem", title: RARITY_LABELS[rarity], style: { "--kp-rarity": rarityColor(rarity) } }, rarity);
  function optionOverlays({ entry, status }) {
    const qty = entry?.qty ?? 0;
    return [
      qty >= 2 ? h("span", { class: "kp-badge kp-badge--count", title: plural(qty, "exemplaire") }, `×${qty}`) : null,
      status === GiveStatus.PINNED ? h("span", { class: "kp-badge kp-badge--lock", title: "Carte verrouillée" }, icon("lock")) : null
    ];
  }
  var hideButton = (onClick) => h("button", { class: "kp-hide", type: "button", title: "Masquer cette offre", onClick }, icon("eye-slash"));
  var swapIcon = () => h("span", { class: "kp-swap" }, icon("arrow-right-arrow-left"));
  function gainBadge(gain) {
    const tone2 = !gain ? "flat" : gain > 0 ? "up" : "down";
    return h("span", { class: `kp-gain kp-gain--${tone2}`, title: "Écart de prix moyen" }, formatGain(gain));
  }
  function giveButton(option, onClick, className = "") {
    const tone2 = option.entry.qty >= 2 ? "double" : "single";
    return h(
      "button",
      { class: `kp-btn kp-btn--${tone2} ${className}`, type: "button", onClick },
      "Donner",
      gainBadge(option.gain)
    );
  }
  function ownershipNote(entry) {
    const qty = entry?.qty ?? 0;
    if (qty === 0) return h("span", { class: "kp-note" }, "Tu ne l’as pas");
    if (qty === 1) return h("span", { class: "kp-note kp-note--warn" }, "Dernier exemplaire");
    return null;
  }
  function blockedTag(entry) {
    const text = entry?.sellBlock === "resale_lock" && entry.resaleUntil ? `Bloquée encore ${formatRemaining(entry.resaleUntil)}` : "Indisponible";
    return h("span", { class: "kp-tag" }, text);
  }

  // src/features/auto-open/panel.js
  var timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  function statusText(state, now) {
    if (state.unavailable) return state.unavailable;
    if (!state.ready) return "Chargement…";
    if (!state.enabled) {
      const stock = `${plural(state.leftNow, "booster")} gratuit${state.leftNow > 1 ? "s" : ""} en stock`;
      return state.stopReason ? `Arrêtée : ${state.stopReason}` : `Inactive · ${stock}`;
    }
    const remaining = state.openAt == null ? null : state.openAt - now;
    const countdown = remaining == null || !Number.isFinite(remaining) ? "…" : formatCountdown(remaining);
    if (state.phase === Phase.OPENING) return "Ouverture en cours…";
    if (state.phase === Phase.BACKOFF) return `Erreur temporaire, nouvel essai dans ${countdown}`;
    return `Prochain lot : ${plural(state.target ?? 0, "booster")} · ouverture dans ${countdown}`;
  }
  function rangeRow({ label, parse, format, onChange }) {
    const field = (ariaLabel) => h("input", { class: "kp-input kp-input--short", type: "text", inputmode: "numeric", "aria-label": ariaLabel });
    const low = field(`${label} (minimum)`);
    const high = field(`${label} (maximum)`);
    let values = [0, 0];
    const show = () => {
      if (document.activeElement !== low) low.value = format(values[0]);
      if (document.activeElement !== high) high.value = format(values[1]);
    };
    const commit = () => {
      const parsed = [parse(low.value), parse(high.value)];
      if (parsed.every((value) => value != null)) onChange(parsed);
      else show();
    };
    low.addEventListener("change", commit);
    high.addEventListener("change", commit);
    const root = h("div", { class: "kp-field" }, h("span", { class: "kp-label" }, label), low, "–", high);
    return {
      root,
      set(next) {
        values = next;
        show();
      }
    };
  }
  function logRow({ at, opened, rarities }) {
    return h(
      "div",
      { class: "kp-auto-open__log-row" },
      h("span", { class: "kp-note" }, timeFormat.format(at)),
      h("strong", {}, plural(opened, "booster")),
      h("span", { class: "kp-auto-open__gems" }, rarities.flatMap(([rarity, count]) => [gem(rarity), `×${count}`]))
    );
  }
  function createAutoOpenPanel(controller) {
    let lastState = null;
    const parseCount = (text) => /^\d{1,2}$/.test(text.trim()) ? Number(text) : null;
    const status = h("p", { class: "kp-auto-open__status" });
    const toggle = h("button", { class: "kp-btn", type: "button" });
    const stats = h("p", { class: "kp-muted" });
    const log = h("div", { class: "kp-auto-open__log" });
    const batchRow = rangeRow({
      label: "Lot de boosters",
      parse: parseCount,
      format: String,
      onChange: ([batchMin, batchMax]) => controller.setSettings({ ...lastState.settings, batchMin, batchMax })
    });
    const delayRow = rangeRow({
      label: "Attente avant d’ouvrir",
      parse: parseDuration,
      format: formatDuration,
      onChange: ([delayMinMs, delayMaxMs]) => controller.setSettings({ ...lastState.settings, delayMinMs, delayMaxMs })
    });
    const trigger = h("button", {
      type: "button",
      class: "kp-auto-open__trigger",
      title: "Auto-ouverture",
      "aria-label": "Auto-ouverture",
      "aria-expanded": "false"
    }, icon("arrows-rotate"));
    const close = h("button", { class: "kp-hide", type: "button", title: "Fermer" }, icon("xmark"));
    const root = h(
      "section",
      { class: "kp-auto-open", hidden: true, "aria-label": "Auto-ouverture des boosters" },
      h("header", { class: "kp-auto-open__head" }, h("h3", { class: "kp-title kp-title--sm" }, "Auto-ouverture"), close),
      status,
      toggle,
      batchRow.root,
      delayRow.root,
      h(
        "p",
        { class: "kp-muted" },
        "Un lot et une attente sont tirés au hasard dans ces plages avant chaque ouverture. ",
        "Si le stock gratuit est plein, tout s’ouvre sans attendre pour ne rien perdre. ",
        "Seuls les boosters gratuits sont ouverts, jamais de chakra. Les réglages valent pour le prochain tirage."
      ),
      stats,
      log
    );
    const setOpen = (open) => {
      root.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    };
    trigger.addEventListener("click", () => setOpen(root.hidden));
    close.addEventListener("click", () => setOpen(false));
    toggle.addEventListener("click", () => lastState.enabled ? controller.stop() : controller.start());
    const tick = () => {
      if (lastState && !root.hidden) status.textContent = statusText(lastState, Date.now());
    };
    const timer = setInterval(tick, config_default.autoOpen.uiTickMs);
    return {
      root,
      trigger,
      setOpen,
      render(state) {
        lastState = state;
        trigger.classList.toggle("is-live", state.enabled);
        toggle.textContent = state.enabled ? "Arrêter" : "Activer";
        toggle.classList.toggle("kp-btn--warn", state.enabled);
        toggle.disabled = !state.enabled && (!state.ready || Boolean(state.unavailable));
        batchRow.set([state.settings.batchMin, state.settings.batchMax]);
        delayRow.set([state.settings.delayMinMs, state.settings.delayMaxMs]);
        stats.textContent = `Cette visite : ${plural(state.opened, "booster")} ouvert${state.opened > 1 ? "s" : ""}`;
        log.replaceChildren(...state.log.map(logRow));
        status.textContent = statusText(state, Date.now());
      },
      destroy() {
        clearInterval(timer);
        root.remove();
        trigger.remove();
      }
    };
  }

  // src/features/auto-open/site-counter.js
  var PILL = "header.bar .bar-side .pill:has(.meter)";
  var PERCENT = 100;
  var counterOf = (user) => ({
    text: `${user.freePacks}/${user.freePacksMax}`,
    percent: Math.min(PERCENT, user.freePacks / Math.max(1, user.freePacksMax) * PERCENT)
  });
  function showFreePacks(user) {
    const pill = document.querySelector(PILL);
    if (!pill || user?.freePacks == null || user.freePacksMax == null) return;
    const { text, percent } = counterOf(user);
    const label = pill.querySelector(".mono")?.firstChild;
    if (label?.nodeType === Node.TEXT_NODE && label.nodeValue !== text) label.nodeValue = text;
    const bar = pill.querySelector(".meter i");
    if (bar) bar.style.width = `${percent}%`;
  }

  // src/features/auto-open/index.js
  var BAR_BUTTONS = "header.bar .bar-side .opts-w";
  var RUNNING_CLASS = "kp-auto-open-on";
  var PULL_EVENT = "kyara:pull";
  var api = {
    loadMe: async () => (await meApi.bootstrap()).me,
    listPacks: () => packsApi.list(),
    getConfig: () => configApi.get(),
    openMany: (packId, count) => packsApi.openMany(packId, { count, maxChakra: 0, requestId: newRequestId() })
  };
  var notify = {
    success: (message) => toast(message, "success"),
    error: (message) => toast(message, "error"),
    pulled: (result) => {
      window.dispatchEvent(new CustomEvent(PULL_EVENT, { detail: result }));
      showFreePacks(result.user);
    }
  };
  var auto_open_default = {
    id: "auto-open",
    matches: (url) => /^\/ouvrir\/[^/]+\/?$/.test(url.pathname),
    mount() {
      const store = createStore(initialState());
      const controller = createAutoOpen({
        store,
        api,
        clock: { now: Date.now, sleep },
        notify,
        currentPackId: packIdFromPath
      });
      const panel = createAutoOpenPanel(controller);
      const unsubscribe = store.subscribe((state) => {
        panel.render(state);
        document.body.classList.toggle(RUNNING_CLASS, state.enabled);
      });
      const detach = keepAttached(panel.trigger, BAR_BUTTONS, (anchor, trigger) => {
        const siteButton = anchor.querySelector("button.icon");
        trigger.className = `${siteButton?.className ?? ""} kp-auto-open__trigger`.trim();
        anchor.before(trigger);
      });
      document.body.append(panel.root);
      panel.render(store.get());
      controller.load().catch((error) => toast(describeError(error), "error"));
      return () => {
        controller.dispose();
        unsubscribe();
        detach();
        panel.destroy();
        document.body.classList.remove(RUNNING_CLASS);
      };
    }
  };

  // src/data/catalog.js
  var pending = null;
  function loadCatalog() {
    pending ??= catalogApi.characters().then((characters) => new Map(characters.map((character) => [character.id, character]))).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  }

  // src/features/collection-albums.js
  var ALBUM_TOOLS = "main .al-tools";
  var ALBUM_ITEM = "main ul.albums > li";
  var ALBUM_BUTTON = "main button.album";
  var SHOW_MORE = "main .more button";
  var albumUrl = (series) => `/collection?serie=${encodeURIComponent(series)}`;
  var albumName = (element) => element.querySelector(".a-name")?.textContent.trim();
  function buildAlbumStats(catalog, collection) {
    const stats = /* @__PURE__ */ new Map();
    for (const card of catalog.values()) {
      if (!card.series) continue;
      if (!stats.has(card.series)) stats.set(card.series, { total: 0, missingRarities: /* @__PURE__ */ new Set() });
      const album = stats.get(card.series);
      album.total++;
      if (!(collection.get(card.id)?.qty > 0)) album.missingRarities.add(card.rarity);
    }
    return stats;
  }
  function matches(album, { minSize, maxSize, rarities }) {
    if (album.total < minSize) return false;
    if (maxSize && album.total > Math.max(maxSize, minSize)) return false;
    if (rarities.size === 0) return true;
    return album.missingRarities.size > 0 && [...album.missingRarities].every((rarity) => rarities.has(rarity));
  }
  function applyFilters(stats, filters) {
    for (const item of document.querySelectorAll(ALBUM_ITEM)) {
      const album = stats.get(albumName(item));
      item.classList.toggle("kp-filtered-out", Boolean(album) && !matches(album, filters));
    }
  }
  async function expandAllAlbums(button) {
    button.disabled = true;
    for (let click = 0; click < config_default.collection.maxExpandClicks; click++) {
      const showMore = document.querySelector(SHOW_MORE);
      if (!showMore) break;
      showMore.click();
      await sleep(config_default.collection.expandDelayMs);
    }
    button.disabled = false;
  }
  function sizeInput(value, onInput, onChange) {
    return h("input", {
      class: "kp-input kp-input--short",
      type: "text",
      inputmode: "numeric",
      value: value ? String(value) : "",
      onInput: (event) => {
        event.target.value = event.target.value.replace(/\D/g, "");
        onInput(Number(event.target.value) || 0);
      },
      onChange
    });
  }
  function rarityChip(rarity, filters, onChange) {
    const chip = h(
      "button",
      {
        class: "kp-gem-chip",
        type: "button",
        title: RARITY_LABELS[rarity],
        style: { "--kp-rarity": rarityColor(rarity) },
        "aria-pressed": String(filters.rarities.has(rarity))
      },
      rarity
    );
    chip.addEventListener("click", () => {
      if (filters.rarities.has(rarity)) filters.rarities.delete(rarity);
      else filters.rarities.add(rarity);
      chip.setAttribute("aria-pressed", String(filters.rarities.has(rarity)));
      onChange();
    });
    return chip;
  }
  function createFilterBar(filters, onChange) {
    const keepMaxAboveMin = () => {
      if (!filters.maxSize || filters.maxSize >= filters.minSize) return;
      filters.maxSize = filters.minSize;
      maxInput.value = String(filters.maxSize);
      onChange();
    };
    const minInput = sizeInput(filters.minSize, (value) => {
      filters.minSize = value;
      onChange();
    }, keepMaxAboveMin);
    const maxInput = sizeInput(filters.maxSize, (value) => {
      filters.maxSize = value;
      onChange();
    }, keepMaxAboveMin);
    const expandButton = h("button", { class: "kp-btn kp-btn--ghost kp-btn--sm", type: "button" }, "Tout afficher");
    expandButton.addEventListener("click", () => expandAllAlbums(expandButton));
    return h(
      "div",
      { class: "kp-album-filters" },
      h("label", { class: "kp-field" }, h("span", { class: "kp-label" }, "Min. persos"), minInput),
      h("label", { class: "kp-field" }, h("span", { class: "kp-label" }, "Max. persos"), maxInput),
      h(
        "div",
        { class: "kp-field" },
        h("span", { class: "kp-label" }, "Il ne manque que"),
        [...RARITIES].reverse().map((rarity) => rarityChip(rarity, filters, onChange))
      ),
      expandButton
    );
  }
  function openAlbumInNewTab(event) {
    if (event.button !== 1) return;
    const button = event.target.closest(ALBUM_BUTTON);
    const name = button && albumName(button);
    if (!name) return;
    event.preventDefault();
    window.open(albumUrl(name), "_blank", "noopener");
  }
  function blockAutoscroll(event) {
    if (event.button === 1 && event.target.closest(ALBUM_BUTTON)) event.preventDefault();
  }
  var collection_albums_default = {
    id: "collection-albums",
    matches: (url) => url.pathname === "/collection",
    mount() {
      const filters = {
        minSize: readSetting("albumMinSize", 0),
        maxSize: readSetting("albumMaxSize", 0),
        rarities: new Set(readSetting("albumMissingRarities", []))
      };
      let stats = null;
      let frame = 0;
      const apply = () => {
        if (!stats || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          applyFilters(stats, filters);
        });
      };
      const onChange = () => {
        writeSetting("albumMinSize", filters.minSize);
        writeSetting("albumMaxSize", filters.maxSize);
        writeSetting("albumMissingRarities", [...filters.rarities]);
        apply();
      };
      const bar = createFilterBar(filters, onChange);
      const detach = keepAttached(bar, ALBUM_TOOLS, (tools, node) => tools.after(node));
      const observer = new MutationObserver(apply);
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("auxclick", openAlbumInNewTab, true);
      document.addEventListener("mousedown", blockAutoscroll, true);
      Promise.all([loadCatalog(), loadCollection()]).then(([catalog, collection]) => {
        stats = buildAlbumStats(catalog, collection);
        apply();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        detach();
        observer.disconnect();
        cancelAnimationFrame(frame);
        document.removeEventListener("auxclick", openAlbumInNewTab, true);
        document.removeEventListener("mousedown", blockAutoscroll, true);
        bar.remove();
        document.querySelectorAll(".kp-filtered-out").forEach((item) => item.classList.remove("kp-filtered-out"));
      };
    }
  };

  // src/features/collection-ghosts.js
  var MISSING_CARD = "main a.slot .miss";
  var FOIL_MAX_RANK = rarityRank("E");
  function findCardScope() {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        const match = rule.selectorText?.match(/\.tcg-name\.(svelte-[a-z0-9]+)/);
        if (match) return match[1];
      }
    }
    return document.querySelector('.tcg-name[class*="svelte-"]')?.className.match(/svelte-[a-z0-9]+/)?.[0] ?? "";
  }
  function siteCard(card, scope) {
    const scoped = (className) => `${className} ${scope}`.trim();
    const foil = rarityRank(card.rarity) <= FOIL_MAX_RANK;
    const showLoaded = (event) => event.target.classList.add("in");
    const useCatalogImage = (event) => {
      if (event.target.src !== card.image) event.target.src = card.image;
    };
    return h(
      "div",
      {
        class: `${scoped(`tcg r-${card.rarity}`)}${foil ? " foil" : ""}${card.heritage ? " heritage" : ""} calm kp-ghost`,
        "aria-hidden": "true",
        "data-card-id": String(card.id)
      },
      h("div", { class: "tcg-top" }, h("span", { class: scoped("tcg-name") }, card.name), h("span", { class: scoped("gem") }, card.rarity)),
      h(
        "div",
        { class: "art" },
        h("img", {
          alt: "",
          decoding: "async",
          referrerpolicy: "no-referrer",
          draggable: "false",
          class: "fade",
          src: `/cards/sm/${card.id}.webp`,
          loading: "lazy",
          onLoad: showLoaded,
          onError: useCatalogImage
        }),
        card.native ? h("span", { class: scoped("art-k"), "aria-hidden": "true" }, card.native) : null,
        h("span", { class: scoped("art-n") }, card.num)
      ),
      h("div", { class: "tcg-type" }, card.series ?? ""),
      h("div", { class: "tcg-stats" }, h("span", { class: scope }, `POW ${card.pow ?? ""}`), h("span", { class: scope }, `AURA ${card.aura ?? ""}`)),
      foil ? h("div", { class: "holo", "aria-hidden": "true" }) : null
    );
  }
  function removeStaleGhosts() {
    for (const ghost of document.querySelectorAll(".kp-ghost")) {
      const slot = ghost.closest("a.slot");
      if (!slot?.querySelector(".miss") || String(cardIdFromLink(slot)) !== ghost.dataset.cardId) ghost.remove();
    }
  }
  function decorate(catalog, scope) {
    removeStaleGhosts();
    for (const missing of document.querySelectorAll(MISSING_CARD)) {
      const slot = missing.closest("a.slot");
      const card = catalog.get(cardIdFromLink(slot));
      if (!card || slot.querySelector(".kp-ghost")) continue;
      missing.classList.add("kp-replaced");
      missing.after(siteCard(card, scope));
    }
  }
  var collection_ghosts_default = {
    id: "collection-ghosts",
    matches: (url) => url.pathname === "/collection",
    mount() {
      let catalog = null;
      let scope = "";
      let frame = 0;
      const schedule = () => {
        if (!catalog || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          scope ||= findCardScope();
          decorate(catalog, scope);
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      loadCatalog().then((loaded) => {
        catalog = loaded;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        document.querySelectorAll(".kp-ghost").forEach((ghost) => ghost.remove());
        document.querySelectorAll(".kp-replaced").forEach((missing) => missing.classList.remove("kp-replaced"));
      };
    }
  };

  // src/features/collection-locks.js
  var CARD_CELL = "main .cell";
  function renderLockButton(button, pinned) {
    button.classList.toggle("is-locked", pinned);
    button.title = pinned ? "Déverrouiller" : "Verrouiller";
    button.setAttribute("aria-label", button.title);
    button.replaceChildren(icon(pinned ? "lock" : "lock-open"));
  }
  var collection_locks_default = {
    id: "collection-locks",
    matches: (url) => url.pathname === "/collection",
    mount() {
      let collection = null;
      let frame = 0;
      async function toggle(button, cardId) {
        const entry = collection.get(cardId);
        const pinned = !entry.pinned;
        button.disabled = true;
        try {
          await collectionApi.setPinned(cardId, pinned);
          entry.pinned = pinned;
          renderLockButton(button, pinned);
        } catch (error) {
          toast(describeError(error), "error");
        } finally {
          button.disabled = false;
        }
      }
      function lockButton(cardId) {
        const button = h("button", { class: "kp-lock", type: "button", "data-card-id": String(cardId) });
        button.addEventListener("click", () => toggle(button, cardId));
        renderLockButton(button, Boolean(collection.get(cardId).pinned));
        return button;
      }
      function decorate2() {
        for (const cell of document.querySelectorAll(CARD_CELL)) {
          const slot = cell.querySelector("a.slot");
          const cardId = cardIdFromLink(slot);
          const current = cell.querySelector(":scope > .kp-lock");
          const owned = slot && !slot.querySelector(".miss") && collection.has(cardId);
          if (current && (!owned || current.dataset.cardId !== String(cardId))) current.remove();
          cell.classList.toggle("kp-lock-host", owned);
          if (owned && !cell.querySelector(":scope > .kp-lock")) cell.prepend(lockButton(cardId));
        }
      }
      const schedule = () => {
        if (!collection || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      loadCollection().then((loaded) => {
        collection = loaded;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        document.querySelectorAll(".kp-lock").forEach((button) => button.remove());
        document.querySelectorAll(".kp-lock-host").forEach((cell) => cell.classList.remove("kp-lock-host"));
      };
    }
  };

  // src/lib/array.js
  function chunk(items, size) {
    const chunks = [];
    for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
    return chunks;
  }

  // src/data/prices.js
  var cache = /* @__PURE__ */ new Map();
  var unitPrice = (row) => row.median7d || row.median30d || row.lastPrice || null;
  var isFresh = (entry, now) => entry && now - entry.at < config_default.prices.ttlMs;
  async function loadPrices(ids) {
    const now = Date.now();
    const stale = [...new Set(ids)].filter((id) => !isFresh(cache.get(id), now));
    for (const batch of chunk(stale, config_default.prices.batchSize)) {
      const rows = await collectionApi.prices(batch);
      for (const id of batch) cache.set(id, { value: null, at: now });
      for (const row of rows) cache.set(row.characterId, { value: unitPrice(row), at: now });
    }
  }
  var priceOf = (id) => cache.get(id)?.value ?? null;
  var isPriceLoaded = (id) => cache.has(id);
  function createPriceRequester(onLoaded, onError) {
    const requested = /* @__PURE__ */ new Set();
    return (ids) => {
      const missing = ids.filter((id) => !requested.has(id));
      if (missing.length === 0) return;
      missing.forEach((id) => requested.add(id));
      loadPrices(missing).then(onLoaded, onError);
    };
  }

  // src/features/collection-recycle.js
  var PRECIOUS_RARITIES = /* @__PURE__ */ new Set(["L", "M"]);
  function confirmRecycle(picks) {
    const precious = picks.filter((pick) => PRECIOUS_RARITIES.has(pick.card.rarity));
    if (precious.length === 0) return true;
    const lines = precious.map((pick) => `• ${pick.card.name} (${RARITY_LABELS[pick.card.rarity]}) ×${pick.count}`);
    return window.confirm(`Tu vas recycler des cartes rares :

${lines.join("\n")}

Continuer ?`);
  }
  async function recyclePicks(picks, onRecycled) {
    for (const pick of picks) {
      const result = await collectionApi.recycle(pick.card.id, pick.count);
      onRecycled(pick, result?.gained ?? 0);
    }
  }

  // src/features/collection-select.js
  var CARD_CELL2 = "main .cell";
  function renderPick(button, count) {
    if (button.dataset.count === String(count)) return;
    button.dataset.count = String(count);
    button.classList.toggle("is-picked", count > 0);
    button.replaceChildren(count > 0 ? `×${count}` : icon("plus"));
  }
  var collection_select_default = {
    id: "collection-select",
    matches: (url) => url.pathname === "/collection",
    mount() {
      let collection = null;
      let catalog = null;
      let frame = 0;
      const selected = /* @__PURE__ */ new Map();
      const summary = h("span", { class: "kp-pick-bar__text" });
      const recycleButton = h(
        "button",
        { class: "kp-btn kp-btn--warn kp-btn--sm", type: "button", onClick: () => recycle() },
        icon("recycle"),
        " Recycler"
      );
      const bar = h(
        "div",
        { class: "kp-pick-bar", hidden: true },
        summary,
        recycleButton,
        h("button", { class: "kp-btn kp-btn--ghost kp-btn--sm", type: "button", onClick: clear }, "Vider")
      );
      async function recycle() {
        const picks = [...selected].map(([id, count]) => ({ card: catalog.get(id), count })).filter((pick) => pick.card);
        if (picks.length === 0 || !confirmRecycle(picks)) return;
        recycleButton.disabled = true;
        let copies = 0;
        let gained = 0;
        const summaryText = () => `${plural(copies, "copie")} recyclée${copies > 1 ? "s" : ""}${gained ? ` · +${formatChakra(gained)}` : ""}.`;
        try {
          await recyclePicks(picks, (pick, chakra) => {
            copies += pick.count;
            gained += chakra;
            selected.delete(pick.card.id);
            renderBar();
          });
        } catch (error) {
          recycleButton.disabled = false;
          toast(`Recyclage interrompu : ${describeError(error)} ${copies ? summaryText() : ""}`, "error");
          await reloadCollection();
          return;
        }
        flashToast(summaryText(), "success");
        location.reload();
      }
      async function reloadCollection() {
        try {
          collection = await loadCollection();
        } catch (error) {
          toast(describeError(error), "error");
        }
        schedule();
      }
      const requestPrices = createPriceRequester(
        () => renderBar(),
        (error) => toast(describeError(error), "error")
      );
      function renderBar() {
        const copies = [...selected.values()].reduce((sum, count) => sum + count, 0);
        const value = [...selected].reduce((sum, [id, count]) => sum + (priceOf(id) ?? 0) * count, 0);
        bar.hidden = copies === 0;
        summary.textContent = `Sélection : ${plural(copies, "copie")} · ${plural(selected.size, "carte")} · ≈ ${formatChakra(value)}`;
      }
      function change(cardId, delta) {
        const max = recyclableCopies(collection.get(cardId));
        const next = Math.min(max, Math.max(0, (selected.get(cardId) ?? 0) + delta));
        if (next === 0) selected.delete(cardId);
        else selected.set(cardId, next);
        requestPrices([cardId]);
        renderBar();
        schedule();
      }
      function clear() {
        selected.clear();
        renderBar();
        schedule();
      }
      function pickButton(cardId) {
        const button = h("button", {
          class: "kp-pick",
          type: "button",
          "data-card-id": String(cardId),
          title: "Clic : ajouter une copie à recycler · clic droit : en retirer une (1 exemplaire est toujours gardé)"
        });
        button.addEventListener("click", () => change(cardId, 1));
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          change(cardId, -1);
        });
        return button;
      }
      function decorateCell(cell) {
        const slot = cell.querySelector("a.slot");
        const cardId = cardIdFromLink(slot);
        const pickable = Boolean(slot) && !slot.querySelector(".miss") && recyclableCopies(collection.get(cardId)) > 0;
        let button = cell.querySelector(":scope > .kp-pick");
        if (button && (!pickable || button.dataset.cardId !== String(cardId))) {
          button.remove();
          button = null;
        }
        cell.classList.toggle("kp-pick-host", pickable);
        cell.classList.toggle("kp-picked", pickable && selected.has(cardId));
        if (!pickable) return;
        if (!button) cell.prepend(button = pickButton(cardId));
        renderPick(button, selected.get(cardId) ?? 0);
      }
      function schedule() {
        if (!collection || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          document.querySelectorAll(CARD_CELL2).forEach(decorateCell);
        });
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      document.body.append(bar);
      showFlashToast();
      Promise.all([loadCollection(), loadCatalog()]).then(([loadedCollection, loadedCatalog]) => {
        collection = loadedCollection;
        catalog = loadedCatalog;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        bar.remove();
        document.querySelectorAll(".kp-pick").forEach((button) => button.remove());
        document.querySelectorAll(".kp-pick-host, .kp-picked").forEach((cell) => cell.classList.remove("kp-pick-host", "kp-picked"));
      };
    }
  };

  // src/features/free-packs/paid-warning.js
  var PAID_OK_KEY = "kyara.open.paidok";
  function suppressPaidWarning() {
    const previous = sessionStorage.getItem(PAID_OK_KEY);
    sessionStorage.setItem(PAID_OK_KEY, "1");
    return () => {
      if (previous === null) sessionStorage.removeItem(PAID_OK_KEY);
      else sessionStorage.setItem(PAID_OK_KEY, previous);
    };
  }

  // src/features/free-packs/site-open.js
  function createOpenOverride() {
    const siteFetch = window.fetch;
    let armed = null;
    const isArmedOpen = (input, init) => {
      if (armed && Date.now() > armed.until) armed = null;
      return Boolean(armed) && input === armed.path && init?.method === "POST" && typeof init.body === "string";
    };
    async function overridingFetch(input, init) {
      if (!isArmedOpen(input, init)) return siteFetch.call(this, input, init);
      const response = await siteFetch.call(this, input, { ...init, body: withFreeCount(init.body, armed.count) });
      if (response.ok) armed = null;
      return response;
    }
    window.fetch = overridingFetch;
    return {
      arm(packId, count) {
        const path = `/api/packs/${encodeURIComponent(packId)}/open-many`;
        armed = { path, count, until: Date.now() + config_default.packs.overrideMs };
      },
      disarm() {
        armed = null;
      },
      restore() {
        if (window.fetch === overridingFetch) window.fetch = siteFetch;
      }
    };
  }

  // src/features/free-packs/index.js
  var COUNT_GROUP = 'main .under .multi[role="group"]';
  var SITE_COUNT_BUTTONS = `${COUNT_GROUP} button:not(.kp-free-count)`;
  var OPEN_BUTTON = "main .under button.btn-open";
  var FREE_MODE_CLASS = "kp-free-mode";
  var PULL_EVENT2 = "kyara:pull";
  var siteButtons = () => [...document.querySelectorAll(SITE_COUNT_BUTTONS)];
  var buttonCount = (button) => Number(button?.textContent.replace(/\D/g, "")) || 0;
  function placeChip(chip, count) {
    const group = document.querySelector(COUNT_GROUP);
    if (!group) return;
    const next = siteButtons().find((button) => buttonCount(button) > count) ?? null;
    if (chip.parentElement !== group || chip.nextElementSibling !== next) group.insertBefore(chip, next);
  }
  function markSelection(chip, freeSelected) {
    for (const button of siteButtons()) {
      button.classList.toggle("on", !freeSelected && button.getAttribute("aria-pressed") === "true");
    }
    const template = siteButtons().find((button) => !button.classList.contains("on"));
    chip.className = `${template?.className ?? ""} kp-free-count${freeSelected ? " on" : ""}`.trim();
    chip.setAttribute("aria-pressed", String(freeSelected));
  }
  var free_packs_default = {
    id: "free-packs",
    matches: (url) => /^\/ouvrir\/[^/]+\/?$/.test(url.pathname),
    mount() {
      const chip = h("button", { type: "button", class: "kp-free-count", hidden: true, onClick: selectFree });
      const override = createOpenOverride();
      let packs = [];
      let me = null;
      let freeMode = null;
      const currentPack = () => packs.find((pack) => pack.id === packIdFromPath());
      const freeCount = () => Math.min(freeOpensLeft(currentPack(), me), config_default.packs.maxPerOpen);
      function render() {
        const count = freeCount();
        chip.hidden = count < 2 || count >= buttonCount(siteButtons().at(-1));
        chip.textContent = `×${count}`;
        chip.title = `Ouvrir tes ${count} boosters gratuits, sans payer`;
        placeChip(chip, count);
        markSelection(chip, Boolean(freeMode));
        const openButton = document.querySelector(OPEN_BUTTON);
        if (freeMode) openButton?.setAttribute("data-kp-label", `Ouvrir ×${count} · gratuits`);
        else openButton?.removeAttribute("data-kp-label");
      }
      function selectFree() {
        const pack = currentPack();
        const count = freeCount();
        if (!pack || count < 2) return;
        siteButtons().at(-1)?.click();
        leaveFreeMode();
        override.arm(pack.id, count);
        freeMode = { restoreWarning: suppressPaidWarning(), timer: setTimeout(leaveFreeMode, config_default.packs.overrideMs) };
        document.body.classList.add(FREE_MODE_CLASS);
        requestAnimationFrame(render);
      }
      function leaveFreeMode() {
        if (!freeMode) return;
        clearTimeout(freeMode.timer);
        freeMode.restoreWarning();
        freeMode = null;
        override.disarm();
        document.body.classList.remove(FREE_MODE_CLASS);
        render();
      }
      const onSiteCountClick = (event) => event.target.closest(SITE_COUNT_BUTTONS) && leaveFreeMode();
      const onPull = (event) => {
        if (!event.detail?.user) return;
        me = event.detail.user;
        leaveFreeMode();
        render();
      };
      async function load() {
        try {
          const [packList, bootstrap] = await Promise.all([packsApi.list(), meApi.bootstrap()]);
          packs = packList;
          me = bootstrap.me;
          render();
        } catch (error) {
          toast(describeError(error), "error");
        }
      }
      window.addEventListener(PULL_EVENT2, onPull);
      document.addEventListener("click", onSiteCountClick, true);
      const detach = keepAttached(chip, COUNT_GROUP, render);
      load();
      return () => {
        detach();
        leaveFreeMode();
        override.restore();
        window.removeEventListener(PULL_EVENT2, onPull);
        document.removeEventListener("click", onSiteCountClick, true);
        chip.remove();
      };
    }
  };

  // src/features/friends-list.js
  var FRIENDS_TAB = 'main [role="tablist"] [role="tab"]:first-child[aria-selected="true"]';
  var PEOPLE_LIST = "main ul.people";
  var MESSAGE_LINK = '.acts a[href*="onglet=messages"]';
  var PINNED_KEY = "pinnedFriends";
  var ACTION_ICONS = {
    Message: "comment",
    Retirer: "user-minus",
    Bloquer: "ban"
  };
  var friendId = (item) => item.querySelector("a.who")?.getAttribute("href")?.match(/\/profil\/([^/?#]+)/)?.[1];
  var friendName = (item) => item.querySelector("a.who b")?.textContent.trim() ?? "";
  var labelOf = (action) => action.textContent.trim();
  function decorateAction(action) {
    const label = labelOf(action);
    if (!action.dataset.kpIcon && ACTION_ICONS[label]) {
      action.dataset.kpIcon = label;
      action.title = label;
      action.setAttribute("aria-label", label);
      action.prepend(icon(ACTION_ICONS[label]));
    }
    if (!action.dataset.kpIcon) return;
    action.classList.add("kp-friend-act");
    action.classList.toggle("kp-friend-act--confirm", label !== action.dataset.kpIcon);
  }
  function renderPin(button, pinned) {
    button.classList.toggle("is-pinned", pinned);
    button.title = pinned ? "Retirer des favoris" : "Mettre en favori";
    button.setAttribute("aria-label", button.title);
  }
  var friends_list_default = {
    id: "friends-list",
    matches: (url) => url.pathname === "/amis",
    mount() {
      const pinned = new Set(readSetting(PINNED_KEY, []));
      let query2 = "";
      let frame = 0;
      const search = h("input", {
        class: "kp-input kp-friend-search",
        type: "search",
        placeholder: "Rechercher un ami…",
        onInput: (event) => {
          query2 = searchKey(event.target.value.trim());
          schedule();
        }
      });
      function togglePin(id) {
        if (pinned.has(id)) pinned.delete(id);
        else pinned.add(id);
        writeSetting(PINNED_KEY, [...pinned]);
        schedule();
      }
      function pinButton(item, id) {
        let button = item.querySelector(".kp-pin");
        if (button?.dataset.friendId !== id) {
          button?.remove();
          button = h("button", { class: "kp-pin", type: "button", "data-friend-id": id }, icon("thumbtack"));
          button.addEventListener("click", () => togglePin(id));
          item.querySelector(".acts")?.prepend(button);
        }
        renderPin(button, pinned.has(id));
      }
      function decorateFriend(item) {
        const id = friendId(item);
        if (!id) return;
        pinButton(item, id);
        item.querySelectorAll(".acts > a, .acts > button:not(.kp-pin)").forEach(decorateAction);
        item.classList.toggle("kp-pinned", pinned.has(id));
        item.classList.toggle("kp-filtered-out", Boolean(query2) && !searchKey(friendName(item)).includes(query2));
      }
      function decorate2() {
        const list = document.querySelector(PEOPLE_LIST);
        const onFriendsTab = Boolean(document.querySelector(FRIENDS_TAB));
        document.body.classList.toggle("kp-friends", onFriendsTab);
        if (!onFriendsTab || !list) return search.remove();
        if (search.nextElementSibling !== list) list.before(search);
        for (const item of list.children) {
          if (item.querySelector(MESSAGE_LINK)) decorateFriend(item);
        }
      }
      function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-selected"]
      });
      schedule();
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        search.remove();
        document.body.classList.remove("kp-friends");
        document.querySelectorAll(".kp-pin").forEach((button) => button.remove());
        document.querySelectorAll("[data-kp-icon]").forEach((action) => {
          action.querySelector(":scope > i.fa-solid")?.remove();
          action.classList.remove("kp-friend-act", "kp-friend-act--confirm");
          action.removeAttribute("title");
          action.removeAttribute("aria-label");
          delete action.dataset.kpIcon;
        });
        document.querySelectorAll(".kp-pinned").forEach((item) => item.classList.remove("kp-pinned"));
        document.querySelectorAll("ul.people .kp-filtered-out").forEach((item) => item.classList.remove("kp-filtered-out"));
      };
    }
  };

  // src/features/header-nav.js
  var MARKET_LINK = 'header.hdr nav.nav a.navlink[href="/marche"]';
  var FRIENDS_PATH = "/amis";
  var ACTIVE_SYNC_MS = 500;
  var header_nav_default = {
    id: "header-nav",
    matches: () => true,
    mount() {
      const link2 = h("a", { href: FRIENDS_PATH, title: "Liste d’amis" }, "Amis");
      const syncCurrent = () => {
        const current = location.pathname.startsWith(FRIENDS_PATH);
        link2.classList.toggle("on", current);
        if (current) link2.setAttribute("aria-current", "page");
        else link2.removeAttribute("aria-current");
      };
      document.body.classList.add("kp-header");
      const detach = keepAttached(link2, MARKET_LINK, (market, node) => {
        node.className = `${market.className.replace(/\bon\b/, "").trim()} kp-nav-friends`;
        market.after(node);
        syncCurrent();
      });
      const timer = setInterval(syncCurrent, ACTIVE_SYNC_MS);
      return () => {
        detach();
        clearInterval(timer);
        link2.remove();
        document.body.classList.remove("kp-header");
      };
    }
  };

  // src/features/market-counter.js
  var TAB_LIST = 'main [role="tablist"]';
  function placeLink(tabList, link2) {
    const tabClass = tabList.querySelector('[role="tab"]')?.className.replace(/\bon\b/, "") ?? "";
    link2.className = `${tabClass} kp-tab-link`;
    tabList.append(link2);
  }
  var market_counter_default = {
    id: "market-counter",
    matches: (url) => url.pathname === "/marche",
    mount() {
      const link2 = h("a", { href: "/marche/chat", title: "Ouvrir le comptoir" }, "Comptoir ↗");
      document.body.classList.add("kp-market");
      const detach = keepAttached(link2, TAB_LIST, placeLink);
      return () => {
        detach();
        link2.remove();
        document.body.classList.remove("kp-market");
      };
    }
  };

  // src/data/me.js
  var pending2 = null;
  function loadMyId() {
    pending2 ??= meApi.bootstrap().then(({ me }) => me.id).catch((error) => {
      pending2 = null;
      throw error;
    });
    return pending2;
  }

  // src/data/trade-ledger.js
  var STORAGE_KEY2 = "kyara-plus:trade-ledger";
  function readEntries() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY2)) ?? [];
    } catch {
      return [];
    }
  }
  var writeEntries = (entries) => localStorage.setItem(STORAGE_KEY2, JSON.stringify(entries));
  var oneCard = (characterId) => ({ cards: [{ characterId, qty: 1 }], chakra: 0 });
  function boardOfferEvents(offers, myId) {
    return offers.filter((offer) => offer.status === "accepted" && offer.closedAt && offer.taker).map((offer) => {
      const posted = offer.user.id === myId;
      return {
        key: `offer:${offer.id}`,
        at: Date.parse(offer.closedAt),
        approximate: false,
        partner: posted ? offer.taker : offer.user,
        gave: oneCard(posted ? offer.characterId : offer.takenWith),
        got: oneCard(posted ? offer.takenWith : offer.characterId)
      };
    });
  }
  function directTradeEvents({ incoming = [], outgoing = [] }, notifications, myId, now) {
    const acceptedAt = new Map(
      notifications.filter((item) => item.type === "trade_accepted").map((item) => [item.data.tradeId, Date.parse(item.createdAt)])
    );
    return [...incoming, ...outgoing].filter((trade) => trade.status === "accepted").map((trade) => {
      const proposed = trade.from.id === myId;
      const exact = acceptedAt.get(trade.id);
      return {
        key: `trade:${trade.id}`,
        at: exact ?? Math.min(now, Date.parse(trade.expiresAt)),
        approximate: exact == null,
        partner: proposed ? trade.to : trade.from,
        gave: proposed ? trade.give : trade.want,
        got: proposed ? trade.want : trade.give
      };
    });
  }
  var eventCardIds = (event) => [...event.gave.cards, ...event.got.cards].map((card) => card.characterId);
  async function fairPrices(events) {
    const ids = [...new Set(events.flatMap(eventCardIds))];
    const prices = {};
    for (const batch of chunk(ids, config_default.prices.batchSize)) Object.assign(prices, await fairPlayApi.prices(batch));
    return prices;
  }
  var sideValue = ({ cards, chakra = 0 }, prices) => cards.reduce((sum, card) => sum + (prices[card.characterId] ?? 0) * (card.qty ?? 1), chakra);
  async function syncTradeLedger(myId, loaded = {}) {
    const now = Date.now();
    const [offers, trades, notifications] = await Promise.all([
      loaded.offers ?? tradesApi.offersMine(),
      loaded.trades ?? tradesApi.mine(),
      notificationsApi.list()
    ]);
    const kept = readEntries().filter((entry) => now - entry.at < config_default.ledger.keepMs);
    const known = new Set(kept.map((entry) => entry.key));
    const fresh = [...boardOfferEvents(offers, myId), ...directTradeEvents(trades, notifications.items ?? [], myId, now)].filter((event) => !known.has(event.key) && now - event.at < config_default.ledger.keepMs);
    const prices = fresh.length ? await fairPrices(fresh) : {};
    const added = fresh.map(({ key, at, approximate, partner, gave, got }) => ({
      key,
      at,
      approximate,
      partner: { id: partner.id, pseudo: partner.pseudo },
      given: sideValue(gave, prices),
      received: sideValue(got, prices)
    }));
    const entries = [...kept, ...added].sort((a, b) => a.at - b.at);
    writeEntries(entries);
    return entries;
  }

  // src/features/market-offers/live.js
  async function fetchNewOffers(isKnown) {
    const fresh = [];
    for (let page = 1; page <= config_default.live.maxPages; page++) {
      const { items, more } = await tradesApi.searchOffers({ page, pageSize: config_default.offers.pageSize, takeable: true });
      const unseen = items.filter((offer) => !isKnown(offer.id));
      fresh.push(...unseen.filter((offer) => offer.status === "open"));
      if (unseen.length < items.length || !more) break;
    }
    return fresh;
  }
  async function waitNextRound(baseMs, failures, isStopped) {
    const start = Date.now();
    const extra = jitter(config_default.live.jitterMs);
    for (; ; ) {
      const due = start + baseMs() * rush() * 2 ** failures + extra;
      if (isStopped() || Date.now() >= due) return;
      await sleep(Math.min(due - Date.now(), config_default.live.wakeSliceMs));
    }
  }
  function startPolling(poll, baseMs, onGiveUp) {
    let stopped = false;
    let failures = 0;
    (async () => {
      while (!stopped) {
        await waitNextRound(baseMs, failures, () => stopped);
        if (stopped) return;
        try {
          await poll();
          failures = 0;
        } catch (error) {
          if (++failures < config_default.live.maxFailures) continue;
          stopped = true;
          onGiveUp(error);
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }

  // src/features/market-activity/model.js
  var Category = {
    TRADES_IN: "recus",
    TRADES_OUT: "envoyes",
    BOARD: "tableau",
    SALES: "ventes",
    BIDS: "mises",
    ORDERS: "ordres"
  };
  var CATEGORIES = [
    {
      id: Category.TRADES_IN,
      label: "Échanges reçus",
      short: "Reçus",
      icon: "inbox"
    },
    {
      id: Category.TRADES_OUT,
      label: "Échanges envoyés",
      short: "Envoyés",
      icon: "paper-plane"
    },
    {
      id: Category.BOARD,
      label: "Offres du tableau",
      short: "Tableau",
      icon: "bullhorn"
    },
    { id: Category.SALES, label: "Ventes", short: "Ventes", icon: "tag" },
    { id: Category.BIDS, label: "Mes mises", short: "Mises", icon: "gavel" },
    {
      id: Category.ORDERS,
      label: "Ordres d’achat",
      short: "Ordres",
      icon: "cart-shopping"
    }
  ];
  var State = { TODO: "todo", LIVE: "live", DONE: "done" };
  var Sort = {
    SOON: "soon",
    RECENT: "recent",
    OLD: "old",
    VALUE: "value",
    GAIN: "gain"
  };
  var HISTORY_KINDS = ["ventes", "mises", "echanges"];
  var DAY_MS = 864e5;
  var WEEK_DAYS = 7;
  var time = (iso) => iso ? Date.parse(iso) : null;
  var sideOf = (side) => ({
    cards: (side?.cards ?? []).map(({ characterId, qty }) => ({
      characterId,
      qty: qty ?? 1
    })),
    chakra: side?.chakra ?? 0
  });
  var cardSide = (characterId, qty = 1) => ({
    cards: [{ characterId, qty }],
    chakra: 0
  });
  var chakraSide = (chakra) => ({ cards: [], chakra });
  function searchText(item, ctx) {
    const names = [
      ...item.give.cards,
      ...item.receive.cards,
      ...(item.choice ?? []).map((characterId) => ({ characterId }))
    ].map(({ characterId }) => ctx.cardOf(characterId)?.name ?? "").join(" ");
    return searchKey(`${item.who?.pseudo ?? ""} ${names}`);
  }
  function finish(item, ctx) {
    return { ...item, search: searchText(item, ctx) };
  }
  function saleItem(listing, ctx) {
    const active = listing.status === "active";
    return finish(
      {
        key: `l:${listing.id}`,
        category: Category.SALES,
        kind: listing.type === "auction" ? "auction" : "sale",
        state: active ? State.LIVE : State.DONE,
        outcome: listing.status,
        createdAt: time(listing.createdAt),
        endsAt: time(listing.endsAt),
        at: time(listing.endsAt),
        who: null,
        give: cardSide(listing.character.id),
        receive: chakraSide(listing.finalPrice ?? listing.currentBid ?? listing.price),
        listing
      },
      ctx
    );
  }
  function bidItem(listing, ctx) {
    const active = listing.status === "active";
    const state = !active ? State.DONE : listing.leading ? State.LIVE : State.TODO;
    return finish(
      {
        key: `b:${listing.id}`,
        category: Category.BIDS,
        kind: "bid",
        state,
        outcome: listing.status,
        createdAt: time(listing.createdAt),
        endsAt: time(listing.endsAt),
        at: time(listing.endsAt),
        who: listing.seller,
        give: chakraSide(listing.myMaxBid ?? listing.currentBid ?? 0),
        receive: cardSide(listing.character.id),
        listing
      },
      ctx
    );
  }
  function orderItem(order, ctx) {
    const open = order.status === "open";
    return finish(
      {
        key: `o:${order.id}`,
        category: Category.ORDERS,
        kind: "order",
        state: open ? State.LIVE : State.DONE,
        outcome: order.status,
        createdAt: time(order.createdAt),
        endsAt: time(order.expiresAt),
        at: time(open ? order.expiresAt : order.createdAt),
        who: null,
        give: chakraSide(order.price * (open ? order.qty - order.filled : order.filled)),
        receive: cardSide(order.characterId, order.qty),
        order
      },
      ctx
    );
  }
  function tradeItem(trade, ctx) {
    const incoming = trade.to.id === ctx.myId;
    const pending3 = trade.status === "pending";
    return finish(
      {
        key: `t:${trade.id}`,
        category: incoming ? Category.TRADES_IN : Category.TRADES_OUT,
        kind: incoming ? "tradeIn" : "tradeOut",
        state: pending3 ? incoming ? State.TODO : State.LIVE : State.DONE,
        outcome: trade.status,
        createdAt: time(trade.createdAt),
        endsAt: time(trade.expiresAt),
        at: time(pending3 ? trade.expiresAt : trade.createdAt),
        who: incoming ? trade.from : trade.to,
        give: sideOf(incoming ? trade.want : trade.give),
        receive: sideOf(incoming ? trade.give : trade.want),
        message: trade.message,
        messages: trade.messages ?? 0,
        trade
      },
      ctx
    );
  }
  function boardItem(offer, ctx) {
    const posted = offer.user.id === ctx.myId;
    const open = offer.status === "open";
    const choice = posted && open ? offer.wantIds : null;
    let give = cardSide(offer.characterId);
    let receive = choice ? { cards: [], chakra: 0 } : cardSide(offer.takenWith);
    if (!posted) [give, receive] = [receive, give];
    return finish(
      {
        key: `c:${offer.id}`,
        category: Category.BOARD,
        kind: "counter",
        state: open && posted ? State.LIVE : State.DONE,
        outcome: offer.status,
        posted,
        createdAt: time(offer.createdAt),
        endsAt: time(offer.expiresAt),
        at: time(open ? offer.expiresAt : offer.closedAt ?? offer.createdAt),
        who: posted ? offer.taker ?? null : offer.user,
        give,
        receive,
        choice,
        offer
      },
      ctx
    );
  }
  function buildItems({ mine, trades, offers }, ctx) {
    return [
      ...mine.listings.map((listing) => saleItem(listing, ctx)),
      ...mine.bids.map((listing) => bidItem(listing, ctx)),
      ...mine.buyOrders.map((order) => orderItem(order, ctx)),
      ...trades.incoming.map((trade) => tradeItem(trade, ctx)),
      ...trades.outgoing.map((trade) => tradeItem(trade, ctx)),
      ...offers.map((offer) => boardItem(offer, ctx))
    ];
  }
  function historyItems(kind, page, ctx) {
    if (kind === "echanges") {
      return [...page.trades.map((trade) => tradeItem(trade, ctx)), ...page.offers.map((offer) => boardItem(offer, ctx))];
    }
    return page.items.map((listing) => kind === "ventes" ? saleItem(listing, ctx) : bidItem(listing, ctx));
  }
  var isActive = (item) => item.state !== State.DONE;
  function categoryStats(items) {
    const empty = () => ({ total: 0, open: 0, todo: 0 });
    const stats = Object.fromEntries([["all", empty()], ...CATEGORIES.map(({ id }) => [id, empty()])]);
    for (const item of items) {
      for (const entry of [stats.all, stats[item.category]]) {
        entry.total++;
        if (isActive(item)) entry.open++;
        if (item.state === State.TODO) entry.todo++;
      }
    }
    return stats;
  }
  function filterItems(items, { category, query: query2 }) {
    const needle = searchKey(query2.trim());
    return items.filter(
      (item) => (category === "all" || item.category === category) && (!needle || item.search.includes(needle))
    );
  }
  function sideValue2(side, priceOf2) {
    let total = side.chakra;
    for (const { characterId, qty } of side.cards) {
      const price = priceOf2(characterId);
      if (price == null) return null;
      total += price * qty;
    }
    return total;
  }
  var BOTH_SIDES_TRADES = /* @__PURE__ */ new Set(["tradeIn", "tradeOut", "counter"]);
  function netOf(item, priceOf2) {
    if (!BOTH_SIDES_TRADES.has(item.kind) || item.choice) return null;
    const given = sideValue2(item.give, priceOf2);
    const received = sideValue2(item.receive, priceOf2);
    return given == null || received == null ? null : received - given;
  }
  function valueOf(item, priceOf2) {
    return Math.max(sideValue2(item.give, priceOf2) ?? -1, sideValue2(item.receive, priceOf2) ?? -1);
  }
  var byNumber = (pick, direction) => (a, b) => direction * ((pick(a) ?? -Infinity) - (pick(b) ?? -Infinity));
  var momentOf = (item) => item.state === State.DONE ? item.at : item.createdAt;
  function sortItems(items, sort, priceOf2) {
    const comparators = {
      [Sort.SOON]: byNumber((item) => item.endsAt, 1),
      [Sort.RECENT]: byNumber(momentOf, -1),
      [Sort.OLD]: byNumber(momentOf, 1),
      [Sort.VALUE]: byNumber((item) => valueOf(item, priceOf2), -1),
      [Sort.GAIN]: byNumber((item) => netOf(item, priceOf2), -1)
    };
    return [...items].sort(comparators[sort]);
  }
  function finishedGroups(items, sort, now) {
    if (sort !== Sort.RECENT && sort !== Sort.OLD) return items.length ? [{ id: "done", items }] : [];
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const bucketOf = (item) => {
      if (item.at >= startOfToday) return "today";
      if (Math.floor((startOfToday - item.at) / DAY_MS) < 1) return "yesterday";
      return Math.floor((startOfToday - item.at) / DAY_MS) < WEEK_DAYS ? "week" : "older";
    };
    return ["today", "yesterday", "week", "older"].map((id) => ({
      id: `done:${id}`,
      items: items.filter((item) => bucketOf(item) === id)
    }));
  }
  function organize(items, { sort, now, priceOf: priceOf2 }) {
    const running = sortItems(items.filter(isActive), sort, priceOf2);
    const finished = sortItems(
      items.filter((item) => !isActive(item)),
      sort === Sort.SOON ? Sort.RECENT : sort,
      priceOf2
    );
    return [
      {
        id: State.TODO,
        items: running.filter((item) => item.state === State.TODO)
      },
      {
        id: State.LIVE,
        items: running.filter((item) => item.state === State.LIVE)
      },
      ...finishedGroups(finished, sort === Sort.SOON ? Sort.RECENT : sort, now)
    ].filter((group) => group.items.length);
  }
  function cardIds(items) {
    const ids = /* @__PURE__ */ new Set();
    for (const item of items) {
      for (const { characterId } of [...item.give.cards, ...item.receive.cards]) ids.add(characterId);
      for (const characterId of item.choice ?? []) ids.add(characterId);
    }
    return [...ids];
  }
  function netSale(price) {
    const { saleTaxPct, listingFeePct, listingFeeMin } = config_default.market;
    const tax = Math.ceil(price * saleTaxPct / 100);
    const fee = Math.max(listingFeeMin, Math.ceil(price * listingFeePct / 100));
    return price - tax - fee;
  }
  var sumOf = (list, pick) => list.reduce((sum, entry) => sum + pick(entry), 0);
  function engagedSummary({ mine, trades, offers }, { myId, chakraHeld = 0 }) {
    const orders = sumOf(
      mine.buyOrders.filter((order) => order.status === "open"),
      (order) => order.price * (order.qty - order.filled)
    );
    const pendingOut = trades.outgoing.filter((trade) => trade.status === "pending");
    const tradesChakra = sumOf(pendingOut, (trade) => trade.give.chakra);
    const bids = sumOf(
      mine.bids.filter((listing) => listing.status === "active" && listing.leading),
      (listing) => listing.myMaxBid ?? listing.currentBid ?? 0
    );
    const held = Math.max(chakraHeld, orders + tradesChakra + bids);
    return {
      held,
      orders,
      tradesChakra,
      bids,
      other: Math.max(0, held - orders - tradesChakra - bids),
      cardsHeld: sumOf(mine.holds, (hold) => hold.qty),
      inbox: trades.incoming.filter((trade) => trade.status === "pending").length,
      outbid: mine.bids.filter((listing) => listing.status === "active" && !listing.leading).length,
      selling: mine.listings.filter((listing) => listing.status === "active").length,
      offersOpen: offers.filter((offer) => offer.status === "open" && offer.user.id === myId).length
    };
  }
  function salesStats(listings) {
    const sold = listings.filter((listing) => listing.status === "sold" && listing.finalPrice != null);
    if (!sold.length) return null;
    const withMedian = sold.filter((listing) => listing.prices?.median7d);
    const gaps = withMedian.map((listing) => listing.finalPrice / listing.prices.median7d - 1);
    return {
      sold: sold.length,
      net: sumOf(sold, (listing) => netSale(listing.finalPrice)),
      vsMedian: gaps.length ? Math.round(sumOf(gaps, (gap) => gap) / gaps.length * 100) : null,
      best: sold.reduce((best, listing) => listing.finalPrice > best.finalPrice ? listing : best)
    };
  }

  // src/features/market-activity/controller.js
  var HistoryPhase = {
    IDLE: "idle",
    LOADING: "loading",
    DONE: "done",
    ERROR: "error"
  };
  var BAD_REQUEST = 400;
  function reportUnexpected(error) {
    if (!(error instanceof ApiError)) console.error("[Kyara Plus] Mon activité", error);
  }
  var initialState2 = () => ({
    phase: "loading",
    error: null,
    items: [],
    summary: null,
    stats: null,
    history: { phase: HistoryPhase.IDLE, error: null },
    busy: /* @__PURE__ */ new Set(),
    version: 0,
    focus: null,
    withdrawArmed: false,
    view: {
      category: "all",
      sort: readSetting("activitySort", Sort.SOON),
      query: "",
      open: /* @__PURE__ */ new Set(),
      shown: config_default.activity.renderStep,
      native: false,
      ledgerOpen: readSetting("activityLedger", false)
    }
  });
  function createActivityController({ store, api: api3, notify: notify3, clock = { now: Date.now } }) {
    let ctx = null;
    let live = null;
    let collection = /* @__PURE__ */ new Map();
    let historyRun = null;
    let withdrawTimer = 0;
    let ledgerWarned = false;
    const extras = /* @__PURE__ */ new Map();
    const history2 = /* @__PURE__ */ new Map();
    const state = () => store.get();
    const patch = (changes) => store.set(changes);
    const patchView = (changes) => patch({ view: { ...state().view, ...changes } });
    const patchHistory = (changes) => patch({ history: { ...state().history, ...changes } });
    const bump = () => patch({ version: state().version + 1 });
    const cardOf = (id) => ctx.catalog.get(id) ?? extras.get(id);
    function setLive(next) {
      live = next;
      ctx.chakraHeld = next.chakraHeld;
      for (const listing of [...next.mine.listings, ...next.mine.bids])
        extras.set(listing.character.id, listing.character);
    }
    function republish() {
      const liveItems = buildItems(live, ctx);
      const known = new Set(liveItems.map((item) => item.key));
      const items = [...liveItems, ...[...history2.values()].filter((item) => !known.has(item.key))];
      patch({
        items,
        summary: engagedSummary(live, ctx),
        stats: salesStats(live.mine.listings)
      });
      return items;
    }
    async function loadPrices2(items) {
      try {
        await api3.prices(cardIds(items));
        bump();
      } catch (error) {
        notify3.error(describeError(error));
      }
    }
    function syncLedger() {
      api3.syncLedger(live).catch((error) => {
        if (ledgerWarned) return;
        ledgerWarned = true;
        notify3.error(describeError(error));
      });
    }
    async function refreshLive() {
      setLive(await api3.live());
      loadPrices2(republish());
      syncLedger();
    }
    async function load() {
      patch({ phase: "loading", error: null });
      try {
        const base = await api3.context();
        collection = base.collection;
        ctx = { myId: base.myId, catalog: base.catalog, chakraHeld: 0, cardOf };
        setLive(await api3.live());
        patch({ phase: "ready" });
        loadPrices2(republish());
        syncLedger();
        loadHistory();
      } catch (error) {
        reportUnexpected(error);
        patch({ phase: "error", error: describeError(error) });
      }
    }
    let historyPageSize = config_default.activity.historyPageSize;
    async function fetchHistoryPage(kind, page) {
      try {
        return await api3.history(kind, page, historyPageSize);
      } catch (error) {
        if (historyPageSize === void 0 || !(error instanceof ApiError) || error.status !== BAD_REQUEST) throw error;
        historyPageSize = void 0;
        return api3.history(kind, page);
      }
    }
    async function loadHistoryKind(kind) {
      const loaded = [];
      for (let page = 1; page <= config_default.activity.historyMaxPages; page++) {
        const result = await fetchHistoryPage(kind, page);
        const items = historyItems(kind, result, ctx);
        for (const item of items) history2.set(item.key, item);
        loaded.push(...items);
        republish();
        if (!result.more) break;
      }
      loadPrices2(loaded);
    }
    async function runHistory() {
      patchHistory({ phase: HistoryPhase.LOADING, error: null });
      try {
        for (const kind of HISTORY_KINDS) await loadHistoryKind(kind);
        patchHistory({ phase: HistoryPhase.DONE });
      } catch (error) {
        reportUnexpected(error);
        patchHistory({ phase: HistoryPhase.ERROR, error: describeError(error) });
      }
    }
    function loadHistory() {
      if (state().history.phase === HistoryPhase.DONE) return Promise.resolve();
      historyRun ??= runHistory().finally(() => {
        historyRun = null;
      });
      return historyRun;
    }
    function setCategory(category) {
      patchView({ category, shown: config_default.activity.renderStep });
    }
    function setSort(sort) {
      writeSetting("activitySort", sort);
      patchView({ sort });
    }
    function setQuery(query2) {
      patchView({ query: query2, shown: config_default.activity.renderStep });
    }
    function toggleOpen(key) {
      const open = new Set(state().view.open);
      if (!open.delete(key)) open.add(key);
      patchView({ open });
    }
    function showMore() {
      patchView({ shown: state().view.shown + config_default.activity.renderStep });
    }
    function setNative(native) {
      patchView({ native });
    }
    function toggleLedger() {
      const ledgerOpen = !state().view.ledgerOpen;
      writeSetting("activityLedger", ledgerOpen);
      patchView({ ledgerOpen });
    }
    async function focusTrade(tradeId) {
      const key = `t:${tradeId}`;
      const find = () => state().items.find((item2) => item2.key === key);
      let item = find();
      if (!item) {
        await loadHistory();
        item = find();
      }
      if (!item) return;
      const open = new Set(state().view.open).add(key);
      patchView({
        category: "all",
        query: "",
        open,
        shown: Math.max(state().view.shown, state().items.length)
      });
      patch({ focus: { key, until: clock.now() + config_default.activity.focusMs } });
    }
    function setBusy(key, busy) {
      const next = new Set(state().busy);
      if (busy) next.add(key);
      else next.delete(key);
      patch({ busy: next });
    }
    async function reloadAfterChange() {
      try {
        const [, owned] = await Promise.all([refreshLive(), api3.reloadCollection()]);
        collection = owned;
        bump();
      } catch (error) {
        notify3.error(describeError(error));
      }
    }
    async function run(key, task, success) {
      setBusy(key, true);
      try {
        const result = await task();
        notify3.success(typeof success === "function" ? success(result) : success);
      } catch (error) {
        notify3.error(describeError(error));
      }
      await reloadAfterChange();
      setBusy(key, false);
    }
    const forTrade = (action, success) => (item) => run(item.key, () => api3.tradeAction(item.trade.id, action), success);
    const actions2 = {
      accept: forTrade("accept", "Échange accepté."),
      decline: forTrade("decline", "Échange refusé."),
      cancelTrade: forTrade("cancel", "Proposition annulée."),
      cancelOffer: (item) => run(item.key, () => api3.cancelOffer(item.offer.id), "Offre retirée."),
      cancelListing: (item) => run(item.key, () => api3.cancelListing(item.listing.id), "Vente retirée, la carte t’est revenue."),
      cancelOrder: (item) => run(item.key, () => api3.cancelOrder(item.order.id), "Ordre annulé, chakra débloqué.")
    };
    function withdrawSummary(result) {
      const total = result.listings + result.orders + result.trades + result.offers;
      if (!total) return "Rien à retirer : tu n’as rien en cours sur le marché.";
      const counts = [
        `${result.listings} ventes`,
        `${result.orders} ordres`,
        `${result.trades} échanges`,
        `${result.offers} offres`
      ].join(", ");
      const bids = result.auctionsWithBids;
      const kept = bids ? ` ${bids} enchère(s) avec mises vont jusqu’au bout.` : "";
      return `Retiré : ${counts}.${kept}`;
    }
    function withdrawAll() {
      if (!state().withdrawArmed) {
        patch({ withdrawArmed: true });
        withdrawTimer = setTimeout(() => patch({ withdrawArmed: false }), config_default.activity.withdrawConfirmMs);
        return Promise.resolve();
      }
      clearTimeout(withdrawTimer);
      patch({ withdrawArmed: false });
      return run(
        "withdraw-all",
        async () => withdrawSummary(await api3.withdrawAll()),
        (message) => message
      );
    }
    return {
      load,
      refreshLive,
      loadHistory,
      setCategory,
      setSort,
      setQuery,
      toggleOpen,
      showMore,
      setNative,
      toggleLedger,
      focusTrade,
      withdrawAll,
      actions: actions2,
      cardOf: (id) => ctx ? cardOf(id) : void 0,
      ownedOf: (id) => collection.get(id)?.qty ?? 0,
      dispose: () => clearTimeout(withdrawTimer)
    };
  }

  // src/features/market-activity/labels.js
  var KINDS = {
    sale: { kanji: "売", label: "Vente" },
    auction: { kanji: "競", label: "Enchère" },
    bid: { kanji: "札", label: "Ma mise" },
    order: { kanji: "注", label: "Ordre d’achat" },
    tradeIn: { kanji: "換", label: "Échange reçu" },
    tradeOut: { kanji: "換", label: "Échange envoyé" },
    counter: { kanji: "台", label: "Offre du tableau" }
  };
  var dayFormat = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short"
  });
  var clockFormat2 = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  var tone = (text, kind) => ({ text, tone: kind });
  var TRADE_OUTCOMES = {
    accepted: tone("Accepté", "good"),
    declined: tone("Refusé", "bad"),
    cancelled: tone("Annulé", "muted"),
    expired: tone("Expiré", "muted")
  };
  function tradeStatus(item) {
    if (item.state === State.TODO) return tone("Attend ta réponse", "warn");
    if (item.state === State.LIVE) return tone(`En attente de ${item.who.pseudo}`, "muted");
    return TRADE_OUTCOMES[item.outcome] ?? tone(item.outcome, "muted");
  }
  function boardStatus(item) {
    const names = { cancelled: "Retirée", expired: "Expirée" };
    if (item.outcome === "open") return tone("Proposée à tous", "accent");
    if (item.outcome !== "accepted") return tone(names[item.outcome] ?? item.outcome, "muted");
    return tone(item.posted ? `Prise par ${item.who?.pseudo ?? "?"}` : "Acceptée", "good");
  }
  function listingStatus(item) {
    const { listing } = item;
    if (listing.status === "active") {
      if (item.kind === "sale") return tone("En vente", "accent");
      return tone(
        listing.bidCount ? `${plural(listing.bidCount, "mise")} · ${formatChakra(listing.currentBid)}` : "Aucune mise",
        "accent"
      );
    }
    const names = {
      sold: "Vendue",
      expired: "Expirée, carte rendue",
      cancelled: "Retirée, carte rendue"
    };
    return tone(names[listing.status] ?? listing.status, listing.status === "sold" ? "good" : "muted");
  }
  function bidStatus(item) {
    if (item.state === State.TODO) return tone("Enchère dépassée", "warn");
    if (item.state === State.LIVE) return tone("Tu es en tête", "good");
    const won = item.listing.leading && item.listing.status === "sold";
    return won ? tone("Remportée", "good") : tone("Terminée", "muted");
  }
  function orderStatus(item) {
    const { order } = item;
    if (order.status === "open") return tone(`Achetées : ${order.filled} sur ${order.qty}`, "accent");
    const names = {
      filled: "Achetée",
      cancelled: "Annulé, chakra rendu",
      expired: "Expiré, chakra rendu"
    };
    return tone(names[order.status] ?? order.status, order.status === "filled" ? "good" : "muted");
  }
  function statusOf(item) {
    switch (item.kind) {
      case "tradeIn":
      case "tradeOut":
        return tradeStatus(item);
      case "counter":
        return boardStatus(item);
      case "bid":
        return bidStatus(item);
      case "order":
        return orderStatus(item);
      default:
        return listingStatus(item);
    }
  }
  function titleOf(item, cardOf) {
    const cardName = (id) => cardOf(id)?.name ?? `Carte ${id}`;
    switch (item.kind) {
      case "tradeIn":
      case "tradeOut":
        return `Avec ${item.who.pseudo}`;
      case "counter":
        return item.posted ? "Ton offre" : `Offre de ${item.who.pseudo}`;
      case "order": {
        const { qty } = item.receive.cards[0];
        return `${cardName(item.receive.cards[0].characterId)}${qty > 1 ? ` ×${qty}` : ""}`;
      }
      case "bid":
        return `${cardName(item.receive.cards[0].characterId)} · ${item.who.pseudo}`;
      default:
        return cardName(item.give.cards[0].characterId);
    }
  }
  function formatWhen(ms, now) {
    const date = new Date(ms);
    const sameDay = new Date(now).toDateString() === date.toDateString();
    const clock = clockFormat2.format(date);
    return sameDay ? `aujourd’hui ${clock}` : `${dayFormat.format(date)} ${clock}`;
  }
  function timeOf(item, now) {
    if (item.state !== State.DONE) return item.endsAt ? `expire dans ${formatRemaining(item.endsAt)}` : "";
    return item.at ? formatWhen(item.at, now) : "";
  }

  // src/features/market-activity/rows.js
  var gainTone = (net) => net > 0 ? "up" : net < 0 ? "down" : "flat";
  var missingTile = () => h("span", { class: "kp-art kp-art--md kp-art--missing", title: "Carte inconnue" }, "?");
  function ownedBadge(owned) {
    return owned > 0 ? h("span", { class: "kp-badge", title: "Exemplaires que tu as" }, `×${owned}`) : h("span", { class: "kp-badge kp-badge--new" }, "Nouveau");
  }
  function tile({ characterId, qty }, view, { name = true } = {}) {
    const card = view.cardOf(characterId);
    if (!card) return missingTile();
    const price = view.priceOf(characterId);
    return h(
      "div",
      { class: "kp-tcard", title: card.name },
      cardArt(card, "md", [ownedBadge(view.ownedOf(characterId))]),
      name ? h("strong", { class: "kp-name" }, qty > 1 ? `${card.name} ×${qty}` : card.name) : null,
      h("span", { class: "kp-price" }, price == null ? "? ◆" : formatChakra(price * qty))
    );
  }
  function sideBlock(label, side, choice, view, { all = false } = {}) {
    const entries = choice ? choice.map((characterId) => ({ characterId, qty: 1 })) : side.cards;
    const limit = all ? entries.length : config_default.activity.compactThumbLimit;
    const hidden = entries.length - limit;
    const total = choice ? null : sideValue2(side, view.priceOf);
    return h(
      "section",
      { class: "kp-act__side" },
      h("span", { class: "kp-label" }, choice ? `${label} · une au choix` : label),
      h(
        "div",
        { class: "kp-act__tiles" },
        entries.slice(0, limit).map((entry) => tile(entry, view)),
        hidden > 0 ? h("span", { class: "kp-act__more" }, `+${hidden}`) : null,
        side.chakra ? h("span", { class: "kp-act__chakra" }, formatChakra(side.chakra)) : null,
        !entries.length && !side.chakra ? h("span", { class: "kp-muted" }, "—") : null
      ),
      all && total != null ? h("span", { class: "kp-price" }, `≈ ${formatChakra(total)}`) : null
    );
  }
  function netPill(item, view) {
    const net = netOf(item, view.priceOf);
    if (net == null) return null;
    const given = sideValue2(item.give, view.priceOf);
    const received = sideValue2(item.receive, view.priceOf);
    const text = net === 0 ? "Équilibré" : `${formatGain(net)} ◆ ${net > 0 ? "gagnés" : "perdus"}`;
    return h(
      "span",
      {
        class: `kp-gain kp-gain--${gainTone(net)} kp-act__net`,
        title: `Tu reçois ≈ ${formatChakra(received)}, tu donnes ≈ ${formatChakra(given)}`
      },
      text
    );
  }
  function salePill(item) {
    if (item.kind !== "sale" && item.kind !== "auction") return null;
    const { listing } = item;
    const median = listing.prices?.median7d;
    if (!median) return null;
    const price = listing.finalPrice ?? listing.currentBid ?? listing.price;
    const gap = Math.round((price / median - 1) * 100);
    return h(
      "span",
      {
        class: `kp-gain kp-gain--${gainTone(gap)} kp-act__net`,
        title: `Prix face à la médiane des 7 derniers jours (${formatChakra(median)})`
      },
      `${gap > 0 ? "+" : ""}${gap} % face à la médiane`
    );
  }
  var link = (href, text) => h("a", { class: "kp-act__link", href }, text);
  function listingFacts(item) {
    const { listing } = item;
    const price = listing.finalPrice ?? listing.currentBid ?? listing.price;
    const facts = [[item.kind === "auction" ? "Mise de départ" : "Prix demandé", formatChakra(listing.price)]];
    if (listing.buyoutPrice) facts.push(["Achat immédiat", formatChakra(listing.buyoutPrice)]);
    if (item.kind !== "bid") {
      const label = listing.status === "sold" ? "Tu as touché" : "Tu toucheras";
      facts.push([label, `${formatChakra(netSale(price))} (taxe et frais déduits)`]);
    }
    if (listing.bidCount) {
      facts.push(["Mises", `${listing.bidCount}, la meilleure à ${formatChakra(listing.currentBid)}`]);
    }
    if (item.kind === "bid") {
      facts.push(["Ta mise maximale", formatChakra(listing.myMaxBid)]);
    }
    if (listing.prices?.median7d) {
      const sales = plural(listing.prices.sales7d, "vente");
      facts.push(["Médiane sur 7 jours", `${formatChakra(listing.prices.median7d)} · ${sales}`]);
    }
    facts.push(["Annonce", link(`/marche?annonce=${listing.id}`, "Ouvrir l’annonce")]);
    return facts;
  }
  function detailFacts(item, view) {
    const created = item.createdAt ? formatWhen(item.createdAt, view.now) : null;
    const base = [created ? ["Créé", created] : null];
    if (item.listing) return [...base, ...listingFacts(item)];
    if (item.order) {
      const { order } = item;
      return [
        ...base,
        ["Prix à l’unité", formatChakra(order.price)],
        ["Achetées", `${order.filled} sur ${order.qty}`],
        ["Chakra mis de côté", formatChakra(order.price * (order.qty - order.filled))]
      ];
    }
    const message = item.message ? ["Message", `« ${item.message} »`] : null;
    const talkHref = item.trade && `/marche?onglet=echanges&echange=${item.trade.id}&discussion=1`;
    const talk = item.trade ? ["Discussion", link(talkHref, `Ouvrir (${item.messages})`)] : null;
    return [message, talk];
  }
  function hasOverflow(item) {
    const limit = config_default.activity.compactThumbLimit;
    return [item.give.cards, item.receive.cards, item.choice ?? []].some((list) => list.length > limit);
  }
  var hasDetail = (item, view) => detailFacts(item, view).some(Boolean) || variantOf(item) === "compact" && hasOverflow(item);
  function detail(item, view) {
    const facts = detailFacts(item, view).filter(Boolean);
    return h(
      "div",
      { class: "kp-act__detail" },
      variantOf(item) === "compact" && hasOverflow(item) ? h(
        "div",
        { class: "kp-act__full" },
        sideBlock("Tu reçois", item.receive, item.choice, view, {
          all: true
        }),
        sideBlock("Tu donnes", item.give, null, view, { all: true })
      ) : null,
      h(
        "dl",
        { class: "kp-act__facts" },
        facts.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value ?? "—")])
      )
    );
  }
  function actionButtons(item, view) {
    const { actions: actions2 } = view.controller;
    const button = (label, onClick, { ghost = true, attrs = {} } = {}) => h(
      "button",
      {
        class: `kp-btn kp-btn--sm${ghost ? " kp-btn--ghost" : ""}`,
        type: "button",
        onClick: () => onClick(item),
        ...attrs
      },
      label
    );
    const open = (label, href) => h("a", { class: "kp-btn kp-btn--sm kp-btn--ghost", href }, label);
    switch (item.kind) {
      case "tradeIn":
        return item.state === State.TODO ? [button("Accepter", actions2.accept, { ghost: false }), button("Refuser", actions2.decline)] : [];
      case "tradeOut":
        return item.state === State.LIVE ? [button("Annuler", actions2.cancelTrade)] : [];
      case "counter":
        return item.state === State.LIVE ? [button("Retirer", actions2.cancelOffer)] : [];
      case "order":
        return item.state === State.LIVE ? [button("Annuler", actions2.cancelOrder)] : [];
      case "bid": {
        const href = `/marche?onglet=encheres&annonce=${item.listing.id}`;
        return item.state === State.DONE ? [] : [open(item.state === State.TODO ? "Surenchérir" : "Voir", href)];
      }
      default: {
        if (item.state !== State.LIVE) return [];
        const locked = item.kind === "auction" && item.listing.bidCount > 0;
        const attrs = locked ? {
          disabled: true,
          title: "Une enchère qui a des mises va jusqu’au bout."
        } : {};
        return [button("Retirer", actions2.cancelListing, { attrs })];
      }
    }
  }
  var VARIANTS = { tradeIn: "wide", tradeOut: "wide", counter: "compact" };
  function variantOf(item) {
    return VARIANTS[item.kind] ?? "mini";
  }
  function actions(item, view, open) {
    return h(
      "div",
      { class: "kp-act__acts" },
      actionButtons(item, view),
      hasDetail(item, view) ? h(
        "button",
        {
          class: "kp-hide kp-act__chev",
          type: "button",
          "aria-expanded": String(open),
          title: open ? "Replier" : "Détails",
          onClick: () => view.controller.toggleOpen(item.key)
        },
        icon(open ? "chevron-up" : "chevron-down")
      ) : null
    );
  }
  function toggleOnClick(item, view) {
    return (event) => {
      if (hasDetail(item, view) && !event.target.closest("a, button")) view.controller.toggleOpen(item.key);
    };
  }
  function header(item, view, ...extra) {
    const status = statusOf(item);
    const kind = KINDS[item.kind];
    const title = titleOf(item, view.cardOf);
    return h(
      "div",
      { class: "kp-act__head", onClick: toggleOnClick(item, view) },
      view.showKind ? h("span", { class: "kp-act__kind", "data-kind": item.kind, title: kind.label }, kind.kanji) : null,
      h(
        "div",
        { class: "kp-act__txt" },
        h("strong", { class: "kp-name", title }, title),
        view.showKind ? h("span", { class: "kp-label" }, kind.label) : null
      ),
      h(
        "div",
        { class: "kp-act__state" },
        h("span", { class: `kp-act__status kp-act__status--${status.tone}` }, status.text),
        h("span", { class: "kp-note" }, timeOf(item, view.now))
      ),
      extra
    );
  }
  function ownershipNotes(side, giving, view) {
    const owned = ({ characterId }) => view.ownedOf(characterId);
    const notes = giving ? [[side.cards.filter((entry) => owned(entry) <= entry.qty).length, "dernier exemplaire", "warn"]] : [
      [side.cards.filter((entry) => owned(entry) === 0).length, "nouvelle", "new"],
      [side.cards.filter((entry) => owned(entry) > 0).length, "déjà possédée", "muted"]
    ];
    return notes.filter(([count]) => count > 0).map(([count, word, tone2]) => h("span", { class: `kp-act__note kp-act__note--${tone2}` }, plural(count, word)));
  }
  function wideBox(label, side, view, { giving, live }) {
    const count = side.cards.reduce((sum, entry) => sum + entry.qty, 0);
    const total = sideValue2(side, view.priceOf);
    return h(
      "section",
      { class: "kp-act__box" },
      h(
        "header",
        { class: "kp-act__box-head" },
        h("span", { class: "kp-label" }, `${label} · ${count}`),
        live ? ownershipNotes(side, giving, view) : null,
        side.chakra ? h("span", { class: "kp-tag" }, `+ ${formatChakra(side.chakra)}`) : null,
        h("span", { class: "kp-price kp-act__box-total" }, `≈ ${formatChakra(total)}`)
      ),
      h(
        "div",
        { class: "kp-act__grid" },
        side.cards.map((entry) => tile(entry, view, { name: false }))
      )
    );
  }
  function wideBody(item, view, open) {
    const live = item.state !== State.DONE;
    return [
      header(item, view, netPill(item, view), actions(item, view, open)),
      h(
        "div",
        { class: "kp-act__boxes" },
        wideBox("Tu donnes", item.give, view, { giving: true, live }),
        h("span", { class: "kp-swap" }, icon("arrow-right-arrow-left")),
        wideBox("Tu reçois", item.receive, view, { giving: false, live })
      )
    ];
  }
  function compactBody(item, view, open) {
    return [
      header(item, view),
      h(
        "div",
        { class: "kp-act__cards" },
        sideBlock("Tu reçois", item.receive, item.choice, view),
        h("span", { class: "kp-swap" }, icon("arrow-right-arrow-left")),
        sideBlock("Tu donnes", item.give, null, view)
      ),
      h(
        "div",
        { class: "kp-act__foot" },
        h("div", { class: "kp-act__meta" }, netPill(item, view)),
        actions(item, view, open)
      )
    ];
  }
  function miniBody(item, view, open) {
    const entry = [...item.give.cards, ...item.receive.cards][0];
    const card = view.cardOf(entry.characterId);
    const status = statusOf(item);
    const title = titleOf(item, view.cardOf);
    const amount = item.give.chakra || item.receive.chakra;
    return [
      h(
        "div",
        { class: "kp-act__mini", onClick: toggleOnClick(item, view) },
        card ? cardArt(card, "sm", []) : missingTile(),
        h(
          "div",
          { class: "kp-act__txt" },
          h("strong", { class: "kp-name", title }, title),
          h(
            "span",
            { class: "kp-note" },
            view.showKind ? `${KINDS[item.kind].label} · ` : null,
            h("span", { class: `kp-act__status kp-act__status--${status.tone}` }, status.text),
            ` · ${timeOf(item, view.now)}`
          )
        ),
        h(
          "div",
          { class: "kp-act__money" },
          h("strong", { class: "kp-act__amount" }, formatChakra(amount)),
          salePill(item)
        ),
        actions(item, view, open)
      )
    ];
  }
  var BODIES = { wide: wideBody, compact: compactBody, mini: miniBody };
  function activityRow(item, view) {
    const { state } = view;
    const open = state.view.open.has(item.key);
    const focused = state.focus?.key === item.key && view.now < state.focus.until;
    const variant = variantOf(item);
    const classes = ["kp-act__row", `kp-act__row--${item.state}`, `kp-act__row--${variant}`];
    if (open) classes.push("is-open");
    if (focused) classes.push("is-focus");
    if (state.busy.has(item.key)) classes.push("is-busy");
    return h(
      "li",
      { class: classes.join(" "), id: `kp-act-${item.key}`, "data-kind": item.kind },
      BODIES[variant](item, view, open),
      open && hasDetail(item, view) ? detail(item, view) : null
    );
  }

  // src/features/market-activity/summary.js
  var SEGMENTS = [
    ["orders", "Ordres d’achat", "var(--cyan)"],
    ["tradesChakra", "Échanges envoyés", "color-mix(in srgb, var(--cyan) 62%, var(--panel))"],
    ["bids", "Enchères en tête", "color-mix(in srgb, var(--cyan) 34%, var(--panel))"],
    ["other", "En cours de règlement", "var(--line3)"]
  ];
  var signed = (value) => value > 0 ? `+${value}` : String(value);
  function lede(summary) {
    const todo = [];
    if (summary.inbox) {
      todo.push(`${plural(summary.inbox, "échange")} ${summary.inbox > 1 ? "attendent" : "attend"} ta réponse`);
    }
    if (summary.outbid) todo.push(`${plural(summary.outbid, "enchère")} dépassée${summary.outbid > 1 ? "s" : ""}`);
    return todo.length ? todo.join(" · ") : "Rien n’attend ta réponse.";
  }
  function stat(label, value, { onClick, active = false, title } = {}) {
    return h(
      onClick ? "button" : "span",
      {
        class: `kp-act__stat${active ? " is-on" : ""}`,
        type: onClick ? "button" : void 0,
        onClick,
        title
      },
      label,
      h("strong", {}, value)
    );
  }
  function ledgerBar(summary) {
    const total = SEGMENTS.reduce((sum, [key]) => sum + summary[key], 0);
    if (!total) return h("p", { class: "kp-muted" }, "Rien n’est mis de côté : tout ton chakra est disponible.");
    const used = SEGMENTS.filter(([key]) => summary[key] > 0);
    return h(
      "div",
      { class: "kp-act__ledger-bar" },
      h(
        "div",
        { class: "kp-act__bar-track" },
        used.map(
          ([key, label, color]) => h("span", {
            style: {
              width: `${summary[key] / total * 100}%`,
              background: color
            },
            title: label
          })
        )
      ),
      h(
        "ul",
        { class: "kp-act__legend" },
        used.map(
          ([key, label, color]) => h("li", {}, h("i", { style: { background: color } }), `${label} : ${formatChakra(summary[key])}`)
        )
      )
    );
  }
  function salesLine(stats) {
    if (!stats) return null;
    const parts = [
      `${plural(stats.sold, "vente")} conclues`,
      `${formatChakra(stats.net)} gagnés, taxes et frais déduits`,
      stats.vsMedian == null ? null : `prix moyen ${signed(stats.vsMedian)} % face à la médiane`,
      `meilleure vente : ${formatChakra(stats.best.finalPrice)}`
    ];
    return h("p", { class: "kp-act__sales" }, icon("chart-line"), parts.filter(Boolean).join(" · "));
  }
  function createSummary(controller) {
    const heading = h("span", { class: "kp-act__lede" });
    const stats = h("div", { class: "kp-act__stats" });
    const inline = h("div", { class: "kp-act__summary" }, heading, stats);
    const ledger = h("div", { class: "kp-act__ledger" });
    return {
      inline,
      ledger,
      render(state) {
        const { summary, items, view } = state;
        inline.hidden = !summary;
        ledger.hidden = !summary || !view.ledgerOpen;
        if (!summary) return;
        const todo = items.filter((item) => item.state === State.TODO).length;
        heading.textContent = lede(summary);
        heading.classList.toggle("is-calm", !todo);
        fill(
          stats,
          stat("Chakra engagé", formatChakra(summary.held), {
            onClick: () => controller.toggleLedger(),
            active: view.ledgerOpen,
            title: "Détail du chakra mis de côté"
          }),
          stat("Cartes bloquées 48 h", String(summary.cardsHeld), {
            title: "Cartes reçues ou achetées il y a moins de 48 h : elles ne peuvent pas encore être revendues"
          })
        );
        if (view.ledgerOpen) fill(ledger, ledgerBar(summary), salesLine(state.stats));
      }
    };
  }

  // src/features/market-activity/panel.js
  var SORT_LABELS = {
    [Sort.SOON]: "Échéance",
    [Sort.RECENT]: "Plus récents",
    [Sort.OLD]: "Plus anciens",
    [Sort.VALUE]: "Plus de valeur",
    [Sort.GAIN]: "Plus de gain"
  };
  var TABS = [{ id: "all", label: "Tout", short: "Tout", icon: "layer-group" }, ...CATEGORIES];
  var GROUP_TITLES = {
    [State.TODO]: "À traiter",
    [State.LIVE]: "En cours",
    done: "Terminés",
    "done:today": "Terminés · aujourd’hui",
    "done:yesterday": "Terminés · hier",
    "done:week": "Terminés · cette semaine",
    "done:older": "Terminés · plus ancien"
  };
  var LAYOUTS = {
    [Category.BOARD]: "board",
    [Category.SALES]: "minis",
    [Category.BIDS]: "minis",
    [Category.ORDERS]: "minis"
  };
  var WITHDRAWABLE = /* @__PURE__ */ new Set([Category.SALES, Category.ORDERS, Category.TRADES_OUT, Category.BOARD]);
  function createTab(controller, tab) {
    const count = h("span", { class: "n" });
    const button = h(
      "button",
      {
        class: "kp-act__tab",
        type: "button",
        role: "tab",
        title: tab.label,
        onClick: () => controller.setCategory(tab.id)
      },
      icon(tab.icon),
      h("span", { class: "kp-act__tab-label" }, tab.short),
      count
    );
    return { id: tab.id, button, count };
  }
  function createActivityPanel(controller, { onSell }) {
    let lastFocus = null;
    let current = null;
    const summary = createSummary(controller);
    const tabs = TABS.map((tab) => createTab(controller, tab));
    const sortSelect = h(
      "select",
      {
        class: "kp-input kp-act__sort",
        "aria-label": "Trier",
        onChange: (event) => controller.setSort(event.target.value)
      },
      Object.entries(SORT_LABELS).map(([sort, label]) => h("option", { value: sort }, label))
    );
    const search = h("input", {
      class: "kp-input kp-act__search",
      type: "search",
      placeholder: "Carte ou joueur",
      "aria-label": "Chercher dans mon activité",
      onInput: (event) => controller.setQuery(event.target.value)
    });
    const sellButton = h("button", { class: "kp-btn kp-btn--sm", type: "button", onClick: onSell }, "Vendre une carte");
    const withdrawButton = h("button", {
      class: "kp-btn kp-btn--sm kp-btn--ghost",
      type: "button",
      onClick: () => controller.withdrawAll()
    });
    const nativeButton = h("button", {
      class: "kp-btn kp-btn--sm kp-btn--ghost",
      type: "button",
      title: "Basculer entre cette vue et celle du site",
      onClick: () => controller.setNative(!current.view.native)
    });
    const toolbar = h(
      "div",
      { class: "kp-act__toolbar" },
      h(
        "div",
        { class: "kp-act__tabs", role: "tablist", "aria-label": "Catégories" },
        tabs.map(({ button }) => button)
      ),
      h("div", { class: "kp-act__tools" }, sortSelect, search, sellButton, withdrawButton)
    );
    const body = h("div", { class: "kp-act__body" });
    const bar = h(
      "div",
      { class: "kp-act__bar" },
      h("h2", { class: "kp-title" }, "Mon activité"),
      summary.inline,
      nativeButton
    );
    const content = h("div", { class: "kp-act__content" }, summary.ledger, toolbar, body);
    const root = h("section", { class: "kp-act", "aria-label": "Mon activité" }, bar, content);
    function renderToolbar(state) {
      const { view, items } = state;
      const stats = categoryStats(items);
      for (const { id, button, count } of tabs) {
        const { total, todo } = stats[id];
        button.setAttribute("aria-selected", String(view.category === id));
        button.classList.toggle("on", view.category === id);
        button.classList.toggle("is-empty", total === 0);
        button.classList.toggle("has-todo", todo > 0);
        count.textContent = String(total);
      }
      sortSelect.value = view.sort;
      if (document.activeElement !== search && search.value !== view.query) search.value = view.query;
      const withdrawable = items.filter((item) => item.state === State.LIVE && WITHDRAWABLE.has(item.category)).length;
      withdrawButton.hidden = withdrawable === 0;
      withdrawButton.classList.toggle("kp-btn--warn", state.withdrawArmed);
      withdrawButton.disabled = state.busy.has("withdraw-all");
      withdrawButton.textContent = state.withdrawArmed ? `Confirmer : retirer ${withdrawable} éléments ?` : "Tout retirer du marché";
    }
    function historyNotice({ history: history2 }) {
      if (history2.phase === HistoryPhase.DONE) return null;
      if (history2.phase === HistoryPhase.ERROR) {
        return h(
          "p",
          { class: "kp-act__notice kp-act__notice--error" },
          `Historique incomplet : ${history2.error} `,
          h(
            "button",
            {
              class: "kp-btn kp-btn--sm kp-btn--ghost",
              type: "button",
              onClick: () => controller.loadHistory()
            },
            "Réessayer"
          )
        );
      }
      return h("p", { class: "kp-act__notice" }, "Chargement de tout l’historique…");
    }
    function visibleGroups(state) {
      const { view } = state;
      const filtered = filterItems(state.items, {
        category: view.category,
        query: view.query
      });
      const groups = organize(filtered, {
        sort: view.sort,
        now: Date.now(),
        priceOf
      });
      let room = view.shown;
      const shown = groups.map((group) => {
        const slice = group.items.slice(0, Math.max(0, room));
        room -= slice.length;
        return { ...group, slice };
      });
      return {
        shown: shown.filter((group) => group.slice.length),
        total: filtered.length
      };
    }
    function renderBody(state) {
      if (state.phase === "loading") return fill(body, h("p", { class: "kp-empty" }, "Chargement de ton activité…"));
      if (state.phase === "error") {
        return fill(
          body,
          h("p", { class: "kp-empty" }, state.error),
          h("button", { class: "kp-btn", type: "button", onClick: () => controller.load() }, "Réessayer")
        );
      }
      const rowView = {
        state,
        controller,
        cardOf: controller.cardOf,
        priceOf,
        ownedOf: controller.ownedOf,
        showKind: state.view.category === "all",
        now: Date.now()
      };
      const { shown, total } = visibleGroups(state);
      const shownCount = shown.reduce((sum, group) => sum + group.slice.length, 0);
      const empty = !shown.length && state.history.phase === HistoryPhase.DONE;
      fill(
        body,
        empty ? h("p", { class: "kp-empty" }, state.view.query ? "Rien ne correspond à cette recherche." : "Rien ici.") : null,
        shown.map(
          (group) => h(
            "section",
            { class: "kp-act__group" },
            h(
              "h3",
              { class: "kp-act__group-title" },
              GROUP_TITLES[group.id],
              h("span", { class: "mono" }, String(group.items.length))
            ),
            h(
              "ul",
              { class: `kp-act__list kp-act__list--${LAYOUTS[state.view.category] ?? "rows"}` },
              group.slice.map((item) => activityRow(item, rowView))
            )
          )
        ),
        total > shownCount ? h(
          "button",
          {
            class: "kp-btn kp-btn--ghost kp-more",
            type: "button",
            onClick: () => controller.showMore()
          },
          `Voir plus (${plural(total - shownCount, "élément")})`
        ) : null,
        historyNotice(state)
      );
    }
    function scrollToFocus(state) {
      if (!state.focus || state.focus.key === lastFocus) return;
      const row = document.getElementById(`kp-act-${state.focus.key}`);
      if (!row) return;
      lastFocus = state.focus.key;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    return {
      root,
      render(state) {
        current = state;
        root.classList.toggle("is-native", state.view.native);
        nativeButton.textContent = state.view.native ? "Vue Kyara Plus" : "Vue du site";
        if (state.view.native) return;
        summary.render(state);
        renderToolbar(state);
        renderBody(state);
        scrollToFocus(state);
      }
    };
  }

  // src/features/market-activity/index.js
  var ACTIVITY_PANEL = 'main [role="tabpanel"]';
  var SECTIONS_TABLIST = '[role="tablist"][aria-label="Sections du marché"] [role="tab"]';
  var URL_WATCH_MS = 1e3;
  var NATIVE_CLASS = "kp-activity--native";
  var FIRST_CATEGORY = {
    ventes: Category.SALES,
    mises: Category.BIDS,
    ordres: Category.ORDERS,
    echanges: "all"
  };
  var notify2 = {
    success: (message) => toast(message, "success"),
    error: (message) => toast(message, "error")
  };
  var offersWarned = false;
  var boardOffers = () => tradesApi.offersMine().catch((error) => {
    if (!offersWarned) {
      offersWarned = true;
      notify2.error(`Offres du tableau indisponibles : ${describeError(error)}`);
    }
    return [];
  });
  var api2 = {
    context: async () => {
      const [{ me }, catalog, collection] = await Promise.all([meApi.bootstrap(), loadCatalog(), loadCollection()]);
      return { myId: me.id, catalog, collection };
    },
    live: async () => {
      const [mine, trades, offers, { me }] = await Promise.all([
        marketApi.mine(),
        tradesApi.mine(),
        boardOffers(),
        meApi.bootstrap()
      ]);
      return { mine, trades, offers, chakraHeld: me.chakraHeld ?? 0 };
    },
    history: (kind, page, size) => marketApi.history(kind, page, size),
    prices: (ids) => loadPrices(ids),
    tradeAction: (tradeId, action) => tradesApi.act(tradeId, action),
    cancelOffer: (offerId) => tradesApi.cancelOffer(offerId),
    cancelListing: (listingId) => marketApi.cancelListing(listingId),
    cancelOrder: (orderId) => marketApi.cancelOrder(orderId),
    withdrawAll: () => marketApi.withdrawAll(),
    reloadCollection: () => loadCollection(),
    syncLedger: (live) => loadMyId().then((myId) => syncTradeLedger(myId, { offers: live.offers, trades: live.trades }))
  };
  var openSellTab = () => [...document.querySelectorAll(SECTIONS_TABLIST)].find((tab) => tab.textContent.trim().startsWith("Vendre"))?.click();
  var market_activity_default = {
    id: "market-activity",
    matches: (url) => url.pathname === "/marche" && Object.hasOwn(FIRST_CATEGORY, url.searchParams.get("onglet")),
    mount() {
      const store = createStore(initialState2());
      const controller = createActivityController({ store, api: api2, notify: notify2 });
      const panel = createActivityPanel(controller, { onSell: openSellTab });
      let focusedTrade = null;
      document.body.classList.add("kp-activity");
      let renderTimer = 0;
      const renderNow = () => {
        clearTimeout(renderTimer);
        renderTimer = 0;
        panel.render(store.get());
      };
      const unsubscribe = store.subscribe((state) => {
        document.body.classList.toggle(NATIVE_CLASS, state.view.native);
        if (state.history.phase !== HistoryPhase.LOADING) return renderNow();
        renderTimer ||= setTimeout(renderNow, config_default.activity.loadingRenderMs);
      });
      const detach = keepAttached(panel.root, ACTIVITY_PANEL, (tabpanel, node) => tabpanel.prepend(node));
      const watchUrl = () => {
        const tradeId = new URLSearchParams(location.search).get("echange");
        if (tradeId === focusedTrade) return;
        focusedTrade = tradeId;
        if (tradeId && !store.get().view.native) controller.focusTrade(tradeId);
      };
      const urlTimer = setInterval(watchUrl, URL_WATCH_MS);
      controller.setCategory(FIRST_CATEGORY[new URLSearchParams(location.search).get("onglet")]);
      panel.render(store.get());
      controller.load().then(watchUrl);
      const stopPolling = startPolling(
        () => controller.refreshLive(),
        () => config_default.activity.refreshMs,
        (error) => toast(`Mise à jour de Mon activité arrêtée : ${describeError(error)}`, "error")
      );
      return () => {
        stopPolling();
        clearInterval(urlTimer);
        controller.dispose();
        unsubscribe();
        clearTimeout(renderTimer);
        detach();
        panel.root.remove();
        document.body.classList.remove("kp-activity", NATIVE_CLASS);
      };
    }
  };

  // src/lib/card-order.js
  var nameCollator = new Intl.Collator("fr");
  function compareCards(a, b) {
    return rarityRank(a.card.rarity) - rarityRank(b.card.rarity) || (b.price ?? -1) - (a.price ?? -1) || nameCollator.compare(a.card.name, b.card.name);
  }
  function orderElements(items) {
    [...items].sort(compareCards).forEach((item, index) => {
      const order = String(index);
      if (item.element.style.order !== order) item.element.style.order = order;
    });
  }
  function clearOrder(elements) {
    for (const element of elements) element.style.removeProperty("order");
  }
  function createSettledSorter(recheck) {
    let signature = "";
    let changedAt = 0;
    let timer = 0;
    return {
      apply(items, pricesReady) {
        const current = items.map((item) => item.card.id).join(",");
        if (current !== signature) {
          signature = current;
          changedAt = Date.now();
          clearOrder(items.map((item) => item.element));
          clearTimeout(timer);
          timer = setTimeout(recheck, config_default.sorting.settleMs);
          return;
        }
        if (pricesReady && Date.now() - changedAt >= config_default.sorting.settleMs) orderElements(items);
      },
      stop: () => clearTimeout(timer)
    };
  }

  // src/features/shelf-tiles.js
  var tileCardId = (tile2) => Number(tile2.querySelector("img")?.getAttribute("src")?.match(/\/cards\/\w+\/(\d+)\./)?.[1]);
  function renderCount(tile2, count) {
    let badge = tile2.querySelector(":scope > .kp-count");
    if (count == null) return badge?.remove();
    if (!badge) {
      badge = h("span", { class: "kp-count" });
      tile2.classList.add("kp-count-host");
      tile2.append(badge);
    }
    const text = `×${count}`;
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle("kp-count--dupe", count >= config_default.profile.duplicateMin);
  }
  function clearCounts() {
    document.querySelectorAll(".kp-count").forEach((badge) => badge.remove());
    document.querySelectorAll(".kp-count-host").forEach((tile2) => tile2.classList.remove("kp-count-host"));
  }

  // src/features/trade-dialog.js
  var SHELF = '[role="dialog"] .shelf';
  var TILE = "ul.grid button.tile";
  var DUPLICATE_MIN = config_default.profile.duplicateMin;
  var isTheirTabSelected = (shelf) => [...shelf.querySelectorAll('.tabs [role="tab"]')].findIndex((tab) => tab.getAttribute("aria-selected") === "true") === 1;
  var trade_dialog_default = {
    id: "trade-dialog",
    matches: (url) => url.pathname.startsWith("/profil/"),
    mount() {
      let collection = null;
      let catalog = null;
      let frame = 0;
      const theirCounts = /* @__PURE__ */ new Map();
      const active = /* @__PURE__ */ new Set();
      let pricesFailed = false;
      const sorter = createSettledSorter(() => schedule());
      const requestPrices = createPriceRequester(
        () => schedule(),
        (error) => {
          pricesFailed = true;
          schedule();
          toast(describeError(error), "error");
        }
      );
      function orderTiles(shelf, tiles) {
        const items = tiles.map((tile2) => ({ tile: tile2, card: catalog?.get(tileCardId(tile2)) })).filter((item) => item.card && item.tile.closest("li"));
        requestPrices(items.map((item) => item.card.id));
        const allLoaded = Boolean(catalog) && !shelf.querySelector("button.more");
        const ready = allLoaded && (pricesFailed || items.every((item) => isPriceLoaded(item.card.id)));
        const ordered = items.map(({ tile: tile2, card }) => ({ element: tile2.closest("li"), card, price: priceOf(card.id) }));
        sorter.apply(ordered, ready);
      }
      const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      };
      function countsOf(userId2) {
        if (!theirCounts.has(userId2)) {
          theirCounts.set(userId2, null);
          tradesApi.availableFrom(userId2).then((rows) => {
            theirCounts.set(userId2, new Map(rows.map((row) => [row.characterId, row.n])));
            schedule();
          }).catch((error) => {
            theirCounts.delete(userId2);
            toast(describeError(error), "error");
          });
        }
        return theirCounts.get(userId2);
      }
      const myQty = (id) => collection?.get(id)?.qty ?? 0;
      const mySpares = (id) => {
        const entry = collection?.get(id);
        return entry ? Math.min(entry.listable ?? 0, entry.qty - 1) : 0;
      };
      const filters = {
        mine: [
          { key: "myDuplicates", label: "Mes doubles", keep: ({ id }) => mySpares(id) > 0 },
          { key: "theyLack", label: "Il lui manque", keep: ({ tile: tile2 }) => Boolean(tile2.querySelector(".lack")) }
        ],
        theirs: [
          { key: "theirDuplicates", label: "Ses doubles", keep: ({ count }) => count >= DUPLICATE_MIN },
          { key: "iLack", label: "Il me manque", keep: ({ id }) => myQty(id) === 0 }
        ]
      };
      const chips = Object.fromEntries(
        Object.entries(filters).map(([tab, list]) => [
          tab,
          list.map((filter) => {
            const chip = h("button", { type: "button", "data-kp-filter": filter.key, "aria-pressed": "false" }, filter.label);
            chip.addEventListener("click", () => {
              if (active.has(filter.key)) active.delete(filter.key);
              else active.add(filter.key);
              chip.classList.toggle("on", active.has(filter.key));
              chip.setAttribute("aria-pressed", String(active.has(filter.key)));
              schedule();
            });
            return chip;
          })
        ])
      );
      function placeChips(shelf, tab) {
        const row = shelf.querySelector(".chips");
        if (!row) return;
        const siteChips = [...row.querySelectorAll("button.only:not([data-kp-filter])")];
        siteChips.filter((chip) => chip.classList.contains("on")).forEach((chip) => chip.click());
        siteChips.forEach((chip) => chip.classList.add("kp-site-only"));
        const baseClass = (siteChips[0]?.className ?? "only").replace(/\b(on|kp-site-only)\b/g, "").trim();
        for (const [key, list] of Object.entries(chips)) if (key !== tab) list.forEach((chip) => chip.remove());
        const tabChips = chips[tab];
        if (tabChips.every((chip) => chip.parentElement === row)) return;
        tabChips.forEach((chip) => chip.className = `${baseClass}${active.has(chip.dataset.kpFilter) ? " on" : ""}`);
        row.prepend(...tabChips);
      }
      function decorate2() {
        const shelf = document.querySelector(SHELF);
        if (!shelf) return;
        const tab = isTheirTabSelected(shelf) ? "theirs" : "mine";
        const counts = tab === "theirs" ? countsOf(profileIdFromPath()) : collection && new Map([...collection].map(([id, entry]) => [id, entry.qty]));
        const activeFilters = filters[tab].filter((filter) => active.has(filter.key));
        placeChips(shelf, tab);
        shelf.querySelector("button.more")?.click();
        const tiles = [...shelf.querySelectorAll(TILE)];
        for (const tile2 of tiles) {
          const id = tileCardId(tile2);
          const count = counts ? counts.get(id) ?? 0 : null;
          renderCount(tile2, count);
          const hidden = count != null && activeFilters.some((filter) => !filter.keep({ id, tile: tile2, count }));
          tile2.closest("li")?.classList.toggle("kp-filtered-out", hidden);
        }
        orderTiles(shelf, tiles);
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
      Promise.all([loadCollection(), loadCatalog()]).then(([loadedCollection, loadedCatalog]) => {
        collection = loadedCollection;
        catalog = loadedCatalog;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        sorter.stop();
        clearOrder(document.querySelectorAll(`${SHELF} ul.grid > li`));
        Object.values(chips).flat().forEach((chip) => chip.remove());
        document.querySelectorAll(".kp-site-only").forEach((chip) => chip.classList.remove("kp-site-only"));
        clearCounts();
      };
    }
  };

  // src/features/market-offers/analysis.js
  var GIVABLE = /* @__PURE__ */ new Set([GiveStatus.AVAILABLE, GiveStatus.PINNED]);
  var OWNED = /* @__PURE__ */ new Set([GiveStatus.AVAILABLE, GiveStatus.PINNED, GiveStatus.BLOCKED]);
  var BANGER_MAX_RANK = rarityRank("L");
  var Filter = {
    TRADEABLE: "tradeable",
    DOUBLES: "doubles",
    MISSING: "missing",
    WISHED: "wished"
  };
  var gainKey = (gain) => gain ?? Number.NEGATIVE_INFINITY;
  var descending = (a, b) => a === b ? 0 : a < b ? 1 : -1;
  var isGivable = (option) => GIVABLE.has(option.status);
  var isDouble = (option) => option.status === GiveStatus.AVAILABLE && option.entry.qty >= 2;
  function bestOption(options, predicate) {
    return options.filter(predicate).sort((a, b) => descending(gainKey(a.gain), gainKey(b.gain)))[0] ?? null;
  }
  function analyzeOffer(offer, { catalog, collection, wishlist, priceOf: priceOf2 }) {
    const received = catalog.get(offer.characterId);
    if (!received) return null;
    const receivedPrice = priceOf2(received.id);
    const options = offer.wantIds.map((id) => ({ card: catalog.get(id), entry: collection.get(id), price: priceOf2(id) })).filter((option) => option.card).map((option) => ({
      ...option,
      status: giveStatus(option.entry),
      gain: receivedPrice != null && option.price != null ? receivedPrice - option.price : null
    })).sort((a, b) => descending(gainKey(a.gain), gainKey(b.gain)));
    return {
      offer,
      received,
      receivedPrice,
      owned: collection.get(received.id)?.qty ?? 0,
      wished: wishlist.has(received.id),
      options,
      bestAvailable: bestOption(options, (option) => option.status === GiveStatus.AVAILABLE)
    };
  }
  var FILTER_TESTS = {
    [Filter.TRADEABLE]: (analysis) => analysis.bestAvailable !== null,
    [Filter.DOUBLES]: (analysis) => analysis.options.some(isDouble),
    [Filter.MISSING]: (analysis) => analysis.owned === 0,
    [Filter.WISHED]: (analysis) => analysis.wished
  };
  var hasOwnedOption = (analysis) => analysis.options.some((option) => OWNED.has(option.status));
  var byBoardPriority = (a, b) => Number(b.wished) - Number(a.wished) || rarityRank(a.received.rarity) - rarityRank(b.received.rarity) || descending(gainKey(a.bestAvailable?.gain), gainKey(b.bestAvailable?.gain));
  var cardMatches = (card, query2) => searchKey(card.name).includes(query2) || searchKey(card.series ?? "").includes(query2);
  var matchesSearch = (analysis, query2) => !query2 || cardMatches(analysis.received, query2) || analysis.options.some((option) => cardMatches(option.card, query2));
  function boardOffers2(analyses, activeFilters, rarities, search = "") {
    const tests = [...activeFilters].map((filter) => FILTER_TESTS[filter]);
    const query2 = searchKey(search.trim());
    return analyses.filter(
      (analysis) => rarities.has(analysis.received.rarity) && hasOwnedOption(analysis) && tests.every((test) => test(analysis)) && matchesSearch(analysis, query2)
    ).sort(byBoardPriority);
  }
  var newFirst = (a, b) => Number(b.analysis.isNew) - Number(a.analysis.isNew);
  var byDealPriority = (a, b) => newFirst(a, b) || rarityRank(a.analysis.received.rarity) - rarityRank(b.analysis.received.rarity) || descending(gainKey(a.option.gain), gainKey(b.option.gain));
  function dealsPerOffer(analyses, qualifies, compareOffers) {
    return analyses.map(
      (analysis) => analysis.options.filter((option) => qualifies(analysis, option)).sort((a, b) => descending(gainKey(a.gain), gainKey(b.gain))).map((option) => ({ analysis, option }))
    ).filter((deals) => deals.length > 0).sort((a, b) => compareOffers(a[0], b[0])).flat();
  }
  var bangerDeals = (analyses) => dealsPerOffer(
    analyses,
    (analysis, option) => {
      const rank = rarityRank(analysis.received.rarity);
      return rank <= BANGER_MAX_RANK && isGivable(option) && rarityRank(option.card.rarity) > rank;
    },
    byDealPriority
  );
  var gainDeals = (analyses, minGain) => dealsPerOffer(
    analyses,
    (analysis, option) => isGivable(option) && option.gain != null && option.gain >= minGain,
    (a, b) => newFirst(a, b) || descending(a.option.gain, b.option.gain)
  );
  function bestDealPerOffer(deals) {
    const seen = /* @__PURE__ */ new Set();
    return deals.filter(({ analysis }) => !seen.has(analysis.offer.id) && seen.add(analysis.offer.id));
  }
  var ruleKey = (giveRarity, receiveRarity) => `${giveRarity}>${receiveRarity}`;
  function autoAcceptOption(analysis, { rules, doublesOnly, minGain }) {
    const ruleMatches = (option) => rules.has(ruleKey(option.card.rarity, analysis.received.rarity)) || minGain != null && option.gain != null && option.gain >= minGain;
    const matches2 = (option) => option.status === GiveStatus.AVAILABLE && !option.entry.pinned && ruleMatches(option);
    const double = bestOption(analysis.options, (option) => matches2(option) && isDouble(option));
    return double ?? (doublesOnly ? null : bestOption(analysis.options, matches2));
  }
  var hasAutoRule = ({ rules, minGain }) => rules.size > 0 || minGain != null;
  function autoAcceptCandidates(analyses, settings) {
    if (!hasAutoRule(settings)) return [];
    return analyses.flatMap((analysis) => {
      const option = autoAcceptOption(analysis, settings);
      return option ? [{ analysis, option }] : [];
    }).sort(byDealPriority);
  }

  // src/data/fair-play.js
  var loadFairPlay = (userId2) => fairPlayApi.withPlayer(userId2);
  function receiveLeft(fair) {
    if (!fair.enabled) return null;
    return { gifts: fair.myReceivedLeft, freeGaps: fair.myFreeLeft, hours: fair.receivedDays * 24 };
  }
  var HOUR_MS = 36e5;
  function tradeImpact({ given, received }, { freeRatio, ignoreBelow }) {
    const high = Math.max(given, received);
    const low = Math.min(given, received);
    const gap = high - low;
    if (gap < ignoreBelow) return null;
    const gift = Math.max(0, Math.round(high - freeRatio * low));
    return { toMe: received > given, gap, gift, free: gap - gift };
  }
  function upcomingReleases(entries, fair, { now, direction, partnerId = null }) {
    const windowMs = (direction === "received" ? fair.receivedDays : fair.pairDays) * HOUR_MS * 24;
    return entries.map((entry) => ({ entry, impact: tradeImpact(entry, fair) })).filter(({ entry, impact }) => impact && impact.toMe === (direction === "received")).filter(({ entry }) => !partnerId || entry.partner.id === partnerId).map(({ entry, impact }) => ({
      at: entry.at + windowMs,
      approximate: entry.approximate,
      partner: entry.partner,
      gift: impact.gift,
      free: impact.free
    })).filter((release) => release.at > now).sort((a, b) => a.at - b.at);
  }

  // src/data/wishlist.js
  async function loadWishlist() {
    const { wishlist } = await meApi.bootstrap();
    return new Set(wishlist ?? []);
  }

  // src/features/market-offers/auto-accept.js
  var MINUTE_MS = 6e4;
  var initialAutoState = () => ({
    enabled: false,
    rules: new Set(readSetting("autoRules", [])),
    doublesOnly: readSetting("autoDoublesOnly", true),
    gainEnabled: readSetting("autoGainEnabled", false),
    minGain: readSetting("autoMinGain", config_default.autoAccept.defaultMinGain),
    log: [],
    stopReason: null,
    giftLimited: 0
  });
  var autoSettings = ({ rules, doublesOnly, gainEnabled, minGain }) => ({
    rules,
    doublesOnly,
    minGain: gainEnabled ? minGain : null
  });
  function createAutoAccept(store, { take, currentAnalyses }) {
    const tried = /* @__PURE__ */ new Set();
    const acceptedAt = [];
    let running = false;
    const auto = () => store.get().auto;
    const patch = (changes) => store.set({ auto: { ...auto(), ...changes } });
    async function waitForRateLimit() {
      for (; ; ) {
        while (acceptedAt.length && Date.now() - acceptedAt[0] >= MINUTE_MS) acceptedAt.shift();
        if (acceptedAt.length < config_default.autoAccept.maxPerMinute) return;
        await sleep(acceptedAt[0] + MINUTE_MS - Date.now());
      }
    }
    const nextCandidate = () => autoAcceptCandidates(currentAnalyses(), autoSettings(auto())).find((deal) => !tried.has(deal.analysis.offer.id));
    function stop(reason) {
      patch({ enabled: false, stopReason: reason });
      toast(`Auto-accept arrêté : ${reason}`, "error");
    }
    function skipGiftLimited(error) {
      if (!auto().giftLimited) toast(`Auto-accept : offre ignorée. ${describeError(error)}`, "error");
      patch({ giftLimited: auto().giftLimited + 1 });
    }
    async function acceptDeal({ analysis, option }) {
      tried.add(analysis.offer.id);
      try {
        await take(analysis, option);
      } catch (error) {
        if (isGiftLimit(error)) skipGiftLimited(error);
        else if (!isGone(error)) stop(describeError(error));
        return;
      }
      acceptedAt.push(Date.now());
      const entry = { id: analysis.offer.id, received: analysis.received, given: option.card, at: Date.now() };
      patch({ log: [entry, ...auto().log].slice(0, config_default.autoAccept.logLimit) });
      toast(`Auto-accept : ${analysis.received.name} reçue contre ${option.card.name}.`, "success");
    }
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (auto().enabled) {
          await waitForRateLimit();
          const deal = auto().enabled ? nextCandidate() : null;
          if (!deal) break;
          await acceptDeal(deal);
          await sleep(config_default.autoAccept.gapMs + jitter(config_default.autoAccept.gapMs));
        }
      } finally {
        running = false;
      }
    }
    function setEnabled(enabled) {
      patch({ enabled, stopReason: null, giftLimited: 0 });
      if (enabled) drain();
    }
    function toggleRule(key) {
      const rules = new Set(auto().rules);
      if (rules.has(key)) rules.delete(key);
      else rules.add(key);
      writeSetting("autoRules", [...rules]);
      patch({ rules });
      drain();
    }
    function setDoublesOnly(doublesOnly) {
      writeSetting("autoDoublesOnly", doublesOnly);
      patch({ doublesOnly });
      drain();
    }
    function setGainRule({ gainEnabled = auto().gainEnabled, minGain = auto().minGain }) {
      writeSetting("autoGainEnabled", gainEnabled);
      writeSetting("autoMinGain", minGain);
      patch({ gainEnabled, minGain });
      drain();
    }
    return {
      consider: drain,
      setEnabled,
      toggleRule,
      setDoublesOnly,
      setGainRule,
      stop: () => patch({ enabled: false })
    };
  }

  // src/features/market-offers/controller.js
  var SERVER_FILTERS = {
    [Filter.DOUBLES]: "doubles",
    [Filter.MISSING]: "missing",
    [Filter.WISHED]: "wished"
  };
  var Phase2 = {
    IDLE: "idle",
    LOADING: "loading",
    READY: "ready",
    ERROR: "error"
  };
  var initialState3 = () => ({
    phase: Phase2.IDLE,
    scanned: 0,
    error: null,
    analyses: [],
    hiddenCount: 0,
    busy: /* @__PURE__ */ new Set(),
    live: true,
    fair: null,
    auto: initialAutoState()
  });
  var pinBusyKey = (card) => `pin:${card.id}`;
  var cardIdsOf = (offers) => offers.flatMap((offer) => [offer.characterId, ...offer.wantIds]);
  function createOffersController(store) {
    let context = null;
    let offers = [];
    let found = /* @__PURE__ */ new Map();
    let generation = 0;
    const takenIds = /* @__PURE__ */ new Set();
    const scannedFilters = /* @__PURE__ */ new Set();
    const hiddenIds = /* @__PURE__ */ new Set();
    const arrivedAt = /* @__PURE__ */ new Map();
    let stopPolling = null;
    const isOpen = (offer, now) => !hiddenIds.has(offer.id) && Date.parse(offer.expiresAt) > now;
    const isNew = (offer, now) => now - (arrivedAt.get(offer.id) ?? -Infinity) < config_default.live.newBadgeMs;
    function publish(extra = {}) {
      const now = Date.now();
      store.set({
        ...extra,
        hiddenCount: hiddenIds.size,
        analyses: offers.filter((offer) => isOpen(offer, now)).map((offer) => {
          const analysis = analyzeOffer(offer, context);
          return analysis && { ...analysis, isNew: isNew(offer, now) };
        }).filter(Boolean)
      });
    }
    const auto = createAutoAccept(store, { take: takeOffer, currentAnalyses: () => store.get().analyses });
    let fairReadAt = 0;
    async function refreshFairPlay() {
      const partner = offers.find((offer) => offer.user?.id)?.user.id;
      if (!partner) return;
      fairReadAt = Date.now();
      try {
        const [fair, entries] = await Promise.all([loadFairPlay(partner), loadMyId().then(syncTradeLedger)]);
        const left = receiveLeft(fair);
        const releases = upcomingReleases(entries, fair, { now: Date.now(), direction: "received" });
        store.set({ fair: left && { ...left, releases } });
      } catch (error) {
        toast(describeError(error), "error");
      }
    }
    const fairPlayIsStale = () => Date.now() - fairReadAt > config_default.fairPlay.refreshMs * rush();
    function hide(offerId) {
      hiddenIds.add(offerId);
      publish();
    }
    function showHidden() {
      hiddenIds.clear();
      publish();
    }
    function setBusy(key, busy) {
      const next = new Set(store.get().busy);
      if (busy) next.add(key);
      else next.delete(key);
      store.set({ busy: next });
    }
    async function scanPages(query2, scanGeneration = generation) {
      const isStale = () => scanGeneration !== generation;
      for (let page = 1; page <= config_default.offers.maxPages && !isStale(); page++) {
        const { items, more } = await tradesApi.searchOffers({
          ...query2,
          page,
          pageSize: config_default.offers.pageSize,
          takeable: true
        });
        if (isStale()) return;
        const fresh = items.filter((offer) => offer.status === "open" && !found.has(offer.id));
        await loadPrices(cardIdsOf(fresh));
        if (isStale()) return;
        for (const offer of fresh) found.set(offer.id, offer);
        offers = [...found.values()].filter((offer) => !takenIds.has(offer.id));
        publish({ scanned: found.size });
        auto.consider();
        if (!more) break;
      }
    }
    function scanFilter(filter) {
      const param = SERVER_FILTERS[filter];
      if (!param || scannedFilters.has(filter)) return Promise.resolve();
      scannedFilters.add(filter);
      return scanPages({ [param]: 1 });
    }
    async function scanOffers(catalog, filters, scanGeneration) {
      for (const filter of filters) await scanFilter(filter);
      for (const rarity of config_default.offers.priorityRarities) {
        const ids = [...catalog.values()].filter((card) => card.rarity === rarity).map((card) => card.id);
        for (const batch of chunk(ids, config_default.offers.idsPerQuery)) await scanPages({ ids: batch }, scanGeneration);
      }
      await scanPages({}, scanGeneration);
    }
    function focus(filter) {
      if (!context) return;
      scanFilter(filter).catch((error) => toast(describeError(error), "error"));
    }
    async function refreshCollection() {
      try {
        context.collection = await loadCollection();
        publish();
      } catch (error) {
        toast(describeError(error), "error");
      }
    }
    function dropOffer(offerId) {
      takenIds.add(offerId);
      offers = offers.filter((offer) => offer.id !== offerId);
      publish();
    }
    async function load(filters = []) {
      const loadGeneration = ++generation;
      found = /* @__PURE__ */ new Map();
      scannedFilters.clear();
      store.set({ phase: Phase2.LOADING, scanned: 0, error: null });
      try {
        const [catalog, collection, wishlist] = await Promise.all([loadCatalog(), loadCollection(), loadWishlist()]);
        if (loadGeneration !== generation) return;
        context = { catalog, collection, wishlist, priceOf };
        startLive();
        await scanOffers(catalog, filters, loadGeneration);
        if (loadGeneration === generation) store.set({ phase: Phase2.READY });
        auto.consider();
      } catch (error) {
        if (loadGeneration === generation) store.set({ phase: Phase2.ERROR, error: describeError(error) });
      }
    }
    function announce(fresh) {
      const freshIds = new Set(fresh.map((offer) => offer.id));
      const analyses = store.get().analyses.filter((analysis) => freshIds.has(analysis.offer.id));
      const bangers = bestDealPerOffer(bangerDeals(analyses));
      const bangerIds = new Set(bangers.map((deal) => deal.analysis.offer.id));
      const gains = bestDealPerOffer(gainDeals(analyses, readSetting("minGain", config_default.side.defaultMinGain))).filter(
        (deal) => !bangerIds.has(deal.analysis.offer.id)
      );
      const describe = (kind, { analysis, option }) => `Nouvelle offre ${kind} : ${analysis.received.name} contre ${option.card.name}.`;
      const messages = [
        ...bangers.map((deal) => describe("banger", deal)),
        ...gains.map((deal) => describe("rentable", deal))
      ];
      if (messages.length > config_default.live.maxToasts) {
        toast(`${messages.length} nouvelles offres intéressantes, en haut de la liste.`, "success");
      } else {
        messages.forEach((message) => toast(message, "success"));
      }
    }
    async function pollNewOffers() {
      if (fairPlayIsStale()) await refreshFairPlay();
      const fresh = await fetchNewOffers((id) => found.has(id) || takenIds.has(id));
      if (fresh.length === 0) return;
      const now = Date.now();
      for (const offer of fresh) {
        found.set(offer.id, offer);
        arrivedAt.set(offer.id, now);
      }
      offers = [...found.values()].filter((offer) => !takenIds.has(offer.id));
      publish({ scanned: found.size });
      auto.consider();
      await loadPrices(cardIdsOf(fresh));
      publish();
      auto.consider();
      announce(fresh);
    }
    const pollBaseMs = () => store.get().auto.enabled ? config_default.live.autoPollMs : config_default.live.pollMs;
    function startLive() {
      if (stopPolling) return;
      stopPolling = startPolling(pollNewOffers, pollBaseMs, (error) => {
        stopPolling = null;
        store.set({ live: false });
        toast(`Suivi en direct arrêté : ${describeError(error)} Clique sur « Actualiser » pour le relancer.`, "error");
      });
      store.set({ live: true });
    }
    async function takeOffer({ offer }, { card }) {
      setBusy(offer.id, true);
      try {
        await tradesApi.acceptOffer(offer.id, card.id);
      } catch (error) {
        if (isGone(error)) dropOffer(offer.id);
        throw error;
      } finally {
        setBusy(offer.id, false);
      }
      dropOffer(offer.id);
      await refreshCollection();
      await refreshFairPlay();
    }
    async function give(analysis, option) {
      try {
        await takeOffer(analysis, option);
      } catch (error) {
        toast(describeError(error), "error");
        return;
      }
      toast(`Échange fait : ${analysis.received.name} contre ${option.card.name}.`, "success");
    }
    function dispose() {
      generation++;
      stopPolling?.();
      auto.stop();
    }
    async function unlock(card) {
      setBusy(pinBusyKey(card), true);
      try {
        await unpinCard(card.id);
      } catch (error) {
        toast(describeError(error), "error");
        return;
      } finally {
        setBusy(pinBusyKey(card), false);
      }
      toast(`${card.name} déverrouillée.`, "success");
      await refreshCollection();
    }
    return {
      load,
      focus,
      give,
      unlock,
      hide,
      showHidden,
      dispose,
      setAuto: auto.setEnabled,
      toggleAutoRule: auto.toggleRule,
      setAutoDoublesOnly: auto.setDoublesOnly,
      setAutoGainRule: auto.setGainRule
    };
  }

  // src/features/market-offers/board.js
  var FILTER_LABELS = [
    [Filter.TRADEABLE, "Échangeables"],
    [Filter.DOUBLES, "Avec mes doublons"],
    [Filter.MISSING, "Cartes que je n’ai pas"],
    [Filter.WISHED, "Ma wishlist"]
  ];
  var WISHLIST_GROUP = "wishlist";
  function statusText2(state, count) {
    if (state.phase === Phase2.LOADING) return `Analyse des offres… ${formatNumber(state.scanned)}`;
    if (state.phase === Phase2.ERROR) return state.error;
    if (state.phase === Phase2.READY) return plural(count, "offre");
    return "";
  }
  function groupOffers(analyses) {
    const groups = /* @__PURE__ */ new Map();
    for (const analysis of analyses) {
      const key = analysis.wished ? WISHLIST_GROUP : analysis.received.rarity;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(analysis);
    }
    return [...groups];
  }
  function optionAction(analysis, option, controller) {
    switch (option.status) {
      case GiveStatus.AVAILABLE:
        return giveButton(option, () => controller.give(analysis, option));
      case GiveStatus.BLOCKED:
        return blockedTag(option.entry);
      default:
        return null;
    }
  }
  function optionTile(analysis, option, controller) {
    return h(
      "div",
      { class: `kp-option kp-option--${option.status}` },
      cardArt(option.card, "md", optionOverlays(option)),
      h("strong", { class: "kp-name", title: option.card.name }, option.card.name),
      h("span", { class: "kp-price" }, formatPrice(option.price)),
      ownershipNote(option.entry),
      optionAction(analysis, option, controller)
    );
  }
  function receivedNote({ owned, wished }) {
    if (wished) return h("span", { class: "kp-note kp-note--wish" }, owned ? `Wishlist · tu en as ${owned}` : "Wishlist · nouvelle");
    return h("span", { class: owned ? "kp-note" : "kp-note kp-note--new" }, owned ? `Tu en as ${owned}` : "Nouvelle carte");
  }
  function offerRow(analysis, busy, controller) {
    const { offer, received, receivedPrice, options } = analysis;
    return h(
      "article",
      { class: `kp-offer${busy.has(offer.id) ? " is-busy" : ""}` },
      h(
        "div",
        { class: "kp-offer__get" },
        h("span", { class: "kp-label" }, "Tu reçois"),
        cardArt(received, "lg"),
        h("strong", { class: "kp-name", title: received.name }, received.name),
        h("span", { class: "kp-price" }, formatPrice(receivedPrice)),
        receivedNote(analysis),
        h("span", { class: "kp-note" }, `${offer.user?.pseudo ?? "?"} · ${formatRemaining(offer.expiresAt)}`)
      ),
      swapIcon(),
      h(
        "div",
        { class: "kp-offer__give" },
        h("span", { class: "kp-label" }, "Tu donnes l’une de ces cartes"),
        h("div", { class: "kp-options" }, options.map((option) => optionTile(analysis, option, controller)))
      ),
      hideButton(() => controller.hide(offer.id))
    );
  }
  function offerGroup(key, analyses, busy, controller) {
    const isWishlist = key === WISHLIST_GROUP;
    const title = isWishlist ? "Wishlist" : RARITY_LABELS[key] ?? key;
    return h(
      "section",
      { class: "kp-group", style: { "--kp-rarity": isWishlist ? "var(--wish)" : rarityColor(key) } },
      h("h3", { class: "kp-group__title" }, `${title} · ${analyses.length}`),
      analyses.map((analysis) => offerRow(analysis, busy, controller))
    );
  }
  function createBoard(controller, { onPropose }) {
    let visibleCount = config_default.offers.renderStep;
    const activeFilters = new Set(readSetting("offerFilters", [Filter.TRADEABLE]));
    const activeRarities = new Set(readSetting("offerRarities", RARITIES));
    let lastState = null;
    let search = "";
    const status = h("p", { class: "kp-muted" });
    const list = h("div", { class: "kp-board__list" });
    const showHiddenButton = h("button", { class: "kp-btn kp-btn--ghost", type: "button", onClick: () => controller.showHidden() });
    const rerender = () => lastState && render(lastState);
    function toggleFilter(filter, chip) {
      if (activeFilters.has(filter)) activeFilters.delete(filter);
      else activeFilters.add(filter);
      chip.setAttribute("aria-pressed", String(activeFilters.has(filter)));
      writeSetting("offerFilters", [...activeFilters]);
      if (activeFilters.has(filter)) controller.focus(filter);
      visibleCount = config_default.offers.renderStep;
      rerender();
    }
    const filterChips = FILTER_LABELS.map(([filter, label]) => {
      const chip = h("button", { class: "kp-chip", type: "button", "aria-pressed": String(activeFilters.has(filter)) }, label);
      chip.addEventListener("click", () => toggleFilter(filter, chip));
      return chip;
    });
    const rarityChips = [...RARITIES].reverse().map((rarity) => {
      const chip = h(
        "button",
        {
          class: "kp-gem-chip",
          type: "button",
          title: RARITY_LABELS[rarity],
          style: { "--kp-rarity": rarityColor(rarity) },
          "aria-pressed": String(activeRarities.has(rarity))
        },
        rarity
      );
      chip.addEventListener("click", () => {
        if (activeRarities.has(rarity)) activeRarities.delete(rarity);
        else activeRarities.add(rarity);
        chip.setAttribute("aria-pressed", String(activeRarities.has(rarity)));
        writeSetting("offerRarities", [...activeRarities]);
        visibleCount = config_default.offers.renderStep;
        rerender();
      });
      return chip;
    });
    const searchInput = h("input", {
      class: "kp-input kp-board__search",
      type: "search",
      placeholder: "Personnage ou série…",
      "aria-label": "Rechercher un personnage ou une série",
      onInput: (event) => {
        search = event.target.value;
        visibleCount = config_default.offers.renderStep;
        rerender();
      }
    });
    const root = h(
      "section",
      { class: "kp-board", "aria-label": "Échanges" },
      h(
        "header",
        { class: "kp-board__bar" },
        h("div", { class: "kp-board__heading" }, h("h2", { class: "kp-title" }, "Échanges"), status),
        h(
          "div",
          { class: "kp-board__actions" },
          showHiddenButton,
          h("button", { class: "kp-btn", type: "button", onClick: onPropose }, "Proposer une carte"),
          h("button", { class: "kp-btn kp-btn--ghost", type: "button", onClick: () => controller.load([...activeFilters]) }, "Actualiser")
        )
      ),
      h(
        "div",
        { class: "kp-filters", role: "group", "aria-label": "Filtres" },
        searchInput,
        filterChips,
        h("div", { class: "kp-field kp-filters__rarities", role: "group", "aria-label": "Raretés" }, rarityChips)
      ),
      list
    );
    const showMore = () => {
      visibleCount += config_default.offers.renderStep;
      rerender();
    };
    function render(state) {
      lastState = state;
      const offers = boardOffers2(state.analyses, activeFilters, activeRarities, search);
      const visible = offers.slice(0, visibleCount);
      status.textContent = statusText2(state, offers.length);
      showHiddenButton.hidden = state.hiddenCount === 0;
      showHiddenButton.textContent = `Réafficher les masquées (${state.hiddenCount})`;
      if (state.phase === Phase2.READY && offers.length === 0) {
        list.replaceChildren(h("p", { class: "kp-empty" }, "Aucune offre avec ces filtres."));
        return;
      }
      const groups = groupOffers(visible).map(([key, group]) => offerGroup(key, group, state.busy, controller));
      if (offers.length > visible.length) {
        groups.push(h("button", { class: "kp-btn kp-btn--ghost kp-more", type: "button", onClick: showMore }, "Voir plus d’offres"));
      }
      list.replaceChildren(...groups);
    }
    return { root, render, filters: () => [...activeFilters] };
  }

  // src/features/market-offers/auto-panel.js
  var RECEIVED = RARITIES.slice(0, -1);
  var GIVEN = RARITIES.slice(1).reverse();
  var timeFormat2 = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  function statusText3({ auto, live }) {
    const parts = [live ? "En direct" : "Suivi en direct arrêté"];
    if (auto.enabled) parts.push(`auto-accept actif, ${plural(auto.log.length, "échange")}`);
    else if (auto.stopReason) parts.push(`auto-accept arrêté : ${auto.stopReason}`);
    else if (!hasAutoRule(autoSettings(auto))) parts.push("coche les échanges à accepter tout seul");
    if (auto.giftLimited) parts.push(`ignorées (limite de dons) : ${plural(auto.giftLimited, "offre")}`);
    return parts.join(" · ");
  }
  function logRow2({ received, given, at }) {
    return h(
      "div",
      { class: "kp-deal" },
      cardArt(received, "sm"),
      swapIcon(),
      cardArt(given, "sm"),
      h(
        "div",
        { class: "kp-deal__info" },
        h("strong", { class: "kp-name", title: received.name }, received.name),
        h("span", { class: "kp-note", title: given.name }, `contre ${given.name} · ${timeFormat2.format(at)}`)
      )
    );
  }
  function createAutoPanel(controller) {
    const cells = /* @__PURE__ */ new Map();
    const cell = (give, receive) => {
      if (rarityRank(give) <= rarityRank(receive)) return null;
      const key = ruleKey(give, receive);
      const button = h("button", {
        class: "kp-rule",
        type: "button",
        title: `Donner une ${RARITY_LABELS[give]} pour recevoir une ${RARITY_LABELS[receive]}`,
        style: { "--kp-rarity": rarityColor(receive) },
        onClick: () => controller.toggleAutoRule(key)
      });
      cells.set(key, button);
      return button;
    };
    const status = h("p", { class: "kp-muted" });
    const toggle = h("button", { class: "kp-btn kp-btn--sm", type: "button" });
    const doubles = h("button", { class: "kp-chip", type: "button" }, "Seulement mes doublons");
    const log = h("div", { class: "kp-deals" });
    const gainChip = h("button", { class: "kp-chip", type: "button" }, "Ou si gain ≥");
    const gainInput = h("input", {
      class: "kp-input kp-input--short",
      type: "text",
      inputmode: "numeric",
      "aria-label": "Gain minimum pour accepter tout seul",
      onInput: (event) => {
        event.target.value = event.target.value.replace(/\D/g, "");
        controller.setAutoGainRule({ minGain: Number(event.target.value) || 0 });
      }
    });
    let enabled = false;
    let doublesOnly = true;
    let gainEnabled = false;
    toggle.addEventListener("click", () => controller.setAuto(!enabled));
    doubles.addEventListener("click", () => controller.setAutoDoublesOnly(!doublesOnly));
    gainChip.addEventListener("click", () => controller.setAutoGainRule({ gainEnabled: !gainEnabled }));
    const root = h(
      "div",
      { class: "kp-side__block kp-auto" },
      h("div", { class: "kp-auto__head" }, h("h3", { class: "kp-title kp-title--sm" }, "Auto-accept"), toggle),
      status,
      h(
        "table",
        { class: "kp-rules" },
        h(
          "thead",
          {},
          h("tr", {}, h("th", { class: "kp-label" }, "Je donne ↓ reçois →"), RECEIVED.map((receive) => h("th", {}, gem(receive))))
        ),
        h(
          "tbody",
          {},
          GIVEN.map(
            (give) => h("tr", {}, h("th", {}, gem(give)), RECEIVED.map((receive) => h("td", {}, cell(give, receive))))
          )
        )
      ),
      h("div", { class: "kp-field" }, gainChip, gainInput, h("span", { class: "kp-muted" }, "chakra")),
      h("p", { class: "kp-muted" }, "Gain = prix moyen de la carte reçue moins celui de la carte donnée."),
      doubles,
      h("p", { class: "kp-muted" }, "Les cartes verrouillées ne sont jamais données."),
      log
    );
    function render(state) {
      const { auto } = state;
      enabled = auto.enabled;
      doublesOnly = auto.doublesOnly;
      gainEnabled = auto.gainEnabled;
      status.textContent = statusText3(state);
      toggle.textContent = enabled ? "Arrêter" : "Activer";
      toggle.classList.toggle("kp-btn--warn", enabled);
      toggle.disabled = !enabled && !hasAutoRule(autoSettings(auto));
      doubles.setAttribute("aria-pressed", String(doublesOnly));
      gainChip.setAttribute("aria-pressed", String(gainEnabled));
      if (document.activeElement !== gainInput) gainInput.value = String(auto.minGain);
      for (const [key, button] of cells) button.setAttribute("aria-pressed", String(auto.rules.has(key)));
      log.replaceChildren(...auto.log.map(logRow2));
    }
    return { root, render };
  }

  // src/features/market-offers/side-panel.js
  var Tab = {
    OFFERS: "offers",
    AUTO: "auto"
  };
  var TABS2 = [
    [Tab.OFFERS, "Offres"],
    [Tab.AUTO, "Auto-accept"]
  ];
  function releasesTitle({ releases, hours }) {
    const gifts = releases.filter((release) => release.gift > 0).slice(0, config_default.ledger.shownReleases);
    if (gifts.length === 0) return `Fenêtre glissante de ${hours} h.`;
    const lines = gifts.map(
      ({ at, approximate, gift }) => `${approximate ? "≈ " : ""}${formatClock(at)} : +${formatChakra(gift)}`
    );
    return `Revient (fenêtre glissante de ${hours} h) :
${lines.join("\n")}`;
  }
  function renderFairPlay(box, fair) {
    const key = JSON.stringify(fair);
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.title = fair ? releasesTitle(fair) : "";
    box.replaceChildren(
      fair ? h("strong", {}, `Dons que tu peux encore accepter : ${formatChakra(fair.gifts)}`) : h("span", { class: "kp-muted" }, "Limite de dons : chargement…")
    );
  }
  function dealAction(analysis, option, controller) {
    if (option.status === GiveStatus.PINNED) {
      return h(
        "button",
        { class: "kp-btn kp-btn--sm kp-btn--warn", type: "button", onClick: () => controller.unlock(option.card) },
        "Déverrouiller"
      );
    }
    return giveButton(option, () => controller.give(analysis, option), "kp-btn--sm");
  }
  function dealRow({ analysis, option }, busy, controller) {
    const isBusy = busy.has(analysis.offer.id) || busy.has(pinBusyKey(option.card));
    return h(
      "div",
      { class: `kp-deal${isBusy ? " is-busy" : ""}${analysis.isNew ? " is-new" : ""}` },
      cardArt(analysis.received, "sm"),
      swapIcon(),
      cardArt(option.card, "sm", optionOverlays(option)),
      h(
        "div",
        { class: "kp-deal__info" },
        h(
          "strong",
          { class: "kp-name", title: analysis.received.name },
          analysis.isNew ? h("span", { class: "kp-new" }, "Nouveau") : null,
          analysis.received.name
        ),
        h("span", { class: "kp-note", title: option.card.name }, `contre ${option.card.name}`),
        h(
          "div",
          { class: "kp-deal__actions" },
          option.status === GiveStatus.PINNED ? gainBadge(option.gain) : null,
          dealAction(analysis, option, controller),
          hideButton(() => controller.hide(analysis.offer.id))
        )
      )
    );
  }
  function createSidePanel(controller) {
    let minGain = readSetting("minGain", config_default.side.defaultMinGain);
    let lastState = null;
    const bangerList = h("div", { class: "kp-deals" });
    const gainList = h("div", { class: "kp-deals" });
    const autoPanel = createAutoPanel(controller);
    const onInput = (event) => {
      const digits = event.target.value.replace(/\D/g, "");
      event.target.value = digits;
      minGain = Number(digits) || 0;
      writeSetting("minGain", minGain);
      if (lastState) render(lastState);
    };
    let tab = readSetting("sideTab", Tab.OFFERS);
    const tabButtons = TABS2.map(([key, label]) => {
      const button = h("button", { class: "kp-chip", type: "button", role: "tab" }, label);
      button.addEventListener("click", () => {
        tab = key;
        writeSetting("sideTab", key);
        if (lastState) render(lastState);
      });
      return [key, button];
    });
    const fairBox = h("div", { class: "kp-fair" });
    const offersView = h(
      "div",
      { class: "kp-side__view", role: "tabpanel" },
      fairBox,
      h(
        "label",
        { class: "kp-field" },
        h("span", { class: "kp-label" }, "Gain minimum"),
        h("input", { class: "kp-input", type: "text", inputmode: "numeric", value: String(minGain), onInput }),
        h("span", { class: "kp-muted" }, "chakra")
      ),
      h(
        "div",
        { class: "kp-side__block" },
        h("h3", { class: "kp-title kp-title--sm" }, "Offres rentables"),
        h(
          "p",
          { class: "kp-muted" },
          "Chaque carte que tu peux donner et qui rapporte au moins le gain minimum : une offre revient une fois par carte. Les nouvelles arrivent en haut."
        ),
        gainList
      ),
      h(
        "div",
        { class: "kp-side__block" },
        h("h3", { class: "kp-title kp-title--sm" }, "Offres bangers"),
        h(
          "p",
          { class: "kp-muted" },
          "Une Mythique ou Légendaire contre une carte de rareté inférieure, une ligne par carte possible."
        ),
        bangerList
      )
    );
    const autoView = h("div", { class: "kp-side__view", role: "tabpanel" }, autoPanel.root);
    const root = h(
      "section",
      { class: "kp-side", "aria-label": "Offres intéressantes" },
      h(
        "div",
        { class: "kp-side__controls kp-side__tabs", role: "tablist" },
        tabButtons.map(([, button]) => button)
      ),
      offersView,
      autoView
    );
    function renderTabs(state) {
      for (const [key, button] of tabButtons) button.setAttribute("aria-pressed", String(key === tab));
      tabButtons.find(([key]) => key === Tab.AUTO)[1].classList.toggle("is-live", state.auto.enabled);
      offersView.hidden = tab !== Tab.OFFERS;
      autoView.hidden = tab !== Tab.AUTO;
    }
    function fill2(list, deals, emptyText, state) {
      if (state.phase !== Phase2.READY && deals.length === 0) {
        list.replaceChildren(h("p", { class: "kp-muted" }, "Chargement…"));
        return;
      }
      const rows = deals.slice(0, config_default.side.listLimit).map((deal) => dealRow(deal, state.busy, controller));
      list.replaceChildren(...rows.length ? rows : [h("p", { class: "kp-muted" }, emptyText)]);
    }
    function render(state) {
      lastState = state;
      renderTabs(state);
      renderFairPlay(fairBox, state.fair);
      autoPanel.render(state);
      fill2(gainList, gainDeals(state.analyses, minGain), "Aucune offre à ce gain.", state);
      fill2(bangerList, bangerDeals(state.analyses), "Aucune offre banger pour le moment.", state);
    }
    return { root, render };
  }

  // src/features/market-offers/index.js
  var NATIVE_BOARD = "main section.board";
  var NATIVE_PROPOSE = `${NATIVE_BOARD} .bh button.btn-acc`;
  var SIDE_COLUMN = "main aside.chat-side";
  var market_offers_default = {
    id: "market-offers",
    matches: (url) => url.pathname === "/marche" && url.searchParams.get("onglet") === "offres",
    mount() {
      const store = createStore(initialState3());
      const controller = createOffersController(store);
      const board = createBoard(controller, { onPropose: () => document.querySelector(NATIVE_PROPOSE)?.click() });
      const side = createSidePanel(controller);
      document.body.classList.add("kp-offers");
      const unsubscribe = store.subscribe((state) => {
        board.render(state);
        side.render(state);
      });
      const detachers = [
        keepAttached(board.root, NATIVE_BOARD, (anchor, node) => anchor.after(node)),
        keepAttached(side.root, SIDE_COLUMN, (column, node) => column.append(node))
      ];
      controller.load(board.filters());
      return () => {
        controller.dispose();
        unsubscribe();
        detachers.forEach((detach) => detach());
        board.root.remove();
        side.root.remove();
        document.body.classList.remove("kp-offers");
      };
    }
  };

  // src/features/offer-dialog.js
  var OFFER_TILES = '[role="dialog"] .od .shelf ul.grid button.tile';
  var offer_dialog_default = {
    id: "offer-dialog",
    matches: (url) => url.pathname === "/marche" && url.searchParams.get("onglet") === "offres",
    mount() {
      let collection = null;
      let frame = 0;
      function decorate2() {
        for (const tile2 of document.querySelectorAll(OFFER_TILES)) {
          renderCount(tile2, collection.get(tileCardId(tile2))?.qty ?? 0);
        }
      }
      const schedule = () => {
        if (!collection || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      loadCollection().then((loaded) => {
        collection = loaded;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        clearCounts();
      };
    }
  };

  // src/features/missions-series.js
  var SERIES_SECTION = 'main section[aria-labelledby="albums-t"]';
  var SERIES_ITEM = "ul.quests > li.q";
  var CLAIM_BUTTON = "button.claim";
  var finishedLabel = (count) => `${formatNumber(count)} ${count > 1 ? "séries finies" : "série finie"}`;
  var missions_series_default = {
    id: "missions-series",
    matches: (url) => url.pathname === "/missions",
    mount() {
      let expanded = false;
      let frame = 0;
      const summary = h("span", { class: "kp-series-summary" });
      const chevron = h("span", { class: "kp-series-chevron" }, icon("chevron-down"));
      const toggle = h("button", { class: "kp-series-toggle", type: "button" }, summary, chevron);
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        schedule();
      });
      function render(section) {
        const items = section.querySelectorAll(SERIES_ITEM);
        const claimable = section.querySelectorAll(`${SERIES_ITEM} ${CLAIM_BUTTON}`).length;
        const text = `${finishedLabel(items.length)}${claimable ? ` · ${claimable} à réclamer` : ""}`;
        if (summary.textContent !== text) summary.textContent = text;
        summary.classList.toggle("has-claim", claimable > 0);
        toggle.setAttribute("aria-expanded", String(expanded));
        section.classList.toggle("kp-series-collapsed", !expanded);
      }
      function decorate2() {
        const section = document.querySelector(SERIES_SECTION);
        if (!section) return;
        const header2 = section.querySelector(":scope > header");
        if (header2 && toggle.parentElement !== header2) header2.append(toggle);
        render(section);
      }
      function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        toggle.remove();
        document.querySelectorAll(".kp-series-collapsed").forEach((section) => section.classList.remove("kp-series-collapsed"));
      };
    }
  };

  // src/features/profile-background.js
  var { userId, video: videoSrc, volume } = config_default.profileBackground;
  var UNMUTE_EVENTS = ["pointerdown", "keydown"];
  var profile_background_default = {
    id: "profile-background",
    matches: (url) => url.pathname === `/profil/${userId}`,
    mount() {
      const video = h("video", { class: "kp-bg-video", src: videoSrc, autoplay: true, loop: true, muted: true, playsinline: true });
      video.muted = true;
      video.volume = volume;
      const unmute = () => {
        UNMUTE_EVENTS.forEach((type) => removeEventListener(type, unmute, true));
        video.muted = false;
        video.play().catch(() => {
        });
      };
      UNMUTE_EVENTS.forEach((type) => addEventListener(type, unmute, true));
      document.body.classList.add("kp-video-bg");
      document.body.prepend(video);
      video.play().catch(() => {
      });
      return () => {
        UNMUTE_EVENTS.forEach((type) => removeEventListener(type, unmute, true));
        video.pause();
        video.remove();
        document.body.classList.remove("kp-video-bg");
      };
    }
  };

  // src/features/profile-collection/filters.js
  var sortEntries = (entries) => entries.sort(compareCards);
  function buildEntries({ catalog, ownedIds, tradeable, myCollection }) {
    return ownedIds.map((id) => catalog.get(id)).filter(Boolean).map((card) => ({
      card,
      tradeable: tradeable.get(card.id) ?? 0,
      mine: myCollection.get(card.id)?.qty ?? 0,
      nameKey: searchKey(card.name),
      seriesKey: searchKey(card.series ?? "")
    })).sort(compareCards);
  }
  var indexCatalog = (catalog) => [...catalog.values()].map((card) => ({ id: card.id, rarity: card.rarity, seriesKey: searchKey(card.series ?? "") }));
  function completion(catalogIndex, ownedIds, { series, rarities }) {
    const seriesKey = searchKey(series.trim());
    let owned = 0;
    let total = 0;
    for (const card of catalogIndex) {
      if (rarities.size > 0 && !rarities.has(card.rarity)) continue;
      if (seriesKey && !card.seriesKey.includes(seriesKey)) continue;
      total++;
      if (ownedIds.has(card.id)) owned++;
    }
    return { owned, total };
  }
  var seriesOf = (entries) => [...new Set(entries.map((entry) => entry.card.series).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  var totalPrice = (entries) => entries.reduce((sum, entry) => sum + (entry.price ?? 0), 0);
  var isDuplicate = (entry) => entry.tradeable >= config_default.profile.duplicateMin;
  function filterEntries(entries, { name, series, rarities, duplicates, iLack }) {
    const nameKey = searchKey(name.trim());
    const seriesKey = searchKey(series.trim());
    return entries.filter(
      (entry) => (!nameKey || entry.nameKey.includes(nameKey)) && (!seriesKey || entry.seriesKey.includes(seriesKey)) && (rarities.size === 0 || rarities.has(entry.card.rarity)) && (!duplicates || isDuplicate(entry)) && (!iLack || entry.mine === 0)
    );
  }

  // src/features/profile-collection/view.js
  var SERIES_LIST_ID = "kp-pc-series";
  function cardBadges(entry) {
    const count = entry.tradeable > 0 ? h(
      "span",
      { class: `kp-badge${isDuplicate(entry) ? " kp-badge--dupe" : ""}`, title: "Exemplaires échangeables" },
      `×${entry.tradeable}`
    ) : h("span", { class: "kp-badge kp-badge--lock", title: "Aucun exemplaire échangeable" }, icon("lock"));
    const fresh = entry.mine === 0 ? h("span", { class: "kp-badge kp-badge--new kp-badge--corner" }, "Nouveau") : null;
    return [count, fresh];
  }
  function cardTile(entry, pricesReady) {
    return h(
      "div",
      { class: "kp-pcard", "data-card-id": String(entry.card.id) },
      cardArt(entry.card, "md", cardBadges(entry)),
      h("strong", { class: "kp-name", title: entry.card.name }, entry.card.name),
      h("span", { class: "kp-note", title: entry.card.series ?? "" }, entry.card.series ?? ""),
      h("span", { class: "kp-price" }, pricesReady ? formatPrice(entry.price) : "…")
    );
  }
  function toggleChip(label, pressed, onToggle, extra = {}) {
    const chip = h("button", { type: "button", "aria-pressed": String(pressed), ...extra }, label);
    chip.addEventListener("click", () => {
      const next = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", String(next));
      onToggle(next);
    });
    return chip;
  }
  function createCollectionModal({ title, onClose }) {
    const filters = { name: "", series: "", rarities: /* @__PURE__ */ new Set(), duplicates: false, iLack: false };
    let entries = null;
    let shown = [];
    let rendered = 0;
    let pricesReady = false;
    let ownership = null;
    const status = h("span", { class: "kp-muted" }, "Chargement…");
    const completionPill = h("span", { class: "kp-pc__total kp-pc__completion" });
    const total = h("span", { class: "kp-pc__total" });
    const grid = h("div", { class: "kp-pc__grid" });
    const sentinel = h("div", { class: "kp-pc__sentinel" });
    const seriesList = h("datalist", { id: SERIES_LIST_ID });
    const body = h("div", { class: "kp-pc__body" }, grid, sentinel);
    function appendNextStep() {
      const next = shown.slice(rendered, rendered + config_default.profile.renderStep);
      rendered += next.length;
      grid.append(...next.map((entry) => cardTile(entry, pricesReady)));
    }
    function renderTotal() {
      if (!pricesReady) {
        total.textContent = "Valeur : calcul…";
        return;
      }
      const selection = shown.length === entries.length ? "" : ` · sélection ${formatChakra(totalPrice(shown))}`;
      total.textContent = `Valeur ${formatChakra(totalPrice(entries))}${selection}`;
    }
    function renderCompletion() {
      const { owned, total: inGame } = completion(ownership.catalogIndex, ownership.ownedIds, filters);
      const scope = [...filters.rarities].map((rarity) => RARITY_LABELS[rarity]).join(" + ") || "Toutes raretés";
      const percent = inGame ? Math.floor(owned / inGame * 100) : 0;
      completionPill.textContent = `${scope} : ${formatNumber(owned)} / ${formatNumber(inGame)} (${percent} %)`;
      completionPill.title = "Cartes différentes possédées sur le nombre de cartes du jeu (filtres rareté et série)";
    }
    function render() {
      if (!entries) return;
      shown = filterEntries(entries, filters);
      renderTotal();
      rendered = 0;
      grid.replaceChildren();
      body.scrollTop = 0;
      status.textContent = `${formatNumber(shown.length)} / ${plural(entries.length, "carte")}`;
      renderCompletion();
      if (shown.length === 0) grid.append(h("p", { class: "kp-empty" }, "Aucune carte avec ces filtres."));
      else appendNextStep();
    }
    const loadMore = new IntersectionObserver(
      ([sentinelEntry]) => {
        if (sentinelEntry.isIntersecting && rendered < shown.length) appendNextStep();
      },
      { root: body, rootMargin: "400px" }
    );
    loadMore.observe(sentinel);
    const textInput = (key, placeholder, extra = {}) => h("input", {
      class: "kp-input",
      type: "search",
      placeholder,
      ...extra,
      onInput: (event) => {
        filters[key] = event.target.value;
        render();
      }
    });
    const rarityChips = [...RARITIES].reverse().map(
      (rarity) => toggleChip(
        rarity,
        false,
        (pressed) => {
          if (pressed) filters.rarities.add(rarity);
          else filters.rarities.delete(rarity);
          render();
        },
        { class: "kp-gem-chip", title: RARITY_LABELS[rarity], style: { "--kp-rarity": rarityColor(rarity) } }
      )
    );
    const flagChip = (key, label) => toggleChip(
      label,
      false,
      (pressed) => {
        filters[key] = pressed;
        render();
      },
      { class: "kp-chip" }
    );
    const root = h(
      "div",
      {
        class: "kp-modal",
        onClick: (event) => event.target === event.currentTarget && onClose()
      },
      h(
        "section",
        { class: "kp-pc", role: "dialog", "aria-modal": "true", "aria-label": title },
        h(
          "header",
          { class: "kp-pc__head" },
          h("h2", { class: "kp-title" }, title),
          status,
          completionPill,
          total,
          h("button", { class: "kp-hide kp-pc__close", type: "button", title: "Fermer", onClick: onClose }, icon("xmark"))
        ),
        h(
          "div",
          { class: "kp-pc__filters" },
          textInput("name", "Nom du perso"),
          textInput("series", "Série", { list: SERIES_LIST_ID }),
          seriesList,
          h("div", { class: "kp-field" }, rarityChips),
          flagChip("duplicates", "Ses doubles"),
          flagChip("iLack", "Il me manque")
        ),
        body
      )
    );
    return {
      root,
      setEntries(loaded, game) {
        entries = loaded;
        ownership = game;
        seriesList.replaceChildren(...seriesOf(entries).map((series) => h("option", { value: series })));
        render();
      },
      // Prices change the order inside each rarity, so the grid is rebuilt rather than patched.
      showPrices() {
        pricesReady = true;
        sortEntries(entries);
        render();
      },
      setError(message) {
        status.textContent = message;
      },
      destroy() {
        loadMore.disconnect();
        root.remove();
      }
    };
  }

  // src/features/profile-collection/index.js
  var PROFILE_ACTIONS = "main .acts";
  var PLAYER_NAME = "main h1";
  var COPY_LINK_LABEL = "Copier le lien";
  function placeButton(actions2, button) {
    const copyLink = [...actions2.querySelectorAll("button")].find((node) => node.textContent.trim() === COPY_LINK_LABEL);
    if (!copyLink) return actions2.append(button);
    copyLink.classList.add("kp-native-hidden");
    button.className = copyLink.className.replace(/\bkp-native-hidden\b/, "").trim();
    copyLink.before(button);
  }
  async function loadEntries(userId2) {
    const [catalog, myCollection, ownedIds, available] = await Promise.all([
      loadCatalog(),
      loadCollection(),
      tradesApi.ownedBy(userId2),
      tradesApi.availableFrom(userId2)
    ]);
    const tradeable = new Map(available.map((row) => [row.characterId, row.n]));
    return {
      entries: buildEntries({ catalog, ownedIds, tradeable, myCollection }),
      catalogIndex: indexCatalog(catalog),
      ownedIds: new Set(ownedIds)
    };
  }
  async function attachPrices(entries) {
    await loadPrices(entries.map((entry) => entry.card.id));
    for (const entry of entries) entry.price = priceOf(entry.card.id);
  }
  var profile_collection_default = {
    id: "profile-collection",
    matches: (url) => url.pathname.startsWith("/profil/"),
    mount() {
      const cache2 = /* @__PURE__ */ new Map();
      let modal = null;
      const close = () => {
        modal?.destroy();
        modal = null;
        document.body.classList.remove("kp-modal-open");
      };
      const onKeydown = (event) => event.key === "Escape" && modal && close();
      function open() {
        const userId2 = profileIdFromPath();
        if (!userId2 || modal) return;
        const name = document.querySelector(PLAYER_NAME)?.textContent.trim();
        const current = createCollectionModal({ title: name ? `Collection de ${name}` : "Collection", onClose: close });
        modal = current;
        document.body.classList.add("kp-modal-open");
        document.body.append(current.root);
        if (!cache2.has(userId2)) cache2.set(userId2, loadEntries(userId2));
        cache2.get(userId2).then(async ({ entries, catalogIndex, ownedIds }) => {
          current.setEntries(entries, { catalogIndex, ownedIds });
          try {
            await attachPrices(entries);
            current.showPrices();
          } catch (error) {
            toast(describeError(error), "error");
          }
        }).catch((error) => {
          cache2.delete(userId2);
          current.setError(describeError(error));
        });
      }
      const button = h("button", { type: "button", onClick: open }, icon("layer-group"), " Voir sa collection");
      const detach = keepAttached(button, PROFILE_ACTIONS, placeButton);
      document.addEventListener("keydown", onKeydown);
      return () => {
        detach();
        close();
        button.remove();
        document.removeEventListener("keydown", onKeydown);
        document.querySelectorAll(".kp-native-hidden").forEach((node) => node.classList.remove("kp-native-hidden"));
      };
    }
  };

  // src/lib/router.js
  function onNavigate(callback) {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function(...args) {
        const result = original.apply(this, args);
        queueMicrotask(callback);
        return result;
      };
    }
    addEventListener("popstate", callback);
    callback();
  }

  // src/styles.css
  var styles_default = `body.kp-market main aside.chat-side > :not(.kp-side) {\r
  display: none !important;\r
}\r
\r
body.kp-market:not(.kp-offers) main aside.chat-side {\r
  display: none !important;\r
}\r
\r
body.kp-market:not(.kp-offers) main .layout {\r
  grid-template-columns: minmax(0, 1fr) !important;\r
}\r
\r
body.kp-offers main .wrap {\r
  --wrap: 1320px;\r
}\r
\r
body.kp-offers main .layout {\r
  grid-template-columns: minmax(0, 1fr) 400px !important;\r
}\r
\r
/* The site may render its offer dialogs inside the board, so only the board's own content is hidden. */\r
body.kp-offers main section.board {\r
  display: contents !important;\r
}\r
\r
body.kp-offers main section.board > :not([role='dialog']):not(:has([role='dialog'])) {\r
  display: none !important;\r
}\r
\r
.kp-tab-link {\r
  display: inline-flex;\r
  align-items: center;\r
  color: inherit;\r
  text-decoration: none;\r
}\r
\r
.kp-filters {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: var(--s-2);\r
}\r
\r
.kp-chip {\r
  padding: 5px 12px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  background: transparent;\r
  color: var(--fg2);\r
  font: 500 var(--t-sm) var(--body);\r
  cursor: pointer;\r
}\r
\r
.kp-chip:hover {\r
  background: var(--raise);\r
}\r
\r
.kp-chip[aria-pressed='true'] {\r
  border-color: var(--acc);\r
  background: var(--acc-soft);\r
  color: var(--fg);\r
}\r
\r
.kp-title {\r
  margin: 0;\r
  font-family: var(--disp);\r
  font-size: var(--t-h3);\r
}\r
\r
.kp-title--sm {\r
  font-size: var(--t-base);\r
}\r
\r
.kp-muted,\r
.kp-empty {\r
  margin: 0;\r
  color: var(--mut);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-empty {\r
  padding: var(--s-6) 0;\r
  text-align: center;\r
}\r
\r
.kp-label {\r
  color: var(--mut);\r
  font-size: var(--t-meta);\r
  letter-spacing: 0.06em;\r
  text-transform: uppercase;\r
}\r
\r
.kp-name {\r
  overflow: hidden;\r
  font-size: var(--t-sm);\r
  text-overflow: ellipsis;\r
  white-space: nowrap;\r
}\r
\r
.kp-price {\r
  color: var(--fg2);\r
  font-family: var(--mono);\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-note {\r
  overflow: hidden;\r
  color: var(--mut);\r
  font-size: var(--t-meta);\r
  text-overflow: ellipsis;\r
  white-space: nowrap;\r
}\r
\r
.kp-note--warn {\r
  color: var(--warn);\r
}\r
\r
.kp-note--new {\r
  color: var(--ok);\r
}\r
\r
.kp-note--wish {\r
  color: var(--wish);\r
}\r
\r
.kp-tag {\r
  align-self: flex-start;\r
  padding: 2px 8px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  color: var(--fg2);\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-art {\r
  position: relative;\r
  display: block;\r
  overflow: hidden;\r
  aspect-ratio: 2 / 3;\r
  border: 3px solid var(--kp-rarity);\r
  border-radius: var(--r-md);\r
  background: var(--bg2);\r
  box-shadow: 0 0 14px color-mix(in srgb, var(--kp-rarity) 30%, transparent);\r
}\r
\r
.kp-art img {\r
  display: block;\r
  width: 100%;\r
  height: 100%;\r
  object-fit: cover;\r
}\r
\r
.kp-art--md {\r
  width: 100%;\r
}\r
\r
.kp-art--lg {\r
  width: 120px;\r
}\r
\r
.kp-art--sm {\r
  width: 44px;\r
  border-width: 2px;\r
  border-radius: var(--r-sm);\r
}\r
\r
.kp-badge {\r
  position: absolute;\r
  right: 4px;\r
  bottom: 4px;\r
  padding: 1px 6px;\r
  border-radius: var(--r-pill);\r
  background: color-mix(in srgb, var(--bg) 85%, transparent);\r
  color: var(--fg);\r
  font-family: var(--mono);\r
  font-size: var(--t-meta);\r
  line-height: 1.4;\r
}\r
\r
.kp-badge--lock {\r
  top: 4px;\r
  bottom: auto;\r
  color: var(--warn);\r
}\r
\r
.kp-art--sm .kp-badge {\r
  right: 1px;\r
  bottom: 1px;\r
  padding: 0 3px;\r
  font-size: 9px;\r
}\r
\r
.kp-art--sm .kp-badge--lock {\r
  top: 1px;\r
  bottom: auto;\r
}\r
\r
.kp-swap {\r
  align-self: center;\r
  color: var(--mut);\r
  font-size: 18px;\r
  text-align: center;\r
}\r
\r
.kp-btn {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  gap: 6px;\r
  padding: 6px 10px;\r
  border: 1px solid transparent;\r
  border-radius: var(--r-md);\r
  background: var(--acc);\r
  color: #fff;\r
  font: 600 var(--t-sm) var(--body);\r
  cursor: pointer;\r
  transition: background 0.15s, opacity 0.15s;\r
}\r
\r
.kp-btn[hidden] {\r
  display: none;\r
}\r
\r
.kp-btn:hover {\r
  background: var(--acc2);\r
}\r
\r
.kp-btn--ghost {\r
  border-color: var(--line2);\r
  background: transparent;\r
  color: var(--fg);\r
}\r
\r
.kp-btn--ghost:hover {\r
  background: var(--raise);\r
}\r
\r
.kp-btn--warn {\r
  background: var(--warn);\r
  color: var(--bg);\r
}\r
\r
.kp-btn--double {\r
  background: #ff5f1f;\r
  color: var(--bg);\r
}\r
\r
.kp-btn--double:hover {\r
  background: #ff7a45;\r
}\r
\r
.kp-btn--single {\r
  background: var(--gold);\r
  color: var(--bg);\r
}\r
\r
.kp-btn--single:hover {\r
  background: #ffd84d;\r
}\r
\r
.kp-btn--sm {\r
  padding: 4px 8px;\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-gain {\r
  padding: 1px 6px;\r
  border-radius: var(--r-pill);\r
  font-family: var(--mono);\r
  font-size: var(--t-meta);\r
  white-space: nowrap;\r
}\r
\r
.kp-gain--up {\r
  background: color-mix(in srgb, var(--ok) 18%, transparent);\r
  color: var(--ok);\r
}\r
\r
.kp-gain--down {\r
  background: color-mix(in srgb, var(--danger) 18%, transparent);\r
  color: var(--danger);\r
}\r
\r
.kp-gain--flat {\r
  background: var(--raise);\r
  color: var(--mut);\r
}\r
\r
.kp-btn .kp-gain {\r
  background: var(--bg);\r
}\r
\r
.kp-board {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-4);\r
}\r
\r
.kp-board__bar {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: flex-end;\r
  justify-content: space-between;\r
  gap: var(--s-3);\r
}\r
\r
.kp-board__actions {\r
  display: flex;\r
  gap: var(--s-2);\r
}\r
\r
.kp-board__list {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-5);\r
}\r
\r
.kp-group {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
}\r
\r
.kp-group__title {\r
  margin: 0;\r
  padding-bottom: var(--s-2);\r
  border-bottom: 1px solid color-mix(in srgb, var(--kp-rarity) 40%, transparent);\r
  color: var(--kp-rarity);\r
  font-family: var(--disp);\r
  font-size: var(--t-base);\r
}\r
\r
.kp-offer {\r
  position: relative;\r
  display: grid;\r
  grid-template-columns: 132px 24px minmax(0, 1fr);\r
  gap: var(--s-4);\r
  padding: var(--s-3);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
  transition: opacity 0.15s;\r
}\r
\r
.kp-offer__get,\r
.kp-option {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 4px;\r
  min-width: 0;\r
}\r
\r
.kp-offer__give {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
  min-width: 0;\r
}\r
\r
.kp-options {\r
  display: grid;\r
  grid-template-columns: repeat(5, 112px);\r
  justify-content: start;\r
  gap: var(--s-3);\r
}\r
\r
.kp-option--missing {\r
  opacity: 0.35;\r
}\r
\r
.kp-option .kp-btn {\r
  width: 100%;\r
  margin-top: auto;\r
  padding: 4px 6px;\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-hide {\r
  display: inline-flex;\r
  align-items: center;\r
  justify-content: center;\r
  width: 26px;\r
  height: 26px;\r
  padding: 0;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  background: var(--panel2);\r
  color: var(--mut);\r
  cursor: pointer;\r
}\r
\r
.kp-hide:hover {\r
  background: var(--raise);\r
  color: var(--fg);\r
}\r
\r
.kp-offer > .kp-hide {\r
  position: absolute;\r
  top: var(--s-2);\r
  right: var(--s-2);\r
}\r
\r
.kp-deal .kp-hide {\r
  width: 22px;\r
  height: 22px;\r
  margin-left: auto;\r
  font-size: 11px;\r
}\r
\r
.kp-more {\r
  align-self: center;\r
}\r
\r
.is-busy {\r
  opacity: 0.45;\r
  pointer-events: none;\r
}\r
\r
.kp-side {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-5);\r
  height: 100%;\r
  overflow-y: auto;\r
  padding: var(--s-4);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
}\r
\r
.kp-side__controls {\r
  position: sticky;\r
  top: calc(-1 * var(--s-4));\r
  z-index: 1;\r
  margin: calc(-1 * var(--s-4)) calc(-1 * var(--s-4)) 0;\r
  padding: var(--s-3) var(--s-4);\r
  border-bottom: 1px solid var(--line);\r
  background: var(--panel);\r
}\r
\r
.kp-side__block {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
}\r
\r
.kp-field {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
}\r
\r
.kp-input {\r
  flex: 1;\r
  min-width: 0;\r
  padding: 6px 10px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-md);\r
  background: var(--bg2);\r
  color: var(--fg);\r
  font-family: var(--mono);\r
}\r
\r
.kp-input:focus {\r
  border-color: var(--acc);\r
  outline: none;\r
}\r
\r
.kp-board__search {\r
  flex-basis: 100%;\r
  max-width: 420px;\r
}\r
\r
.kp-deals {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
}\r
\r
.kp-deal {\r
  display: grid;\r
  grid-template-columns: 44px auto 44px minmax(0, 1fr);\r
  align-items: center;\r
  gap: var(--s-2);\r
  padding: var(--s-2);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-md);\r
  background: var(--panel2);\r
}\r
\r
.kp-deal .kp-swap {\r
  font-size: 12px;\r
}\r
\r
.kp-deal__info {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 2px;\r
  min-width: 0;\r
}\r
\r
.kp-deal__actions {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
  gap: var(--s-2);\r
  margin-top: 2px;\r
}\r
\r
.kp-deal.is-new {\r
  border-color: var(--acc);\r
  box-shadow: 0 0 0 1px var(--acc-soft);\r
}\r
\r
.kp-new {\r
  margin-right: 6px;\r
  padding: 1px 6px;\r
  border-radius: var(--r-pill);\r
  background: var(--acc);\r
  color: #fff;\r
  font-size: var(--t-meta);\r
  font-weight: 700;\r
}\r
\r
.kp-auto {\r
  padding: var(--s-3);\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-md);\r
  background: var(--panel2);\r
}\r
\r
.kp-auto__head {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
  gap: var(--s-2);\r
}\r
\r
.kp-rules {\r
  border-spacing: 4px;\r
  margin: 0 -4px;\r
}\r
\r
.kp-rules th {\r
  font-weight: 400;\r
  text-align: center;\r
}\r
\r
.kp-rules thead th:first-child {\r
  max-width: 90px;\r
  text-align: left;\r
}\r
\r
.kp-gem {\r
  display: inline-grid;\r
  place-items: center;\r
  width: 22px;\r
  height: 22px;\r
  border: 2px solid var(--kp-rarity);\r
  border-radius: 50%;\r
  color: var(--kp-rarity);\r
  font: 900 10px var(--body);\r
}\r
\r
.kp-rule {\r
  display: block;\r
  width: 28px;\r
  height: 28px;\r
  margin: auto;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-sm, 6px);\r
  background: transparent;\r
  cursor: pointer;\r
}\r
\r
.kp-rule:hover {\r
  border-color: var(--kp-rarity);\r
}\r
\r
.kp-rule[aria-pressed='true'] {\r
  border-color: var(--kp-rarity);\r
  background: var(--kp-rarity);\r
  box-shadow: 0 0 10px color-mix(in srgb, var(--kp-rarity) 50%, transparent);\r
}\r
\r
.kp-side__tabs {\r
  display: flex;\r
  gap: var(--s-2);\r
}\r
\r
.kp-side__view {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-5);\r
}\r
\r
.kp-side__view[hidden] {\r
  display: none;\r
}\r
\r
/* A dot on the Auto-accept tab while it runs, so it stays visible from the Offres tab. */\r
.kp-side__tabs .kp-chip.is-live::after {\r
  content: '';\r
  display: inline-block;\r
  width: 7px;\r
  height: 7px;\r
  margin-left: 6px;\r
  border-radius: 50%;\r
  background: var(--ok);\r
  box-shadow: 0 0 6px var(--ok);\r
  vertical-align: middle;\r
}\r
\r
.kp-auto__head .kp-btn:disabled {\r
  cursor: not-allowed;\r
}\r
\r
.kp-auto > .kp-chip {\r
  align-self: flex-start;\r
}\r
\r
.kp-toasts {\r
  position: fixed;\r
  right: 16px;\r
  bottom: 16px;\r
  z-index: 2147483647;\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
}\r
\r
.kp-toast {\r
  max-width: 360px;\r
  padding: 10px 14px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-md);\r
  background: var(--raise);\r
  box-shadow: var(--sh-1);\r
  color: var(--fg);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-toast--success {\r
  border-color: var(--ok);\r
}\r
\r
.kp-toast--error {\r
  border-color: var(--danger);\r
}\r
\r
.kp-replaced {\r
  display: none !important;\r
}\r
\r
.tcg.kp-ghost {\r
  filter: saturate(0.45) brightness(0.8);\r
}\r
\r
.tcg.kp-ghost .art img {\r
  filter: grayscale(1) brightness(0.7);\r
}\r
\r
.kp-filtered-out {\r
  display: none !important;\r
}\r
\r
.kp-album-filters {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-3);\r
  margin: var(--s-3) 0;\r
}\r
\r
.kp-input--short {\r
  flex: 0 0 72px;\r
  width: 72px;\r
}\r
\r
.kp-gem-chip {\r
  display: inline-grid;\r
  place-items: center;\r
  width: 26px;\r
  height: 26px;\r
  padding: 0;\r
  border: 2px solid var(--kp-rarity);\r
  border-radius: 50%;\r
  background: transparent;\r
  color: var(--kp-rarity);\r
  font: 900 11px var(--body);\r
  cursor: pointer;\r
}\r
\r
.kp-gem-chip[aria-pressed='true'] {\r
  background: var(--kp-rarity);\r
  box-shadow: 0 0 12px color-mix(in srgb, var(--kp-rarity) 60%, transparent);\r
  color: var(--bg);\r
}\r
\r
.kp-btn:disabled {\r
  opacity: 0.5;\r
  cursor: progress;\r
}\r
\r
.kp-lock-host {\r
  position: relative;\r
}\r
\r
.kp-lock-host .pin {\r
  display: none !important;\r
}\r
\r
.kp-lock {\r
  position: absolute;\r
  top: 2px;\r
  left: 0;\r
  z-index: 6;\r
  display: grid;\r
  place-items: center;\r
  width: 30px;\r
  height: 30px;\r
  padding: 0;\r
  border: 1px solid var(--line2);\r
  border-radius: 50%;\r
  background: var(--panel2);\r
  color: var(--dim);\r
  font-size: 13px;\r
  cursor: pointer;\r
  opacity: 0;\r
  transition: opacity 0.15s, color 0.15s;\r
}\r
\r
.kp-lock-host:hover .kp-lock,\r
.kp-lock.is-locked,\r
.kp-lock:focus-visible {\r
  opacity: 1;\r
}\r
\r
.kp-lock.is-locked {\r
  color: var(--warn);\r
}\r
\r
.kp-lock:hover {\r
  color: var(--fg);\r
}\r
\r
.kp-pick-host {\r
  position: relative;\r
}\r
\r
.kp-pick {\r
  position: absolute;\r
  top: 2px;\r
  left: 34px;\r
  z-index: 6;\r
  display: grid;\r
  place-items: center;\r
  min-width: 30px;\r
  height: 30px;\r
  padding: 0 6px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  background: var(--panel2);\r
  color: var(--dim);\r
  font: 700 12px var(--mono);\r
  cursor: pointer;\r
  opacity: 0;\r
  transition: opacity 0.15s, color 0.15s;\r
}\r
\r
.kp-pick-host:hover .kp-pick,\r
.kp-pick.is-picked,\r
.kp-pick:focus-visible {\r
  opacity: 1;\r
}\r
\r
.kp-pick:hover {\r
  color: var(--fg);\r
}\r
\r
.kp-pick.is-picked {\r
  border-color: var(--acc);\r
  background: var(--acc);\r
  color: #fff;\r
}\r
\r
.kp-picked .slot {\r
  outline: 2px solid var(--acc);\r
  outline-offset: 2px;\r
  border-radius: var(--r-md);\r
}\r
\r
.kp-pick-bar {\r
  position: fixed;\r
  bottom: 16px;\r
  left: 50%;\r
  z-index: 1000;\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-3);\r
  padding: 8px 8px 8px 16px;\r
  border: 1px solid var(--acc);\r
  border-radius: var(--r-pill);\r
  background: var(--raise);\r
  box-shadow: var(--sh-1);\r
  color: var(--fg);\r
  font-size: var(--t-sm);\r
  transform: translateX(-50%);\r
}\r
\r
.kp-pick-bar[hidden] {\r
  display: none;\r
}\r
\r
.kp-fair {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 2px;\r
  padding: var(--s-2) var(--s-3);\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-md);\r
  background: var(--panel2);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-releases {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 2px;\r
  margin: 0;\r
  padding: 0;\r
  list-style: none;\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-release__time {\r
  display: inline-block;\r
  min-width: 82px;\r
  color: var(--fg2);\r
  font-family: var(--mono);\r
}\r
\r
\r
.kp-pc__completion {\r
  font-weight: 600;\r
}\r
\r
.kp-lock:disabled {\r
  cursor: progress;\r
}\r
\r
.kp-badge--new {\r
  color: var(--ok);\r
}\r
\r
.kp-tcard {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: center;\r
  gap: 2px;\r
  width: 92px;\r
  min-width: 0;\r
}\r
\r
.kp-tcard .kp-name {\r
  max-width: 100%;\r
}\r
\r
.kp-count-host {\r
  container-type: inline-size;\r
}\r
\r
/* The tile image spans the tile width with a 5:7 ratio, so its bottom edge sits at 140% of that width. */\r
.kp-count {\r
  position: absolute;\r
  top: calc(140cqw - 22px);\r
  right: 5px;\r
  padding: 0 6px;\r
  border-radius: var(--r-pill);\r
  background: #0a090ed9;\r
  color: var(--fg2);\r
  font: 700 11px var(--mono);\r
  line-height: 18px;\r
  pointer-events: none;\r
}\r
\r
.kp-count--dupe {\r
  color: var(--ok);\r
}\r
\r
.kp-site-only {\r
  display: none !important;\r
}\r
\r
.kp-native-hidden {\r
  display: none !important;\r
}\r
\r
body.kp-modal-open {\r
  overflow: hidden;\r
}\r
\r
.kp-modal {\r
  position: fixed;\r
  inset: 0;\r
  z-index: 1000;\r
  display: grid;\r
  place-items: center;\r
  padding: var(--s-4);\r
  background: color-mix(in srgb, var(--bg) 70%, transparent);\r
  backdrop-filter: blur(4px);\r
}\r
\r
.kp-pc {\r
  display: flex;\r
  flex-direction: column;\r
  width: min(1200px, 100%);\r
  height: min(900px, 100%);\r
  overflow: hidden;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
  box-shadow: var(--sh-1);\r
}\r
\r
.kp-pc__head {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-3);\r
  padding: var(--s-3) var(--s-4);\r
  border-bottom: 1px solid var(--line);\r
}\r
\r
.kp-pc__close {\r
  margin-left: auto;\r
}\r
\r
.kp-pc__filters {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-2) var(--s-3);\r
  padding: var(--s-3) var(--s-4);\r
  border-bottom: 1px solid var(--line);\r
}\r
\r
.kp-pc__filters .kp-input {\r
  flex: 0 1 200px;\r
}\r
\r
.kp-pc__body {\r
  flex: 1;\r
  overflow-y: auto;\r
  padding: var(--s-4);\r
}\r
\r
.kp-pc__grid {\r
  display: grid;\r
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));\r
  gap: var(--s-3);\r
}\r
\r
.kp-pc__grid .kp-empty {\r
  grid-column: 1 / -1;\r
}\r
\r
.kp-pc__sentinel {\r
  height: 1px;\r
}\r
\r
.kp-pcard {\r
  display: flex;\r
  flex-direction: column;\r
  gap: 2px;\r
  min-width: 0;\r
}\r
\r
.kp-badge--dupe {\r
  color: var(--ok);\r
}\r
\r
.kp-badge--corner {\r
  top: 4px;\r
  right: auto;\r
  bottom: auto;\r
  left: 4px;\r
}\r
\r
.kp-pc__total {\r
  padding: 2px 10px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  color: var(--fg);\r
  font: 700 var(--t-sm) var(--mono);\r
}\r
\r
.kp-friend-search {\r
  display: block;\r
  width: 100%;\r
  max-width: 880px;\r
  margin-bottom: var(--s-3);\r
}\r
\r
body.kp-friends main ul.people {\r
  display: flex;\r
  flex-direction: column;\r
}\r
\r
body.kp-friends main ul.people > li.kp-pinned {\r
  order: -1;\r
  box-shadow: inset 3px 0 0 var(--gold);\r
}\r
\r
.kp-pin,\r
.kp-friend-act {\r
  display: inline-flex !important;\r
  flex: none;\r
  align-items: center;\r
  justify-content: center;\r
  gap: 0 !important;\r
  box-sizing: border-box;\r
  width: 32px;\r
  height: 32px;\r
  min-width: 0 !important;\r
  min-height: 0 !important;\r
  margin: 0 !important;\r
  padding: 0 !important;\r
  line-height: 0 !important;\r
  vertical-align: middle;\r
  border: 1px solid var(--line2) !important;\r
  border-radius: 50% !important;\r
  background: var(--panel2) !important;\r
  color: var(--mut) !important;\r
  font-size: 0 !important;\r
  text-decoration: none !important;\r
  cursor: pointer;\r
  transition: color 0.15s, background 0.15s;\r
}\r
\r
.kp-pin i,\r
.kp-friend-act i {\r
  width: 1.25em;\r
  font-size: 13px;\r
  line-height: 1;\r
  text-align: center;\r
}\r
\r
.kp-pin:hover,\r
.kp-friend-act:hover {\r
  background: var(--raise) !important;\r
  color: var(--fg) !important;\r
}\r
\r
.kp-friend-act[data-kp-icon='Retirer']:hover,\r
.kp-friend-act[data-kp-icon='Bloquer']:hover {\r
  color: var(--danger) !important;\r
}\r
\r
.kp-pin.is-pinned {\r
  border-color: var(--gold) !important;\r
  color: var(--gold) !important;\r
}\r
\r
.kp-pin.is-pinned i {\r
  transform: rotate(-45deg);\r
}\r
\r
.kp-friend-act--confirm {\r
  gap: 6px !important;\r
  width: auto;\r
  padding: 0 12px !important;\r
  border-color: var(--danger) !important;\r
  border-radius: var(--r-pill) !important;\r
  color: var(--danger) !important;\r
  font-size: var(--t-sm) !important;\r
  line-height: 1 !important;\r
}\r
\r
.kp-series-collapsed > ul.quests {\r
  display: none !important;\r
}\r
\r
.kp-series-toggle {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
  margin-left: auto;\r
  padding: 4px 12px;\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-pill);\r
  background: var(--panel2);\r
  color: var(--fg2);\r
  font: 600 var(--t-sm) var(--body);\r
  cursor: pointer;\r
}\r
\r
.kp-series-toggle:hover {\r
  background: var(--raise);\r
  color: var(--fg);\r
}\r
\r
.kp-series-summary.has-claim {\r
  color: var(--ok);\r
}\r
\r
.kp-series-chevron {\r
  display: inline-flex;\r
  font-size: 11px;\r
  transition: transform 0.15s;\r
}\r
\r
.kp-series-toggle[aria-expanded='true'] .kp-series-chevron {\r
  transform: rotate(180deg);\r
}\r
\r
html:has(body.kp-video-bg),\r
body.kp-video-bg,\r
body.kp-video-bg main section.band,\r
body.kp-video-bg main .box.coll {\r
  background: transparent !important;\r
}\r
\r
.kp-bg-video {\r
  position: fixed;\r
  inset: 0;\r
  z-index: -1;\r
  width: 100vw;\r
  height: 100vh;\r
  object-fit: cover;\r
  filter: brightness(0.45);\r
  pointer-events: none;\r
}\r
\r
.kp-filters__rarities {\r
  margin-left: auto;\r
}\r
\r
.kp-free-count[hidden] {\r
  display: none !important;\r
}\r
\r
/* The site's own label still describes its largest batch, so it is swapped for the free count while selected. */\r
body.kp-free-mode main .under .btn-open[data-kp-label] {\r
  font-size: 0 !important;\r
}\r
\r
body.kp-free-mode main .under .btn-open[data-kp-label] > * {\r
  display: none !important;\r
}\r
\r
body.kp-free-mode main .under .btn-open[data-kp-label]::after {\r
  content: attr(data-kp-label);\r
  font-size: var(--t-base, 1rem);\r
}\r
\r
.kp-auto-open__trigger {\r
  position: relative;\r
  display: inline-grid;\r
  place-items: center;\r
  font-size: 18px;\r
}\r
\r
.kp-auto-open__trigger.is-live::after {\r
  content: '';\r
  position: absolute;\r
  top: 6px;\r
  right: 6px;\r
  width: 8px;\r
  height: 8px;\r
  border-radius: 50%;\r
  background: var(--ok);\r
  box-shadow: 0 0 6px var(--ok);\r
}\r
\r
.kp-auto-open {\r
  position: fixed;\r
  top: 72px;\r
  right: 16px;\r
  z-index: 900;\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
  width: min(380px, calc(100vw - 32px));\r
  padding: var(--s-4);\r
  border: 1px solid var(--line2);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
  box-shadow: var(--sh-1);\r
  color: var(--fg);\r
}\r
\r
.kp-auto-open[hidden] {\r
  display: none;\r
}\r
\r
.kp-auto-open__head {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
}\r
\r
.kp-auto-open__status {\r
  margin: 0;\r
  font-size: var(--t-sm);\r
  font-weight: 600;\r
}\r
\r
.kp-auto-open .kp-field {\r
  flex-wrap: wrap;\r
}\r
\r
.kp-auto-open .kp-field .kp-label {\r
  flex: 1 0 100%;\r
}\r
\r
.kp-auto-open__log {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-1);\r
}\r
\r
.kp-auto-open__log-row {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-auto-open__gems {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 4px;\r
  margin-left: auto;\r
  font-family: var(--mono);\r
}\r
\r
/* The site's "Tu es toujours là ?" prompt is a browser-only idle pause (nothing is sent to the server); the\r
   auto-open runs on its own requests, so the prompt would only cover the page while it works. */\r
body.kp-auto-open-on [role='dialog'][aria-labelledby='idle-t'] {\r
  display: none !important;\r
}\r
\r
body.kp-header .hdr a.navlink.support {\r
  display: none !important;\r
}\r
\r
body.kp-activity:not(.kp-activity--native) main [role='tabpanel'] > :not(.kp-act):not([role='dialog']):not(:has([role='dialog'])) {\r
  display: none !important;\r
}\r
\r
/* The market hero (kicker, title, intro, Cartes / Éveil) used half a screen: one slim line is enough. */\r
body.kp-market main > section.head {\r
  display: flex;\r
  align-items: center;\r
  justify-content: space-between;\r
  gap: var(--s-4);\r
  min-height: 0 !important;\r
  margin-block: 0 !important;\r
  padding-block: var(--s-3) !important;\r
}\r
\r
body.kp-market main > section.head .eyebrow,\r
body.kp-market main > section.head .lead {\r
  display: none !important;\r
}\r
\r
body.kp-market main > section.head .h1 {\r
  margin: 0 !important;\r
  font-size: 24px !important;\r
  line-height: 1.15 !important;\r
}\r
\r
body.kp-market main > section.head .mode {\r
  margin: 0 !important;\r
}\r
\r
.kp-act,\r
.kp-act__content {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
}\r
\r
.kp-act__bar {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-2) var(--s-4);\r
}\r
\r
.kp-act__bar .kp-title {\r
  flex: none;\r
}\r
\r
.kp-act.is-native .kp-act__content,\r
.kp-act.is-native .kp-act__bar .kp-title,\r
.kp-act.is-native .kp-act__summary {\r
  display: none;\r
}\r
\r
.kp-act.is-native .kp-act__bar {\r
  justify-content: flex-end;\r
}\r
\r
.kp-act__summary {\r
  display: flex;\r
  flex: 1 1 280px;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-2) var(--s-3);\r
  min-width: 0;\r
}\r
\r
.kp-act__summary[hidden] {\r
  display: none;\r
}\r
\r
.kp-act__lede {\r
  color: var(--warn);\r
  font-size: var(--t-sm);\r
  font-weight: 600;\r
}\r
\r
.kp-act__lede.is-calm {\r
  color: var(--mut);\r
  font-weight: 500;\r
}\r
\r
.kp-act__stats {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: var(--s-2);\r
  margin-left: auto;\r
}\r
\r
.kp-act__stat {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 8px;\r
  padding: 4px 12px;\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-pill);\r
  background: var(--panel);\r
  color: var(--fg2);\r
  font: 500 var(--t-sm) var(--body);\r
}\r
\r
.kp-act__stat strong {\r
  color: var(--fg);\r
  font-family: var(--mono);\r
}\r
\r
button.kp-act__stat {\r
  cursor: pointer;\r
}\r
\r
button.kp-act__stat:hover,\r
.kp-act__stat.is-on {\r
  border-color: var(--acc);\r
  background: var(--acc-soft);\r
}\r
\r
.kp-act__ledger {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
  padding: var(--s-3) var(--s-4);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
}\r
\r
.kp-act__ledger[hidden] {\r
  display: none;\r
}\r
\r
.kp-act__bar-track {\r
  display: flex;\r
  height: 10px;\r
  overflow: hidden;\r
  border-radius: var(--r-pill);\r
  background: var(--bg2);\r
}\r
\r
.kp-act__legend {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: var(--s-1) var(--s-4);\r
  margin: var(--s-2) 0 0;\r
  padding: 0;\r
  color: var(--fg2);\r
  font-size: var(--t-sm);\r
  list-style: none;\r
}\r
\r
.kp-act__legend i {\r
  display: inline-block;\r
  width: 10px;\r
  height: 10px;\r
  margin-right: 6px;\r
  border-radius: 2px;\r
}\r
\r
.kp-act__sales {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
  margin: 0;\r
  color: var(--fg2);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-act__toolbar {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  justify-content: space-between;\r
  gap: var(--s-3);\r
}\r
\r
.kp-act__tabs {\r
  display: flex;\r
  flex-wrap: wrap;\r
  gap: 4px;\r
  padding: 4px;\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
}\r
\r
.kp-act__tab {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: 8px;\r
  padding: 7px 12px;\r
  border: 0;\r
  border-radius: var(--r-md);\r
  background: transparent;\r
  color: var(--fg2);\r
  font: 600 var(--t-sm) var(--body);\r
  cursor: pointer;\r
  transition: background 0.15s, color 0.15s;\r
}\r
\r
.kp-act__tab:hover {\r
  background: var(--raise);\r
  color: var(--fg);\r
}\r
\r
.kp-act__tab.on {\r
  background: var(--acc);\r
  color: #fff;\r
  box-shadow: 0 2px 10px color-mix(in srgb, var(--acc) 40%, transparent);\r
}\r
\r
.kp-act__tab.is-empty:not(.on) {\r
  opacity: 0.55;\r
}\r
\r
.kp-act__tab .n {\r
  min-width: 20px;\r
  padding: 1px 6px;\r
  border-radius: var(--r-pill);\r
  background: var(--bg2);\r
  color: var(--fg2);\r
  font: 700 11px var(--mono);\r
  text-align: center;\r
}\r
\r
.kp-act__tab.on .n {\r
  background: rgb(255 255 255 / 0.22);\r
  color: #fff;\r
}\r
\r
.kp-act__tab.has-todo:not(.on) .n {\r
  background: var(--warn);\r
  color: var(--bg);\r
}\r
\r
.kp-act__tools {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__search {\r
  flex: 1 1 160px;\r
  min-width: 140px;\r
  max-width: 260px;\r
}\r
\r
.kp-act__sort {\r
  flex: 0 0 auto;\r
  width: auto;\r
}\r
\r
.kp-act__tools .kp-btn[hidden] {\r
  display: none;\r
}\r
\r
.kp-act__body {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-4);\r
}\r
\r
.kp-act__notice {\r
  margin: 0;\r
  color: var(--mut);\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-act__notice--error {\r
  color: var(--danger);\r
}\r
\r
.kp-act__group {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__group-title {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
  margin: 0;\r
  color: var(--fg2);\r
  font: 700 var(--t-sm) var(--disp);\r
  letter-spacing: 0.06em;\r
  text-transform: uppercase;\r
}\r
\r
.kp-act__group-title .mono {\r
  color: var(--mut);\r
  font-weight: 500;\r
}\r
\r
.kp-act__list {\r
  display: grid;\r
  grid-template-columns: minmax(0, 1fr);\r
  gap: var(--s-3);\r
  align-items: start;\r
  margin: 0;\r
  padding: 0;\r
  list-style: none;\r
}\r
\r
.kp-act__row {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
  min-width: 0;\r
  padding: var(--s-3);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel);\r
  transition: opacity 0.15s, border-color 0.15s;\r
}\r
\r
.kp-act__row:hover {\r
  border-color: var(--line2);\r
}\r
\r
.kp-act__row--todo {\r
  border-color: var(--warn);\r
  box-shadow: inset 3px 0 0 var(--warn);\r
}\r
\r
.kp-act__row--done {\r
  background: color-mix(in srgb, var(--panel) 70%, var(--bg));\r
}\r
\r
.kp-act__row.is-focus {\r
  animation: kp-act-focus 2.6s ease-out;\r
}\r
\r
@keyframes kp-act-focus {\r
  0%,\r
  60% {\r
    box-shadow: 0 0 0 2px var(--acc);\r
  }\r
\r
  100% {\r
    box-shadow: 0 0 0 0 transparent;\r
  }\r
}\r
\r
.kp-act__head {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-3);\r
  min-width: 0;\r
  cursor: pointer;\r
}\r
\r
.kp-act__kind {\r
  --kc: var(--acc);\r
  display: grid;\r
  flex: none;\r
  place-items: center;\r
  width: 34px;\r
  height: 34px;\r
  border: 1px solid color-mix(in srgb, var(--kc) 55%, transparent);\r
  border-radius: 50%;\r
  background: color-mix(in srgb, var(--kc) 14%, transparent);\r
  color: var(--kc);\r
  font: 700 16px var(--disp);\r
}\r
\r
.kp-act__kind[data-kind='bid'] {\r
  --kc: var(--gold);\r
}\r
\r
.kp-act__kind[data-kind='order'] {\r
  --kc: var(--cyan);\r
}\r
\r
.kp-act__kind[data-kind='tradeIn'],\r
.kp-act__kind[data-kind='tradeOut'] {\r
  --kc: var(--E);\r
}\r
\r
.kp-act__kind[data-kind='counter'] {\r
  --kc: var(--ok);\r
}\r
\r
.kp-act__txt {\r
  display: flex;\r
  flex: 1;\r
  flex-direction: column;\r
  gap: 2px;\r
  min-width: 0;\r
}\r
\r
.kp-act__state {\r
  display: flex;\r
  flex: none;\r
  flex-direction: column;\r
  align-items: flex-end;\r
  gap: 2px;\r
  max-width: 55%;\r
  text-align: right;\r
}\r
\r
.kp-act__status {\r
  font-size: var(--t-meta);\r
  font-weight: 700;\r
}\r
\r
.kp-act__status--good {\r
  color: var(--ok);\r
}\r
\r
.kp-act__status--bad {\r
  color: var(--danger);\r
}\r
\r
.kp-act__status--warn {\r
  color: var(--warn);\r
}\r
\r
.kp-act__status--accent {\r
  color: var(--acc);\r
}\r
\r
.kp-act__status--muted {\r
  color: var(--mut);\r
}\r
\r
.kp-act__cards,\r
.kp-act__full {\r
  display: grid;\r
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r
  gap: var(--s-2);\r
  align-items: center;\r
}\r
\r
.kp-act__full {\r
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);\r
  align-items: start;\r
}\r
\r
.kp-act__side {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: center;\r
  gap: var(--s-2);\r
  min-width: 0;\r
  text-align: center;\r
}\r
\r
.kp-act__tiles {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: flex-start;\r
  justify-content: center;\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__tiles .kp-tcard {\r
  width: 72px;\r
}\r
\r
.kp-act__more,\r
.kp-act__chakra {\r
  align-self: center;\r
  color: var(--fg2);\r
  font: 700 var(--t-base) var(--mono);\r
}\r
\r
.kp-act__chakra {\r
  color: var(--cyan);\r
}\r
\r
.kp-art--missing {\r
  display: grid;\r
  place-items: center;\r
  width: 72px;\r
  color: var(--mut);\r
}\r
\r
.kp-act__foot {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  justify-content: space-between;\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__net {\r
  padding: 3px 10px;\r
  font-size: var(--t-sm);\r
  font-weight: 700;\r
  white-space: nowrap;\r
}\r
\r
.kp-act__acts {\r
  display: flex;\r
  align-items: center;\r
  gap: var(--s-2);\r
  margin-left: auto;\r
}\r
\r
.kp-act__acts .kp-btn {\r
  text-decoration: none;\r
}\r
\r
.kp-act__detail {\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-3);\r
  padding-top: var(--s-3);\r
  border-top: 1px solid var(--line);\r
}\r
\r
.kp-act__facts {\r
  display: grid;\r
  grid-template-columns: max-content minmax(0, 1fr);\r
  gap: 4px var(--s-4);\r
  margin: 0;\r
  font-size: var(--t-sm);\r
}\r
\r
.kp-act__facts dt {\r
  color: var(--mut);\r
}\r
\r
.kp-act__facts dd {\r
  margin: 0;\r
}\r
\r
.kp-act__link {\r
  color: var(--acc);\r
  text-decoration: underline;\r
}\r
\r
.kp-act__list--board {\r
  grid-template-columns: repeat(5, minmax(0, 1fr));\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__list--minis {\r
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__row--compact {\r
  gap: var(--s-2);\r
  padding: var(--s-2);\r
}\r
\r
.kp-act__row--compact .kp-act__head {\r
  gap: var(--s-2);\r
}\r
\r
.kp-act__row--compact .kp-act__kind {\r
  width: 24px;\r
  height: 24px;\r
  font-size: 12px;\r
}\r
\r
.kp-act__row--compact .kp-act__state {\r
  max-width: 50%;\r
}\r
\r
.kp-act__row--compact .kp-act__tiles .kp-tcard {\r
  width: 56px;\r
}\r
\r
.kp-act__row--compact .kp-act__side .kp-label {\r
  font-size: 10px;\r
}\r
\r
.kp-act__row--compact .kp-act__acts .kp-btn {\r
  padding: 3px 6px;\r
}\r
\r
.kp-act__row--wide .kp-act__head {\r
  flex-wrap: wrap;\r
}\r
\r
.kp-act__row--wide .kp-act__txt {\r
  flex: 1 1 140px;\r
}\r
\r
.kp-act__row--wide .kp-act__state {\r
  flex-direction: row;\r
  align-items: center;\r
  gap: var(--s-3);\r
  max-width: none;\r
}\r
\r
.kp-act__row--wide .kp-act__acts {\r
  margin-left: 0;\r
}\r
\r
.kp-act__boxes {\r
  display: grid;\r
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r
  align-items: stretch;\r
  gap: var(--s-3);\r
}\r
\r
.kp-act__boxes > .kp-swap {\r
  color: var(--acc);\r
}\r
\r
.kp-act__box {\r
  container-type: inline-size;\r
  display: flex;\r
  flex-direction: column;\r
  gap: var(--s-2);\r
  padding: var(--s-2) var(--s-3) var(--s-3);\r
  border: 1px solid var(--line);\r
  border-radius: var(--r-lg);\r
  background: var(--panel2);\r
}\r
\r
.kp-act__box-head {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-1) var(--s-3);\r
}\r
\r
.kp-act__box-total {\r
  margin-left: auto;\r
}\r
\r
.kp-act__grid {\r
  display: grid;\r
  grid-template-columns: repeat(10, minmax(0, 1fr));\r
  gap: 6px;\r
}\r
\r
@container (max-width: 480px) {\r
  .kp-act__grid {\r
    grid-template-columns: repeat(5, minmax(0, 1fr));\r
  }\r
}\r
\r
.kp-act__grid .kp-tcard {\r
  width: auto;\r
}\r
\r
.kp-act__box .kp-badge {\r
  right: 2px;\r
  bottom: 2px;\r
  padding: 0 4px;\r
  font-size: 9px;\r
}\r
\r
.kp-act__note {\r
  font-size: var(--t-meta);\r
  font-weight: 600;\r
}\r
\r
.kp-act__note--warn {\r
  color: var(--warn);\r
}\r
\r
.kp-act__note--new {\r
  color: var(--ok);\r
}\r
\r
.kp-act__note--muted {\r
  color: var(--fg2);\r
}\r
\r
.kp-act__row--mini {\r
  gap: var(--s-2);\r
  padding: var(--s-2) var(--s-3);\r
}\r
\r
.kp-act__mini {\r
  display: grid;\r
  grid-template-columns: 44px minmax(0, 1fr) auto auto;\r
  align-items: center;\r
  gap: var(--s-3);\r
  cursor: pointer;\r
}\r
\r
.kp-act__mini .kp-act__txt {\r
  gap: 1px;\r
}\r
\r
.kp-act__mini .kp-note {\r
  white-space: normal;\r
}\r
\r
.kp-act__money {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: flex-end;\r
  gap: 2px;\r
}\r
\r
.kp-act__amount {\r
  color: var(--cyan);\r
  font: 700 var(--t-base) var(--mono);\r
  white-space: nowrap;\r
}\r
\r
.kp-act__money .kp-act__net {\r
  padding: 1px 6px;\r
  font-size: var(--t-meta);\r
}\r
\r
.kp-act__mini .kp-art--missing {\r
  width: 44px;\r
}\r
\r
@media (max-width: 1100px) {\r
  .kp-act__list--board {\r
    grid-template-columns: repeat(3, minmax(0, 1fr));\r
  }\r
}\r
\r
@media (max-width: 760px) {\r
  .kp-act__boxes {\r
    grid-template-columns: minmax(0, 1fr);\r
  }\r
\r
  .kp-act__list--board {\r
    grid-template-columns: repeat(2, minmax(0, 1fr));\r
  }\r
\r
  .kp-act__list--minis {\r
    grid-template-columns: minmax(0, 1fr);\r
  }\r
\r
  .kp-act__tab-label {\r
    display: none;\r
  }\r
\r
  .kp-act__tab.on .kp-act__tab-label {\r
    display: inline;\r
  }\r
}\r
`;

  // src/main.js
  var features = [
    market_counter_default,
    market_offers_default,
    market_activity_default,
    collection_ghosts_default,
    collection_albums_default,
    collection_locks_default,
    collection_select_default,
    trade_dialog_default,
    profile_collection_default,
    friends_list_default,
    missions_series_default,
    profile_background_default,
    offer_dialog_default,
    free_packs_default,
    auto_open_default,
    header_nav_default
  ];
  var mounted = /* @__PURE__ */ new Map();
  function syncFeatures() {
    const url = new URL(location.href);
    for (const feature of features) {
      const active = feature.matches(url);
      if (active && !mounted.has(feature.id)) {
        mounted.set(feature.id, feature.mount());
      } else if (!active && mounted.has(feature.id)) {
        mounted.get(feature.id)();
        mounted.delete(feature.id);
      }
    }
  }
  injectStylesheet(config_default.ui.iconsCss);
  injectStyles(styles_default);
  onNavigate(syncFeatures);
})();
