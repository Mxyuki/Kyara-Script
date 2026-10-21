// ==UserScript==
// @name         Kyara Plus
// @namespace    kyara-plus
// @version      2.17.1
// @description  Marché, échanges et collection améliorés pour kyara.games
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
    setPinned: (characterId, pinned) => request(`/me/collection/${characterId}/pin`, { method: "POST", body: { pinned } })
  };
  var tradesApi = {
    mine: () => request("/me/trades"),
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
  var plural = (count, word) => `${formatNumber(count)} ${word}${count > 1 ? "s" : ""}`;
  var searchKey = (text) => text.normalize("NFD").replace(new RegExp("\\p{Diacritic}", "gu"), "").toLowerCase();

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
    const spare = (entry?.qty ?? 0) - 1;
    return [
      spare > 0 ? h("span", { class: "kp-badge kp-badge--count", title: plural(spare, "doublon") }, `+${spare}`) : null,
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
      return () => {
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

  // src/features/trade-dialog.js
  var SHELF = '[role="dialog"] .shelf';
  var DUPLICATE_MIN = config_default.profile.duplicateMin;
  var tileCardId = (tile) => Number(tile.querySelector("img")?.getAttribute("src")?.match(/\/cards\/\w+\/(\d+)\./)?.[1]);
  var isTheirTabSelected = (shelf) => [...shelf.querySelectorAll('.tabs [role="tab"]')].findIndex((tab) => tab.getAttribute("aria-selected") === "true") === 1;
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
    badge.classList.toggle("kp-count--dupe", count >= DUPLICATE_MIN);
  }
  var trade_dialog_default = {
    id: "trade-dialog",
    matches: (url) => url.pathname.startsWith("/profil/"),
    mount() {
      let collection = null;
      let frame = 0;
      const theirCounts = /* @__PURE__ */ new Map();
      const active = /* @__PURE__ */ new Set();
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
        for (const tile of shelf.querySelectorAll("ul.grid button.tile")) {
          const id = tileCardId(tile);
          const count = counts ? counts.get(id) ?? 0 : null;
          renderCount(tile, count);
          const hidden = count != null && activeFilters.some((filter) => !filter.keep({ id, tile, count }));
          tile.closest("li")?.classList.toggle("kp-filtered-out", hidden);
        }
      }
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
      loadCollection().then((loaded) => {
        collection = loaded;
        schedule();
      }).catch((error) => toast(describeError(error), "error"));
      return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        Object.values(chips).flat().forEach((chip) => chip.remove());
        document.querySelectorAll(".kp-site-only").forEach((chip) => chip.classList.remove("kp-site-only"));
        document.querySelectorAll(".kp-count").forEach((badge) => badge.remove());
        document.querySelectorAll(".kp-count-host").forEach((tile) => tile.classList.remove("kp-count-host"));
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
  function boardOffers(analyses, activeFilters) {
    const tests = [...activeFilters].map((filter) => FILTER_TESTS[filter]);
    return analyses.filter((analysis) => hasOwnedOption(analysis) && tests.every((test) => test(analysis))).sort(byBoardPriority);
  }
  var byDealPriority = (a, b) => rarityRank(a.analysis.received.rarity) - rarityRank(b.analysis.received.rarity) || descending(gainKey(a.option.gain), gainKey(b.option.gain));
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
    }).sort((a, b) => descending(a.option.gain, b.option.gain));
  }

  // src/data/wishlist.js
  async function loadWishlist() {
    const { wishlist } = await meApi.bootstrap();
    return new Set(wishlist ?? []);
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
  var initialState = {
    phase: Phase.IDLE,
    scanned: 0,
    error: null,
    analyses: [],
    hiddenCount: 0,
    busy: /* @__PURE__ */ new Set()
  };
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
    const publish = (extra = {}) => store.set({
      ...extra,
      hiddenCount: hiddenIds.size,
      analyses: offers.filter((offer) => !hiddenIds.has(offer.id)).map((offer) => analyzeOffer(offer, context)).filter(Boolean)
    });
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
        await scanOffers(catalog, filters, loadGeneration);
        if (loadGeneration === generation) store.set({ phase: Phase.READY });
      } catch (error) {
        if (loadGeneration === generation) store.set({ phase: Phase.ERROR, error: describeError(error) });
      }
    }
    async function give({ offer, received }, { card }) {
      setBusy(offer.id, true);
      try {
        await tradesApi.acceptOffer(offer.id, card.id);
      } catch (error) {
        if (isGone(error)) dropOffer(offer.id);
        toast(describeError(error), "error");
        return;
      } finally {
        setBusy(offer.id, false);
      }
      toast(`Échange fait : ${received.name} contre ${card.name}.`, "success");
      dropOffer(offer.id);
      await refreshCollection();
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
    return { load, focus, give, unlock, hide, showHidden };
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
  function createBoard(controller) {
    let visibleCount = config_default.offers.renderStep;
    const activeFilters = new Set(readSetting("offerFilters", [Filter.TRADEABLE]));
    let lastState = null;
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
          h("button", { class: "kp-btn kp-btn--ghost", type: "button", onClick: () => controller.load([...activeFilters]) }, "Actualiser")
        )
      ),
      h("div", { class: "kp-filters", role: "group", "aria-label": "Filtres" }, filterChips),
      list
    );
    const showMore = () => {
      visibleCount += config_default.offers.renderStep;
      rerender();
    };
    function render(state) {
      lastState = state;
      const offers = boardOffers(state.analyses, activeFilters);
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

  // src/features/market-offers/side-panel.js
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
      { class: `kp-deal${isBusy ? " is-busy" : ""}` },
      cardArt(analysis.received, "sm"),
      swapIcon(),
      cardArt(option.card, "sm", optionOverlays(option)),
      h(
        "div",
        { class: "kp-deal__info" },
        h("strong", { class: "kp-name", title: analysis.received.name }, analysis.received.name),
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
    const onInput = (event) => {
      const digits = event.target.value.replace(/\D/g, "");
      event.target.value = digits;
      minGain = Number(digits) || 0;
      writeSetting("minGain", minGain);
      if (lastState) render(lastState);
    };
    const root = h(
      "section",
      { class: "kp-side", "aria-label": "Offres intéressantes" },
      h(
        "label",
        { class: "kp-field kp-side__controls" },
        h("span", { class: "kp-label" }, "Gain minimum"),
        h("input", { class: "kp-input", type: "text", inputmode: "numeric", value: String(minGain), onInput }),
        h("span", { class: "kp-muted" }, "chakra")
      ),
      h(
        "div",
        { class: "kp-side__block" },
        h("h3", { class: "kp-title kp-title--sm" }, "Offres rentables"),
        h("p", { class: "kp-muted" }, "Toutes les offres qui rapportent au moins le gain minimum."),
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
      fill(gainList, gainDeals(state.analyses, minGain), "Aucune offre à ce gain.", state);
      fill(bangerList, bangerDeals(state.analyses), "Aucune offre banger pour le moment.", state);
    }
    return { root, render };
  }

  // src/features/market-offers/index.js
  var NATIVE_BOARD = "main section.board";
  var SIDE_COLUMN = "main aside.chat-side";
  var market_offers_default = {
    id: "market-offers",
    matches: (url) => url.pathname === "/marche" && url.searchParams.get("onglet") === "offres",
    mount() {
      const store = createStore(initialState);
      const controller = createOffersController(store);
      const board = createBoard(controller);
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
        unsubscribe();
        detachers.forEach((detach) => detach());
        board.root.remove();
        side.root.remove();
        document.body.classList.remove("kp-offers");
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
  var byRarityThenName = (a, b) => rarityRank(a.card.rarity) - rarityRank(b.card.rarity) || a.card.name.localeCompare(b.card.name, "fr");
  function buildEntries({ catalog, ownedIds, tradeable, myCollection }) {
    return ownedIds.map((id) => catalog.get(id)).filter(Boolean).map((card) => ({
      card,
      tradeable: tradeable.get(card.id) ?? 0,
      mine: myCollection.get(card.id)?.qty ?? 0,
      nameKey: searchKey(card.name),
      seriesKey: searchKey(card.series ?? "")
    })).sort(byRarityThenName);
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
    const status = h("span", { class: "kp-muted" }, "Chargement…");
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
    function render() {
      if (!entries) return;
      shown = filterEntries(entries, filters);
      renderTotal();
      rendered = 0;
      grid.replaceChildren();
      body.scrollTop = 0;
      status.textContent = `${formatNumber(shown.length)} / ${plural(entries.length, "carte")}`;
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
      setEntries(loaded) {
        entries = loaded;
        seriesList.replaceChildren(...seriesOf(entries).map((series) => h("option", { value: series })));
        render();
      },
      showPrices() {
        pricesReady = true;
        const byId = new Map(entries.map((entry) => [String(entry.card.id), entry]));
        for (const tile of grid.querySelectorAll(".kp-pcard")) {
          tile.querySelector(".kp-price").textContent = formatPrice(byId.get(tile.dataset.cardId)?.price);
        }
        renderTotal();
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
    return buildEntries({ catalog, ownedIds, tradeable, myCollection });
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
        cache2.get(userId2).then(async (entries) => {
          current.setEntries(entries);
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
  var styles_default = "body.kp-market main aside.chat-side > :not(.kp-side) {\r\n  display: none !important;\r\n}\r\n\r\nbody.kp-market:not(.kp-offers) main aside.chat-side {\r\n  display: none !important;\r\n}\r\n\r\nbody.kp-market:not(.kp-offers) main .layout {\r\n  grid-template-columns: minmax(0, 1fr) !important;\r\n}\r\n\r\nbody.kp-offers main .wrap {\r\n  --wrap: 1320px;\r\n}\r\n\r\nbody.kp-offers main .layout {\r\n  grid-template-columns: minmax(0, 1fr) 400px !important;\r\n}\r\n\r\nbody.kp-offers main section.board {\r\n  display: none !important;\r\n}\r\n\r\n.kp-tab-link {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  color: inherit;\r\n  text-decoration: none;\r\n}\r\n\r\n.kp-filters {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-chip {\r\n  padding: 5px 12px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-pill);\r\n  background: transparent;\r\n  color: var(--fg2);\r\n  font: 500 var(--t-sm) var(--body);\r\n  cursor: pointer;\r\n}\r\n\r\n.kp-chip:hover {\r\n  background: var(--raise);\r\n}\r\n\r\n.kp-chip[aria-pressed='true'] {\r\n  border-color: var(--acc);\r\n  background: var(--acc-soft);\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-title {\r\n  margin: 0;\r\n  font-family: var(--disp);\r\n  font-size: var(--t-h3);\r\n}\r\n\r\n.kp-title--sm {\r\n  font-size: var(--t-base);\r\n}\r\n\r\n.kp-muted,\r\n.kp-empty {\r\n  margin: 0;\r\n  color: var(--mut);\r\n  font-size: var(--t-sm);\r\n}\r\n\r\n.kp-empty {\r\n  padding: var(--s-6) 0;\r\n  text-align: center;\r\n}\r\n\r\n.kp-label {\r\n  color: var(--mut);\r\n  font-size: var(--t-meta);\r\n  letter-spacing: 0.06em;\r\n  text-transform: uppercase;\r\n}\r\n\r\n.kp-name {\r\n  overflow: hidden;\r\n  font-size: var(--t-sm);\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.kp-price {\r\n  color: var(--fg2);\r\n  font-family: var(--mono);\r\n  font-size: var(--t-meta);\r\n}\r\n\r\n.kp-note {\r\n  overflow: hidden;\r\n  color: var(--mut);\r\n  font-size: var(--t-meta);\r\n  text-overflow: ellipsis;\r\n  white-space: nowrap;\r\n}\r\n\r\n.kp-note--warn {\r\n  color: var(--warn);\r\n}\r\n\r\n.kp-note--new {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-note--wish {\r\n  color: var(--wish);\r\n}\r\n\r\n.kp-tag {\r\n  align-self: flex-start;\r\n  padding: 2px 8px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-pill);\r\n  color: var(--fg2);\r\n  font-size: var(--t-meta);\r\n}\r\n\r\n.kp-art {\r\n  position: relative;\r\n  display: block;\r\n  overflow: hidden;\r\n  aspect-ratio: 2 / 3;\r\n  border: 3px solid var(--kp-rarity);\r\n  border-radius: var(--r-md);\r\n  background: var(--bg2);\r\n  box-shadow: 0 0 14px color-mix(in srgb, var(--kp-rarity) 30%, transparent);\r\n}\r\n\r\n.kp-art img {\r\n  display: block;\r\n  width: 100%;\r\n  height: 100%;\r\n  object-fit: cover;\r\n}\r\n\r\n.kp-art--md {\r\n  width: 100%;\r\n}\r\n\r\n.kp-art--lg {\r\n  width: 120px;\r\n}\r\n\r\n.kp-art--sm {\r\n  width: 44px;\r\n  border-width: 2px;\r\n  border-radius: var(--r-sm);\r\n}\r\n\r\n.kp-badge {\r\n  position: absolute;\r\n  right: 4px;\r\n  bottom: 4px;\r\n  padding: 1px 6px;\r\n  border-radius: var(--r-pill);\r\n  background: color-mix(in srgb, var(--bg) 85%, transparent);\r\n  color: var(--fg);\r\n  font-family: var(--mono);\r\n  font-size: var(--t-meta);\r\n  line-height: 1.4;\r\n}\r\n\r\n.kp-badge--lock {\r\n  top: 4px;\r\n  bottom: auto;\r\n  color: var(--warn);\r\n}\r\n\r\n.kp-art--sm .kp-badge {\r\n  right: 1px;\r\n  bottom: 1px;\r\n  padding: 0 3px;\r\n  font-size: 9px;\r\n}\r\n\r\n.kp-art--sm .kp-badge--lock {\r\n  top: 1px;\r\n  bottom: auto;\r\n}\r\n\r\n.kp-swap {\r\n  align-self: center;\r\n  color: var(--mut);\r\n  font-size: 18px;\r\n  text-align: center;\r\n}\r\n\r\n.kp-btn {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 6px;\r\n  padding: 6px 10px;\r\n  border: 1px solid transparent;\r\n  border-radius: var(--r-md);\r\n  background: var(--acc);\r\n  color: #fff;\r\n  font: 600 var(--t-sm) var(--body);\r\n  cursor: pointer;\r\n  transition: background 0.15s, opacity 0.15s;\r\n}\r\n\r\n.kp-btn[hidden] {\r\n  display: none;\r\n}\r\n\r\n.kp-btn:hover {\r\n  background: var(--acc2);\r\n}\r\n\r\n.kp-btn--ghost {\r\n  border-color: var(--line2);\r\n  background: transparent;\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-btn--ghost:hover {\r\n  background: var(--raise);\r\n}\r\n\r\n.kp-btn--warn {\r\n  background: var(--warn);\r\n  color: var(--bg);\r\n}\r\n\r\n.kp-btn--double {\r\n  background: #ff5f1f;\r\n  color: var(--bg);\r\n}\r\n\r\n.kp-btn--double:hover {\r\n  background: #ff7a45;\r\n}\r\n\r\n.kp-btn--single {\r\n  background: var(--gold);\r\n  color: var(--bg);\r\n}\r\n\r\n.kp-btn--single:hover {\r\n  background: #ffd84d;\r\n}\r\n\r\n.kp-btn--sm {\r\n  padding: 4px 8px;\r\n  font-size: var(--t-meta);\r\n}\r\n\r\n.kp-gain {\r\n  padding: 1px 6px;\r\n  border-radius: var(--r-pill);\r\n  font-family: var(--mono);\r\n  font-size: var(--t-meta);\r\n  white-space: nowrap;\r\n}\r\n\r\n.kp-gain--up {\r\n  background: color-mix(in srgb, var(--ok) 18%, transparent);\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-gain--down {\r\n  background: color-mix(in srgb, var(--danger) 18%, transparent);\r\n  color: var(--danger);\r\n}\r\n\r\n.kp-gain--flat {\r\n  background: var(--raise);\r\n  color: var(--mut);\r\n}\r\n\r\n.kp-btn .kp-gain {\r\n  background: var(--bg);\r\n}\r\n\r\n.kp-board {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-4);\r\n}\r\n\r\n.kp-board__bar {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  align-items: flex-end;\r\n  justify-content: space-between;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-board__actions {\r\n  display: flex;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-board__list {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-5);\r\n}\r\n\r\n.kp-group {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-group__title {\r\n  margin: 0;\r\n  padding-bottom: var(--s-2);\r\n  border-bottom: 1px solid color-mix(in srgb, var(--kp-rarity) 40%, transparent);\r\n  color: var(--kp-rarity);\r\n  font-family: var(--disp);\r\n  font-size: var(--t-base);\r\n}\r\n\r\n.kp-offer {\r\n  position: relative;\r\n  display: grid;\r\n  grid-template-columns: 132px 24px minmax(0, 1fr);\r\n  gap: var(--s-4);\r\n  padding: var(--s-3);\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r-lg);\r\n  background: var(--panel);\r\n  transition: opacity 0.15s;\r\n}\r\n\r\n.kp-offer__get,\r\n.kp-option {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 4px;\r\n  min-width: 0;\r\n}\r\n\r\n.kp-offer__give {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-2);\r\n  min-width: 0;\r\n}\r\n\r\n.kp-options {\r\n  display: grid;\r\n  grid-template-columns: repeat(5, 112px);\r\n  justify-content: start;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-option--missing {\r\n  opacity: 0.35;\r\n}\r\n\r\n.kp-option .kp-btn {\r\n  width: 100%;\r\n  margin-top: auto;\r\n  padding: 4px 6px;\r\n  font-size: var(--t-meta);\r\n}\r\n\r\n.kp-hide {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 26px;\r\n  height: 26px;\r\n  padding: 0;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-pill);\r\n  background: var(--panel2);\r\n  color: var(--mut);\r\n  cursor: pointer;\r\n}\r\n\r\n.kp-hide:hover {\r\n  background: var(--raise);\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-offer > .kp-hide {\r\n  position: absolute;\r\n  top: var(--s-2);\r\n  right: var(--s-2);\r\n}\r\n\r\n.kp-deal .kp-hide {\r\n  width: 22px;\r\n  height: 22px;\r\n  margin-left: auto;\r\n  font-size: 11px;\r\n}\r\n\r\n.kp-more {\r\n  align-self: center;\r\n}\r\n\r\n.is-busy {\r\n  opacity: 0.45;\r\n  pointer-events: none;\r\n}\r\n\r\n.kp-side {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-5);\r\n  height: 100%;\r\n  overflow-y: auto;\r\n  padding: var(--s-4);\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r-lg);\r\n  background: var(--panel);\r\n}\r\n\r\n.kp-side__controls {\r\n  position: sticky;\r\n  top: calc(-1 * var(--s-4));\r\n  z-index: 1;\r\n  margin: calc(-1 * var(--s-4)) calc(-1 * var(--s-4)) 0;\r\n  padding: var(--s-3) var(--s-4);\r\n  border-bottom: 1px solid var(--line);\r\n  background: var(--panel);\r\n}\r\n\r\n.kp-side__block {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-field {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-input {\r\n  flex: 1;\r\n  min-width: 0;\r\n  padding: 6px 10px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-md);\r\n  background: var(--bg2);\r\n  color: var(--fg);\r\n  font-family: var(--mono);\r\n}\r\n\r\n.kp-input:focus {\r\n  border-color: var(--acc);\r\n  outline: none;\r\n}\r\n\r\n.kp-deals {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-deal {\r\n  display: grid;\r\n  grid-template-columns: 44px auto 44px minmax(0, 1fr);\r\n  align-items: center;\r\n  gap: var(--s-2);\r\n  padding: var(--s-2);\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r-md);\r\n  background: var(--panel2);\r\n}\r\n\r\n.kp-deal .kp-swap {\r\n  font-size: 12px;\r\n}\r\n\r\n.kp-deal__info {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n  min-width: 0;\r\n}\r\n\r\n.kp-deal__actions {\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: space-between;\r\n  gap: var(--s-2);\r\n  margin-top: 2px;\r\n}\r\n\r\n.kp-toasts {\r\n  position: fixed;\r\n  right: 16px;\r\n  bottom: 16px;\r\n  z-index: 2147483647;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-toast {\r\n  max-width: 360px;\r\n  padding: 10px 14px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-md);\r\n  background: var(--raise);\r\n  box-shadow: var(--sh-1);\r\n  color: var(--fg);\r\n  font-size: var(--t-sm);\r\n}\r\n\r\n.kp-toast--success {\r\n  border-color: var(--ok);\r\n}\r\n\r\n.kp-toast--error {\r\n  border-color: var(--danger);\r\n}\r\n\r\n.kp-replaced {\r\n  display: none !important;\r\n}\r\n\r\n.tcg.kp-ghost {\r\n  filter: saturate(0.45) brightness(0.8);\r\n}\r\n\r\n.tcg.kp-ghost .art img {\r\n  filter: grayscale(1) brightness(0.7);\r\n}\r\n\r\n.kp-filtered-out {\r\n  display: none !important;\r\n}\r\n\r\n.kp-album-filters {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  align-items: center;\r\n  gap: var(--s-3);\r\n  margin: var(--s-3) 0;\r\n}\r\n\r\n.kp-input--short {\r\n  flex: 0 0 72px;\r\n  width: 72px;\r\n}\r\n\r\n.kp-gem-chip {\r\n  display: inline-grid;\r\n  place-items: center;\r\n  width: 26px;\r\n  height: 26px;\r\n  padding: 0;\r\n  border: 2px solid var(--kp-rarity);\r\n  border-radius: 50%;\r\n  background: transparent;\r\n  color: var(--kp-rarity);\r\n  font: 900 11px var(--body);\r\n  cursor: pointer;\r\n}\r\n\r\n.kp-gem-chip[aria-pressed='true'] {\r\n  background: var(--kp-rarity);\r\n  box-shadow: 0 0 12px color-mix(in srgb, var(--kp-rarity) 60%, transparent);\r\n  color: var(--bg);\r\n}\r\n\r\n.kp-btn:disabled {\r\n  opacity: 0.5;\r\n  cursor: progress;\r\n}\r\n\r\n.kp-lock-host {\r\n  position: relative;\r\n}\r\n\r\n.kp-lock-host .pin {\r\n  display: none !important;\r\n}\r\n\r\n.kp-lock {\r\n  position: absolute;\r\n  top: 2px;\r\n  left: 0;\r\n  z-index: 6;\r\n  display: grid;\r\n  place-items: center;\r\n  width: 30px;\r\n  height: 30px;\r\n  padding: 0;\r\n  border: 1px solid var(--line2);\r\n  border-radius: 50%;\r\n  background: var(--panel2);\r\n  color: var(--dim);\r\n  font-size: 13px;\r\n  cursor: pointer;\r\n  opacity: 0;\r\n  transition: opacity 0.15s, color 0.15s;\r\n}\r\n\r\n.kp-lock-host:hover .kp-lock,\r\n.kp-lock.is-locked,\r\n.kp-lock:focus-visible {\r\n  opacity: 1;\r\n}\r\n\r\n.kp-lock.is-locked {\r\n  color: var(--warn);\r\n}\r\n\r\n.kp-lock:hover {\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-lock:disabled {\r\n  cursor: progress;\r\n}\r\n\r\nbody[data-kp-trades-tab] main [role='tabpanel'] > h2[data-kp-section],\r\nbody[data-kp-trades-tab='board'] main [data-kp-section]:not([data-kp-section='board']),\r\nbody[data-kp-trades-tab='received'] main [data-kp-section]:not([data-kp-section='received']),\r\nbody[data-kp-trades-tab='sent'] main [data-kp-section]:not([data-kp-section='sent']) {\r\n  display: none !important;\r\n}\r\n\r\n.kp-trade-tabs {\r\n  margin: var(--s-3) 0;\r\n}\r\n\r\n.kp-trade-host > .compact,\r\n.kp-trade-host > .trays,\r\n.kp-trade-host > .verdict,\r\n.kp-trade-host > .more,\r\n.kp-trade-host > .sides {\r\n  display: none !important;\r\n}\r\n\r\n.kp-badge--new {\r\n  color: var(--ok);\r\n}\r\n\r\n[data-kp-section='board'] .kp-trade-host {\r\n  text-align: center;\r\n}\r\n\r\n[data-kp-section='board'] .kp-trade-host > .th {\r\n  justify-content: center;\r\n  gap: var(--s-2);\r\n}\r\n\r\nbody[data-kp-trades-tab] main [role='tabpanel'] ul.trades[data-kp-section='board'] {\r\n  display: grid;\r\n  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));\r\n  align-items: start;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-trade {\r\n  display: grid;\r\n  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r\n  align-items: start;\r\n  gap: var(--s-2);\r\n  margin: var(--s-2) 0;\r\n}\r\n\r\n.kp-trade > .kp-swap {\r\n  align-self: center;\r\n  color: var(--acc);\r\n  font-size: 14px;\r\n}\r\n\r\n.kp-trade__side {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  gap: var(--s-2);\r\n  min-width: 0;\r\n}\r\n\r\n.kp-trade__cards {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  justify-content: center;\r\n  gap: var(--s-2);\r\n}\r\n\r\n.kp-tcard {\r\n  display: flex;\r\n  flex-direction: column;\r\n  align-items: center;\r\n  gap: 2px;\r\n  width: 92px;\r\n  min-width: 0;\r\n}\r\n\r\n.kp-tcard .kp-name {\r\n  max-width: 100%;\r\n}\r\n\r\n.kp-trade__cards:has(> .kp-tcard:nth-child(2)) .kp-tcard {\r\n  width: 60px;\r\n}\r\n\r\n.kp-trade__total {\r\n  color: var(--mut);\r\n}\r\n\r\n.kp-trade__net {\r\n  grid-column: 1 / -1;\r\n  justify-self: center;\r\n  font-family: var(--mono);\r\n  font-size: var(--t-base);\r\n  font-weight: 700;\r\n}\r\n\r\n.kp-trade__net--up {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-trade__net--down {\r\n  color: var(--danger);\r\n}\r\n\r\n.kp-trade__net--flat {\r\n  color: var(--mut);\r\n}\r\n\r\n.kp-trade--wide {\r\n  display: grid;\r\n  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);\r\n  align-items: stretch;\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-trade--wide > .kp-swap {\r\n  align-self: center;\r\n  color: var(--acc);\r\n}\r\n\r\n.kp-trade__summary {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: var(--s-3);\r\n  margin-left: auto;\r\n  margin-right: var(--s-2);\r\n}\r\n\r\n.kp-pill {\r\n  padding: 2px 10px;\r\n  border: 1px solid currentColor;\r\n  border-radius: var(--r-pill);\r\n  font-family: var(--mono);\r\n  font-size: var(--t-sm);\r\n  font-weight: 700;\r\n}\r\n\r\n.kp-pill--up {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-pill--down {\r\n  color: var(--danger);\r\n}\r\n\r\n.kp-pill--flat {\r\n  color: var(--mut);\r\n}\r\n\r\n.kp-trade__box {\r\n  container-type: inline-size;\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: var(--s-2);\r\n  padding: var(--s-2) var(--s-3) var(--s-3);\r\n  border: 1px solid var(--line);\r\n  border-radius: var(--r-lg);\r\n  background: var(--panel2);\r\n}\r\n\r\n.kp-trade__box-head {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  align-items: center;\r\n  gap: var(--s-1) var(--s-3);\r\n}\r\n\r\n.kp-trade__box-total {\r\n  margin-left: auto;\r\n}\r\n\r\n.kp-trade__grid {\r\n  display: grid;\r\n  grid-template-columns: repeat(10, minmax(0, 1fr));\r\n  gap: 6px;\r\n}\r\n\r\n@container (max-width: 480px) {\r\n  .kp-trade__grid {\r\n    grid-template-columns: repeat(5, minmax(0, 1fr));\r\n  }\r\n}\r\n\r\n.kp-trade__grid .kp-tcard {\r\n  width: auto;\r\n}\r\n\r\n.kp-trade__box .kp-badge {\r\n  right: 2px;\r\n  bottom: 2px;\r\n  padding: 0 4px;\r\n  font-size: 9px;\r\n}\r\n\r\n.kp-trade__note {\r\n  font-size: var(--t-meta);\r\n  font-weight: 600;\r\n}\r\n\r\n.kp-trade__note--warn {\r\n  color: var(--warn);\r\n}\r\n\r\n.kp-trade__note--new {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-trade__note--muted {\r\n  color: var(--fg2);\r\n}\r\n\r\n.kp-trade-host .tact .talk {\r\n  display: none !important;\r\n}\r\n\r\n.kp-trade-host .tact:not(:has(> :not(.talk))) {\r\n  display: none !important;\r\n}\r\n\r\n.kp-talk {\r\n  display: inline-grid;\r\n  place-items: center;\r\n  width: 22px;\r\n  height: 22px;\r\n  margin-left: 6px;\r\n  padding: 0;\r\n  border: none;\r\n  border-radius: 50%;\r\n  background: transparent;\r\n  color: var(--mut);\r\n  font-size: 13px;\r\n  vertical-align: middle;\r\n  cursor: pointer;\r\n}\r\n\r\n.kp-talk:hover {\r\n  background: var(--raise);\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-count-host {\r\n  container-type: inline-size;\r\n}\r\n\r\n/* The tile image spans the tile width with a 5:7 ratio, so its bottom edge sits at 140% of that width. */\r\n.kp-count {\r\n  position: absolute;\r\n  top: calc(140cqw - 22px);\r\n  right: 5px;\r\n  padding: 0 6px;\r\n  border-radius: var(--r-pill);\r\n  background: #0a090ed9;\r\n  color: var(--fg2);\r\n  font: 700 11px var(--mono);\r\n  line-height: 18px;\r\n  pointer-events: none;\r\n}\r\n\r\n.kp-count--dupe {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-site-only {\r\n  display: none !important;\r\n}\r\n\r\n.kp-native-hidden {\r\n  display: none !important;\r\n}\r\n\r\nbody.kp-modal-open {\r\n  overflow: hidden;\r\n}\r\n\r\n.kp-modal {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: 1000;\r\n  display: grid;\r\n  place-items: center;\r\n  padding: var(--s-4);\r\n  background: color-mix(in srgb, var(--bg) 70%, transparent);\r\n  backdrop-filter: blur(4px);\r\n}\r\n\r\n.kp-pc {\r\n  display: flex;\r\n  flex-direction: column;\r\n  width: min(1200px, 100%);\r\n  height: min(900px, 100%);\r\n  overflow: hidden;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-lg);\r\n  background: var(--panel);\r\n  box-shadow: var(--sh-1);\r\n}\r\n\r\n.kp-pc__head {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: var(--s-3);\r\n  padding: var(--s-3) var(--s-4);\r\n  border-bottom: 1px solid var(--line);\r\n}\r\n\r\n.kp-pc__close {\r\n  margin-left: auto;\r\n}\r\n\r\n.kp-pc__filters {\r\n  display: flex;\r\n  flex-wrap: wrap;\r\n  align-items: center;\r\n  gap: var(--s-2) var(--s-3);\r\n  padding: var(--s-3) var(--s-4);\r\n  border-bottom: 1px solid var(--line);\r\n}\r\n\r\n.kp-pc__filters .kp-input {\r\n  flex: 0 1 200px;\r\n}\r\n\r\n.kp-pc__body {\r\n  flex: 1;\r\n  overflow-y: auto;\r\n  padding: var(--s-4);\r\n}\r\n\r\n.kp-pc__grid {\r\n  display: grid;\r\n  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));\r\n  gap: var(--s-3);\r\n}\r\n\r\n.kp-pc__grid .kp-empty {\r\n  grid-column: 1 / -1;\r\n}\r\n\r\n.kp-pc__sentinel {\r\n  height: 1px;\r\n}\r\n\r\n.kp-pcard {\r\n  display: flex;\r\n  flex-direction: column;\r\n  gap: 2px;\r\n  min-width: 0;\r\n}\r\n\r\n.kp-badge--dupe {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-badge--corner {\r\n  top: 4px;\r\n  right: auto;\r\n  bottom: auto;\r\n  left: 4px;\r\n}\r\n\r\n.kp-pc__total {\r\n  padding: 2px 10px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-pill);\r\n  color: var(--fg);\r\n  font: 700 var(--t-sm) var(--mono);\r\n}\r\n\r\n.kp-friend-search {\r\n  display: block;\r\n  width: 100%;\r\n  max-width: 880px;\r\n  margin-bottom: var(--s-3);\r\n}\r\n\r\nbody.kp-friends main ul.people {\r\n  display: flex;\r\n  flex-direction: column;\r\n}\r\n\r\nbody.kp-friends main ul.people > li.kp-pinned {\r\n  order: -1;\r\n  box-shadow: inset 3px 0 0 var(--gold);\r\n}\r\n\r\n.kp-pin,\r\n.kp-friend-act {\r\n  display: inline-flex !important;\r\n  flex: none;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 0 !important;\r\n  box-sizing: border-box;\r\n  width: 32px;\r\n  height: 32px;\r\n  min-width: 0 !important;\r\n  min-height: 0 !important;\r\n  margin: 0 !important;\r\n  padding: 0 !important;\r\n  line-height: 0 !important;\r\n  vertical-align: middle;\r\n  border: 1px solid var(--line2) !important;\r\n  border-radius: 50% !important;\r\n  background: var(--panel2) !important;\r\n  color: var(--mut) !important;\r\n  font-size: 0 !important;\r\n  text-decoration: none !important;\r\n  cursor: pointer;\r\n  transition: color 0.15s, background 0.15s;\r\n}\r\n\r\n.kp-pin i,\r\n.kp-friend-act i {\r\n  width: 1.25em;\r\n  font-size: 13px;\r\n  line-height: 1;\r\n  text-align: center;\r\n}\r\n\r\n.kp-pin:hover,\r\n.kp-friend-act:hover {\r\n  background: var(--raise) !important;\r\n  color: var(--fg) !important;\r\n}\r\n\r\n.kp-friend-act[data-kp-icon='Retirer']:hover,\r\n.kp-friend-act[data-kp-icon='Bloquer']:hover {\r\n  color: var(--danger) !important;\r\n}\r\n\r\n.kp-pin.is-pinned {\r\n  border-color: var(--gold) !important;\r\n  color: var(--gold) !important;\r\n}\r\n\r\n.kp-pin.is-pinned i {\r\n  transform: rotate(-45deg);\r\n}\r\n\r\n.kp-friend-act--confirm {\r\n  gap: 6px !important;\r\n  width: auto;\r\n  padding: 0 12px !important;\r\n  border-color: var(--danger) !important;\r\n  border-radius: var(--r-pill) !important;\r\n  color: var(--danger) !important;\r\n  font-size: var(--t-sm) !important;\r\n  line-height: 1 !important;\r\n}\r\n\r\n.kp-series-collapsed > ul.quests {\r\n  display: none !important;\r\n}\r\n\r\n.kp-series-toggle {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  gap: var(--s-2);\r\n  margin-left: auto;\r\n  padding: 4px 12px;\r\n  border: 1px solid var(--line2);\r\n  border-radius: var(--r-pill);\r\n  background: var(--panel2);\r\n  color: var(--fg2);\r\n  font: 600 var(--t-sm) var(--body);\r\n  cursor: pointer;\r\n}\r\n\r\n.kp-series-toggle:hover {\r\n  background: var(--raise);\r\n  color: var(--fg);\r\n}\r\n\r\n.kp-series-summary.has-claim {\r\n  color: var(--ok);\r\n}\r\n\r\n.kp-series-chevron {\r\n  display: inline-flex;\r\n  font-size: 11px;\r\n  transition: transform 0.15s;\r\n}\r\n\r\n.kp-series-toggle[aria-expanded='true'] .kp-series-chevron {\r\n  transform: rotate(180deg);\r\n}\r\n\r\nhtml:has(body.kp-video-bg),\r\nbody.kp-video-bg,\r\nbody.kp-video-bg main section.band,\r\nbody.kp-video-bg main .box.coll {\r\n  background: transparent !important;\r\n}\r\n\r\n.kp-bg-video {\r\n  position: fixed;\r\n  inset: 0;\r\n  z-index: -1;\r\n  width: 100vw;\r\n  height: 100vh;\r\n  object-fit: cover;\r\n  filter: brightness(0.45);\r\n  pointer-events: none;\r\n}\r\n";

  // src/main.js
  var features = [market_counter_default, market_offers_default, market_trades_default, collection_ghosts_default, collection_albums_default, collection_locks_default, trade_dialog_default, profile_collection_default, friends_list_default, missions_series_default, profile_background_default];
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
