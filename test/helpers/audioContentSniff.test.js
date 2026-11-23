const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/audioContentSniff.js");

test("sniffs WAV, MP4, MP3 (ID3 and frame sync), and WebM from the leading bytes", async () => {
  const { sniffAudioMime } = await load();
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
  assert.equal(sniffAudioMime(wav), "audio/wav");
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]);
  assert.equal(sniffAudioMime(mp4), "audio/mp4");
  assert.equal(sniffAudioMime(Buffer.from("ID3\x04\x00\x00", "latin1")), "audio/mpeg");
  // 0xFF 0xFB = frame sync with MPEG-1 Layer III
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg");
  assert.equal(sniffAudioMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])), "audio/webm");
});

test("AAC ADTS frames are not mistaken for MP3", async () => {
  const { sniffAudioMime } = await load();
  // 0xFF 0xF1: same 0xFFF sync, but layer bits 00 mark ADTS (AAC)
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xf1, 0x50, 0x80])), null);
});

test("unknown or too-short content sniffs to null", async () => {
  const { sniffAudioMime } = await load();
  assert.equal(sniffAudioMime(Buffer.from("OggS\x00\x02", "latin1")), null);
  assert.equal(sniffAudioMime(Buffer.from([0x01, 0x02])), null);
  assert.equal(sniffAudioMime(Buffer.alloc(0)), null);
  assert.equal(sniffAudioMime(undefined), null);
});

test("declared MIME types normalise to the bare allowlist spelling", async () => {
  const { normalizeAudioMime } = await load();
  assert.equal(normalizeAudioMime("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeAudioMime("audio/x-wav"), "audio/wav");
  assert.equal(normalizeAudioMime("audio/mp3"), "audio/mpeg");
  assert.equal(normalizeAudioMime("audio/x-m4a"), "audio/mp4");
  assert.equal(normalizeAudioMime(undefined), null);
});
