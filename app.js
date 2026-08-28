/* Workout Player — reads plans from the private exercise repo, writes raw
   feedback back. App code is public; all data stays in the private repo. */
const OWNER = 'balintdom', REPO = 'exercise', BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const $ = (id) => document.getElementById(id);
const views = ['setup', 'pick', 'player', 'plan', 'finish'];
function show(v) { views.forEach(x => $('view-' + x).hidden = (x !== v)); window.scrollTo(0, 0); keepAwake(v === 'player' || v === 'plan'); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
// YAML | blocks carry hard 78-col wraps; unwrap them, keep paragraph breaks
function fmtText(s) {
  return String(s).trim().split(/\n\s*\n/)
    .map(p => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('');
}

// keep the screen on during a session (rest timers must stay visible)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('view-player').hidden) keepAwake(true);
});

let token = localStorage.getItem('gh_token') || '';
let S = null;          // live session state (persisted on every change)
let timerInt = null;

/* ---------- persistence ---------- */
const sessionKey = (f) => 'session:' + f;
const doneKey = (f) => 'done:' + f;
function persist() { if (S) try { localStorage.setItem(sessionKey(S.file), JSON.stringify(S)); } catch {} }
function markDone(file) {
  try { localStorage.setItem(doneKey(file), '1'); localStorage.removeItem(sessionKey(file)); } catch {}
}

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
    const [items, fbItems] = await Promise.all([
      gh(`contents/workouts?ref=${BRANCH}`),
      gh(`contents/feedback?ref=${BRANCH}`),
    ]);
    const fbNames = new Set((fbItems || []).map(i => i.name.replace('.yaml', '')));
    const rows = (items || [])
      .filter(i => i.name.endsWith('.yaml'))
      .map(i => ({ file: i.name, base: i.name.replace('.yaml', ''), date: i.name.slice(0, 10), place: i.name.slice(11).replace('.yaml', '') }));
    // done = local flag, pending feedback exists, or the workout file has done fields
    await Promise.all(rows.map(async r => {
      r.inProgress = !!localStorage.getItem(sessionKey(r.file));
      if (localStorage.getItem(doneKey(r.file)) || fbNames.has(r.base)) { r.done = true; return; }
      try { r.done = /^\s+done:/m.test((await getRaw(`workouts/${r.file}`)) || ''); } catch { r.done = false; }
    }));
    const today = todayStr();
    const open = rows.filter(r => !r.done).sort((a, b) => a.date.localeCompare(b.date));
    const done = rows.filter(r => r.done).sort((a, b) => b.date.localeCompare(a.date));
    const el = $('pick-list');
    el.innerHTML = '';
    const mkRow = (r) => {
      const b = document.createElement('button');
      b.className = 'pick-item';
      const tag = r.inProgress ? ' <span class="prog-tag">in progress</span>'
        : (r.done ? ' <span class="done-tag">done ✓</span>'
          : (r.date === today ? ' <span class="today-tag">today</span>'
            : (r.date < today ? ' <span class="past">past</span>' : '')));
      b.innerHTML = `<span class="when">${esc(r.date)}${tag}</span><span>${esc(r.place)}</span>`;
      b.onclick = () => openWorkout(r.file);
      return b;
    };
    if (!open.length) el.innerHTML = '<p>No planned workouts. Ask the agent to plan one!</p>';
    open.forEach(r => el.appendChild(mkRow(r)));
    if (done.length) {
      const det = document.createElement('details');
      det.className = 'done-list';
      det.innerHTML = `<summary>Done (${done.length})</summary>`;
      done.slice(0, 15).forEach(r => det.appendChild(mkRow(r)));
      el.appendChild(det);
    }
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
    workSecs: isDuration ? parseMaxSeconds(p.duration) : 0,
    restSecs: parseMaxSeconds(p.rest) || 5,   // default 5s to breathe/prepare
    target: p.reps != null ? String(p.reps) : (p.duration != null ? String(p.duration) : ''),
  };
}

/* ---------- open / resume workout ---------- */
async function openWorkout(file) {
  const saved = localStorage.getItem(sessionKey(file));
  if (saved) {
    try {
      S = JSON.parse(saved);
      show('player'); render();
      return;
    } catch {}
  }
  $('pick-list').innerHTML = '<p>Loading workout…</p>';
  try {
    const workout = jsyaml.load(await getRaw(`workouts/${file}`));
    const names = [...new Set((workout.exercises || []).map(e => e.name))];
    const exInfo = {};
    await Promise.all(names.map(async n => {
      try { exInfo[n] = jsyaml.load(await getRaw(`exercises/${n}.yaml`)); }
      catch { exInfo[n] = null; }
    }));
    S = {
      file, workout, exInfo,
      ei: 0, si: 0, mode: 'work',
      pain: 'none', painText: '', overall: '',
      appNotes: [], nextWorkouts: [],
      results: (workout.exercises || []).map(e => ({
        name: e.name, sets: Array(exMeta(e).nSets).fill(null), comment: '',
      })),
    };
    persist();
    show('player');
    render();
  } catch (e) { $('pick-list').innerHTML = `<p class="error">${e.message}</p>`; }
}

/* ---------- flow ---------- */
function advance() {
  const exs = S.workout.exercises;
  const m = exMeta(exs[S.ei]);
  if (S.mode === 'work') {
    S.mode = S.si < m.nSets - 1 ? 'rest' : 'transition';
  } else if (S.mode === 'rest') {
    S.si++; S.mode = 'work';
  } else { // transition
    if (S.ei < exs.length - 1) { S.ei++; S.si = 0; S.mode = 'work'; }
    else { persist(); stopTimer(); showPlan(); return; }
  }
  persist();
  render();
}
function goBack() {
  if (S.mode !== 'work') { S.mode = 'work'; }
  else if (S.si > 0) { S.si--; }
  else if (S.ei > 0) { S.ei--; S.si = exMeta(S.workout.exercises[S.ei]).nSets - 1; }
  persist();
  render();
}

function render() {
  stopTimer();
  const exs = S.workout.exercises;
  const entry = exs[S.ei];
  const m = exMeta(entry);
  $('progress').textContent = `${S.ei + 1} / ${exs.length}`;
  $('progress-fill').style.width = `${((S.ei + (S.si + 1) / m.nSets) / exs.length) * 100}%`;
  if (S.mode === 'work') renderWork(entry, m);
  else renderRest(entry, m, S.mode);
}

/* details block for an exercise (used on work cards and rest previews) */
function detailsHtml(info, p, label) {
  if (!info && !p) return '';
  let det = '';
  const note = p && (p.note || p['order-note']);
  if (note) det += `<div class="plan-note">${esc(note)}</div>`;
  if (info) {
    if (info.personal) det += `<div class="personal"><b>You:</b> ${fmtText(info.personal)}</div>`;
    const li = (v) => (Array.isArray(v) ? v : [v]).map(x => `<li>${esc(x)}</li>`).join('');
    if (info.how) det += `<div class="sec-h">How</div><ol class="how">${li(info.how)}</ol>`;
    if (info.feel) det += `<div class="sec-h">Feel</div><div class="ex-notes">${fmtText(info.feel)}</div>`;
    if (info.dos) det += `<div class="sec-h">Do</div><ul class="dos">${li(info.dos)}</ul>`;
    if (info.donts) det += `<div class="sec-h">Don't</div><ul class="donts">${li(info.donts)}</ul>`;
    if (info.notes) det += `<div class="ex-notes">${fmtText(info.notes)}</div>`;
    const vid = String(info.video || '').match(/[?&]v=([\w-]{11})/);
    if (vid)
      det += `<div class="yt" data-id="${vid[1]}">
          <img src="https://i.ytimg.com/vi/${vid[1]}/hqdefault.jpg" alt="video thumbnail" loading="lazy">
          <span class="yt-play">▶</span></div>
        <a class="yt-ext" href="${esc(info.video)}" target="_blank" rel="noopener">open in YouTube ↗</a>`;
  }
  return det ? `<details class="det"><summary>${label}</summary>${det}</details>` : '';
}
function wireYt(card) {
  card.querySelectorAll('.yt').forEach(yt => yt.onclick = () => {
    yt.outerHTML = `<div class="yt playing"><iframe
      src="https://www.youtube-nocookie.com/embed/${yt.dataset.id}?autoplay=1&playsinline=1&rel=0"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen title="demo video"></iframe></div>`;
  });
}

function renderWork(entry, m) {
  const res = S.results[S.ei];
  const info = S.exInfo[entry.name];
  const card = $('card');
  card.innerHTML = '';
  const add = (h) => card.insertAdjacentHTML('beforeend', h);
  const auto = { on: true };

  const phase = entry.phase || 'main';
  add(`<span class="phase-chip ${phase}">${phase}</span>`);
  add(`<h2 class="ex-title">${esc(entry.name.replace(/-/g, ' '))}</h2>`);
  add(`<div class="set-line">${m.setWord} <b>${S.si + 1}</b> / ${m.nSets}` +
      (m.target ? ` &nbsp;·&nbsp; target: <b>${esc(m.target)}</b>` : '') + `</div>`);
  const attrs = ['grip', 'depth', 'tempo', 'apparatus'].filter(k => m.p[k]).map(k => `${k}: ${esc(m.p[k])}`);
  if (attrs.length) add(`<div class="attr-line">${attrs.join(' · ')}</div>`);
  add(detailsHtml(info, m.p, 'Details'));
  wireYt(card);

  // duration work: timer autostarts, completion prefills + auto-advances
  if (m.workSecs) {
    addTimer(card, m.workSecs, auto, () => {
      const inp = $('in-num');
      if (inp && !inp.value) { inp.value = m.workSecs; res.sets[S.si] = m.workSecs; persist(); }
      if (auto.on) advance();
    }, true);
  }

  add(`<input id="in-num" type="number" inputmode="numeric" min="0"
        placeholder="${m.unit === 'reps' ? 'reps done' : 'seconds held'} — empty = skipped"
        value="${res.sets[S.si] != null ? res.sets[S.si] : ''}">`);
  add(`<button id="btn-go" class="primary big">Next ›</button>`);
  $('in-num').oninput = (e) => {
    auto.on = false;
    res.sets[S.si] = e.target.value === '' ? null : Number(e.target.value);
    persist();
  };
  $('btn-go').onclick = advance;
}

function renderRest(entry, m, mode) {
  const card = $('card');
  card.innerHTML = '';
  const add = (h) => card.insertAdjacentHTML('beforeend', h);
  const auto = { on: true };

  const exs = S.workout.exercises;
  const nextEntry = mode === 'rest' ? entry : exs[S.ei + 1];
  const nextUp = mode === 'rest'
    ? `${entry.name.replace(/-/g, ' ')} — ${exMeta(entry).setWord.toLowerCase()} ${S.si + 2} / ${m.nSets}`
    : (nextEntry ? nextEntry.name.replace(/-/g, ' ') : 'finish 🎉');

  add(`<h2 class="ex-title">Rest</h2>`);
  add(`<div class="set-line">next: <b>${esc(nextUp)}</b></div>`);
  addTimer(card, m.restSecs, auto, () => { if (auto.on) advance(); }, true);

  if (mode === 'transition') {
    const res = S.results[S.ei];
    add(`<label class="lbl">Comment on ${esc(entry.name.replace(/-/g, ' '))} (pain, insight — optional)</label>
         <textarea id="in-comment" placeholder="typing pauses auto-advance">${esc(res.comment)}</textarea>`);
    $('in-comment').oninput = (e) => { auto.on = false; res.comment = e.target.value; persist(); };
    $('in-comment').onfocus = () => { auto.on = false; };
    // preview of the NEXT exercise for reading during the rest
    if (nextEntry) {
      add(detailsHtml(S.exInfo[nextEntry.name], nextEntry.planned, `Next up: ${esc(nextEntry.name.replace(/-/g, ' '))}`));
      wireYt(card);
    }
  }
  add(`<button id="btn-go" class="primary big">Next ›</button>`);
  $('btn-go').onclick = advance;
}

/* ---------- timer widget ---------- */
function addTimer(card, target, auto, onDone, autostart) {
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
  $('t-stop').onclick = () => { auto.on = false; stopTimer(); };
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

/* ---------- app-improvement ideas ---------- */
$('btn-idea').onclick = () => { $('idea-overlay').hidden = false; $('idea-text').focus(); };
$('idea-cancel').onclick = () => { $('idea-overlay').hidden = true; $('idea-text').value = ''; };
$('idea-add').onclick = () => {
  const txt = $('idea-text').value.trim();
  if (txt && S) {
    S.appNotes.push({ at: S.workout.exercises[S.ei] ? S.workout.exercises[S.ei].name : '', text: txt });
    persist();
  }
  $('idea-overlay').hidden = true; $('idea-text').value = '';
};

/* ---------- header nav ---------- */
$('btn-exit').onclick = () => { stopTimer(); loadPick(); };   // state persists; no data loss on exit
$('btn-prev-step').onclick = () => goBack();

/* ---------- plan next workouts ---------- */
async function showPlan() {
  show('plan');
  renderPlanList();
  if (!$('plan-place').options.length) {
    try {
      const places = (await gh(`contents/places?ref=${BRANCH}`)) || [];
      for (const p of places.filter(x => x.name.endsWith('.yaml'))) {
        const o = document.createElement('option');
        o.value = o.textContent = p.name.replace('.yaml', '');
        $('plan-place').appendChild(o);
      }
    } catch {}
  }
  $('plan-date').value = $('plan-date').value || '';
}
function renderPlanList() {
  const el = $('plan-list');
  el.innerHTML = S.nextWorkouts.length ? '' : '<p>No next workout added yet.</p>';
  S.nextWorkouts.forEach((w, i) => {
    const d = document.createElement('div');
    d.className = 'plan-item';
    d.innerHTML = `<span>${esc(w.date)} ${esc(w.time)} · ${esc(w.type)} · ${esc(String(w['length-min']))}min @ ${esc(w.place)}</span>
      <button class="ghost" data-i="${i}">✕</button>`;
    d.querySelector('button').onclick = () => { S.nextWorkouts.splice(i, 1); persist(); renderPlanList(); };
    el.appendChild(d);
  });
}
$('plan-add').onclick = () => {
  const w = {
    date: $('plan-date').value, time: $('plan-time').value || '11:00',
    type: $('plan-type').value, 'length-min': Number($('plan-length').value) || 60,
    place: $('plan-place').value,
  };
  if (!w.date) { $('plan-date').focus(); return; }
  S.nextWorkouts.push(w); persist(); renderPlanList();
};
$('plan-back').onclick = () => { show('player'); render(); };
$('plan-next').onclick = () => {
  // restore finish view bindings from state
  if (S.pain === 'some') { $('pain-some').classList.add('sel'); $('pain-none').classList.remove('sel'); $('pain-text').hidden = false; }
  else { $('pain-none').classList.add('sel'); $('pain-some').classList.remove('sel'); $('pain-text').hidden = true; }
  $('pain-text').value = S.painText || '';
  $('overall-notes').value = S.overall || '';
  show('finish');
};

/* ---------- finish + save ---------- */
$('pain-none').onclick = () => { S.pain = 'none'; persist(); $('pain-none').classList.add('sel'); $('pain-some').classList.remove('sel'); $('pain-text').hidden = true; };
$('pain-some').onclick = () => { S.pain = 'some'; persist(); $('pain-some').classList.add('sel'); $('pain-none').classList.remove('sel'); $('pain-text').hidden = false; };
$('pain-text').oninput = (e) => { S.painText = e.target.value; persist(); };
$('overall-notes').oninput = (e) => { S.overall = e.target.value; persist(); };
$('btn-back').onclick = () => { showPlan(); };

$('btn-save').onclick = async () => {
  const btn = $('btn-save');
  btn.disabled = true; $('save-status').textContent = 'Saving…';
  try {
    const name = S.file.replace('.yaml', '');
    const fb = {
      workout: name,
      captured: new Date().toISOString(),
      source: 'workout-player',
      pain: S.pain === 'none' ? 'none' : (S.painText.trim() || 'unspecified'),
      entries: S.results.map((r, i) => ({
        name: r.name,
        unit: exMeta(S.workout.exercises[i]).unit,
        sets: r.sets,
        ...(r.sets.every(s => s == null) ? { status: 'skipped' } : {}),
        ...(r.comment ? { comment: r.comment } : {}),
      })),
      ...(S.nextWorkouts.length ? { 'next-workouts': S.nextWorkouts } : {}),
      notes: S.overall.trim(),
    };
    await putFile(`feedback/${name}.yaml`, jsyaml.dump(fb, { lineWidth: 78 }),
      `Raw feedback: ${name} (workout-player)`);
    if (S.appNotes.length) {
      let ideas = { ideas: [] };
      try { const cur = await getRaw('feedback/app-improvements.yaml'); if (cur) ideas = jsyaml.load(cur) || ideas; } catch {}
      if (!Array.isArray(ideas.ideas)) ideas.ideas = [];
      for (const n of S.appNotes) ideas.ideas.push({ date: todayStr(), workout: name, ...n });
      await putFile('feedback/app-improvements.yaml', jsyaml.dump(ideas, { lineWidth: 78 }),
        `App improvement ideas from ${name}`);
    }
    markDone(S.file);
    $('save-status').textContent = '✓ Saved to the repo. The agent will process it.';
    $('btn-back').hidden = true;
    $('btn-save').hidden = true;
    $('btn-done-home').hidden = false;
  } catch (e) {
    $('save-status').textContent = 'Save failed: ' + e.message;
    btn.disabled = false;
  }
};
$('btn-done-home').onclick = () => {
  $('btn-back').hidden = false; $('btn-save').hidden = false; $('btn-save').disabled = false;
  $('btn-done-home').hidden = true; $('save-status').textContent = '';
  S = null;
  loadPick();
};

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (token) loadPick(); else show('setup');
