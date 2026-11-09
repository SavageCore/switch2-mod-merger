import { describe, it, expect } from 'vitest';
import { parseIps, emitIps32, mergeIpsRecords } from '../src/ips.js';

function rec(offset, bytes) {
  return { offset, bytes: new Uint8Array(bytes) };
}

describe('parseIps', () => {
  it('parses classic PATCH files', () => {
    // PATCH + [000100, 0002, AABB] + EOF
    const raw = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0x00, 0x01, 0x00, 0x00, 0x02, 0xaa, 0xbb, 0x45, 0x4f, 0x46]);
    const { magic, records } = parseIps(raw);
    expect(magic).toBe('PATCH');
    expect(records).toHaveLength(1);
    expect(records[0].offset).toBe(0x100);
    expect([...records[0].bytes]).toEqual([0xaa, 0xbb]);
  });

  it('parses IPS32 files', () => {
    // IPS32 + [00000100, 0002, CCDD] + EEOF
    const raw = new Uint8Array([0x49, 0x50, 0x53, 0x33, 0x32, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0xcc, 0xdd, 0x45, 0x45, 0x4f, 0x46]);
    const { magic, records } = parseIps(raw);
    expect(magic).toBe('IPS32');
    expect(records[0].offset).toBe(0x100);
  });

  it('expands RLE records', () => {
    const raw = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x03, 0x7f, 0x45, 0x4f, 0x46]);
    const { records } = parseIps(raw);
    expect([...records[0].bytes]).toEqual([0x7f, 0x7f, 0x7f]);
  });

  it('rejects bad magic', () => {
    expect(() => parseIps(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/magic/);
  });
});

describe('emitIps32', () => {
  it('round-trips through the parser', () => {
    const records = [rec(0x200, [1, 2]), rec(0x100, [9])];
    const { records: back } = parseIps(emitIps32(records));
    expect(back.map((r) => r.offset)).toEqual([0x100, 0x200]);
    expect([...back[0].bytes]).toEqual([9]);
  });
});

describe('mergeIpsRecords', () => {
  it('concatenates disjoint ranges', () => {
    const { merged, conflicts } = mergeIpsRecords([
      { mod: 'A', records: [rec(0x100, [1, 2, 3, 4])] },
      { mod: 'B', records: [rec(0x200, [5, 6])] },
    ]);
    expect(conflicts).toHaveLength(0);
    const { records } = parseIps(merged);
    expect(records).toHaveLength(2);
  });

  it('dedupes identical patches', () => {
    const { merged, conflicts } = mergeIpsRecords([
      { mod: 'A', records: [rec(0x100, [1, 2])] },
      { mod: 'B', records: [rec(0x100, [1, 2])] },
    ]);
    expect(conflicts).toHaveLength(0);
    expect(parseIps(merged).records).toHaveLength(1);
  });

  it('flags overlapping ranges with different bytes', () => {
    const { merged, conflicts } = mergeIpsRecords([
      { mod: 'A', records: [rec(0x100, [1, 2, 3, 4])] },
      { mod: 'B', records: [rec(0x102, [9, 9, 9, 9])] },
    ]);
    expect(merged).toBeNull();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].address).toBe(0x102);
  });

  it('allows overlapping ranges with identical bytes', () => {
    const { merged, conflicts } = mergeIpsRecords([
      { mod: 'A', records: [rec(0x100, [1, 2, 3, 4])] },
      { mod: 'B', records: [rec(0x102, [3, 4])] },
    ]);
    expect(conflicts).toHaveLength(0);
    expect(merged).not.toBeNull();
  });
});
