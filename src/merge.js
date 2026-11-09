import JSZip from 'jszip';
import { parseSarc, buildSarc, groupByDirectory, bytesEqual } from './sarc.js';
import { zstdDecompress, zstdCompress } from './zstd.js';
import { parsePchtxt, findPchtxtConflicts, mergePchtxt, gameVersionHints } from './exefs.js';

const ZSTD_MAGIC = 0xfd2fb528;

function isZstd(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === (ZSTD_MAGIC & 0xff) &&
    bytes[1] === ((ZSTD_MAGIC >> 8) & 0xff) &&
    bytes[2] === ((ZSTD_MAGIC >> 16) & 0xff) &&
    bytes[3] === ((ZSTD_MAGIC >> 24) & 0xff)
  );
}

function isSarc(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x43;
}

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Folder/file-safe display name for the merged mod: ClassicGP+SecretTracks.
 *  Source capitalization is kept exactly; names are sorted alphabetically. */
export function mergedModName(modNames) {
  const clean = modNames
    .map((n) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 60))
    .filter((n) => n.length > 0);
  const unique = [...new Set(clean)];
  unique.sort((a, b) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return (unique.length > 0 ? unique : ['merged']).join('+');
}

/** Compressed SARC archives mods ship: .sarc.zs and TOTK-style .pack.zs. */
export function isGameArchive(rel) {
  const lower = rel.toLowerCase();
  return lower.endsWith('.sarc.zs') || lower.endsWith('.pack.zs');
}

/** Split a zip entry path into { kind: 'romfs'|'exefs', rel } or null when unrelated. */
export function normalizeEntryPath(fullPath) {
  const parts = fullPath.split('/').filter((p) => p !== '' && p !== '.' && p !== '__MACOSX');
  if (parts.some((p) => p === '.DS_Store')) return null;
  const idx = parts.findIndex((p) => p === 'romfs' || p === 'exefs');
  if (idx < 0 || idx === parts.length - 1) return null;
  return { kind: parts[idx], rel: parts.slice(idx + 1).join('/') };
}

export async function readModZip(name, arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries = [];
  const jobs = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const norm = normalizeEntryPath(relativePath);
    if (!norm) return;
    jobs.push(
      entry.async('uint8array').then((data) => {
        entries.push({ kind: norm.kind, rel: norm.rel, data: new Uint8Array(data) });
      }),
    );
  });
  await Promise.all(jobs);
  return { name, entries };
}

function checkVersionGate(mods) {
  const versionsByMod = new Map();
  for (const mod of mods) {
    const found = new Set();
    for (const e of mod.entries) {
      if (e.kind === 'exefs' && e.rel.toLowerCase().endsWith('.pchtxt')) {
        const text = new TextDecoder().decode(e.data);
        for (const v of gameVersionHints(text)) {
          if (/^build /.test(v)) continue;
          found.add(v);
        }
      }
    }
    if (found.size > 0) versionsByMod.set(mod.name, found);
  }
  const all = new Set([...versionsByMod.values()].flatMap((s) => [...s]));
  if (all.size > 1) {
    throw new Error(
      `Game version mismatch: ${[...versionsByMod.entries()].map(([m, s]) => `${m} (${[...s].join(', ')})`).join('; ')}. Merge mods built for the same game version.`,
    );
  }
}

/**
 * Lightweight pre-scan: which game archives are replaced by 2+ mods, and
 * whether their contents actually differ. Reads only the archive entries
 * (no decompression), so it runs right after upload to tell the user which
 * vanilla files to supply for auto-merge.
 * @param {Array<{name: string, arrayBuffer: ArrayBuffer}>} modZips
 * @returns {Promise<Array<{rel: string, filename: string, mods: string[], differing: boolean}>>}
 */
export async function scanSharedArchives(modZips) {
  const perMod = [];
  for (const z of modZips) {
    const zip = await JSZip.loadAsync(z.arrayBuffer);
    const found = new Map();
    const jobs = [];
    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      const norm = normalizeEntryPath(relativePath);
      if (!norm || norm.kind !== 'romfs' || !isGameArchive(norm.rel)) return;
      jobs.push(
        entry.async('uint8array').then((data) => {
          found.set(norm.rel, fnv1a(new Uint8Array(data)));
        }),
      );
    });
    await Promise.all(jobs);
    perMod.push({ name: z.name, found });
  }
  const byRel = new Map();
  for (const m of perMod) {
    for (const [rel, hash] of m.found) {
      if (!byRel.has(rel)) byRel.set(rel, { mods: [], hashes: new Set() });
      byRel.get(rel).mods.push(m.name);
      byRel.get(rel).hashes.add(hash);
    }
  }
  return [...byRel.entries()]
    .filter(([, v]) => v.mods.length >= 2)
    .map(([rel, v]) => ({ rel, filename: rel.split('/').pop(), mods: v.mods, differing: v.hashes.size > 1 }))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * Analyze uploaded mods and compute everything the UI needs.
 * @param {Array<{name: string, arrayBuffer: ArrayBuffer}>} modZips
 * @param {Map<string, Uint8Array>|null} vanillaArches filename -> raw (.sarc or .sarc.zs) bytes
 */
export async function analyzeMods(modZips, vanillaArches = null) {
  const mods = [];
  for (const z of modZips) mods.push(await readModZip(z.name, z.arrayBuffer));
  checkVersionGate(mods);

  // Decompress + parse every .sarc.zs up front.
  // sarcMaps[i]: Map archiveRel -> { files: Map(inner -> data), order: [inner], verbatim: Uint8Array|null }
  const sarcMaps = mods.map(() => new Map());
  const looseMaps = mods.map(() => new Map()); // Map 'kind/rel' -> data
  const exefsPatches = []; // { mod, rel, patches }
  const errors = [];

  for (let i = 0; i < mods.length; i++) {
    for (const e of mods[i].entries) {
      try {
        if (e.kind === 'romfs' && isGameArchive(e.rel)) {
          const raw = await zstdDecompress(e.data);
          const { files } = parseSarc(raw);
          const map = new Map();
          const order = [];
          for (const f of files) {
            map.set(f.name, f.data);
            order.push(f.name);
          }
          sarcMaps[i].set(e.rel, { files: map, order, verbatim: e.data });
        } else {
          looseMaps[i].set(`${e.kind}/${e.rel}`, e.data);
          if (e.kind === 'exefs' && e.rel.toLowerCase().endsWith('.pchtxt')) {
            exefsPatches.push({ mod: mods[i].name, rel: e.rel, patches: parsePchtxt(new TextDecoder().decode(e.data)) });
          }
        }
      } catch (err) {
        errors.push(`${mods[i].name}: ${e.rel}: ${err.message}`);
      }
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));

  // Parse vanilla archives (optional): filename -> Map(inner -> data)
  const vanilla = new Map();
  if (vanillaArches) {
    for (const [filename, bytes] of vanillaArches) {
      const raw = isZstd(bytes) ? await zstdDecompress(bytes) : bytes;
      if (!isSarc(raw)) throw new Error(`Vanilla file ${filename} is not a SARC archive`);
      const { files } = parseSarc(raw);
      vanilla.set(filename, new Map(files.map((f) => [f.name, f.data])));
    }
  }

  const archives = [];
  const archiveRels = new Set(sarcMaps.flatMap((m) => [...m.keys()]));
  for (const rel of [...archiveRels].sort()) {
    const holders = [];
    for (let i = 0; i < mods.length; i++) if (sarcMaps[i].has(rel)) holders.push(i);
    const filename = rel.split('/').pop();
    const vanillaFiles = vanilla.get(filename) ?? vanilla.get(rel) ?? null;

    const innerNames = new Set();
    for (const i of holders) for (const n of sarcMaps[i].get(rel).files.keys()) innerNames.add(n);

    const identical = [];
    const unique = []; // { inner, mod }
    const differing = []; // { inner, variants: [modIdx], auto: modIdx|null }
    for (const inner of innerNames) {
      const present = holders.filter((i) => sarcMaps[i].get(rel).files.has(inner));
      if (present.length === 1) {
        unique.push({ inner, mod: present[0] });
        continue;
      }
      const first = sarcMaps[present[0]].get(rel).files.get(inner);
      const allSame = present.every((i) => bytesEqual(sarcMaps[i].get(rel).files.get(inner), first));
      if (allSame) {
        identical.push(inner);
      } else if (vanillaFiles && vanillaFiles.has(inner)) {
        const v = vanillaFiles.get(inner);
        const unchanged = present.filter((i) => bytesEqual(sarcMaps[i].get(rel).files.get(inner), v));
        const changed = present.filter((i) => !bytesEqual(sarcMaps[i].get(rel).files.get(inner), v));
        if (changed.length === 1) differing.push({ inner, variants: present, auto: changed[0] });
        else differing.push({ inner, variants: present, auto: null });
      } else {
        differing.push({ inner, variants: present, auto: null });
      }
    }
    const needsPick = differing.filter((d) => d.auto === null);
    archives.push({
      rel,
      holders,
      fileCount: innerNames.size,
      identicalCount: identical.length,
      unique,
      autoResolved: differing.filter((d) => d.auto !== null),
      groups: groupByDirectory(needsPick.map((d) => d.inner)).map(([dir, paths]) => ({
        dir,
        files: paths.map((inner) => ({ inner, variants: differing.find((d) => d.inner === inner).variants })),
      })),
    });
  }

  // Loose (non-sarc) files across mods.
  const looseRels = new Set(looseMaps.flatMap((m) => [...m.keys()]));
  const looseIdentical = [];
  const looseUnique = [];
  const looseConflicts = []; // { rel, variants, auto }
  for (const rel of [...looseRels].sort()) {
    const holders = [];
    for (let i = 0; i < mods.length; i++) if (looseMaps[i].has(rel)) holders.push(i);
    if (holders.length === 1) {
      looseUnique.push({ rel, mod: holders[0] });
      continue;
    }
    const first = looseMaps[holders[0]].get(rel);
    if (holders.every((i) => bytesEqual(looseMaps[i].get(rel), first))) looseIdentical.push(rel);
    else looseConflicts.push({ rel, variants: holders, auto: null });
  }

  // exefs .ips / other binaries that differ are hard conflicts (never auto-merged).
  // .pchtxt files merge by concatenation after overlap checking.
  const pchtxtRels = [...new Set(exefsPatches.map((p) => p.rel))].sort();
  const exefs = [];
  for (const rel of pchtxtRels) {
    const perMod = exefsPatches.filter((p) => p.rel === rel);
    const conflicts = findPchtxtConflicts(perMod);
    exefs.push({ rel, kind: 'pchtxt', mods: perMod.map((p) => p.mod), conflicts });
  }
  for (const c of looseConflicts.filter((l) => l.rel.startsWith('exefs/') && !l.rel.toLowerCase().endsWith('.pchtxt'))) {
    exefs.push({ rel: c.rel.slice('exefs/'.length), kind: 'binary', mods: c.variants.map((i) => mods[i].name), conflicts: [{ address: null }] });
  }

  return { mods: mods.map((m) => m.name), archives, looseIdentical, looseUnique, looseConflicts, exefs, _internal: { sarcMaps, looseMaps, mods } };
}

/**
 * Build the merged mod zip.
 * @param {object} analysis from analyzeMods
 * @param {object} resolutions { picks: Map<'archiveRel\ninner' | 'loose:kind/rel', modIdx> }
 * @param {(done: number, total: number, label: string) => void} onProgress
 * @returns {Promise<{ zipBytes: Uint8Array, manifest: object }>}
 */
export async function buildMerged(analysis, resolutions, onProgress = () => {}) {
  const { sarcMaps, looseMaps, mods } = analysis._internal;
  const picks = resolutions.picks ?? new Map();
  const manifest = {
    generator: 'switch2-mod-merger',
    name: mergedModName(mods.map((m) => m.name)),
    sources: mods.map((m) => m.name),
    created: new Date().toISOString(),
    archives: {},
    loose: {},
    exefs: {},
  };

  // Top-level folder carries the combined name so the emulator's importer
  // pre-fills it (e.g. ClassicGP+SecretTracks/romfs, .../exefs).
  const out = new JSZip();
  const root = out.folder(manifest.name);
  const romfs = root.folder('romfs');
  const exefs = root.folder('exefs');

  const archiveJobs = analysis.archives;
  let step = 0;
  const total = archiveJobs.length + 1;

  for (const arch of archiveJobs) {
    onProgress(step++, total, `Merging ${arch.rel.split('/').pop()}…`);
    const holders = arch.holders;
    const allSame = arch.groups.length === 0 && arch.autoResolved.length === 0 && arch.unique.length === 0;
    if (allSame) {
      // Byte-identical everywhere: copy the compressed bytes verbatim.
      const src = sarcMaps[holders[0]].get(arch.rel).verbatim;
      romfs.file(arch.rel, src, { binary: true });
      manifest.archives[arch.rel] = { action: 'copied-verbatim', from: mods[holders[0]].name };
      continue;
    }
    // Base order from the first holder; new files appended in first-seen order.
    const base = sarcMaps[holders[0]].get(arch.rel);
    const ordered = [...base.order];
    const seen = new Set(ordered);
    for (const i of holders.slice(1)) {
      for (const n of sarcMaps[i].get(arch.rel).order) {
        if (!seen.has(n)) {
          seen.add(n);
          ordered.push(n);
        }
      }
    }
    const sources = {};
    const outFiles = [];
    for (const inner of ordered) {
      const present = holders.filter((i) => sarcMaps[i].get(arch.rel).files.has(inner));
      let chosen;
      if (present.length === 1) {
        chosen = present[0];
        sources[inner] = { from: mods[chosen].name, how: 'only-in-one-mod' };
      } else {
        const first = sarcMaps[present[0]].get(arch.rel).files.get(inner);
        if (present.every((i) => bytesEqual(sarcMaps[i].get(arch.rel).files.get(inner), first))) {
          chosen = present[0];
          sources[inner] = { from: mods[chosen].name, how: 'identical' };
        } else {
          const auto = arch.autoResolved.find((d) => d.inner === inner);
          const key = `${arch.rel}\n${inner}`;
          if (auto) {
            chosen = auto.auto;
            sources[inner] = { from: mods[chosen].name, how: 'auto-vanilla' };
          } else if (picks.has(key)) {
            chosen = picks.get(key);
            sources[inner] = { from: mods[chosen].name, how: 'user-pick' };
          } else {
            throw new Error(`No resolution for ${inner} in ${arch.rel}`);
          }
        }
      }
      outFiles.push({ name: inner, data: sarcMaps[chosen].get(arch.rel).files.get(inner) });
    }
    const rebuilt = buildSarc(outFiles, { littleEndian: true });
    const compressed = await zstdCompress(rebuilt, 10);
    romfs.file(arch.rel, compressed, { binary: true });
    const counts = {};
    const detail = {};
    for (const [inner, s] of Object.entries(sources)) {
      counts[`${s.from} (${s.how})`] = (counts[`${s.from} (${s.how})`] ?? 0) + 1;
      if (s.how !== 'identical') detail[inner] = s;
    }
    manifest.archives[arch.rel] = { action: 'merged', files: outFiles.length, bySource: counts, detail };
  }

  onProgress(step, total, 'Packing remaining files…');
  // Loose files.
  const looseSeen = new Set();
  for (let i = 0; i < mods.length; i++) {
    for (const [rel, data] of looseMaps[i]) {
      if (looseSeen.has(rel)) continue;
      const [kind, ...rest] = rel.split('/');
      const restPath = rest.join('/');
      const holders = [];
      for (let j = 0; j < mods.length; j++) if (looseMaps[j].has(rel)) holders.push(j);
      const folder = kind === 'romfs' ? romfs : exefs;
      if (holders.length === 1) {
        folder.file(restPath, data, { binary: true });
        manifest.loose[rel] = { from: mods[i].name, how: 'only-in-one-mod' };
      } else if (holders.every((j) => bytesEqual(looseMaps[j].get(rel), data))) {
        folder.file(restPath, data, { binary: true });
        manifest.loose[rel] = { from: mods[i].name, how: 'identical' };
      } else if (kind === 'exefs' && restPath.toLowerCase().endsWith('.pchtxt')) {
        const named = holders.map((j) => ({ mod: mods[j].name, text: new TextDecoder().decode(looseMaps[j].get(rel)) }));
        folder.file(restPath, mergePchtxt(named));
        manifest.exefs[restPath] = { action: 'concatenated-pchtxt', from: named.map((n) => n.mod) };
      } else {
        const key = `loose:${rel}`;
        if (!picks.has(key)) throw new Error(`No resolution for ${rel}`);
        const chosen = picks.get(key);
        folder.file(restPath, looseMaps[chosen].get(rel), { binary: true });
        manifest.loose[rel] = { from: mods[chosen].name, how: 'user-pick' };
      }
      looseSeen.add(rel);
    }
  }

  root.file('switch2-mod-merger-manifest.json', JSON.stringify(manifest, null, 2));
  const zipBytes = new Uint8Array(await out.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  onProgress(total, total, 'Done');
  return { zipBytes, manifest };
}
