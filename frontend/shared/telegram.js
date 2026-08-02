// Обёртка над Telegram WebApp SDK. Если приложение открыто не внутри
// Telegram (например, при локальной разработке в обычном браузере),
// подставляется заглушка в памяти — чтобы верстать и проверять логику,
// не выходя в реальный Telegram на каждый чих.
export function getTelegram() {
  if (window.Telegram && window.Telegram.WebApp) {
    return window.Telegram.WebApp;
  }
  console.warn("Telegram WebApp SDK не найден — тестовый режим вне Telegram");
  const mem = {};
  // Для локальной проверки админки в обычном браузере: initData можно
  // сгенерировать на сервере (см. backend/auth.py -> sign_init_data,
  // используя ваш локальный BOT_TOKEN) и подставить в адрес страницы как
  // ?dev_init_data=... — секрет при этом никогда не попадает в код фронтенда.
  const devInitData = new URLSearchParams(location.search).get("dev_init_data") || "";
  return {
    initData: devInitData,
    initDataUnsafe: { user: { id: 0, first_name: "Тест" } },
    themeParams: {},
    colorScheme: "light",
    ready() {},
    expand() {},
    close() {},
    MainButton: {
      _text: "", _onClick: null,
      show() { this._el && (this._el.style.display = "block"); },
      hide() { this._el && (this._el.style.display = "none"); },
      setText(t) { this._text = t; },
      onClick(fn) { this._onClick = fn; },
      offClick() { this._onClick = null; },
    },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    CloudStorage: {
      getItem(key, cb) { cb(null, mem[key] ?? null); },
      setItem(key, value, cb) { mem[key] = value; cb && cb(null, true); },
    },
    // Заглушки для полноэкранного режима (Bot API 8.0) — вне Telegram просто
    // ничего не делают, чтобы верстать и проверять логику в обычном браузере.
    isFullscreen: false,
    isVersionAtLeast() { return false; },
    requestFullscreen() {},
    exitFullscreen() {},
    disableVerticalSwipes() {},
    enableVerticalSwipes() {},
    setHeaderColor() {},
    setBackgroundColor() {},
    setBottomBarColor() {},
    onEvent() {},
    offEvent() {},
    safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
    contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
    showAlert(msg) { alert(msg); },
    showConfirm(msg, cb) { cb(confirm(msg)); },
  };
}

// Разворачиваем мини-апп на весь экран (как «нативное» приложение — без рамки
// и кнопки «Закрыть» сверху) и пробрасываем безопасные отступы Telegram в
// CSS-переменные, чтобы контент не заезжал под чёлку/системные индикаторы.
// Всё под optional-chaining: на старых клиентах и в локальной заглушке — no-op.
export function initFullscreen(tg) {
  try { tg.ready?.(); } catch (e) {}
  try { tg.expand?.(); } catch (e) {}
  try { tg.requestFullscreen?.(); } catch (e) {}
  // На весь экран удобнее без «протягивания» вниз, которое сворачивает окно.
  try { tg.disableVerticalSwipes?.(); } catch (e) {}

  const applySafeArea = () => {
    const root = document.documentElement;
    const sa = tg.safeAreaInset || {};
    const csa = tg.contentSafeAreaInset || {};
    const px = (v) => (Number(v) || 0) + "px";
    root.style.setProperty("--tg-safe-top", px((sa.top || 0) + (csa.top || 0)));
    root.style.setProperty("--tg-safe-bottom", px((sa.bottom || 0) + (csa.bottom || 0)));
    root.style.setProperty("--tg-safe-left", px((sa.left || 0) + (csa.left || 0)));
    root.style.setProperty("--tg-safe-right", px((sa.right || 0) + (csa.right || 0)));
  };
  applySafeArea();
  try {
    tg.onEvent?.("safeAreaChanged", applySafeArea);
    tg.onEvent?.("contentSafeAreaChanged", applySafeArea);
    tg.onEvent?.("fullscreenChanged", applySafeArea);
  } catch (e) {}
}

// Обёртка fetch, которая всегда подкладывает initData в заголовок —
// именно так бэкенд проверяет, что запрос действительно от Telegram.
export async function apiFetch(path, { method = "GET", body, tg } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (tg && tg.initData) headers["X-Telegram-Init-Data"] = tg.initData;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
