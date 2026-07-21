import { randomUUID } from "node:crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { errorResponse } from "../utils/error.js";
import { sseChunk } from "../utils/sse.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";

const CHAT_URL = PROVIDERS["doubao-web"].baseUrl; // https://www.dola.com/chat/completion
const DEFAULT_MODEL = "dola-speed";
const DOLA_BOT_ID = "7339470689562525703";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// --- helpers (sama seperti sebelumnya, tidak berubah) ---
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
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

// ⚠️ Tidak ada normalizeCookie di 9router — dibuat versi lokal minimal
function normalizeCookie(raw) {
  if (!raw) return "";
  return raw.replace(/^Cookie:\s*/i, "").trim();
}

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
  const raw = normalizeCookie((rawCredential || "").trim());
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
    messages: [{ local_message_id: messageId, content_block: [{ block_type: 10000, content: { text_block: { text: prompt, icon_url: "", icon_url_dark: "", summary: "" }, pc_event_block: "" }, block_id: blockId, parent_id: "", meta_info: [], append_fields: [] }], message_status: 0 }],
    option: { send_message_scene: "", create_time_ms: now, collect_id: "", is_audio: false, answer_with_suggest: false, tts_switch: false, need_deep_think: deepThinkValue, click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false, is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false, select_text_action: "", is_select_text: false, resend_for_regen: false, scene_type: 0, unique_key: uniqueKey, start_seq: 0, need_create_conversation: true, conversation_init_option: { need_ack_conversation: true }, regen_query_id: [], edit_query_id: [], regen_instruction: "", no_replace_for_regen: false, message_from: 0, shared_app_name: "", shared_app_id: "", sse_recv_event_options: { support_chunk_delta: true }, is_ai_playground: false, is_old_user: false, recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 }, message_storage_type: 0 },
    user_context: [],
    ext: { use_deep_think: String(deepThinkValue), fp, sub_conv_firstmet_type: "1", collection_id: "", conversation_init_option: JSON.stringify({ need_ack_conversation: true }), commerce_credit_config_enable: "0" },
  };
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
  const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") return { event: event || "done", data: "[DONE]" };
  try { return { event: event || "", data: JSON.parse(rawData) }; } catch { return null; }
}

function extractDolaBlockDeltas(blocks, state) {
  const deltas = [];
  for (const block of blocks) {
    const blockRecord = asRecord(block);
    if (state && isDolaAnswerBoundary(blockRecord)) { state.answerStarted = true; state.bufferedDeltas = []; continue; }
    const text = toContentText(asRecord(asRecord(blockRecord.content).text_block).text);
    if (!text) continue;
    if (!state || state.answerStarted) deltas.push(text); else state.bufferedDeltas.push(text);
  }
  return deltas;
}
function flushDolaTextExtractionState(state) {
  if (state.answerStarted) return [];
  const fallback = state.bufferedDeltas;
  state.bufferedDeltas = []; state.answerStarted = true;
  return fallback;
}
export function extractDolaTextDeltas(data, state) {
  const root = asRecord(data);
  const payload = asRecord(root.data);
  const content = asRecord(root.content);
  const payloadContent = asRecord(payload.content);
  const initialBlocks = Array.isArray(content.content_block) ? content.content_block : Array.isArray(payloadContent.content_block) ? payloadContent.content_block : [];
  const patchOps = Array.isArray(root.patch_op) ? root.patch_op : Array.isArray(payload.patch_op) ? payload.patch_op : [];
  const deltas = extractDolaBlockDeltas(initialBlocks, state);
  for (const op of patchOps) {
    const patchValue = asRecord(asRecord(op).patch_value);
    const blocks = Array.isArray(patchValue.content_block) ? patchValue.content_block : [];
    deltas.push(...extractDolaBlockDeltas(blocks, state));
  }
  return deltas;
}
function extractDolaError(data) {
  const root = asRecord(data);
  const payload = asRecord(root.data);
  return toString(root.message) || toString(payload.message) || toString(payload.error_msg) || toString(payload.errorMessage);
}
export function isDolaBusyMessage(content) {
  const normalized = content.trim().toLowerCase();
  return normalized.includes("a lot of people are using the app right now") && normalized.includes("try again later");
}

export class DoubaoWebExecutor extends BaseExecutor {
  constructor() {
    super("doubao-web", PROVIDERS["doubao-web"]);
  }

  createHeaders(cookieHeader) {
    const headers = { "Content-Type": "application/json", "User-Agent": USER_AGENT, Accept: "text/event-stream", Referer: "https://www.dola.com/chat/", Origin: "https://www.dola.com", "Agw-Js-Conv": "str" };
    if (cookieHeader) headers.Cookie = cookieHeader;
    return headers;
  }

  async collectText(upstream, modelId) {
    const raw = await upstream.text();
    const state = createDolaTextExtractionState(modelId);
    const deltas = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const event = parseSseBlock(block);
      if (event) deltas.push(...extractDolaTextDeltas(event.data, state));
    }
    deltas.push(...flushDolaTextExtractionState(state));
    return deltas.join("");
  }

  // Pakai sseChunk/SSE_DONE dari util 9router sendiri, samakan format dgn grok-web.js
  createStream(upstream, modelId, cid, created, signal) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state = createDolaTextExtractionState(modelId);
    let sentDone = false;

    return new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model: modelId,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })));

        const reader = upstream.body?.getReader();
        if (!reader) { controller.enqueue(encoder.encode(SSE_DONE)); controller.close(); return; }
        let buffer = ""; let errored = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() || "";
            for (const block of blocks) {
              const event = parseSseBlock(block);
              if (!event) continue;
              if (event.event === "STREAM_ERROR") {
                errored = true;
                controller.error(new Error(extractDolaError(event.data) || "Dola stream error"));
                return;
              }
              for (const text of extractDolaTextDeltas(event.data, state)) {
                controller.enqueue(encoder.encode(sseChunk({
                  id: cid, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                })));
              }
              if (event.event === "SSE_REPLY_END") sentDone = true;
            }
          }
        } catch (err) {
          if (!signal?.aborted) { errored = true; controller.error(err); }
          return;
        } finally {
          if (errored) return;
          for (const text of flushDolaTextExtractionState(state)) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            })));
          }
          controller.enqueue(encoder.encode(sseChunk({
            id: cid, object: "chat.completion.chunk", created, model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })));
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
        }
      },
    });
  }

  // ⚠️ Override total execute(), sama seperti GrokWebExecutor — tidak pakai retry-loop generik base.js
  async execute({ model, body, stream, credentials, signal, log }) {
    const bodyObj = asRecord(body);
    const providerSpecificData = credentials?.providerSpecificData;
    const rawCredential = toString(credentials?.apiKey);
    const cookieHeader = buildDolaCookieHeader(rawCredential, providerSpecificData);
    const requestedModel = toString(bodyObj.model) || model || DEFAULT_MODEL;
    const modelId = requestedModel.split("/").pop() || DEFAULT_MODEL;
    const prompt = foldMessages(bodyObj.messages);
    const fingerprint = resolveDolaFingerprint(cookieHeader, providerSpecificData, rawCredential);
    const transformedBody = buildDolaPayload(prompt, modelId, cookieHeader, providerSpecificData, rawCredential);
    const query = buildDolaQueryParams(cookieHeader, providerSpecificData, rawCredential);
    const url = `${CHAT_URL}?${query.toString()}`;
    const headers = this.createHeaders(cookieHeader);

    if (!extractCookieValue(cookieHeader, "sessionid")) {
      const resp = errorResponse(401, "Dola Web requires a www.dola.com Cookie header containing at least sessionid, ttwid, and s_v_web_id.");
      return { response: resp, url, headers, transformedBody };
    }
    if (!fingerprint) {
      const resp = errorResponse(401, "Dola Web requires the browser fingerprint value from www.dola.com (s_v_web_id or fp).");
      return { response: resp, url, headers, transformedBody };
    }

    let upstream;
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(transformedBody), signal });
    } catch (err) {
      log?.error?.("DOUBAO-WEB", `Fetch failed: ${err.message || String(err)}`);
      const resp = errorResponse(502, `Dola fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
      return { response: resp, url, headers, transformedBody };
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      return { response: errorResponse(upstream.status, `Dola error: ${errText}`), url, headers, transformedBody };
    }

    const contentType = upstream.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      const text = await upstream.text().catch(() => "");
      return { response: errorResponse(502, `Dola returned non-SSE response: ${text}`), url, headers, transformedBody };
    }

    const cid = `chatcmpl-dola-${randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      const content = await this.collectText(upstream, modelId);
      if (isDolaBusyMessage(content)) {
        return { response: errorResponse(429, "Dola is temporarily busy. Please try again later."), url, headers, transformedBody };
      }
      const resp = new Response(JSON.stringify({
        id: cid, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      return { response: resp, url, headers, transformedBody };
    }

    const sseStream = this.createStream(upstream, modelId, cid, created, signal);
    const resp = new Response(sseStream, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
    return { response: resp, url, headers, transformedBody };
  }
}

export default DoubaoWebExecutor;
