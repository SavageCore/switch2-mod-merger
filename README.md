# switch2-mod-merger

Combine Switch 2 mods that replace the same compressed archives, entirely in your browser. No uploads, no server - your files never leave your machine.

**Live app:** https://savagecore.github.io/switch2-mod-merger/ (published via GitHub Pages)

## What it does

Many Switch 2 mods ship a full copy of a game archive (`.sarc.zs`, or TOTK-style `.pack.zs`) with only a handful of inner files changed. When two mods replace the same archive, only one can win - unless you merge them.

This tool:

1. Reads two or more mod `.zip` files (standard `romfs/` + `exefs/` layout).
2. Decompresses each shared archive and diffs the inner files (11,000-file archives take ~200 ms).
3. Auto-merges everything that doesn't overlap. Files changed by only one side are taken from that side.
4. For files changed by **both** mods, you pick a winner per folder group - or drop in the vanilla (unmodded) archive to auto-resolve those too. As soon as you add your mods, the app names the exact shared file(s) (e.g. `general_format.Product_180.sarc.zs`) and tells you which vanilla copies to supply.
5. Concatenates `exefs` `.pchtxt` patches (overlapping patches to the same address are reported, not silently merged), passes `.ips` and everything else through.
6. Rebuilds the archives, recompresses them, and gives you one install-ready mod `.zip` plus a manifest of where every file came from.

It refuses to merge mods built for different game versions (detected from patch comments).

## Supported / not supported

- ✅ Any number of mods sharing `.sarc.zs` / `.pack.zs` archives
- ✅ Same-file conflicts resolved by group pick or vanilla-assisted 3-way merge
- ✅ `.pchtxt` concatenation with overlap detection, `.ips` passthrough
- ❌ Two mods editing *different settings inside the same inner file* (e.g. two GYML tweaks in one `.bgyml`) - reported as a conflict, key-level merging is future work
- ❌ Yaz0 (`.szs`) archives - Switch 2 mods use zstd; `.szs` support can be added on request

## Install a merged mod

No manual install: on the game's configuration page (right-click the game, Configure, Add-ons) use
**Import Mod from ZIP** and pick the downloaded file. The emulator installs it as one mod -
the output zip already has the expected layout, with a top-level folder named after the sources
(e.g. `ClassicGP+SecretTracks/romfs`, `.../exefs`), so the mod name field is pre-filled.
Afterwards, disable the source mods so they don't shadow the merged copy.

## Development

```sh
pnpm install
pnpm test        # unit tests (synthetic fixtures only, no game files)
pnpm dev         # local dev server
pnpm build       # production build to dist/
```

`test/e2e.mjs` drives the production build in headless Chromium against **real** mod zips. It needs two mod zips on disk and is intentionally not part of CI (game files must never enter this repo):

```sh
pnpm build
MOD_A=/path/to/modA.zip MOD_B=/path/to/modB.zip node test/e2e.mjs
```

E2E paths are currently hardcoded to the author's local fixtures - pass paths or edit the script.

## How the SARC codec was validated

`src/sarc.js` is a clean-room SARC reader/writer. Against a real 11,102-file game archive it round-trips losslessly (verified with an independent parser), preserves node hash order, 0x100 data alignment, and the word-addressed filename table. Filename hashing (`h = h * 0x65 + c`) and node sort order were confirmed against known entries.

## License

MIT. The SARC implementation is original code written for this project from observed file layouts.
