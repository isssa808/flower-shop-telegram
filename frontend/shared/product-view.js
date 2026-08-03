// Общий билдер карточки товара (шторка) — ОДИН источник HTML для витрины и
// превью в админке, чтобы они совпадали 1:1. Возвращает HTML-строку; навешивание
// обработчиков — на стороне вызывающего (customer навешивает всё, admin-превью нет).

const ICON_GIFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12v8H4v-8"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7S9 7 8 5.5 9 3 10 4s2 3 2 3zM12 7s3 0 4-1.5S15 3 14 4s-2 3-2 3z"/></svg>`;
const ICON_TRUCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/></svg>`;
const ICON_STORE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16l-1 11H5z"/><path d="M4 9l1.2-4h13.6L20 9"/></svg>`;
const ICON_HEART = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21C12 21 4 14.5 4 8.8C4 5.9 6.2 4 8.6 4C10.2 4 11.4 4.9 12 6C12.6 4.9 13.8 4 15.4 4C17.8 4 20 5.9 20 8.8C20 14.5 12 21 12 21Z"/></svg>`;

// Минимальная цена среди вариантов (>0), иначе null («по запросу»).
export function priceOf(p) {
  const prices = (p.variants || []).map((v) => v.price).filter((x) => x > 0);
  return prices.length ? Math.min(...prices) : null;
}

// Метка бейджа через переданный t(); '' если бейджа нет.
export function badgeLabel(t, badge) {
  if (badge === "new") return t("badge_new");
  if (badge === "hit") return t("badge_hit");
  if (badge === "recommended") return t("badge_recommended");
  return "";
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

// buildProductSheetHtml(p, opts) — HTML карточки товара.
// opts: { t, money, shop, mode, liked, descExpanded, selectedVariantId, selectedQty }
// mode: "full" (витрина, с «в корзину»/допродажей) | "preview" (админка, только показ).
export function buildProductSheetHtml(p, opts = {}) {
  const {
    t, money, shop = {}, mode = "full", liked = false,
    descExpanded = false, selectedVariantId = null, selectedQty = 1,
  } = opts;
  const preview = mode === "preview";

  const variantsHtml = (p.variants || [])
    .map(
      (v) => `
      <button class="variant-pill ${v.id === selectedVariantId ? "active" : ""}${v.available === false ? " unavail" : ""}" data-variant="${v.id}"${(preview || v.available === false) ? " disabled" : ""}>
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
    ? `<div class="pd-desc ${isLong && !descExpanded ? "clamp" : ""}">${desc}</div>
       ${isLong ? `<button class="pd-more" id="desc-toggle" type="button">${descExpanded ? t("collapse") : t("see_full_desc")}</button>` : ""}`
    : "";

  const note = shop.disclaimer_note || t("note_default");
  const express = shop.express_delivery_text || t("express_default");
  const deliveryInfo = shop.delivery_payment_info || t("delivery_info_default");

  // строка мета: бейдж + лайки (+число заказов). Лайк в full-режиме — кнопка.
  const blabel = badgeLabel(t, p.badge);
  const badgeHtml = blabel ? `<span class="pd-badge badge-${p.badge}">${blabel}</span>` : "";
  const likeInner = `${ICON_HEART}<span>${p.likes || 0}</span>`;
  const likeHtml = preview
    ? `<span class="pd-like">${likeInner}</span>`
    : `<button class="pd-like ${liked ? "on" : ""}" data-like="${p.id}" type="button" aria-label="like">${likeInner}</button>`;
  const ordersHtml = p.order_count > 0 ? `<span class="pd-orders">${t("ordered_times", { n: p.order_count })}</span>` : "";
  const metaHtml = (badgeHtml || ordersHtml || true)
    ? `<div class="pd-meta">${badgeHtml}${likeHtml}${ordersHtml}</div>`
    : "";

  const selVar = (p.variants || []).find((v) => v.id === selectedVariantId);
  const selUnavail = selVar ? (selVar.available === false) : false;
  const buyBlock = preview
    ? ""
    : (p.available === false
      ? `<div class="pd-oos">${t("out_of_stock")}</div>`
      : `
    <div class="pd-label">${t("quantity")}</div>
    <div class="qty-row">
      <button class="qty-btn" id="qty-minus">−</button>
      <span class="qty-value" id="qty-value">${selectedQty}</span>
      <button class="qty-btn" id="qty-plus">+</button>
    </div>
    ${selUnavail
      ? `<div class="pd-oos">${t("size_unavailable")}</div>`
      : `<button class="btn btn-primary btn-block" id="add-to-cart-btn">${t("add_to_cart")}</button>`}`);

  const addonsBlock = preview ? "" : `<div id="product-addons"></div>`;

  return `
    <div class="pd-photo"><img src="${p.photo_url}" alt="${p.name}" /></div>
    <h2 class="pd-title">${p.name}</h2>
    ${metaHtml}
    <div class="pd-price-lead">${leadPrice}</div>
    ${descBlock}

    <div class="pd-note">${note}</div>

    <div class="pd-benefits">
      ${benefitRow(ICON_GIFT, t("benefit_packaging"))}
      ${benefitRow(ICON_TRUCK, `${t("benefit_express")} · ${express}`)}
      ${benefitRow(ICON_STORE, shop.address ? `${t("benefit_pickup")} — ${shop.address}` : t("benefit_pickup"))}
    </div>

    <div class="pd-label">${t("size")}</div>
    <div class="variant-row" id="variant-row">${variantsHtml}</div>
    ${buyBlock}

    <div class="pd-accs">
      ${accordion("desc", t("acc_description"), p.description || "")}
      ${accordion("comp", t("acc_composition"), p.composition || "")}
      ${accordion("deliv", t("acc_delivery"), deliveryInfo)}
    </div>

    ${addonsBlock}
  `;
}
