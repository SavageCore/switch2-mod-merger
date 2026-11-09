/**
 * IPS / IPS32 code-patch parsing and merging.
 *
 * Classic IPS:  `PATCH` + records[u24be offset, u16be size, bytes] + `EOF`.
 * IPS32 (what Switch mods ship): `IPS32` + records[u32be offset, u16be size,
 * bytes] + `EEOF`. A zero size marks an RLE record, expanded on parse.
 *
 * Records from several mods merge exactly like pchtxt lines: disjoint
 * address ranges concatenate, overlapping ranges with different bytes are a
 * conflict. Output is always IPS32, which covers the full 32-bit range.
 */

export function parseIps(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let magic;
  let offsetWidth;
  let eof;
  if (data.length >= 5 && data[0] === 0x50 && data[1] === 0x41 && data[2] === 0x54 && data[3] === 0x43 && data[4] === 0x48) {
    magic = 'PATCH';
    offsetWidth = 3;
    eof = [0x45, 0x4f, 0x46];
  } else if (data.length >= 5 && data[0] === 0x49 && data[1] === 0x50 && data[2] === 0x53 && data[3] === 0x33 && data[4] === 0x32) {
    magic = 'IPS32';
    offsetWidth = 4;
    eof = [0x45, 0x45, 0x4f, 0x46];
  } else {
    throw new Error('Not an IPS patch (bad magic)');
  }
  const records = [];
  let p = 5;
  const atEof = () => eof.every((b, i) => data[p + i] === b);
  while (!atEof()) {
    if (p + offsetWidth + 2 > data.length) throw new Error('Truncated IPS record');
    let offset = 0;
    for (let i = 0; i < offsetWidth; i++) offset = offset * 256 + data[p + i];
    p += offsetWidth;
    const size = (data[p] << 8) | data[p + 1];
    p += 2;
    if (size === 0) {
      if (p + 3 > data.length) throw new Error('Truncated IPS RLE record');
      const runLength = (data[p] << 8) | data[p + 1];
      const value = data[p + 2];
      p += 3;
      records.push({ offset, bytes: new Uint8Array(runLength).fill(value) });
    } else {
      if (p + size > data.length) throw new Error('Truncated IPS record data');
      records.push({ offset, bytes: data.slice(p, p + size) });
      p += size;
    }
    if (p > data.length) throw new Error('IPS runs past end of file');
  }
  return { magic, records };
}

export function emitIps32(records) {
  const sorted = [...records].sort((a, b) => a.offset - b.offset);
  let size = 5 + 4;
  for (const r of sorted) {
    if (r.bytes.length === 0 || r.bytes.length > 0xffff) throw new Error(`Unemittable IPS record at 0x${r.offset.toString(16)}`);
    size += 4 + 2 + r.bytes.length;
  }
  const out = new Uint8Array(size);
  out.set([0x49, 0x50, 0x53, 0x33, 0x32], 0);
  let p = 5;
  const writeU32 = (v) => {
    out[p] = (v >>> 24) & 0xff;
    out[p + 1] = (v >>> 16) & 0xff;
    out[p + 2] = (v >>> 8) & 0xff;
    out[p + 3] = v & 0xff;
    p += 4;
  };
  for (const r of sorted) {
    writeU32(r.offset);
    out[p] = (r.bytes.length >>> 8) & 0xff;
    out[p + 1] = r.bytes.length & 0xff;
    p += 2;
    out.set(r.bytes, p);
    p += r.bytes.length;
  }
  out.set([0x45, 0x45, 0x4f, 0x46], p);
  return out;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Merge IPS records from several mods.
 * @param {Array<{mod: string, records: Array<{offset: number, bytes: Uint8Array}>}>} perMod
 * @returns {{ merged: Uint8Array|null, conflicts: Array<{address: number, size: number, entries: Array<{mod: string, hex: string}>}> }}
 */
export function mergeIpsRecords(perMod) {
  const conflicts = [];
  const flat = [];
  for (const { mod, records } of perMod) {
    for (const r of records) flat.push({ mod, offset: r.offset, bytes: r.bytes });
  }
  const seen = new Set();
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i];
      const b = flat[j];
      if (a.mod === b.mod) continue;
      if (!rangesOverlap(a.offset, a.offset + a.bytes.length, b.offset, b.offset + b.bytes.length)) continue;
      const key = `${a.mod}<${b.mod}@${Math.min(a.offset, b.offset)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Compare the overlapping window byte for byte.
      const start = Math.max(a.offset, b.offset);
      const end = Math.min(a.offset + a.bytes.length, b.offset + b.bytes.length);
      let same = true;
      for (let k = start; k < end; k++) {
        if (a.bytes[k - a.offset] !== b.bytes[k - b.offset]) {
          same = false;
          break;
        }
      }
      if (!same) {
        conflicts.push({
          address: start,
          size: end - start,
          entries: [
            { mod: a.mod, hex: hex(a.bytes) },
            { mod: b.mod, hex: hex(b.bytes) },
          ],
        });
      }
    }
  }
  if (conflicts.length > 0) return { merged: null, conflicts };
  // Dedupe identical ranges, keep first.
  const kept = [];
  for (const r of flat) {
    if (!kept.some((k) => k.offset === r.offset && k.bytes.length === r.bytes.length && hex(k.bytes) === hex(r.bytes))) {
      kept.push(r);
    }
  }
  return { merged: emitIps32(kept), conflicts: [] };
}
