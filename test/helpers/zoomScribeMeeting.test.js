const test = require("node:test");
const assert = require("node:assert/strict");
const { withLiveServer, createSocketFor } = require("./harness/zoomLiveServer");

const loadClient = () => import("../../src/helpers/zoomScribeStreaming.js");
const loadMeeting = () => import("../../src/helpers/meetingStreamingProviders.js");

const T0 = 1_700_000_000_000;
const CHUNK_24K = 2400 * 2; // 100 ms of 24 kHz PCM16

// Answers session.update with session.updated and session.close with session.closed.
const readyServer = (ws, message) => {
  if (message.type === "session.update") ws.send(JSON.stringify({ type: "session.updated" }));
  if (message.type === "session.close") ws.send(JSON.stringify({ type: "session.closed" }));
};

const emitServerMessage = (client, message) =>
  client.ws.emit("message", Buffer.from(JSON.stringify(message)));

const meetingChunk = (fill) => Buffer.alloc(CHUNK_24K, fill);

test("final timestamps are the session start plus the server's audio_start_ms", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  const { sendMeetingStreamingAudio } = await loadMeeting();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const finals = [];
    client.onFinalTranscript = (text, timestampMs) => finals.push({ text, timestampMs });
    await client.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });

    assert.equal(sendMeetingStreamingAudio(client, meetingChunk(1), T0), true);
    assert.equal(client.sessionStartedAt, T0);

    emitServerMessage(client, {
      type: "transcription.completed",
      transcript: "hello there.",
      audio_start_ms: 1200,
    });
    assert.deepEqual(finals, [{ text: "hello there.", timestampMs: T0 + 1200 }]);
    await client.disconnect({ commit: false });
  });
});

test("onFinalTranscript carries the accumulated text while completedSegments holds each turn", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const finals = [];
    client.onFinalTranscript = (text) => finals.push(text);
    await client.connect({ apiKey: "k", model: "zoom-scribe-en" });

    emitServerMessage(client, {
      type: "transcription.completed",
      transcript: "one.",
      audio_start_ms: 0,
    });
    emitServerMessage(client, {
      type: "transcription.completed",
      transcript: "two.",
      audio_start_ms: 900,
    });

    assert.deepEqual(finals, ["one.", "one. two."]);
    assert.deepEqual(client.completedSegments, ["one.", "two."]);
    await client.disconnect({ commit: false });
  });
});

test("a turn without audio_start_ms still gets a timestamp", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const before = Date.now();
    const stamps = [];
    client.onFinalTranscript = (_text, timestampMs) => stamps.push(timestampMs);
    await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
    emitServerMessage(client, { type: "transcription.completed", transcript: "x." });
    assert.equal(stamps.length, 1);
    assert.ok(stamps[0] >= before);
    await client.disconnect({ commit: false });
  });
});

test("sendAudio reports whether the chunk reached the socket", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    assert.equal(client.sendAudio(meetingChunk(1)), false, "no socket yet");
    await client.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    assert.equal(client.sendAudio(meetingChunk(2)), true);
    assert.equal(client.sendAudio(Buffer.alloc(0)), true, "an empty chunk is not a failure");
    await client.disconnect({ commit: false });
    assert.equal(client.sendAudio(meetingChunk(3)), false, "closed client drops audio");
  });
});

test("audioBytesSent counts caller-rate bytes and the socket gets 16 kHz samples", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url, seen }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    await client.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    assert.equal(client.audioBytesSent, 0);
    client.sendAudio(meetingChunk(4));
    client.sendAudio(meetingChunk(5));
    assert.equal(client.audioBytesSent, 2 * CHUNK_24K);

    await client.disconnect({ commit: true });
    const wireBytes = seen.frames.reduce((sum, frame) => sum + frame.length, 0);
    // 200 ms at 24 kHz is 4800 samples, which is 3200 samples at 16 kHz.
    assert.equal(wireBytes, 3200 * 2);
  });
});

test("without a sampleRate, audio goes to the socket unchanged", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url, seen }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    await client.connect({ apiKey: "k", model: "zoom-scribe-en" });
    const chunk = Buffer.from([1, 0, 2, 0, 3, 0]);
    client.sendAudio(chunk);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(seen.frames[0], chunk);
    await client.disconnect({ commit: false });
  });
});

test("a socket lost after audio was sent calls onConnectionLost once and not onError", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const lost = [];
    const errors = [];
    client.onConnectionLost = (error) => lost.push(error);
    client.onError = (error) => errors.push(error);
    await client.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    client.sendAudio(meetingChunk(6));
    client.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(lost.length, 1);
    assert.match(lost[0].message, /connection lost/);
    assert.equal(errors.length, 0);
  });
});

test("an idle close before any audio calls neither hook", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  await withLiveServer(readyServer, async ({ url }) => {
    const client = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const lost = [];
    const errors = [];
    client.onConnectionLost = (error) => lost.push(error);
    client.onError = (error) => errors.push(error);
    await client.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    client.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(lost.length, 0);
    assert.equal(errors.length, 0);
  });
});

test("a replacement session's clock starts at the oldest replayed chunk's capture time", async () => {
  const { ZoomScribeStreaming } = await loadClient();
  const { sendMeetingStreamingAudio } = await loadMeeting();
  await withLiveServer(readyServer, async ({ url }) => {
    // The first session takes live audio, then drops.
    const first = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    await first.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    for (let i = 0; i < 3; i++) {
      sendMeetingStreamingAudio(first, meetingChunk(i + 1), T0 + i * 100);
    }
    first.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The replacement session is fed the buffered audio, then live audio.
    const replay = [0, 1, 2].map((i) => ({
      buffer: meetingChunk(i + 1),
      capturedAt: T0 + i * 100,
    }));
    const second = new ZoomScribeStreaming({ createSocket: createSocketFor(url) });
    const finals = [];
    second.onFinalTranscript = (_text, timestampMs) => finals.push(timestampMs);
    await second.connect({ apiKey: "k", model: "zoom-scribe-en", sampleRate: 24000 });
    assert.ok(second.sessionStartedAt > T0, "connect alone stamps the time it opened");

    const replayed = replay.every(({ buffer, capturedAt }) =>
      sendMeetingStreamingAudio(second, buffer, capturedAt)
    );
    assert.equal(replayed, true);
    assert.equal(second.sessionStartedAt, T0, "replay anchors the session at its oldest chunk");

    // Live audio after the replay does not move the anchor.
    sendMeetingStreamingAudio(second, meetingChunk(9), T0 + 300);
    assert.equal(second.sessionStartedAt, T0);
    assert.equal(second.audioBytesSent, 4 * CHUNK_24K);

    emitServerMessage(second, {
      type: "transcription.completed",
      transcript: "replayed words.",
      audio_start_ms: 250,
    });
    assert.deepEqual(finals, [T0 + 250]);
    await second.disconnect({ commit: false });
  });
});

test("the meeting audio clock leaves a client with no session unchanged", async () => {
  const { sendMeetingStreamingAudio } = await loadMeeting();
  const fake = {
    audioBytesSent: 0,
    sessionStartedAt: 5,
    isConnected: false,
    sendAudio: () => true,
  };
  assert.equal(sendMeetingStreamingAudio(fake, Buffer.alloc(2), T0), true);
  assert.equal(fake.sessionStartedAt, 5, "not connected, so the clock is not re-anchored");
});
