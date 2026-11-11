const module = { exports: {} };
const exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// registry/src/phone-alerts/src/tools/send_test.ts
var send_test_exports = {};
__export(send_test_exports, {
  default: () => send_test_default
});
module.exports = __toCommonJS(send_test_exports);

// registry/src/phone-alerts/src/send.ts
var DEFAULTS = { via: "ntfy", needsInput: true, finished: false, failed: true };
async function loadConfig(api) {
  return { ...DEFAULTS, ...await api.storage.get("config") ?? {} };
}
async function sendAlert(api, cfg, title, body, urgent = false) {
  const secrets = await api.secrets.list();
  const has = (n) => secrets.some((s) => s.name === n && s.set);
  if (cfg.via === "telegram") {
    if (!has("TELEGRAM_BOT_TOKEN") || !cfg.chatId) return "Telegram needs the TELEGRAM_BOT_TOKEN secret and a chat id";
    const r2 = await api.http.request("POST", "https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendMessage", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: `${title}
${body}`.slice(0, 3500), disable_notification: !urgent })
    });
    return r2.status < 300 ? "sent via Telegram" : `Telegram answered ${r2.status}: ${r2.text.slice(0, 120)}`;
  }
  const topic = (cfg.topic ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(topic)) return "set an ntfy topic first (6-64 letters, digits, - or _)";
  const headers = { Title: title.slice(0, 120), Priority: urgent ? "4" : "3", Tags: urgent ? "warning" : "white_check_mark" };
  if (has("NTFY_TOKEN")) headers.Authorization = "Bearer {{secret:NTFY_TOKEN}}";
  const r = await api.http.request("POST", `https://ntfy.sh/${topic}`, { headers, body: body.slice(0, 3500) });
  return r.status < 300 ? "sent via ntfy" : `ntfy answered ${r.status}: ${r.text.slice(0, 120)}`;
}

// registry/src/phone-alerts/src/tools/send_test.ts
var handler = async (_input, api) => {
  const cfg = await loadConfig(api);
  return sendAlert(api, cfg, "YAAM test alert", "If you can read this on your phone, alerts work.");
};
var send_test_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);