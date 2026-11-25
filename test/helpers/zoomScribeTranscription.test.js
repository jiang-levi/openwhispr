const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/zoomScribeTranscription.js");

const fakeFetch = (respond) => {
  const calls = [];
  const proxyFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  return { proxyFetch, calls };
};

test("Fast posts the recording as a WebM data URL when it fits the cap", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () =>
      new Response(JSON.stringify({ result: { text_display: "My VIN is 1FMVU72X6Y." } }), {
        status: 200,
      })
  );
  const audio = Buffer.from("webm-bytes");
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: audio,
    mimeType: "audio/webm",
    model: "zoom-scribe-en",
    language: "en",
    keyterms: ["VIN"],
    proxyFetch,
  });
  assert.equal(result.text, "My VIN is 1FMVU72X6Y.");
  assert.equal(result.mimeType, "audio/webm");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.zoom.us/v2/aiservices/scribe/transcribe");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.equal(calls[0].body.file, `data:audio/webm;base64,${audio.toString("base64")}`);
  assert.deepEqual(calls[0].body.config, {
    language: "en-US",
    model: "zoom-scribe-en",
    vocabulary: { phrases: ["VIN"] },
  });
});

test("Fast retains the selected language-specific model instead of falling back to Multilingual", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "你好" } }), { status: 200 })
  );
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/webm",
    model: "zoom-scribe-zh",
    language: "en",
    proxyFetch,
  });
  assert.equal(result.text, "你好");
  assert.equal(calls[0].body.config.model, "zoom-scribe-zh");
  assert.equal(calls[0].body.config.language, "zh-CN");
  assert.equal(calls[0].body.config.language_detection, undefined);
});

test("an over-cap encoded body is re-encoded once to m4a and then sent", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "ok" } }), { status: 200 })
  );
  let transcodes = 0;
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: Buffer.alloc(5000, 1),
    mimeType: "audio/webm",
    model: "zoom-scribe-multilingual",
    language: "fr",
    proxyFetch,
    limitBytes: 6000,
    transcodeToM4a: async () => {
      transcodes += 1;
      return Buffer.alloc(100, 2);
    },
  });
  assert.equal(transcodes, 1);
  assert.equal(result.mimeType, "audio/mp4");
  assert.match(calls[0].body.file, /^data:audio\/mp4;base64,/);
  assert.deepEqual(calls[0].body.config.language_detection, { mode: "continuous" });
});

test("an over-cap file that is still too large after m4a raises PAYLOAD_TOO_LARGE", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.alloc(5000, 1),
      mimeType: "audio/webm",
      model: "zoom-scribe-en",
      proxyFetch,
      limitBytes: 6000,
      transcodeToM4a: async () => Buffer.alloc(5000, 2),
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_PAYLOAD_TOO_LARGE");
      assert.equal(error.messageKey, "providerErrors.payloadTooLarge");
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("an over-cap file with no transcoder is refused before any request", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.alloc(5000, 1),
      mimeType: "audio/webm",
      proxyFetch,
      limitBytes: 1000,
    }),
    (error) => error.code === "PROVIDER_PAYLOAD_TOO_LARGE"
  );
  assert.equal(calls.length, 0);
});

test("a gateway 413 with an HTML body is classified without showing the HTML", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch } = fakeFetch(
    () => new Response("<html><body>413 Request Entity Too Large</body></html>", { status: 413 })
  );
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.from("x"),
      mimeType: "audio/webm",
      proxyFetch,
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_PAYLOAD_TOO_LARGE");
      assert.equal(error.message.includes("<html"), false);
      return true;
    }
  );
});

test("a 401 maps to an auth failure and an UNSUPPORTED_MODEL 400 to the premium-model message", async () => {
  const { transcribeWithZoomScribe } = await load();
  const unauthorized = fakeFetch(
    () => new Response('{"code":124,"message":"Invalid Access token"}', { status: 401 })
  );
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "bad",
      audioBuffer: Buffer.from("x"),
      mimeType: "audio/webm",
      proxyFetch: unauthorized.proxyFetch,
    }),
    (error) => error.code === "PROVIDER_AUTH_FAILED"
  );

  const unsupported = fakeFetch(
    () => new Response('{"reason":"UNSUPPORTED_MODEL","message":"not enabled"}', { status: 400 })
  );
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.from("x"),
      mimeType: "audio/webm",
      model: "zoom-scribe-en-pro",
      proxyFetch: unsupported.proxyFetch,
    }),
    (error) => {
      assert.equal(error.messageKey, "providerErrors.modelUnavailable");
      assert.equal(error.messageParams.model, "zoom-scribe-en-pro");
      return true;
    }
  );
});

test("a missing key is refused before any request", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
  await assert.rejects(
    transcribeWithZoomScribe({ audioBuffer: Buffer.from("x"), mimeType: "audio/webm", proxyFetch }),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("a 60 MB WebM is re-encoded instead of refused and then transcribed", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () =>
      new Response(JSON.stringify({ result: { text_display: "long recording" } }), { status: 200 })
  );
  let transcodedFrom = 0;
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: Buffer.alloc(60 * 1024 * 1024, 1),
    mimeType: "audio/webm",
    model: "zoom-scribe-multilingual",
    language: "en",
    proxyFetch,
    transcodeToM4a: async (buffer) => {
      transcodedFrom = buffer.length;
      return Buffer.alloc(8 * 1024 * 1024, 2);
    },
  });
  assert.equal(transcodedFrom, 60 * 1024 * 1024);
  assert.equal(result.mimeType, "audio/mp4");
  assert.equal(result.text, "long recording");
  assert.equal(calls.length, 1);
});

test("the dictation proxy forwards the custom dictionary as Fast vocabulary", async () => {
  const { transcribeZoomScribeProxyRequest } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "ok" } }), { status: 200 })
  );
  await transcribeZoomScribeProxyRequest(
    {
      audioBuffer: Buffer.from("webm-bytes"),
      mimeType: "audio/webm",
      model: "zoom-scribe-en",
      language: "en",
      vocabulary: ["Acme Corp", "  Kubernetes  "],
    },
    { apiKey: "k", proxyFetch }
  );
  assert.deepEqual(calls[0].body.config.vocabulary, { phrases: ["Acme Corp", "Kubernetes"] });
});

test("an undocumented container (ogg) is re-encoded to m4a even when it is small", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "ok" } }), { status: 200 })
  );
  let transcodes = 0;
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: Buffer.from("OggS-not-really"),
    mimeType: "audio/ogg",
    model: "zoom-scribe-en",
    proxyFetch,
    transcodeToM4a: async () => {
      transcodes += 1;
      return Buffer.from("m4a-bytes");
    },
  });
  assert.equal(transcodes, 1);
  assert.equal(result.mimeType, "audio/mp4");
  assert.match(calls[0].body.file, /^data:audio\/mp4;base64,/);
});

test("retry sniffs WebM bytes without a declared type and sends them as-is", async () => {
  const { transcribeWithZoomScribe } = await load();
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("rest-of-webm")]);
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "ok" } }), { status: 200 })
  );
  const result = await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: webm,
    model: "zoom-scribe-en",
    proxyFetch,
    transcodeToM4a: async () => assert.fail("a sniffed WebM must not be transcoded"),
  });
  assert.equal(result.mimeType, "audio/webm");
  assert.match(calls[0].body.file, /^data:audio\/webm;base64,/);
});

test("unknown content with no declared type is transcoded, not guessed", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(
    () => new Response(JSON.stringify({ result: { text_display: "ok" } }), { status: 200 })
  );
  await transcribeWithZoomScribe({
    apiKey: "k",
    audioBuffer: Buffer.from("unknown-bytes"),
    model: "zoom-scribe-en",
    proxyFetch,
    transcodeToM4a: async () => Buffer.from("m4a"),
  });
  assert.match(calls[0].body.file, /^data:audio\/mp4;base64,/);
});

test("unknown content with no transcoder is a bad request before any call", async () => {
  const { transcribeWithZoomScribe } = await load();
  const { proxyFetch, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
  await assert.rejects(
    transcribeWithZoomScribe({ apiKey: "k", audioBuffer: Buffer.from("junk"), proxyFetch }),
    (error) => error.code === "PROVIDER_BAD_REQUEST"
  );
  assert.equal(calls.length, 0);
});

for (const status of [413, 415]) {
  test(`Fast compresses once after actual HTTP ${status}, retaining the cap and tracking IDs`, async () => {
    const { transcribeWithZoomScribe } = await load();
    let count = 0,
      transcodes = 0;
    const ids = [];
    const options = {
      apiKey: "k",
      model: "zoom-scribe-zh",
      audioBuffer: Buffer.alloc(12),
      mimeType: "audio/webm",
      transcodeToM4a: async () => {
        transcodes++;
        return Buffer.alloc(8);
      },
      proxyFetch: async (_url, init) => {
        ids.push(init.headers["x-zm-trackingid"]);
        return ++count === 1
          ? new Response("rejected", { status })
          : new Response(
              JSON.stringify({
                result: { segments: [{ text: "你 好" }, { text: "世 界 ， hello world" }] },
              })
            );
      },
    };
    assert.equal((await transcribeWithZoomScribe(options)).text, "你好世界， hello world");
    assert.equal(transcodes, 1);
    assert.equal(count, 2);
    assert.match(ids[0], /^zoom_ai_community_openwhispr_/);
    assert.notEqual(ids[0], ids[1]);
    count = 0;
    transcodes = 0;
    await assert.rejects(
      transcribeWithZoomScribe({
        ...options,
        proxyFetch: async () => {
          count++;
          return new Response("rejected", { status });
        },
      }),
      (error) => error.status === status
    );
    assert.equal(count, 2);
    assert.equal(transcodes, 1);
  });
}

test("Fast does not retry server rejection after a preflight conversion", async () => {
  const { transcribeWithZoomScribe } = await load();
  let requests = 0,
    transcodes = 0;
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.alloc(12),
      mimeType: "audio/ogg",
      transcodeToM4a: async () => {
        transcodes++;
        return Buffer.alloc(8);
      },
      proxyFetch: async () => {
        requests++;
        return new Response("rejected", { status: 415 });
      },
    })
  );
  assert.equal(requests, 1);
  assert.equal(transcodes, 1);
});

test("Fast localizes invalid success JSON and deadline while preserving caller cancellation", async () => {
  const { transcribeWithZoomScribe } = await load();
  const options = { apiKey: "k", audioBuffer: Buffer.alloc(12), mimeType: "audio/webm" };
  await assert.rejects(
    transcribeWithZoomScribe({
      ...options,
      proxyFetch: async () => new Response("<html>bad gateway</html>"),
    }),
    (error) => error.messageKey === "providerErrors.unknown" && !error.message.includes("html")
  );
  const waitForAbort = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    );
  // Keep the event loop live while AbortSignal.timeout's unref'ed timer expires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      transcribeWithZoomScribe({ ...options, timeoutMs: 10, proxyFetch: waitForAbort }),
      (error) => error.code === "PROVIDER_TIMEOUT"
    );
    const controller = new AbortController();
    const pending = transcribeWithZoomScribe({
      ...options,
      signal: controller.signal,
      proxyFetch: waitForAbort,
    });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
  } finally {
    clearInterval(keepAlive);
  }
});

test("Fast rechecks the encoded-body cap after a server-triggered compression", async () => {
  const { transcribeWithZoomScribe } = await load();
  let requests = 0;
  await assert.rejects(
    transcribeWithZoomScribe({
      apiKey: "k",
      audioBuffer: Buffer.alloc(12),
      mimeType: "audio/webm",
      limitBytes: 1024,
      proxyFetch: async () => {
        requests++;
        return new Response("rejected", { status: 413 });
      },
      transcodeToM4a: async () => Buffer.alloc(1024),
    }),
    (error) => error.code === "PROVIDER_PAYLOAD_TOO_LARGE"
  );
  assert.equal(requests, 1);
});
