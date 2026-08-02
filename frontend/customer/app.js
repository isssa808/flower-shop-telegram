import { getTelegram, apiFetch, initFullscreen } from "/shared/telegram.js";

const tg = getTelegram();
initFullscreen(tg);

const LOCATION_ID = 1;

const state = {
  categories: [],
  products: [],
  allProducts: null, // кэш полного каталога (для избранного)
  activeCategory: null,
  search: "",
  view: "catalog", // catalog | favorites
  favorites: new Set(),
  theme: "system", // light | dark | system
  cart: [], // { productId, name, photo, variantId, variantLabel, price, quantity }
  currentProduct: null,
  selectedVariantId: null,
  selectedQty: 1,
};

const el = (id) => document.getElementById(id);
const money = (n) => `${Number(n).toFixed(0)} ₾`;

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}

// --- Навигация по шторкам + системная кнопка «Назад» Telegram ---------
// history — стек открытых экранов. Пока в нём что-то есть, показываем
// нативную кнопку «‹ Назад»; она закрывает верхнюю шторку и возвращает на
// предыдущую (оформление → корзина → каталог). Когда стек пуст — кнопку
// прячем, и Telegram сам показывает своё «Закрыть».
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
// Открыть новый экран поверх текущего (текущий остаётся в истории).
function navPush(name) {
  const cur = curSheet();
  if (cur && cur !== name) hideSheetEl(cur);
  sheetHistory.push(name);
  showSheetEl(name);
  syncBackButton();
}
// Назад: закрыть верхний экран и показать предыдущий (или каталог).
function navBack() {
  const cur = sheetHistory.pop();
  if (cur) hideSheetEl(cur);
  const prev = curSheet();
  if (prev) showSheetEl(prev);
  syncBackButton();
}
// Закрыть все шторки (например, после успешного заказа).
function navReset() {
  while (sheetHistory.length) hideSheetEl(sheetHistory.pop());
  syncBackButton();
}
tg.BackButton?.onClick?.(navBack);
tg.BackButton?.hide?.();
// Клик по затемнению/крестику = «назад».
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", navBack)
);

// ---------------------------------------------------------------------
// Каталог
// ---------------------------------------------------------------------
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

function renderTabs() {
  const tabs = el("tabs");
  const all = [{ slug: null, name: "Всё" }, ...state.categories];
  tabs.innerHTML = "";
  all.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (state.activeCategory === c.slug ? " active" : "");
    btn.textContent = c.name;
    btn.addEventListener("click", () => {
      state.activeCategory = c.slug;
      renderTabs();
      loadProducts();
    });
    tabs.appendChild(btn);
  });
}

function statusBadge(status) {
  if (status === "made_to_order") return `<span class="badge badge-muted">под заказ</span>`;
  return `<span class="badge badge-leaf">в наличии</span>`;
}

function findProduct(id) {
  return (
    state.products.find((x) => x.id === id) ||
    (state.allProducts || []).find((x) => x.id === id) ||
    null
  );
}

function productCardHtml(p) {
  const prices = p.variants.map((v) => v.price).filter((x) => x > 0);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const priceLabel = minPrice
    ? `<span class="pc-price"><small>от</small> ${money(minPrice)}</span>`
    : `<span class="pc-price">по запросу</span>`;
  const fav = state.favorites.has(p.id) ? " on" : "";
  const tag = p.status === "made_to_order" ? `<span class="pc-tag made">Под заказ</span>` : "";
  return `
    <div class="product-card" data-product="${p.id}">
      <div class="photo">
        ${tag}
        <button class="pc-heart${fav}" data-fav="${p.id}" type="button" aria-label="В избранное">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21C12 21 4 14.5 4 8.8C4 5.9 6.2 4 8.6 4C10.2 4 11.4 4.9 12 6C12.6 4.9 13.8 4 15.4 4C17.8 4 20 5.9 20 8.8C20 14.5 12 21 12 21Z"/></svg>
        </button>
        <img src="${p.photo_url}" alt="${p.name}" loading="lazy" />
      </div>
      <div class="info">
        <div class="pc-name">${p.name}</div>
        <div class="pc-row">${priceLabel}<button class="pc-plus" data-add="${p.id}" type="button" aria-label="В корзину">+</button></div>
      </div>
    </div>`;
}

function renderProductGrid(list = state.products) {
  const grid = el("product-grid");
  if (!list.length) {
    const msg =
      state.view === "favorites"
        ? "В избранном пока пусто — жмите ♥ на букетах"
        : "Ничего не нашлось — попробуйте другой запрос";
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

// Быстрое добавление с карточки: берём первый доступный вариант.
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
  showToast("Добавлено в корзину");
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
// Карточка товара
// ---------------------------------------------------------------------
function openProduct(p) {
  state.currentProduct = p;
  state.selectedVariantId = p.variants[0]?.id ?? null;
  state.selectedQty = 1;
  renderProductSheet();
  navPush("product");
}

function renderProductSheet() {
  const p = state.currentProduct;
  const variantsHtml = p.variants
    .map(
      (v) => `
      <button class="variant-pill ${v.id === state.selectedVariantId ? "active" : ""}" data-variant="${v.id}">
        ${v.label}
        <span class="v-price">${v.price > 0 ? money(v.price) : "по запросу"}</span>
      </button>`
    )
    .join("");

  const prices = p.variants.map((v) => v.price).filter((x) => x > 0);
  const leadPrice = prices.length ? `от ${money(Math.min(...prices))}` : "по запросу";

  el("product-sheet-content").innerHTML = `
    <div class="pd-photo"><img src="${p.photo_url}" alt="${p.name}" /></div>
    <h2 class="pd-title">${p.name}</h2>
    <div class="pd-price-lead">${leadPrice}</div>
    ${p.description ? `<div class="pd-desc">${p.description}</div>` : ""}
    ${p.composition ? `<div class="pd-composition">Состав: ${p.composition}</div>` : ""}
    <div class="pd-label">Размер</div>
    <div class="variant-row" id="variant-row">${variantsHtml}</div>
    <div class="pd-label">Количество</div>
    <div class="qty-row">
      <button class="qty-btn" id="qty-minus">−</button>
      <span class="qty-value" id="qty-value">${state.selectedQty}</span>
      <button class="qty-btn" id="qty-plus">+</button>
    </div>
    <button class="btn btn-primary btn-block" id="add-to-cart-btn">Добавить в корзину</button>
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
}

function addSelectedToCart() {
  const p = state.currentProduct;
  const variant = p.variants.find((v) => v.id === state.selectedVariantId);
  if (!variant) return;
  const existing = state.cart.find((l) => l.variantId === variant.id);
  if (existing) {
    existing.quantity += state.selectedQty;
  } else {
    state.cart.push({
      productId: p.id,
      name: p.name,
      photo: p.photo_url,
      variantId: variant.id,
      variantLabel: variant.label,
      price: variant.price,
      quantity: state.selectedQty,
    });
  }
  tg.HapticFeedback?.impactOccurred("light");
  updateCartBar();
  navBack();
  showToast("Добавлено в корзину");
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
  if (count === 0) {
    bar.classList.remove("visible");
    return;
  }
  el("cart-summary").textContent = `${count} товар(а) · ${money(cartTotal())}`;
  bar.classList.add("visible");
}

el("cart-bar").addEventListener("click", () => {
  renderCart();
  navPush("cart");
});

function renderCart() {
  const wrap = el("cart-items");
  if (!state.cart.length) {
    wrap.innerHTML = `<div class="empty-state">Корзина пуста</div>`;
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
            <button class="qty-btn qty-btn-sm" data-dec="${i}" aria-label="Меньше">−</button>
            <span class="cl-qty-val">${l.quantity}</span>
            <button class="qty-btn qty-btn-sm" data-inc="${i}" aria-label="Больше">+</button>
          </div>
        </div>
        <div class="cl-price">${money(l.price * l.quantity)}</div>
        <button class="btn-icon" data-remove="${i}" aria-label="Убрать">✕</button>
      </div>`
      )
      .join("");
    const rerender = () => { renderCart(); updateCartBar(); };
    wrap.querySelectorAll("[data-remove]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.cart.splice(Number(btn.dataset.remove), 1);
        rerender();
      })
    );
    wrap.querySelectorAll("[data-inc]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.cart[Number(btn.dataset.inc)].quantity += 1;
        tg.HapticFeedback?.selectionChanged?.();
        rerender();
      })
    );
    wrap.querySelectorAll("[data-dec]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const line = state.cart[Number(btn.dataset.dec)];
        line.quantity = Math.max(1, line.quantity - 1);
        tg.HapticFeedback?.selectionChanged?.();
        rerender();
      })
    );
  }
  el("cart-total").innerHTML = `<span>Итого</span><span>${money(cartTotal())}</span>`;
}

el("to-checkout-btn").addEventListener("click", () => {
  if (!state.cart.length) return;
  el("checkout-total").innerHTML = `<span>К оплате</span><span>${money(cartTotal())}</span>`;
  navPush("checkout"); // корзина остаётся в истории — «назад» вернёт к ней
});

// ---------------------------------------------------------------------
// Оформление заказа
// ---------------------------------------------------------------------
let fulfillmentType = "delivery";
document.querySelectorAll("#fulfillment-toggle .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#fulfillment-toggle .segmented-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    fulfillmentType = btn.dataset.value;
    el("delivery-fields").style.display = fulfillmentType === "delivery" ? "block" : "none";
  });
});

let paymentMethod = "cash";
document.querySelectorAll("#payment-toggle .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#payment-toggle .segmented-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    paymentMethod = btn.dataset.value;
  });
});

el("checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    location_id: LOCATION_ID,
    customer_name: fd.get("customer_name"),
    customer_phone: fd.get("customer_phone"),
    fulfillment_type: fulfillmentType,
    address: fulfillmentType === "delivery" ? fd.get("address") : "",
    delivery_date: fd.get("delivery_date") || "",
    delivery_slot: fd.get("delivery_slot") || "",
    recipient_name: fd.get("recipient_name") || "",
    card_message: fd.get("card_message") || "",
    photo_before_delivery: fd.get("photo_before_delivery") === "on",
    payment_method: paymentMethod,
    items: state.cart.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
  };

  const btn = el("submit-order-btn");
  btn.disabled = true;
  btn.textContent = "Отправляем…";
  try {
    const order = await apiFetch("/api/orders", { method: "POST", body: payload, tg });
    state.cart = [];
    updateCartBar();
    navReset(); // заказ оформлен, корзина пуста — «назад» из подтверждения ведёт в каталог
    renderConfirmation(order);
    navPush("confirm");
    tg.HapticFeedback?.notificationOccurred("success");
  } catch (err) {
    showToast(err.data?.error === "unauthorized" ? "Откройте приложение через Telegram, чтобы оформить заказ" : "Не получилось оформить заказ, попробуйте ещё раз");
  } finally {
    btn.disabled = false;
    btn.textContent = "Подтвердить заказ";
  }
});

const STAGES = [
  { key: "new", label: "Новый", icon: "✿" },
  { key: "confirmed", label: "Подтверждён", icon: "✿" },
  { key: "assembling", label: "Собирается", icon: "✿" },
  { key: "out_for_delivery", label: "В пути", icon: "✿" },
  { key: "delivered", label: "Доставлен", icon: "✿" },
];

function bloomProgressHtml(status) {
  const idx = STAGES.findIndex((s) => s.key === status);
  return `<div class="bloom-progress">${STAGES.map((s, i) => {
    const cls = i < idx ? "done" : i === idx ? "current" : "";
    return `<div class="bloom-step ${cls}">
        <div class="bloom-line"></div>
        <div class="bloom-dot">${i <= idx ? s.icon : ""}</div>
        <div class="bloom-label">${s.label}</div>
      </div>`;
  }).join("")}</div>`;
}

function renderConfirmation(order) {
  el("confirm-content").innerHTML = `
    <div class="confirm-icon">💐</div>
    <div class="confirm-title">Заказ №${order.id} принят</div>
    <div class="confirm-sub">Мы уже начали собирать ваш букет. Сумма: ${money(order.total)}</div>
    ${bloomProgressHtml(order.status)}
    <button class="btn btn-secondary btn-block" style="margin-top:22px;" data-close="confirm">Готово</button>
  `;
  el("confirm-content").querySelector("[data-close]").addEventListener("click", navBack);
}

// ---------------------------------------------------------------------
// Мои заказы + отслеживание статуса + повтор заказа
// ---------------------------------------------------------------------
const ORDER_STATUS_LABEL = {
  new: "Новый", confirmed: "Подтверждён", assembling: "Собирается",
  out_for_delivery: "В пути", delivered: "Доставлен", cancelled: "Отменён",
};

async function openOrders() {
  navPush("orders");
  await loadMyOrders();
}

async function loadMyOrders() {
  const list = el("orders-list");
  list.innerHTML = `<div class="empty-state">Загружаем…</div>`;
  try {
    const orders = await apiFetch("/api/orders/mine", { tg });
    if (!orders.length) {
      list.innerHTML = `<div class="empty-state">Здесь появятся ваши заказы</div>`;
      return;
    }
    list.innerHTML = orders
      .map(
        (o) => `
      <button class="order-row" data-order="${o.id}">
        <div>
          <div class="or-id">Заказ №${o.id}</div>
          <div class="or-date">${(o.created_at || "").slice(0, 10)}</div>
        </div>
        <div class="or-right">
          <span class="or-status s-${o.status}">${ORDER_STATUS_LABEL[o.status] || o.status}</span>
          <span class="or-total">${money(o.total)}</span>
        </div>
      </button>`
      )
      .join("");
    list.querySelectorAll("[data-order]").forEach((btn) =>
      btn.addEventListener("click", () => openOrderDetail(Number(btn.dataset.order)))
    );
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${
      err.status === 401 ? "Откройте приложение через Telegram, чтобы видеть заказы" : "Не удалось загрузить заказы"
    }</div>`;
  }
}

async function openOrderDetail(orderId) {
  navPush("orderdetail");
  const box = el("orderdetail-content");
  box.innerHTML = `<div class="sheet-handle-spacer"></div><div class="empty-state">Загружаем…</div>`;
  try {
    const o = await apiFetch(`/api/orders/${orderId}`, { tg });
    const progress =
      o.status === "cancelled"
        ? `<div class="order-cancelled">Заказ отменён</div>`
        : bloomProgressHtml(o.status);
    box.innerHTML = `
      <h2 style="margin-top:0;">Заказ №${o.id}</h2>
      <div class="od-sub">${(o.created_at || "").slice(0, 16)} · ${money(o.total)}</div>
      ${progress}
      <div class="od-items">
        ${o.items
          .map(
            (i) => `
          <div class="cart-line">
            <div class="cl-info">
              <div class="cl-name">${i.product_name}</div>
              <div class="cl-variant">${i.variant_label} · ×${i.quantity}</div>
            </div>
            <div class="cl-price">${money(i.price * i.quantity)}</div>
          </div>`
          )
          .join("")}
      </div>
      <button class="btn btn-primary btn-block" id="repeat-order-btn" style="margin-top:18px;">Повторить заказ</button>
    `;
    el("repeat-order-btn").addEventListener("click", () => repeatOrder(o));
  } catch (err) {
    box.innerHTML = `<div class="empty-state">Не удалось загрузить заказ</div>`;
  }
}

// Повтор заказа: подтягиваем актуальный товар по product_id, ищем тот же
// вариант по названию (label) — цена берётся текущая. Недоступные пропускаем.
async function repeatOrder(order) {
  const btn = el("repeat-order-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Добавляем…"; }
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
    } catch (_) { /* товар скрыт/удалён — пропускаем */ }
  }
  updateCartBar();
  if (added) {
    navReset();
    renderCart();
    navPush("cart");
    tg.HapticFeedback?.notificationOccurred?.("success");
    showToast(added === order.items.length ? "Добавлено в корзину" : "Часть товаров недоступна — добавили что смогли");
  } else {
    if (btn) { btn.disabled = false; btn.textContent = "Повторить заказ"; }
    showToast("Эти товары сейчас недоступны");
  }
}

// ---------------------------------------------------------------------
// Нижнее меню + вкладки (Каталог / Избранное / Корзина / Профиль)
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
  el("grid-title").textContent = "Популярное";
  renderProductGrid(state.products);
}

async function showFavorites() {
  state.view = "favorites";
  setActiveTab("favorites");
  el("tabs").style.display = "none";
  el("grid-title").textContent = "Избранное";
  if (!state.allProducts) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Загружаем…</div>`;
    try {
      state.allProducts = await apiFetch(`/api/products?location_id=${LOCATION_ID}`, { tg });
    } catch (_) {
      state.allProducts = [...state.products];
    }
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
el("filter-btn").addEventListener("click", () => showToast("Фильтры добавим на следующем этапе"));

// ---------------------------------------------------------------------
// Избранное — хранение в Telegram CloudStorage (синхронно между устройствами)
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
        if (!err && val) {
          try { JSON.parse(val).forEach((id) => state.favorites.add(Number(id))); } catch (_) {}
        }
        resolve();
      });
    } catch (_) { resolve(); }
  });
}

// ---------------------------------------------------------------------
// Тема (светлая / тёмная / как в системе)
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
      cs.getItem("theme", (err, val) => {
        state.theme = !err && val ? val : "system";
        applyTheme(state.theme);
        resolve();
      });
    } catch (_) { applyTheme("system"); resolve(); }
  });
}

// ---------------------------------------------------------------------
// Профиль (история заказов + настройки; язык и валюта — Этап 4)
// ---------------------------------------------------------------------
function renderProfile() {
  const u = tg.initDataUnsafe?.user;
  const name = u?.first_name ? `${u.first_name}${u.last_name ? " " + u.last_name : ""}` : "Гость";
  const t = state.theme || "system";
  el("profile-content").innerHTML = `
    <div class="profile-head">
      <div class="profile-avatar-lg"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5 8-5s6.5 1 8 5"/></svg></div>
      <div>
        <div class="profile-name">${name}</div>
        <div class="profile-hint">Flowers Batum Flower · Батуми</div>
      </div>
    </div>
    <div class="profile-menu">
      <button class="pm-item" id="pm-orders" type="button"><span>🌸 Мои заказы</span><span class="pm-val">смотреть ›</span></button>
      <div class="pm-block">
        <div class="pm-block-title">Оформление</div>
        <div class="pm-block-row">
          <span>Тема</span>
          <div class="pm-seg" id="pm-theme">
            <button class="pm-seg-btn ${t === "light" ? "active" : ""}" data-theme="light" type="button">Светлая</button>
            <button class="pm-seg-btn ${t === "dark" ? "active" : ""}" data-theme="dark" type="button">Тёмная</button>
            <button class="pm-seg-btn ${t === "system" ? "active" : ""}" data-theme="system" type="button">Как в системе</button>
          </div>
        </div>
      </div>
      <div class="pm-block">
        <div class="pm-block-row"><span>Язык</span><span class="pm-val">Русский <span class="pm-soon">скоро</span></span></div>
      </div>
      <div class="pm-block">
        <div class="pm-block-row"><span>Валюта</span><span class="pm-val">₾ лари <span class="pm-soon">скоро</span></span></div>
      </div>
    </div>
  `;
  el("pm-orders").addEventListener("click", openOrders);
  el("profile-content").querySelectorAll("#pm-theme .pm-seg-btn").forEach((b) =>
    b.addEventListener("click", () => { setTheme(b.dataset.theme); renderProfile(); })
  );
}

// ---------------------------------------------------------------------
init();
async function init() {
  try {
    await loadTheme();
    await loadFavorites();
    await loadCategories();
    await loadProducts();
  } catch (err) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Не удалось загрузить каталог. Проверьте, что backend запущен.</div>`;
    console.error(err);
  }
}
