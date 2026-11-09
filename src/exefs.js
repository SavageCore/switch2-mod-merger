/**
 * exefs patch handling.
 *
 * - `.pchtxt` files are text: parse `@enabled` blocks of `<address> <hexbytes>`
 *   lines so overlapping patches to the same NSO build ID can be detected.
 *   Merging concatenates the blocks with a source header per mod.
 * - `.ips` files are binary blobs we do not rewrite: byte-identical copies
 *   merge cleanly, anything else is a conflict for the user to resolve.
 */

const HEX_LINE = /^([0-9A-Fa-f]{4,16})\s+([0-9A-Fa-f\s]+)$/;

export function parsePchtxt(text) {
  const patches = [];
  const lines = text.split(/\r?\n/);
  let enabled = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '@enabled') {
      enabled = true;
      continue;
    }
    if (line.startsWith('@') || line.startsWith('//') || line === '') {
      if (line.startsWith('@') && line !== '@enabled') enabled = false;
      continue;
    }
    if (!enabled) continue;
    const m = line.match(HEX_LINE);
    if (!m) continue;
    const address = parseInt(m[1], 16);
    const bytes = m[2].replace(/\s+/g, '');
    if (bytes.length % 2 !== 0) continue;
    patches.push({
      address,
      size: bytes.length / 2,
      hex: bytes.toUpperCase(),
      line,
    });
  }
  return patches;
}

export function findPchtxtConflicts(patchesByMod) {
  // patchesByMod: [{ mod, patches }] -> [{ address, size, entries: [{mod, hex}] }]
  const byAddress = new Map();
  for (const { mod, patches } of patchesByMod) {
    for (const p of patches) {
      const key = `${p.address}:${p.size}`;
      if (!byAddress.has(key)) byAddress.set(key, []);
      byAddress.get(key).push({ mod, hex: p.hex, line: p.line });
    }
  }
  const conflicts = [];
  for (const [key, entries] of byAddress) {
    const hexes = new Set(entries.map((e) => e.hex));
    if (hexes.size > 1) {
      const [address, size] = key.split(':').map(Number);
      conflicts.push({ address, size, entries });
    }
  }
  return conflicts;
}

export function mergePchtxt(namedSources) {
  // namedSources: [{ mod, text }] -> merged text with per-mod headers.
  const out = [
    '// Merged by switch2-mod-merger (https://github.com/SavageCore/switch2-mod-merger)',
    '// Sources concatenated below; overlapping patches were checked before merging.',
    '',
  ];
  for (const { mod, text } of namedSources) {
    out.push(`// ---- from ${mod} ----`);
    out.push(text.replace(/\s+$/, ''));
    out.push('');
  }
  return out.join('\n');
}

export function gameVersionHints(text) {
  // e.g. "Some Game v1.8.0 (Build 917504)" in a mod's pchtxt comment header
  const versions = new Set();
  for (const m of text.matchAll(/v(\d+\.\d+\.\d+)/g)) versions.add(m[1]);
  for (const m of text.matchAll(/build\s+(\d+)/gi))
    versions.add(`build ${m[1]}`);
  return [...versions];
}
