import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildSarc, parseSarc } from '../src/sarc.js';
import { zstdCompress, zstdDecompress } from '../src/zstd.js';
import { analyzeMods, buildMerged } from '../src/merge.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sarcZs(entries) {
  const raw = buildSarc(entries.map(([name, text]) => ({ name, data: enc.encode(text) })));
  return zstdCompress(raw, 3);
}

async function modZip(name, { sarcEntries = null, sarcPath = 'System/Test/data.sarc.zs', loose = {}, exefs = {} } = {}) {
  const zip = new JSZip();
  if (sarcEntries) zip.file(`romfs/${sarcPath}`, await sarcZs(sarcEntries));
  for (const [path, text] of Object.entries(loose)) zip.file(`romfs/${path}`, text);
  for (const [path, content] of Object.entries(exefs)) zip.file(`exefs/${path}`, content);
  return { name, arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }) };
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
    const got = await out.file('romfs/System/Test/data.sarc.zs').async('uint8array');
    const want = await (await JSZip.loadAsync(a.arrayBuffer)).file('romfs/System/Test/data.sarc.zs').async('uint8array');
    expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
  });

  it('merges TOTK-style .pack.zs archives too', async () => {
    const a = await modZip('A', { sarcEntries: [['Actor/a.bgyml', '1']], sarcPath: 'Pack/Actor.pack.zs' });
    const b = await modZip('B', { sarcEntries: [['Actor/a.bgyml', '2']], sarcPath: 'Pack/Actor.pack.zs' });
    const analysis = await analyzeMods([a, b]);
    expect(analysis.archives).toHaveLength(1);
    expect(analysis.archives[0].rel).toBe('Pack/Actor.pack.zs');
    const { zipBytes } = await buildMerged(analysis, { picks: new Map([['Pack/Actor.pack.zs\nActor/a.bgyml', 1]]) });
    const out = await JSZip.loadAsync(zipBytes);
    const mergedZs = await out.file('romfs/Pack/Actor.pack.zs').async('uint8array');
    const { files } = parseSarc(await zstdDecompress(mergedZs));
    expect(dec.decode(files[0].data)).toBe('2');
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
    const { zipBytes, manifest } = await buildMerged(analysis, { picks: picked });
    const out = await JSZip.loadAsync(zipBytes);
    const mergedZs = await out.file('romfs/System/Test/data.sarc.zs').async('uint8array');
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
    const vanillaRaw = buildSarc(BASE.slice(0, 2).map(([name, text]) => ({ name, data: enc.encode(text) })));
    const analysis = await analyzeMods([a, b], new Map([['data.sarc.zs', vanillaRaw]]));
    expect(analysis.archives[0].groups).toHaveLength(0);
    expect(analysis.archives[0].autoResolved).toHaveLength(1);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    const mergedZs = await out.file('romfs/System/Test/data.sarc.zs').async('uint8array');
    const { files } = parseSarc(await zstdDecompress(mergedZs));
    expect(dec.decode(files.find((f) => f.name === 'Gyml/Cups/Banana.bgyml').data)).toBe('mod-cup');
  });

  it('concatenates pchtxt and passes exefs through', async () => {
    const a = await modZip('A', { exefs: { 'BID.pchtxt': '@enabled\n0001 AAAA\n' } });
    const b = await modZip('B', { exefs: { 'BID.pchtxt': '@enabled\n0002 BBBB\n' } });
    const analysis = await analyzeMods([a, b]);
    expect(analysis.exefs[0].conflicts).toHaveLength(0);
    const { zipBytes } = await buildMerged(analysis, { picks: new Map() });
    const out = await JSZip.loadAsync(zipBytes);
    const text = await out.file('exefs/BID.pchtxt').async('string');
    expect(text).toContain('0001 AAAA');
    expect(text).toContain('0002 BBBB');
  });

  it('blocks on game version mismatch', async () => {
    const a = await modZip('A', { exefs: { 'BID.pchtxt': '// Example Game v1.8.0\n@enabled\n0001 AAAA\n' } });
    const b = await modZip('B', { exefs: { 'BID.pchtxt': '// Example Game v1.7.0\n@enabled\n0001 AAAA\n' } });
    await expect(analyzeMods([a, b])).rejects.toThrow(/version mismatch/i);
  });

  it('throws when a pick is missing', async () => {
    const a = await modZip('A', { sarcEntries: [['Gyml/X/a.bgyml', '1']] });
    const b = await modZip('B', { sarcEntries: [['Gyml/X/a.bgyml', '2']] });
    const analysis = await analyzeMods([a, b]);
    await expect(buildMerged(analysis, { picks: new Map() })).rejects.toThrow(/No resolution/);
  });
});
