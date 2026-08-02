import { getTelegram, apiFetch, initFullscreen } from "/shared/telegram.js";
import { buildProductSheetHtml } from "/shared/product-view.js";
import { t, setLang } from "/shared/i18n.js";

const tg = getTelegram();
initFullscreen(tg);
setLang("ru"); // админка русскоязычная; превью показываем на русском

const LOCATION_ID = 1;
const el = (id) => document.getElementById(id);
const money = (n) => `${Number(n).toFixed(0)} ₾`;

const state = {
  staff: null,
  view: "orders",
  categories: [],
  products: [],
  stock: [],
  orders: [],
  orderFilter: "",
  staffList: [],
  settings: null,
  salesPeriod: "day",
  salesOrders: [],
};

function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}
// Стек открытых шторок + системная кнопка Telegram «Назад»: пока открыта хоть
// одна шторка, показываем «Назад» (она закрывает верхнюю). Плюс видимый ✕ в
// каждой шторке (data-close) — чтобы выход был очевиден.
const sheetStack = [];
function openSheet(name) {
  el(`${name}-backdrop`).classList.add("open");
  el(`${name}-sheet`).classList.add("open");
  if (!sheetStack.includes(name)) sheetStack.push(name);
  tg.BackButton?.show?.();
}
function closeSheet(name) {
  el(`${name}-backdrop`).classList.remove("open");
  el(`${name}-sheet`).classList.remove("open");
  const i = sheetStack.lastIndexOf(name);
  if (i >= 0) sheetStack.splice(i, 1);
  if (!sheetStack.length) tg.BackButton?.hide?.();
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => closeSheet(b.dataset.close))
);
tg.BackButton?.onClick?.(() => {
  const top = sheetStack[sheetStack.length - 1];
  if (top) closeSheet(top);
});
tg.BackButton?.hide?.();

function roleLabel(role) {
  return { owner: "владелец", florist: "флорист", courier: "курьер" }[role] || role;
}
function statusLabelRu(s) {
  return { in_stock: "в наличии", made_to_order: "под заказ", hidden: "скрыт" }[s] || s;
}
const STATUS_LABELS = {
  new: "Новый", assembling: "Собирается", assembled: "Собран",
  out_for_delivery: "Передан курьеру", delivered: "Доставлен", cancelled: "Отменён",
};

// ---------------------------------------------------------------------
// Навигация между Заказы / Каталог / Склад
// ---------------------------------------------------------------------
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.view = btn.dataset.view;
    document.querySelectorAll(".admin-view").forEach((v) => (v.style.display = "none"));
    el(`view-${state.view}`).style.display = "block";
    if (state.view === "sales" && isOwner()) renderSales();
  });
});

// ---------------------------------------------------------------------
// Заказы
// ---------------------------------------------------------------------
const ORDER_STATUS_TABS = [["", "Все"], ...Object.entries(STATUS_LABELS)];

function renderOrderTabs() {
  el("order-status-tabs").innerHTML = ORDER_STATUS_TABS.map(
    ([val, label]) => `<button class="tab ${state.orderFilter === val ? "active" : ""}" data-status="${val}">${label}</button>`
  ).join("");
  el("order-status-tabs").querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.orderFilter = btn.dataset.status;
      renderOrderTabs();
      await loadOrders();
      renderOrders();
    });
  });
}

async function loadOrders() {
  const params = new URLSearchParams({ location_id: LOCATION_ID });
  if (state.orderFilter) params.set("status", state.orderFilter);
  state.orders = await apiFetch(`/api/admin/orders?${params}`, { tg });
}

function renderOrders() {
  const wrap = el("orders-list");
  if (!state.orders.length) {
    wrap.innerHTML = `<div class="empty-state">Заказов пока нет</div>`;
    return;
  }
  wrap.innerHTML = state.orders
    .map(
      (o) => {
        const thumb = o.items.find((i) => i.photo_url)?.photo_url;
        const times = [
          o.assembled_at ? `собран ${o.assembled_at}` : "",
          o.handed_at ? `передан ${o.handed_at}` : "",
          o.delivered_at ? `доставлен ${o.delivered_at}` : "",
        ].filter(Boolean).join(" · ");
        return `
    <div class="card order-card" data-order="${o.id}">
      <div class="order-card-top">
        <div style="display:flex; gap:10px; align-items:flex-start;">
          ${thumb ? `<img class="order-thumb" src="${thumb}" alt=""/>` : ""}
          <div>
            <div class="order-id">Заказ №${o.id}</div>
            <div class="order-customer">${o.customer_name || "—"} · ${o.customer_phone || "без телефона"}</div>
          </div>
        </div>
        <div class="order-total">${money(o.total)}</div>
      </div>
      <div class="order-meta">
        ${o.fulfillment_type === "delivery" ? `Доставка: ${o.address || "—"} · ${o.delivery_date || ""} ${o.delivery_slot || ""}` : "Самовывоз"}<br/>
        ${o.items.map((i) => `${i.product_name} (${i.variant_label}) ×${i.quantity}`).join(", ")}
        ${times ? `<br/><span class="order-times">${times}</span>` : ""}
      </div>
      <select class="status-select" data-order-id="${o.id}">
        ${Object.entries(STATUS_LABELS).map(([val, label]) => `<option value="${val}" ${o.status === val ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>`;
      }
    )
    .join("");

  wrap.querySelectorAll(".status-select").forEach((sel) => {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", async () => {
      try {
        await apiFetch(`/api/admin/orders/${sel.dataset.orderId}/status`, {
          method: "PUT", body: { status: sel.value }, tg,
        });
        showToast("Статус обновлён");
        await loadOrders();
        renderOrders();
      } catch {
        showToast("Не удалось изменить статус");
      }
    });
  });

  wrap.querySelectorAll(".order-card").forEach((card) => {
    card.addEventListener("click", () => openOrderDetail(Number(card.dataset.order)));
  });
}

function openOrderDetail(orderId) {
  const o = state.orders.find((x) => x.id === orderId);
  if (o) renderOrderDetail(o);
}

function renderOrderDetail(o) {
  const timeRows = [
    ["Собран", o.assembled_at], ["Передан курьеру", o.handed_at], ["Доставлен", o.delivered_at],
  ].filter(([, v]) => v);
  el("order-detail-content").innerHTML = `
    <h2>Заказ №${o.id}</h2>
    <div class="order-meta" style="margin-bottom:14px;">
      <strong>${o.customer_name}</strong><br/>${o.customer_phone}<br/><br/>
      ${o.fulfillment_type === "delivery" ? `Доставка на: ${o.address}<br/>${o.delivery_date || ""} ${o.delivery_slot || ""}${o.delivery_zone ? `<br/>Зона: ${o.delivery_zone === "batumi" ? "по Батуми" : o.delivery_zone}` : ""}` : "Самовывоз"}<br/>
      ${o.recipient_name ? `Получатель: ${o.recipient_name}<br/>` : ""}
      ${o.card_message ? `Открытка: «${o.card_message}»<br/>` : ""}
      ${o.photo_before_delivery ? "📷 Прислать фото перед доставкой<br/>" : ""}
      Оплата: ${o.payment_method}
    </div>
    ${o.items.map((i) => `<div class="cart-line">
        ${i.photo_url ? `<img class="order-thumb" src="${i.photo_url}" alt=""/>` : ""}
        <div class="cl-info"><div class="cl-name">${i.product_name}</div><div class="cl-variant">${i.variant_label} ×${i.quantity}</div></div>
        <div class="cl-price">${money(i.price * i.quantity)}</div></div>`).join("")}
    ${o.delivery_fee ? `<div class="cart-line"><div class="cl-info"><div class="cl-name">Доставка</div></div><div class="cl-price">${money(o.delivery_fee)}</div></div>` : ""}
    <div class="cart-total"><span>Итого</span><span>${money(o.total)}</span></div>
    ${timeRows.length ? `<div class="order-meta" style="margin-top:12px;">${timeRows.map(([l, v]) => `${l}: ${v}`).join("<br/>")}</div>` : ""}
  `;
  openSheet("order-detail");
}

// ---------------------------------------------------------------------
// Каталог
// ---------------------------------------------------------------------
async function loadCategories() {
  state.categories = await apiFetch(`/api/categories?location_id=${LOCATION_ID}`, { tg });
}
async function loadProducts() {
  state.products = await apiFetch(`/api/admin/products?location_id=${LOCATION_ID}`, { tg });
}

function renderCatalog() {
  const wrap = el("catalog-list");
  if (!state.products.length) {
    wrap.innerHTML = `<div class="empty-state">Пока нет товаров</div>`;
    return;
  }
  wrap.innerHTML = state.products
    .map(
      (p) => `
    <div class="card catalog-row">
      <img src="${p.photo_url}" alt=""/>
      <div class="cr-info">
        <div class="cr-name">${p.name}${badgeRu(p.badge) ? ` <span class="badge badge-rose">${badgeRu(p.badge)}</span>` : ""}</div>
        <div class="cr-meta">${p.variants.map((v) => money(v.price)).join(" / ") || "без цены"} · ${statusLabelRu(p.status)}</div>
        <div class="cr-meta">♥ ${p.likes || 0} · заказов ${p.order_count || 0}</div>
      </div>
      <div class="cr-actions">
        <button class="btn-icon" data-preview="${p.id}" aria-label="Превью">👁</button>
        <button class="btn-icon" data-edit="${p.id}" aria-label="Редактировать">✎</button>
        <button class="btn-icon" data-delete="${p.id}" aria-label="Удалить">🗑</button>
      </div>
    </div>`
    )
    .join("");
  wrap.querySelectorAll("[data-preview]").forEach((b) => b.addEventListener("click", () => previewProduct(state.products.find((x) => x.id === Number(b.dataset.preview)))));
  wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openProductEdit(Number(b.dataset.edit))));
  wrap.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => deleteProduct(Number(b.dataset.delete))));
}

el("add-product-btn").addEventListener("click", () => openProductEdit(null));

function badgeRu(b) { return { hit: "Хит", new: "Новинка", recommended: "Рекомендуем" }[b] || ""; }

// --- Превью товара «как на витрине» (общий модуль shared/product-view.js) ---
function shopForPreview() {
  const s = state.settings || {};
  return {
    address: s.shop_address,
    disclaimer_note: s.disclaimer_note,
    express_delivery_text: s.express_delivery_text,
    delivery_payment_info: s.delivery_payment_info,
  };
}
function formToProduct(variantEditor, existing) {
  const fd = new FormData(el("product-form"));
  const variants = [...variantEditor.querySelectorAll(".variant-editor-row")]
    .map((row) => ({ id: -1, label: row.querySelector(".v-label").value, price: parseFloat(row.querySelector(".v-price").value) || 0 }))
    .filter((v) => v.label);
  return {
    id: existing?.id ?? -1,
    name: fd.get("name") || "—",
    description: fd.get("description") || "",
    composition: fd.get("composition") || "",
    status: fd.get("status") || "in_stock",
    badge: fd.get("badge") || "",
    is_addon: fd.get("is_addon") ? 1 : 0,
    photo_url: existing?.photo_url || "/static/img/placeholder.svg",
    likes: existing?.likes || 0,
    order_count: existing?.order_count || 0,
    variants: variants.length ? variants : [{ id: -1, label: "—", price: 0 }],
  };
}
let previewDescExpanded = false;
function renderPreview(p) {
  el("product-preview-content").innerHTML = buildProductSheetHtml(p, {
    t, money, shop: shopForPreview(), mode: "preview",
    selectedVariantId: p.variants[0]?.id ?? null, descExpanded: previewDescExpanded,
  });
  const dt = el("product-preview-content").querySelector("#desc-toggle");
  if (dt) dt.addEventListener("click", () => { previewDescExpanded = !previewDescExpanded; renderPreview(p); });
  el("product-preview-content").querySelectorAll(".pd-acc-head").forEach((h) =>
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"))
  );
}
function previewProduct(p) {
  if (!p) return;
  previewDescExpanded = false;
  renderPreview(p);
  openSheet("product-preview");
}

function openProductEdit(productId) {
  const p = productId ? state.products.find((x) => x.id === productId) : null;
  const variants = p && p.variants.length ? p.variants : [{ label: "", price: "" }];

  el("product-edit-content").innerHTML = `
    <h2>${p ? "Редактировать товар" : "Новый товар"}</h2>
    <form id="product-form">
      <div class="field"><label>Название</label><input name="name" required value="${p?.name || ""}"/></div>
      <div class="field"><label>Категория</label>
        <select name="category_id">${state.categories.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? "selected" : ""}>${c.name}</option>`).join("")}</select>
      </div>
      <div class="field"><label>Описание</label><textarea name="description" rows="2">${p?.description || ""}</textarea></div>
      <div class="field"><label>Состав</label><input name="composition" value="${p?.composition || ""}"/></div>
      <div class="field"><label>Статус</label>
        <select name="status">
          <option value="in_stock" ${p?.status === "in_stock" ? "selected" : ""}>В наличии</option>
          <option value="made_to_order" ${p?.status === "made_to_order" ? "selected" : ""}>Под заказ</option>
          <option value="hidden" ${p?.status === "hidden" ? "selected" : ""}>Скрыт</option>
        </select>
      </div>
      <div class="field"><label>Отметка на витрине</label>
        <select name="badge">
          <option value="" ${!p?.badge ? "selected" : ""}>Без отметки</option>
          <option value="hit" ${p?.badge === "hit" ? "selected" : ""}>Хит</option>
          <option value="new" ${p?.badge === "new" ? "selected" : ""}>Новинка</option>
          <option value="recommended" ${p?.badge === "recommended" ? "selected" : ""}>Рекомендуем</option>
        </select>
      </div>
      <div class="field"><label>Повод (через запятую)</label><input name="occasion_tags" value="${(p?.occasion_tags || []).join(", ")}"/></div>
      <label class="checkbox-row" style="margin:2px 0 14px;">
        <input type="checkbox" name="is_addon" ${p?.is_addon ? "checked" : ""}/>
        <span>Показывать как доп-товар («Добавьте к заказу»)</span>
      </label>
      <div class="field"><label>Фото</label><input type="file" name="photo" accept="image/*"/></div>
      <div class="field">
        <label>Варианты (размер и цена)</label>
        <div id="variant-editor"></div>
        <button type="button" class="btn btn-outline btn-sm" id="add-variant-row">+ вариант</button>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="preview-product">Превью</button>
        <button type="button" class="btn btn-secondary" data-close="product-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `;

  const variantEditor = el("variant-editor");
  function addVariantRow(label = "", price = "") {
    const row = document.createElement("div");
    row.className = "variant-editor-row";
    row.innerHTML = `<input placeholder="Например: S — 11 роз" class="v-label" value="${label}"/>
      <input placeholder="Цена" type="number" step="0.01" class="v-price" style="max-width:90px;" value="${price}"/>
      <button type="button" class="btn-icon" data-remove-row aria-label="Убрать">✕</button>`;
    row.querySelector("[data-remove-row]").addEventListener("click", () => row.remove());
    variantEditor.appendChild(row);
  }
  variants.forEach((v) => addVariantRow(v.label, v.price));
  el("add-variant-row").addEventListener("click", () => addVariantRow());
  document.querySelectorAll("#product-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("product-edit")));
  el("preview-product").addEventListener("click", () => previewProduct(formToProduct(variantEditor, p)));

  el("product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const variantRows = [...variantEditor.querySelectorAll(".variant-editor-row")]
      .map((row) => ({
        label: row.querySelector(".v-label").value,
        price: parseFloat(row.querySelector(".v-price").value) || 0,
      }))
      .filter((v) => v.label);

    const body = {
      location_id: LOCATION_ID,
      category_id: Number(fd.get("category_id")),
      name: fd.get("name"),
      description: fd.get("description"),
      composition: fd.get("composition"),
      status: fd.get("status"),
      occasion_tags: fd.get("occasion_tags").split(",").map((s) => s.trim()).filter(Boolean),
      is_addon: fd.get("is_addon") ? 1 : 0,
      badge: fd.get("badge") || "",
      variants: variantRows,
    };

    try {
      const saved = p
        ? await apiFetch(`/api/admin/products/${p.id}`, { method: "PUT", body, tg })
        : await apiFetch("/api/admin/products", { method: "POST", body, tg });

      const photoFile = fd.get("photo");
      if (photoFile && photoFile.size > 0) {
        const photoForm = new FormData();
        photoForm.append("photo", photoFile);
        await fetch(`/api/admin/products/${saved.id}/photo`, {
          method: "POST",
          headers: { "X-Telegram-Init-Data": tg.initData },
          body: photoForm,
        });
      }
      showToast("Сохранено");
      closeSheet("product-edit");
      await loadProducts();
      renderCatalog();
    } catch (err) {
      showToast("Не удалось сохранить товар");
    }
  });

  openSheet("product-edit");
}

function deleteProduct(id) {
  tg.showConfirm("Удалить этот товар из каталога?", async (ok) => {
    if (!ok) return;
    try {
      await apiFetch(`/api/admin/products/${id}`, { method: "DELETE", tg });
      showToast("Товар удалён");
      await loadProducts();
      renderCatalog();
    } catch {
      showToast("Не удалось удалить товар");
    }
  });
}

// ---------------------------------------------------------------------
// Склад
// ---------------------------------------------------------------------
async function loadStock() {
  state.stock = await apiFetch(`/api/admin/stock?location_id=${LOCATION_ID}`, { tg });
}

function renderStock() {
  const wrap = el("stock-list");
  if (!state.stock.length) {
    wrap.innerHTML = `<div class="empty-state">Склад пуст</div>`;
    return;
  }
  wrap.innerHTML = state.stock
    .map((s) => {
      const low = s.quantity <= s.low_stock_threshold;
      return `
    <div class="card stock-row ${low ? "low" : ""}">
      <div>
        <div class="stock-name">${s.name}${low ? ' <span class="badge badge-rose">мало</span>' : ""}</div>
        <div class="stock-meta">${s.supplier || "поставщик не указан"}</div>
        <div class="stock-actions">
          <button class="btn btn-outline btn-sm" data-income="${s.id}">+ приход</button>
          <button class="btn btn-outline btn-sm" data-writeoff="${s.id}">− списание</button>
        </div>
      </div>
      <div class="stock-qty ${low ? "low" : ""}">${s.quantity} ${s.unit}</div>
    </div>`;
    })
    .join("");
  wrap.querySelectorAll("[data-income]").forEach((b) => b.addEventListener("click", () => openStockAction(Number(b.dataset.income), "income")));
  wrap.querySelectorAll("[data-writeoff]").forEach((b) => b.addEventListener("click", () => openStockAction(Number(b.dataset.writeoff), "writeoff")));
}

function openStockAction(stockId, type) {
  const s = state.stock.find((x) => x.id === stockId);
  el("stock-action-content").innerHTML = `
    <h2>${type === "income" ? "Приход поставки" : "Списание"}: ${s.name}</h2>
    <div class="stock-meta" style="margin-bottom:12px;">Сейчас на складе: ${s.quantity} ${s.unit}</div>
    <form id="stock-action-form">
      <div class="field"><label>Количество (${s.unit})</label><input name="quantity" type="number" step="0.01" min="0.01" required/></div>
      <div class="field"><label>Комментарий</label><input name="note" placeholder="${type === "income" ? "Например: поставка из Нидерландов" : "Например: увяли, брак"}"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="stock-action">Отмена</button>
        <button type="submit" class="btn btn-primary">${type === "income" ? "Добавить" : "Списать"}</button>
      </div>
    </form>
  `;
  document.querySelectorAll("#stock-action-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("stock-action")));
  el("stock-action-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await apiFetch(`/api/admin/stock/${stockId}/${type}`, {
        method: "POST",
        body: { quantity: parseFloat(fd.get("quantity")), note: fd.get("note") },
        tg,
      });
      showToast("Склад обновлён");
      closeSheet("stock-action");
      await loadStock();
      renderStock();
    } catch {
      showToast("Не удалось обновить склад");
    }
  });
  openSheet("stock-action");
}

el("add-stock-btn").addEventListener("click", () => {
  el("stock-action-content").innerHTML = `
    <h2>Новая позиция на складе</h2>
    <form id="new-stock-form">
      <div class="field"><label>Название</label><input name="name" required placeholder="Роза Ecuador белая 60см"/></div>
      <div class="field-row">
        <div class="field"><label>Ед. изм.</label><input name="unit" value="шт"/></div>
        <div class="field"><label>Начальный остаток</label><input name="quantity" type="number" step="0.01" value="0"/></div>
      </div>
      <div class="field"><label>Порог низкого остатка</label><input name="low_stock_threshold" type="number" value="10"/></div>
      <div class="field"><label>Поставщик</label><input name="supplier"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="stock-action">Отмена</button>
        <button type="submit" class="btn btn-primary">Добавить</button>
      </div>
    </form>
  `;
  document.querySelectorAll("#stock-action-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("stock-action")));
  el("new-stock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await apiFetch("/api/admin/stock", {
        method: "POST",
        body: {
          location_id: LOCATION_ID, name: fd.get("name"), unit: fd.get("unit") || "шт",
          quantity: parseFloat(fd.get("quantity")) || 0,
          low_stock_threshold: parseFloat(fd.get("low_stock_threshold")) || 10,
          supplier: fd.get("supplier"),
        },
        tg,
      });
      showToast("Позиция добавлена");
      closeSheet("stock-action");
      await loadStock();
      renderStock();
    } catch {
      showToast("Не удалось добавить позицию");
    }
  });
  openSheet("stock-action");
});

// ---------------------------------------------------------------------
// Настройки: категории, персонал, магазин (только владелец)
// ---------------------------------------------------------------------
function isOwner() {
  return state.staff && state.staff.role === "owner";
}

// --- Категории ---
function renderCategoriesAdmin() {
  const wrap = el("category-list");
  if (!state.categories.length) {
    wrap.innerHTML = `<div class="empty-state">Категорий пока нет</div>`;
    return;
  }
  wrap.innerHTML = state.categories
    .map((c) => {
      const count = state.products.filter((p) => p.category_id === c.id).length;
      return `
    <div class="card catalog-row">
      <div class="cr-info">
        <div class="cr-name">${c.name}</div>
        <div class="cr-meta">${count} товар(ов) · порядок ${c.sort_order}</div>
      </div>
      <div class="cr-actions">
        <button class="btn-icon" data-cat-edit="${c.id}" aria-label="Редактировать">✎</button>
        <button class="btn-icon" data-cat-delete="${c.id}" aria-label="Удалить">🗑</button>
      </div>
    </div>`;
    })
    .join("");
  wrap.querySelectorAll("[data-cat-edit]").forEach((b) => b.addEventListener("click", () => openCategoryEdit(Number(b.dataset.catEdit))));
  wrap.querySelectorAll("[data-cat-delete]").forEach((b) => b.addEventListener("click", () => deleteCategory(Number(b.dataset.catDelete))));
}

function openCategoryEdit(categoryId) {
  const c = categoryId ? state.categories.find((x) => x.id === categoryId) : null;
  el("category-edit-content").innerHTML = `
    <h2>${c ? "Редактировать категорию" : "Новая категория"}</h2>
    <form id="category-form">
      <div class="field"><label>Название</label><input name="name" required value="${c?.name || ""}" placeholder="Например: Пионы"/></div>
      <div class="field"><label>Порядок в списке</label><input name="sort_order" type="number" value="${c?.sort_order ?? ""}" placeholder="чем меньше — тем левее"/></div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="category-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `;
  document.querySelectorAll("#category-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("category-edit")));
  el("category-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const so = fd.get("sort_order");
    const body = { name: fd.get("name"), sort_order: so === "" ? null : Number(so) };
    try {
      if (c) await apiFetch(`/api/admin/categories/${c.id}`, { method: "PUT", body, tg });
      else await apiFetch("/api/admin/categories", { method: "POST", body, tg });
      showToast("Сохранено");
      closeSheet("category-edit");
      await loadCategories();
      renderCategoriesAdmin();
    } catch (err) {
      showToast("Не удалось сохранить категорию");
    }
  });
  openSheet("category-edit");
}

function deleteCategory(id) {
  const c = state.categories.find((x) => x.id === id);
  const count = state.products.filter((p) => p.category_id === id).length;
  if (count) {
    showToast(`В категории ${count} товар(ов) — сначала перенесите их`);
    return;
  }
  tg.showConfirm(`Удалить категорию «${c?.name}»?`, async (ok) => {
    if (!ok) return;
    try {
      await apiFetch(`/api/admin/categories/${id}`, { method: "DELETE", tg });
      showToast("Категория удалена");
      await loadCategories();
      renderCategoriesAdmin();
    } catch (err) {
      showToast(err?.data?.detail || "Не удалось удалить категорию");
    }
  });
}

el("add-category-btn").addEventListener("click", () => openCategoryEdit(null));

// --- Персонал ---
async function loadStaffList() {
  state.staffList = await apiFetch("/api/admin/staff", { tg });
}

function renderStaffAdmin() {
  const wrap = el("staff-list");
  if (!state.staffList.length) {
    wrap.innerHTML = `<div class="empty-state">Сотрудников нет</div>`;
    return;
  }
  wrap.innerHTML = state.staffList
    .map((s) => {
      const self = String(s.telegram_id) === String(state.staff.telegram_id);
      return `
    <div class="card catalog-row">
      <div class="cr-info">
        <div class="cr-name">${s.name}${self ? ' <span class="badge badge-muted">вы</span>' : ""}</div>
        <div class="cr-meta">${roleLabel(s.role)} · ID ${s.telegram_id}</div>
      </div>
      <div class="cr-actions">
        <button class="btn-icon" data-staff-edit="${s.id}" aria-label="Редактировать">✎</button>
        ${self ? "" : `<button class="btn-icon" data-staff-delete="${s.id}" aria-label="Удалить">🗑</button>`}
      </div>
    </div>`;
    })
    .join("");
  wrap.querySelectorAll("[data-staff-edit]").forEach((b) => b.addEventListener("click", () => openStaffEdit(Number(b.dataset.staffEdit))));
  wrap.querySelectorAll("[data-staff-delete]").forEach((b) => b.addEventListener("click", () => deleteStaff(Number(b.dataset.staffDelete))));
}

const ROLE_OPTIONS = [["owner", "Владелец"], ["florist", "Флорист"], ["courier", "Курьер"]];

function openStaffEdit(staffId) {
  const s = staffId ? state.staffList.find((x) => x.id === staffId) : null;
  el("staff-edit-content").innerHTML = `
    <h2>${s ? "Редактировать сотрудника" : "Новый сотрудник"}</h2>
    <form id="staff-form">
      <div class="field"><label>Имя</label><input name="name" required value="${s?.name || ""}"/></div>
      <div class="field">
        <label>Telegram ID</label>
        <input name="telegram_id" ${s ? "disabled" : "required"} value="${s?.telegram_id || ""}" placeholder="напр. 123456789"/>
        ${s ? "" : '<div class="cr-meta" style="margin-top:6px;">Узнать ID можно через @userinfobot. Сотрудник должен сначала написать боту /start.</div>'}
      </div>
      <div class="field"><label>Роль</label>
        <select name="role">${ROLE_OPTIONS.map(([v, l]) => `<option value="${v}" ${s?.role === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="staff-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `;
  document.querySelectorAll("#staff-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("staff-edit")));
  el("staff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      if (s) {
        await apiFetch(`/api/admin/staff/${s.id}`, { method: "PUT", body: { name: fd.get("name"), role: fd.get("role") }, tg });
      } else {
        await apiFetch("/api/admin/staff", {
          method: "POST",
          body: { telegram_id: fd.get("telegram_id"), name: fd.get("name"), role: fd.get("role") },
          tg,
        });
      }
      showToast("Сохранено");
      closeSheet("staff-edit");
      await loadStaffList();
      renderStaffAdmin();
    } catch (err) {
      showToast(err?.data?.detail || "Не удалось сохранить сотрудника");
    }
  });
  openSheet("staff-edit");
}

function deleteStaff(id) {
  const s = state.staffList.find((x) => x.id === id);
  tg.showConfirm(`Убрать доступ сотруднику «${s?.name}»?`, async (ok) => {
    if (!ok) return;
    try {
      await apiFetch(`/api/admin/staff/${id}`, { method: "DELETE", tg });
      showToast("Сотрудник удалён");
      await loadStaffList();
      renderStaffAdmin();
    } catch (err) {
      showToast(err?.data?.detail || "Не удалось удалить сотрудника");
    }
  });
}

el("add-staff-btn").addEventListener("click", () => openStaffEdit(null));

// --- Магазин и уведомления ---
async function loadSettings() {
  state.settings = await apiFetch("/api/admin/settings", { tg });
}

const esc = (v) => String(v == null ? "" : v).replace(/"/g, "&quot;");

function renderSettings() {
  const s = state.settings || {};
  const usingEnv = !s.staff_chat_id && s.staff_chat_id_effective;
  el("settings-form-wrap").innerHTML = `
    <div class="card" style="padding:14px;">
      <form id="settings-form">
        <h3 class="settings-group">Магазин</h3>
        <div class="field"><label>Название магазина</label><input name="shop_name" value="${esc(s.shop_name)}"/></div>
        <div class="field"><label>Адрес / точка</label><input name="shop_address" value="${esc(s.shop_address)}"/></div>

        <h3 class="settings-group">Доставка</h3>
        <div class="field-row">
          <div class="field"><label>Мин. сумма для доставки, ₾</label><input name="min_delivery_amount" type="number" step="1" value="${esc(s.min_delivery_amount)}"/></div>
          <div class="field"><label>Время смены тарифа</label><input name="delivery_day_end" value="${esc(s.delivery_day_end)}" placeholder="22:00"/></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Дневной тариф, ₾</label><input name="delivery_fee_day" type="number" step="1" value="${esc(s.delivery_fee_day)}"/></div>
          <div class="field"><label>Ночной тариф, ₾</label><input name="delivery_fee_night" type="number" step="1" value="${esc(s.delivery_fee_night)}"/></div>
        </div>
        <div class="field"><label>Лимит доставок на 1 слот (2 часа)</label><input name="slot_capacity" type="number" step="1" min="1" value="${esc(s.slot_capacity)}"/></div>
        <div class="cr-meta" style="margin:-4px 0 10px;">Заказ меньше мин. суммы — только самовывоз. Дневной тариф — до «времени смены», ночной — после (приём до 00:00). Доставка только по Батуми. Когда лимит на слот исчерпан — это время исчезает у клиента.</div>

        <h3 class="settings-group">Контакты</h3>
        <div class="field"><label>Телефон</label><input name="shop_phone" value="${esc(s.shop_phone)}" placeholder="+995 5xx xx xx xx"/></div>
        <div class="field"><label>Instagram (ник без @)</label><input name="shop_instagram" value="${esc(s.shop_instagram)}" placeholder="flowers_batum_flower"/></div>

        <h3 class="settings-group">Тексты витрины</h3>
        <div class="field"><label>Экспресс-доставка (срок)</label><input name="express_delivery_text" value="${esc(s.express_delivery_text)}" placeholder="в течение часа"/></div>
        <div class="field"><label>Сноска про живые цветы</label><textarea name="disclaimer_note" rows="3">${esc(s.disclaimer_note)}</textarea></div>
        <div class="field"><label>Раздел «Доставка и оплата»</label><textarea name="delivery_payment_info" rows="3">${esc(s.delivery_payment_info)}</textarea></div>

        <h3 class="settings-group">Уведомления</h3>
        <div class="field">
          <label>Chat ID для уведомлений о заказах</label>
          <input name="staff_chat_id" value="${esc(s.staff_chat_id)}" placeholder="напр. -1001234567890 (группа) или ваш ID"/>
          <div class="cr-meta" style="margin-top:6px;">
            ${usingEnv
              ? `Сейчас используется значение по умолчанию: <b>${esc(s.staff_chat_id_effective)}</b>. Оставьте пустым, чтобы не менять.`
              : "Куда бот шлёт новые заказы. Для группы добавьте бота в неё и укажите её ID (начинается с −100)."}
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary btn-block">Сохранить настройки</button>
        </div>
      </form>
    </div>
  `;
  el("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      state.settings = await apiFetch("/api/admin/settings", {
        method: "PUT",
        body: {
          staff_chat_id: fd.get("staff_chat_id"),
          shop_name: fd.get("shop_name"),
          shop_address: fd.get("shop_address"),
          min_delivery_amount: fd.get("min_delivery_amount"),
          delivery_fee_day: fd.get("delivery_fee_day"),
          delivery_fee_night: fd.get("delivery_fee_night"),
          delivery_day_end: fd.get("delivery_day_end"),
          slot_capacity: fd.get("slot_capacity"),
          shop_phone: fd.get("shop_phone"),
          shop_instagram: fd.get("shop_instagram"),
          express_delivery_text: fd.get("express_delivery_text"),
          disclaimer_note: fd.get("disclaimer_note"),
          delivery_payment_info: fd.get("delivery_payment_info"),
        },
        tg,
      });
      showToast("Настройки сохранены");
      renderSettings();
    } catch (err) {
      showToast("Не удалось сохранить настройки");
    }
  });
}

// --- Продажи (только владелец): вкладка со списком выполненных заказов и
// общей суммой внизу. Период день/месяц. ---
// Текущая дата Батуми (UTC+4): {day:"YYYY-MM-DD", month:"YYYY-MM"}.
function batumiParts() {
  const now = new Date();
  const b = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 4 * 3600000);
  const y = b.getFullYear();
  const m = String(b.getMonth() + 1).padStart(2, "0");
  const d = String(b.getDate()).padStart(2, "0");
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}
// Дата заказа для фильтра: сначала delivered_at (Батуми), иначе created_at (UTC).
function orderDateKey(o) {
  return String(o.delivered_at || o.created_at || "").slice(0, 10);
}

function renderSalesTabs() {
  el("sales-period-tabs").innerHTML = [["day", "День"], ["month", "Месяц"]]
    .map(([v, l]) => `<button class="tab ${state.salesPeriod === v ? "active" : ""}" data-period="${v}">${l}</button>`)
    .join("");
  el("sales-period-tabs").querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => { state.salesPeriod = b.dataset.period; renderSalesTabs(); renderSales(); })
  );
}

async function renderSales() {
  renderSalesTabs();
  const listWrap = el("sales-list");
  const totalWrap = el("sales-total");
  let orders;
  try {
    orders = await apiFetch(`/api/admin/orders?status=delivered&location_id=${LOCATION_ID}`, { tg });
  } catch {
    listWrap.innerHTML = `<div class="empty-state">Не удалось загрузить продажи</div>`;
    totalWrap.innerHTML = "";
    return;
  }
  const parts = batumiParts();
  const period = state.salesPeriod;
  const keyLen = period === "month" ? 7 : 10;
  const want = period === "month" ? parts.month : parts.day;
  const list = orders.filter((o) => orderDateKey(o).slice(0, keyLen) === want);
  state.salesOrders = list;

  if (!list.length) {
    listWrap.innerHTML = `<div class="empty-state">За ${period === "month" ? "месяц" : "день"} выполненных заказов нет</div>`;
  } else {
    listWrap.innerHTML = list
      .map((o) => {
        const thumb = o.items.find((i) => i.photo_url)?.photo_url;
        const names = o.items.map((i) => `${i.product_name}${i.variant_label ? ` (${i.variant_label})` : ""} ×${i.quantity}`).join(", ");
        const when = o.delivered_at || o.delivery_date || "";
        return `
    <div class="card sale-card" data-sale="${o.id}">
      ${thumb ? `<img class="order-thumb" src="${thumb}" alt=""/>` : `<div class="order-thumb"></div>`}
      <div class="sale-info">
        <div class="sale-title">Заказ №${o.id}${when ? ` · ${when}` : ""}</div>
        <div class="sale-items">${names}</div>
      </div>
      <div class="order-total">${money(o.total)}</div>
    </div>`;
      })
      .join("");
    listWrap.querySelectorAll("[data-sale]").forEach((c) =>
      c.addEventListener("click", () => {
        const o = state.salesOrders.find((x) => x.id === Number(c.dataset.sale));
        if (o) renderOrderDetail(o);
      })
    );
  }

  const totalSum = list.reduce((s, o) => s + (o.total || 0), 0);
  const bouquets = list.reduce((s, o) => s + o.items.reduce((n, i) => n + i.quantity, 0), 0);
  totalWrap.innerHTML = `
    <div class="sales-total-inner">
      <div><span class="st-count">${list.length}</span> заказов · ${bouquets} букетов</div>
      <div class="st-sum">${money(totalSum)}</div>
    </div>`;
}

// ---------------------------------------------------------------------
async function init() {
  try {
    state.staff = await apiFetch("/api/admin/me", { tg });
  } catch (err) {
    el("access-denied").style.display = "block";
    return;
  }
  el("staff-label").textContent = `${state.staff.name} · ${roleLabel(state.staff.role)}`;
  el("admin-main").style.display = "block";
  el("bottom-nav").style.display = "flex";

  // Заказы доступны и владельцу, и флористу.
  renderOrderTabs();
  await loadOrders();
  renderOrders();

  if (isOwner()) {
    // Владелец: каталог, склад, настройки, продажи.
    el("nav-settings").style.display = "flex";
    el("nav-sales").style.display = "flex";
    try {
      await loadCategories();
      await Promise.all([loadProducts(), loadStock(), loadStaffList(), loadSettings()]);
      renderCatalog();
      renderStock();
      renderCategoriesAdmin();
      renderStaffAdmin();
      renderSettings();
      renderSales();
    } catch (err) {
      // часть разделов может остаться пустой, заказы всё равно работают
    }
  } else {
    // Флорист: только заказы — прячем вкладки Каталог и Склад.
    document
      .querySelectorAll('.nav-btn[data-view="catalog"], .nav-btn[data-view="stock"]')
      .forEach((b) => (b.style.display = "none"));
  }
}
init();
