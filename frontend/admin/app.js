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
  couriers: [],
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
    if (state.view === "sales" && !isCourier()) renderSales();
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
async function loadCouriers() {
  state.couriers = await apiFetch("/api/admin/couriers", { tg });
}

function renderOrders() {
  if (isCourier()) return renderCourierOrders();
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
        ${o.assigned_courier_name ? `<br/>🛵 Курьер: ${o.assigned_courier_name}` : ""}
        ${times ? `<br/><span class="order-times">${times}</span>` : ""}
      </div>
      ${(o.status === "new" || o.status === "assembling")
        ? `<button class="btn btn-block btn-assembled" data-assembled="${o.id}">✅ Букет собран</button>` : ""}
      <select class="status-select" data-order-id="${o.id}">
        ${Object.entries(STATUS_LABELS).map(([val, label]) => `<option value="${val}" ${o.status === val ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>`;
      }
    )
    .join("");

  wrap.querySelectorAll("[data-assembled]").forEach((b) => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await apiFetch(`/api/admin/orders/${b.dataset.assembled}/status`, {
          method: "PUT", body: { status: "assembled" }, tg,
        });
        showToast("Отмечено «Собран»");
        await loadOrders();
        renderOrders();
      } catch (err) {
        showToast(err?.data?.detail || "Не удалось отметить");
      }
    });
  });

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

// Экран курьера: только его доставки, кнопка «Доставлено».
function renderCourierOrders() {
  const wrap = el("orders-list");
  const active = state.orders.filter((o) => o.status !== "delivered" && o.status !== "cancelled");
  const done = state.orders.filter((o) => o.status === "delivered");
  if (!state.orders.length) {
    wrap.innerHTML = `<div class="empty-state">Вам пока не назначены доставки</div>`;
    return;
  }
  const card = (o, isDone) => {
    const addr = o.fulfillment_type === "delivery" ? (o.address || "—") : "Самовывоз";
    const when = [o.delivery_date || "", o.delivery_slot || ""].filter(Boolean).join(" ");
    const phone = o.recipient_phone || o.customer_phone || "";
    return `
    <div class="card order-card">
      <div class="order-card-top">
        <div class="order-id">Заказ №${o.id}</div>
        <div class="order-total">${money(o.total)}</div>
      </div>
      <div class="order-meta">
        📍 ${addr}${when ? `<br/>🕒 ${when}` : ""}
        ${phone ? `<br/>📞 <a href="tel:${phone}">${phone}</a>` : ""}<br/>
        ${o.items.map((i) => `${i.product_name} ×${i.quantity}`).join(", ")}
        ${o.card_message ? `<br/>Открытка: «${o.card_message}»` : ""}
      </div>
      ${isDone ? "" : (
        o.status === "assembled" ? `<div class="ready-badge ready-yes">✅ Собран — можно забирать</div>`
        : o.status === "out_for_delivery" ? `<div class="ready-badge ready-go">🚚 В доставке</div>`
        : `<div class="ready-badge ready-wait">⏳ Собирается</div>`)}
      ${isDone
        ? `<div class="courier-done">✓ Доставлено${o.delivered_at ? ` · ${o.delivered_at}` : ""}</div>`
        : `<button class="btn btn-primary btn-block" data-deliver="${o.id}">Доставлено</button>`}
    </div>`;
  };
  wrap.innerHTML =
    (active.length ? active.map((o) => card(o, false)).join("") : `<div class="empty-state">Активных доставок нет</div>`) +
    (done.length ? `<div class="admin-section-head"><h2>Выполненные</h2></div>` + done.map((o) => card(o, true)).join("") : "");
  wrap.querySelectorAll("[data-deliver]").forEach((b) =>
    b.addEventListener("click", () => deliverOrder(Number(b.dataset.deliver)))
  );
}

function deliverOrder(orderId) {
  tg.showConfirm("Отметить заказ как доставленный?", async (ok) => {
    if (!ok) return;
    try {
      await apiFetch(`/api/admin/orders/${orderId}/status`, {
        method: "PUT", body: { status: "delivered" }, tg,
      });
      showToast("Отмечено «Доставлено»");
      await loadOrders();
      renderOrders();
    } catch (err) {
      showToast(err?.data?.detail || "Не удалось отметить");
    }
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
      Оплата: ${PAY_LABELS[o.payment_method] || "не указана"}
    </div>
    ${o.items.map((i) => `<div class="cart-line">
        ${i.photo_url ? `<img class="order-thumb" src="${i.photo_url}" alt=""/>` : ""}
        <div class="cl-info"><div class="cl-name">${i.product_name}</div><div class="cl-variant">${i.variant_label} ×${i.quantity}</div></div>
        <div class="cl-price">${money(i.price * i.quantity)}</div></div>`).join("")}
    ${o.delivery_fee ? `<div class="cart-line"><div class="cl-info"><div class="cl-name">Доставка</div></div><div class="cl-price">${money(o.delivery_fee)}</div></div>` : ""}
    <div class="cart-total"><span>Итого</span><span>${money(o.total)}</span></div>
    ${timeRows.length ? `<div class="order-meta" style="margin-top:12px;">${timeRows.map(([l, v]) => `${l}: ${v}`).join("<br/>")}</div>` : ""}
    ${!isCourier() ? `
    <div class="assign-box">
      <label>Курьер</label>
      <div class="assign-row">
        <select id="assign-courier">
          <option value="">— не назначен —</option>
          ${state.couriers.map((c) => `<option value="${c.id}" ${o.assigned_staff_id === c.id ? "selected" : ""}>${c.name}</option>`).join("")}
        </select>
        <button class="btn btn-outline btn-sm" id="assign-btn">Назначить</button>
      </div>
      ${state.couriers.length ? "" : `<div class="cr-meta" style="margin-top:6px;">Курьеров пока нет${isOwner() ? " — добавьте в разделе Персонал (роль «Курьер»)" : ""}.</div>`}
    </div>
    <div class="assign-box">
      <label>Способ оплаты (для кассы)</label>
      <div class="seg" id="order-pay">
        ${[["cash", "Нал"], ["card", "Карта"], ["transfer", "Перевод"]].map(([v, l]) =>
          `<button type="button" class="seg-btn ${o.payment_method === v ? "active" : ""}" data-pay="${v}">${l}</button>`).join("")}
      </div>
    </div>` : ""}
  `;
  const payBox = el("order-pay");
  if (payBox) {
    payBox.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", async () => {
      const pm = b.dataset.pay;
      payBox.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      try {
        await apiFetch(`/api/admin/orders/${o.id}/payment`, { method: "PUT", body: { payment_method: pm }, tg });
        o.payment_method = pm;
        showToast("Оплата отмечена");
      } catch { showToast("Не удалось сохранить оплату"); }
    }));
  }
  const assignBtn = el("assign-btn");
  if (assignBtn) {
    assignBtn.addEventListener("click", async () => {
      const cid = el("assign-courier").value;
      try {
        await apiFetch(`/api/admin/orders/${o.id}/assign`, {
          method: "PUT", body: { courier_id: cid ? Number(cid) : null }, tg,
        });
        showToast(cid ? "Курьер назначен" : "Курьер снят");
        closeSheet("order-detail");
        await loadOrders();
        renderOrders();
      } catch (err) {
        showToast(err?.data?.detail || "Не удалось назначить курьера");
      }
    });
  }
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

function productHasStock(p) {
  if (p.track_stock) return true;
  if ((p.recipe || []).length) return true;
  return (p.variants || []).some((v) => (v.recipe || []).length);
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
    <div class="card catalog-row" data-row="${p.id}">
      <button class="cr-drag" data-drag="${p.id}" aria-label="Переместить" title="Перетащить">⠿</button>
      <img src="${p.photo_url}" alt=""/>
      <div class="cr-info">
        <div class="cr-name">${p.name}${badgeRu(p.badge) ? ` <span class="badge badge-rose">${badgeRu(p.badge)}</span>` : ""}</div>
        <div class="cr-meta">${p.variants.map((v) => money(v.price)).join(" / ") || "без цены"} · ${statusLabelRu(p.status)}${productHasStock(p) ? "" : ` · <span class="cr-nostock">без склада</span>`}</div>
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
  wrap.querySelectorAll(".cr-drag").forEach((h) => h.addEventListener("pointerdown", (e) => startCatalogDrag(e, wrap)));
}

// Перетаскивание товаров за ручку ⠿. Общий порядок сохраняется на сервере и
// отражается на витрине. Реализация на Pointer Events без библиотек: место
// вставки считаем по геометрии соседних карточек (надёжно на тач, без хаков
// с pointer-events/elementFromPoint).
function startCatalogDrag(e, wrap) {
  e.preventDefault();
  const dragEl = e.target.closest(".catalog-row");
  if (!dragEl) return;

  // Схватили карточку: запоминаем её геометрию и точку захвата внутри неё.
  const rect = dragEl.getBoundingClientRect();
  const grabY = e.clientY - rect.top;
  tg.HapticFeedback?.impactOccurred?.("light");

  // Плейсхолдер держит место карточки в потоке (показывает целевой слот), пока
  // сама карточка «летит» за пальцем в position: fixed.
  const ph = document.createElement("div");
  ph.className = "catalog-row-ph";
  ph.style.height = rect.height + "px";
  dragEl.parentNode.insertBefore(ph, dragEl);

  dragEl.classList.add("dragging");
  dragEl.style.width = rect.width + "px";
  dragEl.style.left = rect.left + "px";
  dragEl.style.top = (e.clientY - grabY) + "px";

  const rowAfter = (y) => {
    const rows = [...wrap.querySelectorAll(".catalog-row:not(.dragging)")];
    let closest = { offset: -Infinity, el: null };
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      const offset = y - (box.top + box.height / 2);
      if (offset < 0 && offset > closest.offset) closest = { offset, el: row };
    }
    return closest.el;
  };

  const onMove = (ev) => {
    ev.preventDefault();
    dragEl.style.top = (ev.clientY - grabY) + "px";   // карточка следует за пальцем 1:1
    const after = rowAfter(ev.clientY);
    if (after == null) wrap.appendChild(ph);
    else if (after !== ph.nextSibling) wrap.insertBefore(ph, after);
    // Лёгкий автоскролл у краёв экрана.
    const m = 90;
    if (ev.clientY < m) window.scrollBy(0, -14);
    else if (ev.clientY > window.innerHeight - m) window.scrollBy(0, 14);
  };

  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    // Возвращаем карточку в поток на место плейсхолдера.
    wrap.insertBefore(dragEl, ph);
    ph.remove();
    dragEl.classList.remove("dragging");
    dragEl.style.width = dragEl.style.left = dragEl.style.top = "";
    const order = [...wrap.querySelectorAll(".catalog-row")].map((r) => Number(r.dataset.row));
    // Пересобираем state.products в новом порядке (чтобы будущие ре-рендеры совпадали).
    const byId = new Map(state.products.map((p) => [p.id, p]));
    state.products = order.map((id) => byId.get(id)).filter(Boolean);
    try {
      await apiFetch("/api/admin/products/reorder", { method: "POST", body: { order }, tg });
    } catch (err) {
      showToast("Не удалось сохранить порядок");
      renderCatalog();
    }
  };

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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

function flowerOptionsHtml(selValue) {
  const stock = state.stock || [];
  const groups = [...new Set(stock.map((s) => (s.flower_type || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const flowers = [...stock].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
  let opts = `<option value="">— выберите позицию/группу —</option>`;
  if (groups.length) {
    opts += `<optgroup label="Группы (замена)">` + groups.map((g) => `<option value="g:${_q(g)}" ${selValue === `g:${g}` ? "selected" : ""}>Группа: ${g}</option>`).join("") + `</optgroup>`;
  }
  opts += `<optgroup label="Позиции склада">` + flowers.map((f) => `<option value="f:${f.id}" ${selValue === `f:${f.id}` ? "selected" : ""}>${f.name}</option>`).join("") + `</optgroup>`;
  return opts;
}

function addRecipeRow(box, data = { value: "", qty: "" }) {
  const rr = document.createElement("div");
  rr.className = "recipe-row";
  rr.innerHTML = `
    <select class="rr-target">${flowerOptionsHtml(data.value)}</select>
    <input class="rr-qty" type="number" min="1" step="1" placeholder="шт" value="${data.qty ?? ""}"/>
    <button type="button" class="btn-icon rr-remove" aria-label="Убрать">✕</button>`;
  rr.querySelector(".rr-remove").addEventListener("click", () => rr.remove());
  box.appendChild(rr);
}

async function openProductEdit(productId) {
  if (!(state.stock && state.stock.length)) { try { await loadStock(); } catch {} }
  const p = productId ? state.products.find((x) => x.id === productId) : null;
  const variants = p && p.variants.length ? p.variants : [{ label: "", price: "", recipe: [] }];
  // Отмеченные категории: у товара — из его списка (fallback на старую одиночную);
  // у нового — первая категория по умолчанию (чтобы не забыть выбрать).
  const catChecked = p
    ? (p.category_ids && p.category_ids.length ? p.category_ids : (p.category_id != null ? [p.category_id] : []))
    : (state.categories[0] ? [state.categories[0].id] : []);

  el("product-edit-content").innerHTML = `
    <h2>${p ? "Редактировать товар" : "Новый товар"}</h2>
    <form id="product-form">
      <div class="field"><label>Название</label><input name="name" required value="${p?.name || ""}"/></div>
      <div class="field"><label>Категории (можно несколько)</label>
        <div style="display:flex; flex-wrap:wrap; gap:8px 14px;">
          ${state.categories.map((c) => `<label class="chk"><input type="checkbox" name="category_ids" value="${c.id}" ${catChecked.includes(c.id) ? "checked" : ""}/><span>${c.name}</span></label>`).join("")}
        </div>
      </div>
      <div class="field"><label>Описание</label><textarea name="description" rows="2">${p?.description || ""}</textarea></div>
      <div class="field"><label>Состав (текст для клиента)</label><input name="composition" value="${p?.composition || ""}"/></div>
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
      <label class="checkbox-row" style="margin:2px 0 8px;">
        <input type="checkbox" name="is_addon" ${p?.is_addon ? "checked" : ""}/>
        <span>Показывать как доп-товар («Добавьте к заказу»)</span>
      </label>
      <label class="checkbox-row" style="margin:2px 0 8px;">
        <input type="checkbox" name="price_on_request" ${p?.price_on_request ? "checked" : ""}/>
        <span>Стоимость по запросу (вместо «в корзину» — «Уточнить у менеджера»)</span>
      </label>
      <label class="checkbox-row" style="margin:2px 0 8px;">
        <input type="checkbox" name="track_stock" id="track-stock-toggle" ${p?.track_stock ? "checked" : ""}/>
        <span>Штучный товар — свой остаток (шары, вазы, сладости)</span>
      </label>
      <div class="field" id="simple-stock-field" style="display:none;"><label>Остаток на складе (шт)</label><input name="stock_qty" type="number" step="1" min="0" value="${p?.stock_qty ?? 0}"/></div>
      <div class="field"><label>Фото</label><input type="file" name="photo" accept="image/*"/></div>
      <div class="field">
        <label>Размеры, цены и рецепт (для склада)</label>
        <div id="variant-editor"></div>
        <button type="button" class="btn btn-outline btn-sm" id="add-variant-row">+ размер</button>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" id="preview-product">Превью</button>
        <button type="button" class="btn btn-secondary" data-close="product-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
  `;

  const variantEditor = el("variant-editor");
  function addVariantRow(v = { label: "", price: "", recipe: [] }) {
    const row = document.createElement("div");
    row.className = "variant-editor-row";
    row.innerHTML = `
      <div class="ver-top">
        <input placeholder="Например: S — 11 роз" class="v-label" value="${_q(v.label)}"/>
        <input placeholder="Цена" type="number" step="0.01" class="v-price" value="${v.price ?? ""}"/>
        <button type="button" class="btn-icon" data-remove-row aria-label="Убрать размер">✕</button>
      </div>
      <div class="ver-recipe">
        <div class="ver-recipe-head"><span>Из чего собран</span><button type="button" class="v-copy-recipe">скопировать с размера</button></div>
        <div class="recipe-rows"></div>
        <button type="button" class="btn btn-outline btn-sm v-add-ingredient">+ ингредиент</button>
      </div>`;
    const rrBox = row.querySelector(".recipe-rows");
    row.querySelector("[data-remove-row]").addEventListener("click", () => row.remove());
    row.querySelector(".v-add-ingredient").addEventListener("click", () => addRecipeRow(rrBox));
    row.querySelector(".v-copy-recipe").addEventListener("click", () => {
      let best = null, bestN = 0;
      variantEditor.querySelectorAll(".variant-editor-row").forEach((other) => {
        if (other === row) return;
        const n = other.querySelectorAll(".recipe-row").length;
        if (n > bestN) { bestN = n; best = other; }
      });
      if (!best) { showToast("Нет рецепта для копирования"); return; }
      rrBox.innerHTML = "";
      best.querySelectorAll(".recipe-row").forEach((rr) => addRecipeRow(rrBox, {
        value: rr.querySelector(".rr-target").value, qty: rr.querySelector(".rr-qty").value,
      }));
    });
    (v.recipe || []).forEach((ln) => {
      const value = ln.flower_stock_id ? `f:${ln.flower_stock_id}` : (ln.flower_type ? `g:${ln.flower_type}` : "");
      addRecipeRow(rrBox, { value, qty: ln.quantity_needed });
    });
    variantEditor.appendChild(row);
  }
  variants.forEach((v) => addVariantRow(v));
  const trackToggle = el("track-stock-toggle");
  function applyTrackMode() {
    const on = trackToggle.checked;
    el("simple-stock-field").style.display = on ? "" : "none";
    variantEditor.querySelectorAll(".ver-recipe").forEach((r) => { r.style.display = on ? "none" : ""; });
  }
  trackToggle.addEventListener("change", applyTrackMode);
  el("add-variant-row").addEventListener("click", () => { addVariantRow(); applyTrackMode(); });
  applyTrackMode();
  document.querySelectorAll("#product-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("product-edit")));
  el("preview-product").addEventListener("click", () => previewProduct(formToProduct(variantEditor, p)));

  el("product-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const catIds = fd.getAll("category_ids").map(Number).filter((n) => Number.isFinite(n));
    if (!catIds.length) { showToast("Выберите хотя бы одну категорию"); return; }
    const variantRows = [...variantEditor.querySelectorAll(".variant-editor-row")]
      .map((row) => ({
        label: row.querySelector(".v-label").value,
        price: parseFloat(row.querySelector(".v-price").value) || 0,
        recipe: [...row.querySelectorAll(".recipe-row")].map((rr) => {
          const val = rr.querySelector(".rr-target").value;
          const qty = parseFloat(rr.querySelector(".rr-qty").value) || 0;
          if (!val || qty <= 0) return null;
          if (val.startsWith("f:")) return { flower_stock_id: Number(val.slice(2)), quantity_needed: qty };
          if (val.startsWith("g:")) return { flower_type: val.slice(2), quantity_needed: qty };
          return null;
        }).filter(Boolean),
      }))
      .filter((v) => v.label);

    const body = {
      location_id: LOCATION_ID,
      category_ids: catIds,
      name: fd.get("name"),
      description: fd.get("description"),
      composition: fd.get("composition"),
      status: fd.get("status"),
      occasion_tags: fd.get("occasion_tags").split(",").map((s) => s.trim()).filter(Boolean),
      is_addon: fd.get("is_addon") ? 1 : 0,
      badge: fd.get("badge") || "",
      track_stock: fd.get("track_stock") ? 1 : 0,
      stock_qty: parseFloat(fd.get("stock_qty")) || 0,
      price_on_request: fd.get("price_on_request") ? 1 : 0,
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

const stockCollapsed = new Set(); // свёрнутые группы (по названию)
let stockSearch = "";
let stockSort = "name"; // name | date (по дате последней поставки, свежие сверху)

function _num(n) { const x = Number(n) || 0; return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100); }
function _stockGroup(s) { return (s.flower_type || "").trim() || "Без группы"; }
function _q(str) { return String(str == null ? "" : str).replace(/"/g, "&quot;"); }
function _fmtDM(d) { return d ? d.slice(8, 10) + "." + d.slice(5, 7) : ""; }

// Плашка свежести: цвет по возрасту последней поставки (🟢≤3 / 🟡4–6 / 🔴7+),
// ★ если ещё лежит предыдущая партия, клик — переворот на дату предыдущей.
function freshBadgeHtml(s) {
  if (!s.fresh_last) return "";
  const age = s.fresh_age;
  const cls = age == null ? "fb-mid" : age <= 3 ? "fb-fresh" : age >= 7 ? "fb-old" : "fb-mid";
  const star = s.fresh_star ? '<span class="fb-star">★</span>' : "";
  const back = s.fresh_prev
    ? `Пред. ${_fmtDM(s.fresh_prev)}${s.fresh_prev_age != null ? " · " + s.fresh_prev_age + " дн" : ""}`
    : "одна поставка";
  return `<button type="button" class="fresh-badge ${cls}">
      <span class="fb-front">${star}Получена ${_fmtDM(s.fresh_last)}</span>
      <span class="fb-back">${back}</span></button>`;
}

function stockRowHtml(s) {
  const low = s.quantity <= s.low_stock_threshold;
  const img = s.photo_url ? `<img src="${s.photo_url}" alt=""/>` : `<span class="ph">🌸</span>`;
  return `
    <div class="stock-row card ${low ? "low" : ""}" data-stock="${s.id}">
      <div class="stock-thumb">${img}</div>
      <div class="stock-row-main">
        <div class="stock-name">${s.name}${low ? ' <span class="badge badge-rose">мало</span>' : ""}</div>
        <div class="stock-meta">${s.supplier || "поставщик не указан"}</div>
        ${freshBadgeHtml(s)}
      </div>
      <div class="stock-qty ${low ? "low" : ""}">${_num(s.quantity)} ${s.unit}</div>
    </div>`;
}

function renderStock() {
  const wrap = el("stock-list");
  wrap.innerHTML = `
    <div class="stock-toolbar">
      <input id="stock-search" placeholder="Поиск цветка…"/>
      <button class="btn btn-outline btn-sm" id="stock-sort">${stockSort === "date" ? "▾ по дате" : "▾ по названию"}</button>
      <button class="btn btn-primary btn-sm" id="open-intake">Приёмка</button>
    </div>
    <div id="stock-groups"></div>`;
  const search = el("stock-search");
  search.value = stockSearch;
  search.addEventListener("input", () => { stockSearch = search.value; renderStockGroups(); });
  el("stock-sort").addEventListener("click", () => {
    stockSort = stockSort === "date" ? "name" : "date";
    el("stock-sort").textContent = stockSort === "date" ? "▾ по дате" : "▾ по названию";
    renderStockGroups();
  });
  el("open-intake").addEventListener("click", openIntake);
  renderStockGroups();
}

function renderStockGroups() {
  const box = el("stock-groups");
  const q = stockSearch.trim().toLowerCase();
  if (!state.stock.length) { box.innerHTML = `<div class="empty-state">Склад пуст</div>`; return; }
  // По дате поставки: плоский список, самые залежавшиеся (большой возраст) сверху;
  // без даты — в конце. По названию — привычные группы-«жалюзи».
  const byAgeDesc = (a, b) => {
    const av = a.fresh_age == null ? -1 : a.fresh_age, bv = b.fresh_age == null ? -1 : b.fresh_age;
    return bv - av || (a.name || "").localeCompare(b.name || "", "ru");
  };
  let html;
  if (q) {
    const found = state.stock
      .filter((s) => (s.name || "").toLowerCase().includes(q) || (s.flower_type || "").toLowerCase().includes(q))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
    html = found.length ? found.map(stockRowHtml).join("") : `<div class="empty-state">Ничего не найдено</div>`;
  } else if (stockSort === "date") {
    html = [...state.stock].sort(byAgeDesc).map(stockRowHtml).join("");
  } else {
    const groups = {};
    state.stock.forEach((s) => { (groups[_stockGroup(s)] ||= []).push(s); });
    html = Object.keys(groups).sort((a, b) => a.localeCompare(b, "ru")).map((g) => {
      const rows = groups[g].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
      const collapsed = stockCollapsed.has(g);
      return `
        <div class="stock-group ${collapsed ? "collapsed" : ""}">
          <button class="stock-group-head" data-group="${_q(g)}" type="button">
            <span>${g} <span class="cnt">${rows.length}</span></span><span class="chev">▾</span>
          </button>
          <div class="stock-group-body">${rows.map(stockRowHtml).join("")}</div>
        </div>`;
    }).join("");
  }
  box.innerHTML = html;
  box.querySelectorAll(".stock-group-head").forEach((h) => h.addEventListener("click", () => {
    const g = h.dataset.group;
    if (stockCollapsed.has(g)) stockCollapsed.delete(g); else stockCollapsed.add(g);
    renderStockGroups();
  }));
  box.querySelectorAll(".fresh-badge").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); b.classList.toggle("flip");
  }));
  box.querySelectorAll("[data-stock]").forEach((r) => r.addEventListener("click", () => openStockItem(Number(r.dataset.stock))));
}

function openStockItem(id) {
  const s = id ? state.stock.find((x) => x.id === id) : null;
  const v = (k, d = "") => (s && s[k] != null ? s[k] : d);
  el("stock-action-content").innerHTML = `
    <h2>${s ? "Цветок: " + s.name : "Новая позиция"}</h2>
    <form id="stock-item-form">
      ${s && s.photo_url ? `<img class="stock-edit-photo" src="${s.photo_url}" alt=""/>` : ""}
      <div class="field"><label>Фото</label><input type="file" name="photo" accept="image/*"/></div>
      <div class="field"><label>Название</label><input name="name" required value="${_q(v("name"))}" placeholder="Бомбастик, красная"/></div>
      <div class="field-row">
        <div class="field"><label>Группа / тип</label><input name="flower_type" value="${_q(v("flower_type"))}" placeholder="Розы"/></div>
        <div class="field"><label>Ед. изм.</label><input name="unit" value="${_q(v("unit", "шт"))}"/></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Штук в пачке</label><input name="pack_size" type="number" step="1" min="0" value="${v("pack_size", 0)}"/></div>
        <div class="field"><label>Порог «мало»</label><input name="low_stock_threshold" type="number" step="1" min="0" value="${v("low_stock_threshold", 10)}"/></div>
      </div>
      <div class="field"><label>Поставщик</label><input name="supplier" value="${_q(v("supplier"))}"/></div>
      ${!s ? `<div class="field"><label>Начальный остаток (шт)</label><input name="quantity" type="number" step="1" value="0"/></div>` : ""}
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="stock-action">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form>
    ${s ? `
      <div class="stock-adjust">
        <div class="stock-adjust-title">Остаток: <b id="si-qty">${_num(s.quantity)} ${s.unit}</b></div>
        <div class="field-row">
          <div class="field"><label>Кол-во</label><input id="si-adj-qty" type="number" step="1" min="0" placeholder="0"/></div>
          <div class="field"><label>Комментарий</label><input id="si-adj-note" placeholder="напр. увяли"/></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-outline btn-sm" id="si-income">+ Приход</button>
          <button type="button" class="btn btn-outline btn-sm" id="si-writeoff">− Списать</button>
        </div>
        <button type="button" class="btn btn-danger btn-block" id="si-delete" style="margin-top:12px;">Удалить позицию</button>
      </div>` : ""}
  `;
  document.querySelectorAll("#stock-action-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("stock-action")));

  el("stock-item-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get("name"), flower_type: fd.get("flower_type") || "", unit: fd.get("unit") || "шт",
      pack_size: parseFloat(fd.get("pack_size")) || 0,
      low_stock_threshold: parseFloat(fd.get("low_stock_threshold")) || 0,
      supplier: fd.get("supplier") || "",
    };
    try {
      let saved;
      if (s) {
        saved = await apiFetch(`/api/admin/stock/${s.id}`, { method: "PUT", body, tg });
      } else {
        body.location_id = LOCATION_ID;
        body.quantity = parseFloat(fd.get("quantity")) || 0;
        saved = await apiFetch("/api/admin/stock", { method: "POST", body, tg });
      }
      const photoFile = fd.get("photo");
      if (photoFile && photoFile.size > 0) {
        const pf = new FormData(); pf.append("photo", photoFile);
        await fetch(`/api/admin/stock/${saved.id}/photo`, { method: "POST", headers: { "X-Telegram-Init-Data": tg.initData }, body: pf });
      }
      showToast("Сохранено");
      closeSheet("stock-action");
      await loadStock(); renderStock();
    } catch { showToast("Не удалось сохранить"); }
  });

  if (s) {
    const adjust = async (type) => {
      const qty = parseFloat(el("si-adj-qty").value);
      if (!qty || qty <= 0) { showToast("Укажите количество"); return; }
      try {
        const upd = await apiFetch(`/api/admin/stock/${s.id}/${type}`, {
          method: "POST", body: { quantity: qty, note: el("si-adj-note").value || (type === "income" ? "приход" : "списание") }, tg,
        });
        el("si-qty").textContent = `${_num(upd.quantity)} ${upd.unit}`;
        el("si-adj-qty").value = "";
        showToast("Склад обновлён");
        await loadStock();
      } catch { showToast("Не удалось обновить"); }
    };
    el("si-income").addEventListener("click", () => adjust("income"));
    el("si-writeoff").addEventListener("click", () => adjust("writeoff"));
    el("si-delete").addEventListener("click", () => {
      const doDel = async () => {
        try {
          await apiFetch(`/api/admin/stock/${s.id}`, { method: "DELETE", tg });
          showToast("Удалено"); closeSheet("stock-action"); await loadStock(); renderStock();
        } catch (err) { showToast(err?.data?.detail || "Не удалось удалить"); }
      };
      if (tg.showConfirm) tg.showConfirm(`Удалить «${s.name}» со склада?`, (ok) => { if (ok) doDel(); });
      else doDel();
    });
  }
  openSheet("stock-action");
}

el("add-stock-btn").addEventListener("click", () => openStockItem(null));

// --- Приёмка: массовый приход по калькулятору пачек ---
function intakeRowHtml(s) {
  return `
    <div class="intake-row" data-flower="${s.id}">
      <div class="intake-row-head">
        <span class="intake-name">${s.name}</span>
        <span class="intake-current">склад: ${_num(s.quantity)} ${s.unit}</span>
      </div>
      <div class="intake-batches">
        <div class="intake-batch">
          <input class="ib-packs" type="number" min="0" step="1" placeholder="пачек"/><span>×</span>
          <input class="ib-size" type="number" min="0" step="1" placeholder="шт/пачка" value="${s.pack_size || ""}"/>
        </div>
      </div>
      <div class="intake-row-foot">
        <button type="button" class="intake-addbatch">+ пачки другого размера</button>
        <label class="intake-direct">+ штук<input class="ib-direct" type="number" min="0" step="1" placeholder="0"/></label>
        <span class="intake-total">= <b>0</b> шт</span>
      </div>
    </div>`;
}

function openIntake() {
  const groups = {};
  state.stock.forEach((s) => { (groups[_stockGroup(s)] ||= []).push(s); });
  const groupHtml = Object.keys(groups).sort((a, b) => a.localeCompare(b, "ru")).map((g) => {
    const rows = groups[g].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru")).map(intakeRowHtml).join("");
    return `
      <div class="stock-group collapsed">
        <button class="stock-group-head" type="button"><span>${g} <span class="cnt">${groups[g].length}</span></span><span class="chev">▾</span></button>
        <div class="stock-group-body">${rows}</div>
      </div>`;
  }).join("");
  el("stock-intake-content").innerHTML = `
    <h2>Приёмка поставки</h2>
    <div class="intake-hint">Сколько пришло: пачек × штук в пачке (можно несколько партий) или штук напрямую. Итог посчитается сам.</div>
    <div id="intake-groups">${groupHtml || '<div class="empty-state">Склад пуст</div>'}</div>
    <div class="form-actions intake-actions">
      <button type="button" class="btn btn-secondary" data-close="stock-intake">Закрыть</button>
      <button type="button" class="btn btn-primary" id="intake-submit">Оприходовать</button>
    </div>`;
  const content = el("stock-intake-content");
  const recalc = (row) => {
    let total = 0;
    row.querySelectorAll(".intake-batch").forEach((b) => {
      total += (parseFloat(b.querySelector(".ib-packs").value) || 0) * (parseFloat(b.querySelector(".ib-size").value) || 0);
    });
    total += parseFloat(row.querySelector(".ib-direct").value) || 0;
    row.querySelector(".intake-total b").textContent = _num(total);
    row.dataset.total = total;
  };
  content.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("stock-intake")));
  content.querySelectorAll(".stock-group-head").forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));
  content.addEventListener("input", (e) => { const row = e.target.closest(".intake-row"); if (row) recalc(row); });
  content.querySelectorAll(".intake-addbatch").forEach((btn) => btn.addEventListener("click", () => {
    const batches = btn.closest(".intake-row").querySelector(".intake-batches");
    const div = document.createElement("div");
    div.className = "intake-batch";
    div.innerHTML = `<input class="ib-packs" type="number" min="0" step="1" placeholder="пачек"/><span>×</span><input class="ib-size" type="number" min="0" step="1" placeholder="шт/пачка"/>`;
    batches.appendChild(div);
  }));
  el("intake-submit").addEventListener("click", async () => {
    const items = [];
    content.querySelectorAll(".intake-row").forEach((row) => {
      const batches = [];
      row.querySelectorAll(".intake-batch").forEach((b) => {
        const packs = parseFloat(b.querySelector(".ib-packs").value) || 0;
        const size = parseFloat(b.querySelector(".ib-size").value) || 0;
        if (packs > 0 && size > 0) batches.push({ packs, pack_size: size });
      });
      const direct = parseFloat(row.querySelector(".ib-direct").value) || 0;
      if (batches.length || direct > 0) items.push({ flower_id: Number(row.dataset.flower), batches, direct_stems: direct });
    });
    if (!items.length) { showToast("Ничего не введено"); return; }
    try {
      await apiFetch("/api/admin/stock/intake", { method: "POST", body: { items }, tg });
      showToast("Оприходовано ✓");
      closeSheet("stock-intake");
      await loadStock(); renderStock();
    } catch { showToast("Не удалось оприходовать"); }
  });
  openSheet("stock-intake");
}

// ---------------------------------------------------------------------
// Настройки: категории, персонал, магазин (только владелец)
// ---------------------------------------------------------------------
function isOwner() {
  return state.staff && state.staff.role === "owner";
}
function isCourier() {
  return state.staff && state.staff.role === "courier";
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
      const count = state.products.filter((p) => (p.category_ids || []).includes(c.id)).length;
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
  // Товар может быть в нескольких категориях — удаление просто снимет эту категорию.
  // Сервер откажет, только если товар останется совсем без категорий.
  const count = state.products.filter((p) => (p.category_ids || []).includes(c?.id)).length;
  const msg = count
    ? `Убрать категорию «${c?.name}» с ${count} товар(ов) и удалить её?`
    : `Удалить категорию «${c?.name}»?`;
  tg.showConfirm(msg, async (ok) => {
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
  const [settings, slots, couriers] = await Promise.all([
    apiFetch("/api/admin/settings", { tg }),
    apiFetch("/api/admin/delivery-slots", { tg }),
    apiFetch("/api/admin/couriers", { tg }),
  ]);
  state.settings = settings;
  state.deliverySlots = slots;
  state.couriers = couriers;
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
        <div class="field">
          <label>Окна доставки и лимит на каждое</label>
          <div id="slots-editor"></div>
          <button type="button" class="btn btn-outline btn-sm" id="add-slot-row">+ окно</button>
        </div>
        <div class="cr-meta" style="margin:-4px 0 10px;">Формат окна: 09:00-11:00. Лимит — сколько заказов принимаем на это окно; когда исчерпан, время пропадает у клиента. Заказ меньше мин. суммы — только самовывоз. Дневной тариф — до «времени смены», ночной — после (приём до 00:00). Доставка только по Батуми.</div>
        <div class="field"><label>Основной курьер (все доставки авто-назначаются на него)</label>
          <select name="default_courier_id">
            <option value="">— не выбран —</option>
            ${(state.couriers || []).map((c) => `<option value="${c.id}" ${String(s.default_courier_id) === String(c.id) ? "selected" : ""}>${c.name}</option>`).join("")}
          </select>
        </div>

        <h3 class="settings-group">Контакты</h3>
        <div class="field"><label>Телефон</label><input name="shop_phone" value="${esc(s.shop_phone)}" placeholder="+995 5xx xx xx xx"/></div>
        <div class="field"><label>Instagram (ник без @)</label><input name="shop_instagram" value="${esc(s.shop_instagram)}" placeholder="flowers_batum_flower"/></div>
        <div class="field"><label>Username менеджера в Telegram (для кнопки «Написать менеджеру», без @)</label><input name="manager_username" value="${esc(s.manager_username)}" placeholder="FlowersBatumFlower"/></div>

        <h3 class="settings-group">Онлайн-оплата (PayPal)</h3>
        <label class="checkbox-row" style="margin:2px 0 8px;">
          <input type="checkbox" name="paypal_enabled" ${String(s.paypal_enabled) === "1" ? "checked" : ""}/>
          <span>Включить оплату PayPal (картой) на витрине</span>
        </label>
        <div class="field-row">
          <div class="field"><label>1 EUR = … лари</label><input name="pay_rate_eur" type="number" step="0.01" min="0" value="${esc(s.pay_rate_eur)}" placeholder="напр. 2.8"/></div>
          <div class="field"><label>1 USD = … лари</label><input name="pay_rate_usd" type="number" step="0.01" min="0" value="${esc(s.pay_rate_usd)}" placeholder="напр. 2.55"/></div>
        </div>
        <div class="cr-meta" style="margin:-4px 0 10px;">Курс с зашитой комиссией: ставьте чуть НИЖЕ реального (реальный ~2.7 → 2.55) — разница покроет сбор PayPal. Клиент выбирает валюту и видит сумму до оплаты. Пустой курс = валюта недоступна. Секретные ключи PayPal задаёт разработчик в переменных окружения сервера.</div>

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
  const slotsEditor = el("slots-editor");
  function addSlotRow(window = "", capacity = 2) {
    const row = document.createElement("div");
    row.className = "slot-row";
    row.innerHTML = `<input class="sr-window" placeholder="09:00-11:00" value="${esc(window)}"/>
      <input class="sr-cap" type="number" min="1" step="1" value="${capacity}" title="лимит на окно"/>
      <button type="button" class="btn-icon" data-remove-slot aria-label="Убрать">✕</button>`;
    row.querySelector("[data-remove-slot]").addEventListener("click", () => row.remove());
    slotsEditor.appendChild(row);
  }
  (state.deliverySlots || []).forEach((sl) => addSlotRow(sl.window, sl.capacity));
  el("add-slot-row").addEventListener("click", () => addSlotRow());
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
          default_courier_id: fd.get("default_courier_id"),
          shop_phone: fd.get("shop_phone"),
          shop_instagram: fd.get("shop_instagram"),
          manager_username: fd.get("manager_username"),
          paypal_enabled: fd.get("paypal_enabled") ? "1" : "",
          pay_rate_eur: fd.get("pay_rate_eur"),
          pay_rate_usd: fd.get("pay_rate_usd"),
          express_delivery_text: fd.get("express_delivery_text"),
          disclaimer_note: fd.get("disclaimer_note"),
          delivery_payment_info: fd.get("delivery_payment_info"),
        },
        tg,
      });
      const slots = [...slotsEditor.querySelectorAll(".slot-row")].map((r) => ({
        window: r.querySelector(".sr-window").value.trim(),
        capacity: parseInt(r.querySelector(".sr-cap").value) || 1,
      })).filter((sl) => sl.window.includes("-"));
      state.deliverySlots = await apiFetch("/api/admin/delivery-slots", { method: "PUT", body: { slots }, tg });
      const ct = state.settings.chat_test;
      if (ct && ct.status === "ok") {
        showToast("Сохранено ✓ В чат ушло проверочное сообщение");
      } else if (ct && ct.status === "permanent") {
        showToast("Сохранено, но бот НЕ может писать в этот чат. Проверьте ID: напишите /chatid в нужном чате и вставьте ответ.");
      } else if (ct && ct.status === "transient") {
        showToast("Сохранено. Проверка чата не прошла (сеть) — уведомления досылаются автоматически.");
      } else {
        showToast("Настройки сохранены");
      }
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
// Дата+время СОЗДАНИЯ заказа в Батуми (created_at хранится в UTC) — для кассы,
// которую считаем по дате заказа. Возвращает "YYYY-MM-DD HH:MM".
function orderCreatedBatumi(o) {
  const s = String(o.created_at || "").trim();
  if (!s) return "";
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d)) return s.slice(0, 16);
  const b = new Date(d.getTime() + 4 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`;
}

function renderSalesTabs() {
  el("sales-period-tabs").innerHTML = [["day", "День"], ["month", "Месяц"]]
    .map(([v, l]) => `<button class="tab ${state.salesPeriod === v ? "active" : ""}" data-period="${v}">${l}</button>`)
    .join("");
  el("sales-period-tabs").querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => { state.salesPeriod = b.dataset.period; renderSalesTabs(); renderSales(); })
  );
}

const PAY_LABELS = { cash: "нал", card: "карта", card_store: "карта в магазине", card_courier: "карта курьеру", transfer: "перевод", paypal: "PayPal" };
const EXP_LABELS = { flowers: "закупка", courier: "курьер", salary: "зарплата", rent: "аренда", other: "прочее" };
const RU_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
  "августа", "сентября", "октября", "ноября", "декабря"];
function fmtDayRu(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return d ? `${d} ${RU_MONTHS[m - 1] || ""}` : String(day);
}

// Касса = доставленные заказы + живые продажи в точке. Список событий по дням,
// итог за период и разбивка по способу оплаты.
async function renderSales() {
  renderSalesTabs();
  const listWrap = el("sales-list");
  const totalWrap = el("sales-total");
  const panel = el("cash-panel");
  let orders = [], sales = [], expenses = [], cash = { shift: null };
  try {
    [orders, sales, expenses, cash] = await Promise.all([
      apiFetch(`/api/admin/orders?status=delivered&location_id=${LOCATION_ID}`, { tg }),
      apiFetch(`/api/admin/sales?period=${state.salesPeriod}`, { tg }),
      apiFetch(`/api/admin/expenses?period=${state.salesPeriod}`, { tg }),
      apiFetch(`/api/admin/cash/current?location_id=${LOCATION_ID}`, { tg }).catch(() => ({ shift: null })),
    ]);
  } catch {
    listWrap.innerHTML = `<div class="empty-state">Не удалось загрузить кассу</div>`;
    totalWrap.innerHTML = ""; if (panel) panel.innerHTML = "";
    return;
  }
  state.cash = cash;
  const parts = batumiParts();
  const period = state.salesPeriod;
  const keyLen = period === "month" ? 7 : 10;
  const want = period === "month" ? parts.month : parts.day;
  // Касса считается по ДАТЕ ЗАКАЗА (доставки предоплачены — деньги приходят при
  // оформлении), в времени Батуми.
  const dOrders = orders.filter((o) => orderCreatedBatumi(o).slice(0, keyLen) === want);
  state.salesOrders = dOrders;

  const events = [];
  dOrders.forEach((o) => events.push({
    kind: "order", id: o.id, day: orderCreatedBatumi(o).slice(0, 10), when: orderCreatedBatumi(o).slice(11, 16),
    title: o.items.map((i) => `${i.product_name}${i.variant_label ? ` (${i.variant_label})` : ""} ×${i.quantity}`).join(", "),
    thumb: o.items.find((i) => i.photo_url)?.photo_url || "",
    amount: o.total || 0, pay: o.payment_method, count: o.items.reduce((n, i) => n + i.quantity, 0),
  }));
  sales.forEach((s) => events.push({
    kind: "sale", id: s.id, day: String(s.created_at || "").slice(0, 10), when: String(s.created_at || "").slice(11, 16),
    title: `${s.title}${s.variant_label ? ` (${s.variant_label})` : ""} ×${s.quantity}`,
    thumb: "", amount: s.amount || 0, pay: s.payment_method, count: s.quantity,
  }));
  expenses.forEach((x) => events.push({
    kind: "expense", id: x.id, day: String(x.created_at || "").slice(0, 10), when: String(x.created_at || "").slice(11, 16),
    title: `${EXP_LABELS[x.category] || "расход"}${x.comment ? ` · ${x.comment}` : ""}`,
    thumb: "", amount: x.amount || 0, pay: x.payment_method, count: 0,
  }));
  events.sort((a, b) => (b.day + (b.when || "")).localeCompare(a.day + (a.when || "")));

  // Метрики дня/месяца.
  const revenue = events.filter((e) => e.kind !== "expense").reduce((s, e) => s + e.amount, 0);
  const expTotal = expenses.reduce((s, x) => s + (x.amount || 0), 0);
  const cashInDrawer = (cash && cash.shift) ? cash.expected_cash : null;
  renderCashPanel(panel, cash, period, revenue, expTotal, cashInDrawer);

  if (!events.length) {
    listWrap.innerHTML = `<div class="empty-state">За ${period === "month" ? "месяц" : "день"} операций нет</div>`;
  } else {
    let html = "", lastDay = null;
    events.forEach((e) => {
      if (period === "month" && e.day !== lastDay) { lastDay = e.day; html += `<div class="sales-day-head">${fmtDayRu(e.day)}</div>`; }
      const payTag = e.pay ? `<span class="pay-tag">${PAY_LABELS[e.pay] || e.pay}</span>`
        : (e.kind === "order" ? `<span class="pay-tag pay-none">оплата?</span>` : "");
      let badge, del = "";
      if (e.kind === "sale") { badge = `<span class="ev-badge">точка</span>`; del = `<button class="sale-del" data-del-sale="${e.id}" aria-label="Удалить">✕</button>`; }
      else if (e.kind === "expense") { badge = `<span class="ev-badge ev-exp">расход</span>`; del = `<button class="sale-del" data-del-exp="${e.id}" aria-label="Удалить">✕</button>`; }
      else { badge = `<span class="ev-badge ev-order">доставка №${e.id}</span>`; }
      const amtStr = e.kind === "expense" ? `−${money(e.amount)}` : money(e.amount);
      html += `
    <div class="card sale-card${e.kind === "expense" ? " exp-card" : ""}" ${e.kind === "order" ? `data-open-order="${e.id}"` : ""}>
      ${e.thumb ? `<img class="order-thumb" src="${e.thumb}" alt=""/>` : `<div class="order-thumb"></div>`}
      <div class="sale-info">
        <div class="sale-title">${badge}${e.when ? ` · ${e.when}` : ""} ${payTag}</div>
        <div class="sale-items">${e.title || "—"}</div>
      </div>
      <div class="order-total${e.kind === "expense" ? " exp-amt" : ""}">${amtStr}${del}</div>
    </div>`;
    });
    listWrap.innerHTML = html;
    listWrap.querySelectorAll("[data-open-order]").forEach((c) =>
      c.addEventListener("click", () => {
        const o = state.salesOrders.find((x) => x.id === Number(c.dataset.openOrder));
        if (o) renderOrderDetail(o);
      }));
    listWrap.querySelectorAll("[data-del-sale]").forEach((b) =>
      b.addEventListener("click", (ev) => { ev.stopPropagation(); deleteSale(Number(b.dataset.delSale)); }));
    listWrap.querySelectorAll("[data-del-exp]").forEach((b) =>
      b.addEventListener("click", (ev) => { ev.stopPropagation(); deleteExpense(Number(b.dataset.delExp)); }));
  }

  const saleEvents = events.filter((e) => e.kind !== "expense");
  const items = saleEvents.reduce((s, e) => s + e.count, 0);
  const paySplit = {};
  saleEvents.forEach((e) => { const k = e.pay || "none"; paySplit[k] = (paySplit[k] || 0) + e.amount; });
  const splitStr = Object.keys(paySplit).filter((k) => k !== "none")
    .map((k) => `${PAY_LABELS[k] || k} ${money(paySplit[k])}`).join(" · ");
  totalWrap.innerHTML = `
    <div class="sales-total-inner">
      <div><span class="st-count">${saleEvents.length}</span> продаж · ${items} шт${splitStr ? `<div class="pay-split">${splitStr}</div>` : ""}${expTotal ? `<div class="pay-split">расходы ${money(expTotal)} · итого ${money(revenue - expTotal)}</div>` : ""}</div>
      <div class="st-sum">${money(revenue)}</div>
    </div>`;
}

// Плашка смены + карточки-метрики над журналом кассы.
function renderCashPanel(panel, cash, period, revenue, expTotal, cashInDrawer) {
  if (!panel) return;
  const sh = cash && cash.shift;
  const bar = sh
    ? `<div class="shift-bar shift-open">
         <div><div class="shift-title"><span class="shift-dot"></span> Смена открыта · ${(sh.opened_at || "").slice(11, 16)}</div>
         <div class="shift-sub">старт налом: ${money(sh.start_cash || 0)}${sh.opened_by ? ` · ${sh.opened_by}` : ""}</div></div>
         <button class="shift-btn" id="shift-close-btn">Закрыть</button></div>`
    : `<div class="shift-bar">
         <div><div class="shift-title">Смена закрыта</div><div class="shift-sub">откройте, чтобы вести кассу за день</div></div>
         <button class="shift-btn" id="shift-open-btn">Открыть</button></div>`;
  const thirdLabel = period === "month" ? "Итого" : "Нал в кассе";
  const thirdVal = period === "month" ? money(revenue - expTotal) : (cashInDrawer != null ? money(cashInDrawer) : "—");
  const metrics = `<div class="cash-metrics">
      <div class="cm-card"><div class="cm-lbl">Выручка</div><div class="cm-val">${money(revenue)}</div></div>
      <div class="cm-card"><div class="cm-lbl">Расходы</div><div class="cm-val cm-red">${money(expTotal)}</div></div>
      <div class="cm-card"><div class="cm-lbl">${thirdLabel}</div><div class="cm-val">${thirdVal}</div></div>
    </div>`;
  panel.innerHTML = bar + metrics + `<button class="cash-link" id="shift-history-btn">История смен ›</button>`;
  el("shift-open-btn")?.addEventListener("click", () => openShiftForm("open"));
  el("shift-close-btn")?.addEventListener("click", () => openShiftForm("close"));
  el("shift-history-btn")?.addEventListener("click", openShiftHistory);
}

async function openShiftHistory() {
  el("sale-edit-content").innerHTML = `<h2>История смен</h2><div class="empty-state">Загрузка…</div>`;
  openSheet("sale-edit");
  let shifts = [];
  try { shifts = await apiFetch("/api/admin/cash/shifts", { tg }); }
  catch { el("sale-edit-content").innerHTML = `<h2>История смен</h2><div class="empty-state">Не удалось загрузить</div>`; return; }
  if (!shifts.length) { el("sale-edit-content").innerHTML = `<h2>История смен</h2><div class="empty-state">Смен пока нет</div>`; return; }
  const rows = shifts.map((s) => {
    const day = (s.opened_at || "").slice(0, 10);
    const t1 = (s.opened_at || "").slice(11, 16);
    const t2 = s.closed_at ? (s.closed_at || "").slice(11, 16) : "…";
    let tag;
    if (s.status === "open") tag = `<span class="ev-badge" style="background:#e4f2ea;color:#2e6b48;">открыта</span>`;
    else {
      const d = s.diff || 0;
      tag = Math.abs(d) < 0.5 ? `<span class="ev-badge">сошлась</span>`
        : (d > 0 ? `<span class="ev-badge ev-exp">излишек ${money(d)}</span>` : `<span class="ev-badge ev-exp">недостача ${money(-d)}</span>`);
    }
    return `<div class="card sale-card" data-shift="${s.id}">
      <div class="sale-info">
        <div class="sale-title">${fmtDayRu(day)} · ${t1}–${t2} ${tag}</div>
        <div class="sale-items">выручка ${money(s.revenue)} · расходы ${money(s.expenses_total)}</div>
      </div>
      <div class="order-total">${money((s.revenue || 0) - (s.expenses_total || 0))}</div>
    </div>`;
  }).join("");
  el("sale-edit-content").innerHTML = `<h2>История смен</h2>${rows}`;
  el("sale-edit-content").querySelectorAll("[data-shift]").forEach((c) =>
    c.addEventListener("click", () => openShiftDetail(Number(c.dataset.shift))));
}

async function openShiftDetail(id) {
  el("sale-edit-content").innerHTML = `<div class="empty-state">Загрузка…</div>`;
  let d;
  try { d = await apiFetch(`/api/admin/cash/shifts/${id}`, { tg }); }
  catch { el("sale-edit-content").innerHTML = `<div class="empty-state">Не удалось загрузить</div>`; return; }
  const s = d.shift;
  const day = (s.opened_at || "").slice(0, 10);
  const recon = s.status === "closed" ? `
    <div class="shift-recon">
      <div><span>Старт налом</span><b>${money(s.start_cash || 0)}</b></div>
      <div><span>Ожидалось налом</span><b>${money(s.expected_cash || 0)}</b></div>
      <div><span>Посчитано по факту</span><b>${money(s.counted_cash || 0)}</b></div>
      <div class="${(s.diff || 0) < -0.5 ? "rc-bad" : ((s.diff || 0) > 0.5 ? "rc-warn" : "rc-ok")}"><span>Расхождение</span><b>${(s.diff || 0) >= 0 ? "+" : ""}${money(s.diff || 0)}</b></div>
    </div>` : `<div class="intake-hint">Смена ещё открыта. Старт налом: ${money(s.start_cash || 0)}.</div>`;
  const orders = (d.orders || []).map((o) => `<div class="mini-row"><span>Доставка №${o.id} ${PAY_LABELS[o.payment_method] || ""}</span><b>${money(o.total)}</b></div>`).join("") || `<div class="mini-empty">нет</div>`;
  const sales = (d.sales || []).map((x) => `<div class="mini-row"><span>${x.title || "продажа"}${x.variant_label ? ` (${x.variant_label})` : ""} · ${PAY_LABELS[x.payment_method] || "—"}</span><b>${money(x.amount)}</b></div>`).join("") || `<div class="mini-empty">нет</div>`;
  const exps = (d.expenses || []).map((x) => `<div class="mini-row"><span>${EXP_LABELS[x.category] || "расход"}${x.comment ? ` · ${x.comment}` : ""} · ${PAY_LABELS[x.payment_method] || "—"}</span><b class="exp-amt">−${money(x.amount)}</b></div>`).join("") || `<div class="mini-empty">нет</div>`;
  el("sale-edit-content").innerHTML = `
    <button class="cash-link" id="shift-back">‹ Все смены</button>
    <h2 style="margin-top:4px;">Смена ${fmtDayRu(day)}</h2>
    <div class="intake-hint">${(s.opened_at || "").slice(11, 16)}–${s.closed_at ? (s.closed_at || "").slice(11, 16) : "…"} · открыл ${s.opened_by || "—"}${s.closed_by ? ` · закрыл ${s.closed_by}` : ""}</div>
    <div class="cash-metrics">
      <div class="cm-card"><div class="cm-lbl">Выручка</div><div class="cm-val">${money(s.revenue)}</div></div>
      <div class="cm-card"><div class="cm-lbl">Расходы</div><div class="cm-val cm-red">${money(s.expenses_total)}</div></div>
      <div class="cm-card"><div class="cm-lbl">Итого</div><div class="cm-val">${money((s.revenue || 0) - (s.expenses_total || 0))}</div></div>
    </div>
    ${recon}
    <div class="shift-sec">Доставки (${s.orders_count})</div>${orders}
    <div class="shift-sec">Продажи в точке (${s.sales_count})</div>${sales}
    <div class="shift-sec">Расходы</div>${exps}`;
  el("shift-back").addEventListener("click", openShiftHistory);
}

async function deleteSale(id) {
  const doDel = async () => {
    try {
      await apiFetch(`/api/admin/sales/${id}`, { method: "DELETE", tg });
      showToast("Продажа удалена, склад возвращён");
      await loadStock().catch(() => {});
      renderSales();
    } catch { showToast("Не удалось удалить"); }
  };
  if (tg.showConfirm) tg.showConfirm("Удалить продажу? Списанный склад вернётся.", (ok) => { if (ok) doDel(); });
  else doDel();
}

// Список конкретных позиций склада (без групп) — для ручного списания продажи.
function saleFlowerOptions() {
  return [...(state.stock || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"))
    .map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
}
function addSaleWriteoffRow(box) {
  const rr = document.createElement("div");
  rr.className = "recipe-row";
  rr.innerHTML = `
    <select class="sw-flower"><option value="">— цветок —</option>${saleFlowerOptions()}</select>
    <input class="sw-qty" type="number" min="1" step="1" placeholder="шт"/>
    <button type="button" class="btn-icon sw-remove" aria-label="Убрать">✕</button>`;
  rr.querySelector(".sw-remove").addEventListener("click", () => rr.remove());
  box.appendChild(rr);
}

function openSaleForm() {
  const prods = (state.products || []).filter((p) => p.status !== "hidden");
  const prodOpts = `<option value="">— вписать вручную —</option>` +
    prods.map((p) => `<option value="${p.id}">${_q(p.name)}</option>`).join("");
  el("sale-edit-content").innerHTML = `
    <h2>Продажа в точке</h2>
    <form id="sale-form">
      <div class="field"><label>Букет</label><select id="sale-product">${prodOpts}</select></div>
      <div class="field" id="sale-title-wrap"><label>Название (вручную)</label><input id="sale-title" placeholder="Авторский букет"/></div>
      <div class="field" id="sale-variant-wrap" style="display:none;"><label>Размер</label><select id="sale-variant"></select></div>
      <div class="field-row">
        <div class="field"><label>Сумма ₾</label><input id="sale-amount" type="number" min="0" step="1" placeholder="0"/></div>
        <div class="field"><label>Кол-во</label><input id="sale-qty" type="number" min="1" step="1" value="1"/></div>
      </div>
      <div class="field"><label>Оплата</label>
        <div class="seg" id="sale-pay">
          <button type="button" class="seg-btn active" data-pay="cash">Нал</button>
          <button type="button" class="seg-btn" data-pay="card">Карта</button>
          <button type="button" class="seg-btn" data-pay="transfer">Перевод</button>
        </div>
      </div>
      <label class="chk"><input type="checkbox" id="sale-writeoff" checked/> Списать со склада</label>
      <div id="sale-writeoff-recipe" class="intake-hint" style="display:none;">Спишется автоматически по рецепту выбранного размера.</div>
      <div id="sale-writeoff-manual" style="display:none;">
        <div class="intake-hint">Что списать со склада (напр. продали все розы):</div>
        <div id="sale-writeoff-rows"></div>
        <button type="button" class="btn btn-outline btn-sm" id="sale-add-flower">+ цветок</button>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="sale-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Записать</button>
      </div>
    </form>`;
  document.querySelectorAll("#sale-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("sale-edit")));

  let payMethod = "cash";
  el("sale-pay").querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    el("sale-pay").querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); payMethod = b.dataset.pay;
  }));

  const rowsBox = el("sale-writeoff-rows");
  el("sale-add-flower").addEventListener("click", () => addSaleWriteoffRow(rowsBox));

  const applyMode = () => {
    const pid = el("sale-product").value;
    const p = pid ? prods.find((x) => x.id === Number(pid)) : null;
    const woOn = el("sale-writeoff").checked;
    el("sale-title-wrap").style.display = p ? "none" : "block";
    // Варианты каталожного товара
    const vwrap = el("sale-variant-wrap");
    if (p && (p.variants || []).length) {
      vwrap.style.display = "block";
      el("sale-variant").innerHTML = p.variants.map((v) => `<option value="${v.id}">${_q(v.label || "размер")} — ${money(v.price)}</option>`).join("");
    } else { vwrap.style.display = "none"; el("sale-variant").innerHTML = ""; }
    // Автосумма из цены первого/выбранного варианта
    if (p) {
      const v = (p.variants || []).find((x) => x.id === Number(el("sale-variant").value)) || (p.variants || [])[0];
      if (v && !el("sale-amount").value) el("sale-amount").value = Math.round(v.price || 0);
    }
    // Списание: каталог с рецептом → авто; иначе ручной выбор
    const hasRecipe = p && (p.variants || []).some((v) => (v.recipe || []).length);
    const isSimple = p && p.track_stock;
    el("sale-writeoff-recipe").style.display = woOn && p && (hasRecipe || isSimple) ? "block" : "none";
    el("sale-writeoff-manual").style.display = woOn && !(p && (hasRecipe || isSimple)) ? "block" : "none";
    if (woOn && !(p && (hasRecipe || isSimple)) && !rowsBox.children.length) addSaleWriteoffRow(rowsBox);
  };
  el("sale-product").addEventListener("change", () => { el("sale-amount").value = ""; applyMode(); });
  el("sale-variant").addEventListener("change", () => {
    const p = prods.find((x) => x.id === Number(el("sale-product").value));
    const v = p && (p.variants || []).find((x) => x.id === Number(el("sale-variant").value));
    if (v) el("sale-amount").value = Math.round(v.price || 0);
  });
  el("sale-writeoff").addEventListener("change", applyMode);
  applyMode();

  el("sale-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pid = el("sale-product").value ? Number(el("sale-product").value) : null;
    const vid = el("sale-variant").value ? Number(el("sale-variant").value) : null;
    const amount = parseFloat(el("sale-amount").value);
    if (!(amount >= 0) || Number.isNaN(amount)) { showToast("Укажите сумму"); return; }
    const title = pid ? "" : (el("sale-title").value || "").trim();
    if (!pid && !title) { showToast("Укажите название букета"); return; }
    const writeoffEnabled = el("sale-writeoff").checked;
    const manual = [];
    if (writeoffEnabled && el("sale-writeoff-manual").style.display !== "none") {
      rowsBox.querySelectorAll(".recipe-row").forEach((r) => {
        const fid = r.querySelector(".sw-flower").value;
        const qty = parseFloat(r.querySelector(".sw-qty").value);
        if (fid && qty > 0) manual.push({ flower_id: Number(fid), qty });
      });
    }
    const body = {
      product_id: pid, variant_id: vid, title, amount,
      quantity: parseInt(el("sale-qty").value) || 1, payment_method: payMethod,
      writeoff_enabled: writeoffEnabled, writeoff: manual, location_id: LOCATION_ID,
    };
    try {
      const res = await apiFetch("/api/admin/sales", { method: "POST", body, tg });
      showToast(res.shortage ? "Записано, но склада не хватило (списан в ноль)" : "Продажа записана");
      closeSheet("sale-edit");
      await loadStock().catch(() => {});
      renderSales();
    } catch { showToast("Не удалось записать продажу"); }
  });

  openSheet("sale-edit");
}
el("add-sale-btn").addEventListener("click", openSaleForm);

// Расход из кассы (реюзаем шит sale-edit).
function openExpenseForm() {
  const cats = [["flowers", "Закупка"], ["courier", "Курьер"], ["salary", "Зарплата"], ["rent", "Аренда"], ["other", "Прочее"]];
  el("sale-edit-content").innerHTML = `
    <h2>Расход из кассы</h2>
    <form id="expense-form">
      <div class="field"><label>Сумма ₾</label><input id="exp-amount" type="number" min="0" step="1" placeholder="0"/></div>
      <div class="field"><label>Категория</label>
        <div class="seg seg-wrap" id="exp-cat">${cats.map(([v, l], i) => `<button type="button" class="seg-btn${i === 0 ? " active" : ""}" data-cat="${v}">${l}</button>`).join("")}</div>
      </div>
      <div class="field"><label>Комментарий</label><input id="exp-comment" placeholder="напр. розы у поставщика"/></div>
      <div class="field"><label>Оплата</label>
        <div class="seg" id="exp-pay">
          <button type="button" class="seg-btn active" data-pay="cash">Нал</button>
          <button type="button" class="seg-btn" data-pay="card">Карта</button>
          <button type="button" class="seg-btn" data-pay="transfer">Перевод</button>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-close="sale-edit">Отмена</button>
        <button type="submit" class="btn btn-primary">Записать расход</button>
      </div>
    </form>`;
  document.querySelectorAll("#sale-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("sale-edit")));
  let cat = "flowers", pay = "cash";
  el("exp-cat").querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    el("exp-cat").querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active")); b.classList.add("active"); cat = b.dataset.cat;
  }));
  el("exp-pay").querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    el("exp-pay").querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active")); b.classList.add("active"); pay = b.dataset.pay;
  }));
  el("expense-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = parseFloat(el("exp-amount").value);
    if (!(amount > 0)) { showToast("Укажите сумму"); return; }
    try {
      await apiFetch("/api/admin/expenses", {
        method: "POST",
        body: { amount, category: cat, comment: (el("exp-comment").value || "").trim(), payment_method: pay, location_id: LOCATION_ID },
        tg,
      });
      showToast("Расход записан");
      closeSheet("sale-edit");
      renderSales();
    } catch (err) { showToast(err?.data?.detail || "Не удалось записать расход"); }
  });
  openSheet("sale-edit");
}
el("add-expense-btn").addEventListener("click", openExpenseForm);

// Открытие/закрытие смены (реюзаем шит sale-edit).
function openShiftForm(mode) {
  const c = state.cash || {};
  const expected = c.expected_cash;
  el("sale-edit-content").innerHTML = mode === "open"
    ? `<h2>Открыть смену</h2>
       <div class="field"><label>Наличные в кассе на старте, ₾</label><input id="shift-cash" type="number" min="0" step="1" value="0"/></div>
       <div class="form-actions">
         <button type="button" class="btn btn-secondary" data-close="sale-edit">Отмена</button>
         <button type="button" class="btn btn-primary" id="shift-submit">Открыть смену</button>
       </div>`
    : `<h2>Закрыть смену</h2>
       <div class="intake-hint">Ожидается налом (старт + продажи налом − расходы налом): <b>${expected != null ? money(expected) : "—"}</b></div>
       <div class="field"><label>Сколько налом по факту, ₾</label><input id="shift-cash" type="number" min="0" step="1" value="${expected != null ? Math.round(expected) : 0}"/></div>
       <div class="form-actions">
         <button type="button" class="btn btn-secondary" data-close="sale-edit">Отмена</button>
         <button type="button" class="btn btn-primary" id="shift-submit">Закрыть смену</button>
       </div>`;
  document.querySelectorAll("#sale-edit-content [data-close]").forEach((b) => b.addEventListener("click", () => closeSheet("sale-edit")));
  el("shift-submit").addEventListener("click", async () => {
    const val = parseFloat(el("shift-cash").value) || 0;
    try {
      if (mode === "open") {
        await apiFetch("/api/admin/cash/open", { method: "POST", body: { start_cash: val, location_id: LOCATION_ID }, tg });
        showToast("Смена открыта");
      } else {
        const r = await apiFetch("/api/admin/cash/close", { method: "POST", body: { counted_cash: val, location_id: LOCATION_ID }, tg });
        const d = r.diff || 0;
        showToast(Math.abs(d) < 0.5 ? "Смена закрыта, касса сошлась ✓"
          : (d > 0 ? `Смена закрыта · излишек ${money(d)}` : `Смена закрыта · недостача ${money(-d)}`));
      }
      closeSheet("sale-edit");
      renderSales();
    } catch (err) { showToast(err?.data?.detail || "Не удалось"); }
  });
  openSheet("sale-edit");
}

async function deleteExpense(id) {
  const doDel = async () => {
    try {
      await apiFetch(`/api/admin/expenses/${id}`, { method: "DELETE", tg });
      showToast("Расход удалён");
      renderSales();
    } catch { showToast("Не удалось удалить"); }
  };
  if (tg.showConfirm) tg.showConfirm("Удалить расход?", (ok) => { if (ok) doDel(); });
  else doDel();
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

  await loadOrders();

  // Курьер: только свои доставки. Без вкладок-статусов и прочих разделов.
  if (isCourier()) {
    el("order-status-tabs").innerHTML = "";
    document
      .querySelectorAll('.nav-btn[data-view="catalog"], .nav-btn[data-view="stock"]')
      .forEach((b) => (b.style.display = "none"));
    renderOrders();
    return;
  }

  // Владелец и флорист: заказы + назначение курьеров.
  renderOrderTabs();
  try { await loadCouriers(); } catch (e) { /* назначать будет нечем, не критично */ }
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
    // Флорист: заказы + касса (живые продажи). Каталог и Склад скрыты, но
    // товары/склад грузим — нужны для формы продажи и списания.
    document
      .querySelectorAll('.nav-btn[data-view="catalog"], .nav-btn[data-view="stock"]')
      .forEach((b) => (b.style.display = "none"));
    el("nav-sales").style.display = "flex";
    try {
      const pos = await apiFetch("/api/admin/pos-data", { tg });
      state.products = pos.products || [];
      state.stock = pos.flowers || [];
      renderSales();
    } catch (err) { /* касса покажет ошибку загрузки при открытии */ }
  }
}
init();
