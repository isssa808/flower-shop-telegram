import { getTelegram, apiFetch } from "/shared/telegram.js";

const tg = getTelegram();
tg.ready();
tg.expand();

const LOCATION_ID = 1;

const state = {
  categories: [],
  products: [],
  activeCategory: null,
  search: "",
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

function openSheet(name) {
  el(`${name}-backdrop`).classList.add("open");
  el(`${name}-sheet`).classList.add("open");
}
function closeSheet(name) {
  el(`${name}-backdrop`).classList.remove("open");
  el(`${name}-sheet`).classList.remove("open");
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => closeSheet(b.dataset.close))
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

function renderProductGrid() {
  const grid = el("product-grid");
  if (!state.products.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">🌾</div>Ничего не нашлось — попробуйте другой запрос</div>`;
    return;
  }
  grid.innerHTML = "";
  state.products.forEach((p) => {
    const minPrice = Math.min(...p.variants.map((v) => v.price).filter((x) => x > 0), Infinity);
    const priceLabel = Number.isFinite(minPrice) ? `от ${money(minPrice)}` : "по запросу";
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="photo"><img src="${p.photo_url}" alt="${p.name}" loading="lazy" /></div>
      <div class="info">
        <div class="name">${p.name}</div>
        <div class="price">${priceLabel}</div>
        <div class="status-row">${statusBadge(p.status)}</div>
      </div>`;
    card.addEventListener("click", () => openProduct(p));
    grid.appendChild(card);
  });
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
  openSheet("product");
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

  el("product-sheet-content").innerHTML = `
    <div class="pd-photo"><img src="${p.photo_url}" alt="${p.name}" /></div>
    <h2 class="pd-title">${p.name}</h2>
    ${p.description ? `<div class="pd-desc">${p.description}</div>` : ""}
    ${p.composition ? `<div class="pd-composition">Состав: ${p.composition}</div>` : ""}
    <div class="variant-row" id="variant-row">${variantsHtml}</div>
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
  closeSheet("product");
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
  if (cartCount() === 0) {
    bar.classList.remove("visible");
    return;
  }
  el("cart-summary").textContent = `${cartCount()} товар(а) · ${money(cartTotal())}`;
  bar.classList.add("visible");
}

el("cart-bar").addEventListener("click", () => {
  renderCart();
  openSheet("cart");
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
          <div class="cl-variant">${l.variantLabel} · ×${l.quantity}</div>
        </div>
        <div class="cl-price">${money(l.price * l.quantity)}</div>
        <button class="btn-icon" data-remove="${i}" aria-label="Убрать">✕</button>
      </div>`
      )
      .join("");
    wrap.querySelectorAll("[data-remove]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.cart.splice(Number(btn.dataset.remove), 1);
        renderCart();
        updateCartBar();
      })
    );
  }
  el("cart-total").innerHTML = `<span>Итого</span><span>${money(cartTotal())}</span>`;
}

el("to-checkout-btn").addEventListener("click", () => {
  if (!state.cart.length) return;
  closeSheet("cart");
  el("checkout-total").innerHTML = `<span>К оплате</span><span>${money(cartTotal())}</span>`;
  openSheet("checkout");
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
    closeSheet("checkout");
    renderConfirmation(order);
    openSheet("confirm");
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
  el("confirm-content").querySelector("[data-close]").addEventListener("click", () => closeSheet("confirm"));
}

// ---------------------------------------------------------------------
init();
async function init() {
  try {
    await loadCategories();
    await loadProducts();
  } catch (err) {
    el("product-grid").innerHTML = `<div class="empty-state" style="grid-column:1/-1;">Не удалось загрузить каталог. Проверьте, что backend запущен.</div>`;
    console.error(err);
  }
}
