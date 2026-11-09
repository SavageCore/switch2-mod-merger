// Browser E2E against the production build in dist/.
// Run: npm run build && node test/e2e.mjs
// Uses the real ClassicGP + Light Optimizations zips from /tmp (never committed).
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: 'networkidle' });
const firstTheme = await page.evaluate(() => document.documentElement.dataset.theme);
if (firstTheme !== 'light' && firstTheme !== 'dark') throw new Error('no theme set: ' + firstTheme);
await page.click('#themeBtn');
const flipped = await page.evaluate(() => document.documentElement.dataset.theme);
if (flipped === firstTheme) throw new Error('theme toggle did not flip');
await page.reload({ waitUntil: 'networkidle' });
const kept = await page.evaluate(() => document.documentElement.dataset.theme);
if (kept !== flipped) throw new Error('theme did not persist across reload');
const modA = process.env.MOD_A ?? '/tmp/opencode/mkw-merge/ClassicGP.zip';
const modB = process.env.MOD_B ?? '/tmp/opencode/mkw-merge/LightOpt.zip';
await page.setInputFiles('#modFiles', [modA, modB]);
await page.locator('#modList li').first().waitFor({ timeout: 30000 });
if ((await page.locator('#modList li').count()) !== 2) throw new Error('expected 2 mods listed');
await page.locator('#nextBtn:enabled').waitFor({ timeout: 30000 });
await page.click('#nextBtn');
await page.locator('#sharedBox .card').waitFor({ timeout: 30000 });
const sharedText = await page.locator('#sharedBox').textContent();
if (!sharedText.includes('romfs/System/GymlArchive/general_format.Product_180.sarc.zs') || !sharedText.toLowerCase().includes('vanilla')) {
  throw new Error('shared archive prompt missing: ' + sharedText);
}
await page.click('#analyzeBtn');
await page.waitForSelector('#archives .card', { timeout: 60000 });
console.log('analyzed, archive cards:', await page.locator('#archives .card').count());
const exefsText = await page.locator('#exefs').textContent();
if (!exefsText.includes('only in ClassicGP')) throw new Error('single-source pchtxt mislabeled: ' + exefsText);

// Picks: cups from ClassicGP, everything else from LightOpt.
const card = page.locator('#archives .card').first();
const headers = await card.locator(':scope > h4').all();
const rows = await card.locator(':scope > .bulkrow').all();
for (let i = 0; i < headers.length; i++) {
  const dir = await headers[i].textContent();
  const want = dir.includes('GrandprixCupSetting') ? 'ClassicGP' : 'LightOpt';
  await rows[i].getByRole('button', { name: `Group from ${want}` }).click();
}
console.log('merge status:', await page.locator('#mergeStatus').textContent());

const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.click('#mergeBtn');
const download = await downloadPromise;
const outPath = '/tmp/opencode/mkw-merge/e2e-download.zip';
await download.saveAs(outPath);
console.log('downloaded', fs.statSync(outPath).size, 'bytes');
console.log('manifest shown:', await page.locator('#manifestWrap').isVisible());
const doneStatus = await page.locator('#mergeStatus').textContent();
if (!doneStatus.startsWith('Done.')) throw new Error('post-merge status wrong: ' + doneStatus);
const footer = await page.locator('#siteFooter').textContent();
if (!footer.includes('SavageCore') || !/[0-9a-f]{7}/.test(footer)) {
  throw new Error('footer missing attribution/build hash: ' + footer);
}
await page.click('#restartBtn');
await page.locator('#pageMods:not([hidden])').waitFor({ timeout: 10000 });
if ((await page.locator('#modList li').count()) !== 0) throw new Error('restart did not clear mods');

// Multi-variant zip: choice required before Next.
const perfZip = process.env.MOD_VARIANT ?? '/home/savagecore/Modding/MKW/mkw_performance_mod_v1.zip';
const helperZip = process.env.MOD_A ?? '/tmp/opencode/mkw-merge/ClassicGP.zip';
await page.setInputFiles('#modFiles', [perfZip, helperZip]);
await page.locator('#modList li').first().waitFor({ timeout: 30000 });
const variantLabels = await page.locator('#pageMods input[type="radio"]').allTextContents();
if (variantLabels.length < 2) throw new Error('variant choice missing: ' + JSON.stringify(variantLabels));
if (await page.locator('#nextBtn').isEnabled()) throw new Error('Next should wait for a variant choice');
await page.locator('#pageMods input[type="radio"]').first().check();
await page.locator('#nextBtn:enabled').waitFor({ timeout: 10000 });

await browser.close();
server.close();
if (errors.length > 0) {
  console.error('CONSOLE/PAGE ERRORS:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('E2E OK, no console errors');
