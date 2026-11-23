// Streaming PCM16 mono resampler. Pure: no sockets, no Electron, no logger.
//
// Each output sample is a windowed-sinc low-pass interpolation of the input at
// its exact position (outputIndex * inputRate / outputRate). The filter cutoff
// sits below the lower of the two Nyquist frequencies, so content the output
// rate cannot represent (for 24 kHz -> 16 kHz, anything above 8 kHz) is
// attenuated instead of folding back into the speech band.
//
// The state (input history and the next output position) persists across calls,
// so feeding a stream in arbitrary chunks yields the same samples as feeding it
// whole. Output lags the input by `halfTaps` input samples until more audio
// arrives; `flush()` ends the stream and emits the remainder.

const DEFAULT_HALF_TAPS = 32;
// Fraction of the lower Nyquist frequency used as the passband edge. The
// remaining margin is the transition band the window has to fill.
const PASSBAND_FRACTION = 0.9;

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

// Blackman window over |t| <= halfTaps.
function blackman(t, halfTaps) {
  if (Math.abs(t) > halfTaps) return 0;
  const phase = (Math.PI * (t + halfTaps)) / (2 * halfTaps);
  return 0.42 - 0.5 * Math.cos(2 * phase) + 0.08 * Math.cos(4 * phase);
}

export class PcmResampler {
  constructor({ inputRate, outputRate, halfTaps = DEFAULT_HALF_TAPS } = {}) {
    if (!(Number.isFinite(inputRate) && inputRate > 0)) {
      throw new RangeError(`PcmResampler: invalid inputRate ${inputRate}`);
    }
    if (!(Number.isFinite(outputRate) && outputRate > 0)) {
      throw new RangeError(`PcmResampler: invalid outputRate ${outputRate}`);
    }
    if (!(Number.isInteger(halfTaps) && halfTaps > 0)) {
      throw new RangeError(`PcmResampler: invalid halfTaps ${halfTaps}`);
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.halfTaps = halfTaps;
    // Input samples consumed per output sample (1.5 for 24 kHz -> 16 kHz).
    this.step = inputRate / outputRate;
    // Cutoff as a fraction of the input sample rate.
    this.cutoff = 0.5 * PASSBAND_FRACTION * Math.min(1, outputRate / inputRate);
    this.reset();
  }

  reset() {
    // Input samples from absolute index `historyStart` onward. Indices before 0 are
    // silence, which is what the stream starts with.
    this.history = [];
    this.historyStart = 0;
    // Absolute input position of the next output sample.
    this.nextPosition = 0;
    this.kernels = new Map();
  }

  // Filter taps for a fractional offset, normalized to unit DC gain. Index k
  // covers input sample floor(position) - halfTaps + 1 + k.
  kernelFor(fraction) {
    const cached = this.kernels.get(fraction);
    if (cached) return cached;
    const { halfTaps, cutoff } = this;
    const taps = new Float64Array(2 * halfTaps);
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      const offset = k - halfTaps + 1;
      const t = fraction - offset;
      const weight = 2 * cutoff * sinc(2 * cutoff * t) * blackman(t, halfTaps);
      taps[k] = weight;
      sum += weight;
    }
    for (let k = 0; k < taps.length; k++) taps[k] /= sum;
    // The phase set is small for rational ratios; bound it for irrational ones.
    if (this.kernels.size > 256) this.kernels.clear();
    this.kernels.set(fraction, taps);
    return taps;
  }

  // Appends samples and returns the output that is now complete, as PCM16 LE.
  // `pcmBuffer` is 16-bit little-endian; an odd trailing byte is ignored.
  process(pcmBuffer) {
    const count = Math.floor((pcmBuffer?.length ?? 0) / 2);
    for (let i = 0; i < count; i++) this.history.push(pcmBuffer.readInt16LE(i * 2));
    return this.emit();
  }

  // Ends the stream: pads with `halfTaps` zero samples so every output that depends
  // on real input is emitted. The resampler is reset afterwards.
  flush() {
    for (let i = 0; i < this.halfTaps; i++) this.history.push(0);
    const out = this.emit();
    this.reset();
    return out;
  }

  emit() {
    const { halfTaps, step } = this;
    const available = this.historyStart + this.history.length; // exclusive end
    const outputs = [];
    for (;;) {
      const center = Math.floor(this.nextPosition);
      // The window needs input up to center + halfTaps.
      if (center + halfTaps >= available) break;
      const taps = this.kernelFor(this.nextPosition - center);
      const first = center - halfTaps + 1;
      let acc = 0;
      for (let k = 0; k < taps.length; k++) {
        const index = first + k;
        if (index < 0) continue;
        acc += taps[k] * this.history[index - this.historyStart];
      }
      outputs.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      this.nextPosition += step;
    }

    // Keep only what the next output's window still needs.
    const keepFrom = Math.floor(this.nextPosition) - halfTaps + 1;
    const drop = Math.min(this.history.length, Math.max(0, keepFrom - this.historyStart));
    if (drop > 0) {
      this.history.splice(0, drop);
      this.historyStart += drop;
    }

    const out = Buffer.alloc(outputs.length * 2);
    for (let i = 0; i < outputs.length; i++) out.writeInt16LE(outputs[i], i * 2);
    return out;
  }
}
