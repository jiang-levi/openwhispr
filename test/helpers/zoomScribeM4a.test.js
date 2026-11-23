const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { convertBufferToM4a, getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
const { pcm16Mono16kWav } = require("./harness/wavFixtures");

const ffmpegAvailable = (() => {
  try {
    return fs.existsSync(getFFmpegPath());
  } catch {
    return false;
  }
})();

test(
  "convertBufferToM4a re-encodes audio to an MP4/AAC container",
  { skip: ffmpegAvailable ? false : "ffmpeg-static binary not installed in node_modules" },
  async () => {
    const samples = Array.from({ length: 16000 }, (_, i) => Math.round(8000 * Math.sin(i / 10)));
    const m4a = await convertBufferToM4a(pcm16Mono16kWav(samples));
    assert.ok(m4a.length > 0);
    assert.equal(m4a.subarray(4, 8).toString("latin1"), "ftyp");
  }
);
