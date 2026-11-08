/**
 * SARC (Sead Archive) reader and writer, clean-room implementation.
 *
 * Verified byte-for-byte against 11,102-file little-endian v0x100 game
 * archives (Mario Kart World's `general_format.Product_180.sarc`):
 *
 * - Header (0x14): 'SARC', u16 header length, u16 BOM, u32 file size,
 *   u32 data-section offset, u16 version, u16 reserved.
 * - SFAT (0x0C): 'SFAT', u16 header length, u16 file count, u32 hash key.
 * - SFAT nodes (0x10 each), sorted by filename hash ascending:
 *   u32 hash, u32 (flags << 24 | nameTableByteOffset / 4),
 *   u32 data start, u32 data end (both relative to the data section).
 * - SFNT (0x08): 'SFNT', u16 header length, u16 reserved, then the
 *   null-terminated filename table. Each entry is padded to 4 bytes and
 *   node offsets address it in 4-byte units.
 * - Data section: file bytes packed in order, each file starting on a
 *   0x100-byte boundary.
 *
 * Filename hash: h = 0; for each UTF-16 code unit c: h = h * 0x65 + c.
 */

export const SARC_MAGIC = 0x43524153; // 'SARC' little-endian
export const SFAT_MAGIC = 0x54414653; // 'SFAT'
export const SFNT_MAGIC = 0x544e4653; // 'SFNT'
export const HASH_KEY = 0x65;
export const DATA_ALIGNMENT = 0x100;
export const NODE_FLAG = 0x01;

export function filenameHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(h, HASH_KEY) + name.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function alignUp(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

function decodeAscii(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Parse a SARC archive.
 * @param {Uint8Array} bytes raw (decompressed) archive
 * @returns {{ littleEndian: boolean, version: number, files: Array<{name: string, data: Uint8Array}> }}
 *   files are returned in data-section order.
 */
export function parseSarc(bytes) {
  if (bytes.length < 0x14) throw new Error('Too small to be a SARC archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

  if (view.getUint32(0, true) !== SARC_MAGIC) throw new Error('Bad SARC magic');
  const bom = view.getUint16(6, true);
  const littleEndian = bom === 0xfeff;
  const le = littleEndian;
  if (!littleEndian && bom !== 0xfffe) throw new Error('Bad SARC BOM');

  const headerLength = view.getUint16(4, le);
  const fileSize = view.getUint32(8, le);
  const dataOffset = view.getUint32(12, le);
  const version = view.getUint16(16, le);
  if (headerLength < 0x14) throw new Error('Bad SARC header length');
  if (fileSize !== bytes.length) throw new Error(`SARC size mismatch: header says ${fileSize}, got ${bytes.length}`);

  let pos = headerLength;
  if (view.getUint32(pos, le) !== SFAT_MAGIC) throw new Error('Bad SFAT magic');
  const sfatLength = view.getUint16(pos + 4, le);
  const fileCount = view.getUint16(pos + 6, le);
  const hashKey = view.getUint32(pos + 8, le);
  if (hashKey !== HASH_KEY) throw new Error(`Unsupported SARC hash key ${hashKey}`);
  pos += sfatLength;

  const nodes = [];
  for (let i = 0; i < fileCount; i++) {
    const hash = view.getUint32(pos, le);
    const nameField = view.getUint32(pos + 4, le);
    const start = view.getUint32(pos + 8, le);
    const end = view.getUint32(pos + 12, le);
    nodes.push({ hash, flags: nameField >>> 24, nameOffset: (nameField & 0xffffff) * 4, start, end });
    pos += 0x10;
  }

  if (view.getUint32(pos, le) !== SFNT_MAGIC) throw new Error('Bad SFNT magic');
  const sfntLength = view.getUint16(pos + 4, le);
  const stringTable = pos + sfntLength;

  const readName = (offset) => {
    const abs = stringTable + offset;
    let end = abs;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end >= bytes.length) throw new Error('Filename runs past end of archive');
    return decodeAscii(bytes, abs, end);
  };

  const files = nodes.map((node) => {
    if (dataOffset + node.end > bytes.length) throw new Error('File data runs past end of archive');
    const name = readName(node.nameOffset);
    if (filenameHash(name) !== node.hash) {
      throw new Error(`Filename hash mismatch for "${name}"`);
    }
    return {
      name,
      data: bytes.subarray(dataOffset + node.start, dataOffset + node.end),
      _offset: node.start,
    };
  });

  // Return in data-section order so a rebuild keeps the original layout.
  files.sort((a, b) => a._offset - b._offset);
  for (const f of files) delete f._offset;
  return { littleEndian, version, files };
}

/**
 * Build a SARC archive.
 * @param {Array<{name: string, data: Uint8Array}>} inputFiles files in the
 *   desired data-section order (duplicated names: last one wins).
 * @param {{ littleEndian?: boolean, version?: number }} options
 * @returns {Uint8Array} the archive bytes.
 */
export function buildSarc(inputFiles, options = {}) {
  const littleEndian = options.littleEndian !== false;
  const le = littleEndian;
  const version = options.version ?? 0x100;

  const byName = new Map();
  for (const f of inputFiles) byName.set(f.name, f.data);
  const orderedNames = [];
  const seen = new Set();
  for (const f of inputFiles) {
    if (!seen.has(f.name)) {
      seen.add(f.name);
      orderedNames.push(f.name);
    }
  }
  const files = orderedNames.map((name) => ({ name, data: byName.get(name) }));

  // String table: names in data order, each null-terminated and 4-aligned.
  const encoder = new TextEncoder();
  const nameBytes = files.map((f) => encoder.encode(f.name));
  const nameOffsets = [];
  let tableSize = 0;
  for (const nb of nameBytes) {
    nameOffsets.push(tableSize);
    tableSize = alignUp(tableSize + nb.length + 1, 4);
  }

  const fileCount = files.length;
  const headerLength = 0x14;
  const sfatLength = 0x0c;
  const sfntLength = 0x08;
  const nodesSize = fileCount * 0x10;
  const dataOffset = headerLength + sfatLength + nodesSize + sfntLength + tableSize;

  let dataSize = 0;
  const dataStarts = [];
  for (const f of files) {
    const start = alignUp(dataSize, DATA_ALIGNMENT);
    dataStarts.push(start);
    dataSize = start + f.data.length;
  }
  const totalSize = dataOffset + dataSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  view.setUint32(0, SARC_MAGIC, le);
  view.setUint16(4, headerLength, le);
  view.setUint16(6, littleEndian ? 0xfeff : 0xfffe, le);
  view.setUint32(8, totalSize, le);
  view.setUint32(12, dataOffset, le);
  view.setUint16(16, version, le);
  view.setUint16(18, 0, le);

  let pos = headerLength;
  view.setUint32(pos, SFAT_MAGIC, le);
  view.setUint16(pos + 4, sfatLength, le);
  view.setUint16(pos + 6, fileCount, le);
  view.setUint32(pos + 8, HASH_KEY, le);
  pos += sfatLength;

  const nodes = files.map((f, i) => ({
    hash: filenameHash(f.name),
    field: (NODE_FLAG << 24) | (nameOffsets[i] / 4),
    start: dataStarts[i],
    end: dataStarts[i] + f.data.length,
  }));
  nodes.sort((a, b) => a.hash - b.hash);
  for (const n of nodes) {
    view.setUint32(pos, n.hash, le);
    view.setUint32(pos + 4, n.field, le);
    view.setUint32(pos + 8, n.start, le);
    view.setUint32(pos + 12, n.end, le);
    pos += 0x10;
  }

  view.setUint32(pos, SFNT_MAGIC, le);
  view.setUint16(pos + 4, sfntLength, le);
  view.setUint16(pos + 6, 0, le);
  pos += sfntLength;

  for (let i = 0; i < files.length; i++) {
    out.set(nameBytes[i], pos + nameOffsets[i]);
  }
  pos += tableSize;

  for (let i = 0; i < files.length; i++) {
    out.set(files[i].data, pos + dataStarts[i]);
  }

  return out;
}

/** Group inner-file paths by their parent directory, for the pick UI. */
export function groupByDirectory(paths) {
  const groups = new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    const dir = slash >= 0 ? p.slice(0, slash) : '(root)';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(p);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
