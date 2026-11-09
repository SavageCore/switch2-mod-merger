import { describe, expect, it } from 'vitest';
import {
  findPchtxtConflicts,
  gameVersionHints,
  mergePchtxt,
  parsePchtxt,
} from '../src/exefs.js';

const CUP = `@nsobid-D00E4F399E411D0613AA8D26B1C02FEF00000000000000000000000000000000

// Example Game v1.8.0 (Build 917504) - Example Mod
@flag print_values

@enabled
00BB1364 1F2003D5

@enabled
007D201C 4A210051
`;

describe('parsePchtxt', () => {
  it('extracts enabled patches', () => {
    const patches = parsePchtxt(CUP);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({
      address: 0x00bb1364,
      size: 4,
      hex: '1F2003D5',
    });
  });

  it('ignores disabled blocks', () => {
    const patches = parsePchtxt('@disabled\n00BB1364 1F2003D5\n');
    expect(patches).toHaveLength(0);
  });
});

describe('findPchtxtConflicts', () => {
  it('flags same address with different bytes', () => {
    const conflicts = findPchtxtConflicts([
      { mod: 'A', patches: [{ address: 1, size: 4, hex: 'AAAA', line: '' }] },
      { mod: 'B', patches: [{ address: 1, size: 4, hex: 'BBBB', line: '' }] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].address).toBe(1);
  });

  it('passes identical patches', () => {
    const conflicts = findPchtxtConflicts([
      { mod: 'A', patches: [{ address: 1, size: 4, hex: 'AAAA', line: '' }] },
      { mod: 'B', patches: [{ address: 1, size: 4, hex: 'AAAA', line: '' }] },
    ]);
    expect(conflicts).toHaveLength(0);
  });
});

describe('mergePchtxt', () => {
  it('concatenates with source headers', () => {
    const merged = mergePchtxt([
      { mod: 'A', text: '@enabled\n0001 AAAA\n' },
      { mod: 'B', text: '@enabled\n0002 BBBB\n' },
    ]);
    expect(merged).toContain('from A');
    expect(merged).toContain('from B');
    expect(mergePchtxt.length).toBeGreaterThan(0);
    expect(parsePchtxt(merged)).toHaveLength(2);
  });
});

describe('gameVersionHints', () => {
  it('finds version and build', () => {
    expect(gameVersionHints(CUP)).toContain('1.8.0');
  });
});
