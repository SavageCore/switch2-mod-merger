import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { emitIps32 } from '../src/ips.js';
import {
  analyzeMods,
  buildMerged,
  detectVariants,
  mergedModName,
  scanSharedArchives,
} from '../src/merge.js';
import { buildSarc, parseSarc } from '../src/sarc.js';
import { zstdCompress, zstdDecompress } from '../src/zstd.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function testIps(records) {
  return emitIps32(
    records.map(([offset, bytes]) => ({
      offset,
      bytes: new Uint8Array(bytes),
    })),
  );
}

async function sarcZs(entries) {
  const raw = buildSarc(
    entries.map(([name, text]) => ({ name, data: enc.encode(text) })),
  );
  return zstdCompress(raw, 3);
}

async function modZip(
  name,
  {
    sarcEntries = null,
    sarcPath = 'System/Test/data.sarc.zs',
    loose = {},
    exefs = {},
  } = {},
  prefix = '',
) {
  const zip = new JSZip();
  if (sarcEntries)
    zip.file(`${prefix}romfs/${sarcPath}`, await sarcZs(sarcEntries));
  for (const [path, text] of Object.entries(loose))
    zip.file(`${prefix}romfs/${path}`, text);
  for (const [path, content] of Object.entries(exefs))
    zip.file(`${prefix}exefs/${path}`, content);
  return {
    name,
    arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }),
  };
}

const BASE = [
  ['Gyml/Cups/Banana.bgyml', 'vanilla-cup'],
  ['Gyml/Lod/CmnObj.bgyml', 'vanilla-lod'],
  ['Gyml/Lod/Other.bgyml', 'vanilla-other'],
];

describe('analyze + merge', () => {
  it('copies byte-identical archives verbatim', async () => {
    const a = await modZip('A', { sarcEntries: BASE });
    const b = await modZip('B', { sarcEntries: BASE });
    const analysis = await analyzeMods([a, b]);
    expect(analysis.archives).toHaveLength(1);
    expect(analysis.archives[0].groups).toHaveLength(0);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    const got = await out
      .file('A+B/romfs/System/Test/data.sarc.zs')
      .async('uint8array');
    const want = await (await JSZip.loadAsync(a.arrayBuffer))
      .file('romfs/System/Test/data.sarc.zs')
      .async('uint8array');
    expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
  });

  it('flags disjoint changes for picking, then merges per picks', async () => {
    const a = await modZip('ClassicGP', {
      sarcEntries: [
        ['Gyml/Cups/Banana.bgyml', 'classic-cup'],
        ['Gyml/Lod/CmnObj.bgyml', 'vanilla-lod'],
        ['Gyml/Lod/Other.bgyml', 'vanilla-other'],
      ],
    });
    const b = await modZip('Light', {
      sarcEntries: [
        ['Gyml/Cups/Banana.bgyml', 'vanilla-cup'],
        ['Gyml/Lod/CmnObj.bgyml', 'light-lod'],
        ['Gyml/Lod/Other.bgyml', 'vanilla-other'],
      ],
    });
    const analysis = await analyzeMods([a, b]);
    const arch = analysis.archives[0];
    expect(arch.identicalCount).toBe(1);
    const picked = new Map();
    for (const g of arch.groups) {
      for (const f of g.files) {
        picked.set(`${arch.rel}\n${f.inner}`, f.inner.includes('Cups') ? 0 : 1);
      }
    }
    const { zipBytes, manifest } = await buildMerged(analysis, {
      picks: picked,
    });
    const out = await JSZip.loadAsync(zipBytes);
    const mergedZs = await out
      .file('ClassicGP+Light/romfs/System/Test/data.sarc.zs')
      .async('uint8array');
    const { files } = parseSarc(await zstdDecompress(mergedZs));
    const got = new Map(files.map((f) => [f.name, dec.decode(f.data)]));
    expect(got.get('Gyml/Cups/Banana.bgyml')).toBe('classic-cup');
    expect(got.get('Gyml/Lod/CmnObj.bgyml')).toBe('light-lod');
    expect(got.get('Gyml/Lod/Other.bgyml')).toBe('vanilla-other');
    expect(manifest.archives['System/Test/data.sarc.zs'].action).toBe('merged');
  });

  it('auto-resolves with vanilla, no picks needed', async () => {
    const a = await modZip('A', {
      sarcEntries: [
        ['Gyml/Cups/Banana.bgyml', 'mod-cup'],
        ['Gyml/Lod/CmnObj.bgyml', 'vanilla-lod'],
      ],
    });
    const b = await modZip('B', { sarcEntries: BASE.slice(0, 2) });
    const vanillaRaw = buildSarc(
      BASE.slice(0, 2).map(([name, text]) => ({
        name,
        data: enc.encode(text),
      })),
    );
    const analysis = await analyzeMods(
      [a, b],
      new Map([['data.sarc.zs', vanillaRaw]]),
    );
    expect(analysis.archives[0].groups).toHaveLength(0);
    expect(analysis.archives[0].autoResolved).toHaveLength(1);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    const mergedZs = await out
      .file('A+B/romfs/System/Test/data.sarc.zs')
      .async('uint8array');
    const { files } = parseSarc(await zstdDecompress(mergedZs));
    expect(
      dec.decode(files.find((f) => f.name === 'Gyml/Cups/Banana.bgyml').data),
    ).toBe('mod-cup');
  });

  it('concatenates pchtxt and passes exefs through', async () => {
    const a = await modZip('A', {
      exefs: { 'BID.pchtxt': '@enabled\n0001 AAAA\n' },
    });
    const b = await modZip('B', {
      exefs: { 'BID.pchtxt': '@enabled\n0002 BBBB\n' },
    });
    const analysis = await analyzeMods([a, b]);
    expect(analysis.exefs[0].conflicts).toHaveLength(0);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    const text = await out.file('A+B/exefs/BID.pchtxt').async('string');
    expect(text).toContain('0001 AAAA');
    expect(text).toContain('0002 BBBB');
  });

  it('blocks on game version mismatch', async () => {
    const a = await modZip('A', {
      exefs: { 'BID.pchtxt': '// Example Game v1.8.0\n@enabled\n0001 AAAA\n' },
    });
    const b = await modZip('B', {
      exefs: { 'BID.pchtxt': '// Example Game v1.7.0\n@enabled\n0001 AAAA\n' },
    });
    await expect(analyzeMods([a, b])).rejects.toThrow(/version mismatch/i);
  });

  it('throws when a pick is missing', async () => {
    const a = await modZip('A', { sarcEntries: [['Gyml/X/a.bgyml', '1']] });
    const b = await modZip('B', { sarcEntries: [['Gyml/X/a.bgyml', '2']] });
    const analysis = await analyzeMods([a, b]);
    await expect(buildMerged(analysis, { picks: new Map() })).rejects.toThrow(
      /No resolution/,
    );
  });

  it('keeps managed exefs out of loose conflicts', async () => {
    const ipsA = testIps([[0x100, [1, 2, 3, 4]]]);
    const ipsB = testIps([[0x200, [5, 6]]]);
    const a = await modZip('A', {
      exefs: { 'BID.pchtxt': '@enabled\n0001 AAAA\n', 'BID.ips': ipsA },
    });
    const b = await modZip('B', {
      exefs: { 'BID.pchtxt': '@enabled\n0002 BBBB\n', 'BID.ips': ipsB },
    });
    const analysis = await analyzeMods([a, b]);
    expect(analysis.looseConflicts).toHaveLength(0);
    expect(analysis.exefs.map((e) => e.kind).sort()).toEqual(['ips', 'pchtxt']);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    expect(out.file('A+B/exefs/BID.pchtxt')).not.toBeNull();
    expect(out.file('A+B/exefs/BID.ips')).not.toBeNull();
  });
});

describe('mod display names', () => {
  it('takes casing from a single top-level folder', async () => {
    const a = await modZip(
      'classicgp.zip',
      { loose: { 'x.txt': '1' } },
      'ClassicGP/',
    );
    const b = await modZip(
      'secrettracks.zip',
      { loose: { 'y.txt': '2' } },
      'SecretTracks/',
    );
    const analysis = await analyzeMods([a, b]);
    expect(analysis.mods).toEqual(['ClassicGP', 'SecretTracks']);
    const { zipBytes, manifest } = await buildMerged(analysis, {
      picks: new Map(),
    });
    expect(manifest.name).toBe('ClassicGP+SecretTracks');
    const out = await JSZip.loadAsync(zipBytes);
    expect(out.file('ClassicGP+SecretTracks/romfs/x.txt')).not.toBeNull();
  });

  it('falls back to the zip name for multi-mod zips and root-level romfs', async () => {
    const zip = new JSZip();
    zip.file('Light/romfs/x.txt', '1');
    zip.file('Strong/romfs/x.txt', '2');
    const multi = {
      name: 'perf.zip',
      arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }),
    };
    const root = await modZip('plain.zip', { loose: { 'x.txt': '1' } });
    const analysis = await analyzeMods([multi, root]);
    expect(analysis.mods).toEqual(['perf.zip', 'plain.zip']);
  });
});

describe('mergedModName', () => {
  it('joins mod names with +', () => {
    expect(mergedModName(['ClassicGP', 'SecretTracks'])).toBe(
      'ClassicGP+SecretTracks',
    );
  });

  it('alphabetises while keeping source capitalisation exactly', () => {
    expect(mergedModName(['SecretTracks', 'ClassicGP', 'light'])).toBe(
      'ClassicGP+light+SecretTracks',
    );
  });

  it('dedupes repeat names', () => {
    expect(mergedModName(['A', 'A', 'B'])).toBe('A+B');
  });

  it('strips filename-unsafe characters', () => {
    expect(mergedModName(['a/b', 'c:d*e'])).toBe('a_b+c_d_e');
  });

  it('lands in the manifest and the zip top level', async () => {
    const a = await modZip('A', { loose: { 'x.txt': '1' } });
    const b = await modZip('B', { loose: { 'x.txt': '2' } });
    const analysis = await analyzeMods([a, b]);
    const { zipBytes, manifest } = await buildMerged(analysis, {
      picks: new Map([['loose:romfs/x.txt', 1]]),
    });
    expect(manifest.name).toBe('A+B');
    const out = await JSZip.loadAsync(zipBytes);
    expect(out.file('A+B/romfs/x.txt')).not.toBeNull();
    expect(out.file('A+B/switch2-mod-merger-manifest.json')).toBeNull();
  });
});

describe('mod variants', () => {
  async function variantZip() {
    const zip = new JSZip();
    zip.file(
      'Light/romfs/System/Test/data.sarc.zs',
      await sarcZs([['Gyml/X/a.bgyml', 'light']]),
    );
    zip.file(
      'Strong/romfs/System/Test/data.sarc.zs',
      await sarcZs([['Gyml/X/a.bgyml', 'strong']]),
    );
    return {
      name: 'perf.zip',
      arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }),
    };
  }

  it('detects variant folders in zip order', async () => {
    expect(await detectVariants((await variantZip()).arrayBuffer)).toEqual([
      'Light',
      'Strong',
    ]);
  });

  it('merges only the chosen variant', async () => {
    for (const [choice, want] of [
      ['Light', 'light'],
      ['Strong', 'strong'],
    ]) {
      const v = await variantZip();
      const analysis = await analyzeMods([{ ...v, variant: choice }]);
      expect(analysis.mods).toEqual([choice]);
      const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
      const out = await JSZip.loadAsync(zipBytes);
      const zs = await out
        .file(`${choice}/romfs/System/Test/data.sarc.zs`)
        .async('uint8array');
      const { files } = parseSarc(await zstdDecompress(zs));
      expect(dec.decode(files[0].data)).toBe(want);
    }
  });

  it('scan respects the chosen variant', async () => {
    const v = await variantZip();
    const a = await modZip('A', {
      sarcEntries: [['Gyml/X/a.bgyml', 'strong']],
      sarcPath: 'System/Test/data.sarc.zs',
    });
    const shared = await scanSharedArchives([{ ...v, variant: 'Strong' }, a]);
    expect(shared).toHaveLength(1);
    expect(shared[0].differing).toBe(false);
  });
});

describe('scanSharedArchives', () => {
  it('detects a differing archive shared by three mods, ignores unique ones', async () => {
    const opts = (text) => ({
      sarcEntries: [['Gyml/X/a.bgyml', text]],
      sarcPath: 'Sys/d.sarc.zs',
    });
    const a = await modZip('A', opts('1'));
    const b = await modZip('B', opts('2'));
    const c = await modZip('C', {
      ...opts('3'),
      loose: { 'Only/here.txt': 'x' },
    });
    const shared = await scanSharedArchives([a, b, c]);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      rel: 'Sys/d.sarc.zs',
      filename: 'd.sarc.zs',
      differing: true,
    });
    expect(shared[0].mods).toEqual(['A', 'B', 'C']);
  });

  it('marks byte-identical shared archives as clean', async () => {
    const opts = { sarcEntries: [['Gyml/X/a.bgyml', 'same']] };
    const a = await modZip('A', opts);
    const b = await modZip('B', opts);
    const shared = await scanSharedArchives([a, b]);
    expect(shared).toHaveLength(1);
    expect(shared[0].differing).toBe(false);
  });

  it('returns empty when no archive is shared', async () => {
    const a = await modZip('A', {
      sarcPath: 'Sys/a.sarc.zs',
      sarcEntries: [['Gyml/X/a.bgyml', '1']],
    });
    const b = await modZip('B', {
      sarcPath: 'Sys/b.sarc.zs',
      sarcEntries: [['Gyml/X/a.bgyml', '1']],
    });
    expect(await scanSharedArchives([a, b])).toHaveLength(0);
  });
});
