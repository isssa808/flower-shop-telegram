import { getTelegram, apiFetch, initFullscreen } from "/shared/telegram.js";
import { t, getLang, setLang, detectLang, applyDomI18n } from "/shared/i18n.js";
import { buildProductSheetHtml, priceOf, badgeLabel } from "/shared/product-view.js";

const tg = getTelegram();
initFullscreen(tg);

const LOCATION_ID = 1;

const state = {
  categories: [],
  products: [],
  allProducts: null, // кэш полного каталога (для избранного)
  addons: [],        // доп-товары «Добавьте к заказу»
  shop: {},          // публичные данные магазина (контакты, доставка, тексты)
  activeCategory: null,
  search: "",
  view: "catalog", // catalog | favorites
  favorites: new Set(),
  theme: "system", // light | dark | system
  lang: "ru",      // ru | en
  haptics: true,   // минимальная вибрация, тумблер в профиле
  filter: { sort: "default", badge: "", availability: "", priceMin: null, priceMax: null },
  cart: [], // { productId, name, photo, variantId, variantLabel, price, quantity }
  currentProduct: null,
  selectedVariantId: null,
  selectedQty: 1,
  descExpanded: false,
  fulfillment: "delivery", // delivery | pickup
  zone: "batumi",          // batumi | outside
  paymentMethod: "cash",
};

const el = (id) => document.getElementById(id);
const money = (n) => `${Number(n).toFixed(0)} ₾`;

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}

// Снять фокус с активного поля — чтобы Telegram скрыл клавиатуру при
// закрытии/переходе между шторками (частый баг «клавиатура не убирается»).
function blurActive() {
  try { document.activeElement?.blur?.(); } catch (_) {}
}

// Минимальная тактильная отдача; отключается тумблером в профиле (state.haptics).
function haptic(kind) {
  if (state.haptics === false) return;
  try {
    if (kind === "success") tg.HapticFeedback?.notificationOccurred?.("success");
    else if (kind === "select") tg.HapticFeedback?.selectionChanged?.();
    else tg.HapticFeedback?.impactOccurred?.("light");
  } catch (_) {}
}

// --- Навигация по шторкам + системная кнопка «Назад» Telegram ---------
const sheetHistory = [];
const curSheet = () => sheetHistory[sheetHistory.length - 1];

function showSheetEl(name) {
  el(`${name}-backdrop`).classList.add("open");
  el(`${name}-sheet`).classList.add("open");
}
function hideSheetEl(name) {
  el(`${name}-backdrop`).classList.remove("open");
  el(`${name}-sheet`).classList.remove("open");
}
function syncBackButton() {
  if (sheetHistory.length) tg.BackButton?.show?.();
  else tg.BackButton?.hide?.();
}
function navPush(name) {
  blurActive();
  const cur = curSheet();
  if (cur && cur !== name) hideSheetEl(cur);
  sheetHistory.push(name);
  showSheetEl(name);
  syncBackButton();
}
function navBack() {
  blurActive();
  const cur = sheetHistory.pop();
  if (cur) hideSheetEl(cur);
  const prev = curSheet();
  if (prev) showSheetEl(prev);
  syncBackButton();
}
function navReset() {
  blurActive();
  while (sheetHistory.length) hideSheetEl(sheetHistory.pop());
  syncBackButton();
}
tg.BackButton?.onClick?.(navBack);
tg.BackButton?.hide?.();
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", navBack)
);

// Тап по пустой области шторки/по «ручке» снимает фокус (скрывает клавиатуру).
document.querySelectorAll(".sheet").forEach((sheet) => {
  sheet.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("input, textarea, select, button, a, label")) blurActive();
  });
});

// ---------------------------------------------------------------------
// Язык
// ---------------------------------------------------------------------
function applyI18n() {
  applyDomI18n(document);
  // перерисовать открытые/фоновые экраны, чтобы динамические строки обновились
  renderTabs();
  if (state.view === "favorites") showFavorites(); else renderProductGrid(state.products);
  updateCartBar();
  const top = curSheet();
  if (top === "product" && state.currentProduct) renderProductSheet();
  if (top === "cart") renderCart();
  if (top === "profile") renderProfile();
}

function setLanguage(lang) {
  state.lang = setLang(lang);
  try { tg.CloudStorage?.setItem?.("lang", state.lang); } catch (_) {}
  applyI18n();
}

function loadLang() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    const fallback = detectLang(tg);
    if (!cs || !cs.getItem) { state.lang = setLang(fallback); return resolve(); }
    try {
      cs.getItem("lang", (err, val) => {
        state.lang = setLang(!err && val ? val : fallback);
        resolve();
      });
    } catch (_) { state.lang = setLang(fallback); resolve(); }
  });
}

// ---------------------------------------------------------------------
// Каталог
// ---------------------------------------------------------------------
async function loadShop() {
  try { state.shop = await apiFetch("/api/shop", { tg }); } catch (_) { state.shop = {}; }
}
async function loadCategories() {
  state.categories = await apiFetch(`/api/categories?location_id=${LOCATION_ID}`, { tg });
  renderTabs();
}
async function loadProducts() {
  const params = new URLSearchParams({ location_id: LOCATION_ID });
  if (state.activeCategory) params.set("category", state.activeCategory);
  if (state.search) params.set("search", state.search);
  state.products = await apiFetch(`/api/products?${params}`, { tg });
  renderProductGrid();
}
async function loadAddons() {
  try { state.addons = await apiFetch(`/api/products?location_id=${LOCATION_ID}&addon=1`, { tg }); }
  catch (_) { state.addons = []; }
}

function renderTabs() {
  const tabs = el("tabs");
  const all = [{ slug: null, name: t("popular") }, ...state.categories];
  tabs.innerHTML = "";
  all.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (state.activeCategory === c.slug ? " active" : "");
    btn.textContent = i === 0 ? t("popular") : c.name;
    btn.addEventListener("click", () => {
      state.activeCategory = c.slug;
      renderTabs();
      loadProducts();
      scrollTop();
    });
    tabs.appendChild(btn);
  });
}

function findProduct(id) {
  return (
    state.products.find((x) => x.id === id) ||
    (state.allProducts || []).find((x) => x.id === id) ||
    state.addons.find((x) => x.id === id) ||
    null
  );
}

function productCardHtml(p) {
  const minPrice = priceOf(p);
  const priceLabel = minPrice
    ? `<span class="pc-price"><small>${t("from_price")}</small> ${money(minPrice)}</span>`
    : `<span class="pc-price">${t("on_request")}</span>`;
  const fav = state.favorites.has(p.id) ? " on" : "";
  const blabel = badgeLabel(t, p.badge);
  const unavailable = p.available === false;
  const tag = unavailable
    ? `<span class="pc-tag oos">${t("out_of_stock_short")}</span>`
    : (blabel
        ? `<span class="pc-tag ${p.badge}">${blabel}</span>`
        : (p.status === "made_to_order" ? `<span class="pc-tag made">${t("made_to_order")}</span>` : ""));
  const likes = p.likes > 0
    ? `<div class="pc-likes"><svg viewBox="0 0 24 24" stroke="none"><path d="M12 21C12 21 4 14.5 4 8.8C4 5.9 6.2 4 8.6 4C10.2 4 11.4 4.9 12 6C12.6 4.9 13.8 4 15.4 4C17.8 4 20 5.9 20 8.8C20 14.5 12 21 12 21Z"/></svg>${p.likes}${p.order_count > 0 ? `<span class="pc-orders">· ${t("ordered_times", { n: p.order_count })}</span>` : ""}</div>`
    : (p.order_count > 0 ? `<div class="pc-likes"><span class="pc-orders">${t("ordered_times", { n: p.order_count })}</span></div>` : "");
  const plus = unavailable
    ? `<button class="pc-plus" disabled aria-label="add">+</button>`
    : `<button class="pc-plus" data-add="${p.id}" type="button" aria-label="add">+</button>`;
  return `
    <div class="product-card${unavailable ? " pc-unavailable" : ""}" data-product="${p.id}">
      <div class="photo">
        ${tag}
        <button class="pc-heart${fav}" data-fav="${p.id}" type="button" aria-label="favorite">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21C12 21 4 14.5 4 8.8C4 5.9 6.2 4 8.6 4C10.2 4 11.4 4.9 12 6C12.6 4.9 13.8 4 15.4 4C17.8 4 20 5.9 20 8.8C20 14.5 12 21 12 21Z"/></svg>
        </button>
        <img src="${p.photo_url}" alt="${p.name}" loading="lazy" />
      </div>
      <div class="info">
        <div class="pc-name">${p.name}</div>
        ${likes}
        ${unavailable ? `<div class="pc-oos-note">${t("out_of_stock")}</div>` : ""}
        <div class="pc-row">${priceLabel}${plus}</div>
      </div>
    </div>`;
}

// Активен ли хоть один фильтр/сортировка (для подсветки кнопки «Фильтры»).
function filterActive() {
  const f = state.filter;
  return f.sort !== "default" || !!f.badge || !!f.availability || f.priceMin != null || f.priceMax != null;
}

// Применить фильтры и сортировку из state.filter к списку товаров.
function applyFilterSort(list) {
  const f = state.filter;
  let out = list.filter((p) => {
    if (f.badge && p.badge !== f.badge) return false;
    if (f.availability === "in_stock" && p.status !== "in_stock") return false;
    if (f.availability === "made_to_order" && p.status !== "made_to_order") return false;
    const price = priceOf(p);
    if (f.priceMin != null && (price == null || price < f.priceMin)) return false;
    if (f.priceMax != null && (price == null || price > f.priceMax)) return false;
    return true;
  });
  if (f.sort === "popular") out = [...out].sort((a, b) => (b.order_count - a.order_count) || (b.likes - a.likes));
  else if (f.sort === "price_asc") out = [...out].sort((a, b) => (priceOf(a) ?? 1e9) - (priceOf(b) ?? 1e9));
  else if (f.sort === "price_desc") out = [...out].sort((a, b) => (priceOf(b) ?? -1) - (priceOf(a) ?? -1));
  return out;
}

function renderProductGrid(list = state.products) {
  const grid = el("product-grid");
  let items = state.view === "catalog" ? applyFilterSort(list) : list;
  el("filter-btn")?.classList.toggle("filter-active", state.view === "catalog" && filterActive());
  if (!items.length) {
    const msg = state.view === "favorites" ? t("fav_empty") : t("nothing_found");
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🌾</div>${msg}</div>`;
    return;
  }
  grid.innerHTML = items.map(productCardHtml).join("");
  grid.querySelectorAll("[data-product]").forEach((card) =>
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-fav]") || e.target.closest("[data-add]")) return;
      const p = findProduct(Number(card.dataset.product));
      if (p) openProduct(p);
    })
  );
  grid.querySelectorAll("[data-fav]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(Number(b.dataset.fav), b);
    })
  );
  grid.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      quickAdd(findProduct(Number(b.dataset.add)));
    })
  );
}

function quickAdd(p) {
  if (!p) return;
  const variant = p.variants.find((v) => v.price > 0) || p.variants[0];
  if (!variant) return;
  const existing = state.cart.find((l) => l.variantId === variant.id);
  if (existing) existing.quantity += 1;
  else
    state.cart.push({
      productId: p.id, name: p.name, photo: p.photo_url,
      variantId: variant.id, variantLabel: variant.label, price: variant.price, quantity: 1,
    });
  haptic();
  updateCartBar();
  showToast(t("added_to_cart"));
}

// Применить функцию ко всем копиям товара во всех загруженных списках.
function eachProduct(id, fn) {
  for (const arr of [state.products, state.allProducts || [], state.addons]) {
    for (const p of arr) if (p.id === id) fn(p);
  }
  if (state.currentProduct && state.currentProduct.id === id) fn(state.currentProduct);
}
function bumpLikes(id, delta) { eachProduct(id, (p) => { p.likes = Math.max(0, (p.likes || 0) + delta); }); }
function setLikes(id, likes) { eachProduct(id, (p) => { p.likes = likes; }); }
function refreshLikeViews() {
  if (state.view === "favorites") showFavorites();
  else renderProductGrid();
  if (curSheet() === "product" && state.currentProduct) renderProductSheet();
}

// Лайк/избранное на сервере. Оптимистично обновляем UI, при ошибке откатываем.
async function toggleFavorite(id, btnEl) {
  const nowFav = !state.favorites.has(id);
  if (nowFav) state.favorites.add(id); else state.favorites.delete(id);
  if (btnEl) {
    btnEl.classList.toggle("on", nowFav);
    btnEl.classList.remove("pop"); void btnEl.offsetWidth; btnEl.classList.add("pop");
  }
  haptic();
  bumpLikes(id, nowFav ? 1 : -1);
  try {
    const res = await apiFetch(`/api/favorites/${id}`, { method: "POST", tg });
    if (res && typeof res.likes === "number") setLikes(id, res.likes);
  } catch (_) {
    if (nowFav) state.favorites.delete(id); else state.favorites.add(id);
    bumpLikes(id, nowFav ? -1 : 1);
  }
  refreshLikeViews();
}

let searchTimer;
function syncSearchClear() { const b = el("search-clear"); if (b) b.hidden = !el("search-input").value; }
el("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  state.search = e.target.value.trim();
  syncSearchClear();
  searchTimer = setTimeout(loadProducts, 300);
});
el("search-clear")?.addEventListener("click", () => {
  const inp = el("search-input");
  inp.value = ""; state.search = ""; syncSearchClear();
  loadProducts(); inp.focus();
});

// ---------------------------------------------------------------------
// Допродажа «Добавьте к заказу» / «Дополнения к букету»
// ---------------------------------------------------------------------
function addonCardHtml(p) {
  const price = priceOf(p);
  return `
    <div class="addon" data-addon="${p.id}">
      <div class="aimg"><img src="${p.photo_url}" alt="${p.name}" /></div>
      <div class="an">${p.name}</div>
      <div class="ap">${price ? money(price) : t("on_request")}<span class="aplus">+</span></div>
    </div>`;
}

function renderAddonsInto(container, title, onAfterAdd) {
  const list = state.addons.filter((a) => !state.cart.some((l) => l.productId === a.id));
  if (!list.length) { container.innerHTML = ""; return; }
  container.innerHTML = `
    <div class="addons">
      <div class="pd-label">${title}</div>
      <div class="addon-row">${list.map(addonCardHtml).join("")}</div>
    </div>`;
  container.querySelectorAll("[data-addon]").forEach((c) =>
    c.addEventListener("click", () => {
      quickAdd(findProduct(Number(c.dataset.addon)));
      onAfterAdd && onAfterAdd();
    })
  );
}

// ---------------------------------------------------------------------
// Карточка товара
// ---------------------------------------------------------------------
function openProduct(p) {
  state.currentProduct = p;
  state.selectedVariantId = p.variants[0]?.id ?? null;
  state.selectedQty = 1;
  state.descExpanded = false;
  renderProductSheet();
  navPush("product");
}

function renderProductSheet() {
  const p = state.currentProduct;
  el("product-sheet-content").innerHTML = buildProductSheetHtml(p, {
    t, money, shop: state.shop || {}, mode: "full",
    liked: state.favorites.has(p.id),
    descExpanded: state.descExpanded,
    selectedVariantId: state.selectedVariantId,
    selectedQty: state.selectedQty,
  });

  document.querySelectorAll("#variant-row .variant-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedVariantId = Number(btn.dataset.variant);
      renderProductSheet();
    });
  });
  el("qty-minus")?.addEventListener("click", () => {
    state.selectedQty = Math.max(1, state.selectedQty - 1);
    el("qty-value").textContent = state.selectedQty;
  });
  el("qty-plus")?.addEventListener("click", () => {
    state.selectedQty += 1;
    el("qty-value").textContent = state.selectedQty;
  });
  el("add-to-cart-btn")?.addEventListener("click", addSelectedToCart);

  const dtoggle = el("desc-toggle");
  if (dtoggle) dtoggle.addEventListener("click", () => { state.descExpanded = !state.descExpanded; renderProductSheet(); });

  document.querySelectorAll("#product-sheet-content .pd-acc-head").forEach((h) =>
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"))
  );

  const likeBtn = document.querySelector("#product-sheet-content .pd-like[data-like]");
  if (likeBtn) likeBtn.addEventListener("click", () => toggleFavorite(p.id, likeBtn));

  const addonBox = el("product-addons");
  if (addonBox && state.currentProduct && !state.currentProduct.is_addon) {
    renderAddonsInto(addonBox, t("addons_title"), () => renderProductSheet());
  }
}

function addSelectedToCart() {
  const p = state.currentProduct;
  const variant = p.variants.find((v) => v.id === state.selectedVariantId);
  if (!variant) return;
  const existing = state.cart.find((l) => l.variantId === variant.id);
  if (existing) existing.quantity += state.selectedQty;
  else
    state.cart.push({
      productId: p.id, name: p.name, photo: p.photo_url,
      variantId: variant.id, variantLabel: variant.label, price: variant.price, quantity: state.selectedQty,
    });
  haptic();
  updateCartBar();
  navBack();
  showToast(t("added_to_cart"));
}

// ---------------------------------------------------------------------
// Корзина
// ---------------------------------------------------------------------
function cartTotal() {
  return state.cart.reduce((sum, l) => sum + l.price * l.quantity, 0);
}
function cartCount() {
  return state.cart.reduce((sum, l) => sum + l.quantity, 0);
}

let lastCartCount = 0;
function bumpEl(elm) { if (!elm) return; elm.classList.remove("bump"); void elm.offsetWidth; elm.classList.add("bump"); }
function setBadge(elm, count) {
  if (!elm) return;
  if (count > 0) { elm.hidden = false; elm.textContent = count; } else elm.hidden = true;
}
function updateCartBar() {
  const bar = el("cart-bar");
  const count = cartCount();
  setBadge(el("cart-nav-badge"), count);
  setBadge(el("header-cart-badge"), count);
  if (count > lastCartCount) { bumpEl(el("cart-nav-badge")); bumpEl(el("header-cart-badge")); }
  lastCartCount = count;
  saveCart();
  if (count === 0) { bar.classList.remove("visible"); return; }
  el("cart-summary").textContent = t("cart_count", { n: count, sum: money(cartTotal()) });
  bar.classList.add("visible");
}

// Постоянная корзина: сохраняем в CloudStorage, восстанавливаем при запуске.
function saveCart() {
  try { tg.CloudStorage?.setItem?.("cart", JSON.stringify(state.cart)); } catch (_) {}
}
function loadCart() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    if (!cs || !cs.getItem) return resolve();
    try {
      cs.getItem("cart", (err, val) => {
        if (!err && val) { try { const arr = JSON.parse(val); if (Array.isArray(arr)) state.cart = arr; } catch (_) {} }
        resolve();
      });
    } catch (_) { resolve(); }
  });
}
// Сверяем сохранённую корзину с каталогом: тихо убираем исчезнувшие позиции и
// подтягиваем актуальные цены/названия (вдруг товар изменили после сохранения).
async function validateCart() {
  if (!state.cart.length) return;
  if (!state.allProducts) {
    try { state.allProducts = await apiFetch(`/api/products?location_id=${LOCATION_ID}`, { tg }); }
    catch (_) { return; }
  }
  const byVariant = new Map();
  for (const p of state.allProducts) for (const v of p.variants) byVariant.set(v.id, { p, v });
  state.cart = state.cart
    .filter((l) => byVariant.has(l.variantId))
    .map((l) => {
      const { p, v } = byVariant.get(l.variantId);
      return { ...l, name: p.name, photo: p.photo_url, variantLabel: v.label, price: v.price };
    });
  updateCartBar();
}

el("cart-bar").addEventListener("click", () => { renderCart(); navPush("cart"); });

function renderCart() {
  const wrap = el("cart-items");
  if (!state.cart.length) {
    wrap.innerHTML = `<div class="empty-state">${t("cart_empty")}</div>`;
  } else {
    wrap.innerHTML = state.cart
      .map(
        (l, i) => `
      <div class="cart-line">
        <img src="${l.photo}" alt="" />
        <div class="cl-info">
          <div class="cl-name">${l.name}</div>
          <div class="cl-variant">${l.variantLabel}</div>
          <div class="cl-qty">
            <button class="qty-btn qty-btn-sm" data-dec="${i}" aria-label="−">−</button>
            <span class="cl-qty-val">${l.quantity}</span>
            <button class="qty-btn qty-btn-sm" data-inc="${i}" aria-label="+">+</button>
          </div>
        </div>
        <div class="cl-price">${money(l.price * l.quantity)}</div>
        <button class="btn-icon" data-remove="${i}" aria-label="✕">✕</button>
      </div>`
      )
      .join("");
    const rerender = () => { renderCart(); updateCartBar(); };
    wrap.querySelectorAll("[data-remove]").forEach((btn) =>
      btn.addEventListener("click", () => { state.cart.splice(Number(btn.dataset.remove), 1); rerender(); })
    );
    wrap.querySelectorAll("[data-inc]").forEach((btn) =>
      btn.addEventListener("click", () => { state.cart[Number(btn.dataset.inc)].quantity += 1; rerender(); })
    );
    wrap.querySelectorAll("[data-dec]").forEach((btn) =>
      btn.addEventListener("click", () => { const l = state.cart[Number(btn.dataset.dec)]; l.quantity = Math.max(1, l.quantity - 1); rerender(); })
    );
  }
  renderAddonsInto(el("cart-addons"), t("addons_cart_title"), () => { renderCart(); updateCartBar(); });
  el("cart-total").innerHTML = `<span>${t("total")}</span><span>${money(cartTotal())}</span>`;
}

el("to-checkout-btn").addEventListener("click", () => {
  if (!state.cart.length) return;
  openCheckout();
});

// ---------------------------------------------------------------------
// Оформление заказа
// ---------------------------------------------------------------------
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? +m[1] * 60 + +m[2] : null;
}
function minDelivery() { return Number(state.shop?.min_delivery_amount ?? 100); }
function computeDeliveryFeeClient() {
  const s = state.shop || {};
  const dayEnd = parseHHMM(s.delivery_day_end || "22:00") ?? 22 * 60;
  const slot = el("f-slot")?.value || "";
  let start = slot ? parseHHMM(slot.split("-")[0]) : null;
  if (start == null) {
    const now = new Date();
    const batumi = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 4 * 3600000);
    start = batumi.getHours() * 60 + batumi.getMinutes();
  }
  const day = Number(s.delivery_fee_day ?? 15);
  const night = Number(s.delivery_fee_night ?? 30);
  return start >= dayEnd ? night : day;
}

// Текущая дата в Батуми (UTC+4) в формате YYYY-MM-DD — для min у поля даты.
function batumiToday() {
  const now = new Date();
  const b = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 4 * 3600000);
  return b.toISOString().slice(0, 10);
}
// Свободные слоты доставки на выбранную дату приходят с сервера: занятые (лимит
// на слот исчерпан) и уже прошедшие сегодня окна не показываются. 2-часовые окна.
async function loadSlots() {
  const sel = el("f-slot");
  const dateEl = el("f-date");
  if (!sel) return;
  const date = dateEl && dateEl.value;
  const prev = sel.value;
  if (!date) {
    sel.innerHTML = `<option value="">${t("slot_pick_date")}</option>`;
    updateCheckoutState();
    return;
  }
  sel.innerHTML = `<option value="">${t("slot_loading")}</option>`;
  try {
    const data = await apiFetch(`/api/slots?date=${encodeURIComponent(date)}`);
    const slots = data.slots || [];
    if (!slots.length) {
      sel.innerHTML = `<option value="">${t("slot_none")}</option>`;
    } else {
      sel.innerHTML =
        `<option value="">${t("slot_choose")}</option>` +
        slots.map((s) => `<option value="${s}">${s.replace("-", "–")}</option>`).join("");
      if (prev && slots.includes(prev)) sel.value = prev;
    }
  } catch (e) {
    sel.innerHTML = `<option value="">${t("slot_none")}</option>`;
  }
  updateCheckoutState();
}

function openCheckout() {
  state.fulfillment = "delivery";
  state.zone = "batumi";
  // Кнопка онлайн-оплаты (PayPal) — только если владелец её включил и задал курс.
  const ppBtn = el("pay-paypal-btn");
  if (ppBtn) {
    const on = !!(state.shop && state.shop.paypal_enabled);
    ppBtn.hidden = !on;
    if (!on && state.paymentMethod === "paypal") {
      state.paymentMethod = "cash";
      document.querySelectorAll("#payment-toggle .segmented-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.value === "cash"));
    }
  }
  const dateEl = el("f-date");
  if (dateEl) {
    dateEl.min = batumiToday();
    if (!dateEl.value) dateEl.value = batumiToday();
  }
  loadSlots();
  syncFulfillmentUi();
  updateCheckoutState();
  navPush("checkout");
}

function syncFulfillmentUi() {
  document.querySelectorAll("#fulfillment-toggle .segmented-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.value === state.fulfillment)
  );
  document.querySelectorAll("#zone-toggle .segmented-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.value === state.zone)
  );
  el("delivery-fields").style.display = state.fulfillment === "delivery" ? "block" : "none";
}

// Пересчёт подсказок, доступности и сумм на экране оформления.
function updateCheckoutState() {
  const items = cartTotal();
  const min = minDelivery();
  const isDelivery = state.fulfillment === "delivery";
  const belowMin = isDelivery && items < min;
  const outside = isDelivery && state.zone === "outside";

  const minNote = el("delivery-min-note");
  minNote.style.display = belowMin ? "block" : "none";
  minNote.textContent = t("delivery_min_note", { sum: money(min) });
  el("zone-outside-note").style.display = outside ? "block" : "none";

  let fee = 0;
  if (isDelivery && !belowMin && !outside) fee = computeDeliveryFeeClient();
  const total = items + fee;
  const rows = [`<div class="ct-row"><span>${t("items_line")}</span><span>${money(items)}</span></div>`];
  if (isDelivery) rows.push(`<div class="ct-row"><span>${t("delivery_fee_line")}</span><span>${outside || belowMin ? "—" : money(fee)}</span></div>`);
  rows.push(`<div class="ct-row ct-total"><span>${t("to_pay")}</span><span>${money(total)}</span></div>`);
  el("checkout-total").innerHTML = rows.join("");

  // Обязательные поля: имя и телефон всегда; для доставки — адрес, дата, слот.
  const name = (el("f-name")?.value || "").trim();
  const phone = (el("f-phone")?.value || "").trim();
  const address = (el("f-address")?.value || "").trim();
  const date = (el("f-date")?.value || "").trim();
  const slot = (el("f-slot")?.value || "").trim();
  const missingContact = !name || !phone;
  const missingDelivery = isDelivery && (!address || !date || !slot);

  const blocked = belowMin || outside || missingContact || missingDelivery;
  const btn = el("submit-order-btn");
  btn.disabled = blocked;
  btn.classList.toggle("is-disabled", blocked);
}

document.querySelectorAll("#fulfillment-toggle .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.fulfillment = btn.dataset.value;
    syncFulfillmentUi();
    updateCheckoutState();
  });
});
document.querySelectorAll("#zone-toggle .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.zone = btn.dataset.value;
    syncFulfillmentUi();
    updateCheckoutState();
  });
});
el("f-slot").addEventListener("change", updateCheckoutState);
el("f-date").addEventListener("change", loadSlots);
// Разблокировка кнопки по мере заполнения обязательных полей.
["f-name", "f-phone", "f-address"].forEach((id) => {
  const inp = el(id);
  if (inp) inp.addEventListener("input", updateCheckoutState);
});

document.querySelectorAll("#payment-toggle .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#payment-toggle .segmented-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.paymentMethod = btn.dataset.value;
  });
});

// Enter в однострочных полях скрывает клавиатуру (а не «прыгает»/висит).
document.querySelectorAll('#checkout-form input:not([type="checkbox"])').forEach((inp) =>
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); blurActive(); } })
);

el("checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  blurActive();
  const fd = new FormData(e.target);
  const payload = {
    location_id: LOCATION_ID,
    customer_name: fd.get("customer_name"),
    customer_phone: fd.get("customer_phone"),
    fulfillment_type: state.fulfillment,
    delivery_zone: state.fulfillment === "delivery" ? state.zone : null,
    address: state.fulfillment === "delivery" ? fd.get("address") : "",
    delivery_date: fd.get("delivery_date") || "",
    delivery_slot: fd.get("delivery_slot") || "",
    recipient_name: fd.get("recipient_name") || "",
    card_message: fd.get("card_message") || "",
    photo_before_delivery: fd.get("photo_before_delivery") === "on",
    payment_method: state.paymentMethod,
    items: state.cart.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
  };

  const btn = el("submit-order-btn");
  btn.disabled = true;
  btn.textContent = t("sending");
  try {
    const order = await apiFetch("/api/orders", { method: "POST", body: payload, tg });
    state.cart = [];
    updateCartBar();
    navReset();
    if (order.needs_payment) {
      renderPaymentStart(order);
    } else {
      renderConfirmation(order);
      haptic("success");
    }
    navPush("confirm");
  } catch (err) {
    const detail = err.data?.detail;
    showToast(detail || (err.data?.error === "unauthorized" ? t("order_auth_err") : t("order_fail")));
  } finally {
    btn.disabled = false;
    btn.textContent = t("confirm_order");
  }
});

const STAGE_KEYS = ["new", "assembling", "assembled", "out_for_delivery", "delivered"];

function bloomProgressHtml(status) {
  const idx = STAGE_KEYS.findIndex((s) => s === status);
  return `<div class="bloom-progress">${STAGE_KEYS.map((key, i) => {
    const cls = i < idx ? "done" : i === idx ? "current" : "";
    return `<div class="bloom-step ${cls}">
        <div class="bloom-line"></div>
        <div class="bloom-dot">${i <= idx ? "✿" : ""}</div>
        <div class="bloom-label">${t("st_" + key)}</div>
      </div>`;
  }).join("")}</div>`;
}

function renderConfirmation(order) {
  stopPaymentPoll();
  el("confirm-content").innerHTML = `
    <div class="confirm-icon">💐</div>
    <div class="confirm-title">${t("order_accepted", { n: order.id })}</div>
    <div class="confirm-sub">${t("order_accepted_sub", { sum: money(order.total) })}</div>
    ${bloomProgressHtml(order.status)}
    <button class="btn btn-secondary btn-block" style="margin-top:22px;" id="confirm-done">${t("done")}</button>
  `;
  el("confirm-done").addEventListener("click", navBack);
}

// ---------------------------------------------------------------------
// Онлайн-оплата (PayPal): выбор валюты → переход на оплату → поллинг статуса
// ---------------------------------------------------------------------
const PAY_CCY = [
  { code: "EUR", sym: "€", rateKey: "pay_rate_eur" },
  { code: "USD", sym: "$", rateKey: "pay_rate_usd" },
];
// Сумма в валюте = лари / курс, округление вверх до цента (как на сервере).
function payAmount(totalGel, rate) {
  const r = Number(rate || 0);
  if (r <= 0) return null;
  return Math.ceil((Number(totalGel) / r) * 100) / 100;
}

let paymentPollTimer = null;
let payVisHandler = null;
function stopPaymentPoll() {
  if (paymentPollTimer) { clearInterval(paymentPollTimer); paymentPollTimer = null; }
  if (payVisHandler) { document.removeEventListener("visibilitychange", payVisHandler); payVisHandler = null; }
}

// Экран после создания онлайн-заказа: выбор валюты с суммой «≈ €X / ≈ $Y».
function renderPaymentStart(order) {
  stopPaymentPoll();
  const opts = PAY_CCY.map((c) => {
    const amt = payAmount(order.total, state.shop?.[c.rateKey]);
    if (amt == null) return "";
    return `<button class="btn btn-primary btn-block pay-ccy-btn" data-ccy="${c.code}" style="margin-bottom:10px;">${t("pay_now", { amount: c.sym + amt.toFixed(2) })}</button>`;
  }).filter(Boolean).join("");
  el("confirm-content").innerHTML = `
    <div class="confirm-icon">💳</div>
    <div class="confirm-title">${t("awaiting_pay_title")}</div>
    <div class="confirm-sub">${t("awaiting_pay_sub", { n: order.id })}</div>
    <div style="margin:16px 0 8px; font-weight:600;">${t("pay_choose_currency")}</div>
    ${opts}
    <div class="pd-note" style="margin-top:10px;">${t("pay_online_hint")}</div>
  `;
  el("confirm-content").querySelectorAll(".pay-ccy-btn").forEach((b) =>
    b.addEventListener("click", () => startPayment(order, b.dataset.ccy))
  );
}

async function startPayment(order, currency) {
  const btns = el("confirm-content").querySelectorAll(".pay-ccy-btn");
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await apiFetch(`/api/orders/${order.id}/pay`, { method: "POST", body: { currency }, tg });
    if (res && res.approval_url) {
      if (tg.openLink) tg.openLink(res.approval_url); else window.open(res.approval_url, "_blank");
      renderPaymentWaiting(order);
      startPaymentPoll(order);
    } else {
      showToast(t("pay_start_err"));
      btns.forEach((b) => (b.disabled = false));
    }
  } catch (err) {
    showToast(err.data?.detail || t("pay_start_err"));
    btns.forEach((b) => (b.disabled = false));
  }
}

// Ожидание оплаты: показываем «проверяем», поллим статус, есть ручная перепроверка.
function renderPaymentWaiting(order) {
  el("confirm-content").innerHTML = `
    <div class="confirm-icon">⏳</div>
    <div class="confirm-title">${t("pay_checking")}</div>
    <div class="confirm-sub">${t("awaiting_pay_sub", { n: order.id })}</div>
    <div class="pd-note" style="margin-top:10px;">${t("pay_online_hint")}</div>
    <button class="btn btn-primary btn-block pay-ccy-btn" id="pay-recheck" style="margin-top:16px;">${t("pay_i_paid")}</button>
  `;
  el("pay-recheck").addEventListener("click", () => checkPaymentOnce(order, true));
}

function startPaymentPoll(order) {
  stopPaymentPoll();
  const until = Date.now() + 10 * 60 * 1000; // поллим до 10 минут
  paymentPollTimer = setInterval(() => {
    if (Date.now() > until) { stopPaymentPoll(); return; }
    if (curSheet() === "confirm") checkPaymentOnce(order, false);
  }, 4000);
  // Клиент вернулся из браузера — сразу проверить.
  payVisHandler = () => {
    if (document.visibilityState === "visible" && curSheet() === "confirm") checkPaymentOnce(order, false);
  };
  document.addEventListener("visibilitychange", payVisHandler);
}

async function checkPaymentOnce(order, manual) {
  try {
    const s = await apiFetch(`/api/orders/${order.id}/payment-status`, { tg });
    if (s && s.payment_status === "paid") {
      stopPaymentPoll();
      renderPaymentSuccess(order);
      haptic("success");
    } else if (manual) {
      showToast(t("pay_checking"));
    }
  } catch (_) { if (manual) showToast(t("pay_start_err")); }
}

function renderPaymentSuccess(order) {
  el("confirm-content").innerHTML = `
    <div class="confirm-icon">💐</div>
    <div class="confirm-title">${t("payment_success")}</div>
    <div class="confirm-sub">${t("payment_success_sub", { n: order.id })}</div>
    ${bloomProgressHtml("new")}
    <button class="btn btn-secondary btn-block" style="margin-top:22px;" id="confirm-done">${t("done")}</button>
  `;
  el("confirm-done").addEventListener("click", navBack);
}

// ---------------------------------------------------------------------
// Мои заказы + отслеживание статуса + повтор заказа
// ---------------------------------------------------------------------
async function openOrders() {
  navPush("orders");
  await loadMyOrders();
}

async function loadMyOrders() {
  const list = el("orders-list");
  list.innerHTML = `<div class="empty-state">${t("loading")}</div>`;
  try {
    const orders = await apiFetch("/api/orders/mine", { tg });
    if (!orders.length) { list.innerHTML = `<div class="empty-state">${t("orders_empty")}</div>`; return; }
    list.innerHTML = orders
      .map(
        (o) => `
      <button class="order-row" data-order="${o.id}">
        <div>
          <div class="or-id">${t("order_num", { n: o.id })}</div>
          <div class="or-date">${(o.created_at || "").slice(0, 10)}</div>
        </div>
        <div class="or-right">
          <span class="or-status s-${o.status}">${t("st_" + o.status)}</span>
          <span class="or-total">${money(o.total)}</span>
        </div>
      </button>`
      )
      .join("");
    list.querySelectorAll("[data-order]").forEach((btn) =>
      btn.addEventListener("click", () => openOrderDetail(Number(btn.dataset.order)))
    );
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${err.status === 401 ? t("orders_auth_err") : t("orders_load_err")}</div>`;
  }
}

async function openOrderDetail(orderId) {
  navPush("orderdetail");
  const box = el("orderdetail-content");
  box.innerHTML = `<div class="empty-state">${t("loading")}</div>`;
  try {
    const o = await apiFetch(`/api/orders/${orderId}`, { tg });
    const progress = o.status === "cancelled"
      ? `<div class="order-cancelled">${t("order_cancelled")}</div>`
      : bloomProgressHtml(o.status);
    const feeLine = o.delivery_fee > 0
      ? `<div class="cart-line"><div class="cl-info"><div class="cl-name">${t("delivery_fee_line")}</div></div><div class="cl-price">${money(o.delivery_fee)}</div></div>`
      : "";
    box.innerHTML = `
      <h2 style="margin-top:0;">${t("order_num", { n: o.id })}</h2>
      <div class="od-sub">${(o.created_at || "").slice(0, 16)} · ${money(o.total)}</div>
      ${progress}
      <div class="od-items">
        ${o.items.map((i) => `
          <div class="cart-line">
            <div class="cl-info"><div class="cl-name">${i.product_name}</div><div class="cl-variant">${i.variant_label} · ×${i.quantity}</div></div>
            <div class="cl-price">${money(i.price * i.quantity)}</div>
          </div>`).join("")}
        ${feeLine}
      </div>
      <button class="btn btn-primary btn-block" id="repeat-order-btn" style="margin-top:18px;">${t("repeat_order")}</button>
    `;
    el("repeat-order-btn").addEventListener("click", () => repeatOrder(o));
  } catch (err) {
    box.innerHTML = `<div class="empty-state">${t("order_load_err")}</div>`;
  }
}

async function repeatOrder(order) {
  const btn = el("repeat-order-btn");
  if (btn) { btn.disabled = true; btn.textContent = t("adding"); }
  let added = 0;
  for (const it of order.items) {
    if (!it.product_id) continue;
    try {
      const p = await apiFetch(`/api/products/${it.product_id}`, { tg });
      const v = p.variants.find((x) => x.label === it.variant_label) || p.variants[0];
      if (!v) continue;
      const existing = state.cart.find((l) => l.variantId === v.id);
      if (existing) existing.quantity += it.quantity;
      else state.cart.push({
        productId: p.id, name: p.name, photo: p.photo_url,
        variantId: v.id, variantLabel: v.label, price: v.price, quantity: it.quantity,
      });
      added += 1;
    } catch (_) {}
  }
  updateCartBar();
  if (added) {
    navReset();
    renderCart();
    navPush("cart");
    haptic("success");
    showToast(added === order.items.length ? t("added_to_cart") : t("partial_added"));
  } else {
    if (btn) { btn.disabled = false; btn.textContent = t("repeat_order"); }
    showToast(t("items_unavailable"));
  }
}

// ---------------------------------------------------------------------
// Нижнее меню + вкладки
// ---------------------------------------------------------------------
function setActiveTab(tab) {
  document.querySelectorAll("#bottom-nav .nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
}
function scrollTop() { window.scrollTo({ top: 0, behavior: "smooth" }); }
function showCatalog() {
  state.view = "catalog";
  setActiveTab("catalog");
  el("tabs").style.display = "";
  el("grid-title").textContent = t("popular");
  renderProductGrid(state.products);
  scrollTop();
}
async function showFavorites() {
  state.view = "favorites";
  setActiveTab("favorites");
  el("tabs").style.display = "none";
  el("grid-title").textContent = t("favorites");
  scrollTop();
  if (!state.allProducts) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">${t("loading")}</div>`;
    try { state.allProducts = await apiFetch(`/api/products?location_id=${LOCATION_ID}`, { tg }); }
    catch (_) { state.allProducts = [...state.products]; }
  }
  renderProductGrid(state.allProducts.filter((p) => state.favorites.has(p.id)));
}

document.querySelectorAll("#bottom-nav .nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab === "catalog") showCatalog();
    else if (tab === "favorites") showFavorites();
    else if (tab === "cart") { renderCart(); navPush("cart"); }
    else if (tab === "profile") { renderProfile(); navPush("profile"); }
  });
});

el("header-cart").addEventListener("click", () => { renderCart(); navPush("cart"); });
el("filter-btn").addEventListener("click", openFilters);

// Кнопка «Наверх» — появляется при длинной прокрутке каталога.
const toTopBtn = el("to-top");
if (toTopBtn) {
  toTopBtn.hidden = false;
  toTopBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  window.addEventListener("scroll", () => {
    toTopBtn.classList.toggle("show", window.scrollY > 400 && !curSheet());
  }, { passive: true });
}

// ---------------------------------------------------------------------
// Фильтры и сортировка
// ---------------------------------------------------------------------
function fchip(group, value, label, active) {
  return `<button class="chip ${active ? "active" : ""}" data-fgroup="${group}" data-fval="${value}" type="button">${label}</button>`;
}
function openFilters() {
  const f = state.filter;
  el("filter-content").innerHTML = `
    <div class="filter-group">
      <div class="filter-group-title">${t("filter_sort")}</div>
      <div class="chips">
        ${fchip("sort", "default", t("sort_default"), f.sort === "default")}
        ${fchip("sort", "popular", t("sort_popular"), f.sort === "popular")}
        ${fchip("sort", "price_asc", t("sort_price_asc"), f.sort === "price_asc")}
        ${fchip("sort", "price_desc", t("sort_price_desc"), f.sort === "price_desc")}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title">${t("filter_badge")}</div>
      <div class="chips">
        ${fchip("badge", "", t("filter_all"), !f.badge)}
        ${fchip("badge", "hit", t("badge_hit"), f.badge === "hit")}
        ${fchip("badge", "new", t("badge_new"), f.badge === "new")}
        ${fchip("badge", "recommended", t("badge_recommended"), f.badge === "recommended")}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title">${t("filter_availability")}</div>
      <div class="chips">
        ${fchip("availability", "", t("filter_all"), !f.availability)}
        ${fchip("availability", "in_stock", t("avail_in_stock"), f.availability === "in_stock")}
        ${fchip("availability", "made_to_order", t("avail_made"), f.availability === "made_to_order")}
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-title">${t("filter_price")}</div>
      <div class="filter-price-row">
        <input type="number" inputmode="numeric" enterkeyhint="done" id="f-price-min" placeholder="${t("price_from")}" value="${f.priceMin ?? ""}" />
        <span>—</span>
        <input type="number" inputmode="numeric" enterkeyhint="done" id="f-price-max" placeholder="${t("price_to")}" value="${f.priceMax ?? ""}" />
      </div>
    </div>
    <div class="filter-actions">
      <button class="btn btn-secondary" id="filter-reset" type="button">${t("reset")}</button>
      <button class="btn btn-primary" id="filter-apply" type="button">${t("apply")}</button>
    </div>
  `;
  el("filter-content").querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      c.parentElement.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      state.filter[c.dataset.fgroup] = c.dataset.fval;
    })
  );
  el("filter-content").querySelectorAll("#f-price-min, #f-price-max").forEach((inp) =>
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); blurActive(); } })
  );
  el("filter-reset").addEventListener("click", () => {
    state.filter = { sort: "default", badge: "", availability: "", priceMin: null, priceMax: null };
    navBack();
    if (state.view !== "catalog") showCatalog(); else renderProductGrid();
  });
  el("filter-apply").addEventListener("click", () => {
    const minV = parseFloat(el("f-price-min").value);
    const maxV = parseFloat(el("f-price-max").value);
    state.filter.priceMin = Number.isFinite(minV) ? minV : null;
    state.filter.priceMax = Number.isFinite(maxV) ? maxV : null;
    navBack();
    if (state.view !== "catalog") showCatalog(); else renderProductGrid();
  });
  navPush("filter");
}

// ---------------------------------------------------------------------
// Избранное/лайки — на сервере (переживает смену устройства)
// ---------------------------------------------------------------------
async function loadFavorites() {
  try {
    const ids = await apiFetch("/api/favorites", { tg });
    state.favorites = new Set((ids || []).map(Number));
  } catch (_) { /* не критично: покажем без отметок */ }
}

// ---------------------------------------------------------------------
// Тема
// ---------------------------------------------------------------------
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}
function setTheme(theme) {
  state.theme = theme;
  applyTheme(theme);
  try { tg.CloudStorage?.setItem?.("theme", theme); } catch (_) {}
}
function osTheme() {
  try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  catch (_) { return "light"; }
}
function loadTheme() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    const done = (v) => { state.theme = v; applyTheme(v); resolve(); };
    if (!cs || !cs.getItem) return done(osTheme());
    try {
      cs.getItem("theme", (err, val) => {
        done(!err && (val === "light" || val === "dark") ? val : osTheme());
      });
    } catch (_) { done(osTheme()); }
  });
}

// Вибрация: тумблер в профиле, хранение в CloudStorage (по умолчанию вкл).
function setHaptics(on) {
  state.haptics = !!on;
  try { tg.CloudStorage?.setItem?.("haptics", on ? "1" : "0"); } catch (_) {}
}
function loadHaptics() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    if (!cs || !cs.getItem) { state.haptics = true; return resolve(); }
    try {
      cs.getItem("haptics", (err, val) => { state.haptics = !(!err && val === "0"); resolve(); });
    } catch (_) { state.haptics = true; resolve(); }
  });
}

// ---------------------------------------------------------------------
// Профиль (заказы, тема, язык, контакты). Валюта — только ₾, без выбора.
// ---------------------------------------------------------------------
function renderProfile() {
  const u = tg.initDataUnsafe?.user;
  const name = u?.first_name ? `${u.first_name}${u.last_name ? " " + u.last_name : ""}` : t("guest");
  const th = state.theme === "dark" ? "dark" : "light";
  const lng = state.lang || "ru";
  const hap = state.haptics !== false;
  const s = state.shop || {};
  const ig = (s.instagram || "").replace(/^@/, "");
  const contactRows = [];
  if (s.phone) contactRows.push(`<a class="pm-item" href="tel:${s.phone}"><span>📞 ${t("call")}</span><span class="pm-val">${s.phone}</span></a>`);
  if (ig) contactRows.push(`<a class="pm-item" href="https://instagram.com/${ig}" target="_blank" rel="noopener"><span>📸 Instagram</span><span class="pm-val">@${ig}</span></a>`);
  if (s.address) contactRows.push(`<div class="pm-item"><span>📍 ${t("address_title")}</span><span class="pm-val">${s.address}</span></div>`);

  el("profile-content").innerHTML = `
    <div class="profile-head">
      <div class="profile-avatar-lg"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5 8-5s6.5 1 8 5"/></svg></div>
      <div>
        <div class="profile-name">${name}</div>
        <div class="profile-hint">${t("profile_hint")}</div>
      </div>
    </div>
    <div class="profile-menu">
      <button class="pm-item" id="pm-orders" type="button"><span>🌸 ${t("my_orders")}</span><span class="pm-val">${t("see_more")}</span></button>
      <div class="pm-block">
        <div class="pm-block-title">${t("appearance")}</div>
        <div class="pm-block-row">
          <span>${t("theme")}</span>
          <div class="pm-seg" id="pm-theme">
            <button class="pm-seg-btn ${th === "light" ? "active" : ""}" data-theme="light" type="button">${t("theme_light")}</button>
            <button class="pm-seg-btn ${th === "dark" ? "active" : ""}" data-theme="dark" type="button">${t("theme_dark")}</button>
          </div>
        </div>
        <div class="pm-block-row">
          <span>${t("language")}</span>
          <div class="pm-seg" id="pm-lang">
            <button class="pm-seg-btn ${lng === "ru" ? "active" : ""}" data-lang="ru" type="button">Русский</button>
            <button class="pm-seg-btn ${lng === "en" ? "active" : ""}" data-lang="en" type="button">English</button>
          </div>
        </div>
        <div class="pm-block-row">
          <span>${t("haptics")}</span>
          <div class="pm-seg" id="pm-haptics">
            <button class="pm-seg-btn ${hap ? "active" : ""}" data-haptics="on" type="button">${t("on_label")}</button>
            <button class="pm-seg-btn ${!hap ? "active" : ""}" data-haptics="off" type="button">${t("off_label")}</button>
          </div>
        </div>
      </div>
      ${contactRows.length ? `<div class="pm-block"><div class="pm-block-title">${t("contact")}</div>${contactRows.join("")}</div>` : ""}
    </div>
  `;
  el("pm-orders").addEventListener("click", openOrders);
  el("profile-content").querySelectorAll("#pm-theme .pm-seg-btn").forEach((b) =>
    b.addEventListener("click", () => { setTheme(b.dataset.theme); renderProfile(); })
  );
  el("profile-content").querySelectorAll("#pm-lang .pm-seg-btn").forEach((b) =>
    b.addEventListener("click", () => { setLanguage(b.dataset.lang); })
  );
  el("profile-content").querySelectorAll("#pm-haptics .pm-seg-btn").forEach((b) =>
    b.addEventListener("click", () => { setHaptics(b.dataset.haptics === "on"); renderProfile(); haptic(); })
  );
}

// ---------------------------------------------------------------------
init();
async function init() {
  try {
    await loadLang();
    await loadTheme();
    await loadHaptics();
    await loadCart();
    applyDomI18n(document);
    await loadShop();
    await loadFavorites();
    await loadCategories();
    await loadProducts();
    await loadAddons();
    await validateCart();
    updateCartBar();
  } catch (err) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">${t("catalog_load_err")}</div>`;
    console.error(err);
  }
}
