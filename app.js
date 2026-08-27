/* Workout Player — reads plans from the private exercise repo, writes raw
   feedback back. App code is public; all data stays in the private repo. */
const OWNER = 'balintdom', REPO = 'exercise', BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const $ = (id) => document.getElementById(id);
const views = ['setup', 'pick', 'player', 'finish'];
function show(v) { views.forEach(x => $('view-' + x).hidden = (x !== v)); window.scrollTo(0, 0); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
// YAML | blocks carry hard 78-col wraps; unwrap them, keep paragraph breaks
function fmtText(s) {
  return String(s).trim().split(/\n\s*\n/)
    .map(p => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('');
}

let token = localStorage.getItem('gh_token') || '';
let state = null;
let timerInt = null;

/* ---------- GitHub API ---------- */
async function gh(path, opts = {}, raw = false) {
  const res = await fetch(path ? `${API}/${path}` : API, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 140)}`);
  return raw ? res.text() : res.json();
}
const getRaw = (p) => gh(`contents/${p}?ref=${BRANCH}`, {}, true);

async function putFile(path, text, message) {
  const existing = await gh(`contents/${path}?ref=${BRANCH}`);
  const body = {
    message, branch: BRANCH,
    content: btoa(unescape(encodeURIComponent(text))),
    ...(existing && existing.sha ? { sha: existing.sha } : {}),
  };
  return gh(`contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
}

/* ---------- setup ---------- */
$('token-save').onclick = async () => {
  token = $('token-input').value.trim();
  $('setup-error').textContent = '';
  try {
    if (!token) throw new Error('empty token');
    await gh('');
    localStorage.setItem('gh_token', token);
    loadPick();
  } catch (e) { $('setup-error').textContent = 'Token check failed: ' + e.message; }
};
$('token-reset').onclick = () => { localStorage.removeItem('gh_token'); token = ''; show('setup'); };
$('pick-refresh').onclick = () => loadPick();

/* ---------- workout list ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function loadPick() {
  show('pick');
  $('pick-list').innerHTML = '<p>Loading…</p>';
  try {
    const items = (await gh(`contents/workouts?ref=${BRANCH}`)) || [];
    const today = todayStr();
    const rows = items
      .filter(i => i.name.endsWith('.yaml'))
      .map(i => ({ file: i.name, date: i.name.slice(0, 10), place: i.name.slice(11).replace('.yaml', '') }))
      .sort((a, b) => b.date.localeCompare(a.date));
    $('pick-list').innerHTML = '';
    for (const r of rows.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = 'pick-item';
      const tag = r.date === today ? ' <span class="today-tag">today</span>'
        : (r.date < today ? ' <span class="past">past</span>' : '');
      b.innerHTML = `<span class="when">${esc(r.date)}${tag}</span><span>${esc(r.place)}</span>`;
      b.onclick = () => openWorkout(r.file);
      $('pick-list').appendChild(b);
    }
    if (!rows.length) $('pick-list').innerHTML = '<p>No workouts found.</p>';
  } catch (e) {
    $('pick-list').innerHTML = `<p class="error">${e.message}</p>`;
    if (/401|403/.test(e.message)) show('setup');
  }
}

/* ---------- units, timers, set counts ---------- */
function parseMaxSeconds(v) {
  if (v == null) return 0;
  const s = String(v);
  const mul = /min/.test(s) ? 60 : 1;
  const nums = (s.match(/\d+/g) || []).map(Number);
  return nums.length ? nums[nums.length - 1] * mul : 0;
}
function exMeta(entry) {
  const p = entry.planned || {};
  const isDuration = p.duration != null && p.sets == null;
  const twoSides = isDuration && /side|each/.test(String(p.duration));
  const nSets = parseInt(p.sets, 10) || (twoSides ? 2 : 1);
  const hold = /hold/.test(String(p.reps || ''));
  return {
    p, isDuration, nSets,
    setWord: twoSides ? 'Side' : 'Set',
    unit: (isDuration || hold) ? 'seconds' : 'reps',
    workSecs: isDuration ? parseMaxSeconds(p.duration) : (hold ? 0 : null),
    restSecs: parseMaxSeconds(p.rest),
    target: p.reps != null ? String(p.reps) : (p.duration != null ? String(p.duration) : ''),
  };
}

/* ---------- open workout ---------- */
async function openWorkout(file) {
  $('pick-list').innerHTML = '<p>Loading workout…</p>';
  try {
    const workout = jsyaml.load(await getRaw(`workouts/${file}`));
    const names = [...new Set((workout.exercises || []).map(e => e.name))];
    const exInfo = {};
    await Promise.all(names.map(async n => {
      try { exInfo[n] = jsyaml.load(await getRaw(`exercises/${n}.yaml`)); }
      catch { exInfo[n] = null; }
    }));
    state = {
      file, workout, exInfo, pain: 'none',
      ei: 0, si: 0, mode: 'work',
      results: (workout.exercises || []).map(e => ({
        name: e.name, sets: Array(exMeta(e).nSets).fill(null), comment: '',
      })),
    };
    show('player');
    render();
  } catch (e) { $('pick-list').innerHTML = `<p class="error">${e.message}</p>`; }
}

/* ---------- flow ---------- */
function advance() {
  const { ei, si, mode } = state;
  const exs = state.workout.exercises;
  const m = exMeta(exs[ei]);
  if (mode === 'work') {
    state.mode = si < m.nSets - 1 ? 'rest' : 'transition';
  } else if (mode === 'rest') {
    state.si++; state.mode = 'work';
  } else { // transition
    if (ei < exs.length - 1) { state.ei++; state.si = 0; state.mode = 'work'; }
    else { stopTimer(); show('finish'); return; }
  }
  render();
}
function goBack() {
  const { ei, si } = state;
  if (state.mode !== 'work') { state.mode = 'work'; }
  else if (si > 0) { state.si--; }
  else if (ei > 0) { state.ei--; state.si = exMeta(state.workout.exercises[ei - 1]).nSets - 1; }
  render();
}

function render() {
  stopTimer();
  const exs = state.workout.exercises;
  const total = exs.length;
  const { ei, si, mode } = state;
  const entry = exs[ei];
  const m = exMeta(entry);
  $('progress').textContent = `${ei + 1} / ${total}`;
  $('progress-fill').style.width = `${((ei + (si + 1) / m.nSets) / total) * 100}%`;
  if (mode === 'work') renderWork(entry, m);
  else renderRest(entry, m, mode);
}

function renderWork(entry, m) {
  const { ei, si } = state;
  const res = state.results[ei];
  const info = state.exInfo[entry.name];
  const card = $('card');
  card.innerHTML = '';
  const add = (h) => card.insertAdjacentHTML('beforeend', h);

  const phase = entry.phase || 'main';
  add(`<span class="phase-chip ${phase}">${phase}</span>`);
  add(`<h2 class="ex-title">${esc(entry.name.replace(/-/g, ' '))}</h2>`);
  add(`<div class="set-line">${m.setWord} <b>${si + 1}</b> / ${m.nSets}` +
      (m.target ? ` &nbsp;·&nbsp; target: <b>${esc(m.target)}</b>` : '') + `</div>`);
  const attrs = ['grip', 'depth', 'tempo', 'apparatus'].filter(k => m.p[k]).map(k => `${k}: ${esc(m.p[k])}`);
  if (attrs.length) add(`<div class="attr-line">${attrs.join(' · ')}</div>`);

  // collapsed details
  let det = '';
  const note = m.p.note || m.p['order-note'];
  if (note) det += `<div class="plan-note">${esc(note)}</div>`;
  if (info && info.notes) det += `<div class="ex-notes">${fmtText(info.notes)}</div>`;
  if (info && info.personal) det += `<div class="personal"><b>You:</b> ${fmtText(info.personal)}</div>`;
  const hasMedia = info && info.media;
  if (det || hasMedia) {
    add(`<details class="det"><summary>Details${hasMedia ? ' & figure' : ''}</summary>${det}<div class="media-slot"></div></details>`);
    if (hasMedia) {
      const mm = String(info.media);
      const slot = card.querySelector('.media-slot');
      if (/^https?:/.test(mm)) slot.innerHTML = `<a class="video" href="${mm}" target="_blank" rel="noopener">▶ Watch demo video</a>`;
      else if (mm.endsWith('.svg')) getRaw(`exercises/${mm}`).then(svg => { if (svg) slot.innerHTML = svg; }).catch(() => {});
    }
  }

  // duration work gets its own timer
  if (m.workSecs) addTimer(card, m.workSecs, false, () => {
    const inp = $('in-num');
    if (inp && !inp.value) inp.value = m.workSecs;
  });

  add(`<input id="in-num" type="number" inputmode="numeric" min="0"
        placeholder="${m.unit === 'reps' ? 'reps done' : 'seconds held'} — empty = skipped"
        value="${res.sets[si] != null ? res.sets[si] : ''}">`);
  add(`<button id="btn-go" class="primary big">Next ›</button>`);
  $('in-num').oninput = (e) => { res.sets[si] = e.target.value === '' ? null : Number(e.target.value); };
  $('btn-go').onclick = advance;
}

function renderRest(entry, m, mode) {
  const { ei } = state;
  const card = $('card');
  card.innerHTML = '';
  const add = (h) => card.insertAdjacentHTML('beforeend', h);

  const exs = state.workout.exercises;
  const nextUp = mode === 'rest'
    ? `${entry.name.replace(/-/g, ' ')} — ${exMeta(entry).setWord.toLowerCase()} ${state.si + 2} / ${m.nSets}`
    : (ei < exs.length - 1 ? exs[ei + 1].name.replace(/-/g, ' ') : 'finish 🎉');

  add(`<h2 class="ex-title">Rest</h2>`);
  add(`<div class="set-line">next: <b>${esc(nextUp)}</b></div>`);
  if (m.restSecs) addTimer(card, m.restSecs, true);

  if (mode === 'transition') {
    const res = state.results[ei];
    add(`<label class="lbl">Comment on ${esc(entry.name.replace(/-/g, ' '))} (pain, insight — optional)</label>
         <textarea id="in-comment" placeholder="e.g. felt it in the elbow / too easy / better setup found...">${esc(res.comment)}</textarea>`);
    $('in-comment').oninput = (e) => { res.comment = e.target.value; };
  }
  add(`<button id="btn-go" class="primary big">Next ›</button>`);
  $('btn-go').onclick = advance;
}

/* ---------- timer widget ---------- */
function addTimer(card, target, autostart, onDone) {
  card.insertAdjacentHTML('beforeend', `
    <div class="timer-box">
      <div class="timer-display" id="timer-d">${fmtTime(target)}</div>
      <div class="timer-btns">
        <button id="t-start" class="primary">Start</button>
        <button id="t-stop">Stop</button>
        <button id="t-plus">+10s</button>
      </div>
    </div>`);
  const t = { target, left: target, onDone };
  $('t-start').onclick = () => startTimer(t);
  $('t-stop').onclick = () => stopTimer();
  $('t-plus').onclick = () => {
    t.left += 10; t.target += 10;
    $('timer-d').textContent = fmtTime(t.left);
  };
  if (autostart) startTimer(t);
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function stopTimer() {
  if (timerInt) { clearInterval(timerInt); timerInt = null; }
  const d = $('timer-d'); if (d) d.classList.remove('running');
}
function startTimer(t) {
  stopTimer();
  const d = $('timer-d');
  if (!d) return;
  d.classList.remove('zero'); d.classList.add('running');
  d.textContent = fmtTime(t.left);
  timerInt = setInterval(() => {
    t.left--;
    const dd = $('timer-d');
    if (!dd) { stopTimer(); return; }
    dd.textContent = fmtTime(Math.max(t.left, 0));
    if (t.left <= 0) {
      stopTimer();
      dd.classList.add('zero');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      beep();
      if (t.onDone) t.onDone();
    }
  }, 1000);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch {}
}

/* ---------- header nav ---------- */
$('btn-exit').onclick = () => {
  if (!confirm('Quit this session? Unsaved progress will be lost.')) return;
  stopTimer(); loadPick();
};
$('btn-back').onclick = () => { show('player'); render(); };
$('btn-prev-step').onclick = () => goBack();

/* ---------- finish + save ---------- */
$('pain-none').onclick = () => { state.pain = 'none'; $('pain-none').classList.add('sel'); $('pain-some').classList.remove('sel'); $('pain-text').hidden = true; };
$('pain-some').onclick = () => { state.pain = 'some'; $('pain-some').classList.add('sel'); $('pain-none').classList.remove('sel'); $('pain-text').hidden = false; };

$('btn-save').onclick = async () => {
  const btn = $('btn-save');
  btn.disabled = true; $('save-status').textContent = 'Saving…';
  try {
    const name = state.file.replace('.yaml', '');
    const fb = {
      workout: name,
      captured: new Date().toISOString(),
      source: 'workout-player',
      pain: state.pain === 'none' ? 'none' : ($('pain-text').value.trim() || 'unspecified'),
      entries: state.results.map((r, i) => ({
        name: r.name,
        unit: exMeta(state.workout.exercises[i]).unit,
        sets: r.sets,
        ...(r.sets.every(s => s == null) ? { status: 'skipped' } : {}),
        ...(r.comment ? { comment: r.comment } : {}),
      })),
      notes: $('overall-notes').value.trim(),
    };
    await putFile(`feedback/${name}.yaml`, jsyaml.dump(fb, { lineWidth: 78 }),
      `Raw feedback: ${name} (workout-player)`);
    $('save-status').textContent = '✓ Saved to the repo. The agent will process it.';
  } catch (e) {
    $('save-status').textContent = 'Save failed: ' + e.message;
    btn.disabled = false;
  }
};

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (token) loadPick(); else show('setup');
