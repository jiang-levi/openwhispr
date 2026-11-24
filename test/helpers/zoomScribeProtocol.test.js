const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/zoomScribeProtocol.js");

test("English-only models coerce every non-English language to en-US and report it", async () => {
  const { resolveZoomScribeLanguage } = await load();
  assert.deepEqual(resolveZoomScribeLanguage({ model: "zoom-scribe-en", language: "fr" }), {
    language: "en-US",
    adjusted: "english-only-model",
  });
  assert.deepEqual(resolveZoomScribeLanguage({ model: "zoom-scribe-en-pro", language: "en" }), {
    language: "en-US",
    adjusted: null,
  });
  assert.deepEqual(resolveZoomScribeLanguage({ model: "zoom-scribe-en", language: undefined }), {
    language: "en-US",
    adjusted: null,
  });
});

test("multilingual maps the ten supported languages to locales and detects otherwise", async () => {
  const { resolveZoomScribeLanguage } = await load();
  assert.equal(
    resolveZoomScribeLanguage({ model: "zoom-scribe-multilingual", language: "pt" }).language,
    "pt-BR"
  );
  assert.equal(
    resolveZoomScribeLanguage({ model: "zoom-scribe-multilingual", language: "zh" }).language,
    "zh-CN"
  );
  assert.deepEqual(
    resolveZoomScribeLanguage({ model: "zoom-scribe-multilingual", language: "auto" }),
    {
      detect: true,
      adjusted: null,
    }
  );
  assert.deepEqual(
    resolveZoomScribeLanguage({ model: "zoom-scribe-multilingual", language: "ru" }),
    {
      detect: true,
      adjusted: "unsupported-language",
    }
  );
});

test("the Live session.update pins a locale or continuous detection, never both", async () => {
  const { buildLiveSessionUpdate } = await load();
  const pinned = buildLiveSessionUpdate({
    model: "zoom-scribe-multilingual",
    language: "de",
    keyterms: ["OpenWhispr"],
  });
  assert.equal(pinned.type, "session.update");
  assert.equal(pinned.language, undefined);
  assert.equal(pinned.config.language, "de-DE");
  assert.deepEqual(pinned.audio, { format: "pcm16" });
  assert.equal(pinned.config.model, "zoom-scribe-multilingual");
  assert.equal(pinned.config.interim_results, true);
  assert.deepEqual(pinned.config.vocabulary, { phrases: ["OpenWhispr"] });
  assert.equal(pinned.config.language_detection, undefined);
  assert.deepEqual(pinned.turn_detection, { silence_duration_ms: 600 });

  const detected = buildLiveSessionUpdate({ model: "zoom-scribe-multilingual", language: "auto" });
  assert.equal(detected.language, undefined);
  assert.deepEqual(detected.config.language_detection, { mode: "continuous" });
  assert.equal(detected.config.vocabulary, undefined);
});

test("vocabulary is trimmed, capped at 50 characters per term and 100 terms", async () => {
  const { normalizeVocabulary } = await load();
  const terms = Array.from({ length: 120 }, (_, i) => `term${i}`);
  terms.push("  ", "x".repeat(80));
  const out = normalizeVocabulary(terms);
  assert.equal(out.length, 100);
  assert.equal(normalizeVocabulary(["  padded  "])[0], "padded");
  assert.equal(normalizeVocabulary(["y".repeat(80)])[0].length, 50);
  assert.deepEqual(normalizeVocabulary(undefined), []);
});

test("Fast body carries a data URL and the same language rules", async () => {
  const { buildFastRequestBody } = await load();
  const body = buildFastRequestBody({
    audioBase64: "AAAA",
    mimeType: "audio/webm",
    model: "zoom-scribe-en-pro",
    language: "fr",
    keyterms: [],
  });
  assert.equal(body.file, "data:audio/webm;base64,AAAA");
  assert.deepEqual(body.config, { language: "en-US", model: "zoom-scribe-en-pro" });

  const auto = buildFastRequestBody({
    audioBase64: "AAAA",
    mimeType: "audio/mp4",
    model: "zoom-scribe-multilingual",
    language: undefined,
    keyterms: ["Zoom"],
  });
  assert.deepEqual(auto.config.language_detection, { mode: "continuous" });
  assert.deepEqual(auto.config.vocabulary, { phrases: ["Zoom"] });
});

test("speaker tags are removed and text_display is preferred over segments", async () => {
  const { stripSpeakerTags, parseFastResponse, normalizeZoomScribeModel } = await load();
  assert.equal(stripSpeakerTags("[Speaker 1] hello there "), "hello there");
  assert.equal(stripSpeakerTags("[SPK_2] hi [speaker_3] there"), "hi there");
  assert.equal(stripSpeakerTags("[channel1]"), "");
  assert.equal(stripSpeakerTags("plain text"), "plain text");

  assert.equal(
    parseFastResponse({ result: { text_display: "My VIN [Speaker 1] is." } }),
    "My VIN is."
  );
  assert.equal(
    parseFastResponse({ result: { segments: [{ text: "one" }, { text: "two" }] } }),
    "one two"
  );
  assert.equal(parseFastResponse({}), "");

  assert.equal(normalizeZoomScribeModel("zoom-scribe-en"), "zoom-scribe-en");
  assert.equal(normalizeZoomScribeModel("whisper-1"), "zoom-scribe-multilingual");
});
