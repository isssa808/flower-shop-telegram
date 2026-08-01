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
    showAlert(msg) { alert(msg); },
    showConfirm(msg, cb) { cb(confirm(msg)); },
  };
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
