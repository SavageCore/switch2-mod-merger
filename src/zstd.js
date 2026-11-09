import { compress, decompress, init } from '@bokuweb/zstd-wasm';

let ready = null;

export function ensureZstd() {
  if (!ready) ready = init();
  return ready;
}

/** @returns {Promise<Uint8Array>} */
export async function zstdDecompress(bytes) {
  await ensureZstd();
  return decompress(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
}

/** @returns {Promise<Uint8Array>} */
export async function zstdCompress(bytes, level = 10) {
  await ensureZstd();
  return compress(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    level,
  );
}
