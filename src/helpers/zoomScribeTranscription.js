// Zoom Scribe Fast (synchronous HTTP) client. Runs in the main process: the key
// never reaches the renderer and the request goes through proxyFetch.
import {
  ZOOM_SCRIBE_BODY_LIMIT_BYTES,
  ZOOM_SCRIBE_DOCUMENTED_MIME_TYPES,
  ZOOM_SCRIBE_FAST_URL,
  buildFastRequestBody,
  encodedBodyBytes,
  normalizeZoomScribeModel,
  parseFastResponse,
  resolveZoomScribeLanguage,
} from "./zoomScribeProtocol.js";
import { PROVIDER_ERROR_CODES, providerError, providerHttpError } from "./providerHttpErrors.js";
import { normalizeAudioMime, sniffAudioMime } from "./audioContentSniff.js";
import debugLogger from "./debugLogger.js";

export const ZOOM_SCRIBE_PROVIDER_NAME = "Zoom Scribe";

function logLanguageAdjustment(resolved, model, language) {
  if (!resolved.adjusted) return;
  debugLogger.debug("Zoom Scribe language adjusted", {
    reason: resolved.adjusted,
    model,
    requestedLanguage: language || null,
  });
}

// Builds the encoded request body and reports its size. Returns the body so the
// caller sends exactly what was measured.
export function buildZoomScribeFastBody({ audioBuffer, mimeType, model, language, keyterms }) {
  const body = buildFastRequestBody({
    audioBase64: Buffer.from(audioBuffer).toString("base64"),
    mimeType,
    model,
    language,
    keyterms,
  });
  return { body, bytes: encodedBodyBytes(body) };
}

async function postFast({ apiKey, body, model, proxyFetch }) {
  const response = await proxyFetch(ZOOM_SCRIBE_FAST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    debugLogger.warn("Zoom Scribe transcription failed", {
      status: response.status,
      model,
    });
    throw providerHttpError({
      provider: ZOOM_SCRIBE_PROVIDER_NAME,
      model,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }
  return response.json();
}

/**
 * Transcribes one recording through the Fast endpoint.
 *
 * The container is decided from the bytes when possible (falling back to the
 * declared MIME type). Only Zoom's documented containers are sent as-is; anything
 * else, or a body over the cap, is re-encoded once with `transcodeToM4a`. A result
 * still over the cap raises PAYLOAD_TOO_LARGE.
 */
export async function transcribeWithZoomScribe({
  apiKey,
  audioBuffer,
  mimeType,
  model: requestedModel,
  language,
  keyterms,
  proxyFetch,
  transcodeToM4a,
  limitBytes = ZOOM_SCRIBE_BODY_LIMIT_BYTES,
}) {
  if (!apiKey) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: ZOOM_SCRIBE_PROVIDER_NAME,
      surface: "transcription",
    });
  }
  const model = normalizeZoomScribeModel(requestedModel);
  const resolved = resolveZoomScribeLanguage({ model, language });
  logLanguageAdjustment(resolved, model, language);

  const effectiveMime = sniffAudioMime(audioBuffer) ?? normalizeAudioMime(mimeType);
  const documented = ZOOM_SCRIBE_DOCUMENTED_MIME_TYPES.has(effectiveMime);

  let source = audioBuffer;
  let sendMime = effectiveMime;
  let built = null;
  if (documented) {
    built = buildZoomScribeFastBody({
      audioBuffer,
      mimeType: effectiveMime,
      model,
      language,
      keyterms,
    });
  }
  if (!documented || built.bytes > limitBytes) {
    const oversize = documented;
    if (!transcodeToM4a) {
      throw providerError(
        oversize ? PROVIDER_ERROR_CODES.PAYLOAD_TOO_LARGE : PROVIDER_ERROR_CODES.BAD_REQUEST,
        { provider: ZOOM_SCRIBE_PROVIDER_NAME, surface: "transcription" }
      );
    }
    source = await transcodeToM4a(audioBuffer);
    sendMime = "audio/mp4";
    built = buildZoomScribeFastBody({
      audioBuffer: source,
      mimeType: sendMime,
      model,
      language,
      keyterms,
    });
    if (built.bytes > limitBytes) {
      throw providerError(PROVIDER_ERROR_CODES.PAYLOAD_TOO_LARGE, {
        provider: ZOOM_SCRIBE_PROVIDER_NAME,
        surface: "transcription",
      });
    }
  }

  const payload = await postFast({ apiKey, body: built.body, model, proxyFetch });
  return { text: parseFastResponse(payload), model, mimeType: sendMime };
}

// The dictation batch proxy (proxy-zoom-scribe-transcription). The renderer sends
// the custom dictionary as `vocabulary`; it must reach the request as keyterms.
export function transcribeZoomScribeProxyRequest(
  { audioBuffer, mimeType, model, language, vocabulary },
  { apiKey, proxyFetch, transcodeToM4a }
) {
  return transcribeWithZoomScribe({
    apiKey,
    audioBuffer: Buffer.from(audioBuffer),
    mimeType,
    model,
    language,
    keyterms: vocabulary,
    proxyFetch,
    transcodeToM4a,
  });
}
