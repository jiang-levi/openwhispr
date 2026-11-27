const test = require("node:test");
const assert = require("node:assert/strict");
const { withLiveServer, createSocketFor } = require("./harness/zoomLiveServer");

const load = () => import("../../src/helpers/zoomScribeStreaming.js");

test("connect sends the live-asr subprotocol, auth and tracking headers, then session.update", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      await client.connect({ apiKey: "secret-token", model: "zoom-scribe-en", language: "en" });
      assert.equal(client.isConnected, true);
      assert.equal(seen.protocol, "live-asr");
      assert.equal(seen.headers.authorization, "Bearer secret-token");
      assert.match(seen.headers["x-zm-trackingid"], /^zoom_ai_community_openwhispr_/);
      assert.equal(seen.texts[0].type, "session.update");
      assert.equal(seen.texts[0].config.language, "en-US");
      assert.equal(seen.texts[0].config.model, "zoom-scribe-en");
      await client.disconnect({ commit: false });
    }
  );
});

test("a selected Chinese Scribe model survives normalization and overrides the app language", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      await client.connect({ apiKey: "k", model: "zoom-scribe-zh", language: "en" });
      assert.equal(seen.texts[0].config.model, "zoom-scribe-zh");
      assert.equal(seen.texts[0].config.language, "zh-CN");
      assert.equal(seen.texts[0].config.language_detection, undefined);
      await client.disconnect({ commit: false });
    }
  );
});

test("audio sent before session.updated is buffered and flushed once the session is ready", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") {
        setTimeout(() => ws.send(JSON.stringify({ type: "session.updated" })), 30);
      }
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      client.beginConnecting();
      client.sendAudio(Buffer.alloc(320, 1));
      const connecting = client.connect({ apiKey: "k", model: "zoom-scribe-multilingual" });
      client.sendAudio(Buffer.alloc(320, 2));
      await connecting;
      client.sendAudio(Buffer.alloc(320, 3));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        seen.frames.map((frame) => frame[0]),
        [1, 2, 3]
      );
      await client.disconnect({ commit: false });
    }
  );
});

test("delta replaces the partial, completed accumulates, and stop returns the full text", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      if (message.type === "session.close") {
        ws.send(
          JSON.stringify({ type: "transcription.completed", transcript: "[Speaker 1] tail words" })
        );
        ws.send(JSON.stringify({ type: "session.closed" }));
      }
    },
    async ({ url }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      const partials = [];
      const finals = [];
      client.onPartialTranscript = (text) => partials.push(text);
      client.onFinalTranscript = (text) => finals.push(text);
      await client.connect({ apiKey: "k", model: "zoom-scribe-en" });

      client.ws.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "transcription.delta", delta: "hello" }))
      );
      client.ws.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "transcription.delta", delta: "hello there" }))
      );
      client.ws.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "transcription.completed", transcript: "hello there." }))
      );
      client.ws.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "transcription.delta", delta: "second" }))
      );

      assert.deepEqual(partials, ["hello", "hello there", "", "second"]);
      assert.deepEqual(finals, ["hello there."]);

      const result = await client.disconnect({ commit: true });
      assert.equal(result.text, "hello there. [Speaker 1] tail words");
      assert.equal(client.isConnected, false);
    }
  );
});

test("after session.close, audio is dropped and the socket closes only after session.closed", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      if (message.type === "session.close") {
        setTimeout(() => ws.send(JSON.stringify({ type: "session.closed" })), 20);
      }
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
      const pending = client.disconnect({ commit: true });
      client.sendAudio(Buffer.alloc(320, 9));
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        seen.frames.some((frame) => frame[0] === 9),
        false
      );
      assert.deepEqual(
        seen.texts.map((message) => message.type),
        ["session.update", "session.close"]
      );
    }
  );
});

test("a 401 refusal on the upgrade is classified as an auth failure with the server message", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    () => {},
    async ({ url, seen }) => {
      seen.reject = { status: 401, body: '{"code":124, "message":"Invalid Access token"}' };
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      await assert.rejects(client.connect({ apiKey: "bad", model: "zoom-scribe-en" }), (error) => {
        assert.equal(error.code, "PROVIDER_AUTH_FAILED");
        assert.equal(error.messageKey, "providerErrors.authFailed");
        assert.equal(error.status, 401);
        return true;
      });
      assert.equal(client.isConnected, false);
    }
  );
});

test("an UNSUPPORTED_MODEL error event before ready maps to the model-unavailable message", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") {
        ws.send(
          JSON.stringify({
            type: "error",
            error: { code: "UNSUPPORTED_MODEL", message: "model not enabled", fatal: true },
          })
        );
      }
    },
    async ({ url }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      await assert.rejects(
        client.connect({ apiKey: "k", model: "zoom-scribe-en-pro" }),
        (error) => {
          assert.equal(error.code, "PROVIDER_MODEL_NOT_FOUND");
          assert.equal(error.messageKey, "providerErrors.modelUnavailable");
          assert.equal(error.messageParams.model, "zoom-scribe-en-pro");
          return true;
        }
      );
    }
  );
});

test("connect refuses to run without a key", async () => {
  const { ZoomScribeStreaming } = await load();
  const client = new ZoomScribeStreaming({ createSocket: () => assert.fail("no socket") });
  await assert.rejects(client.connect({ model: "zoom-scribe-en" }), (error) => {
    assert.equal(error.code, "API_KEY_MISSING");
    return true;
  });
});

test("a server-side idle close with no audio is silent and the next connect reconnects", async () => {
  const { ZoomScribeStreaming } = await load();
  let sessions = 0;
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") {
        sessions += 1;
        ws.send(JSON.stringify({ type: "session.updated" }));
        // The first session is ended by the server with no audio, as Scribe does.
        if (sessions === 1) setTimeout(() => ws.terminate(), 30);
      }
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      const errors = [];
      client.onError = (error) => errors.push(error);
      await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(errors.length, 0, "an idle close must not reach the user");
      assert.equal(client.isConnected, false);

      await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
      assert.equal(client.isConnected, true);
      assert.equal(sessions, 2);
      assert.equal(seen.texts.filter((message) => message.type === "session.update").length, 2);
      await client.disconnect({ commit: false });
    }
  );
});

test("a close after audio was sent is still reported as a lost connection", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
    },
    async ({ url }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      const errors = [];
      client.onError = (error) => errors.push(error);
      await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
      client.sendAudio(Buffer.alloc(320, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.ws.terminate();
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /connection lost/);
    }
  );
});

test("empty completion clears stale partial and Chinese turns join without added spaces", async () => {
  const { ZoomScribeStreaming } = await load();
  const client = new ZoomScribeStreaming();
  client.model = "zoom-scribe-zh";
  const partials = [];
  client.onPartialTranscript = (text) => partials.push(text);
  const emit = (value) => client.handleMessage(Buffer.from(JSON.stringify(value)));
  emit({ type: "transcription.delta", delta: "旧 的 预 览" });
  emit({ type: "transcription.completed", transcript: "" });
  assert.equal(client.partialText, "");
  assert.deepEqual(partials, ["旧的预览", ""]);
  emit({ type: "transcription.completed", transcript: "你 好" });
  emit({ type: "transcription.completed", transcript: "世 界" });
  assert.equal(client.getFullTranscript(), "你好世界");
});

test("reconnect waits for updated, fatal handshake rejects immediately, fatal+close reports once", async () => {
  const { EventEmitter } = require("node:events");
  const { ZoomScribeStreaming } = await load();
  class Socket extends EventEmitter {
    readyState = 1;
    sent = [];
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.emit("close", 1006);
    }
  }
  const sockets = [];
  const client = new ZoomScribeStreaming({
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  const emit = (socket, value) => socket.emit("message", Buffer.from(JSON.stringify(value)));
  const first = client.connect({ apiKey: "k", sampleRate: 24000 });
  emit(sockets[0], { type: "session.updated" });
  await first;
  sockets[0].close();
  assert.equal(client.sessionReady, false);
  const second = client.connect({ apiKey: "k", sampleRate: 24000 });
  client.sendAudio(Buffer.alloc(24000 * 2 * 6));
  assert.equal(client.pendingBytes, 24000 * 2 * 5);
  assert.equal(sockets[1].sent.length, 0);
  emit(sockets[1], { type: "error", error: { fatal: true, code: "INVALID_CONFIG" } });
  await assert.rejects(second, (error) => error.code === "PROVIDER_ERROR");
  const third = client.connect({ apiKey: "k" });
  emit(sockets[2], { type: "session.updated" });
  await third;
  client.sendAudio(Buffer.alloc(320));
  let errors = 0;
  client.onError = () => errors++;
  emit(sockets[2], { type: "error", error: { fatal: true, code: "SERVER_ERROR" } });
  sockets[2].close();
  assert.equal(errors, 1);
  assert.equal(client.isConnected, false);
});

test("socket construction failure and cancellation settle the handshake without stale timers", async () => {
  const { ZoomScribeStreaming } = await load();
  const failed = new ZoomScribeStreaming({
    createSocket: () => {
      throw new Error("socket creation failed");
    },
  });
  await assert.rejects(failed.connect({ apiKey: "k" }), /socket creation failed/);
  assert.equal(failed.pendingConnect, null);
  const { EventEmitter } = require("node:events");
  const socket = new EventEmitter();
  socket.close = () => {};
  const client = new ZoomScribeStreaming({ createSocket: () => socket });
  const connecting = client.connect({ apiKey: "k" });
  client.cleanup();
  await assert.rejects(connecting, (error) => error.name === "AbortError");
  assert.equal(client.pendingConnect, null);
});

test("an unsolicited session.closed triggers recovery and simultaneous disconnects share a close", async () => {
  const { ZoomScribeStreaming } = await load();
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      if (message.type === "session.close") ws.send(JSON.stringify({ type: "session.closed" }));
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      try {
        await client.connect({ apiKey: "k" });
        client.sendAudio(Buffer.alloc(320));
        let losses = 0;
        client.onConnectionLost = () => losses++;
        client.handleMessage(Buffer.from(JSON.stringify({ type: "session.closed" })));
        assert.equal(losses, 1);
        assert.equal(client.isConnected, false);
        assert.equal(client.sessionReady, false);
        await client.connect({ apiKey: "k" });
        await Promise.all([client.disconnect(), client.disconnect()]);
        assert.equal(seen.texts.filter((message) => message.type === "session.close").length, 1);
      } finally {
        client.cleanup();
      }
    }
  );
});

test("dictation disables interim results for the resolved Multilingual model after stale-ID fallback", async () => {
  const { ZoomScribeStreaming } = await load();
  const { EventEmitter } = require("node:events");
  for (const { model, context, expectedModel, interim } of [
    {
      model: "legacy-model",
      context: "dictation",
      expectedModel: "zoom-scribe-multilingual",
      interim: false,
    },
    { model: "", context: "dictation", expectedModel: "zoom-scribe-multilingual", interim: false },
    {
      model: "zoom-scribe-en",
      context: "dictation",
      expectedModel: "zoom-scribe-en",
      interim: true,
    },
    { model: "legacy-model", expectedModel: "zoom-scribe-multilingual", interim: true },
  ]) {
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.close = () => {};
    const sent = [];
    socket.send = (data) => {
      const message = JSON.parse(data);
      sent.push(message);
      if (message.type === "session.update")
        socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    };
    const client = new ZoomScribeStreaming({ createSocket: () => socket });
    try {
      const connecting = client.connect({ apiKey: "k", model, context });
      socket.emit("open");
      await connecting;
      assert.equal(sent[0].config.model, expectedModel);
      assert.equal(sent[0].config.interim_results, interim);
    } finally {
      client.cleanup();
    }
  }
});

test("pre-ready queue overflow preserves PCM16 alignment across odd-byte frames", async () => {
  const { ZoomScribeStreaming } = await load();
  const { PcmResampler } = await import("../../src/helpers/pcmResampler.js");
  await withLiveServer(
    (ws, message) => {
      if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
      if (message.type === "session.close") ws.send(JSON.stringify({ type: "session.closed" }));
    },
    async ({ url, seen }) => {
      const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
      const input = Buffer.alloc(240002);
      for (let i = 0; i < input.length / 2; i++) input.writeInt16LE((i % 20000) - 10000, i * 2);
      try {
        const connecting = client.connect({ apiKey: "k", sampleRate: 24000 });
        client.sendAudio(input.subarray(0, 3));
        client.sendAudio(input.subarray(3, 240001));
        client.sendAudio(input.subarray(240001));
        await connecting;
        await client.disconnect();
        const reference = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
        const expected = Buffer.concat([reference.process(input.subarray(2)), reference.flush()]);
        assert.ok(
          Buffer.concat(seen.frames).equals(expected),
          "wire PCM must match the aligned retained audio"
        );
      } finally {
        client.cleanup();
      }
    }
  );
});
