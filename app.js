/* Workout Player — reads plans from the private exercise repo, writes raw
   feedback back. App code is public; all data stays in the private repo. */
const OWNER = 'balintdom', REPO = 'exercise', BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const $ = (id) => document.getElementById(id);
const views = ['setup', 'pick', 'player', 'finish'];
function show(v) { views.forEach(x => $('view-' + x).hidden = (x !== v)); window.scrollTo(0, 0); }

let token = localStorage.getItem('gh_token') || '';
let state = null; // { file, workout, exInfo, results, idx, pain, overall }
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
const getRaw = (p) => gh(`contents/${encodeURIComponent(p).replace(/%2F/g, '/')}?ref=${BRANCH}`, {}, true);

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
    await gh(''); // repo meta = token works
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
      file, workout, exInfo, idx: 0, pain: 'none', overall: '',
      results: (workout.exercises || []).map(e => ({
        name: e.name, status: null, setsDone: 0, actual: '', comment: '',
      })),
    };
    show('player');
    renderCard();
  } catch (e) { $('pick-list').innerHTML = `<p class="error">${e.message}</p>`; }
}

/* ---------- player card ---------- */
function fmtPlanned(p) {
  if (!p) return [];
  const chips = [];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'note' || k === 'order-note') continue;
    if (k === 'rest') chips.push(`rest ${esc(v)}s`);
    else chips.push(`${esc(k)}: ${esc(v)}`);
  }
  return chips;
}
function parseSeconds(v) {
  // "150-180" | 120 | "30s/side" | "2-3 min" | "1 min" -> [seconds...]
  if (v == null) return [];
  const s = String(v);
  const mul = /min/.test(s) ? 60 : 1;
  const nums = (s.match(/\d+/g) || []).map(Number).map(n => n * mul);
  if (!nums.length) return [];
  return [...new Set([nums[0], nums[nums.length - 1]])];
}

function renderCard() {
  stopTimer();
  const i = state.idx;
  const entry = state.workout.exercises[i];
  const res = state.results[i];
  const info = state.exInfo[entry.name];
  const total = state.workout.exercises.length;

  $('progress').textContent = `${i + 1} / ${total}`;
  $('progress-fill').style.width = `${((i + 1) / total) * 100}%`;
  $('btn-prev').disabled = i === 0;
  $('btn-next').textContent = i === total - 1 ? 'Finish ›' : 'Next ›';

  const p = entry.planned || {};
  const card = $('card');
  card.innerHTML = '';
  const add = (html) => card.insertAdjacentHTML('beforeend', html);

  const phase = entry.phase || 'main';
  add(`<span class="phase-chip ${phase}">${phase}</span>`);
  add(`<h2 class="ex-title">${entry.name.replace(/-/g, ' ')}</h2>`);
  add(`<div class="plan-chips">${fmtPlanned(p).map(c => `<span>${c}</span>`).join('')}</div>`);
  const note = p.note || p['order-note'];
  if (note) add(`<div class="plan-note">${esc(note)}</div>`);
  if (info && info.notes) add(`<div class="ex-notes">${esc(info.notes.trim())}</div>`);
  if (info && info.personal) add(`<div class="personal"><b>You:</b> ${esc(info.personal.trim())}</div>`);

  // media
  if (info && info.media) {
    const m = String(info.media);
    if (/^https?:/.test(m)) {
      add(`<div class="media-box"><a class="video" href="${m}" target="_blank" rel="noopener">▶ Watch demo video</a></div>`);
    } else if (m.endsWith('.svg')) {
      const box = document.createElement('div'); box.className = 'media-box';
      card.appendChild(box);
      getRaw(`exercises/${m}`).then(svg => { if (svg) box.innerHTML = svg; }).catch(() => {});
    }
  }

  // sets tracker
  const nSets = parseInt(p.sets, 10);
  if (nSets) {
    const dots = Array.from({ length: nSets }, (_, k) =>
      `<div class="set-dot ${k < res.setsDone ? 'done' : ''}">${k + 1}</div>`).join('');
    add(`<div class="sets-box"><div class="sets-dots">${dots}</div>
      <button id="set-done" class="primary" ${res.setsDone >= nSets ? 'disabled' : ''}>
        ${res.setsDone >= nSets ? 'All sets done ✓' : `Set ${res.setsDone + 1} done — start rest`}
      </button></div>`);
  }

  // timer (rest for set-based, duration otherwise)
  const secs = parseSeconds(p.rest != null ? p.rest : p.duration);
  if (secs.length) {
    const label = p.rest != null ? 'Rest timer' : 'Duration timer';
    add(`<div class="timer-box"><div class="lbl" style="margin:0 0 4px">${label}</div>
      <div class="timer-display" id="timer-d">${fmtTime(secs[secs.length - 1])}</div>
      <div class="timer-btns">
        ${secs.map(s => `<button class="t-preset" data-s="${s}">${fmtTime(s)}</button>`).join('')}
        <button id="t-start" class="primary">Start</button>
        <button id="t-stop">Stop</button>
      </div></div>`);
    let target = secs[secs.length - 1];
    card.querySelectorAll('.t-preset').forEach(b => b.onclick = () => {
      target = +b.dataset.s; stopTimer(); $('timer-d').textContent = fmtTime(target);
    });
    $('t-start').onclick = () => startTimer(target);
    $('t-stop').onclick = () => stopTimer();
    if (nSets) {
      const sd = $('set-done');
      if (sd) sd.onclick = () => {
        res.setsDone++;
        if (res.setsDone >= nSets && res.status === null) res.status = 'done';
        renderCard();
        if (res.setsDone < nSets) startTimer(target);
      };
    }
  } else if (nSets) {
    const sd = $('set-done');
    if (sd) sd.onclick = () => {
      res.setsDone++;
      if (res.setsDone >= nSets && res.status === null) res.status = 'done';
      renderCard();
    };
  }

  // status + capture
  add(`<div class="status-row">
      <button id="st-done" class="done-b ${res.status === 'done' ? 'sel' : ''}">Done ✓</button>
      <button id="st-skip" class="skip-b ${res.status === 'skipped' ? 'sel' : ''}">Skip</button>
    </div>
    <input id="in-actual" placeholder="actual (e.g. 4x2, 25s, only 3 reps last set)" value="${esc(res.actual)}">
    <textarea id="in-comment" placeholder="comment — anything: too easy, felt it in the elbow, found a better setup...">${esc(res.comment)}</textarea>`);
  $('st-done').onclick = () => { res.status = res.status === 'done' ? null : 'done'; renderCard(); };
  $('st-skip').onclick = () => { res.status = res.status === 'skipped' ? null : 'skipped'; renderCard(); };
  $('in-actual').oninput = (e) => { res.actual = e.target.value; };
  $('in-comment').oninput = (e) => { res.comment = e.target.value; };
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

/* ---------- timer ---------- */
function fmtTime(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } const d = $('timer-d'); if (d) d.classList.remove('running'); }
function startTimer(target) {
  stopTimer();
  let left = target;
  const d = $('timer-d');
  if (!d) return;
  d.classList.remove('zero'); d.classList.add('running');
  d.textContent = fmtTime(left);
  timerInt = setInterval(() => {
    left--;
    if (!$('timer-d')) { stopTimer(); return; }
    $('timer-d').textContent = fmtTime(Math.max(left, 0));
    if (left <= 0) {
      stopTimer();
      $('timer-d').classList.add('zero');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      beep();
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

/* ---------- navigation ---------- */
$('btn-prev').onclick = () => { if (state.idx > 0) { state.idx--; renderCard(); } };
$('btn-next').onclick = () => {
  if (state.idx < state.workout.exercises.length - 1) { state.idx++; renderCard(); }
  else { stopTimer(); show('finish'); }
};
$('btn-exit').onclick = () => { stopTimer(); loadPick(); };
$('btn-back').onclick = () => { show('player'); renderCard(); };

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
      entries: state.results.map(r => ({
        name: r.name,
        ...(r.status ? { status: r.status } : {}),
        ...(r.setsDone ? { 'sets-done': r.setsDone } : {}),
        ...(r.actual ? { actual: r.actual } : {}),
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
