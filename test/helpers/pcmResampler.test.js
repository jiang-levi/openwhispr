const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/pcmResampler.js");

function toPcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], i * 2);
  return out;
}

function sine(frequencyHz, sampleRate, count, amplitude = 10000) {
  const samples = new Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
  }
  return samples;
}

// Amplitude of one frequency in a PCM16 buffer, by a single-bin DFT. Edges are
// skipped so the filter's startup transient does not count.
function toneAmplitude(pcm, sampleRate, frequencyHz, skip = 200) {
  const count = pcm.length / 2;
  let re = 0;
  let im = 0;
  let n = 0;
  for (let i = skip; i < count - skip; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const phase = (2 * Math.PI * frequencyHz * i) / sampleRate;
    re += sample * Math.cos(phase);
    im += sample * Math.sin(phase);
    n++;
  }
  return (2 * Math.sqrt(re * re + im * im)) / n;
}

// Deterministic noise (Numerical Recipes LCG) so failures reproduce.
function seededNoise(count, seed = 1) {
  let state = seed >>> 0;
  const samples = new Array(count);
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    samples[i] = Math.round((state / 0xffffffff) * 40000 - 20000);
  }
  return samples;
}

test("24 kHz to 16 kHz produces exactly two output samples per three input samples", async () => {
  const { PcmResampler } = await load();
  const resampler = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const pcm = toPcm16(seededNoise(24000));
  const out = Buffer.concat([resampler.process(pcm), resampler.flush()]);
  assert.equal(out.length / 2, 16000);
});

test("output stays two thirds of the input across uneven 100 ms chunks", async () => {
  const { PcmResampler } = await load();
  const resampler = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const chunks = [];
  let total = 0;
  for (let i = 0; i < 37; i++) {
    const pcm = toPcm16(seededNoise(2400, i + 1));
    total += 2400;
    chunks.push(resampler.process(pcm));
  }
  chunks.push(resampler.flush());
  const produced = chunks.reduce((sum, chunk) => sum + chunk.length / 2, 0);
  assert.equal(produced, Math.round((total * 2) / 3));
});

test("a 1 kHz sine keeps its frequency and amplitude", async () => {
  const { PcmResampler } = await load();
  const resampler = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const out = Buffer.concat([
    resampler.process(toPcm16(sine(1000, 24000, 24000))),
    resampler.flush(),
  ]);
  const amplitude = toneAmplitude(out, 16000, 1000);
  assert.ok(Math.abs(amplitude - 10000) < 200, `1 kHz amplitude ${amplitude.toFixed(1)}`);
  // The tone is at 1 kHz, not 2 kHz or any other bin the filter could smear it into.
  assert.ok(toneAmplitude(out, 16000, 2000) < 50);
});

test("a 10 kHz tone is attenuated instead of aliasing to 6 kHz", async () => {
  const { PcmResampler } = await load();
  const resampler = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const out = Buffer.concat([
    resampler.process(toPcm16(sine(10000, 24000, 24000))),
    resampler.flush(),
  ]);
  // Without the anti-alias filter the 10 kHz tone folds onto 6 kHz at full amplitude.
  assert.ok(toneAmplitude(out, 16000, 6000) < 20, "aliased 6 kHz energy");
  assert.ok(toneAmplitude(out, 16000, 1000) < 20, "leakage into the speech band");
});

test("chunked processing is byte-identical to processing the whole buffer", async () => {
  const { PcmResampler } = await load();
  const pcm = toPcm16(seededNoise(24000, 7));

  const whole = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const expected = Buffer.concat([whole.process(pcm), whole.flush()]);

  const chunked = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const sizes = [2, 6, 100, 2400, 4800, 14, 1, 3000];
  const parts = [];
  let offset = 0;
  for (let i = 0; offset < pcm.length; i++) {
    const size = Math.min(pcm.length - offset, sizes[i % sizes.length] * 2);
    parts.push(chunked.process(pcm.subarray(offset, offset + size)));
    offset += size;
  }
  parts.push(chunked.flush());

  assert.equal(Buffer.compare(Buffer.concat(parts), expected), 0);
});

test("the output lags the input by the filter half-width until flushed", async () => {
  const { PcmResampler } = await load();
  const resampler = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const first = resampler.process(toPcm16(seededNoise(2400)));
  assert.ok(first.length / 2 < 1600, "the tail waits for lookahead");
  assert.ok(first.length / 2 > 1500, "but nearly all of the chunk is out");
});

test("reset returns the resampler to a fresh state", async () => {
  const { PcmResampler } = await load();
  const pcm = toPcm16(seededNoise(4800, 3));
  const fresh = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  const expected = Buffer.concat([fresh.process(pcm), fresh.flush()]);

  const used = new PcmResampler({ inputRate: 24000, outputRate: 16000 });
  used.process(toPcm16(seededNoise(999, 5)));
  used.reset();
  assert.equal(Buffer.compare(Buffer.concat([used.process(pcm), used.flush()]), expected), 0);
});

test("invalid rates are rejected", async () => {
  const { PcmResampler } = await load();
  assert.throws(() => new PcmResampler({ inputRate: 0, outputRate: 16000 }), RangeError);
  assert.throws(() => new PcmResampler({ inputRate: 24000, outputRate: NaN }), RangeError);
  assert.throws(() => new PcmResampler({ inputRate: 24000, outputRate: 16000, halfTaps: 0 }));
});
