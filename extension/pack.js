// Packing what is stored: JSON, compressed, as text.
//
// Saved sessions are long lists of addresses and titles, which compress to a
// fraction of their size. They are packed before they are stored, and then
// sealed by the helper with the sessions key (background.js). The format is
// gzip, so a packed store can be unpacked by any tool.

const CHUNK = 0x8000;

/** Bytes to base64, in pieces so a large store does not overflow the call stack. */
export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(text);
}

export function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function through(stream, bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Any JSON value to compressed base64 text. */
export async function pack(value) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  return toBase64(await through(new CompressionStream("gzip"), plain));
}

/** The value back from `pack`'s text. Throws if the text is not a packed value. */
export async function unpack(text) {
  const plain = await through(new DecompressionStream("gzip"), fromBase64(text));
  return JSON.parse(new TextDecoder().decode(plain));
}
