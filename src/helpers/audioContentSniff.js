// Container detection from the first bytes of a recording. Pure, so the Zoom
// Scribe client can decide between sending the bytes as-is and re-encoding them
// without trusting a file extension or a client-supplied MIME type.

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

const startsWith = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length && bytes.every((byte, i) => buffer[offset + i] === byte);

// Returns "audio/wav", "audio/mp4", "audio/mpeg", "audio/webm", or null.
export function sniffAudioMime(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < 4) return null;
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WAVE") {
    return "audio/wav";
  }
  if (buffer.length >= 8 && buffer.toString("latin1", 4, 8) === "ftyp") return "audio/mp4";
  if (buffer.toString("latin1", 0, 3) === "ID3") return "audio/mpeg";
  // MPEG audio frame sync: 11 set bits, then a non-zero layer. Layer III (MP3) has
  // layer bits 01; AAC ADTS frames share the 0xFFF sync but carry layer bits 00.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && ((buffer[1] >> 1) & 0x03) === 0x01) {
    return "audio/mpeg";
  }
  if (startsWith(buffer, EBML_MAGIC)) return "audio/webm";
  return null;
}

// Maps the MIME types our callers build (with or without codecs or the x-wav
// spelling) onto the bare type the Zoom allowlist compares against.
export function normalizeAudioMime(mimeType) {
  if (typeof mimeType !== "string") return null;
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base === "audio/x-wav" || base === "audio/wave") return "audio/wav";
  if (base === "audio/mp3") return "audio/mpeg";
  if (base === "audio/m4a" || base === "audio/x-m4a") return "audio/mp4";
  return base || null;
}
