import { getTelegram, apiFetch, initFullscreen } from "/shared/telegram.js";

const tg = getTelegram();
initFullscreen(tg);

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
};

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

function roleLabel(role) {
  return { owner: "владелец", florist: "флорист", courier: "курьер" }[role] || role;
}
function statusLabelRu(s) {
  return { in_stock: "в наличии", made_to_order: "под заказ", hidden: "скрыт" }[s] || s;
}
const STATUS_LABELS = {
  new: "Новый", confirmed: "Подтверждён", assembling: "Собирается",
  out_for_delivery: "В пути", delivered: "Доставлен", cancelled: "Отменён",
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
      (o) => `
    <div class="card order-card" data-order="${o.id}">
      <div class="order-card-top">
        <div>
          <div class="order-id">Заказ №${o.id}</div>
          <div class="order-customer">${o.customer_name || "—"} · ${o.customer_phone || "без телефона"}</div>
        </div>
        <div class="order-total">${money(o.total)}</div>
      </div>
      <div class="order-meta">
        ${o.fulfillment_type === "delivery" ? `Доставка: ${o.address || "—"} · ${o.delivery_date || ""} ${o.delivery_slot || ""}` : "Самовывоз"}<br/>
        ${o.items.map((i) => `${i.product_name} (${i.variant_label}) ×${i.quantity}`).join(", ")}
      </div>
      <select class="status-select" data-order-id="${o.id}">
        ${Object.entries(STATUS_LABELS).map(([val, label]) => `<option value="${val}" ${o.status === val ? "selected" : ""}>${label}</option>`).join("")}
      </select>
    </div>`
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
  if (!o) return;
  el("order-detail-content").innerHTML = `
    <h2>Заказ №${o.id}</h2>
    <div class="order-meta" style="margin-bottom:14px;">
      <strong>${o.customer_name}</strong><br/>${o.customer_phone}<br/><br/>
      ${o.fulfillment_type === "delivery" ? `Доставка на: ${o.address}<br/>${o.delivery_date} ${o.delivery_slot}` : "Самовывоз"}<br/>
      ${o.recipient_name ? `Получатель: ${o.recipient_name}<br/>` : ""}
      ${o.card_message ? `Открытка: «${o.card_message}»<br/>` : ""}
      ${o.photo_before_delivery ? "📷 Прислать фото перед доставкой<br/>" : ""}
      Оплата: ${o.payment_method}
    </div>
    ${o.items.map((i) => `<div class="cart-line"><div class="cl-info"><div class="cl-name">${i.product_name}</div><div class="cl-variant">${i.variant_label} ×${i.quantity}</div></div><div class="cl-price">${money(i.price * i.quantity)}</div></div>`).join("")}
    <div class="cart-total"><span>Итого</span><span>${money(o.total)}</span></div>
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
        <div class="cr-name">${p.name}</div>
        <div class="cr-meta">${p.variants.map((v) => money(v.price)).join(" / ") || "без цены"} · ${statusLabelRu(p.status)}</div>
      </div>
      <div class="cr-actions">
        <button class="btn-icon" data-edit="${p.id}" aria-label="Редактировать">✎</button>
        <button class="btn-icon" data-delete="${p.id}" aria-label="Удалить">🗑</button>
      </div>
    </div>`
    )
    .join("");
  wrap.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openProductEdit(Number(b.dataset.edit))));
  wrap.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", () => deleteProduct(Number(b.dataset.delete))));
}

el("add-product-btn").addEventListener("click", () => openProductEdit(null));

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
      <div class="field"><label>Повод (через запятую)</label><input name="occasion_tags" value="${(p?.occasion_tags || []).join(", ")}"/></div>
      <div class="field"><label>Фото</label><input type="file" name="photo" accept="image/*"/></div>
      <div class="field">
        <label>Варианты (размер и цена)</label>
        <div id="variant-editor"></div>
        <button type="button" class="btn btn-outline btn-sm" id="add-variant-row">+ вариант</button>
      </div>
      <div class="form-actions">
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

function renderSettings() {
  const s = state.settings || {};
  const usingEnv = !s.staff_chat_id && s.staff_chat_id_effective;
  el("settings-form-wrap").innerHTML = `
    <div class="card" style="padding:14px;">
      <form id="settings-form">
        <div class="field">
          <label>Chat ID для уведомлений о заказах</label>
          <input name="staff_chat_id" value="${s.staff_chat_id || ""}" placeholder="напр. -1001234567890 (группа) или ваш ID"/>
          <div class="cr-meta" style="margin-top:6px;">
            ${usingEnv
              ? `Сейчас используется значение по умолчанию: <b>${s.staff_chat_id_effective}</b>. Оставьте пустым, чтобы не менять.`
              : "Куда бот шлёт новые заказы. Для группы добавьте бота в неё и укажите её ID (начинается с −100)."}
          </div>
        </div>
        <div class="field"><label>Название магазина</label><input name="shop_name" value="${s.shop_name || ""}"/></div>
        <div class="field"><label>Адрес / точка</label><input name="shop_address" value="${s.shop_address || ""}"/></div>
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

  await loadCategories();
  renderOrderTabs();
  await Promise.all([loadOrders(), loadProducts(), loadStock()]);
  renderOrders();
  renderCatalog();
  renderStock();

  // Раздел «Настройки» — только для владельца: управление категориями,
  // персоналом и параметрами магазина.
  if (isOwner()) {
    el("nav-settings").style.display = "flex";
    try {
      await Promise.all([loadStaffList(), loadSettings()]);
      renderCategoriesAdmin();
      renderStaffAdmin();
      renderSettings();
    } catch (err) {
      // раздел просто останется пустым, остальное работает
    }
  }
}
init();
