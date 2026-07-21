// open-sse/executors/doubao-web.js
/**
 * DoubaoWebExecutor — Dola Global web chat via dola.com.
 * Provider id tetap `doubao-web` untuk kompatibilitas koneksi lama.
 * Endpoint: POST https://www.dola.com/chat/completion
 * Auth: Session cookies dari www.dola.com
 */
const { randomUUID } = require("node:crypto");
const { BaseExecutor } = require("./base.js");
const { makeExecutorErrorResult: makeErrorResult, normalizeCookie } = require("../utils/error.js");

const BASE_URL = "https://www.dola.com";
const CHAT_URL = `${BASE_URL}/chat/completion`;
const DEFAULT_MODEL = "dola-speed";
const DOLA_BOT_ID = "7339470689562525703";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function toContentText(value) {
  return typeof value === "string" ? value : "";
}
function parseJsonRecord(raw) {
  if (!raw.startsWith("{")) return null;
  try { return asRecord(JSON.parse(raw)); } catch { return null; }
}
function randomNumericId(length = 19) {
  const digit = (max) => {
    const limit = 256 - (256 % max);
    const buf = new Uint8Array(1);
    let b;
    do { globalThis.crypto.getRandomValues(buf); b = buf[0]; } while (b >= limit);
    return b % max;
  };
  let id = String(digit(9) + 1);
  for (let i = 1; i < length; i += 1) id += String(digit(10));
  return id;
}
// ... (sisanya sama persis, tinggal hapus semua anotasi tipe seperti di atas)

class DoubaoWebExecutor extends BaseExecutor {
  constructor() {
    super("doubao-web", { id: "doubao-web", baseUrl: BASE_URL });
  }
  // ... method createHeaders, collectText, createStream, execute — sama,
  // cuma buang `: ExecuteInput`, `: Response`, `?: AbortSignal | null`, dst.
}

module.exports = { DoubaoWebExecutor, foldMessages, extractCookieValue, resolveDolaFingerprint,
  buildDolaCookieHeader, buildDolaQueryParams, resolveDolaDeepThinkValue, buildDolaPayload,
  extractDolaTextDeltas, isDolaBusyMessage };
