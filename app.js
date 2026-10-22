(() => {
  "use strict";

  const API = "/api";
  const TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
  const TILE_ATTR = "&copy; OpenStreetMap contributors";
  const LEVEL_COLOR = { fresh: "#2f7d4f", soon: "#f2a93b", urgent: "#d9482b" };
  const STATUS_LABEL = {
    available: "Available",
    claimed: "Claimed, waiting for pickup",
    completed: "Picked up",
    expired: "Expired, nobody collected it",
    cancelled: "Cancelled",
  };
  const DONE_MESSAGE = {
    claim: "Claimed. The donor's contact details are now on the listing.",
    release: "Released. The food is available to others again.",
    complete: "Marked as picked up. Thank you!",
    cancel: "Listing cancelled.",
    delete: "Listing deleted.",
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const state = {
    token: localStorage.getItem("sl_token"),
    user: null,
    view: "home",
    listings: [],
    center: null,
    filters: { q: "", type: "" },
    cache: {},
  };
  let map, markerLayer, pickMap, pickMarker, pickLatLng = null;
  let authMode = "login";
  let editingId = null;
  let fitted = false;

  /* ------------------------------------------------------------ helpers */
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && state.token) logout(true);
      throw new Error(data.error || "Something went wrong. Try again.");
    }
    return data;
  }

  let toastTimer;
  function toast(message, bad = false) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.toggle("bad", bad);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
  }

  function msLeft(l) { return Date.parse(l.pickup_by) - Date.now(); }
  function level(ms) { return ms < 3600000 ? "urgent" : ms < 10800000 ? "soon" : "fresh"; }
  function fmtLeft(ms) {
    if (ms <= 0) return "Pickup window closed";
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${Math.max(m, 1)} min left to collect`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min left to collect` : `${h} h left to collect`;
  }
  function pct(l) {
    const total = Math.max(Date.parse(l.pickup_by) - Date.parse(l.created_at), 1);
    return Math.max(0, Math.min(100, (msLeft(l) / total) * 100));
  }
  function remember(list) { list.forEach((l) => { state.cache[l.id] = l; }); }
  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ----------------------------------------------------------- rendering */
  function actionsFor(l) {
    const u = state.user, a = [];
    if (!u) {
      if (l.status === "available") a.push(["login", "Log in to claim", "primary"]);
      return a;
    }
    const owner = l.donor_id === u.id || u.role === "admin";
    if (l.status === "available" && u.role === "receiver") a.push(["claim", "Claim this food", "primary"]);
    if (l.status === "claimed" && l.claimed_by === u.id) {
      a.push(["complete", "Mark as picked up", "primary"]);
      a.push(["release", "Release", "ghost"]);
    }
    if (l.status === "claimed" && l.donor_id === u.id) a.push(["complete", "Confirm handover", "primary"]);
    if (l.status === "available" && l.donor_id === u.id) a.push(["edit", "Edit", "ghost"]);
    if (owner && ["available", "claimed"].includes(l.status)) a.push(["cancel", "Cancel listing", "danger"]);
    if (owner && ["completed", "expired", "cancelled"].includes(l.status)) a.push(["delete", "Delete", "danger"]);
    return a;
  }

  function contactHTML(l) {
    const u = state.user;
    if (!u || !["claimed", "completed"].includes(l.status)) return "";
    if (l.claimed_by === u.id) {
      return `<p class="l-contact">Contact the donor: <strong>${esc(l.donor_name)}</strong>${l.donor_phone ? `, ${esc(l.donor_phone)}` : ""}</p>`;
    }
    if (l.donor_id === u.id || u.role === "admin") {
      return `<p class="l-contact">Collected by <strong>${esc(l.claimer_name || "a receiver")}</strong>${l.claimer_phone ? `, ${esc(l.claimer_phone)}` : ""}</p>`;
    }
    return "";
  }

  function rowHTML(l) {
    const live = ["available", "claimed"].includes(l.status);
    const ms = msLeft(l);
    const lv = live ? level(ms) : "closed";
    const dist = l.distance_km != null ? `<span>${l.distance_km} km away</span>` : "";
    const statusLine = live
      ? `<div class="fresh" aria-hidden="true"><div class="fresh-bar" style="width:${pct(l)}%"></div></div>
         <p class="fresh-text">${esc(fmtLeft(ms))}${l.status === "claimed" ? " (claimed)" : ""}</p>`
      : `<p class="status-text">${esc(STATUS_LABEL[l.status])}</p>`;
    const actions = actionsFor(l)
      .map(([act, label, cls]) => `<button type="button" class="${cls}" data-action="${act}" data-id="${l.id}">${esc(label)}</button>`)
      .join("");
    return `<article class="listing ${lv}" data-id="${l.id}">
      <div class="l-head"><h3>${esc(l.title)}</h3><span class="chip">${esc(l.food_type)}</span></div>
      <p class="l-meta"><strong>${l.quantity} servings</strong><span>${esc(l.donor_org || l.donor_name)}</span>${dist}</p>
      <p class="l-addr">${esc(l.address)}</p>
      ${l.description ? `<p class="l-desc">${esc(l.description)}</p>` : ""}
      ${statusLine}
      ${contactHTML(l)}
      ${actions ? `<div class="l-actions">${actions}</div>` : ""}
    </article>`;
  }

  const EMPTY_BOARD = `<div class="empty"><strong>No food listed right now</strong>Donors can post surplus in under a minute. New listings appear here as soon as they are posted.</div>`;

  function renderBoard() {
    const q = state.filters.q.trim().toLowerCase();
    const t = state.filters.type;
    const items = state.listings.filter((l) =>
      (!t || l.food_type === t) &&
      (!q || `${l.title} ${l.description} ${l.address} ${l.donor_name} ${l.donor_org || ""}`.toLowerCase().includes(q)));
    $("#listings").innerHTML = items.length ? items.map(rowHTML).join("") : EMPTY_BOARD;

    markerLayer.clearLayers();
    items.forEach((l) => {
      const color = LEVEL_COLOR[level(msLeft(l))];
      L.circleMarker([l.lat, l.lng], { radius: 11, color: "#12302a", weight: 2, fillColor: color, fillOpacity: 0.95 })
        .bindPopup(`<strong>${esc(l.title)}</strong><br>${l.quantity} servings`)
        .on("click", () => focusRow(l.id))
        .addTo(markerLayer);
    });
    if (!fitted && items.length) {
      map.fitBounds(items.map((l) => [l.lat, l.lng]), { padding: [40, 40], maxZoom: 15 });
      fitted = true;
    }
  }

  function focusRow(id) {
    $$("#listings .listing").forEach((r) => r.classList.toggle("focus", r.dataset.id === String(id)));
    const row = $(`#listings .listing[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function renderStats(s) {
    const html =
      `<span><b>${s.meals_shared}</b>meals shared</span>` +
      `<span><b>${s.listed_now}</b>listed now</span>` +
      `<span><b>${s.donors}</b>donors</span>` +
      `<span><b>${s.receivers}</b>receivers</span>`;
    $("#stats").innerHTML = html;
    $("#home-stats").innerHTML = html;
  }

  function renderSession() {
    const u = state.user;
    $("#btn-login").hidden = !!u;
    $("#btn-logout").hidden = !u;
    $("#user-chip").hidden = !u;
    $("#btn-post").hidden = !(u && u.role === "donor");
    if (u) $("#user-chip").textContent = `${u.name} (${u.role})`;
    const act = $('[data-view="activity"]');
    act.hidden = !(u && u.role !== "admin");
    if (u) act.textContent = u.role === "donor" ? "My listings" : "My claims";
    $('[data-view="admin"]').hidden = !(u && u.role === "admin");
  }

  /* ---------------------------------------------------------------- data */
  async function loadBoard() {
    const qs = state.center ? `?lat=${state.center[0]}&lng=${state.center[1]}` : "";
    const data = await api(`/listings${qs}`);
    state.listings = data.listings;
    remember(data.listings);
    renderBoard();
  }
  async function loadStats() { renderStats(await api("/stats")); }

  async function loadActivity() {
    const { listings } = await api("/my");
    remember(listings);
    const empty = state.user.role === "donor"
      ? `<div class="empty"><strong>You haven't posted anything yet</strong>Use "Post surplus food" at the top to list your first donation.</div>`
      : `<div class="empty"><strong>You haven't claimed anything yet</strong>Open the live board and claim food that is ready near you.</div>`;
    $("#activity-title").textContent = state.user.role === "donor" ? "My listings" : "My claims";
    $("#activity-list").innerHTML = listings.length ? listings.map(rowHTML).join("") : empty;
  }

  async function loadAdmin() {
    const [{ users }, { listings }] = await Promise.all([api("/admin/users"), api("/listings?status=all")]);
    remember(listings);
    $("#admin-users tbody").innerHTML = users.map((u) =>
      `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.org || "")}</td><td>${esc((u.created_at || "").slice(0, 10))}</td></tr>`).join("");
    $("#admin-listings").innerHTML = listings.length ? listings.map(rowHTML).join("") : `<div class="empty">No listings yet.</div>`;
  }

  async function refreshAll() {
    const jobs = [loadBoard(), loadStats()];
    if (state.view === "activity" && state.user) jobs.push(loadActivity());
    if (state.view === "admin" && state.user) jobs.push(loadAdmin());
    await Promise.allSettled(jobs);
  }

  /* --------------------------------------------------------------- views */
  function setView(view) {
    state.view = view;
    ["home", "board", "activity", "admin"].forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
    $$("#nav button").forEach((b) => b.toggleAttribute("aria-current", b.dataset.view === view));
    $$("#nav button").forEach((b) => { if (b.dataset.view === view) b.setAttribute("aria-current", "page"); });
    if (view === "board") setTimeout(() => { map.invalidateSize(); fitted = false; renderBoard(); }, 0);
    if (view === "activity") loadActivity().catch((e) => toast(e.message, true));
    if (view === "admin") loadAdmin().catch((e) => toast(e.message, true));
  }

  /* ---------------------------------------------------------------- auth */
  function openAuth(mode) {
    setAuthMode(mode);
    $("#auth-error").textContent = "";
    $("#dlg-auth").showModal();
  }
  function setAuthMode(mode) {
    authMode = mode;
    document.body.classList.toggle("login-mode", mode === "login");
    $$(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const text = mode === "login" ? "Log in" : "Create account";
    $("#auth-title").textContent = text;
    $("#auth-submit").textContent = text;
    $('#auth-form [name="password"]').autocomplete = mode === "login" ? "current-password" : "new-password";
  }
  function logout(expired = false) {
    state.token = null;
    state.user = null;
    localStorage.removeItem("sl_token");
    renderSession();
    setView("home");
    refreshAll();
    if (expired) toast("Your session ended. Log in again.", true);
  }

  /* ------------------------------------------------------- map & places */
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("This browser can't share your location."));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve([p.coords.latitude, p.coords.longitude]),
        () => reject(new Error("Location was blocked. You can still tap the map to set a spot.")),
        { enableHighAccuracy: true, timeout: 10000 });
    });
  }

  function setPick(latlng) {
    pickLatLng = { lat: latlng.lat, lng: latlng.lng };
    if (pickMarker) pickMarker.setLatLng(latlng);
    else pickMarker = L.circleMarker(latlng, { radius: 10, color: "#12302a", weight: 2, fillColor: "#f2a93b", fillOpacity: 1 }).addTo(pickMap);
    $("#pick-hint").textContent = `Pickup spot set (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`;
  }

  function openPost(listing = null) {
    editingId = listing ? listing.id : null;
    const form = $("#post-form");
    form.reset();
    $("#post-error").textContent = "";
    $("#post-title").textContent = listing ? "Edit listing" : "Post surplus food";
    $("#post-submit").textContent = listing ? "Save changes" : "Post listing";
    const soon = new Date(Date.now() + 3 * 3600000);
    form.pickup_by.min = toLocalInput(new Date());
    form.pickup_by.value = toLocalInput(soon);
    pickLatLng = null;
    $("#pick-hint").textContent = "Tap the map to mark the pickup spot.";
    if (listing) {
      ["title", "food_type", "quantity", "description", "address"].forEach((k) => { form[k].value = listing[k] ?? ""; });
      form.pickup_by.value = toLocalInput(new Date(listing.pickup_by));
    }
    $("#dlg-post").showModal();
    setTimeout(() => {
      if (!pickMap) {
        pickMap = L.map("pick-map").setView([20, 0], 2);
        L.tileLayer(TILES, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(pickMap);
        pickMap.on("click", (e) => setPick(e.latlng));
      }
      pickMap.invalidateSize();
      if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
      if (listing) {
        pickMap.setView([listing.lat, listing.lng], 15);
        setPick({ lat: listing.lat, lng: listing.lng });
      } else if (state.center) {
        pickMap.setView(state.center, 15);
      } else {
        pickMap.setView(map.getCenter(), Math.max(map.getZoom(), 4));
      }
    }, 60);
  }

  /* ---------------------------------------------------------- listeners */
  function bind() {
    $("#nav").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-view]");
      if (b) setView(b.dataset.view);
    });
    $("#btn-login").addEventListener("click", () => openAuth("login"));
    $$("[data-go]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.go === "join") openAuth("register"); else setView("board");
    }));
    $("#btn-logout").addEventListener("click", () => logout());
    $("#btn-post").addEventListener("click", () => openPost());
    $$(".seg button").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
    $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

    $("#f-q").addEventListener("input", (e) => { state.filters.q = e.target.value; renderBoard(); });
    $("#f-type").addEventListener("change", (e) => { state.filters.type = e.target.value; renderBoard(); });
    $("#btn-near").addEventListener("click", async () => {
      try {
        state.center = await locate();
        map.setView(state.center, 14);
        await loadBoard();
        toast("Sorted by distance from you.");
      } catch (err) { toast(err.message, true); }
    });
    $("#btn-here").addEventListener("click", async () => {
      try {
        const [lat, lng] = await locate();
        pickMap.setView([lat, lng], 16);
        setPick({ lat, lng });
      } catch (err) { $("#post-error").textContent = err.message; }
    });

    $("#listings").addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const row = e.target.closest(".listing");
      const l = row && state.cache[row.dataset.id];
      if (!l) return;
      focusRow(l.id);
      map.flyTo([l.lat, l.lng], Math.max(map.getZoom(), 15));
    });

    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { email: f.get("email"), password: f.get("password") };
      if (authMode === "register") Object.assign(body, { name: f.get("name"), org: f.get("org"), phone: f.get("phone"), role: f.get("role") });
      $("#auth-error").textContent = "";
      try {
        const data = await api(authMode === "login" ? "/login" : "/register", { method: "POST", body });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem("sl_token", data.token);
        $("#dlg-auth").close();
        e.target.reset();
        renderSession();
        setView(data.user.role === "admin" ? "admin" : "board");
        await refreshAll();
        toast(`Welcome, ${data.user.name}.`);
      } catch (err) { $("#auth-error").textContent = err.message; }
    });

    $("#post-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const err = $("#post-error");
      err.textContent = "";
      if (!pickLatLng) { err.textContent = "Tap the map to mark the pickup spot."; return; }
      const when = new Date(f.get("pickup_by"));
      if (isNaN(when)) { err.textContent = "Set a pickup deadline."; return; }
      const body = {
        title: f.get("title"), food_type: f.get("food_type"), quantity: f.get("quantity"),
        description: f.get("description"), address: f.get("address"),
        lat: pickLatLng.lat, lng: pickLatLng.lng, pickup_by: when.toISOString(),
      };
      try {
        await api(editingId ? `/listings/${editingId}` : "/listings", { method: editingId ? "PUT" : "POST", body });
        $("#dlg-post").close();
        toast(editingId ? "Listing updated." : "Posted. Receivers nearby can see it now.");
        fitted = false;
        await refreshAll();
      } catch (ex) { err.textContent = ex.message; }
    });

    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      const { action, id } = b.dataset;
      if (action === "login") return openAuth("login");
      if (action === "edit") return openPost(state.cache[id]);
      if (action === "cancel" && !confirm("Cancel this listing? If someone claimed it, they will lose the claim.")) return;
      if (action === "delete" && !confirm("Delete this listing permanently?")) return;
      b.disabled = true;
      try {
        if (action === "delete") await api(`/listings/${id}`, { method: "DELETE" });
        else await api(`/listings/${id}/${action}`, { method: "POST" });
        toast(DONE_MESSAGE[action]);
        await refreshAll();
      } catch (ex) {
        toast(ex.message, true);
        b.disabled = false;
        refreshAll();
      }
    });
  }

  /* ---------------------------------------------------------------- init */
  async function init() {
    map = L.map("map", { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer(TILES, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    setAuthMode("login");
    bind();

    if (state.token) {
      try { state.user = (await api("/me")).user; } catch { /* token invalid; api() already cleared it */ }
    }
    renderSession();
    await refreshAll();

    // keep countdowns and new listings fresh
    setInterval(() => { if (!document.hidden) refreshAll(); }, 30000);
  }

  init();
})();
