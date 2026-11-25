// Zoom Scribe wire protocol and routing facts, shared by the Live socket
// (zoomScribeStreaming.js) and the Fast HTTP client (zoomScribeTranscription.js).
// Pure ESM: no sockets, no Electron, no logger, so both transports and the tests
// build the same payloads.

export const ZOOM_SCRIBE_LIVE_URL = "wss://api.zoom.us/v2/aiservices/scribe/live";
export const ZOOM_SCRIBE_FAST_URL = "https://api.zoom.us/v2/aiservices/scribe/transcribe";
export const ZOOM_SCRIBE_LIVE_SUBPROTOCOL = "live-asr";
// Live accepts only 16 kHz mono PCM16. Other input rates are resampled by the client;
// `audio.sample_rate` in session.update is ignored by the server.
export const ZOOM_SCRIBE_LIVE_SAMPLE_RATE = 16000;
export const ZOOM_SCRIBE_TRACKING_PREFIX = "zoom_ai_community_openwhispr_";

// Application limit for the complete encoded JSON body, not a server guarantee.
// Historical gateway probes accepted 65 MB and rejected 72 MB; published limits
// differ. A server 413/415 can therefore trigger one compression retry below this cap.
export const ZOOM_SCRIBE_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

// Containers Zoom Scribe documents for Fast. Anything else is re-encoded to m4a
// before it is sent, so an unverified format cannot reach the endpoint as-is.
export const ZOOM_SCRIBE_DOCUMENTED_MIME_TYPES = Object.freeze(
  new Set(["audio/wav", "audio/mpeg", "audio/mp4", "video/mp4", "audio/webm"])
);

export const ZOOM_SCRIBE_DEFAULT_MODEL = "zoom-scribe-multilingual";
// Models that only transcribe English. Anything else is coerced to en-US.
const ENGLISH_ONLY_MODELS = new Set(["zoom-scribe-en", "zoom-scribe-en-pro"]);

// Base language code -> Zoom locale for the multilingual model.
export const ZOOM_SCRIBE_LOCALES = Object.freeze({
  en: "en-US",
  ar: "ar-SA",
  zh: "zh-CN",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  pt: "pt-BR",
  es: "es-ES",
});

// Korean is available through Multilingual, not a standalone Scribe model.
export const ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS = Object.freeze(
  Object.fromEntries(
    Object.entries(ZOOM_SCRIBE_LOCALES)
      .filter(([language]) => language !== "ko")
      .map(([language, locale]) => [`zoom-scribe-${language}`, locale])
  )
);
export const ZOOM_SCRIBE_MODELS = Object.freeze([
  ZOOM_SCRIBE_DEFAULT_MODEL,
  ...Object.keys(ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS),
  "zoom-scribe-en-pro",
]);

export function isZoomScribeSingleLanguageModel(model) {
  return Object.hasOwn(ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS, model);
}

export const ZOOM_SCRIBE_VOCABULARY_LIMIT = 100;
export const ZOOM_SCRIBE_VOCABULARY_TERM_CHARS = 50;
export const ZOOM_SCRIBE_SILENCE_MS = 600;
// Scribe closes a Live session that receives no audio after roughly 15 s (measured
// against the live endpoint: abnormal close, no session.closed, no error). A warm
// connection is therefore dropped after 10 s of idle time, leaving margin, and the
// next dictation reconnects. No keepalive audio is sent, since it is billed.
export const ZOOM_SCRIBE_WARM_IDLE_MS = 10000;

export function isZoomEnglishOnlyModel(model) {
  return ENGLISH_ONLY_MODELS.has(model);
}

// A stale or unknown id falls back to the default, matching resolveByokModel.
export function normalizeZoomScribeModel(model) {
  return ZOOM_SCRIBE_MODELS.includes(model) ? model : ZOOM_SCRIBE_DEFAULT_MODEL;
}

// Returns what to send for a requested model and base language:
//   { detect: true }            -> config.language_detection, no language field
//   { language: "<locale>" }    -> pinned locale
// `adjusted` names the fallback the caller should log at debug level, or null.
export function resolveZoomScribeLanguage({ model, language }) {
  const base = typeof language === "string" ? language.split("-")[0].toLowerCase() : "";
  const requestedAuto = !base || base === "auto";
  if (isZoomEnglishOnlyModel(model)) {
    if (requestedAuto || base === "en") return { language: "en-US", adjusted: null };
    return { language: "en-US", adjusted: "english-only-model" };
  }
  if (isZoomScribeSingleLanguageModel(model)) {
    const locale = ZOOM_SCRIBE_SINGLE_LANGUAGE_MODELS[model];
    return {
      language: locale,
      adjusted: requestedAuto || base === locale.split("-")[0] ? null : "single-language-model",
    };
  }
  // Multilingual always detects continuously, independently of app language.
  return { detect: true, adjusted: null };
}

// Plain transcript fields can contain literal speaker/channel text. Do not strip
// bracketed words: polishing is disabled and speaker identity is structured.
export function stripSpeakerTags(text) {
  return typeof text === "string" ? text.trim() : "";
}

export function cleanZoomScribeText(text, model) {
  text = stripSpeakerTags(text);
  if (model !== "zoom-scribe-zh") return text;
  // Preserve Latin word spaces and line breaks, including mixed-language speech.
  return text.replace(
    /([\p{Script=Han}，。！？；：、（）《》“”‘’])[ \t]+(?=[\p{Script=Han}，。！？；：、（）《》“”‘’])/gu,
    "$1"
  );
}

export function joinZoomScribeTurns(turns, model) {
  return cleanZoomScribeText(turns.join(" "), model);
}

export function normalizeVocabulary(terms) {
  if (!Array.isArray(terms)) return [];
  return terms
    .map((term) =>
      typeof term === "string" ? term.trim().slice(0, ZOOM_SCRIBE_VOCABULARY_TERM_CHARS) : ""
    )
    .filter(Boolean)
    .slice(0, ZOOM_SCRIBE_VOCABULARY_LIMIT);
}

function languageFields(resolved) {
  return resolved.detect
    ? { language_detection: { mode: "continuous" } }
    : { language: resolved.language };
}

// First frame on the Live socket. Audio is sent only after session.updated.
export function buildLiveSessionUpdate({ model, language, keyterms, interimResults = true }) {
  const resolved = resolveZoomScribeLanguage({ model, language });
  const phrases = normalizeVocabulary(keyterms);
  const config = {
    model,
    interim_results: interimResults,
    ...(phrases.length > 0 ? { vocabulary: { phrases } } : {}),
    ...languageFields(resolved),
  };
  return {
    type: "session.update",
    audio: { format: "pcm16" },
    config,
    outputs: { text_polishing: { enabled: false } },
    turn_detection: { silence_duration_ms: ZOOM_SCRIBE_SILENCE_MS },
  };
}

// Fast request body. `file` is a data URL; the caller decides the container.
export function buildFastRequestBody({ audioBase64, mimeType, model, language, keyterms }) {
  const resolved = resolveZoomScribeLanguage({ model, language });
  const phrases = normalizeVocabulary(keyterms);
  return {
    outputs: { text_polishing: { enabled: false } },
    file: `data:${mimeType};base64,${audioBase64}`,
    config: {
      ...languageFields(resolved),
      model,
      ...(phrases.length > 0 ? { vocabulary: { phrases } } : {}),
    },
  };
}

// Prefers result.text_display; falls back to joining segment texts.
export function parseFastResponse(payload, model) {
  const result = payload?.result;
  if (typeof result?.text_display === "string")
    return cleanZoomScribeText(result.text_display, model);
  if (Array.isArray(result?.segments)) {
    return cleanZoomScribeText(
      result.segments
        .map((segment) => (typeof segment?.text === "string" ? segment.text : ""))
        .join(" "),
      model
    );
  }
  return "";
}

export function encodedBodyBytes(body) {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}
