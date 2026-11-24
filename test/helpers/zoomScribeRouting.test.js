const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const routing = () => import("../../src/helpers/dictationStreamingRouting.js");

test("BYOK Zoom Scribe dictation streams through the zoom-realtime provider", async () => {
  const { resolveStreamingProviderName, buildStreamingSessionOptions } = await routing();
  const settings = {
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "zoom",
    cloudTranscriptionModel: "zoom-scribe-en",
  };
  const providerName = resolveStreamingProviderName({ settings, context: "dictation" });
  assert.equal(providerName, "zoom-realtime");
  const options = buildStreamingSessionOptions({
    providerName,
    settings,
    language: "en",
    keyterms: ["VIN"],
  });
  assert.equal(options.provider, "zoom-realtime");
  assert.equal(options.model, "zoom-scribe-en");
  assert.equal(options.language, "en");
  assert.deepEqual(options.keyterms, ["VIN"]);
  assert.equal(options.mode, "byok");
});

test("Zoom Scribe is not a managed streaming provider", async () => {
  const { resolveStreamingProviderName } = await routing();
  const providerName = resolveStreamingProviderName({
    settings: { cloudTranscriptionMode: "openwhispr", cloudTranscriptionProvider: "zoom" },
    context: "dictation",
  });
  assert.notEqual(providerName, "zoom-realtime");
});

test("Zoom Scribe is offered for and accepted by Note Recording", async () => {
  const meeting = await import("../../src/helpers/meetingStreamingProviders.js");
  const routingMeeting = await import("../../src/helpers/meetingTranscriptionRouting.js");
  const { ZoomScribeStreaming } = require("../../src/helpers/zoomScribeStreaming.js");
  const { filterMeetingStreamingProviders, MEETING_STREAMING_PROVIDER_IDS } = routingMeeting;
  assert.equal(MEETING_STREAMING_PROVIDER_IDS.includes("zoom"), true);
  assert.equal(meeting.ALLOWED_MEETING_PROVIDERS.has("zoom-realtime"), true);
  assert.equal(meeting.STREAMING_CLIENT_BY_PROVIDER["zoom-realtime"], ZoomScribeStreaming);
  assert.equal(filterMeetingStreamingProviders([{ id: "zoom", models: [] }]).length, 1);
});

test("the Note Recording picker lists Zoom Scribe's streaming models", async () => {
  const { getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");
  const zoom = getMeetingStreamingTranscriptionProviders().find(
    (provider) => provider.id === "zoom"
  );
  assert.ok(zoom, "zoom must be offered for note recording");
  assert.ok(zoom.models.some((model) => model.id === "zoom-scribe-zh"));
  assert.ok(zoom.models.every((model) => model.streaming));
});

test("a BYOK Zoom Scribe meeting resolves to the zoom-realtime client with its model and language", async () => {
  const { resolveMeetingTranscriptionOptions } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");
  const byokProviders = [
    {
      id: "zoom",
      models: [{ id: "zoom-scribe-multilingual", default: true }, { id: "zoom-scribe-en" }],
    },
  ];
  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      transcriptionMode: "providers",
      language: "fr",
      selectedProvider: "zoom",
      selectedModel: "zoom-scribe-en",
      byokProviders,
      managedProviders: [],
    }),
    { provider: "zoom-realtime", model: "zoom-scribe-en", mode: "byok", language: "fr" }
  );
  assert.equal(
    resolveMeetingTranscriptionOptions({
      transcriptionMode: "providers",
      language: "auto",
      selectedProvider: "zoom",
      selectedModel: "",
      byokProviders,
      managedProviders: [],
    }).model,
    "zoom-scribe-multilingual"
  );
});

test("the zoom-realtime token provider hands the saved key to the dictation socket", async () => {
  const { fetchRealtimeTokenForProvider } = require("../../src/helpers/realtimeTokenProviders.js");
  const env = { getZoomScribeKey: () => "saved-key" };
  assert.equal(
    await fetchRealtimeTokenForProvider(
      "zoom-realtime",
      { environmentManager: env },
      { mode: "byok" }
    ),
    "saved-key"
  );
  await assert.rejects(
    fetchRealtimeTokenForProvider(
      "zoom-realtime",
      { environmentManager: { getZoomScribeKey: () => "" } },
      { mode: "byok" }
    ),
    /No Zoom Scribe API key configured/
  );
});

// A scripted stand-in for the Live socket used by the connection check.
class FakeSocket extends EventEmitter {
  constructor(script) {
    super();
    this.script = script;
    this.sent = [];
  }
  send(data) {
    const message = JSON.parse(data);
    this.sent.push(message);
    this.script(this, message);
  }
  close() {
    this.emit("close", 1000);
  }
}

test("the Zoom connection check accepts a key that gets session.updated, with no audio sent", async () => {
  const { testProviderConnection } = require("../../src/helpers/providerConnectionTest.js");
  let socket;
  const result = await testProviderConnection(
    { provider: "zoom", apiKey: "good-key" },
    undefined,
    undefined,
    (url, protocols, options) => {
      socket = new FakeSocket((self, message) => {
        if (message.type === "session.update") {
          self.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
        }
      });
      setImmediate(() => socket.emit("open"));
      socket.url = url;
      socket.protocols = protocols;
      socket.options = options;
      return socket;
    }
  );
  assert.deepEqual(result, { success: true });
  assert.equal(socket.protocols[0], "live-asr");
  assert.equal(socket.options.headers.Authorization, "Bearer good-key");
  assert.equal(
    socket.sent.some((message) => message.type === "input_audio_buffer.append"),
    false
  );
});

test("the Zoom connection check reports a refused key as credentialsRejected", async () => {
  const { testProviderConnection } = require("../../src/helpers/providerConnectionTest.js");
  const result = await testProviderConnection(
    { provider: "zoom", apiKey: "bad-key" },
    undefined,
    undefined,
    () => {
      const socket = new FakeSocket(() => {});
      setImmediate(() => {
        const response = Object.assign(
          Readable.from([Buffer.from('{"code":124,"message":"Invalid Access token"}')]),
          { statusCode: 401 }
        );
        socket.emit("unexpected-response", {}, response);
      });
      return socket;
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "credentialsRejected");
  assert.equal(result.status, 401);
});

test("the Zoom connection check needs a key", async () => {
  const { testProviderConnection } = require("../../src/helpers/providerConnectionTest.js");
  const result = await testProviderConnection({ provider: "zoom", apiKey: "  " });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "apiKeyRequired");
});
