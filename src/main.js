import { analyzeMods, buildMerged } from './merge.js';

const state = {
  mods: [], // { name, arrayBuffer }
  vanilla: new Map(), // filename -> Uint8Array
  analysis: null,
  picks: new Map(), // resolution key -> modIdx
  outputUrl: null,
};

const $ = (id) => document.getElementById(id);

function shortName(filename) {
  return filename.replace(/\.zip$/i, '');
}

function refreshModList() {
  const ul = $('modList');
  ul.innerHTML = '';
  state.mods.forEach((m, i) => {
    const li = document.createElement('li');
    const size = (m.arrayBuffer.byteLength / 1048576).toFixed(1);
    li.innerHTML = `<span><strong>${escapeHtml(m.name)}</strong> <span class="filetoggle">${size} MB</span></span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'secondary';
    btn.onclick = () => {
      state.mods.splice(i, 1);
      resetResults();
      refreshModList();
    };
    li.appendChild(btn);
    ul.appendChild(li);
  });
  $('analyzeBtn').disabled = state.mods.length < 2;
}

function refreshVanillaList() {
  const ul = $('vanillaList');
  ul.innerHTML = '';
  for (const [name, bytes] of state.vanilla) {
    const li = document.createElement('li');
    const size = (bytes.length / 1048576).toFixed(1);
    li.innerHTML = `<span><strong>${escapeHtml(name)}</strong> <span class="filetoggle">${size} MB</span></span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.className = 'secondary';
    btn.onclick = () => {
      state.vanilla.delete(name);
      resetResults();
      refreshVanillaList();
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resetResults() {
  state.analysis = null;
  state.picks = new Map();
  $('results').hidden = true;
  $('errors').hidden = true;
  $('downloadWrap').hidden = true;
  $('manifestWrap').hidden = true;
  if (state.outputUrl) {
    URL.revokeObjectURL(state.outputUrl);
    state.outputUrl = null;
  }
}

async function addModFiles(fileList) {
  for (const f of fileList) {
    if (!/\.zip$/i.test(f.name)) continue;
    state.mods.push({ name: shortName(f.name), arrayBuffer: await f.arrayBuffer() });
  }
  resetResults();
  refreshModList();
}

async function addVanillaFiles(fileList) {
  for (const f of fileList) {
    state.vanilla.set(f.name, new Uint8Array(await f.arrayBuffer()));
  }
  resetResults();
  refreshVanillaList();
}

function pickKey(archRel, inner) {
  return `${archRel}\n${inner}`;
}

function renderAnalysis(analysis) {
  const modNames = analysis.mods;
  const totalDiffs = analysis.archives.reduce((n, a) => n + a.groups.reduce((m, g) => m + g.files.length, 0), 0);
  const totalAuto = analysis.archives.reduce((n, a) => n + a.autoResolved.length, 0);

  $('summary').innerHTML =
    `<div class="card"><h3>Merged from: ${modNames.map(escapeHtml).join(' + ')}</h3>` +
    `<span class="pill good">${analysis.archives.length} shared archive(s)</span>` +
    `<span class="pill ${totalDiffs ? 'warn' : 'good'}">${totalDiffs} file(s) need a pick</span>` +
    (totalAuto ? `<span class="pill good">${totalAuto} auto-resolved from vanilla</span>` : '') +
    (analysis.looseConflicts.length ? `<span class="pill warn">${analysis.looseConflicts.length} loose file conflict(s)</span>` : '') +
    `</div>`;

  // Global bulk bar.
  const bulk = $('bulkBar');
  bulk.innerHTML = '';
  if (totalDiffs > 0) {
    const row = document.createElement('div');
    row.className = 'bulkrow';
    row.innerHTML = '<span>Undecided files default to nothing - bulk-pick:</span>';
    modNames.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'secondary';
      b.textContent = `All from ${name}`;
      b.onclick = () => {
        for (const a of analysis.archives) {
          for (const g of a.groups) for (const f of g.files) state.picks.set(pickKey(a.rel, f.inner), i);
        }
        for (const c of analysis.looseConflicts) state.picks.set(`loose:${c.rel}`, i);
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
    if (arch.groups.length === 0 && analysis.looseConflicts.length === 0) html += ' <span class="pill good">merges cleanly</span>';
    else if (arch.groups.length > 0) html += ' <span class="pill warn">needs picks</span>';
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
        b.className = 'secondary';
        b.textContent = `Group from ${modNames[i]}`;
        b.onclick = () => {
          for (const f of group.files) state.picks.set(pickKey(arch.rel, f.inner), i);
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
    card.innerHTML = '<h3>Other conflicting files <span class="pill warn">needs picks</span></h3>';
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
      if (e.kind === 'pchtxt' && e.conflicts.length === 0) {
        p.innerHTML = `<code>${escapeHtml(e.rel)}</code> <span class="pill good">concatenated (${e.mods.map(escapeHtml).join(' + ')})</span>`;
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
  for (const a of analysis.archives) for (const g of a.groups) for (const f of g.files) {
    if (!state.picks.has(pickKey(a.rel, f.inner))) n++;
  }
  for (const c of analysis.looseConflicts) if (!state.picks.has(`loose:${c.rel}`)) n++;
  return n;
}

function updateMergeReadiness(analysis) {
  const n = undecidedCount(analysis);
  const blocking = document.querySelector('#exefs .card')?.dataset.blocking === '1';
  $('mergeBtn').disabled = n > 0 || blocking;
  $('mergeStatus').textContent =
    blocking ? 'Resolve the exefs conflict above (or drop one of the mods).' : n > 0 ? `${n} file(s) still undecided.` : 'Ready to merge.';
}

async function onAnalyze() {
  resetResults();
  $('analyzeBtn').disabled = true;
  $('analyzeStatus').textContent = 'Analyzing…';
  try {
    const modZips = state.mods.map((m) => ({ name: m.name, arrayBuffer: m.arrayBuffer.slice(0) }));
    state.analysis = await analyzeMods(modZips, state.vanilla.size > 0 ? state.vanilla : null);
    $('results').hidden = false;
    renderAnalysis(state.analysis);
    $('analyzeStatus').textContent = '';
  } catch (err) {
    $('errors').hidden = false;
    $('errorPre').textContent = err.message;
  } finally {
    $('analyzeBtn').disabled = state.mods.length < 2;
  }
}

async function onMerge() {
  $('mergeBtn').disabled = true;
  $('mergeProgress').hidden = false;
  $('mergeStatus').textContent = '';
  try {
    const { zipBytes, manifest } = await buildMerged(state.analysis, { picks: state.picks }, (done, total, label) => {
      $('mergeBar').style.width = `${(done / total) * 100}%`;
      $('mergeStatus').textContent = label;
    });
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    state.outputUrl = URL.createObjectURL(blob);
    const link = $('downloadLink');
    link.href = state.outputUrl;
    link.download = `${state.analysis.mods.join('+')}-merged.zip`;
    $('downloadWrap').hidden = false;
    link.click();
    const summary = { ...manifest };
    for (const a of Object.values(summary.archives)) delete a.detail;
    $('manifestPre').textContent = JSON.stringify(summary, null, 2);
    $('manifestWrap').hidden = false;
    $('mergeStatus').textContent = 'Done. Extract the zip into a new folder under your emulator\'s load/<title-id>/ folder.';
  } catch (err) {
    $('errors').hidden = false;
    $('errorPre').textContent = err.message;
  } finally {
    $('mergeProgress').hidden = true;
    updateMergeReadiness(state.analysis);
  }
}

function init() {
  const dz = $('dropzone');
  const input = $('modFiles');
  dz.addEventListener('click', (e) => {
    if (e.target === input) return;
  });
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer.files.length > 0) addModFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    addModFiles(picked);
  });
  const vanillaInput = $('vanillaFiles');
  vanillaInput.addEventListener('change', () => {
    const picked = [...vanillaInput.files];
    vanillaInput.value = '';
    addVanillaFiles(picked);
  });
  $('analyzeBtn').addEventListener('click', onAnalyze);
  $('mergeBtn').addEventListener('click', onMerge);
  refreshModList();
  refreshVanillaList();
}

init();
