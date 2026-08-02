import { getTelegram, apiFetch, initFullscreen } from "/shared/telegram.js";
import { t, getLang, setLang, detectLang, applyDomI18n } from "/shared/i18n.js";

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
  renderProductGrid(state.view === "favorites" ? undefined : state.products);
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

function priceOf(p) {
  const prices = p.variants.map((v) => v.price).filter((x) => x > 0);
  return prices.length ? Math.min(...prices) : null;
}

function productCardHtml(p) {
  const minPrice = priceOf(p);
  const priceLabel = minPrice
    ? `<span class="pc-price"><small>${t("from_price")}</small> ${money(minPrice)}</span>`
    : `<span class="pc-price">${t("on_request")}</span>`;
  const fav = state.favorites.has(p.id) ? " on" : "";
  const tag = p.status === "made_to_order" ? `<span class="pc-tag made">${t("made_to_order")}</span>` : "";
  return `
    <div class="product-card" data-product="${p.id}">
      <div class="photo">
        ${tag}
        <button class="pc-heart${fav}" data-fav="${p.id}" type="button" aria-label="favorite">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21C12 21 4 14.5 4 8.8C4 5.9 6.2 4 8.6 4C10.2 4 11.4 4.9 12 6C12.6 4.9 13.8 4 15.4 4C17.8 4 20 5.9 20 8.8C20 14.5 12 21 12 21Z"/></svg>
        </button>
        <img src="${p.photo_url}" alt="${p.name}" loading="lazy" />
      </div>
      <div class="info">
        <div class="pc-name">${p.name}</div>
        <div class="pc-row">${priceLabel}<button class="pc-plus" data-add="${p.id}" type="button" aria-label="add">+</button></div>
      </div>
    </div>`;
}

function renderProductGrid(list = state.products) {
  const grid = el("product-grid");
  if (!list.length) {
    const msg = state.view === "favorites" ? t("fav_empty") : t("nothing_found");
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🌾</div>${msg}</div>`;
    return;
  }
  grid.innerHTML = list.map(productCardHtml).join("");
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
  tg.HapticFeedback?.impactOccurred?.("light");
  updateCartBar();
  showToast(t("added_to_cart"));
}

function toggleFavorite(id, btnEl) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  if (btnEl) btnEl.classList.toggle("on", state.favorites.has(id));
  saveFavorites();
  tg.HapticFeedback?.selectionChanged?.();
  if (state.view === "favorites") showFavorites();
}

let searchTimer;
el("search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  state.search = e.target.value.trim();
  searchTimer = setTimeout(loadProducts, 300);
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

function benefitRow(icon, text) {
  return `<div class="pd-benefit"><span class="pd-bic">${icon}</span><span>${text}</span></div>`;
}
function accordion(id, title, body) {
  if (!body) return "";
  return `
    <div class="pd-acc" data-acc="${id}">
      <button class="pd-acc-head" type="button">${title}
        <svg class="pd-acc-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="pd-acc-body">${body}</div>
    </div>`;
}

function renderProductSheet() {
  const p = state.currentProduct;
  const s = state.shop || {};
  const variantsHtml = p.variants
    .map(
      (v) => `
      <button class="variant-pill ${v.id === state.selectedVariantId ? "active" : ""}" data-variant="${v.id}">
        ${v.label}
        <span class="v-price">${v.price > 0 ? money(v.price) : t("on_request")}</span>
      </button>`
    )
    .join("");

  const minP = priceOf(p);
  const leadPrice = minP ? `${t("from_price")} ${money(minP)}` : t("on_request");

  const desc = p.description || "";
  const isLong = desc.length > 120;
  const descBlock = desc
    ? `<div class="pd-desc ${isLong && !state.descExpanded ? "clamp" : ""}">${desc}</div>
       ${isLong ? `<button class="pd-more" id="desc-toggle" type="button">${state.descExpanded ? t("collapse") : t("see_full_desc")}</button>` : ""}`
    : "";

  const note = (s.disclaimer_note || t("note_default"));
  const express = (s.express_delivery_text || t("express_default"));
  const deliveryInfo = (s.delivery_payment_info || t("delivery_info_default"));
  const ICON_GIFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12v8H4v-8"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7S9 7 8 5.5 9 3 10 4s2 3 2 3zM12 7s3 0 4-1.5S15 3 14 4s-2 3-2 3z"/></svg>`;
  const ICON_TRUCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>`;
  const ICON_STORE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16l-1 11H5z"/><path d="M4 9l1.2-4h13.6L20 9"/></svg>`;

  el("product-sheet-content").innerHTML = `
    <div class="pd-photo"><img src="${p.photo_url}" alt="${p.name}" /></div>
    <h2 class="pd-title">${p.name}</h2>
    <div class="pd-price-lead">${leadPrice}</div>
    ${descBlock}

    <div class="pd-note">${note}</div>

    <div class="pd-benefits">
      ${benefitRow(ICON_GIFT, t("benefit_packaging"))}
      ${benefitRow(ICON_TRUCK, `${t("benefit_express")} · ${express}`)}
      ${benefitRow(ICON_STORE, s.address ? `${t("benefit_pickup")} — ${s.address}` : t("benefit_pickup"))}
    </div>

    <div class="pd-label">${t("size")}</div>
    <div class="variant-row" id="variant-row">${variantsHtml}</div>
    <div class="pd-label">${t("quantity")}</div>
    <div class="qty-row">
      <button class="qty-btn" id="qty-minus">−</button>
      <span class="qty-value" id="qty-value">${state.selectedQty}</span>
      <button class="qty-btn" id="qty-plus">+</button>
    </div>
    <button class="btn btn-primary btn-block" id="add-to-cart-btn">${t("add_to_cart")}</button>

    <div class="pd-accs">
      ${accordion("desc", t("acc_description"), p.description || "")}
      ${accordion("comp", t("acc_composition"), p.composition || "")}
      ${accordion("deliv", t("acc_delivery"), deliveryInfo)}
    </div>

    <div id="product-addons"></div>
  `;

  document.querySelectorAll("#variant-row .variant-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedVariantId = Number(btn.dataset.variant);
      renderProductSheet();
    });
  });
  el("qty-minus").addEventListener("click", () => {
    state.selectedQty = Math.max(1, state.selectedQty - 1);
    el("qty-value").textContent = state.selectedQty;
  });
  el("qty-plus").addEventListener("click", () => {
    state.selectedQty += 1;
    el("qty-value").textContent = state.selectedQty;
  });
  el("add-to-cart-btn").addEventListener("click", addSelectedToCart);

  const dtoggle = el("desc-toggle");
  if (dtoggle) dtoggle.addEventListener("click", () => { state.descExpanded = !state.descExpanded; renderProductSheet(); });

  document.querySelectorAll("#product-sheet-content .pd-acc-head").forEach((h) =>
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"))
  );

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
  tg.HapticFeedback?.impactOccurred?.("light");
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

function updateCartBar() {
  const bar = el("cart-bar");
  const count = cartCount();
  const badge = el("cart-nav-badge");
  if (badge) {
    if (count > 0) { badge.hidden = false; badge.textContent = count; }
    else badge.hidden = true;
  }
  if (count === 0) { bar.classList.remove("visible"); return; }
  el("cart-summary").textContent = t("cart_count", { n: count, sum: money(cartTotal()) });
  bar.classList.add("visible");
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
      btn.addEventListener("click", () => { state.cart[Number(btn.dataset.inc)].quantity += 1; tg.HapticFeedback?.selectionChanged?.(); rerender(); })
    );
    wrap.querySelectorAll("[data-dec]").forEach((btn) =>
      btn.addEventListener("click", () => { const l = state.cart[Number(btn.dataset.dec)]; l.quantity = Math.max(1, l.quantity - 1); tg.HapticFeedback?.selectionChanged?.(); rerender(); })
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

function openCheckout() {
  state.fulfillment = "delivery";
  state.zone = "batumi";
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

  const blocked = belowMin || outside;
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
    renderConfirmation(order);
    navPush("confirm");
    tg.HapticFeedback?.notificationOccurred?.("success");
  } catch (err) {
    const detail = err.data?.detail;
    showToast(detail || (err.data?.error === "unauthorized" ? t("order_auth_err") : t("order_fail")));
  } finally {
    btn.disabled = false;
    btn.textContent = t("confirm_order");
  }
});

const STAGE_KEYS = ["new", "confirmed", "assembling", "out_for_delivery", "delivered"];

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
    tg.HapticFeedback?.notificationOccurred?.("success");
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
function showCatalog() {
  state.view = "catalog";
  setActiveTab("catalog");
  el("tabs").style.display = "";
  el("grid-title").textContent = t("popular");
  renderProductGrid(state.products);
}
async function showFavorites() {
  state.view = "favorites";
  setActiveTab("favorites");
  el("tabs").style.display = "none";
  el("grid-title").textContent = t("favorites");
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

el("profile-avatar").addEventListener("click", () => { renderProfile(); navPush("profile"); });
el("filter-btn").addEventListener("click", () => showToast(t("filters_soon")));

// ---------------------------------------------------------------------
// Избранное — Telegram CloudStorage
// ---------------------------------------------------------------------
function saveFavorites() {
  try { tg.CloudStorage?.setItem?.("favorites", JSON.stringify([...state.favorites])); } catch (_) {}
}
function loadFavorites() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    if (!cs || !cs.getItem) return resolve();
    try {
      cs.getItem("favorites", (err, val) => {
        if (!err && val) { try { JSON.parse(val).forEach((id) => state.favorites.add(Number(id))); } catch (_) {} }
        resolve();
      });
    } catch (_) { resolve(); }
  });
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
function loadTheme() {
  return new Promise((resolve) => {
    const cs = tg.CloudStorage;
    if (!cs || !cs.getItem) { applyTheme("system"); return resolve(); }
    try {
      cs.getItem("theme", (err, val) => { state.theme = !err && val ? val : "system"; applyTheme(state.theme); resolve(); });
    } catch (_) { applyTheme("system"); resolve(); }
  });
}

// ---------------------------------------------------------------------
// Профиль (заказы, тема, язык, контакты). Валюта — только ₾, без выбора.
// ---------------------------------------------------------------------
function renderProfile() {
  const u = tg.initDataUnsafe?.user;
  const name = u?.first_name ? `${u.first_name}${u.last_name ? " " + u.last_name : ""}` : t("guest");
  const th = state.theme || "system";
  const lng = state.lang || "ru";
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
            <button class="pm-seg-btn ${th === "system" ? "active" : ""}" data-theme="system" type="button">${t("theme_system")}</button>
          </div>
        </div>
        <div class="pm-block-row">
          <span>${t("language")}</span>
          <div class="pm-seg" id="pm-lang">
            <button class="pm-seg-btn ${lng === "ru" ? "active" : ""}" data-lang="ru" type="button">Русский</button>
            <button class="pm-seg-btn ${lng === "en" ? "active" : ""}" data-lang="en" type="button">English</button>
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
}

// ---------------------------------------------------------------------
init();
async function init() {
  try {
    await loadLang();
    await loadTheme();
    await loadFavorites();
    applyDomI18n(document);
    await loadShop();
    await loadCategories();
    await loadProducts();
    await loadAddons();
  } catch (err) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">${t("catalog_load_err")}</div>`;
    console.error(err);
  }
}
