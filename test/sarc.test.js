import { describe, expect, it } from 'vitest';
import {
  buildSarc,
  bytesEqual,
  filenameHash,
  groupByDirectory,
  parseSarc,
} from '../src/sarc.js';

const enc = new TextEncoder();

function files(...pairs) {
  return pairs.map(([name, text]) => ({ name, data: enc.encode(text) }));
}

describe('filenameHash', () => {
  it('hashes the empty string to 0', () => {
    expect(filenameHash('')).toBe(0);
  });
  it('matches a known hash-order-first game entry', () => {
    // Gyml/Component/ExistConditionGParam/StageHigh... is hash-order first (0x1ed1)
    expect(
      filenameHash(
        'Gyml/Component/ExistConditionGParam/StageHigh.gear__ExistConditionGParam.bgyml',
      ),
    ).toBe(0x1ed1);
  });
});

describe('sarc round-trip', () => {
  it('parses what it builds', () => {
    const input = files(
      ['a.txt', 'hello'],
      ['dir/b.bin', 'world!'],
      ['empty', ''],
    );
    const bytes = buildSarc(input);
    const { files: out } = parseSarc(bytes);
    expect(out.map((f) => f.name).sort()).toEqual([
      'a.txt',
      'dir/b.bin',
      'empty',
    ]);
    for (const f of out) {
      const want = input.find((i) => i.name === f.name).data;
      expect(bytesEqual(f.data, want)).toBe(true);
    }
  });

  it('last duplicate name wins', () => {
    const bytes = buildSarc(files(['a', 'one'], ['a', 'two']));
    const { files: out } = parseSarc(bytes);
    expect(out).toHaveLength(1);
    expect(new TextDecoder().decode(out[0].data)).toBe('two');
  });

  it('keeps data-section order stable', () => {
    const input = files(['z-last', '1'], ['a-first', '2'], ['m-mid', '3']);
    const { files: out } = parseSarc(buildSarc(input));
    expect(out.map((f) => f.name)).toEqual(['z-last', 'a-first', 'm-mid']);
  });

  it('rejects bad magic', () => {
    expect(() => parseSarc(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });

  it('handles 2000 files', () => {
    const input = [];
    for (let i = 0; i < 2000; i++)
      input.push({
        name: `Gyml/Cat${i % 7}/file_${i}.bgyml`,
        data: enc.encode(`payload-${i}`),
      });
    const { files: out } = parseSarc(buildSarc(input));
    expect(out).toHaveLength(2000);
  });
});

describe('groupByDirectory', () => {
  it('groups by parent dir', () => {
    const groups = groupByDirectory(['Gyml/A/x', 'Gyml/A/y', 'Gyml/B/z']);
    expect(groups).toEqual([
      ['Gyml/A', ['Gyml/A/x', 'Gyml/A/y']],
      ['Gyml/B', ['Gyml/B/z']],
    ]);
  });
});
