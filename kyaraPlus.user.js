// ==UserScript==
// @name         Kyara Plus
// @namespace    https://github.com/Mxyuki/Kyara-Script
// @version      2.25.1
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
  // src/api/errors.js
  var ErrorCode = {
    NETWORK: "network",
    PASS_REQUIRED: "pass_required",
    QUEUED: "queued"
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
  var isGone = (error) => error instanceof ApiError && [404, 409, 410].includes(error.status);

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
  function buildHeaders({ hasBody, withPass }) {
    const headers = { "x-device-id": localStorage.getItem("kyara_device") ?? "" };
    const token = localStorage.getItem("kyara_token");
    const pass = withPass ? readPass() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    if (hasBody) headers["content-type"] = "application/json";
    if (pass) headers["x-pass"] = pass;
    return headers;
  }
  async function send(path, { method, body, withPass }) {
    await waitForTurn();
    try {
      return await fetch(`/api${path}`, {
        method,
        headers: buildHeaders({ hasBody: body !== void 0, withPass }),
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, ErrorCode.NETWORK);
    }
  }
  async function request(path, { method = "GET", body, withPass = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await send(path, { method, body, withPass });
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

  // src/data/catalog.js
  var pending = null;
  function loadCatalog() {
    pending ??= catalogApi.characters().then((characters) => new Map(characters.map((character) => [character.id, character]))).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  }

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

  // src/lib/site.js
  var profileIdFromPath = () => location.pathname.match(/^\/profil\/([^/]+)/)?.[1];
  var cardIdFromLink = (link) => Number(link?.getAttribute("href")?.match(/\/wiki\/(\d+)/)?.[1]);

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

  // src/lib/icon.js
  var icon = (name) => h("i", { class: `fa-solid fa-${name}`, "aria-hidden": "true" });

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

  // src/features/collection-order.js
  var CARD_CELL2 = "main .grid > .cell";
  var collection_order_default = {
    id: "collection-order",
    matches: (url) => url.pathname === "/collection",
    mount() {
      let catalog = null;
      let frame = 0;
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
      function decorate2() {
        const items = [...document.querySelectorAll(CARD_CELL2)].map((cell) => ({ element: cell, card: catalog.get(cardIdFromLink(cell.querySelector("a.slot"))) })).filter((item) => item.card);
        requestPrices(items.map((item) => item.card.id));
        const ready = pricesFailed || items.every((item) => isPriceLoaded(item.card.id));
        sorter.apply(items.map((item) => ({ ...item, price: priceOf(item.card.id) })), ready);
      }
      function schedule() {
        if (!catalog || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          decorate2();
        });
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      loadCatalog().then((loaded) => {
        catalog = loaded;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        sorter.stop();
        clearOrder(document.querySelectorAll(CARD_CELL2));
      };
    }
  };

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
  var plural = (count, word) => `${formatNumber(count)} ${word}${count > 1 ? "s" : ""}`;
  var searchKey = (text) => text.normalize("NFD").replace(new RegExp("\\p{Diacritic}", "gu"), "").toLowerCase();

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
  var CARD_CELL3 = "main .cell";
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
          document.querySelectorAll(CARD_CELL3).forEach(decorateCell);
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
      h("img", { src: card.image, alt: card.name, loading: "lazy" }),
      overlays
    );
  }
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

  // src/lib/store.js
  function createStore(initialState2) {
    const state = { ...initialState2 };
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
  function bangerDeals(analyses) {
    return analyses.flatMap((analysis) => {
      const rank = rarityRank(analysis.received.rarity);
      if (rank > BANGER_MAX_RANK) return [];
      const option = bestOption(analysis.options, (o) => isGivable(o) && rarityRank(o.card.rarity) > rank);
      return option ? [{ analysis, option }] : [];
    }).sort(byDealPriority);
  }
  function gainDeals(analyses, minGain) {
    return analyses.flatMap((analysis) => {
      const option = bestOption(analysis.options, (o) => isGivable(o) && o.gain != null && o.gain >= minGain);
      return option ? [{ analysis, option }] : [];
    }).sort((a, b) => newFirst(a, b) || descending(a.option.gain, b.option.gain));
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
    stopReason: null
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
    async function acceptDeal({ analysis, option }) {
      tried.add(analysis.offer.id);
      try {
        await take(analysis, option);
      } catch (error) {
        if (!isGone(error)) stop(describeError(error));
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
      patch({ enabled, stopReason: null });
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
  var Phase = {
    IDLE: "idle",
    LOADING: "loading",
    READY: "ready",
    ERROR: "error"
  };
  var initialState = () => ({
    phase: Phase.IDLE,
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
      store.set({ phase: Phase.LOADING, scanned: 0, error: null });
      try {
        const [catalog, collection, wishlist] = await Promise.all([loadCatalog(), loadCollection(), loadWishlist()]);
        if (loadGeneration !== generation) return;
        context = { catalog, collection, wishlist, priceOf };
        startLive();
        await scanOffers(catalog, filters, loadGeneration);
        if (loadGeneration === generation) store.set({ phase: Phase.READY });
        auto.consider();
      } catch (error) {
        if (loadGeneration === generation) store.set({ phase: Phase.ERROR, error: describeError(error) });
      }
    }
    function announce(fresh) {
      const freshIds = new Set(fresh.map((offer) => offer.id));
      const analyses = store.get().analyses.filter((analysis) => freshIds.has(analysis.offer.id));
      const bangers = bangerDeals(analyses);
      const bangerIds = new Set(bangers.map((deal) => deal.analysis.offer.id));
      const gains = gainDeals(analyses, readSetting("minGain", config_default.side.defaultMinGain)).filter(
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
  function statusText(state, count) {
    if (state.phase === Phase.LOADING) return `Analyse des offres… ${formatNumber(state.scanned)}`;
    if (state.phase === Phase.ERROR) return state.error;
    if (state.phase === Phase.READY) return plural(count, "offre");
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
      status.textContent = statusText(state, offers.length);
      showHiddenButton.hidden = state.hiddenCount === 0;
      showHiddenButton.textContent = `Réafficher les masquées (${state.hiddenCount})`;
      if (state.phase === Phase.READY && offers.length === 0) {
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
  var timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
  var gem = (rarity) => h("span", { class: "kp-gem", title: RARITY_LABELS[rarity], style: { "--kp-rarity": rarityColor(rarity) } }, rarity);
  function statusText2({ auto, live }) {
    const parts = [live ? "En direct" : "Suivi en direct arrêté"];
    if (auto.enabled) parts.push(`auto-accept actif, ${plural(auto.log.length, "échange")}`);
    else if (auto.stopReason) parts.push(`auto-accept arrêté : ${auto.stopReason}`);
    else if (!hasAutoRule(autoSettings(auto))) parts.push("coche les échanges à accepter tout seul");
    return parts.join(" · ");
  }
  function logRow({ received, given, at }) {
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
        h("span", { class: "kp-note", title: given.name }, `contre ${given.name} · ${timeFormat.format(at)}`)
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
      status.textContent = statusText2(state);
      toggle.textContent = enabled ? "Arrêter" : "Activer";
      toggle.classList.toggle("kp-btn--warn", enabled);
      toggle.disabled = !enabled && !hasAutoRule(autoSettings(auto));
      doubles.setAttribute("aria-pressed", String(doublesOnly));
      gainChip.setAttribute("aria-pressed", String(gainEnabled));
      if (document.activeElement !== gainInput) gainInput.value = String(auto.minGain);
      for (const [key, button] of cells) button.setAttribute("aria-pressed", String(auto.rules.has(key)));
      log.replaceChildren(...auto.log.map(logRow));
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
          "Toutes les offres qui rapportent au moins le gain minimum. Les nouvelles arrivent en haut."
        ),
        gainList
      ),
      h(
        "div",
        { class: "kp-side__block" },
        h("h3", { class: "kp-title kp-title--sm" }, "Offres bangers"),
        h("p", { class: "kp-muted" }, "Une Mythique ou Légendaire contre une carte de rareté inférieure."),
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
      if (state.phase !== Phase.READY && deals.length === 0) {
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
      const store = createStore(initialState());
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
  var styles_default = "body.kp-market main aside.chat-side > :not(.kp-side) {\n  display: none !important;\n}\n\nbody.kp-market:not(.kp-offers) main aside.chat-side {\n  display: none !important;\n}\n\nbody.kp-market:not(.kp-offers) main .layout {\n  grid-template-columns: minmax(0, 1fr) !important;\n}\n\nbody.kp-offers main .wrap {\n  --wrap: 1320px;\n}\n\nbody.kp-offers main .layout {\n  grid-template-columns: minmax(0, 1fr) 400px !important;\n}\n\n/* The site may render its offer dialogs inside the board, so only the board's own content is hidden. */\nbody.kp-offers main section.board {\n  display: contents !important;\n}\n\nbody.kp-offers main section.board > :not([role='dialog']):not(:has([role='dialog'])) {\n  display: none !important;\n}\n\n.kp-tab-link {\n  display: inline-flex;\n  align-items: center;\n  color: inherit;\n  text-decoration: none;\n}\n\n.kp-filters {\n  display: flex;\n  flex-wrap: wrap;\n  gap: var(--s-2);\n}\n\n.kp-chip {\n  padding: 5px 12px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  background: transparent;\n  color: var(--fg2);\n  font: 500 var(--t-sm) var(--body);\n  cursor: pointer;\n}\n\n.kp-chip:hover {\n  background: var(--raise);\n}\n\n.kp-chip[aria-pressed='true'] {\n  border-color: var(--acc);\n  background: var(--acc-soft);\n  color: var(--fg);\n}\n\n.kp-title {\n  margin: 0;\n  font-family: var(--disp);\n  font-size: var(--t-h3);\n}\n\n.kp-title--sm {\n  font-size: var(--t-base);\n}\n\n.kp-muted,\n.kp-empty {\n  margin: 0;\n  color: var(--mut);\n  font-size: var(--t-sm);\n}\n\n.kp-empty {\n  padding: var(--s-6) 0;\n  text-align: center;\n}\n\n.kp-label {\n  color: var(--mut);\n  font-size: var(--t-meta);\n  letter-spacing: 0.06em;\n  text-transform: uppercase;\n}\n\n.kp-name {\n  overflow: hidden;\n  font-size: var(--t-sm);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.kp-price {\n  color: var(--fg2);\n  font-family: var(--mono);\n  font-size: var(--t-meta);\n}\n\n.kp-note {\n  overflow: hidden;\n  color: var(--mut);\n  font-size: var(--t-meta);\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.kp-note--warn {\n  color: var(--warn);\n}\n\n.kp-note--new {\n  color: var(--ok);\n}\n\n.kp-note--wish {\n  color: var(--wish);\n}\n\n.kp-tag {\n  align-self: flex-start;\n  padding: 2px 8px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  color: var(--fg2);\n  font-size: var(--t-meta);\n}\n\n.kp-art {\n  position: relative;\n  display: block;\n  overflow: hidden;\n  aspect-ratio: 2 / 3;\n  border: 3px solid var(--kp-rarity);\n  border-radius: var(--r-md);\n  background: var(--bg2);\n  box-shadow: 0 0 14px color-mix(in srgb, var(--kp-rarity) 30%, transparent);\n}\n\n.kp-art img {\n  display: block;\n  width: 100%;\n  height: 100%;\n  object-fit: cover;\n}\n\n.kp-art--md {\n  width: 100%;\n}\n\n.kp-art--lg {\n  width: 120px;\n}\n\n.kp-art--sm {\n  width: 44px;\n  border-width: 2px;\n  border-radius: var(--r-sm);\n}\n\n.kp-badge {\n  position: absolute;\n  right: 4px;\n  bottom: 4px;\n  padding: 1px 6px;\n  border-radius: var(--r-pill);\n  background: color-mix(in srgb, var(--bg) 85%, transparent);\n  color: var(--fg);\n  font-family: var(--mono);\n  font-size: var(--t-meta);\n  line-height: 1.4;\n}\n\n.kp-badge--lock {\n  top: 4px;\n  bottom: auto;\n  color: var(--warn);\n}\n\n.kp-art--sm .kp-badge {\n  right: 1px;\n  bottom: 1px;\n  padding: 0 3px;\n  font-size: 9px;\n}\n\n.kp-art--sm .kp-badge--lock {\n  top: 1px;\n  bottom: auto;\n}\n\n.kp-swap {\n  align-self: center;\n  color: var(--mut);\n  font-size: 18px;\n  text-align: center;\n}\n\n.kp-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  padding: 6px 10px;\n  border: 1px solid transparent;\n  border-radius: var(--r-md);\n  background: var(--acc);\n  color: #fff;\n  font: 600 var(--t-sm) var(--body);\n  cursor: pointer;\n  transition: background 0.15s, opacity 0.15s;\n}\n\n.kp-btn[hidden] {\n  display: none;\n}\n\n.kp-btn:hover {\n  background: var(--acc2);\n}\n\n.kp-btn--ghost {\n  border-color: var(--line2);\n  background: transparent;\n  color: var(--fg);\n}\n\n.kp-btn--ghost:hover {\n  background: var(--raise);\n}\n\n.kp-btn--warn {\n  background: var(--warn);\n  color: var(--bg);\n}\n\n.kp-btn--double {\n  background: #ff5f1f;\n  color: var(--bg);\n}\n\n.kp-btn--double:hover {\n  background: #ff7a45;\n}\n\n.kp-btn--single {\n  background: var(--gold);\n  color: var(--bg);\n}\n\n.kp-btn--single:hover {\n  background: #ffd84d;\n}\n\n.kp-btn--sm {\n  padding: 4px 8px;\n  font-size: var(--t-meta);\n}\n\n.kp-gain {\n  padding: 1px 6px;\n  border-radius: var(--r-pill);\n  font-family: var(--mono);\n  font-size: var(--t-meta);\n  white-space: nowrap;\n}\n\n.kp-gain--up {\n  background: color-mix(in srgb, var(--ok) 18%, transparent);\n  color: var(--ok);\n}\n\n.kp-gain--down {\n  background: color-mix(in srgb, var(--danger) 18%, transparent);\n  color: var(--danger);\n}\n\n.kp-gain--flat {\n  background: var(--raise);\n  color: var(--mut);\n}\n\n.kp-btn .kp-gain {\n  background: var(--bg);\n}\n\n.kp-board {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-4);\n}\n\n.kp-board__bar {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: flex-end;\n  justify-content: space-between;\n  gap: var(--s-3);\n}\n\n.kp-board__actions {\n  display: flex;\n  gap: var(--s-2);\n}\n\n.kp-board__list {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-5);\n}\n\n.kp-group {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-3);\n}\n\n.kp-group__title {\n  margin: 0;\n  padding-bottom: var(--s-2);\n  border-bottom: 1px solid color-mix(in srgb, var(--kp-rarity) 40%, transparent);\n  color: var(--kp-rarity);\n  font-family: var(--disp);\n  font-size: var(--t-base);\n}\n\n.kp-offer {\n  position: relative;\n  display: grid;\n  grid-template-columns: 132px 24px minmax(0, 1fr);\n  gap: var(--s-4);\n  padding: var(--s-3);\n  border: 1px solid var(--line);\n  border-radius: var(--r-lg);\n  background: var(--panel);\n  transition: opacity 0.15s;\n}\n\n.kp-offer__get,\n.kp-option {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 0;\n}\n\n.kp-offer__give {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-2);\n  min-width: 0;\n}\n\n.kp-options {\n  display: grid;\n  grid-template-columns: repeat(5, 112px);\n  justify-content: start;\n  gap: var(--s-3);\n}\n\n.kp-option--missing {\n  opacity: 0.35;\n}\n\n.kp-option .kp-btn {\n  width: 100%;\n  margin-top: auto;\n  padding: 4px 6px;\n  font-size: var(--t-meta);\n}\n\n.kp-hide {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 26px;\n  height: 26px;\n  padding: 0;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  background: var(--panel2);\n  color: var(--mut);\n  cursor: pointer;\n}\n\n.kp-hide:hover {\n  background: var(--raise);\n  color: var(--fg);\n}\n\n.kp-offer > .kp-hide {\n  position: absolute;\n  top: var(--s-2);\n  right: var(--s-2);\n}\n\n.kp-deal .kp-hide {\n  width: 22px;\n  height: 22px;\n  margin-left: auto;\n  font-size: 11px;\n}\n\n.kp-more {\n  align-self: center;\n}\n\n.is-busy {\n  opacity: 0.45;\n  pointer-events: none;\n}\n\n.kp-side {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-5);\n  height: 100%;\n  overflow-y: auto;\n  padding: var(--s-4);\n  border: 1px solid var(--line);\n  border-radius: var(--r-lg);\n  background: var(--panel);\n}\n\n.kp-side__controls {\n  position: sticky;\n  top: calc(-1 * var(--s-4));\n  z-index: 1;\n  margin: calc(-1 * var(--s-4)) calc(-1 * var(--s-4)) 0;\n  padding: var(--s-3) var(--s-4);\n  border-bottom: 1px solid var(--line);\n  background: var(--panel);\n}\n\n.kp-side__block {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-3);\n}\n\n.kp-field {\n  display: flex;\n  align-items: center;\n  gap: var(--s-2);\n}\n\n.kp-input {\n  flex: 1;\n  min-width: 0;\n  padding: 6px 10px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-md);\n  background: var(--bg2);\n  color: var(--fg);\n  font-family: var(--mono);\n}\n\n.kp-input:focus {\n  border-color: var(--acc);\n  outline: none;\n}\n\n.kp-board__search {\n  flex-basis: 100%;\n  max-width: 420px;\n}\n\n.kp-deals {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-2);\n}\n\n.kp-deal {\n  display: grid;\n  grid-template-columns: 44px auto 44px minmax(0, 1fr);\n  align-items: center;\n  gap: var(--s-2);\n  padding: var(--s-2);\n  border: 1px solid var(--line);\n  border-radius: var(--r-md);\n  background: var(--panel2);\n}\n\n.kp-deal .kp-swap {\n  font-size: 12px;\n}\n\n.kp-deal__info {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n\n.kp-deal__actions {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--s-2);\n  margin-top: 2px;\n}\n\n.kp-deal.is-new {\n  border-color: var(--acc);\n  box-shadow: 0 0 0 1px var(--acc-soft);\n}\n\n.kp-new {\n  margin-right: 6px;\n  padding: 1px 6px;\n  border-radius: var(--r-pill);\n  background: var(--acc);\n  color: #fff;\n  font-size: var(--t-meta);\n  font-weight: 700;\n}\n\n.kp-auto {\n  padding: var(--s-3);\n  border: 1px solid var(--line2);\n  border-radius: var(--r-md);\n  background: var(--panel2);\n}\n\n.kp-auto__head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: var(--s-2);\n}\n\n.kp-rules {\n  border-spacing: 4px;\n  margin: 0 -4px;\n}\n\n.kp-rules th {\n  font-weight: 400;\n  text-align: center;\n}\n\n.kp-rules thead th:first-child {\n  max-width: 90px;\n  text-align: left;\n}\n\n.kp-gem {\n  display: inline-grid;\n  place-items: center;\n  width: 22px;\n  height: 22px;\n  border: 2px solid var(--kp-rarity);\n  border-radius: 50%;\n  color: var(--kp-rarity);\n  font: 900 10px var(--body);\n}\n\n.kp-rule {\n  display: block;\n  width: 28px;\n  height: 28px;\n  margin: auto;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-sm, 6px);\n  background: transparent;\n  cursor: pointer;\n}\n\n.kp-rule:hover {\n  border-color: var(--kp-rarity);\n}\n\n.kp-rule[aria-pressed='true'] {\n  border-color: var(--kp-rarity);\n  background: var(--kp-rarity);\n  box-shadow: 0 0 10px color-mix(in srgb, var(--kp-rarity) 50%, transparent);\n}\n\n.kp-side__tabs {\n  display: flex;\n  gap: var(--s-2);\n}\n\n.kp-side__view {\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-5);\n}\n\n.kp-side__view[hidden] {\n  display: none;\n}\n\n/* A dot on the Auto-accept tab while it runs, so it stays visible from the Offres tab. */\n.kp-side__tabs .kp-chip.is-live::after {\n  content: '';\n  display: inline-block;\n  width: 7px;\n  height: 7px;\n  margin-left: 6px;\n  border-radius: 50%;\n  background: var(--ok);\n  box-shadow: 0 0 6px var(--ok);\n  vertical-align: middle;\n}\n\n.kp-auto__head .kp-btn:disabled {\n  cursor: not-allowed;\n}\n\n.kp-auto > .kp-chip {\n  align-self: flex-start;\n}\n\n.kp-toasts {\n  position: fixed;\n  right: 16px;\n  bottom: 16px;\n  z-index: 2147483647;\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-2);\n}\n\n.kp-toast {\n  max-width: 360px;\n  padding: 10px 14px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-md);\n  background: var(--raise);\n  box-shadow: var(--sh-1);\n  color: var(--fg);\n  font-size: var(--t-sm);\n}\n\n.kp-toast--success {\n  border-color: var(--ok);\n}\n\n.kp-toast--error {\n  border-color: var(--danger);\n}\n\n.kp-replaced {\n  display: none !important;\n}\n\n.tcg.kp-ghost {\n  filter: saturate(0.45) brightness(0.8);\n}\n\n.tcg.kp-ghost .art img {\n  filter: grayscale(1) brightness(0.7);\n}\n\n.kp-filtered-out {\n  display: none !important;\n}\n\n.kp-album-filters {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: var(--s-3);\n  margin: var(--s-3) 0;\n}\n\n.kp-input--short {\n  flex: 0 0 72px;\n  width: 72px;\n}\n\n.kp-gem-chip {\n  display: inline-grid;\n  place-items: center;\n  width: 26px;\n  height: 26px;\n  padding: 0;\n  border: 2px solid var(--kp-rarity);\n  border-radius: 50%;\n  background: transparent;\n  color: var(--kp-rarity);\n  font: 900 11px var(--body);\n  cursor: pointer;\n}\n\n.kp-gem-chip[aria-pressed='true'] {\n  background: var(--kp-rarity);\n  box-shadow: 0 0 12px color-mix(in srgb, var(--kp-rarity) 60%, transparent);\n  color: var(--bg);\n}\n\n.kp-btn:disabled {\n  opacity: 0.5;\n  cursor: progress;\n}\n\n.kp-lock-host {\n  position: relative;\n}\n\n.kp-lock-host .pin {\n  display: none !important;\n}\n\n.kp-lock {\n  position: absolute;\n  top: 2px;\n  left: 0;\n  z-index: 6;\n  display: grid;\n  place-items: center;\n  width: 30px;\n  height: 30px;\n  padding: 0;\n  border: 1px solid var(--line2);\n  border-radius: 50%;\n  background: var(--panel2);\n  color: var(--dim);\n  font-size: 13px;\n  cursor: pointer;\n  opacity: 0;\n  transition: opacity 0.15s, color 0.15s;\n}\n\n.kp-lock-host:hover .kp-lock,\n.kp-lock.is-locked,\n.kp-lock:focus-visible {\n  opacity: 1;\n}\n\n.kp-lock.is-locked {\n  color: var(--warn);\n}\n\n.kp-lock:hover {\n  color: var(--fg);\n}\n\n.kp-pick-host {\n  position: relative;\n}\n\n.kp-pick {\n  position: absolute;\n  top: 2px;\n  left: 34px;\n  z-index: 6;\n  display: grid;\n  place-items: center;\n  min-width: 30px;\n  height: 30px;\n  padding: 0 6px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  background: var(--panel2);\n  color: var(--dim);\n  font: 700 12px var(--mono);\n  cursor: pointer;\n  opacity: 0;\n  transition: opacity 0.15s, color 0.15s;\n}\n\n.kp-pick-host:hover .kp-pick,\n.kp-pick.is-picked,\n.kp-pick:focus-visible {\n  opacity: 1;\n}\n\n.kp-pick:hover {\n  color: var(--fg);\n}\n\n.kp-pick.is-picked {\n  border-color: var(--acc);\n  background: var(--acc);\n  color: #fff;\n}\n\n.kp-picked .slot {\n  outline: 2px solid var(--acc);\n  outline-offset: 2px;\n  border-radius: var(--r-md);\n}\n\n.kp-pick-bar {\n  position: fixed;\n  bottom: 16px;\n  left: 50%;\n  z-index: 1000;\n  display: flex;\n  align-items: center;\n  gap: var(--s-3);\n  padding: 8px 8px 8px 16px;\n  border: 1px solid var(--acc);\n  border-radius: var(--r-pill);\n  background: var(--raise);\n  box-shadow: var(--sh-1);\n  color: var(--fg);\n  font-size: var(--t-sm);\n  transform: translateX(-50%);\n}\n\n.kp-pick-bar[hidden] {\n  display: none;\n}\n\n.kp-fair {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: var(--s-2) var(--s-3);\n  border: 1px solid var(--line2);\n  border-radius: var(--r-md);\n  background: var(--panel2);\n  font-size: var(--t-sm);\n}\n\n.kp-releases {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  margin: 0;\n  padding: 0;\n  list-style: none;\n  font-size: var(--t-meta);\n}\n\n.kp-release__time {\n  display: inline-block;\n  min-width: 82px;\n  color: var(--fg2);\n  font-family: var(--mono);\n}\n\n\n.kp-pc__completion {\n  font-weight: 600;\n}\n\n.kp-lock:disabled {\n  cursor: progress;\n}\n\nbody[data-kp-trades-tab] main [role='tabpanel'] > h2[data-kp-section],\nbody[data-kp-trades-tab='board'] main [data-kp-section]:not([data-kp-section='board']),\nbody[data-kp-trades-tab='received'] main [data-kp-section]:not([data-kp-section='received']),\nbody[data-kp-trades-tab='sent'] main [data-kp-section]:not([data-kp-section='sent']) {\n  display: none !important;\n}\n\n.kp-trade-tabs {\n  margin: var(--s-3) 0;\n}\n\n.kp-trade-host > .compact,\n.kp-trade-host > .trays,\n.kp-trade-host > .verdict,\n.kp-trade-host > .more,\n.kp-trade-host > .sides {\n  display: none !important;\n}\n\n.kp-badge--new {\n  color: var(--ok);\n}\n\n[data-kp-section='board'] .kp-trade-host {\n  text-align: center;\n}\n\n[data-kp-section='board'] .kp-trade-host > .th {\n  justify-content: center;\n  gap: var(--s-2);\n}\n\nbody[data-kp-trades-tab] main [role='tabpanel'] ul.trades[data-kp-section='board'] {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));\n  align-items: start;\n  gap: var(--s-3);\n}\n\n.kp-trade {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\n  align-items: start;\n  gap: var(--s-2);\n  margin: var(--s-2) 0;\n}\n\n.kp-trade > .kp-swap {\n  align-self: center;\n  color: var(--acc);\n  font-size: 14px;\n}\n\n.kp-trade__side {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: var(--s-2);\n  min-width: 0;\n}\n\n.kp-trade__cards {\n  display: flex;\n  flex-wrap: wrap;\n  justify-content: center;\n  gap: var(--s-2);\n}\n\n.kp-tcard {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 2px;\n  width: 92px;\n  min-width: 0;\n}\n\n.kp-tcard .kp-name {\n  max-width: 100%;\n}\n\n.kp-trade__cards:has(> .kp-tcard:nth-child(2)) .kp-tcard {\n  width: 60px;\n}\n\n.kp-trade__total {\n  color: var(--mut);\n}\n\n.kp-trade__net {\n  grid-column: 1 / -1;\n  justify-self: center;\n  font-family: var(--mono);\n  font-size: var(--t-base);\n  font-weight: 700;\n}\n\n.kp-trade__net--up {\n  color: var(--ok);\n}\n\n.kp-trade__net--down {\n  color: var(--danger);\n}\n\n.kp-trade__net--flat {\n  color: var(--mut);\n}\n\n.kp-trade--wide {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\n  align-items: stretch;\n  gap: var(--s-3);\n}\n\n.kp-trade--wide > .kp-swap {\n  align-self: center;\n  color: var(--acc);\n}\n\n.kp-trade__summary {\n  display: inline-flex;\n  align-items: center;\n  gap: var(--s-3);\n  margin-left: auto;\n  margin-right: var(--s-2);\n}\n\n.kp-pill {\n  padding: 2px 10px;\n  border: 1px solid currentColor;\n  border-radius: var(--r-pill);\n  font-family: var(--mono);\n  font-size: var(--t-sm);\n  font-weight: 700;\n}\n\n.kp-pill--up {\n  color: var(--ok);\n}\n\n.kp-pill--down {\n  color: var(--danger);\n}\n\n.kp-pill--flat {\n  color: var(--mut);\n}\n\n.kp-trade__box {\n  container-type: inline-size;\n  display: flex;\n  flex-direction: column;\n  gap: var(--s-2);\n  padding: var(--s-2) var(--s-3) var(--s-3);\n  border: 1px solid var(--line);\n  border-radius: var(--r-lg);\n  background: var(--panel2);\n}\n\n.kp-trade__box-head {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: var(--s-1) var(--s-3);\n}\n\n.kp-trade__box-total {\n  margin-left: auto;\n}\n\n.kp-trade__grid {\n  display: grid;\n  grid-template-columns: repeat(10, minmax(0, 1fr));\n  gap: 6px;\n}\n\n@container (max-width: 480px) {\n  .kp-trade__grid {\n    grid-template-columns: repeat(5, minmax(0, 1fr));\n  }\n}\n\n.kp-trade__grid .kp-tcard {\n  width: auto;\n}\n\n.kp-trade__box .kp-badge {\n  right: 2px;\n  bottom: 2px;\n  padding: 0 4px;\n  font-size: 9px;\n}\n\n.kp-trade__note {\n  font-size: var(--t-meta);\n  font-weight: 600;\n}\n\n.kp-trade__note--warn {\n  color: var(--warn);\n}\n\n.kp-trade__note--new {\n  color: var(--ok);\n}\n\n.kp-trade__note--muted {\n  color: var(--fg2);\n}\n\n.kp-trade-host .tact .talk {\n  display: none !important;\n}\n\n.kp-trade-host .tact:not(:has(> :not(.talk))) {\n  display: none !important;\n}\n\n.kp-talk {\n  display: inline-grid;\n  place-items: center;\n  width: 22px;\n  height: 22px;\n  margin-left: 6px;\n  padding: 0;\n  border: none;\n  border-radius: 50%;\n  background: transparent;\n  color: var(--mut);\n  font-size: 13px;\n  vertical-align: middle;\n  cursor: pointer;\n}\n\n.kp-talk:hover {\n  background: var(--raise);\n  color: var(--fg);\n}\n\n.kp-count-host {\n  container-type: inline-size;\n}\n\n/* The tile image spans the tile width with a 5:7 ratio, so its bottom edge sits at 140% of that width. */\n.kp-count {\n  position: absolute;\n  top: calc(140cqw - 22px);\n  right: 5px;\n  padding: 0 6px;\n  border-radius: var(--r-pill);\n  background: #0a090ed9;\n  color: var(--fg2);\n  font: 700 11px var(--mono);\n  line-height: 18px;\n  pointer-events: none;\n}\n\n.kp-count--dupe {\n  color: var(--ok);\n}\n\n.kp-site-only {\n  display: none !important;\n}\n\n.kp-native-hidden {\n  display: none !important;\n}\n\nbody.kp-modal-open {\n  overflow: hidden;\n}\n\n.kp-modal {\n  position: fixed;\n  inset: 0;\n  z-index: 1000;\n  display: grid;\n  place-items: center;\n  padding: var(--s-4);\n  background: color-mix(in srgb, var(--bg) 70%, transparent);\n  backdrop-filter: blur(4px);\n}\n\n.kp-pc {\n  display: flex;\n  flex-direction: column;\n  width: min(1200px, 100%);\n  height: min(900px, 100%);\n  overflow: hidden;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-lg);\n  background: var(--panel);\n  box-shadow: var(--sh-1);\n}\n\n.kp-pc__head {\n  display: flex;\n  align-items: center;\n  gap: var(--s-3);\n  padding: var(--s-3) var(--s-4);\n  border-bottom: 1px solid var(--line);\n}\n\n.kp-pc__close {\n  margin-left: auto;\n}\n\n.kp-pc__filters {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: var(--s-2) var(--s-3);\n  padding: var(--s-3) var(--s-4);\n  border-bottom: 1px solid var(--line);\n}\n\n.kp-pc__filters .kp-input {\n  flex: 0 1 200px;\n}\n\n.kp-pc__body {\n  flex: 1;\n  overflow-y: auto;\n  padding: var(--s-4);\n}\n\n.kp-pc__grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));\n  gap: var(--s-3);\n}\n\n.kp-pc__grid .kp-empty {\n  grid-column: 1 / -1;\n}\n\n.kp-pc__sentinel {\n  height: 1px;\n}\n\n.kp-pcard {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  min-width: 0;\n}\n\n.kp-badge--dupe {\n  color: var(--ok);\n}\n\n.kp-badge--corner {\n  top: 4px;\n  right: auto;\n  bottom: auto;\n  left: 4px;\n}\n\n.kp-pc__total {\n  padding: 2px 10px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  color: var(--fg);\n  font: 700 var(--t-sm) var(--mono);\n}\n\n.kp-friend-search {\n  display: block;\n  width: 100%;\n  max-width: 880px;\n  margin-bottom: var(--s-3);\n}\n\nbody.kp-friends main ul.people {\n  display: flex;\n  flex-direction: column;\n}\n\nbody.kp-friends main ul.people > li.kp-pinned {\n  order: -1;\n  box-shadow: inset 3px 0 0 var(--gold);\n}\n\n.kp-pin,\n.kp-friend-act {\n  display: inline-flex !important;\n  flex: none;\n  align-items: center;\n  justify-content: center;\n  gap: 0 !important;\n  box-sizing: border-box;\n  width: 32px;\n  height: 32px;\n  min-width: 0 !important;\n  min-height: 0 !important;\n  margin: 0 !important;\n  padding: 0 !important;\n  line-height: 0 !important;\n  vertical-align: middle;\n  border: 1px solid var(--line2) !important;\n  border-radius: 50% !important;\n  background: var(--panel2) !important;\n  color: var(--mut) !important;\n  font-size: 0 !important;\n  text-decoration: none !important;\n  cursor: pointer;\n  transition: color 0.15s, background 0.15s;\n}\n\n.kp-pin i,\n.kp-friend-act i {\n  width: 1.25em;\n  font-size: 13px;\n  line-height: 1;\n  text-align: center;\n}\n\n.kp-pin:hover,\n.kp-friend-act:hover {\n  background: var(--raise) !important;\n  color: var(--fg) !important;\n}\n\n.kp-friend-act[data-kp-icon='Retirer']:hover,\n.kp-friend-act[data-kp-icon='Bloquer']:hover {\n  color: var(--danger) !important;\n}\n\n.kp-pin.is-pinned {\n  border-color: var(--gold) !important;\n  color: var(--gold) !important;\n}\n\n.kp-pin.is-pinned i {\n  transform: rotate(-45deg);\n}\n\n.kp-friend-act--confirm {\n  gap: 6px !important;\n  width: auto;\n  padding: 0 12px !important;\n  border-color: var(--danger) !important;\n  border-radius: var(--r-pill) !important;\n  color: var(--danger) !important;\n  font-size: var(--t-sm) !important;\n  line-height: 1 !important;\n}\n\n.kp-series-collapsed > ul.quests {\n  display: none !important;\n}\n\n.kp-series-toggle {\n  display: inline-flex;\n  align-items: center;\n  gap: var(--s-2);\n  margin-left: auto;\n  padding: 4px 12px;\n  border: 1px solid var(--line2);\n  border-radius: var(--r-pill);\n  background: var(--panel2);\n  color: var(--fg2);\n  font: 600 var(--t-sm) var(--body);\n  cursor: pointer;\n}\n\n.kp-series-toggle:hover {\n  background: var(--raise);\n  color: var(--fg);\n}\n\n.kp-series-summary.has-claim {\n  color: var(--ok);\n}\n\n.kp-series-chevron {\n  display: inline-flex;\n  font-size: 11px;\n  transition: transform 0.15s;\n}\n\n.kp-series-toggle[aria-expanded='true'] .kp-series-chevron {\n  transform: rotate(180deg);\n}\n\nhtml:has(body.kp-video-bg),\nbody.kp-video-bg,\nbody.kp-video-bg main section.band,\nbody.kp-video-bg main .box.coll {\n  background: transparent !important;\n}\n\n.kp-bg-video {\n  position: fixed;\n  inset: 0;\n  z-index: -1;\n  width: 100vw;\n  height: 100vh;\n  object-fit: cover;\n  filter: brightness(0.45);\n  pointer-events: none;\n}\n\n.kp-filters__rarities {\n  margin-left: auto;\n}\n";

  // src/main.js
  var features = [
    market_counter_default,
    market_offers_default,
    market_trades_default,
    collection_ghosts_default,
    collection_albums_default,
    collection_locks_default,
    collection_order_default,
    collection_select_default,
    trade_dialog_default,
    profile_collection_default,
    friends_list_default,
    missions_series_default,
    profile_background_default,
    offer_dialog_default
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
