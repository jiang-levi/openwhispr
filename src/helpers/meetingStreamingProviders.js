const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const DeepgramStreaming = require("./deepgramStreaming");
const CortiStreaming = require("./cortiStreaming");
const { TinfoilRealtimeStreaming } = require("./tinfoilRealtimeStreaming");
const { ZoomScribeStreaming } = require("./zoomScribeStreaming");

const STREAMING_CLIENT_BY_PROVIDER = {
  "openai-realtime": OpenAIRealtimeStreaming,
  "enterprise-realtime": OpenAIRealtimeStreaming,
  "assemblyai-realtime": AssemblyAiStreaming,
  "deepgram-realtime": DeepgramStreaming,
  "corti-realtime": CortiStreaming,
  "tinfoil-realtime": TinfoilRealtimeStreaming,
  "zoom-realtime": ZoomScribeStreaming,
};

// Derived from the registry so an allowed provider can never lack a client
// class and silently fall through to the OpenAI default.
const ALLOWED_MEETING_PROVIDERS = new Set(["local", ...Object.keys(STREAMING_CLIENT_BY_PROVIDER)]);

const getMeetingStreamingClient = (provider) => {
  const StreamingClient = STREAMING_CLIENT_BY_PROVIDER[provider];
  if (!StreamingClient) throw new Error(`Unsupported meeting streaming provider: ${provider}`);
  return StreamingClient;
};

// These authenticate with saved credentials whatever the mode says.
// Zoom Scribe reads its saved key in every mode, as Corti and Tinfoil do.
const SAVED_KEY_PROVIDERS = new Set(["corti-realtime", "tinfoil-realtime", "zoom-realtime"]);

// A connection that authenticates with a saved key also records the count of key
// saves it opened under, so a start never reuses one opened before a save.
const getMeetingConnectionKey = (options = {}, credentialGeneration = null) =>
  JSON.stringify({
    provider: options.provider,
    model: options.model,
    language: options.language,
    mode: options.mode,
    environment: options.environment,
    tenant: options.tenant,
    keyterms: options.keyterms,
    managedContext: options.managedContext,
    enterpriseConnection: options.enterpriseConnection,
    credentialGeneration:
      options.mode === "enterprise" ||
      options.mode === "byok" ||
      SAVED_KEY_PROVIDERS.has(options.provider)
        ? credentialGeneration
        : null,
  });

// Every meeting stream's audio goes through here. A session's timestamps count from
// its first sample (Deepgram's `start`, Zoom's `audio_start_ms`), so the first chunk
// that reaches a fresh session sets its start to that chunk's capture time. That
// holds for replayed reconnect audio too: the replay's oldest chunk becomes the
// new session's origin. Returns the client's sendAudio result, which replay checks.
const sendMeetingStreamingAudio = (streaming, buffer, capturedAt = null) => {
  const firstSampleAt = streaming.audioBytesSent === 0 ? capturedAt : null;
  const sent = streaming.sendAudio(buffer);
  if (
    sent &&
    streaming.isConnected &&
    firstSampleAt !== null &&
    streaming.sessionStartedAt != null
  ) {
    streaming.sessionStartedAt = firstSampleAt;
  }
  return sent;
};

module.exports = {
  STREAMING_CLIENT_BY_PROVIDER,
  sendMeetingStreamingAudio,
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
};
