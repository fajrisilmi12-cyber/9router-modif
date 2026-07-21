import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
// ⚠️ perlu dicek: apakah utils/error.js sudah punya fungsi ini
import { makeExecutorErrorResult as makeErrorResult, normalizeCookie } from "../utils/error.js";

const BASE_URL = "https://www.dola.com";
const CHAT_URL = `${BASE_URL}/chat/completion`;
const DEFAULT_MODEL = "dola-speed";
const DOLA_BOT_ID = "7339470689562525703";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function toString(value) { return typeof value === "string" ? value.trim() : ""; }
function toContentText(value) { return typeof value === "string" ? value : ""; }
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
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = asRecord(part);
      if (item.type === "text") return toContentText(item.text);
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function isDolaReasoningModel(modelId) { return modelId === "dola-pro" || modelId === "dola-deep-think"; }
function createDolaTextExtractionState(modelId) {
  const deferUntilAnswer = isDolaReasoningModel(modelId);
  return { deferUntilAnswer, answerStarted: !deferUntilAnswer, bufferedDeltas: [] };
}
function isDolaAnswerBoundary(block) { return block.block_type === 10040 && block.is_finish === true; }

export function foldMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    const item = asRecord(message);
    const role = toString(item.role) || "user";
    const text = contentToText(item.content);
    return text ? `${role}: ${text}` : "";
  }).filter(Boolean).join("\n\n");
}

export function extractCookieValue(cookieHeader, name) {
  const pattern = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`);
  const value = pattern.exec(cookieHeader)?.[1] ?? "";
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}
function extractQueryValue(raw, name) {
  if (!raw.includes("?") && !raw.includes("&")) return "";
  try {
    const url = raw.startsWith("http") ? new URL(raw) : new URL(`https://www.dola.com/?${raw}`);
    return toString(url.searchParams.get(name));
  } catch { return ""; }
}

export function resolveDolaFingerprint(cookieHeader, providerSpecificData, rawCredential = "") {
  const data = asRecord(providerSpecificData);
  return (
    toString(data.s_v_web_id) || toString(data.sVWebId) ||
    extractCookieValue(cookieHeader, "s_v_web_id") || toString(data.fp) ||
    extractCookieValue(cookieHeader, "fp") || extractQueryValue(rawCredential, "fp")
  );
}

export function buildDolaCookieHeader(rawCredential, providerSpecificData) {
  const providerData = asRecord(providerSpecificData);
  const raw = normalizeCookie(rawCredential.trim());
  const parsed = parseJsonRecord(raw);
  const data = { ...providerData, ...(parsed ?? {}) };
  const explicitCookie = normalizeCookie(toString(data.cookie));
  const directCookie = raw && !parsed ? raw : "";
  const cookieSource = explicitCookie || directCookie;
  if (cookieSource.includes("=")) return cookieSource;

  const cookieNames = ["sessionid","ttwid","s_v_web_id","fp","sessionid_ss","sid_guard","sid_tt","uid_tt","uid_tt_ss","passport_auth_status","passport_auth_status_ss","odin_tt"];
  const parts = cookieNames.map((name) => {
    const value = toString(data[name]);
    return value ? `${name}=${value}` : "";
  }).filter(Boolean);
  if (parts.length > 0) return parts.join("; ");
  return raw ? `sessionid=${raw}` : "";
}

export function buildDolaQueryParams(cookieHeader, providerSpecificData, rawCredential = "") {
  const data = asRecord(providerSpecificData);
  const generatedId = randomNumericId();
  const deviceId = toString(data.device_id) || toString(data.deviceId) || generatedId;
  const fp = resolveDolaFingerprint(cookieHeader, providerSpecificData, rawCredential);
  return new URLSearchParams({
    aid: "495671", real_aid: "495671", device_platform: "web", device_id: deviceId,
    web_id: toString(data.web_id) || toString(data.webId) || deviceId,
    tea_uuid: toString(data.tea_uuid) || toString(data.teaUuid) || deviceId,
    web_tab_id: randomUUID(), pc_version: toString(data.pc_version) || "3.25.3",
    pkg_type: "release_version", version_code: "20800", samantha_web: "1",
    web_platform: "browser", "use-olympus-account": "1",
    language: toString(data.language) || "en", region: toString(data.region) || "US",
    sys_region: toString(data.sys_region) || "US", fp,
  });
}

export function resolveDolaDeepThinkValue(modelId, providerSpecificData) {
  const data = asRecord(providerSpecificData);
  const configured = toString(data.use_deep_think) || toString(data.useDeepThink);
  if (configured === "3") return 3;
  if (configured === "0") return 0;
  if (data.deepThink === true || modelId === "dola-pro" || modelId === "dola-deep-think") return 3;
  return 0;
}

export function buildDolaPayload(prompt, modelId = DEFAULT_MODEL, cookieHeader = "", providerSpecificData, rawCredential = "") {
  const data = asRecord(providerSpecificData);
  const localConversationId = toString(data.local_conversation_id) || `local_${randomNumericId(16)}`;
  const blockId = randomUUID();
  const messageId = randomUUID();
  const uniqueKey = randomUUID();
  const now = Date.now();
  const deepThinkValue = resolveDolaDeepThinkValue(modelId, providerSpecificData);
  const fp = resolveDolaFingerprint(cookieHeader, providerSpecificData, rawCredential);

  return {
    client_meta: { local_conversation_id: localConversationId, conversation_id: "", bot_id: toString(data.bot_id) || DOLA_BOT_ID, last_section_id: "", last_message_index: null },
    messages:
