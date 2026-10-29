// ==UserScript==
// @name         Kyara Plus
// @namespace    https://github.com/Mxyuki/Kyara-Script
// @version      2.31.0
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
  function createStore(initialState3) {
    const state = { ...initialState3 };
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
  var cardIdFromLink = (link) => Number(link?.getAttribute("href")?.match(/\/wiki\/(\d+)/)?.[1]);
  var cardImageUrl = (cardId) => `/cards/sm/${cardId}.webp`;
  var packIdFromPath = () => location.pathname.match(/^\/ouvrir\/([^/]+)/)?.[1];

  // src/lib/toast.js
  var container = null;
  function toast(message, tone = "info") {
    if (!container?.isConnected) {
      container = h("div", { class: "kp-toasts", role: "status" });
      document.body.append(container);
    }
    const item = h("div", { class: `kp-toast kp-toast--${tone}` }, message);
    container.append(item);
    setTimeout(() => item.remove(), config_default.ui.toastMs);
  }
  var FLASH_KEY = "kyara-plus:flash";
  function flashToast(message, tone = "info") {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, tone }));
  }
  function showFlashToast() {
    const stored = sessionStorage.getItem(FLASH_KEY);
    if (!stored) return;
    sessionStorage.removeItem(FLASH_KEY);
    const { message, tone } = JSON.parse(stored);
    toast(message, tone);
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
  function createAutoOpen({ store, api: api2, clock, notify: notify2, currentPackId }) {
    let pack = null;
    let regenMs = 0;
    let runId = 0;
    const state = () => store.get();
    const patch = (changes) => store.set(changes);
    const isCurrent = (id) => id === runId && state().enabled;
    async function load() {
      const packId = currentPackId();
      const [packs, serverConfig, me] = await Promise.all([api2.listPacks(), api2.getConfig(), api2.loadMe()]);
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
      if (reason) notify2.error(`Auto-ouverture arrêtée : ${reason}`);
    }
    function record(opened, cards) {
      if (opened === 0) return;
      const rarities = countByRarity(cards);
      const entry = { at: clock.now(), opened, rarities };
      patch({ opened: state().opened + opened, log: [entry, ...state().log].slice(0, config_default.autoOpen.logLimit) });
      const summary = rarities.map(([rarity, count]) => `${rarity}×${count}`).join(" ");
      notify2.success(`Auto-ouverture : ${plural(opened, "booster")} (${summary}).`);
    }
    async function openAll(id, known) {
      let me = known;
      let left = freeOpensLeft(pack, me);
      let opened = 0;
      const cards = [];
      while (left > 0 && isCurrent(id)) {
        const count = Math.min(left, config_default.packs.maxPerOpen);
        const { results = [], stopped = null } = await api2.openMany(pack.id, count);
        if (results.length === 0) {
          stop(stopped?.message ?? stopped?.code ?? "Le serveur n’a ouvert aucun booster.");
          break;
        }
        me = results.at(-1).user;
        notify2.pulled(results.at(-1));
        opened += results.length;
        cards.push(...pulledCards(results));
        left = stopped || results.length < count ? 0 : freeOpensLeft(pack, me);
        if (left > 0) await clock.sleep(config_default.autoOpen.gapMs * rush() + jitter(config_default.autoOpen.jitterMs));
      }
      record(opened, cards);
      return me;
    }
    async function cycleOnce(id, cycle, known) {
      const me = known ?? await api2.loadMe();
      if (!isCurrent(id)) return { me };
      const plan = planOpening({ pack, me, now: clock.now(), regenMs, cycle });
      patch({ phase: Phase.WAITING, target: plan.target, openAt: plan.openAt, leftNow: plan.leftNow });
      await sleepUntil(plan.openAt, id, config_default.autoOpen.resyncMs * rush());
      if (!isCurrent(id)) return { me };
      if (clock.now() < plan.openAt) return { me: null };
      const fresh = await api2.loadMe();
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
    const tone = !gain ? "flat" : gain > 0 ? "up" : "down";
    return h("span", { class: `kp-gain kp-gain--${tone}`, title: "Écart de prix moyen" }, formatGain(gain));
  }
  function giveButton(option, onClick, className = "") {
    const tone = option.entry.qty >= 2 ? "double" : "single";
    return h(
      "button",
      { class: `kp-btn kp-btn--${tone} ${className}`, type: "button", onClick },
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

  // src/features/market-counter.js
  var TAB_LIST = 'main [role="tablist"]';
  function placeLink(tabList, link) {
    const tabClass = tabList.querySelector('[role="tab"]')?.className.replace(/\bon\b/, "") ?? "";
    link.className = `${tabClass} kp-tab-link`;
    tabList.append(link);
  }
  var market_counter_default = {
    id: "market-counter",
    matches: (url) => url.pathname === "/marche",
    mount() {
      const link = h("a", { href: "/marche/chat", title: "Ouvrir le comptoir" }, "Comptoir ↗");
      document.body.classList.add("kp-market");
      const detach = keepAttached(link, TAB_LIST, placeLink);
      return () => {
        detach();
        link.remove();
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
  async function syncTradeLedger(myId) {
    const now = Date.now();
    const [offers, trades, notifications] = await Promise.all([
      tradesApi.offersMine(),
      tradesApi.mine(),
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

  // src/features/market-trades/analysis.js
  var difference = (incoming, outgoing) => incoming == null || outgoing == null ? null : incoming - outgoing;
  function describeSide({ cards, chakra = 0 }, { catalog, collection, priceOf: priceOf2 }) {
    const items = cards.map(({ characterId, qty = 1 }) => ({
      card: catalog.get(characterId),
      qty,
      price: priceOf2(characterId),
      owned: collection.get(characterId)?.qty ?? 0
    })).filter((item) => item.card);
    const prices = items.map((item) => item.price == null ? null : item.price * item.qty);
    const total = prices.includes(null) ? null : prices.reduce((sum, price) => sum + price, chakra);
    return { cards: items, chakra, total };
  }
  var tradeCardIds = (trade) => [...trade.give.cards, ...trade.want.cards].map((card) => card.characterId);
  function directTrade(trade, incoming, context) {
    const give = describeSide(incoming ? trade.want : trade.give, context);
    const receive = describeSide(incoming ? trade.give : trade.want, context);
    return { give, receive, net: difference(receive.total, give.total) };
  }
  function boardOffer(receiveIds, giveIds, context) {
    const toSide = (ids) => describeSide({ cards: ids.map((characterId) => ({ characterId })) }, context);
    const give = toSide(giveIds);
    const receive = toSide(receiveIds);
    if (give.cards.length === 1 && receive.cards.length === 1) {
      return { give, receive, net: difference(receive.total, give.total) };
    }
    if (receive.cards.length > 1 && give.cards.length === 1) {
      receive.total = void 0;
      receive.cards.forEach((item) => item.gain = difference(item.price, give.cards[0].price));
    }
    if (give.cards.length > 1 && receive.cards.length === 1) {
      give.total = void 0;
      give.cards.forEach((item) => item.gain = difference(receive.cards[0].price, item.price));
    }
    return { give, receive };
  }

  // src/features/market-trades/trade-panel.js
  var CLOSED_STATUSES = /* @__PURE__ */ new Set(["accepted", "declined", "cancelled", "expired"]);
  var gainTone = (gain) => gain == null || gain === 0 ? "flat" : gain > 0 ? "up" : "down";
  var cardCount = (side) => side.cards.reduce((count, item) => count + item.qty, 0);
  function ownedBadge(owned) {
    return owned > 0 ? h("span", { class: "kp-badge", title: "Exemplaires que tu as" }, `x${owned}`) : h("span", { class: "kp-badge kp-badge--new" }, "Nouveau");
  }
  function tradeCard({ card, qty, price, owned, gain }, { showName }) {
    return h(
      "div",
      { class: "kp-tcard", title: card.name },
      cardArt(card, "md", [ownedBadge(owned)]),
      showName ? h("strong", { class: "kp-name" }, qty > 1 ? `${card.name} ×${qty}` : card.name) : null,
      h("span", { class: "kp-price" }, qty > 1 && !showName ? `${formatChakra(price)} ×${qty}` : formatChakra(price)),
      gain === void 0 ? null : gainBadge(gain)
    );
  }
  var chakraTag = (side) => side.chakra ? h("span", { class: "kp-tag" }, `+ ${formatChakra(side.chakra)}`) : null;
  function compactSide(label, side) {
    const showTotal = side.total !== void 0 && (side.cards.length > 1 || side.chakra > 0);
    return h(
      "div",
      { class: "kp-trade__side" },
      h("span", { class: "kp-label" }, label),
      h("div", { class: "kp-trade__cards" }, side.cards.map((item) => tradeCard(item, { showName: true })), chakraTag(side)),
      showTotal ? h("span", { class: "kp-price kp-trade__total" }, `Total ${formatChakra(side.total)}`) : null
    );
  }
  function netLine(net) {
    if (net === void 0) return null;
    if (net == null) return h("div", { class: "kp-trade__net kp-trade__net--flat" }, "Bilan inconnu");
    if (net === 0) return h("div", { class: "kp-trade__net kp-trade__net--flat" }, "Échange équilibré");
    return h("div", { class: `kp-trade__net kp-trade__net--${gainTone(net)}` }, `${formatGain(net)} ◆ ${net > 0 ? "gagnés" : "perdus"}`);
  }
  function boardOfferPanel({ give, receive, net }) {
    return {
      body: h("div", { class: "kp-trade" }, compactSide("Tu reçois", receive), swapIcon(), compactSide("Tu donnes", give), netLine(net))
    };
  }
  function ownershipSummary(side, giving) {
    const items = side.cards;
    const notes = giving ? [[items.filter((item) => item.owned <= item.qty).length, "dernier exemplaire", "derniers exemplaires", "warn"]] : [
      [items.filter((item) => item.owned === 0).length, "nouvelle", "nouvelles", "new"],
      [items.filter((item) => item.owned > 0).length, "déjà possédée", "déjà possédées", "muted"]
    ];
    return notes.filter(([count]) => count > 0).map(([count, one, many, tone]) => h("span", { class: `kp-trade__note kp-trade__note--${tone}` }, `${count} ${count > 1 ? many : one}`));
  }
  function wideBox(label, side, { giving, open }) {
    return h(
      "section",
      { class: "kp-trade__box" },
      h(
        "header",
        { class: "kp-trade__box-head" },
        h("span", { class: "kp-label" }, `${label} · ${cardCount(side)}`),
        open ? ownershipSummary(side, giving) : null,
        chakraTag(side),
        h("span", { class: "kp-price kp-trade__box-total" }, `≈ ${formatChakra(side.total)}`)
      ),
      h("div", { class: "kp-trade__grid" }, side.cards.map((item) => tradeCard(item, { showName: false })))
    );
  }
  function netPill(net) {
    const text = net == null ? "Bilan inconnu" : net === 0 ? "Équilibré" : `${formatGain(net)} ◆ pour toi`;
    return h("span", { class: `kp-pill kp-pill--${gainTone(net)}` }, text);
  }
  function directTradePanel({ give, receive, net }, trade) {
    const open = !CLOSED_STATUSES.has(trade.status) && new Date(trade.expiresAt) > Date.now();
    return {
      header: h(
        "span",
        { class: "kp-trade__summary" },
        open ? h("span", { class: "kp-muted" }, `expire dans ${formatRemaining(trade.expiresAt)}`) : null,
        netPill(net)
      ),
      body: h(
        "div",
        { class: "kp-trade kp-trade--wide" },
        wideBox("Tu donnes", give, { giving: true, open }),
        swapIcon(),
        wideBox("Tu reçois", receive, { giving: false, open })
      )
    };
  }

  // src/features/market-trades/index.js
  var TAB_PANEL = 'main [role="tabpanel"]';
  var SECTIONS = [
    ["received", "Reçues"],
    ["sent", "Envoyées"],
    ["board", "Offres du tableau"]
  ];
  var SECTION_BY_TITLE = new Map(SECTIONS.map(([key, title]) => [title, key]));
  var DIRECT_TRADE_PREFIX = "echange-";
  function indexTrades({ incoming = [], outgoing = [] }) {
    return new Map([
      ...incoming.map((trade) => [trade.id, { trade, incoming: true }]),
      ...outgoing.map((trade) => [trade.id, { trade, incoming: false }])
    ]);
  }
  function tagSections(panel) {
    let key = null;
    for (const child of panel.children) {
      if (child.matches("h2")) key = SECTION_BY_TITLE.get(child.textContent.trim()) ?? null;
      if (key) child.dataset.kpSection = key;
    }
  }
  function boardOfferIds(item) {
    const ids = { receive: [], give: [] };
    for (const side of item.querySelectorAll(".sides .side")) {
      const target = side.querySelector(".sk")?.textContent.trim().startsWith("Tu reçois") ? ids.receive : ids.give;
      side.querySelectorAll("a.thumb").forEach((link) => target.push(cardIdFromLink(link)));
    }
    return ids;
  }
  function placePanel(item, { body, header: headerExtra }) {
    item.querySelector(":scope > .kp-trade")?.remove();
    item.querySelector(".kp-trade__summary")?.remove();
    item.classList.add("kp-trade-host");
    const header = item.querySelector(":scope > .th");
    if (header) header.after(body);
    else item.prepend(body);
    if (!headerExtra) return;
    const status = header?.querySelector(".st");
    if (status) status.before(headerExtra);
    else (header ?? item).append(headerExtra);
  }
  function placeTalkIcon(item) {
    item.querySelector(".kp-talk")?.remove();
    const talk = item.querySelector(".tact .talk");
    const player = item.querySelector(":scope > .th a");
    if (!talk || !player) return;
    const button = h("button", { class: "kp-talk", type: "button", title: "Discuter" }, icon("comment"));
    button.addEventListener("click", () => talk.click());
    player.after(button);
  }
  var market_trades_default = {
    id: "market-trades",
    matches: (url) => url.pathname === "/marche" && url.searchParams.get("onglet") === "echanges",
    mount() {
      let context = null;
      let trades = /* @__PURE__ */ new Map();
      let version = 0;
      let frame = 0;
      let active = readSetting("tradesTab", "received");
      const requestedTradeIds = /* @__PURE__ */ new Set();
      const requestedPriceIds = /* @__PURE__ */ new Set();
      const tabButtons = SECTIONS.map(([key, title]) => {
        const button = h("button", { class: "kp-chip", type: "button", "data-section": key }, title);
        button.addEventListener("click", () => {
          active = key;
          writeSetting("tradesTab", key);
          schedule();
        });
        return button;
      });
      const tabs = h("div", { class: "kp-filters kp-trade-tabs", role: "tablist" }, tabButtons);
      const refresh = () => {
        version++;
        schedule();
      };
      function fetchMissingPrices(ids) {
        const missing = ids.filter((id) => !requestedPriceIds.has(id));
        if (!missing.length) return;
        missing.forEach((id) => requestedPriceIds.add(id));
        loadPrices(missing).then(refresh).catch((error) => toast(describeError(error), "error"));
      }
      function fetchTrades(tradeId) {
        if (requestedTradeIds.has(tradeId)) return;
        requestedTradeIds.add(tradeId);
        tradesApi.mine().then((data) => {
          trades = indexTrades(data);
          fetchMissingPrices([...trades.values()].flatMap(({ trade }) => tradeCardIds(trade)));
          refresh();
        }).catch((error) => toast(describeError(error), "error"));
      }
      function renderTabs(panel) {
        document.body.dataset.kpTradesTab = active;
        for (const button of tabButtons) {
          const key = button.dataset.section;
          const count = panel.querySelectorAll(`[data-kp-section="${key}"] li.trade`).length;
          const label = `${SECTIONS.find(([section]) => section === key)[1]} (${count})`;
          button.setAttribute("aria-pressed", String(key === active));
          if (button.textContent !== label) button.textContent = label;
        }
      }
      function enhance(item) {
        if (item.dataset.kpVersion === String(version)) {
          if (!item.querySelector(".kp-talk")) placeTalkIcon(item);
          return;
        }
        let panel;
        if (item.id.startsWith(DIRECT_TRADE_PREFIX)) {
          const tradeId = item.id.slice(DIRECT_TRADE_PREFIX.length);
          const entry = trades.get(tradeId);
          if (!entry) return fetchTrades(tradeId);
          panel = directTradePanel(directTrade(entry.trade, entry.incoming, context), entry.trade);
        } else {
          const ids = boardOfferIds(item);
          fetchMissingPrices([...ids.receive, ...ids.give]);
          panel = boardOfferPanel(boardOffer(ids.receive, ids.give, context));
        }
        item.dataset.kpVersion = String(version);
        placePanel(item, panel);
        placeTalkIcon(item);
      }
      function decorate2() {
        const panel = document.querySelector(TAB_PANEL);
        if (!panel) return;
        tagSections(panel);
        renderTabs(panel);
        if (context) panel.querySelectorAll("li.trade").forEach(enhance);
      }
      function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      }
      const detach = keepAttached(tabs, TAB_PANEL, (panel, node) => {
        const intro = panel.querySelector(":scope > p.sub");
        if (intro) intro.after(node);
        else panel.prepend(node);
      });
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();
      Promise.all([loadCatalog(), loadCollection(), tradesApi.mine()]).then(([catalog, collection, data]) => {
        context = { catalog, collection, priceOf };
        trades = indexTrades(data);
        fetchMissingPrices([...trades.values()].flatMap(({ trade }) => tradeCardIds(trade)));
        refresh();
      }).catch((error) => toast(describeError(error), "error"));
      const syncLedger = () => loadMyId().then(syncTradeLedger);
      syncLedger().catch((error) => toast(describeError(error), "error"));
      const stopLedgerSync = startPolling(
        syncLedger,
        () => config_default.ledger.syncMs,
        (error) => toast(`Suivi des échanges arrêté : ${describeError(error)}`, "error")
      );
      return () => {
        stopLedgerSync();
        detach();
        observer.disconnect();
        cancelAnimationFrame(frame);
        tabs.remove();
        delete document.body.dataset.kpTradesTab;
        document.querySelectorAll(".kp-trade, .kp-trade__summary, .kp-talk").forEach((node) => node.remove());
        document.querySelectorAll(".kp-trade-host").forEach((item) => {
          item.classList.remove("kp-trade-host");
          delete item.dataset.kpVersion;
        });
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
  var tileCardId = (tile) => Number(tile.querySelector("img")?.getAttribute("src")?.match(/\/cards\/\w+\/(\d+)\./)?.[1]);
  function renderCount(tile, count) {
    let badge = tile.querySelector(":scope > .kp-count");
    if (count == null) return badge?.remove();
    if (!badge) {
      badge = h("span", { class: "kp-count" });
      tile.classList.add("kp-count-host");
      tile.append(badge);
    }
    const text = `×${count}`;
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle("kp-count--dupe", count >= config_default.profile.duplicateMin);
  }
  function clearCounts() {
    document.querySelectorAll(".kp-count").forEach((badge) => badge.remove());
    document.querySelectorAll(".kp-count-host").forEach((tile) => tile.classList.remove("kp-count-host"));
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
        const items = tiles.map((tile) => ({ tile, card: catalog?.get(tileCardId(tile)) })).filter((item) => item.card && item.tile.closest("li"));
        requestPrices(items.map((item) => item.card.id));
        const allLoaded = Boolean(catalog) && !shelf.querySelector("button.more");
        const ready = allLoaded && (pricesFailed || items.every((item) => isPriceLoaded(item.card.id)));
        const ordered = items.map(({ tile, card }) => ({ element: tile.closest("li"), card, price: priceOf(card.id) }));
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
          { key: "theyLack", label: "Il lui manque", keep: ({ tile }) => Boolean(tile.querySelector(".lack")) }
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
        for (const tile of tiles) {
          const id = tileCardId(tile);
          const count = counts ? counts.get(id) ?? 0 : null;
          renderCount(tile, count);
          const hidden = count != null && activeFilters.some((filter) => !filter.keep({ id, tile, count }));
          tile.closest("li")?.classList.toggle("kp-filtered-out", hidden);
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
  function boardOffers(analyses, activeFilters, rarities, search = "") {
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
  var initialState2 = () => ({
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
      const offers = boardOffers(state.analyses, activeFilters, activeRarities, search);
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
  var TABS = [
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
    const tabButtons = TABS.map(([key, label]) => {
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
    function fill(list, deals, emptyText, state) {
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
      fill(gainList, gainDeals(state.analyses, minGain), "Aucune offre à ce gain.", state);
      fill(bangerList, bangerDeals(state.analyses), "Aucune offre banger pour le moment.", state);
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
      const store = createStore(initialState2());
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
        for (const tile of document.querySelectorAll(OFFER_TILES)) {
          renderCount(tile, collection.get(tileCardId(tile))?.qty ?? 0);
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
        const header = section.querySelector(":scope > header");
        if (header && toggle.parentElement !== header) header.append(toggle);
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
  function placeButton(actions, button) {
    const copyLink = [...actions.querySelectorAll("button")].find((node) => node.textContent.trim() === COPY_LINK_LABEL);
    if (!copyLink) return actions.append(button);
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
body[data-kp-trades-tab] main [role='tabpanel'] > h2[data-kp-section],\r
body[data-kp-trades-tab='board'] main [data-kp-section]:not([data-kp-section='board']),\r
body[data-kp-trades-tab='received'] main [data-kp-section]:not([data-kp-section='received']),\r
body[data-kp-trades-tab='sent'] main [data-kp-section]:not([data-kp-section='sent']) {\r
  display: none !important;\r
}\r
\r
.kp-trade-tabs {\r
  margin: var(--s-3) 0;\r
}\r
\r
.kp-trade-host > .compact,\r
.kp-trade-host > .trays,\r
.kp-trade-host > .verdict,\r
.kp-trade-host > .more,\r
.kp-trade-host > .sides {\r
  display: none !important;\r
}\r
\r
.kp-badge--new {\r
  color: var(--ok);\r
}\r
\r
[data-kp-section='board'] .kp-trade-host {\r
  text-align: center;\r
}\r
\r
[data-kp-section='board'] .kp-trade-host > .th {\r
  justify-content: center;\r
  gap: var(--s-2);\r
}\r
\r
body[data-kp-trades-tab] main [role='tabpanel'] ul.trades[data-kp-section='board'] {\r
  display: grid;\r
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));\r
  align-items: start;\r
  gap: var(--s-3);\r
}\r
\r
.kp-trade {\r
  display: grid;\r
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r
  align-items: start;\r
  gap: var(--s-2);\r
  margin: var(--s-2) 0;\r
}\r
\r
.kp-trade > .kp-swap {\r
  align-self: center;\r
  color: var(--acc);\r
  font-size: 14px;\r
}\r
\r
.kp-trade__side {\r
  display: flex;\r
  flex-direction: column;\r
  align-items: center;\r
  gap: var(--s-2);\r
  min-width: 0;\r
}\r
\r
.kp-trade__cards {\r
  display: flex;\r
  flex-wrap: wrap;\r
  justify-content: center;\r
  gap: var(--s-2);\r
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
.kp-trade__cards:has(> .kp-tcard:nth-child(2)) .kp-tcard {\r
  width: 60px;\r
}\r
\r
.kp-trade__total {\r
  color: var(--mut);\r
}\r
\r
.kp-trade__net {\r
  grid-column: 1 / -1;\r
  justify-self: center;\r
  font-family: var(--mono);\r
  font-size: var(--t-base);\r
  font-weight: 700;\r
}\r
\r
.kp-trade__net--up {\r
  color: var(--ok);\r
}\r
\r
.kp-trade__net--down {\r
  color: var(--danger);\r
}\r
\r
.kp-trade__net--flat {\r
  color: var(--mut);\r
}\r
\r
.kp-trade--wide {\r
  display: grid;\r
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r
  align-items: stretch;\r
  gap: var(--s-3);\r
}\r
\r
.kp-trade--wide > .kp-swap {\r
  align-self: center;\r
  color: var(--acc);\r
}\r
\r
.kp-trade__summary {\r
  display: inline-flex;\r
  align-items: center;\r
  gap: var(--s-3);\r
  margin-left: auto;\r
  margin-right: var(--s-2);\r
}\r
\r
.kp-pill {\r
  padding: 2px 10px;\r
  border: 1px solid currentColor;\r
  border-radius: var(--r-pill);\r
  font-family: var(--mono);\r
  font-size: var(--t-sm);\r
  font-weight: 700;\r
}\r
\r
.kp-pill--up {\r
  color: var(--ok);\r
}\r
\r
.kp-pill--down {\r
  color: var(--danger);\r
}\r
\r
.kp-pill--flat {\r
  color: var(--mut);\r
}\r
\r
.kp-trade__box {\r
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
.kp-trade__box-head {\r
  display: flex;\r
  flex-wrap: wrap;\r
  align-items: center;\r
  gap: var(--s-1) var(--s-3);\r
}\r
\r
.kp-trade__box-total {\r
  margin-left: auto;\r
}\r
\r
.kp-trade__grid {\r
  display: grid;\r
  grid-template-columns: repeat(10, minmax(0, 1fr));\r
  gap: 6px;\r
}\r
\r
@container (max-width: 480px) {\r
  .kp-trade__grid {\r
    grid-template-columns: repeat(5, minmax(0, 1fr));\r
  }\r
}\r
\r
.kp-trade__grid .kp-tcard {\r
  width: auto;\r
}\r
\r
.kp-trade__box .kp-badge {\r
  right: 2px;\r
  bottom: 2px;\r
  padding: 0 4px;\r
  font-size: 9px;\r
}\r
\r
.kp-trade__note {\r
  font-size: var(--t-meta);\r
  font-weight: 600;\r
}\r
\r
.kp-trade__note--warn {\r
  color: var(--warn);\r
}\r
\r
.kp-trade__note--new {\r
  color: var(--ok);\r
}\r
\r
.kp-trade__note--muted {\r
  color: var(--fg2);\r
}\r
\r
.kp-trade-host .tact .talk {\r
  display: none !important;\r
}\r
\r
.kp-trade-host .tact:not(:has(> :not(.talk))) {\r
  display: none !important;\r
}\r
\r
.kp-talk {\r
  display: inline-grid;\r
  place-items: center;\r
  width: 22px;\r
  height: 22px;\r
  margin-left: 6px;\r
  padding: 0;\r
  border: none;\r
  border-radius: 50%;\r
  background: transparent;\r
  color: var(--mut);\r
  font-size: 13px;\r
  vertical-align: middle;\r
  cursor: pointer;\r
}\r
\r
.kp-talk:hover {\r
  background: var(--raise);\r
  color: var(--fg);\r
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

.kp-auto-open__trigger {
  position: relative;
  display: inline-grid;
  place-items: center;
  font-size: 18px;
}

.kp-auto-open__trigger.is-live::after {
  content: '';
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 6px var(--ok);
}

.kp-auto-open {
  position: fixed;
  top: 72px;
  right: 16px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  width: min(380px, calc(100vw - 32px));
  padding: var(--s-4);
  border: 1px solid var(--line2);
  border-radius: var(--r-lg);
  background: var(--panel);
  box-shadow: var(--sh-1);
  color: var(--fg);
}

.kp-auto-open[hidden] {
  display: none;
}

.kp-auto-open__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kp-auto-open__status {
  margin: 0;
  font-size: var(--t-sm);
  font-weight: 600;
}

.kp-auto-open .kp-field {
  flex-wrap: wrap;
}

.kp-auto-open .kp-field .kp-label {
  flex: 1 0 100%;
}

.kp-auto-open__log {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.kp-auto-open__log-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-sm);
}

.kp-auto-open__gems {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-family: var(--mono);
}

/* The site's "Tu es toujours là ?" prompt is a browser-only idle pause (nothing is sent to the server); the
   auto-open runs on its own requests, so the prompt would only cover the page while it works. */
body.kp-auto-open-on [role='dialog'][aria-labelledby='idle-t'] {
  display: none !important;
}
`;

  // src/main.js
  var features = [
    market_counter_default,
    market_offers_default,
    market_trades_default,
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
    auto_open_default
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
