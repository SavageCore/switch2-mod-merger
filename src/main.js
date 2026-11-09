import {
  analyzeMods,
  buildMerged,
  detectVariants,
  mergedModName,
  scanSharedArchives,
} from './merge.js';
import {
  deleteVanillaFile,
  loadVanillaStore,
  saveVanillaFile,
} from './vanilla-store.js';

const state = {
  mods: [], // { name, arrayBuffer }
  vanilla: new Map(), // filename -> Uint8Array
  remembered: new Set(), // vanilla filenames restored from storage
  shared: null, // scanSharedArchives() result
  analysis: null,
  picks: new Map(), // resolution key -> modIdx
};

const $ = (id) => document.getElementById(id);

const PAGES = ['pageMods', 'pageShared', 'pageResults'];

function showPage(id) {
  for (const p of PAGES) $(p).hidden = p !== id;
  window.scrollTo(0, 0);
}

function shortName(filename) {
  return filename.replace(/\.zip$/i, '');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function refreshModList() {
  const ul = $('modList');
  ul.innerHTML = '';
  state.mods.forEach((m, i) => {
    const li = document.createElement('li');
    const size = formatSize(m.arrayBuffer.byteLength);
    const label =
      m.variants.length >= 2 && m.variant ? `${m.name} (${m.variant})` : m.name;
    const text = document.createElement('span');
    text.title = label;
    text.innerHTML = `<strong>${escapeHtml(label)}</strong> <span class="filetoggle">${size}</span>`;
    li.appendChild(text);
    li.appendChild(
      trashButton(`Remove ${m.name}`, () => {
        state.mods.splice(i, 1);
        resetResults();
        refreshModList();
        refreshSharedBox();
      }),
    );
    ul.appendChild(li);
    if (m.variants.length >= 2) {
      const wrap = document.createElement('div');
      wrap.className = 'pick';
      const title = document.createElement('span');
      title.innerHTML = `Which version of <strong>${escapeHtml(m.name)}</strong>? `;
      wrap.appendChild(title);
      m.variants.forEach((v) => {
        const radio = document.createElement('label');
        radio.className = 'pick';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `variant-${i}`;
        input.checked = m.variant === v;
        input.onchange = () => {
          m.variant = v;
          resetResults();
          refreshModList();
          refreshSharedBox();
        };
        radio.appendChild(input);
        radio.appendChild(document.createTextNode(v));
        wrap.appendChild(radio);
      });
      if (!m.variant) {
        const warn = document.createElement('span');
        warn.className = 'pill warn';
        warn.textContent = 'choose one';
        wrap.appendChild(warn);
      }
      ul.appendChild(wrap);
    }
  });
  const needChoice = state.mods.filter(
    (m) => m.variants.length >= 2 && !m.variant,
  );
  $('nextBtn').disabled = state.mods.length < 2 || needChoice.length > 0;
  $('modsHint').textContent =
    needChoice.length > 0
      ? `Choose a version for: ${needChoice.map((m) => m.name).join(', ')}`
      : '';
}

function refreshVanillaList() {
  const ul = $('vanillaList');
  ul.innerHTML = '';
  for (const [name, bytes] of state.vanilla) {
    const li = document.createElement('li');
    const size = formatSize(bytes.length);
    const text = document.createElement('span');
    text.title = name;
    text.innerHTML = `<strong>${escapeHtml(name)}</strong> <span class="filetoggle">${size}</span>`;
    if (state.remembered.has(name)) {
      const tag = document.createElement('span');
      tag.className = 'filetoggle';
      tag.textContent = 'remembered';
      text.appendChild(document.createTextNode(' '));
      text.appendChild(tag);
    }
    li.appendChild(text);
    li.appendChild(
      trashButton(`Remove ${name}`, () => {
        state.vanilla.delete(name);
        state.remembered.delete(name);
        deleteVanillaFile(name);
        resetResults();
        refreshVanillaList();
        refreshSharedBox();
      }),
    );
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const TRASH_PATHS =
  '<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />' +
  '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />' +
  '<line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />';

function trashButton(label, onclick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'iconbtn sm';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><title>${escapeHtml(label)}</title>${TRASH_PATHS}</svg>`;
  btn.onclick = onclick;
  return btn;
}

/** Match an uploaded vanilla file to a shared archive filename. */
function vanillaFor(filename) {
  const bare = filename.replace(/\.zs$/i, '');
  for (const key of state.vanilla.keys()) {
    if (key === filename || key === bare) return key;
  }
  return null;
}

let sharedRun = 0;

async function refreshSharedBox() {
  const run = ++sharedRun;
  const box = $('sharedBox');
  const status = $('vanillaStatus');
  box.innerHTML = '';
  status.textContent = '';
  if (state.mods.length < 2) {
    state.shared = null;
    return;
  }
  try {
    state.shared = await scanSharedArchives(
      state.mods.map((m) => ({
        name: m.name,
        arrayBuffer: m.arrayBuffer,
        variant: m.variant ?? null,
      })),
    );
  } catch (err) {
    if (run !== sharedRun) return;
    box.innerHTML = `<div class="card"><p class="filetoggle">Could not scan mod zips (${escapeHtml(err.message)}). Analyze will report problems.</p></div>`;
    state.shared = null;
    return;
  }
  if (run !== sharedRun) return;
  if (state.shared.length === 0) {
    box.innerHTML =
      '<div class="card"><p class="filetoggle">No archive is replaced by more than one mod - these mods don\'t conflict, install them side by side instead of merging.</p></div>';
    return;
  }
  const card = document.createElement('div');
  card.className = 'card';
  const needVanilla = state.shared.filter(
    (s) => s.differing && !vanillaFor(s.filename),
  );
  const ready = state.shared.filter(
    (s) => s.differing && vanillaFor(s.filename),
  );
  status.textContent =
    needVanilla.length > 0
      ? `- ${needVanilla.length} shared ${needVanilla.length > 1 ? 'files need' : 'file needs'} vanilla`
      : '';
  let html = '<h3>Shared archives</h3>';
  if (needVanilla.length > 0) {
    html += `<p>Add the vanilla copy of each file below (from your game dump, same filename).</p>`;
  } else if (ready.length > 0) {
    html += '<p>Vanilla files present - shared files merge automatically.</p>';
  }
  card.innerHTML = html;
  for (const s of state.shared) {
    const p = document.createElement('p');
    if (!s.differing) {
      p.innerHTML =
        `<code>${escapeHtml(s.filename)}</code> <span class="pill good">identical in ${s.mods.length} mods</span>` +
        `<br><span class="filetoggle">${s.mods.map(escapeHtml).join(', ')}</span>`;
    } else {
      const v = vanillaFor(s.filename);
      p.innerHTML =
        `<code>romfs/${escapeHtml(s.rel)}</code> ` +
        (v
          ? `<span class="pill good">vanilla added (${escapeHtml(v)})</span>`
          : '') +
        `<br><span class="filetoggle">replaced by ${s.mods.map(escapeHtml).join(', ')}</span>`;
    }
    card.appendChild(p);
  }
  box.appendChild(card);
}

function resetResults() {
  state.analysis = null;
  state.picks = new Map();
  $('pageResults').hidden = true;
  $('errors').hidden = true;
  $('restartWrap').hidden = true;
  $('manifestWrap').hidden = true;
}

function resetAll() {
  state.mods = [];
  state.vanilla = new Map();
  state.shared = null;
  resetResults();
  refreshModList();
  refreshVanillaList();
  refreshSharedBox();
  showPage('pageMods');
}

async function addModFiles(fileList) {
  for (const f of fileList) {
    if (!/\.zip$/i.test(f.name)) continue;
    const arrayBuffer = await f.arrayBuffer();
    let variants = [];
    try {
      variants = await detectVariants(arrayBuffer);
    } catch {
      variants = [];
    }
    state.mods.push({
      name: shortName(f.name),
      arrayBuffer,
      variants,
      variant: null,
    });
  }
  resetResults();
  refreshModList();
  refreshSharedBox();
}

async function addVanillaFiles(fileList) {
  for (const f of fileList) {
    if (!/\.(sarc|zs)$/i.test(f.name)) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    state.vanilla.set(f.name, bytes);
    state.remembered.delete(f.name);
    await saveVanillaFile(f.name, bytes);
  }
  resetResults();
  refreshVanillaList();
  refreshSharedBox();
}

function pickKey(archRel, inner) {
  return `${archRel}\n${inner}`;
}

function renderAnalysis(analysis) {
  const modNames = analysis.mods;
  const totalDiffs = analysis.archives.reduce(
    (n, a) => n + a.groups.reduce((m, g) => m + g.files.length, 0),
    0,
  );
  const totalAuto = analysis.archives.reduce(
    (n, a) => n + a.autoResolved.length,
    0,
  );

  const warnBox = $('warnBox');
  if (analysis.vanillaFailed.length > 0) {
    warnBox.hidden = false;
    warnBox.innerHTML =
      '<strong>These vanilla files could not be used and were removed - add them again if you want auto-merge:</strong><ul class="compact">' +
      analysis.vanillaFailed
        .map(
          (f) =>
            `<li><code>${escapeHtml(f.filename)}</code> <span class="filetoggle">${escapeHtml(f.reason)}</span></li>`,
        )
        .join('') +
      '</ul>';
  } else {
    warnBox.hidden = true;
    warnBox.innerHTML = '';
  }
  $('summary').innerHTML =
    `<div class="card"><h3>Merged from: ${modNames.map(escapeHtml).join(' + ')}</h3>` +
    `<span class="pill good">${plural(analysis.archives.length, 'shared archive')}</span>` +
    `<span class="pill ${totalDiffs ? 'warn' : 'good'}">${plural(totalDiffs, 'file needs', 'files need')} a pick</span>` +
    (totalAuto
      ? `<span class="pill good">${totalAuto} auto-resolved from vanilla</span>`
      : '') +
    (analysis.looseConflicts.length
      ? `<span class="pill warn">${plural(analysis.looseConflicts.length, 'loose file conflict')}</span>`
      : '') +
    `</div>`;

  // Global bulk bar.
  const bulk = $('bulkBar');
  bulk.innerHTML = '';
  if (totalDiffs > 0) {
    const row = document.createElement('div');
    row.className = 'bulkrow';
    row.innerHTML =
      '<span>Undecided files default to nothing - bulk-pick:</span>';
    modNames.forEach((name, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.textContent = `All from ${name}`;
      b.onclick = () => {
        for (const a of analysis.archives) {
          for (const g of a.groups)
            for (const f of g.files)
              state.picks.set(pickKey(a.rel, f.inner), i);
        }
        for (const c of analysis.looseConflicts)
          state.picks.set(`loose:${c.rel}`, i);
        renderAnalysis(analysis);
      };
      row.appendChild(b);
    });
    bulk.appendChild(row);
  }

  // Archives.
  const archDiv = $('archives');
  archDiv.innerHTML = '';
  analysis.archives.forEach((arch) => {
    const card = document.createElement('div');
    card.className = 'card';
    const short = arch.rel.split('/').pop();
    let html = `<h3><code>${escapeHtml(short)}</code>`;
    if (arch.groups.length === 0 && analysis.looseConflicts.length === 0)
      html += ' <span class="pill good">merges cleanly</span>';
    else if (arch.groups.length > 0)
      html += ' <span class="pill warn">needs picks</span>';
    html += `</h3><p class="filetoggle">${arch.fileCount} files, ${arch.identicalCount} identical, ${arch.unique.length} only in one mod, ${arch.autoResolved.length} auto-resolved</p>`;
    card.innerHTML = html;

    arch.groups.forEach((group) => {
      const h4 = document.createElement('h4');
      h4.textContent = group.dir;
      card.appendChild(h4);
      const bulkRow = document.createElement('div');
      bulkRow.className = 'bulkrow';
      const involved = [...new Set(group.files.flatMap((f) => f.variants))];
      involved.forEach((i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'secondary';
        b.textContent = `Group from ${modNames[i]}`;
        b.onclick = () => {
          for (const f of group.files)
            state.picks.set(pickKey(arch.rel, f.inner), i);
          renderAnalysis(analysis);
        };
        bulkRow.appendChild(b);
      });
      card.appendChild(bulkRow);

      const list = document.createElement('div');
      group.files.forEach((f) => {
        const key = pickKey(arch.rel, f.inner);
        const wrap = document.createElement('div');
        wrap.className = 'pick';
        const label = document.createElement('span');
        label.innerHTML = `<code>${escapeHtml(f.inner.split('/').pop())}</code> `;
        wrap.appendChild(label);
        f.variants.forEach((i) => {
          const radio = document.createElement('label');
          radio.className = 'pick';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = `pick-${arch.rel}-${f.inner}`;
          input.checked = state.picks.get(key) === i;
          input.onchange = () => {
            state.picks.set(key, i);
            updateMergeReadiness(analysis);
          };
          radio.appendChild(input);
          radio.appendChild(document.createTextNode(modNames[i]));
          wrap.appendChild(radio);
        });
        if (!state.picks.has(key)) {
          const warn = document.createElement('span');
          warn.className = 'pill warn';
          warn.textContent = 'undecided';
          wrap.appendChild(warn);
        }
        list.appendChild(wrap);
      });
      card.appendChild(list);
    });

    if (arch.autoResolved.length > 0) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = `${arch.autoResolved.length} auto-resolved from vanilla`;
      det.appendChild(sum);
      const ul = document.createElement('ul');
      ul.className = 'compact';
      arch.autoResolved.forEach((d) => {
        const li = document.createElement('li');
        li.innerHTML = `<code>${escapeHtml(d.inner)}</code> &larr; ${escapeHtml(modNames[d.auto])}`;
        ul.appendChild(li);
      });
      det.appendChild(ul);
      card.appendChild(det);
    }
    archDiv.appendChild(card);
  });

  // Loose conflicts.
  const looseDiv = $('loose');
  looseDiv.innerHTML = '';
  if (analysis.looseConflicts.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h3>Other conflicting files <span class="pill warn">needs picks</span></h3>';
    analysis.looseConflicts.forEach((c) => {
      const key = `loose:${c.rel}`;
      const wrap = document.createElement('div');
      wrap.className = 'pick';
      wrap.innerHTML = `<code>${escapeHtml(c.rel)}</code> `;
      c.variants.forEach((i) => {
        const radio = document.createElement('label');
        radio.className = 'pick';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `pick-loose-${c.rel}`;
        input.checked = state.picks.get(key) === i;
        input.onchange = () => {
          state.picks.set(key, i);
          updateMergeReadiness(analysis);
        };
        radio.appendChild(input);
        radio.appendChild(document.createTextNode(modNames[i]));
        wrap.appendChild(radio);
      });
      card.appendChild(wrap);
    });
    looseDiv.appendChild(card);
  }

  // exefs.
  const exDiv = $('exefs');
  exDiv.innerHTML = '';
  if (analysis.exefs.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<h3>Code patches (exefs)</h3>';
    let blocking = false;
    analysis.exefs.forEach((e) => {
      const p = document.createElement('p');
      if (
        (e.kind === 'pchtxt' || e.kind === 'ips') &&
        e.conflicts.length === 0
      ) {
        const verb = e.kind === 'pchtxt' ? 'concatenated' : 'merged';
        p.innerHTML =
          e.mods.length > 1
            ? `<code>${escapeHtml(e.rel)}</code> <span class="pill good">${verb} (${e.mods.map(escapeHtml).join(' + ')})</span>`
            : `<code>${escapeHtml(e.rel)}</code> <span class="pill good">only in ${escapeHtml(e.mods[0])}</span>`;
      } else if (e.conflicts.length > 0) {
        blocking = true;
        p.innerHTML = `<code>${escapeHtml(e.rel)}</code> <span class="pill bad">overlapping patches - cannot merge</span>`;
        const ul = document.createElement('ul');
        ul.className = 'compact';
        e.conflicts.forEach((c) => {
          const li = document.createElement('li');
          li.textContent =
            c.address === null
              ? 'binary patch differs between mods'
              : `0x${c.address.toString(16).toUpperCase()}: ${c.entries.map((x) => `${x.mod}=${x.hex}`).join(' vs ')}`;
          ul.appendChild(li);
        });
        p.appendChild(ul);
      }
      card.appendChild(p);
    });
    card.dataset.blocking = blocking ? '1' : '';
    exDiv.appendChild(card);
  }

  updateMergeReadiness(analysis);
}

function undecidedCount(analysis) {
  let n = 0;
  for (const a of analysis.archives)
    for (const g of a.groups)
      for (const f of g.files) {
        if (!state.picks.has(pickKey(a.rel, f.inner))) n++;
      }
  for (const c of analysis.looseConflicts)
    if (!state.picks.has(`loose:${c.rel}`)) n++;
  return n;
}

function updateMergeReadiness(analysis) {
  const n = undecidedCount(analysis);
  const blocking =
    document.querySelector('#exefs .card')?.dataset.blocking === '1';
  const btn = $('mergeBtn');
  btn.disabled = n > 0 || blocking;
  const reason = blocking
    ? 'Resolve the exefs conflict above (or drop one of the mods).'
    : n > 0
      ? `${plural(n, 'file')} still undecided.`
      : '';
  $('mergeStatus').textContent = reason;
  btn.title = reason;
}

async function onAnalyze() {
  resetResults();
  $('analyzeBtn').disabled = true;
  $('analyzeStatus').textContent = 'Analyzing…';
  try {
    const modZips = state.mods.map((m) => ({
      name: m.name,
      arrayBuffer: m.arrayBuffer.slice(0),
      variant: m.variant ?? null,
    }));
    state.analysis = await analyzeMods(
      modZips,
      state.vanilla.size > 0 ? state.vanilla : null,
    );
    if (state.analysis.vanillaFailed.length > 0) {
      for (const f of state.analysis.vanillaFailed) {
        state.vanilla.delete(f.filename);
        state.remembered.delete(f.filename);
        await deleteVanillaFile(f.filename);
      }
      refreshVanillaList();
      await refreshSharedBox();
    }
    renderAnalysis(state.analysis);
    $('analyzeStatus').textContent = '';
    showPage('pageResults');
  } catch (err) {
    $('errors').hidden = false;
    $('errorPre').textContent = err.message;
    $('errors').scrollIntoView();
  } finally {
    $('analyzeBtn').disabled = false;
  }
}

async function onMerge() {
  $('mergeBtn').disabled = true;
  $('mergeProgress').hidden = false;
  $('mergeStatus').textContent = '';
  try {
    const { zipBytes, manifest } = await buildMerged(
      state.analysis,
      { picks: state.picks },
      (done, total, label) => {
        $('mergeBar').style.width = `${(done / total) * 100}%`;
        $('mergeStatus').textContent = label;
      },
    );
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mergedModName(state.analysis.mods)}-merged.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('restartWrap').hidden = false;
    const summary = { ...manifest };
    for (const a of Object.values(summary.archives)) delete a.detail;
    $('manifestPre').textContent = JSON.stringify(summary, null, 2);
    $('manifestWrap').hidden = false;
    $('mergeStatus').textContent =
      'Done. Import the zip with Import Mod from ZIP (right-click the game, Configure, Add-ons).';
    $('mergeBtn').disabled = false;
  } catch (err) {
    $('errors').hidden = false;
    $('errorPre').textContent = err.message;
    $('errors').scrollIntoView();
    updateMergeReadiness(state.analysis);
  } finally {
    $('mergeProgress').hidden = true;
  }
}

function wireDrop(zone, inputEl, onFiles) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputEl.click();
    }
  });
}

async function init() {
  try {
    const stored = await loadVanillaStore();
    for (const [name, bytes] of stored) {
      state.vanilla.set(name, bytes);
      state.remembered.add(name);
    }
  } catch {
    // Start without remembered files.
  }
  $('themeBtn').addEventListener('click', () => {
    const next =
      document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('s2mm-theme', next);
    } catch {}
  });
  const short =
    typeof __COMMIT_SHORT__ !== 'undefined' ? __COMMIT_SHORT__ : 'dev';
  const full = typeof __COMMIT_FULL__ !== 'undefined' ? __COMMIT_FULL__ : '';
  const hashEl = $('buildHash');
  if (full && full !== 'unknown') {
    const a = document.createElement('a');
    a.href = `https://github.com/SavageCore/switch2-mod-merger/commit/${full}`;
    a.textContent = short;
    hashEl.replaceChildren(a);
  } else {
    hashEl.textContent = short;
  }
  const input = $('modFiles');
  wireDrop($('dropzone'), input, (files) => addModFiles(files));
  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    addModFiles(picked);
  });
  const vanillaInput = $('vanillaFiles');
  wireDrop($('vanillaDropzone'), vanillaInput, (files) =>
    addVanillaFiles(files),
  );
  vanillaInput.addEventListener('change', () => {
    const picked = [...vanillaInput.files];
    vanillaInput.value = '';
    addVanillaFiles(picked);
  });
  $('analyzeBtn').addEventListener('click', onAnalyze);
  $('mergeBtn').addEventListener('click', onMerge);
  $('restartBtn').addEventListener('click', resetAll);
  $('nextBtn').addEventListener('click', () => {
    showPage('pageShared');
    refreshSharedBox();
  });
  $('backToModsBtn').addEventListener('click', () => showPage('pageMods'));
  $('backToSharedBtn').addEventListener('click', () => showPage('pageShared'));
  refreshModList();
  refreshVanillaList();
  showPage('pageMods');
}

init();
