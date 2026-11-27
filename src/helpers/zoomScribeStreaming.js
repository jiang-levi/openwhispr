// Zoom Scribe Live (WebSocket) client. Runs in the main process: the Authorization
// and x-zm-trackingid headers and the live-asr subprotocol are set on the `ws`
// handshake, which renderer WebSockets cannot do.
//
// Interface matches the dictation-realtime surface: sendAudio() with PCM16 at the
// rate given to connect() (16 kHz when none is given; other rates are resampled
// to 16 kHz before they reach the socket), onPartialTranscript (the current full
// hypothesis, replaced each time), onFinalTranscript(accumulatedText, timestampMs),
// and disconnect() returning { text } after session.close -> session.closed.
//
// The meeting path (meetingStreamingProviders.js) also reads completedSegments
// (one entry per completed turn), audioBytesSent, sessionStartedAt, and
// onConnectionLost. Like the other clients, onFinalTranscript carries the
// accumulated text; a meeting reads its per-turn text from completedSegments.
import WebSocket from "ws";
import {
  ZOOM_SCRIBE_DEFAULT_MODEL,
  ZOOM_SCRIBE_LIVE_SAMPLE_RATE,
  ZOOM_SCRIBE_LIVE_SUBPROTOCOL,
  ZOOM_SCRIBE_LIVE_URL,
  ZOOM_SCRIBE_TRACKING_PREFIX,
  buildLiveSessionUpdate,
  normalizeZoomScribeModel,
  resolveZoomScribeLanguage,
  cleanZoomScribeText,
  joinZoomScribeTurns,
} from "./zoomScribeProtocol.js";
import { PROVIDER_ERROR_CODES, providerError, providerHttpError } from "./providerHttpErrors.js";
import { ZOOM_SCRIBE_PROVIDER_NAME } from "./zoomScribeTranscription.js";
import { PcmResampler } from "./pcmResampler.js";
import debugLogger from "./debugLogger.js";
import { randomUUID } from "crypto";

const HANDSHAKE_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 5000;
// Audio captured before session.updated is acknowledged. Older frames are dropped.
// Counted in input bytes (the caller's rate, before resampling).
const MAX_PENDING_SECONDS = 5;

const defaultCreateSocket = (url, protocols, options) => new WebSocket(url, protocols, options);

// A Live `error` event as a provider error. UNSUPPORTED_MODEL is the premium
// model case (zoom-scribe-en-pro); providerHttpError turns it into a model message.
export function zoomLiveErrorFromEvent(error, model) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  const detail = { underlyingError: `${code} ${message}`.trim().slice(0, 300) };
  const ctx = { provider: ZOOM_SCRIBE_PROVIDER_NAME, model, surface: "transcription" };
  if (/UNSUPPORTED_MODEL/i.test(code) || /UNSUPPORTED_MODEL/i.test(message)) {
    return providerHttpError({
      ...ctx,
      status: 400,
      body: JSON.stringify({ code, message }),
    });
  }
  if (/PERMISSION|PREMIUM|PLAN/i.test(code)) {
    return providerError(PROVIDER_ERROR_CODES.ACCESS_DENIED, { ...ctx, technicalDetails: detail });
  }
  return providerError(PROVIDER_ERROR_CODES.ERROR, { ...ctx, technicalDetails: detail });
}

// Handshake refusals (HTTP 401 with a JSON body, etc.) are classified like any
// other provider HTTP failure.
export function zoomLiveHandshakeError({ status, body, model }) {
  return providerHttpError({
    provider: ZOOM_SCRIBE_PROVIDER_NAME,
    model,
    status,
    body,
    surface: "transcription",
  });
}

export class ZoomScribeStreaming {
  constructor({ createSocket = defaultCreateSocket } = {}) {
    this.createSocket = createSocket;
    this.ws = null;
    this.isConnected = false;
    this.sessionReady = false;
    this.model = null;
    this.language = null;
    this.connectionKey = null;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onLanguage = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.completedSegments = [];
    this.partialText = "";
    this.bufferingAudio = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.maxPendingBytes = ZOOM_SCRIBE_LIVE_SAMPLE_RATE * 2 * MAX_PENDING_SECONDS;
    this.closing = false;
    this.closedWaiter = null;
    this.pendingConnect = null;
    this.trackingId = null;
    // True once audio has reached the socket in this session. A close before that
    // is the server ending an idle warm connection, which is not a user error.
    this.audioSent = false;
    // Input (caller-rate) bytes accepted into this session. Replay logic only tests
    // it for 0, so it counts what the caller sent, as the Deepgram client does.
    this.audioBytesSent = 0;
    // Wall-clock ms of the session's first sample. Final timestamps are this plus
    // the server's audio_start_ms. The meeting path re-anchors it to the first
    // chunk's capture time.
    this.sessionStartedAt = null;
    this.onConnectionLost = null;
    this.connectionLossNotified = false;
    // Converts the caller's rate to the Live rate. Null when no conversion is needed.
    this.resampler = null;
  }

  beginConnecting() {
    this.bufferingAudio = true;
    this.pendingAudio = [];
    this.pendingBytes = 0;
  }

  getFullTranscript() {
    return joinZoomScribeTurns(this.completedSegments, this.model);
  }

  async connect({
    apiKey,
    model,
    language,
    keyterms,
    sampleRate,
    interimResults = true,
    context,
  } = {}) {
    if (!apiKey) {
      throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
        provider: ZOOM_SCRIBE_PROVIDER_NAME,
        surface: "transcription",
      });
    }
    if (sampleRate != null && !(Number.isFinite(sampleRate) && sampleRate > 0)) {
      throw new RangeError(`Zoom Scribe sampleRate must be a positive number, got ${sampleRate}`);
    }
    if (this.isConnected) return;
    this.pendingConnect?.(new DOMException("Zoom Scribe connection superseded", "AbortError"));
    // A socket the server already closed is dropped without touching the buffered
    // audio, which belongs to the dictation that is starting.
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close?.();
      } catch {
        // Closing an already-closed socket is not an error.
      }
    }
    this.sessionReady = false;
    this.isConnected = false;
    this.maxPendingBytes = (sampleRate ?? ZOOM_SCRIBE_LIVE_SAMPLE_RATE) * 2 * MAX_PENDING_SECONDS;
    this.audioSent = false;
    this.audioBytesSent = 0;
    this.connectionLossNotified = false;
    this.completedSegments = [];
    this.partialText = "";
    this.closing = false;
    this.resampler =
      sampleRate != null && sampleRate !== ZOOM_SCRIBE_LIVE_SAMPLE_RATE
        ? new PcmResampler({ inputRate: sampleRate, outputRate: ZOOM_SCRIBE_LIVE_SAMPLE_RATE })
        : null;
    model = normalizeZoomScribeModel(model);
    // Decide after normalization: stale IDs can resolve to Multilingual too.
    // Meeting callers keep live captions, including one-speaker mono streams.
    if (context === "dictation" && model === ZOOM_SCRIBE_DEFAULT_MODEL) interimResults = false;
    this.model = model;
    this.language = language ?? null;
    this.trackingId = `${ZOOM_SCRIBE_TRACKING_PREFIX}${randomUUID()}`;
    if (!this.bufferingAudio) this.beginConnecting();

    const resolved = resolveZoomScribeLanguage({ model, language });
    if (resolved.adjusted) {
      debugLogger.debug("Zoom Scribe Live language adjusted", {
        reason: resolved.adjusted,
        model,
        requestedLanguage: language || null,
      });
    }
    const update = buildLiveSessionUpdate({ model, language, keyterms, interimResults });

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingConnect = null;
        if (error) {
          this.teardown();
          reject(error);
        } else {
          resolve();
        }
      };
      this.pendingConnect = finish;
      const timer = setTimeout(
        () => finish(new Error("Zoom Scribe WebSocket connection timeout")),
        HANDSHAKE_TIMEOUT_MS
      );

      let ws;
      try {
        ws = this.createSocket(ZOOM_SCRIBE_LIVE_URL, [ZOOM_SCRIBE_LIVE_SUBPROTOCOL], {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "x-zm-trackingid": this.trackingId,
          },
        });
      } catch (error) {
        finish(error);
        return;
      }
      this.ws = ws;

      ws.on("open", () => {
        if (this.ws !== ws) return;
        ws.send(JSON.stringify(update));
      });

      ws.on("unexpected-response", (_request, response) => {
        if (this.ws !== ws) return;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          finish(
            zoomLiveHandshakeError({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
              model,
            })
          );
        });
        response.on("error", () =>
          finish(zoomLiveHandshakeError({ status: response.statusCode, body: "", model }))
        );
      });

      // Events from a socket this session already retired are ignored.
      const current = () => this.ws === ws;

      ws.on("message", (data) => {
        if (current()) this.handleMessage(data, { onReady: finish, model });
      });

      ws.on("error", (error) => {
        if (!current()) return;
        if (!settled) return finish(error);
        this.teardown();
        this.notifyConnectionLost(error);
      });

      ws.on("close", (code) => {
        if (!current()) return;
        const wasReady = this.isConnected;
        this.isConnected = false;
        this.sessionReady = false;
        if (this.closedWaiter) this.closedWaiter.resolve();
        if (!settled) return finish(new Error(`Zoom Scribe closed before ready (code: ${code})`));
        if (wasReady && !this.closing) {
          if (!this.audioSent) {
            debugLogger.debug("Zoom Scribe idle connection closed by server", { code });
            return;
          }
          this.notifyConnectionLost(new Error(`Zoom Scribe connection lost (code: ${code})`));
        }
      });
    });

    if (!this.sessionReady || this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Zoom Scribe closed immediately after readiness");
    }
    this.isConnected = true;
    this.sessionStartedAt = Date.now();
    this.flushPendingAudio();
  }

  // Meetings recover from a lost session through onConnectionLost. Dictation has
  // no such hook and reports the loss as an error.
  notifyConnectionLost(error) {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.onConnectionLost) this.onConnectionLost(error);
    else this.emitError(error);
  }

  // Wall-clock time of a completed turn: the session start plus the server's offset
  // for the turn. Falls back to now when the server omits the offset.
  turnTimestamp(audioStartMs) {
    if (this.sessionStartedAt == null || !Number.isFinite(audioStartMs)) return Date.now();
    return Math.round(this.sessionStartedAt + audioStartMs);
  }

  handleMessage(data, { onReady, model } = {}) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (message.type) {
      case "session.updated":
        this.sessionReady = true;
        onReady?.();
        break;
      case "transcription.delta": {
        const text = cleanZoomScribeText(message.delta || "", this.model);
        this.partialText = text;
        this.onPartialTranscript?.(text);
        break;
      }
      case "transcription.completed": {
        const text = cleanZoomScribeText(message.transcript || "", this.model);
        if (message.language && this.onLanguage) {
          this.onLanguage({ language: message.language });
        }
        this.partialText = "";
        this.onPartialTranscript?.("");
        if (text) {
          this.completedSegments.push(text);
          this.onFinalTranscript?.(
            this.getFullTranscript(),
            this.turnTimestamp(message.audio_start_ms)
          );
        }
        break;
      }
      case "error": {
        const error = zoomLiveErrorFromEvent(message.error, model ?? this.model);
        if (message.error?.fatal === false) break;
        if (!this.sessionReady) onReady?.(error);
        else {
          this.teardown();
          this.notifyConnectionLost(error);
        }
        break;
      }
      case "session.closed":
        if (this.closing) this.closedWaiter?.resolve();
        else {
          const hadAudio = this.audioSent;
          this.teardown();
          if (hadAudio)
            this.notifyConnectionLost(new Error("Zoom Scribe session ended unexpectedly"));
        }
        break;
      default:
        break;
    }
  }

  emitError(error) {
    if (this.onError) this.onError(error);
  }

  flushPendingAudio() {
    if (!this.ws || !this.sessionReady) return;
    this.bufferingAudio = false;
    const pending = this.pendingAudio;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    for (const chunk of pending) this.writeAudio(chunk);
  }

  // Sends one caller-rate chunk on the open socket, resampling it first. Returns
  // true once the chunk is accepted, including when the resampler holds it back for
  // lookahead (its samples follow with the next chunk).
  writeAudio(buffer) {
    const wire = this.resampler ? this.resampler.process(buffer) : buffer;
    this.audioBytesSent += buffer.length;
    this.audioSent = true;
    if (wire.length > 0) this.ws.send(wire, { binary: true });
    return true;
  }

  // Returns true when the chunk reached the socket or was accepted by the resampler
  // (the meeting replay relies on that). Returns false when it was dropped or
  // is only buffered before session.updated.
  sendAudio(pcmBuffer) {
    if (this.closing) return false;
    const buffer = pcmBuffer?.length ? Buffer.from(pcmBuffer) : null;
    if (!this.ws || !this.sessionReady) {
      if (buffer && this.bufferingAudio) {
        this.pendingAudio.push(buffer);
        this.pendingBytes += buffer.length;
        // Frames can split a PCM16 sample. Evict a whole number of samples
        // across frame boundaries so the retained stream starts on a low byte.
        let dropBytes = Math.max(0, Math.ceil((this.pendingBytes - this.maxPendingBytes) / 2) * 2);
        while (dropBytes > 0 && this.pendingAudio.length > 0) {
          const first = this.pendingAudio[0];
          const drop = Math.min(first.length, dropBytes);
          if (drop === first.length) this.pendingAudio.shift();
          else this.pendingAudio[0] = first.subarray(drop);
          this.pendingBytes -= drop;
          dropBytes -= drop;
        }
      }
      return false;
    }
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    if (!buffer) return true;
    return this.writeAudio(buffer);
  }

  // Sends the resampler's held-back tail, padded with silence, before the session
  // closes so the last words are not cut off.
  flushResampler() {
    if (!this.resampler) return;
    const tail = this.resampler.flush();
    if (tail.length > 0 && this.ws?.readyState === WebSocket.OPEN && this.sessionReady) {
      this.ws.send(tail, { binary: true });
    }
  }

  // Ends the session and waits for session.closed. The remaining completed events
  // arrive in between, so they are read before the socket is closed.
  disconnect(options = {}) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishDisconnect(options).finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  async finishDisconnect({ commit = true } = {}) {
    const text = this.getFullTranscript();
    if (!this.ws) return { text };
    if (!commit || !this.isConnected) {
      this.teardown();
      return { text };
    }
    this.closing = true;
    const closed = new Promise((resolve) => {
      this.closedWaiter = { resolve };
    });
    try {
      this.flushResampler();
      this.ws.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // The socket is already gone; the close handler finishes the cleanup.
    }
    let timer;
    await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    const finalText = this.getFullTranscript();
    this.teardown();
    this.onSessionEnd?.({ text: finalText });
    return { text: finalText };
  }

  teardown() {
    const socket = this.ws;
    this.ws = null;
    this.isConnected = false;
    this.sessionReady = false;
    this.closing = false;
    this.closedWaiter?.resolve();
    this.closedWaiter = null;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.bufferingAudio = false;
    this.resampler = null;
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    pending?.(new DOMException("Zoom Scribe connection cancelled", "AbortError"));
    if (socket) {
      try {
        socket.removeAllListeners?.("message");
        socket.close?.();
      } catch {
        // Closing an already-closed socket is not an error.
      }
    }
  }

  cleanup() {
    this.teardown();
  }
}
