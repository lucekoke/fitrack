'use strict';

// ─── State ────────────────────────────────────────────────────────────────
let workouts  = [];
let endurance = [];
let sports    = [];
let meals     = [];
let foods_db  = [];
let recipes   = [];
let exercise_catalog = [];

// ─── API helper ───────────────────────────────────────────────────────────
async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(await resp.text());
  const ct = resp.headers.get('content-type') || '';
  return ct.includes('json') ? resp.json() : null;
}

// ─── Formatters ───────────────────────────────────────────────────────────

// Reps: just the per-set numbers (sets column already shows the count)
// [8,8,8,8] → "8"   |   [8,8,7,6] → "8, 8, 7, 6"
function fmt_reps(reps_json) {
  const reps   = JSON.parse(reps_json);
  const unique = [...new Set(reps)];
  return unique.length === 1 ? String(reps[0]) : esc(reps.join(', '));
}

// Weight: "100.0 kg (220.5 lbs)"  or  "BW"
function fmt_weight(wkg_json, wlbs_json) {
  if (!wkg_json) return 'BW';
  const kg  = JSON.parse(wkg_json);
  const lbs = wlbs_json ? JSON.parse(wlbs_json) : null;
  const kg_s  = [...new Set(kg)].length  === 1 ? String(kg[0])  : kg.join(', ');
  if (lbs) {
    const lbs_s = [...new Set(lbs)].length === 1 ? String(lbs[0]) : lbs.join(', ');
    return `${kg_s}&thinsp;kg (${lbs_s}&thinsp;lbs)`;
  }
  return `${kg_s}&thinsp;kg`;
}

function weight_to_input(w_json) {
  if (!w_json) return '';
  const vals = JSON.parse(w_json);
  return [...new Set(vals)].length === 1 ? String(vals[0]) : vals.join(', ');
}

// Returns 'lbs' or 'kg' based on which stored value is "cleaner" (divisible by 0.5).
// Prefers lbs on a tie (both clean or neither clean).
function pick_weight_unit(ex) {
  if (!ex || !ex.weight_kg) return 'kg';
  const is_clean  = v => v === null || Math.round(v * 2) === v * 2;
  const all_clean = arr => arr.every(is_clean);
  const kg_clean  = all_clean(JSON.parse(ex.weight_kg));
  const lbs_clean = ex.weight_lbs ? all_clean(JSON.parse(ex.weight_lbs)) : false;
  return (kg_clean && !lbs_clean) ? 'kg' : 'lbs';
}

function reps_to_input(reps_json) {
  const reps = JSON.parse(reps_json);
  return [...new Set(reps)].length === 1 ? String(reps[0]) : reps.join(', ');
}

// Parse duration string → integer seconds (or null).
// Accepted formats:
//   "90"        → 90 minutes = 5400 s   (bare number = minutes)
//   "1:30"      → 1 h 30 min = 5400 s   (H:MM)
//   "1:30:45"   → 1 h 30 min 45 s       (H:MM:SS)
//   "0:45"      → 45 min                (H:MM)
function parse_duration(s) {
  if (!s || !s.trim()) return null;
  const clean = s.trim();
  // Bare integer → treat as minutes
  if (/^\d+$/.test(clean)) return parseInt(clean, 10) * 60;
  // Colon-separated
  const parts = clean.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // H:MM:SS
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;            // H:MM
  return null;
}

// Format integer seconds → "H:MM" (no seconds if exact), else "H:MM:SS"
function fmt_duration(s) {
  if (s == null) return '—';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Show back as H:MM or H:MM:SS so editing round-trips cleanly
function duration_to_input(s) {
  if (s == null) return '';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (sec === 0) return `${h}:${String(m).padStart(2, '0')}`;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmt_pace(distance_km, duration_s) {
  if (!distance_km || !duration_s) return '—';
  const pace_s = duration_s / distance_km;
  const m = Math.floor(pace_s / 60);
  const s = Math.round(pace_s % 60);
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

function fmt_speed(distance_km, duration_s) {
  if (!distance_km || !duration_s) return '—';
  return (distance_km / (duration_s / 3600)).toFixed(1) + ' km/h';
}

function opt(val, suffix = '', fallback = '—') {
  return (val != null && val !== '') ? (val + suffix) : fallback;
}

function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

// ─── State lookups ────────────────────────────────────────────────────────
function find_exercise(id) {
  for (const s of workouts) {
    const ex = s.exercises.find(e => e.id === id);
    if (ex) return { session: s, exercise: ex };
  }
  return null;
}

// ─── Tab navigation ───────────────────────────────────────────────────────
document.querySelectorAll('.tab-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => { s.hidden = true; });
    link.classList.add('active');
    document.getElementById(`tab-${link.dataset.tab}`).hidden = false;
    if (link.dataset.tab === 'body')     load_body();
    if (link.dataset.tab === 'analysis') load_analysis();
  });
});

// ─── Modal ────────────────────────────────────────────────────────────────
const modal = document.getElementById('modal');

// Focus the first usable field so the keyboard always has a valid target.
// Guards against the Chrome <dialog> focus-trap bug where focus is left on a
// removed/closed element and printable keys stop registering in inputs.
function _focus_first_field(container) {
  const el = container.querySelector(
    'input:not([type=hidden]):not([readonly]):not(:disabled), select, textarea'
  );
  if (el) el.focus();
}

function open_modal(title, body_html, on_submit) {
  if (modal.open) modal.close();   // never call showModal() on an open dialog
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = body_html;

  const form = body.querySelector('form');
  if (form && on_submit) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(form));
        form.querySelectorAll('input[type=checkbox]').forEach(cb => { data[cb.name] = cb.checked; });
        await on_submit(data);
        modal.close();
      } catch (err) {
        alert('Fehler: ' + err.message);
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
        _focus_first_field(body);   // re-anchor focus after the alert
      }
    });
  }
  modal.showModal();
  _focus_first_field(body);
}

function close_modal() { modal.close(); }
// Outside-click does NOT close the modal — prevents accidental closure while selecting text.

// On close, drop the stale content: leaving the old form in the (hidden)
// dialog keeps duplicate IDs in the DOM and can hold focus on dead elements.
modal.addEventListener('close', () => {
  document.getElementById('modal-body').innerHTML = '';
});

// Second modal — used for pickers (e.g. recipe selection) opened ON TOP of the
// first modal. It has its own dialog element so it does not destroy the meal
// editor form underneath (which lives in #modal-body).
const modal2 = document.getElementById('modal2');

function open_modal2(title, body_html) {
  if (modal2.open) modal2.close();
  document.getElementById('modal2-title').textContent = title;
  const body2 = document.getElementById('modal2-body');
  body2.innerHTML = body_html;
  modal2.showModal();
  _focus_first_field(body2);
}

function close_modal2() { modal2.close(); }

modal2.addEventListener('close', () => {
  document.getElementById('modal2-body').innerHTML = '';
  // Hand focus back to the underlying editor dialog if it is still open.
  if (modal.open) _focus_first_field(document.getElementById('modal-body'));
});

// ─── Form templates ───────────────────────────────────────────────────────

function tpl_workout_session(date = '', comment = '') {
  return `<form>
    <label>Datum<input type="date" name="date" value="${esc(date)}" required></label>
    <label>Kommentar (optional)<input type="text" name="comment" value="${esc(comment)}"></label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function tpl_exercise(ex = null) {
  const unit = ex ? pick_weight_unit(ex) : 'kg';
  const weight_val = ex
    ? (unit === 'lbs' ? esc(weight_to_input(ex.weight_lbs)) : esc(weight_to_input(ex.weight_kg)))
    : '';
  return `<form>
    <label>Übung
      <input type="text" name="exercise_name" list="exercises-datalist"
             value="${ex ? esc(ex.exercise_name) : ''}"
             placeholder="z.B. Bankdrücken" required>
    </label>
    <div class="grid">
      <label>Sätze
        <input type="number" name="sets" value="${ex ? ex.sets : ''}" min="1" max="50" required>
      </label>
      <label>Wiederholungen
        <input type="text" name="reps_str"
               value="${ex ? esc(reps_to_input(ex.reps_per_set)) : ''}"
               placeholder="8  oder  8,8,7,6" required>
      </label>
    </div>
    <label>Gewicht &mdash; leer = Bodyweight</label>
    <div style="display:flex; gap:.5rem; align-items:center; margin-bottom:1rem">
      <input type="text" name="weight_str" value="${weight_val}"
             placeholder="100  oder  100,102.5,105,100"
             style="flex:1; width:auto; margin:0">
      <select name="weight_unit" style="width:5.5rem; flex-shrink:0; margin:0">
        <option value="kg"  ${unit === 'kg'  ? 'selected' : ''}>kg</option>
        <option value="lbs" ${unit === 'lbs' ? 'selected' : ''}>lbs</option>
      </select>
    </div>
    <label>Kommentar (optional)
      <input type="text" name="comment" value="${ex ? esc(ex.comment || '') : ''}">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function tpl_endurance(s = null, default_type = 'run') {
  const type = s ? s.activity_type : default_type;
  return `<form>
    <div class="grid">
      <label>Datum<input type="date" name="date" value="${s ? esc(s.date) : ''}" required></label>
      <label>Typ
        <select name="activity_type">
          <option value="run"  ${type === 'run'  ? 'selected' : ''}>🏃 Lauf</option>
          <option value="ride" ${type === 'ride' ? 'selected' : ''}>🚴 Radfahrt</option>
        </select>
      </label>
    </div>
    <div class="grid">
      <label>Distanz (km)
        <input type="number" name="distance_km" step="0.01" min="0"
               value="${s && s.distance_km != null ? s.distance_km : ''}">
      </label>
      <label>Zeit (h:mm:ss)
        <input type="text" name="duration_str" placeholder="0:45:00"
               value="${s ? duration_to_input(s.duration_s) : ''}">
      </label>
    </div>
    <div class="grid">
      <label>Höhenmeter (m)
        <input type="number" name="elevation_m" step="1" min="0"
               value="${s && s.elevation_m != null ? s.elevation_m : ''}">
      </label>
      <label>Ø Herzfrequenz (bpm)
        <input type="number" name="avg_hr" step="1" min="0"
               value="${s && s.avg_hr != null ? s.avg_hr : ''}">
      </label>
    </div>
    <label>kcal
      <input type="number" name="kcal" step="1" min="0"
             value="${s && s.kcal != null ? s.kcal : ''}">
    </label>
    <label>Kommentar (optional)
      <input type="text" name="comment" value="${s ? esc(s.comment || '') : ''}">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function tpl_sport(s = null) {
  return `<form>
    <div class="grid">
      <label>Datum<input type="date" name="date" value="${s ? esc(s.date) : ''}" required></label>
      <label>Sportart
        <input type="text" name="sport_name" value="${s ? esc(s.sport_name) : ''}"
               placeholder="z.B. Fußball" required>
      </label>
    </div>
    <div class="grid">
      <label>Zeit (h:mm:ss)
        <input type="text" name="duration_str" placeholder="1:30:00"
               value="${s ? duration_to_input(s.duration_s) : ''}">
      </label>
      <label>Ø Herzfrequenz (bpm)
        <input type="number" name="avg_hr" step="1" min="0"
               value="${s && s.avg_hr != null ? s.avg_hr : ''}">
      </label>
    </div>
    <label>kcal
      <input type="number" name="kcal" step="1" min="0"
             value="${s && s.kcal != null ? s.kcal : ''}">
    </label>
    <label>Kommentar (optional)
      <input type="text" name="comment" value="${s ? esc(s.comment || '') : ''}">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

// ─── Activities — combined render ─────────────────────────────────────────

function render_activities() {
  const el = document.getElementById('activities-list');
  // Merge all three types, sort newest first
  const all = [
    ...workouts.map(s  => ({...s, _type: 'workout'})),
    ...endurance.map(s => ({...s, _type: 'endurance'})),
    ...sports.map(s    => ({...s, _type: 'sport'})),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  if (!all.length) {
    el.innerHTML = '<p class="empty">Noch keine Aktivitäten vorhanden.</p>';
    return;
  }
  el.innerHTML = all.map(item => {
    if (item._type === 'workout')   return _workout_card(item);
    if (item._type === 'endurance') return _endurance_card(item);
    return _sport_card(item);
  }).join('');
}

function _workout_card(s) {
  return `
  <article>
    <header>
      <div class="session-header">
        <span>
          <span class="activity-badge badge-workout">💪 Kraft</span>
          <strong>${esc(s.date)}</strong>
          ${s.comment ? `<small style="margin-left:.5rem">${esc(s.comment)}</small>` : ''}
          <small style="margin-left:.5rem;color:var(--pico-muted-color)">
            (${s.exercises.length} Übung${s.exercises.length !== 1 ? 'en' : ''})
          </small>
        </span>
        <div>
          <button class="outline secondary" title="Kopieren" onclick="copy_workout(${s.id})">&#10064;</button>
          <button class="outline secondary" onclick="open_edit_workout(${s.id})">Bearbeiten</button>
          <button class="outline contrast"  onclick="del_workout(${s.id})">Löschen</button>
        </div>
      </div>
    </header>

    ${s.exercises.length ? `
    <figure>
      <table>
        <thead>
          <tr><th></th><th>Übung</th><th>Sätze</th><th>Reps</th><th>Gewicht</th><th>Kommentar</th><th></th></tr>
        </thead>
        <tbody>
          ${s.exercises.map((ex, idx) => `
          <tr>
            <td class="reorder-col">
              <button class="reorder-btn" title="Nach oben"
                      ${idx === 0 ? 'disabled' : ''}
                      onclick="move_exercise(${s.id}, ${ex.id}, -1)">▲</button>
              <button class="reorder-btn" title="Nach unten"
                      ${idx === s.exercises.length - 1 ? 'disabled' : ''}
                      onclick="move_exercise(${s.id}, ${ex.id}, 1)">▼</button>
            </td>
            <td>${esc(ex.exercise_name)}</td>
            <td>${ex.sets}</td>
            <td>${fmt_reps(ex.reps_per_set)}</td>
            <td>${fmt_weight(ex.weight_kg, ex.weight_lbs)}</td>
            <td>${esc(ex.comment || '')}</td>
            <td class="row-actions">
              <button class="outline secondary" title="Kopieren" onclick="copy_exercise(${ex.id},${s.id})">&#10064;</button>
              <button class="outline secondary" onclick="open_edit_exercise(${ex.id})">&#9998;</button>
              <button class="outline contrast"  onclick="del_exercise(${ex.id})">&#10005;</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </figure>` : `<p class="empty">Noch keine Übungen.</p>`}

    <footer>
      <button class="secondary outline" onclick="open_add_exercise(${s.id})">+ Übung hinzufügen</button>
    </footer>
  </article>`;
}

function _endurance_card(s) {
  const is_run        = s.activity_type === 'run';
  const label         = is_run ? '🏃 Lauf' : '🚴 Radfahrt';
  const derived       = is_run ? fmt_pace(s.distance_km, s.duration_s) : fmt_speed(s.distance_km, s.duration_s);
  const derived_label = is_run ? 'Pace' : 'Tempo';
  return `
  <article>
    <header>
      <div class="session-header">
        <span>
          <span class="activity-badge badge-endurance">${label}</span>
          <strong>${esc(s.date)}</strong>
        </span>
        <div>
          <button class="outline secondary" onclick="open_edit_endurance(${s.id})">Bearbeiten</button>
          <button class="outline contrast"  onclick="del_endurance(${s.id})">Löschen</button>
        </div>
      </div>
    </header>
    <figure>
      <table>
        <tbody>
          <tr>
            <th>Distanz</th><th>Zeit</th><th>${derived_label}</th>
            <th>Höhenmeter</th><th>Ø HR</th><th>kcal</th><th>Kommentar</th>
          </tr>
          <tr>
            <td>${opt(s.distance_km, ' km')}</td>
            <td>${fmt_duration(s.duration_s)}</td>
            <td>${derived}</td>
            <td>${opt(s.elevation_m, ' m')}</td>
            <td>${opt(s.avg_hr, ' bpm')}</td>
            <td>${opt(s.kcal)}</td>
            <td>${s.comment ? esc(s.comment) : '---'}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  </article>`;
}

function _sport_card(s) {
  return `
  <article>
    <header>
      <div class="session-header">
        <span>
          <span class="activity-badge badge-sport">⚽ Sport</span>
          <strong>${esc(s.date)}</strong>
          &middot; <em>${esc(s.sport_name)}</em>
        </span>
        <div>
          <button class="outline secondary" onclick="open_edit_sport(${s.id})">Bearbeiten</button>
          <button class="outline contrast"  onclick="del_sport(${s.id})">Löschen</button>
        </div>
      </div>
    </header>
    <figure>
      <table>
        <tbody>
          <tr><th>Zeit</th><th>Ø HR</th><th>kcal</th><th>Kommentar</th></tr>
          <tr>
            <td>${fmt_duration(s.duration_s)}</td>
            <td>${opt(s.avg_hr, ' bpm')}</td>
            <td>${opt(s.kcal)}</td>
            <td>${s.comment ? esc(s.comment) : '---'}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  </article>`;
}

// Type picker — opens first, then the specific form via setTimeout so the
// dialog is fully closed before re-opening (required for <dialog> element).
function open_new_activity() {
  open_modal('Neue Aktivität', `
    <p style="margin-bottom:1rem">Welche Art von Aktivität?</p>
    <div style="display:flex; flex-direction:column; gap:.5rem">
      <button onclick="close_modal(); setTimeout(open_new_workout, 0)">💪 Kraft-Training</button>
      <button onclick="close_modal(); setTimeout(() => open_new_endurance('run'),  0)">🏃 Lauf</button>
      <button onclick="close_modal(); setTimeout(() => open_new_endurance('ride'), 0)">🚴 Radfahrt</button>
      <button onclick="close_modal(); setTimeout(open_new_sport, 0)">⚽ Hobby-Sport</button>
    </div>
    <div class="form-footer" style="margin-top:1rem">
      <button class="secondary outline" onclick="close_modal()">Abbrechen</button>
    </div>
  `);
}

// ─── Workouts ─────────────────────────────────────────────────────────────

async function load_workouts() {
  try {
    workouts = await api('GET', '/api/workouts');
    render_activities();
  } catch (err) {
    document.getElementById('activities-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden der Workouts: ${esc(err.message)}</p>`;
  }
}

function open_new_workout() {
  const today = new Date().toISOString().slice(0, 10);
  open_modal('Neue Kraft-Session', tpl_workout_session(today), async data => {
    await api('POST', '/api/workouts', { date: data.date, comment: data.comment || null });
    await load_workouts();
  });
}

function open_edit_workout(session_id) {
  const s = workouts.find(w => w.id === session_id);
  if (!s) return;
  open_modal('Session bearbeiten', tpl_workout_session(s.date, s.comment || ''), async data => {
    await api('PUT', `/api/workouts/${session_id}`, { date: data.date, comment: data.comment || null });
    await load_workouts();
  });
}

async function del_workout(session_id) {
  const s = workouts.find(w => w.id === session_id);
  if (!s) return;
  if (!confirm(`Session vom ${s.date} und alle ${s.exercises.length} Übung(en) löschen?`)) return;
  await api('DELETE', `/api/workouts/${session_id}`);
  await load_workouts();
}

function copy_workout(session_id) {
  const today = new Date().toISOString().slice(0, 10);
  open_modal('Workout kopieren', `
    <label>Datum
      <input type="date" id="copy-date" value="${today}">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" onclick="do_copy_workout(${session_id})">Kopieren</button>
    </div>
  `);
}

// Build the exercise POST payload preserving the unit the weights were
// originally entered in (otherwise a kg round-trip makes lbs values uneven).
function _exercise_copy_payload(ex) {
  const unit = pick_weight_unit(ex);
  const raw  = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
  const w    = raw ? JSON.parse(raw) : null;
  return {
    exercise_name: ex.exercise_name,
    sets:          ex.sets,
    reps_str:      JSON.parse(ex.reps_per_set).join(','),
    weight_str:    w ? w.join(',') : null,
    weight_unit:   unit,
    comment:       ex.comment || null,
  };
}

async function do_copy_workout(session_id) {
  const s = workouts.find(w => w.id === session_id);
  if (!s) return;
  const date = document.getElementById('copy-date').value;
  if (!date) return;
  close_modal();
  try {
    const { id: new_id } = await api('POST', '/api/workouts', { date, comment: s.comment || null });
    for (const ex of s.exercises) {
      await api('POST', `/api/workouts/${new_id}/exercises`, _exercise_copy_payload(ex));
    }
    await load_workouts();
  } catch (err) {
    alert('Fehler beim Kopieren: ' + err.message);
  }
}

function copy_exercise(exercise_id, session_id) {
  const s  = workouts.find(w => w.id === session_id);
  const ex = s?.exercises.find(e => e.id === exercise_id);
  if (!ex) return;
  const sorted = [...workouts].sort((a, b) => b.date.localeCompare(a.date));
  const opts = sorted.map(w =>
    `<option value="${w.id}" ${w.id === session_id ? 'selected' : ''}>${esc(w.date)}${w.comment ? ' — ' + esc(w.comment) : ''} (${w.exercises.length} Übungen)</option>`
  ).join('');
  open_modal(`Übung kopieren: ${esc(ex.exercise_name)}`, `
    <label>Ziel-Workout
      <select id="copy-ex-target">${opts}</select>
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" onclick="do_copy_exercise(${exercise_id},${session_id})">Kopieren</button>
    </div>
  `);
}

async function do_copy_exercise(exercise_id, session_id) {
  const s  = workouts.find(w => w.id === session_id);
  const ex = s?.exercises.find(e => e.id === exercise_id);
  if (!ex) return;
  const target_id = parseInt(document.getElementById('copy-ex-target').value);
  close_modal();
  try {
    await api('POST', `/api/workouts/${target_id}/exercises`, _exercise_copy_payload(ex));
    await load_workouts();
  } catch (err) {
    alert('Fehler beim Kopieren: ' + err.message);
  }
}

async function open_add_exercise(session_id) {
  await ensure_exercises_loaded();
  open_modal('Übung hinzufügen', tpl_exercise(), async data => {
    await api('POST', `/api/workouts/${session_id}/exercises`, data);
    await load_workouts();
    await load_exercise_catalog();
  });
}

async function open_edit_exercise(exercise_id) {
  await ensure_exercises_loaded();
  const found = find_exercise(exercise_id);
  if (!found) return;
  open_modal('Übung bearbeiten', tpl_exercise(found.exercise), async data => {
    await api('PUT', `/api/exercises/${exercise_id}`, data);
    await load_workouts();
    await load_exercise_catalog();
  });
}

async function del_exercise(exercise_id) {
  const found = find_exercise(exercise_id);
  if (!found) return;
  if (!confirm(`"${found.exercise.exercise_name}" löschen?`)) return;
  await api('DELETE', `/api/exercises/${exercise_id}`);
  await load_workouts();
}

async function move_exercise(session_id, exercise_id, dir) {
  const s = workouts.find(w => w.id === session_id);
  if (!s) return;
  const idx     = s.exercises.findIndex(e => e.id === exercise_id);
  const new_idx = idx + dir;
  if (new_idx < 0 || new_idx >= s.exercises.length) return;
  [s.exercises[idx], s.exercises[new_idx]] = [s.exercises[new_idx], s.exercises[idx]];
  render_activities();
  try {
    await api('PUT', `/api/workouts/${session_id}/exercises/reorder`,
              { ids: s.exercises.map(e => e.id) });
  } catch (err) {
    alert('Fehler beim Umsortieren: ' + err.message);
    await load_workouts();
  }
}

// ─── Export ───────────────────────────────────────────────────────────────

function open_export_workouts() {
  if (!workouts.length) { alert('Noch keine Workouts zum Exportieren vorhanden.'); return; }
  const dates = workouts.map(w => w.date).sort();
  const min = dates[0], max = dates[dates.length - 1];
  open_modal('Workout-Historie exportieren', `
    <fieldset>
      <label><input type="radio" name="exp-range" value="all" checked onchange="_toggle_export_dates()"> Gesamte Historie</label>
      <label><input type="radio" name="exp-range" value="range" onchange="_toggle_export_dates()"> Zeitraum</label>
    </fieldset>
    <div id="exp-dates" hidden class="grid">
      <label>Von<input type="date" id="exp-from" value="${min}"></label>
      <label>Bis<input type="date" id="exp-to"   value="${max}"></label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" onclick="do_export_workouts()">Als CSV herunterladen</button>
    </div>
  `);
}

function _toggle_export_dates() {
  const range = document.querySelector('input[name="exp-range"]:checked').value;
  document.getElementById('exp-dates').hidden = (range !== 'range');
}

function _csv_cell(v) {
  const s = (v ?? '').toString();
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function do_export_workouts() {
  const range = document.querySelector('input[name="exp-range"]:checked').value;
  let list = [...workouts];
  let from = '', to = '';
  if (range === 'range') {
    from = document.getElementById('exp-from').value;
    to   = document.getElementById('exp-to').value;
    if (!from || !to) { alert('Bitte Von- und Bis-Datum wählen.'); return; }
    if (from > to) [from, to] = [to, from];
    list = list.filter(w => w.date >= from && w.date <= to);
  }
  if (!list.length) { alert('Keine Workouts im gewählten Zeitraum.'); return; }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const rows = [[
    'Datum', 'Session-Kommentar', 'Übung', 'Sätze',
    'Wiederholungen', 'Gewicht (kg)', 'Gewicht (lbs)', 'Übungs-Kommentar',
  ]];
  const join_w = raw => raw
    ? JSON.parse(raw).map(v => v == null ? 'BW' : v).join(' ')
    : 'BW';
  for (const s of list) {
    if (!s.exercises.length) {
      rows.push([s.date, s.comment || '', '', '', '', '', '', '']);
      continue;
    }
    for (const ex of s.exercises) {
      rows.push([
        s.date,
        s.comment || '',
        ex.exercise_name,
        ex.sets,
        JSON.parse(ex.reps_per_set).join(' '),
        join_w(ex.weight_kg),
        ex.weight_lbs ? JSON.parse(ex.weight_lbs).map(v => v == null ? 'BW' : v).join(' ') : '',
        ex.comment || '',
      ]);
    }
  }
  // Leading BOM so Excel reads UTF-8 (umlauts) correctly.
  const csv = '﻿' + rows.map(r => r.map(_csv_cell).join(',')).join('\r\n');
  const fname = range === 'range'
    ? `workouts_${from}_bis_${to}.csv`
    : 'workouts_alle.csv';
  _download(fname, csv, 'text/csv;charset=utf-8');
  close_modal();
}

function _download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Endurance ────────────────────────────────────────────────────────────

async function load_endurance() {
  try {
    endurance = await api('GET', '/api/endurance');
    render_activities();
  } catch (err) {
    document.getElementById('activities-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden der Ausdauer-Daten: ${esc(err.message)}</p>`;
  }
}

function _parse_endurance_form(data) {
  return {
    date:          data.date,
    activity_type: data.activity_type,
    distance_km:   data.distance_km ? parseFloat(data.distance_km) : null,
    duration_s:    parse_duration(data.duration_str),
    elevation_m:   data.elevation_m ? parseFloat(data.elevation_m) : null,
    avg_hr:        data.avg_hr      ? parseInt(data.avg_hr)         : null,
    kcal:          data.kcal        ? parseFloat(data.kcal)         : null,
    comment:       data.comment     || null,
  };
}

function open_new_endurance(default_type = 'run') {
  const title = default_type === 'run' ? 'Neuer Lauf' : 'Neue Radfahrt';
  open_modal(title, tpl_endurance(null, default_type), async data => {
    await api('POST', '/api/endurance', _parse_endurance_form(data));
    await load_endurance();
  });
}

function open_edit_endurance(id) {
  const s = endurance.find(e => e.id === id);
  if (!s) return;
  open_modal('Aktivität bearbeiten', tpl_endurance(s), async data => {
    await api('PUT', `/api/endurance/${id}`, _parse_endurance_form(data));
    await load_endurance();
  });
}

async function del_endurance(id) {
  const s = endurance.find(e => e.id === id);
  if (!s) return;
  const label = s.activity_type === 'run' ? 'Lauf' : 'Radfahrt';
  if (!confirm(`${label} vom ${s.date} löschen?`)) return;
  await api('DELETE', `/api/endurance/${id}`);
  await load_endurance();
}

// ─── Sport ────────────────────────────────────────────────────────────────

async function load_sports() {
  try {
    sports = await api('GET', '/api/sports');
    render_activities();
  } catch (err) {
    document.getElementById('activities-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden der Sport-Daten: ${esc(err.message)}</p>`;
  }
}

function _parse_sport_form(data) {
  return {
    date:       data.date,
    sport_name: data.sport_name,
    duration_s: parse_duration(data.duration_str),
    avg_hr:     data.avg_hr ? parseInt(data.avg_hr)   : null,
    kcal:       data.kcal   ? parseFloat(data.kcal)   : null,
    comment:    data.comment || null,
  };
}

function open_new_sport() {
  open_modal('Neue Sport-Aktivität', tpl_sport(), async data => {
    await api('POST', '/api/sports', _parse_sport_form(data));
    await load_sports();
  });
}

function open_edit_sport(id) {
  const s = sports.find(sp => sp.id === id);
  if (!s) return;
  open_modal('Sport bearbeiten', tpl_sport(s), async data => {
    await api('PUT', `/api/sports/${id}`, _parse_sport_form(data));
    await load_sports();
  });
}

async function del_sport(id) {
  const s = sports.find(sp => sp.id === id);
  if (!s) return;
  if (!confirm(`"${s.sport_name}" vom ${s.date} löschen?`)) return;
  await api('DELETE', `/api/sports/${id}`);
  await load_sports();
}

// ─── Meals ────────────────────────────────────────────────────────────────

async function load_meals() {
  try {
    meals = await api('GET', '/api/meals');
    render_meals();
  } catch (err) {
    document.getElementById('meals-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden: ${esc(err.message)}</p>`;
  }
}

async function load_foods_db() {
  try {
    foods_db = await api('GET', '/api/foods');
    _update_foods_datalist();
    render_foods_db();
  } catch (err) {
    document.getElementById('foods-db-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden: ${esc(err.message)}</p>`;
  }
}

async function ensure_foods_loaded() {
  if (!foods_db.length) await load_foods_db();
}

function _update_foods_datalist() {
  let dl = document.getElementById('foods-datalist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'foods-datalist';
    document.body.appendChild(dl);
  }
  dl.innerHTML = foods_db.map(f => `<option value="${esc(f.name)}">`).join('');
}

async function load_exercise_catalog() {
  exercise_catalog = await api('GET', '/api/exercise-catalog');
  _update_exercises_datalist();
  render_exercises_db();
}

async function ensure_exercises_loaded() {
  if (!exercise_catalog.length) await load_exercise_catalog();
}

function _update_exercises_datalist() {
  let dl = document.getElementById('exercises-datalist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'exercises-datalist';
    document.body.appendChild(dl);
  }
  dl.innerHTML = exercise_catalog.map(e => `<option value="${esc(e.name)}">`).join('');
}

function _food_lookup(name) {
  return foods_db.find(f => f.name.toLowerCase() === name.trim().toLowerCase()) || null;
}

function _set_macros_readonly(row, readonly) {
  ['kcal', 'protein_g', 'carbs_g', 'fat_g'].forEach(name => {
    const inp = row.querySelector(`[name="${name}"]`);
    if (!inp) return;
    inp.readOnly = readonly;
    inp.classList.toggle('macro-auto', readonly);
  });
}

function on_food_name_change(input) {
  const food  = _food_lookup(input.value);
  const row   = input.closest('tr');
  const badge = row.querySelector('.food-badge');
  const unit_sel = row.querySelector('[name="unit"]');
  if (food) {
    row.dataset.per100kcal    = food.kcal_per_100g;
    row.dataset.per100protein = food.protein_per_100g;
    row.dataset.per100carbs   = food.carbs_per_100g;
    row.dataset.per100fat     = food.fat_per_100g;
    if (food.unit_grams) row.dataset.unitGrams = food.unit_grams;
    else delete row.dataset.unitGrams;
    if (unit_sel) {
      // Preselect the food's own unit — for foods like eggs "2 Stk." is the
      // natural entry; grams remain one click away.
      const prefer = (food.unit_name && food.unit_grams) ? food.unit_name : 'g';
      unit_sel.innerHTML = _unit_options_html(food, prefer);
    }
    if (badge) { badge.className = 'food-badge match'; badge.textContent = '✓'; }
    _set_macros_readonly(row, true);
    const g = _row_grams(row);
    if (!isNaN(g) && g > 0) _recalc_macros(row, g);
  } else {
    delete row.dataset.per100kcal;
    delete row.dataset.unitGrams;
    if (unit_sel) unit_sel.innerHTML = _unit_options_html(null, 'g');
    _set_macros_readonly(row, false);
    if (badge) {
      badge.className = 'food-badge' + (input.value.trim() ? ' new' : '');
      badge.textContent = input.value.trim() ? 'neu' : '';
    }
  }
}

function on_amount_change(input) {
  const row = input.closest('tr');
  const g   = _row_grams(row);
  if (!isNaN(g) && g > 0 && row.dataset.per100kcal !== undefined) {
    _recalc_macros(row, g);
  }
}

function _recalc_macros(row, amount_grams) {
  const f = amount_grams / 100;
  row.querySelector('[name="kcal"]').value      = (parseFloat(row.dataset.per100kcal)    * f).toFixed(1);
  row.querySelector('[name="protein_g"]').value = (parseFloat(row.dataset.per100protein) * f).toFixed(1);
  row.querySelector('[name="carbs_g"]').value   = (parseFloat(row.dataset.per100carbs)   * f).toFixed(1);
  row.querySelector('[name="fat_g"]').value     = (parseFloat(row.dataset.per100fat)     * f).toFixed(1);
}

function switch_acts_tab(btn) {
  document.querySelectorAll('[data-acts-tab]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.actsTab;
  document.getElementById('acts-subtab-history').hidden   = (tab !== 'history');
  document.getElementById('acts-subtab-exercises').hidden = (tab !== 'exercises');
  document.getElementById('activities-add-btn').hidden    = (tab !== 'history');
  document.getElementById('activities-export-btn').hidden = (tab !== 'history');
  if (tab === 'exercises') load_exercise_catalog();
}

// Convert bare URLs in a (already plain) string into clickable links.
function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function render_exercises_db() {
  const el = document.getElementById('exercises-db-list');
  if (!el) return;
  const add_btn = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
    <button onclick="open_new_exercise_db()" style="width:auto;margin:0">+ Neue Übung</button>
  </div>`;
  if (!exercise_catalog.length) {
    el.innerHTML = add_btn + '<p class="empty">Keine Übungen in der Datenbank.</p>';
    return;
  }
  const sorted = [...exercise_catalog].sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr><th>Übung</th><th>Kommentar</th><th></th></tr></thead>
    <tbody>${sorted.map(e => `
      <tr>
        <td>${esc(e.name)}</td>
        <td style="white-space:pre-wrap">${e.comment ? linkify(e.comment) : '<span style="color:var(--pico-muted-color)">&ndash;</span>'}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_exercise_db(${e.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_exercise_db(${e.id})">&#10005;</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></figure>`;
}

function _exercise_db_modal_body(e) {
  const name    = e ? esc(e.name) : '';
  const comment = e ? esc(e.comment || '') : '';
  return `<div>
    <label>Übung
      <input type="text" id="exdb-name" value="${name}" placeholder="z.B. Bankdrücken" required>
    </label>
    <label>Kommentar (z.B. YouTube-Link, Technik-Hinweise)
      <textarea id="exdb-comment" rows="3" placeholder="https://youtu.be/...">${comment}</textarea>
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="exdb-save-btn" onclick="save_exercise_db(${e ? e.id : 'null'})">Speichern</button>
    </div>
  </div>`;
}

function open_new_exercise_db() {
  open_modal('Neue Übung', _exercise_db_modal_body(null), null);
}

function open_edit_exercise_db(exercise_id) {
  const e = exercise_catalog.find(x => x.id === exercise_id);
  if (!e) return;
  open_modal('Übung bearbeiten', _exercise_db_modal_body(e), null);
}

async function del_exercise_db(exercise_id) {
  const e = exercise_catalog.find(x => x.id === exercise_id);
  if (!e || !confirm(`Übung "${e.name}" aus der Datenbank löschen?`)) return;
  await api('DELETE', `/api/exercise-catalog/${exercise_id}`);
  await load_exercise_catalog();
}

async function save_exercise_db(exercise_id) {
  const name    = document.getElementById('exdb-name').value.trim();
  const comment = document.getElementById('exdb-comment').value.trim() || null;
  if (!name) { alert('Bitte Übungsname eingeben.'); return; }
  const btn = document.getElementById('exdb-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    if (exercise_id === null) {
      await api('POST', '/api/exercise-catalog', { name, comment });
    } else {
      await api('PUT', `/api/exercise-catalog/${exercise_id}`, { name, comment });
    }
    close_modal();
    await load_exercise_catalog();
  } catch (err) {
    alert('Fehler: ' + err.message);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

function switch_meals_tab(btn) {
  document.querySelectorAll('[data-meals-tab]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.mealsTab;
  document.getElementById('meals-subtab-diary').hidden   = (tab !== 'diary');
  document.getElementById('meals-subtab-foods').hidden   = (tab !== 'foods');
  document.getElementById('meals-subtab-recipes').hidden = (tab !== 'recipes');
  document.getElementById('meals-add-btn').hidden        = (tab !== 'diary');
  document.getElementById('meals-targets-btn').hidden    = (tab !== 'diary');
  if (tab === 'foods')   load_foods_db();
  if (tab === 'recipes') load_recipes();
}

// ─── Daily targets (Soll/Ist) ─────────────────────────────────────────────

let settings = {};

async function load_settings() {
  try { settings = await api('GET', '/api/settings'); } catch { settings = {}; }
}

function open_targets_modal() {
  open_modal('Tagesziele', `<form>
    <label>Kalorien-Limit (kcal/Tag)
      <input type="number" name="kcal_target" min="0" step="10"
             value="${esc(settings.kcal_target || '')}" placeholder="z.B. 2500 — leer = kein Ziel">
    </label>
    <label>Protein-Soll (g/Tag)
      <input type="number" name="protein_target" min="0" step="1"
             value="${esc(settings.protein_target || '')}" placeholder="z.B. 150 — leer = kein Ziel">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`, async data => {
    await api('PUT', '/api/settings', {
      kcal_target:    data.kcal_target    || null,
      protein_target: data.protein_target || null,
    });
    await load_settings();
    render_meals();
  });
}

// Soll/Ist balance row for one day. kcal is a LIMIT (over = bad), protein a
// GOAL (reached = good).
function _target_row_html(dk, dp) {
  const kcal_t = parseFloat(settings.kcal_target);
  const prot_t = parseFloat(settings.protein_target);
  if (isNaN(kcal_t) && isNaN(prot_t)) return '';
  let kcal_cell = '', prot_cell = '';
  if (!isNaN(kcal_t)) {
    const diff = Math.round(kcal_t - dk);
    const cls  = diff >= 0 ? 'target-ok' : 'target-over';
    kcal_cell  = `<span class="${cls}">${diff >= 0 ? diff + ' übrig' : (-diff) + ' drüber'}</span>
                  <small>/ ${Math.round(kcal_t)}</small>`;
  }
  if (!isNaN(prot_t)) {
    const diff = dp - prot_t;
    const cls  = diff >= 0 ? 'target-ok' : 'target-under';
    prot_cell  = `<span class="${cls}">${diff >= 0 ? 'erreicht ✓' : (-diff).toFixed(0) + 'g fehlen'}</span>
                  <small>/ ${Math.round(prot_t)}g</small>`;
  }
  return `<tr class="target-row">
    <td></td>
    <td>Bilanz (Soll)</td>
    <td>${kcal_cell}</td>
    <td>${prot_cell}</td>
    <td></td><td></td><td></td>
  </tr>`;
}

function render_meals() {
  const el = document.getElementById('meals-list');
  if (!meals.length) {
    el.innerHTML = '<p class="empty">Noch keine Mahlzeiten vorhanden.</p>';
    return;
  }
  // Group by date, newest first
  const by_date = {};
  for (const s of meals) (by_date[s.date] = by_date[s.date] || []).push(s);
  const dates = Object.keys(by_date).sort((a, b) => b.localeCompare(a));
  el.innerHTML = dates.map(date => {
    const ss = by_date[date];
    const dk = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.kcal,      0), 0);
    const dp = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.protein_g, 0), 0);
    const dc = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.carbs_g,   0), 0);
    const df = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.fat_g,     0), 0);
    return `
    <article>
      <header>
        <div class="session-header">
          <strong>${esc(date)}</strong>
          <span class="day-macros">${Math.round(dk)}&thinsp;kcal &nbsp;·&nbsp; ${dp.toFixed(1)}g P &nbsp;·&nbsp; ${dc.toFixed(1)}g KH &nbsp;·&nbsp; ${df.toFixed(1)}g F</span>
          <button onclick="open_new_meal_for('${date}')">+ Mahlzeit</button>
        </div>
      </header>
      <figure>
        <table>
          <thead><tr><th></th><th>Mahlzeit</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th></tr></thead>
          <tbody>${ss.map((s, idx) => {
            const tk = s.items.reduce((a, i) => a + i.kcal,      0);
            const tp = s.items.reduce((a, i) => a + i.protein_g, 0);
            const tc = s.items.reduce((a, i) => a + i.carbs_g,   0);
            const tf = s.items.reduce((a, i) => a + i.fat_g,     0);
            return `<tr>
              <td class="reorder-col">
                <button class="reorder-btn" title="Nach oben"  ${idx === 0             ? 'disabled' : ''} onclick="move_meal_in_day(${s.id},'${date}',-1)">▲</button>
                <button class="reorder-btn" title="Nach unten" ${idx === ss.length - 1 ? 'disabled' : ''} onclick="move_meal_in_day(${s.id},'${date}', 1)">▼</button>
              </td>
              <td>${s.meal_name ? esc(s.meal_name) : (s.items[0] ? esc(s.items[0].food_name) : '&ndash;')}</td>
              <td>${Math.round(tk)}</td>
              <td>${tp.toFixed(1)}g</td>
              <td>${tc.toFixed(1)}g</td>
              <td>${tf.toFixed(1)}g</td>
              <td class="row-actions">
                <button class="outline secondary" title="Kopieren"   onclick="copy_meal(${s.id})">&#10064;</button>
                <button class="outline secondary" title="Bearbeiten" onclick="open_edit_meal(${s.id})">&#9998;</button>
                <button class="outline contrast"  title="Löschen"    onclick="del_meal(${s.id})">&#10005;</button>
              </td>
            </tr>`;
          }).join('')}</tbody>
          <tfoot><tr>
            <td></td>
            <td><strong>Gesamt</strong></td>
            <td><strong>${Math.round(dk)}</strong></td>
            <td><strong>${dp.toFixed(1)}g</strong></td>
            <td><strong>${dc.toFixed(1)}g</strong></td>
            <td><strong>${df.toFixed(1)}g</strong></td>
            <td></td>
          </tr>${_target_row_html(dk, dp)}</tfoot>
        </table>
      </figure>
    </article>`;
  }).join('');
}


function parse_factor(raw) {
  const s = raw.trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return a / b;
  }
  return parseFloat(s);
}


function render_foods_db() {
  const el = document.getElementById('foods-db-list');
  const add_btn = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
    <button onclick="open_new_food()" style="width:auto;margin:0">+ Neues Lebensmittel</button>
  </div>`;
  if (!foods_db.length) {
    el.innerHTML = add_btn + '<p class="empty">Keine Lebensmittel in der Datenbank.</p>';
    return;
  }
  const sorted = [...foods_db].sort((a, b) => a.name.localeCompare(b.name));
  const focus_badge = f => {
    if (!f.focus) return '';
    const label = { kcal: 'K', protein: 'P', beides: 'K+P' }[f.focus] || '';
    const title = { kcal: 'Kaloriensensitiv', protein: 'Proteinsensitiv', beides: 'Kalorien- & proteinsensitiv' }[f.focus] || '';
    return ` <span class="food-badge match" title="${title}">${label}</span>`;
  };
  const density_badge = f => f.energy_density === 'gering'
    ? ' <span class="food-badge skip" title="Geringe Energiedichte — grobe Schätzung">≈</span>' : '';
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr>
      <th>Lebensmittel</th><th>kcal/100g</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th>Einheit</th><th></th>
    </tr></thead>
    <tbody>${sorted.map(f => `
      <tr>
        <td>${esc(f.name)}${focus_badge(f)}${density_badge(f)}</td>
        <td>${f.kcal_per_100g.toFixed(1)}</td>
        <td>${f.protein_per_100g.toFixed(1)}g</td>
        <td>${f.carbs_per_100g.toFixed(1)}g</td>
        <td>${f.fat_per_100g.toFixed(1)}g</td>
        <td>${f.unit_name && f.unit_grams ? `${esc(f.unit_name)} = ${f.unit_grams} g` : '&ndash;'}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_food(${f.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_food(${f.id})">&#10005;</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></figure>`;
}

// ─── Recipes ──────────────────────────────────────────────────────────────

async function load_recipes() {
  // Recipe macros are computed from the foods DB, so make sure it's loaded
  // (it is otherwise lazy-loaded only when the Lebensmittel tab is opened).
  await ensure_foods_loaded();
  recipes = await api('GET', '/api/recipes');
  render_recipes();
}

function render_recipes() {
  const el = document.getElementById('recipes-list');
  if (!el) return;
  const add_btn = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
    <button onclick="open_new_recipe()" style="width:auto;margin:0">+ Neues Rezept</button>
  </div>`;
  if (!recipes.length) {
    el.innerHTML = add_btn + '<p class="empty">Noch keine Rezepte vorhanden.</p>';
    return;
  }
  const rows = recipes.map(r => {
    let tk = 0, tp = 0, tc = 0, tf = 0, total_g = 0;
    for (const item of r.items) {
      const food = _food_lookup(item.food_name);
      if (food) {
        const f = item.amount_grams / 100;
        tk += food.kcal_per_100g    * f;
        tp += food.protein_per_100g * f;
        tc += food.carbs_per_100g   * f;
        tf += food.fat_per_100g     * f;
      }
      total_g += item.amount_grams || 0;
    }
    // Ingredients visible directly on the overview page (expandable per recipe)
    const ing_list = r.items.map(i =>
      `<li>${i.amount_grams} g ${esc(i.food_name)}</li>`).join('');
    return `<tr>
      <td>
        <details class="recipe-details">
          <summary><strong>${esc(r.name)}</strong></summary>
          <ul class="recipe-ingredients">${ing_list || '<li>keine Zutaten</li>'}</ul>
        </details>
      </td>
      <td>${r.items.length} Zutat${r.items.length !== 1 ? 'en' : ''} (${Math.round(total_g)}&thinsp;g)</td>
      <td>${Math.round(tk)}&thinsp;kcal</td>
      <td>${tp.toFixed(1)}g P</td>
      <td>${tc.toFixed(1)}g KH</td>
      <td>${tf.toFixed(1)}g F</td>
      <td class="row-actions">
        <button class="outline secondary" onclick="open_edit_recipe(${r.id})">&#9998;</button>
        <button class="outline contrast"  onclick="del_recipe(${r.id})">&#10005;</button>
      </td>
    </tr>`;
  }).join('');
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr><th>Name</th><th>Zutaten</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></figure>`;
}

function _recipe_item_row_html(food_name = '', amount = '') {
  return `<tr>
    <td><input type="text" value="${esc(food_name)}" list="foods-datalist" placeholder="Lebensmittel"
               style="margin:0;min-width:8rem"></td>
    <td><input type="number" value="${amount}" step="0.1" min="0" placeholder="g"
               style="margin:0;width:5rem"></td>
    <td><button type="button" class="outline contrast"
                style="padding:.15rem .4rem;margin:0;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

function add_recipe_item_row() {
  document.getElementById('rm-items').insertAdjacentHTML('beforeend', _recipe_item_row_html());
  document.querySelector('#rm-items tr:last-child input').focus();
}

function _recipe_modal_body(r) {
  const name = r ? esc(r.name) : '';
  const rows = r ? r.items.map(i => _recipe_item_row_html(i.food_name, i.amount_grams)).join('') : '';
  return `<div>
    <label>Rezeptname<input type="text" id="rm-name" value="${name}" placeholder="z.B. Chili con Carne" required></label>
    <strong style="font-size:.9rem">Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr><th>Lebensmittel</th><th>Menge (g)</th><th></th></tr></thead>
        <tbody id="rm-items">${rows}</tbody>
      </table>
    </div>
    <button type="button" class="secondary outline"
            style="width:auto;font-size:.85rem;margin:.6rem 0 1rem"
            onclick="add_recipe_item_row()">+ Zutat hinzufügen</button>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="rm-save-btn" onclick="save_recipe(${r ? r.id : 'null'})">Speichern</button>
    </div>
  </div>`;
}

async function open_new_recipe() {
  await ensure_foods_loaded();
  open_modal('Neues Rezept', _recipe_modal_body(null), null);
}

async function open_edit_recipe(recipe_id) {
  await ensure_foods_loaded();
  const r = recipes.find(x => x.id === recipe_id);
  if (!r) return;
  open_modal('Rezept bearbeiten', _recipe_modal_body(r), null);
}

async function del_recipe(recipe_id) {
  const r = recipes.find(x => x.id === recipe_id);
  if (!r || !confirm(`Rezept "${r.name}" löschen?`)) return;
  await api('DELETE', `/api/recipes/${recipe_id}`);
  await load_recipes();
}

async function save_recipe(recipe_id) {
  const name = document.getElementById('rm-name').value.trim();
  if (!name) { alert('Bitte Rezeptname eingeben.'); return; }
  const rows = document.querySelectorAll('#rm-items tr');
  const items = [];
  for (const row of rows) {
    const food = row.cells[0].querySelector('input').value.trim();
    const grams = parseFloat(row.cells[1].querySelector('input').value);
    if (!food || isNaN(grams) || grams <= 0) continue;
    items.push({ food_name: food, amount_grams: grams });
  }
  const btn = document.getElementById('rm-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    if (recipe_id === null) {
      await api('POST', '/api/recipes', { name, items });
    } else {
      await api('PUT', `/api/recipes/${recipe_id}`, { name, items });
    }
    close_modal();
    await load_recipes();
  } catch (err) {
    alert('Fehler: ' + err.message);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ─── Add recipe to meal ────────────────────────────────────────────────────

async function open_add_recipe_to_meal(preselect_id = null) {
  await ensure_foods_loaded();
  // Recipes are otherwise only loaded when the Rezepte tab is opened — fetch
  // fresh so "+ Rezept" works even if that tab was never visited this session.
  recipes = await api('GET', '/api/recipes');
  if (!recipes.length) {
    alert('Noch keine Rezepte vorhanden. Bitte zuerst ein Rezept anlegen.');
    return;
  }
  const opts = recipes.map(r => {
    const total_g = r.items.reduce((sum, i) => sum + (i.amount_grams || 0), 0);
    return `<option value="${r.id}" data-total="${total_g}" ${r.id === preselect_id ? 'selected' : ''}>${esc(r.name)} (${Math.round(total_g)}&thinsp;g gesamt)</option>`;
  }).join('');
  open_modal2('Rezept hinzufügen', `<div>
    <label>Rezept<select id="ra-select" onchange="update_recipe_add_hint()">${opts}</select></label>
    <label>Portion (g)
      <input type="number" id="ra-grams" step="1" min="1" placeholder="z.B. 300" autofocus>
      <small id="ra-hint" style="color:var(--pico-muted-color)"></small>
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal2()">Abbrechen</button>
      <button type="button" onclick="apply_recipe_to_meal()">Hinzufügen</button>
    </div>
  </div>`);
  update_recipe_add_hint();
}

function update_recipe_add_hint() {
  const sel  = document.getElementById('ra-select');
  const hint = document.getElementById('ra-hint');
  if (!sel || !hint) return;
  const total = parseFloat(sel.options[sel.selectedIndex]?.dataset.total) || 0;
  hint.textContent = total > 0 ? `Rezept gesamt: ${Math.round(total)} g` : '';
}

async function apply_recipe_to_meal() {
  await ensure_foods_loaded();
  const sel      = document.getElementById('ra-select');
  const recipe_id = parseInt(sel.value);
  const grams    = parseFloat(document.getElementById('ra-grams').value);
  if (isNaN(grams) || grams <= 0) { alert('Bitte Menge eingeben.'); return; }
  const r = recipes.find(x => x.id === recipe_id);
  if (!r) return;
  const total_g = r.items.reduce((sum, i) => sum + (i.amount_grams || 0), 0);
  if (total_g <= 0) { alert('Rezept hat keine Zutaten mit Gewicht.'); return; }
  const scale = grams / total_g;
  close_modal2();
  const round1 = v => Math.round(v * 10) / 10;
  for (const item of r.items) {
    const amount = round1(item.amount_grams * scale);
    const food = _food_lookup(item.food_name);
    let kcal = 0, protein = 0, carbs = 0, fat = 0;
    if (food) {
      const f = amount / 100;
      kcal    = round1(food.kcal_per_100g    * f);
      protein = round1(food.protein_per_100g * f);
      carbs   = round1(food.carbs_per_100g   * f);
      fat     = round1(food.fat_per_100g     * f);
    }
    add_em_item_row(item.food_name, amount, kcal, protein, carbs, fat);
  }
}


function _food_modal_body(f) {
  const name    = f ? esc(f.name)              : '';
  const kcal    = f ? f.kcal_per_100g    : '';
  const protein = f ? f.protein_per_100g : '';
  const carbs   = f ? f.carbs_per_100g   : '';
  const fat     = f ? f.fat_per_100g     : '';
  return `<form>
    <label>Name<input type="text" name="name" value="${name}" required></label>
    <label style="font-weight:600">Nährwerte je
      <input type="number" name="per_g" value="100" min="1" step="1"
             style="display:inline-block;width:5rem;margin:0 .4rem"
             oninput="update_per_g_label(this)">
      g <span id="per-g-hint" style="font-weight:normal;color:var(--pico-muted-color);font-size:.85rem"></span>
    </label>
    <div class="grid">
      <label>Energiedichte
        <select name="energy_density" onchange="on_density_change(this)">
          <option value="hoch"   ${!f || f.energy_density !== 'gering' ? 'selected' : ''}>Hoch — genaue Angaben</option>
          <option value="gering" ${f && f.energy_density === 'gering' ? 'selected' : ''}>Gering — grobe Schätzung reicht</option>
        </select>
      </label>
      <label>Fokus
        <select name="focus">
          <option value=""        ${!f || !f.focus ? 'selected' : ''}>—</option>
          <option value="kcal"    ${f && f.focus === 'kcal'    ? 'selected' : ''}>Kaloriensensitiv</option>
          <option value="protein" ${f && f.focus === 'protein' ? 'selected' : ''}>Proteinsensitiv</option>
          <option value="beides"  ${f && f.focus === 'beides'  ? 'selected' : ''}>Beides</option>
        </select>
      </label>
    </div>
    <div class="grid">
      <label>kcal<input type="number" name="kcal" step="0.01" value="${kcal}" required></label>
      <label>Eiweiß (g)<input type="number" name="protein" step="0.01" value="${protein}" required></label>
    </div>
    <div class="grid">
      <label>KH (g)<input type="number" name="carbs" step="0.01" value="${carbs}" required></label>
      <label>Fett (g)<input type="number" name="fat" step="0.01" value="${fat}" required></label>
    </div>
    <div class="grid">
      <label>Einheit (optional)
        <input type="text" name="unit_name" value="${f && f.unit_name ? esc(f.unit_name) : ''}"
               placeholder="z.B. Stk., Handvoll" list="units-datalist">
        <datalist id="units-datalist">
          <option value="Stk."><option value="Handvoll"><option value="EL"><option value="TL"><option value="Scheibe">
        </datalist>
      </label>
      <label>Gramm pro Einheit
        <input type="number" name="unit_grams" step="0.1" min="0"
               value="${f && f.unit_grams != null ? f.unit_grams : ''}" placeholder="z.B. 60">
      </label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function update_per_g_label(input) {
  const g = parseFloat(input.value);
  const hint = document.getElementById('per-g-hint');
  if (!hint) return;
  hint.textContent = (!isNaN(g) && g !== 100) ? `(wird auf 100g umgerechnet)` : '';
}

// Geringe Energiedichte → exact macros don't matter; grey the fields out
// (values are kept, just no longer meant to be fine-tuned).
function on_density_change(sel) {
  const form   = sel.closest('form');
  const gering = sel.value === 'gering';
  ['kcal', 'protein', 'carbs', 'fat'].forEach(n => {
    const inp = form.querySelector(`[name="${n}"]`);
    if (gering && inp.value === '') inp.value = 0;   // satisfy `required`
    inp.readOnly = gering;
    inp.classList.toggle('macro-auto', gering);
  });
}

function _food_macros_from_form(data) {
  const per_g  = parseFloat(data.per_g) || 100;
  const factor = 100 / per_g;
  const unit_name  = (data.unit_name || '').trim();
  const unit_grams = parseFloat(data.unit_grams);
  return {
    name:             data.name,
    kcal_per_100g:    parseFloat(data.kcal)    * factor,
    protein_per_100g: parseFloat(data.protein) * factor,
    carbs_per_100g:   parseFloat(data.carbs)   * factor,
    fat_per_100g:     parseFloat(data.fat)      * factor,
    unit_name:        unit_name && !isNaN(unit_grams) && unit_grams > 0 ? unit_name : null,
    unit_grams:       unit_name && !isNaN(unit_grams) && unit_grams > 0 ? unit_grams : null,
    energy_density:   data.energy_density || 'hoch',
    focus:            data.focus || null,
  };
}

function _init_density_state() {
  const sel = document.querySelector('#modal-body [name="energy_density"]');
  if (sel) on_density_change(sel);
}

function open_new_food() {
  open_modal('Neues Lebensmittel', _food_modal_body(null), async data => {
    await api('POST', '/api/foods', _food_macros_from_form(data));
    await load_foods_db();
  });
  _init_density_state();
}

function open_edit_food(food_id) {
  const f = foods_db.find(x => x.id === food_id);
  if (!f) return;
  open_modal('Lebensmittel bearbeiten', _food_modal_body(f), async data => {
    await api('PUT', `/api/foods/${food_id}`, _food_macros_from_form(data));
    await Promise.all([load_foods_db(), load_meals()]);
  });
  _init_density_state();
}

async function del_food(food_id) {
  const f = foods_db.find(x => x.id === food_id);
  if (!f || !confirm(`"${f.name}" aus der Datenbank löschen?`)) return;
  await api('DELETE', `/api/foods/${food_id}`);
  await load_foods_db();
}

function open_new_meal() {
  open_new_meal_for(new Date().toISOString().slice(0, 10));
}

// Suggestions for the meal-name field: standard meal labels + all recipe
// names. Picking a recipe name offers to pull in its ingredients directly.
const MEAL_NAME_SUGGESTIONS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];

function _mealname_datalist_html() {
  const recipe_opts = recipes.map(r => `<option value="${esc(r.name)}">`).join('');
  return `<datalist id="mealnames-datalist">
    ${MEAL_NAME_SUGGESTIONS.map(n => `<option value="${n}">`).join('')}
    ${recipe_opts}
  </datalist>`;
}

function on_meal_name_change(input) {
  const name = input.value.trim().toLowerCase();
  if (!name) return;
  const recipe = recipes.find(r => r.name.toLowerCase() === name);
  if (!recipe) return;
  // Only offer auto-fill while the ingredient list is still empty
  const tbody = document.getElementById('em-items');
  if (tbody && tbody.children.length === 0) open_add_recipe_to_meal(recipe.id);
}

async function open_new_meal_for(date) {
  await ensure_foods_loaded();
  try { recipes = await api('GET', '/api/recipes'); } catch { /* suggestions only */ }
  const import_options = meals.map(m => {
    const label = m.meal_name || (m.items[0] ? m.items[0].food_name : '?');
    return `<option value="${m.id}">${esc(label)} (${m.date})</option>`;
  }).join('');

  const body = `
    <div class="grid" style="column-gap:1rem">
      <label style="margin-bottom:.5rem">Datum
        <input type="date" id="em-date" value="${date}" required>
      </label>
      <label style="margin-bottom:.5rem">Name
        <input type="text" id="em-name" placeholder="z.B. Frühstück oder Rezeptname"
               list="mealnames-datalist" onchange="on_meal_name_change(this)">
      </label>
    </div>
    ${_mealname_datalist_html()}
    ${meals.length ? `
    <details style="margin-bottom:.75rem">
      <summary style="cursor:pointer;color:var(--pico-primary);font-size:.9rem;user-select:none">
        Zutaten aus vorhandener Mahlzeit importieren…
      </summary>
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.6rem">
        <select id="em-import-src" style="margin:0;flex:1;min-width:10rem">
          <option value="">— Mahlzeit wählen —</option>
          ${import_options}
        </select>
        <input type="text" id="em-import-factor" value="1" placeholder="z.B. 1/5"
               style="margin:0;width:6rem;font-family:monospace" title="Faktor (z.B. 1/5 oder 0.2)">
        <button type="button" class="secondary outline"
                style="margin:0;width:auto;white-space:nowrap"
                onclick="import_meal_rows()">Importieren</button>
      </div>
    </details>` : ''}
    <hr style="margin:.25rem 0 .75rem">
    <strong>Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr>
          <th>Lebensmittel</th><th>Menge</th><th>kcal</th>
          <th>Eiweiß</th><th>KH</th><th>Fett</th><th></th>
        </tr></thead>
        <tbody id="em-items"></tbody>
      </table>
    </div>
    <div style="display:flex;gap:.5rem;margin:.6rem 0 1rem;flex-wrap:wrap">
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="add_em_item_row()">+ Zutat</button>
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="open_add_recipe_to_meal()">+ Rezept</button>
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="add_em_skip_row()" title="Einmalige Mahlzeit — nicht in Lebensmitteldatenbank speichern">+ Einmalig</button>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="em-save-btn" onclick="save_new_meal()">Speichern</button>
    </div>`;

  open_modal('Neue Mahlzeit', body, null);
}

// Unit <select> options for a row: grams always, plus the food's serving
// unit (e.g. "Stk.") when one is defined in the foods DB.
function _unit_options_html(food, selected = 'g') {
  let opts = `<option value="g" ${selected === 'g' ? 'selected' : ''}>g</option>`;
  if (food && food.unit_name && food.unit_grams) {
    opts += `<option value="${esc(food.unit_name)}" ${selected === food.unit_name ? 'selected' : ''}>${esc(food.unit_name)}</option>`;
  }
  return opts;
}

// Amount of a row in grams, regardless of the unit it was entered in.
function _row_grams(row) {
  const val = parseFloat(row.querySelector('[name="amount_grams"]').value);
  if (isNaN(val)) return NaN;
  const unit = row.querySelector('[name="unit"]').value;
  if (unit === 'g') return val;
  const ug = parseFloat(row.dataset.unitGrams);
  return isNaN(ug) ? NaN : val * ug;
}

function on_unit_change(sel) {
  const row = sel.closest('tr');
  const g   = _row_grams(row);
  if (!isNaN(g) && g > 0 && row.dataset.per100kcal !== undefined) _recalc_macros(row, g);
}

function _item_row_html(item_id, food_name = '', amount = '', kcal = '', protein = '', carbs = '', fat = '', per100 = null, skip_db = false, unit = 'g') {
  const food = food_name ? _food_lookup(food_name) : null;
  const pa   = per100 ? ` data-per100kcal="${per100.kcal}" data-per100protein="${per100.protein}" data-per100carbs="${per100.carbs}" data-per100fat="${per100.fat}"` : '';
  const ug   = (food && food.unit_grams) ? ` data-unit-grams="${food.unit_grams}"` : '';
  const skip_attr  = skip_db ? ' data-skip-db="true"' : '';
  const badge_cls  = skip_db ? 'skip' : (per100 ? 'match' : (food_name ? 'new' : ''));
  const badge_text = skip_db ? 'einmalig' : (per100 ? '✓' : (food_name ? 'neu' : ''));
  return `<tr data-item-id="${item_id}"${pa}${ug}${skip_attr}>
    <td style="white-space:nowrap">
      <input type="text" name="food_name" value="${esc(food_name)}" placeholder="Lebensmittel" list="foods-datalist"
             onchange="on_food_name_change(this)" style="margin:0;min-width:8rem;display:inline-block;width:auto">
      <span class="food-badge ${badge_cls}">${badge_text}</span>
    </td>
    <td style="white-space:nowrap">
      <input type="number" name="amount_grams" value="${amount}" step="0.1" min="0" placeholder="Menge"
             oninput="on_amount_change(this)" style="margin:0;width:4.5rem;display:inline-block">
      <select name="unit" onchange="on_unit_change(this)"
              style="margin:0;width:auto;display:inline-block;padding:.2rem 1.4rem .2rem .4rem">${_unit_options_html(food, unit)}</select>
    </td>
    <td><input type="number" name="kcal"         value="${kcal}"     step="0.1" placeholder="kcal" style="margin:0;width:4.5rem" ${per100 ? 'readonly class="macro-auto"' : ''}></td>
    <td><input type="number" name="protein_g"    value="${protein}"  step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly class="macro-auto"' : ''}></td>
    <td><input type="number" name="carbs_g"      value="${carbs}"    step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly class="macro-auto"' : ''}></td>
    <td><input type="number" name="fat_g"        value="${fat}"      step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly class="macro-auto"' : ''}></td>
    <td><button type="button" class="outline contrast" style="margin:0;padding:.15rem .4rem;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

function add_em_item_row(food_name = '', amount = '', kcal = '', protein = '', carbs = '', fat = '') {
  const per100 = food_name ? _food_lookup(food_name) && {
    kcal:    _food_lookup(food_name).kcal_per_100g,
    protein: _food_lookup(food_name).protein_per_100g,
    carbs:   _food_lookup(food_name).carbs_per_100g,
    fat:     _food_lookup(food_name).fat_per_100g,
  } : null;
  const tbody = document.getElementById('em-items');
  tbody.insertAdjacentHTML('beforeend', _item_row_html('new', food_name, amount, kcal, protein, carbs, fat, per100));
  const row = tbody.lastElementChild;
  if (!food_name) row.querySelector('input').focus();
}

function add_em_skip_row() {
  const tbody = document.getElementById('em-items');
  tbody.insertAdjacentHTML('beforeend', _item_row_html('new', '', '', '', '', '', '', null, true));
  tbody.lastElementChild.querySelector('input').focus();
}

function import_meal_rows() {
  const sel_id = parseInt(document.getElementById('em-import-src').value);
  if (!sel_id) { alert('Bitte eine Mahlzeit auswählen.'); return; }
  const src = meals.find(m => m.id === sel_id);
  if (!src || !src.items.length) return;
  const factor = parse_factor(document.getElementById('em-import-factor').value);
  if (isNaN(factor) || factor <= 0) { alert('Ungültiger Faktor — z.B. 0.2 oder 1/5.'); return; }
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  src.items.forEach(item => {
    // Use DB per-100g if available; otherwise derive from source item values
    const food = _food_lookup(item.food_name);
    add_em_item_row(
      item.food_name,
      item.amount_grams != null ? round(item.amount_grams * factor, 1) : '',
      round(item.kcal      * factor, 1),
      round(item.protein_g * factor, 2),
      round(item.carbs_g   * factor, 2),
      round(item.fat_g     * factor, 2),
    );
    // Attach per-100g so changing amount auto-recalculates
    if (food) {
      const row = document.querySelector('#em-items tr:last-child');
      row.dataset.per100kcal    = food.kcal_per_100g;
      row.dataset.per100protein = food.protein_per_100g;
      row.dataset.per100carbs   = food.carbs_per_100g;
      row.dataset.per100fat     = food.fat_per_100g;
    }
  });
}

async function save_new_meal() {
  const date = document.getElementById('em-date').value;
  const name = document.getElementById('em-name').value.trim();
  if (!date) { alert('Datum fehlt.'); return; }

  const btn = document.getElementById('em-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const { id: session_id } = await api('POST', '/api/meals', {
      date, meal_name: name || null, comment: null,
    });
    const rows = Array.from(document.querySelectorAll('#em-items tr'));
    await Promise.all(rows.map(row => {
      const food_name = row.querySelector('[name="food_name"]').value.trim();
      if (!food_name) return null;
      const v = n => { const r = row.querySelector(`[name="${n}"]`).value; return r ? parseFloat(r) : 0; };
      const g = _row_grams(row);
      const unit = row.querySelector('[name="unit"]').value;
      const raw  = parseFloat(row.querySelector('[name="amount_grams"]').value);
      return api('POST', `/api/meals/${session_id}/items`, {
        food_name,
        amount_grams: isNaN(g) ? null : g,
        kcal: v('kcal'), protein_g: v('protein_g'), carbs_g: v('carbs_g'), fat_g: v('fat_g'),
        is_estimated: false, comment: null,
        skip_food_db: row.dataset.skipDb === 'true',
        amount_units: unit !== 'g' && !isNaN(raw) ? raw : null,
        unit_name:    unit !== 'g' && !isNaN(raw) ? unit : null,
      });
    }).filter(Boolean));
    modal.close();
    await load_meals();
  } catch (err) {
    alert('Fehler: ' + err.message);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

async function open_edit_meal(session_id) {
  await ensure_foods_loaded();
  const s = meals.find(m => m.id === session_id);
  if (!s) return;

  const body = `
    <div class="grid" style="column-gap:1rem">
      <label style="margin-bottom:.5rem">Datum
        <input type="date" id="em-date" value="${s.date}" required>
      </label>
      <label style="margin-bottom:.5rem">Name
        <input type="text" id="em-name" value="${esc(s.meal_name || (s.items.length === 1 ? s.items[0].food_name : ''))}"
               placeholder="z.B. Frühstück oder Rezeptname" list="mealnames-datalist" onchange="on_meal_name_change(this)">
      </label>
    </div>
    ${_mealname_datalist_html()}
    <hr style="margin:.5rem 0 .75rem">
    <strong>Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr>
          <th>Lebensmittel</th><th>Menge</th><th>kcal</th>
          <th>Eiweiß</th><th>KH</th><th>Fett</th><th></th>
        </tr></thead>
        <tbody id="em-items">
          ${s.items.map(i => {
            const food = _food_lookup(i.food_name);
            const per100 = food ? { kcal: food.kcal_per_100g, protein: food.protein_per_100g, carbs: food.carbs_per_100g, fat: food.fat_per_100g } : null;
            // Show the amount in the unit it was entered in (e.g. "2 Stk.")
            const in_units = i.unit_name && i.amount_units != null;
            return _item_row_html(i.id, i.food_name,
              in_units ? i.amount_units : (i.amount_grams ?? ''),
              i.kcal, i.protein_g, i.carbs_g, i.fat_g, per100, !food,
              in_units ? i.unit_name : 'g');
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="display:flex;gap:.5rem;margin:.6rem 0 1rem;flex-wrap:wrap">
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="add_em_item_row()">+ Zutat</button>
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="open_add_recipe_to_meal()">+ Rezept</button>
      <button type="button" class="secondary outline"
              style="width:auto;font-size:.85rem;margin:0"
              onclick="add_em_skip_row()" title="Einmalige Mahlzeit — nicht in Lebensmitteldatenbank speichern">+ Einmalig</button>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="em-save-btn" onclick="save_meal_edit(${session_id}, [${s.items.map(i => i.id).join(',')}])">Speichern</button>
    </div>`;

  open_modal('Mahlzeit bearbeiten', body, null);
}

async function save_meal_edit(session_id, original_ids) {
  const btn = document.getElementById('em-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const date = document.getElementById('em-date').value;
    const name = document.getElementById('em-name').value.trim();

    await api('PUT', `/api/meals/${session_id}`, {
      date, meal_name: name || null, comment: null,
    });

    const rows = Array.from(document.querySelectorAll('#em-items tr'));
    const kept_ids = [];
    const ops = [];

    for (const row of rows) {
      const item_id    = row.dataset.itemId;
      const food_name  = row.querySelector('[name="food_name"]').value.trim();
      const amount_raw = row.querySelector('[name="amount_grams"]').value;
      const kcal_raw   = row.querySelector('[name="kcal"]').value;
      const prot_raw   = row.querySelector('[name="protein_g"]').value;
      const carb_raw   = row.querySelector('[name="carbs_g"]').value;
      const fat_raw    = row.querySelector('[name="fat_g"]').value;

      if (!food_name) continue; // skip blank rows

      const g    = _row_grams(row);
      const unit = row.querySelector('[name="unit"]').value;
      const raw  = amount_raw ? parseFloat(amount_raw) : NaN;
      const payload = {
        food_name,
        amount_grams: isNaN(g) ? null : g,
        kcal:      kcal_raw ? parseFloat(kcal_raw) : 0,
        protein_g: prot_raw ? parseFloat(prot_raw) : 0,
        carbs_g:   carb_raw ? parseFloat(carb_raw) : 0,
        fat_g:     fat_raw  ? parseFloat(fat_raw)  : 0,
        is_estimated: false,
        comment: null,
        skip_food_db: row.dataset.skipDb === 'true',
        amount_units: unit !== 'g' && !isNaN(raw) ? raw : null,
        unit_name:    unit !== 'g' && !isNaN(raw) ? unit : null,
      };

      if (item_id === 'new') {
        ops.push(api('POST', `/api/meals/${session_id}/items`, payload));
      } else {
        kept_ids.push(parseInt(item_id, 10));
        ops.push(api('PUT', `/api/meal-items/${item_id}`, payload));
      }
    }

    // Delete items whose rows were removed
    const deleted_ids = original_ids.filter(id => !kept_ids.includes(id));
    for (const id of deleted_ids) ops.push(api('DELETE', `/api/meal-items/${id}`));

    await Promise.all(ops);
    modal.close();
    await load_meals();
  } catch (err) {
    alert('Fehler: ' + err.message);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

async function del_meal(session_id) {
  const s = meals.find(m => m.id === session_id);
  if (!s) return;
  if (!confirm(`Mahlzeit vom ${s.date} und alle ${s.items.length} Zutat(en) löschen?`)) return;
  await api('DELETE', `/api/meals/${session_id}`);
  await load_meals();
}

async function move_meal_in_day(session_id, date, dir) {
  const day     = meals.filter(m => m.date === date);
  const day_idx = day.findIndex(m => m.id === session_id);
  const new_day_idx = day_idx + dir;
  if (new_day_idx < 0 || new_day_idx >= day.length) return;
  // Swap in the global meals array by id
  const gi = meals.findIndex(m => m.id === day[day_idx].id);
  const gj = meals.findIndex(m => m.id === day[new_day_idx].id);
  [meals[gi], meals[gj]] = [meals[gj], meals[gi]];
  render_meals();
  try {
    await api('PUT', '/api/meals/reorder', { ids: meals.map(m => m.id) });
  } catch (err) {
    alert('Fehler beim Umsortieren: ' + err.message);
    await load_meals();
  }
}

function copy_meal(session_id) {
  const s = meals.find(m => m.id === session_id);
  if (!s) return;
  const today = new Date().toISOString().slice(0, 10);
  open_modal('Mahlzeit kopieren', `
    <label>Datum
      <input type="date" id="copy-date" value="${today}">
    </label>
    <div class="form-footer">
      <button class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button onclick="do_copy_meal(${session_id})">Kopieren</button>
    </div>
  `);
}

async function do_copy_meal(session_id) {
  const s = meals.find(m => m.id === session_id);
  if (!s) return;
  const date = document.getElementById('copy-date').value;
  if (!date) return;
  close_modal();
  try {
    await ensure_foods_loaded();
    const { id: new_id } = await api('POST', '/api/meals', { date, meal_name: s.meal_name, comment: s.comment });
    for (const item of s.items) {
      await api('POST', `/api/meals/${new_id}/items`, {
        food_name:    item.food_name,
        amount_grams: item.amount_grams,
        kcal:         item.kcal,
        protein_g:    item.protein_g,
        carbs_g:      item.carbs_g,
        fat_g:        item.fat_g,
        is_estimated: !!item.is_estimated,
        comment:      item.comment || null,
        // Items not in the foods DB were entered as one-time — keep them out
        // of the DB when copying instead of silently auto-registering them.
        skip_food_db: !_food_lookup(item.food_name),
        amount_units: item.amount_units ?? null,
        unit_name:    item.unit_name || null,
      });
    }
    await load_meals();
  } catch (err) {
    alert('Fehler beim Kopieren: ' + err.message);
  }
}

// ─── Körper (body weight / measurements / photos) ─────────────────────────

let body_weight   = [];
let body_measures = [];
let body_photos   = [];

async function load_body() {
  try {
    [body_weight, body_measures, body_photos] = await Promise.all([
      api('GET', '/api/body/weight'),
      api('GET', '/api/body/measurements'),
      api('GET', '/api/body/photos'),
    ]);
    render_body_weight();
    render_body_measurements();
    render_body_photos();
  } catch (err) {
    document.getElementById('body-weight-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden: ${esc(err.message)}</p>`;
  }
}

function render_body_weight() {
  const el = document.getElementById('body-weight-list');
  if (!body_weight.length) {
    el.innerHTML = '<p class="empty">Noch keine Gewichts-Einträge.</p>';
    return;
  }
  el.innerHTML = `<figure><table>
    <thead><tr><th>Datum</th><th>Gewicht</th><th>Kommentar</th><th></th></tr></thead>
    <tbody>${body_weight.map(w => `
      <tr>
        <td>${esc(w.date)}</td>
        <td>${w.weight_kg.toFixed(1)}&thinsp;kg</td>
        <td>${w.comment ? esc(w.comment) : '&ndash;'}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_body_weight(${w.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_body_weight(${w.id})">&#10005;</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></figure>`;
}

function tpl_body_weight(w = null) {
  const today = new Date().toISOString().slice(0, 10);
  return `<form>
    <div class="grid">
      <label>Datum<input type="date" name="date" value="${w ? esc(w.date) : today}" required></label>
      <label>Gewicht (kg)
        <input type="number" name="weight_kg" step="0.1" min="0" value="${w ? w.weight_kg : ''}" required>
      </label>
    </div>
    <label>Kommentar (optional)
      <input type="text" name="comment" value="${w ? esc(w.comment || '') : ''}">
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function _parse_body_weight_form(data) {
  return {
    date:      data.date,
    weight_kg: parseFloat(data.weight_kg),
    comment:   data.comment || null,
  };
}

function open_new_body_weight() {
  open_modal('Gewicht eintragen', tpl_body_weight(), async data => {
    await api('POST', '/api/body/weight', _parse_body_weight_form(data));
    await load_body();
  });
}

function open_edit_body_weight(id) {
  const w = body_weight.find(x => x.id === id);
  if (!w) return;
  open_modal('Gewicht bearbeiten', tpl_body_weight(w), async data => {
    await api('PUT', `/api/body/weight/${id}`, _parse_body_weight_form(data));
    await load_body();
  });
}

async function del_body_weight(id) {
  const w = body_weight.find(x => x.id === id);
  if (!w || !confirm(`Gewichts-Eintrag vom ${w.date} (${w.weight_kg} kg) löschen?`)) return;
  await api('DELETE', `/api/body/weight/${id}`);
  await load_body();
}

const MEASURE_SUGGESTIONS = ['Brust', 'Taille', 'Hüfte', 'Bizeps links', 'Bizeps rechts',
                             'Oberschenkel links', 'Oberschenkel rechts', 'Wade', 'Nacken', 'Körperfett'];

function render_body_measurements() {
  const el = document.getElementById('body-measurements-list');
  if (!body_measures.length) {
    el.innerHTML = '<p class="empty">Noch keine Maße erfasst.</p>';
    return;
  }
  el.innerHTML = `<figure><table>
    <thead><tr><th>Datum</th><th>Messung</th><th>Wert</th><th></th></tr></thead>
    <tbody>${body_measures.map(m => `
      <tr>
        <td>${esc(m.date)}</td>
        <td>${esc(m.name)}</td>
        <td>${m.value}&thinsp;${esc(m.unit)}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_body_measurement(${m.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_body_measurement(${m.id})">&#10005;</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></figure>`;
}

function tpl_body_measurement(m = null) {
  const today = new Date().toISOString().slice(0, 10);
  return `<form>
    <div class="grid">
      <label>Datum<input type="date" name="date" value="${m ? esc(m.date) : today}" required></label>
      <label>Messung
        <input type="text" name="name" value="${m ? esc(m.name) : ''}" list="measure-datalist"
               placeholder="z.B. Taille" required>
      </label>
    </div>
    <datalist id="measure-datalist">
      ${MEASURE_SUGGESTIONS.map(s => `<option value="${s}">`).join('')}
    </datalist>
    <div class="grid">
      <label>Wert
        <input type="number" name="value" step="0.1" min="0" value="${m ? m.value : ''}" required>
      </label>
      <label>Einheit
        <select name="unit">
          <option value="cm" ${!m || m.unit === 'cm' ? 'selected' : ''}>cm</option>
          <option value="%"  ${m && m.unit === '%'  ? 'selected' : ''}>%</option>
          <option value="mm" ${m && m.unit === 'mm' ? 'selected' : ''}>mm</option>
        </select>
      </label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function _parse_body_measurement_form(data) {
  return {
    date:  data.date,
    name:  data.name.trim(),
    value: parseFloat(data.value),
    unit:  data.unit,
  };
}

function open_new_body_measurement() {
  open_modal('Maß eintragen', tpl_body_measurement(), async data => {
    await api('POST', '/api/body/measurements', _parse_body_measurement_form(data));
    await load_body();
  });
}

function open_edit_body_measurement(id) {
  const m = body_measures.find(x => x.id === id);
  if (!m) return;
  open_modal('Maß bearbeiten', tpl_body_measurement(m), async data => {
    await api('PUT', `/api/body/measurements/${id}`, _parse_body_measurement_form(data));
    await load_body();
  });
}

async function del_body_measurement(id) {
  const m = body_measures.find(x => x.id === id);
  if (!m || !confirm(`"${m.name}" vom ${m.date} löschen?`)) return;
  await api('DELETE', `/api/body/measurements/${id}`);
  await load_body();
}

// ── Photos: drag & drop upload ──

function render_body_photos() {
  const el = document.getElementById('body-photos-grid');
  if (!body_photos.length) {
    el.innerHTML = '<p class="empty" style="grid-column:1/-1">Noch keine Fotos hochgeladen.</p>';
    return;
  }
  el.innerHTML = body_photos.map(p => `
    <figure class="photo-card">
      <img src="/uploads/${esc(p.filename)}" alt="${esc(p.date)}" loading="lazy"
           onclick="window.open('/uploads/${esc(p.filename)}', '_blank')">
      <figcaption>
        <span>${esc(p.date)}</span>
        <button class="photo-del" title="Löschen" onclick="del_body_photo(${p.id})">&#10005;</button>
      </figcaption>
    </figure>`).join('');
}

async function del_body_photo(id) {
  const p = body_photos.find(x => x.id === id);
  if (!p || !confirm(`Foto vom ${p.date} löschen?`)) return;
  await api('DELETE', `/api/body/photos/${id}`);
  await load_body();
}

async function _upload_photos(file_list) {
  const files = Array.from(file_list).filter(f => f.type.startsWith('image/'));
  if (!files.length) { alert('Keine Bilddateien erkannt.'); return; }
  const today = new Date().toISOString().slice(0, 10);
  const zone = document.getElementById('photo-dropzone');
  zone.setAttribute('aria-busy', 'true');
  try {
    for (const file of files) {
      const data_b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]); // strip data: prefix
        reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
        reader.readAsDataURL(file);
      });
      await api('POST', '/api/body/photos', {
        date: today, filename: file.name, data_b64, comment: null,
      });
    }
    await load_body();
  } catch (err) {
    alert('Fehler beim Hochladen: ' + err.message);
  } finally {
    zone.removeAttribute('aria-busy');
  }
}

function _init_photo_dropzone() {
  const zone  = document.getElementById('photo-dropzone');
  const input = document.getElementById('photo-file-input');
  if (!zone) return;
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { _upload_photos(input.files); input.value = ''; });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    _upload_photos(e.dataTransfer.files);
  });
}

// ─── Analyse (time / weight chart) ─────────────────────────────────────────

async function load_analysis() {
  // Needs workouts (already loaded at init) + body weight
  try {
    if (!body_weight.length) {
      body_weight = await api('GET', '/api/body/weight');
    }
  } catch { /* body weight simply unavailable */ }
  _fill_analysis_selector();
  render_analysis_chart();
}

// True if the exercise entry has at least one real (non-null) weight value.
function _has_weight(ex) {
  if (!ex.weight_kg) return false;
  return JSON.parse(ex.weight_kg).some(v => v != null);
}

function _fill_analysis_selector() {
  const sel  = document.getElementById('ana-series');
  const prev = sel.value;
  // Exercises with at least one non-null weight value — pure BW exercises are useless here
  const names = new Set();
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (_has_weight(ex)) names.add(ex.exercise_name);
    }
  }
  const ex_opts = [...names].sort((a, b) => a.localeCompare(b))
    .map(n => `<option value="ex:${esc(n)}">Übung: ${esc(n)}</option>`).join('');
  sel.innerHTML = `<option value="bw">Körpergewicht</option>${ex_opts}`;
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Unit the exercise was originally entered in: majority vote over its entries
// (pick_weight_unit per entry); tie → unit of the most recent entry.
function _series_unit(name) {
  let kg = 0, lbs = 0, most_recent = null;
  for (const s of workouts) {            // workouts are ordered newest-first
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name || !_has_weight(ex)) continue;
      const u = pick_weight_unit(ex);
      if (most_recent === null) most_recent = u;
      u === 'lbs' ? lbs++ : kg++;
    }
  }
  if (lbs === kg) return most_recent || 'kg';
  return lbs > kg ? 'lbs' : 'kg';
}

// Build { points: [{date, avg, max}] ascending, unit, single } for the selection.
// For exercises: max = heaviest set that day, avg = mean over all sets that day,
// both in the series' original entry unit. Body weight: single series in kg.
function _analysis_points() {
  const sel = document.getElementById('ana-series').value;
  if (sel === 'bw') {
    const by_date = new Map();
    // several entries per date possible — keep the latest (list is newest-first)
    for (const w of [...body_weight].reverse()) by_date.set(w.date, w.weight_kg);
    const points = [...by_date.entries()]
      .map(([date, v]) => ({ date, avg: v, max: v }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { points, unit: 'kg', single: true };
  }
  const name = sel.slice(3);
  const unit = _series_unit(name);
  const by_date = new Map();               // date -> flat list of set weights
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name || !_has_weight(ex)) continue;
      const raw  = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
      if (!raw) continue;
      const vals = JSON.parse(raw).filter(v => v != null);
      if (!vals.length) continue;
      if (!by_date.has(s.date)) by_date.set(s.date, []);
      by_date.get(s.date).push(...vals);
    }
  }
  const round1 = v => Math.round(v * 10) / 10;
  const points = [...by_date.entries()].map(([date, vals]) => ({
    date,
    avg: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
    max: Math.max(...vals),
  })).sort((a, b) => a.date.localeCompare(b.date));
  return { points, unit, single: false };
}

// Clean y-axis ticks: step = 1/2/5 × 10^n covering [min,max] in ~5 steps.
function _nice_ticks(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const raw  = span / 4;
  const pow  = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * pow).find(s => span / s <= 5) || 10 * pow;
  const lo   = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = lo; v <= max + step * 0.999; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

const _ANA = { W: 860, H: 380, top: 16, right: 56, bottom: 36, left: 48 };

// Step path: horizontal to the next x first, then vertical to its y (no
// linear interpolation between points).
function _step_path(px, key) {
  return px.map((p, i) => i
    ? `H${p.x.toFixed(1)} V${p[key].toFixed(1)}`
    : `M${p.x.toFixed(1)},${p[key].toFixed(1)}`).join(' ');
}

function render_analysis_chart() {
  const el  = document.getElementById('analysis-chart');
  const { points: pts, unit, single } = _analysis_points();
  const sel   = document.getElementById('ana-series');
  const label = sel.options[sel.selectedIndex]?.textContent || '';

  if (pts.length === 0) {
    el.innerHTML = '<p class="empty">Keine Daten für diese Auswahl vorhanden.</p>';
    return;
  }

  const { W, H, top, right, bottom, left } = _ANA;
  const iw = W - left - right, ih = H - top - bottom;

  const ts     = pts.map(p => new Date(p.date + 'T00:00:00').getTime());
  const t_min  = Math.min(...ts), t_max = Math.max(...ts);
  const t_span = Math.max(t_max - t_min, 1);
  const vals   = pts.flatMap(p => single ? [p.max] : [p.avg, p.max]);
  const ticks  = _nice_ticks(Math.min(...vals), Math.max(...vals));
  const y_min  = ticks[0], y_max = ticks[ticks.length - 1];

  const X = t => left + ((t - t_min) / t_span) * iw;
  const Y = v => top + ih - ((v - y_min) / (y_max - y_min || 1)) * ih;

  const px = pts.map((p, i) => ({
    ...p,
    x:  pts.length === 1 ? left + iw / 2 : X(ts[i]),
    ym: Y(p.max),
    ya: Y(p.avg),
  }));

  // x ticks: ≤6 evenly picked data dates (dates ARE the ticks — no in-between labels)
  const n_lbl  = Math.min(6, px.length);
  const lbl_ix = new Set(Array.from({ length: n_lbl },
    (_, i) => Math.round(i * (px.length - 1) / Math.max(n_lbl - 1, 1))));
  const fmt_d  = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}`;

  const grid = ticks.map(v =>
    `<line x1="${left}" y1="${Y(v)}" x2="${left + iw}" y2="${Y(v)}" stroke="var(--ana-grid)" stroke-width="1"/>
     <text x="${left - 8}" y="${Y(v) + 4}" text-anchor="end" class="ana-tick">${v}</text>`).join('');

  const x_labels = px.map((p, i) => lbl_ix.has(i)
    ? `<text x="${p.x}" y="${top + ih + 22}" text-anchor="middle" class="ana-tick">${fmt_d(p.date)}</text>`
    : '').join('');

  const line = (key, color) => px.length > 1
    ? `<path d="${_step_path(px, key)}" fill="none" stroke="${color}"
             stroke-width="2" stroke-linecap="round" stroke-dasharray="2 7"/>` : '';
  const dots = (key, color) => px.map(p =>
    `<circle cx="${p.x}" cy="${p[key]}" r="4.5" fill="${color}"
             stroke="var(--ana-surface)" stroke-width="2"/>`).join('');

  // End labels: max always; avg only when the two don't collide vertically.
  const last = px[px.length - 1];
  let end_labels =
    `<text x="${(last.x + 8).toFixed(1)}" y="${(last.ym + 4).toFixed(1)}" class="ana-endlabel">${last.max}</text>`;
  if (!single && Math.abs(last.ya - last.ym) >= 16) {
    end_labels +=
      `<text x="${(last.x + 8).toFixed(1)}" y="${(last.ya + 4).toFixed(1)}" class="ana-endlabel">${last.avg}</text>`;
  }

  const legend = single ? '' : `
    <div class="ana-legend">
      <span><i style="background:var(--ana-series)"></i>Max (${esc(unit)})</span>
      <span><i style="background:var(--ana-series2)"></i>&Oslash; über Sätze (${esc(unit)})</span>
    </div>`;

  el.innerHTML = `
    ${legend}
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"
           style="width:100%;height:auto;display:block">
        <rect x="0" y="0" width="${W}" height="${H}" fill="var(--ana-surface)"/>
        ${grid}
        <text x="${left - 8}" y="${top - 4}" text-anchor="end" class="ana-tick">${esc(unit)}</text>
        <line x1="${left}" y1="${top + ih}" x2="${left + iw}" y2="${top + ih}"
              stroke="var(--ana-axis)" stroke-width="1"/>
        ${x_labels}
        ${single ? '' : line('ya', 'var(--ana-series2)')}
        ${line('ym', 'var(--ana-series)')}
        <line id="ana-crosshair" x1="0" y1="${top}" x2="0" y2="${top + ih}"
              stroke="var(--ana-axis)" stroke-width="1" visibility="hidden"/>
        ${single ? '' : dots('ya', 'var(--ana-series2)')}
        ${dots('ym', 'var(--ana-series)')}
        ${end_labels}
      </svg>
      <div id="ana-tooltip" class="chart-tooltip" hidden></div>
    </div>
    <details style="margin-top:.75rem">
      <summary style="cursor:pointer;font-size:.9rem;color:var(--pico-muted-color)">Datentabelle</summary>
      <figure><table style="font-size:.85rem">
        <thead><tr><th>Datum</th><th>Max (${esc(unit)})</th>${single ? '' : `<th>&Oslash; (${esc(unit)})</th>`}</tr></thead>
        <tbody>${pts.map(p =>
          `<tr><td>${esc(p.date)}</td><td>${p.max}</td>${single ? '' : `<td>${p.avg}</td>`}</tr>`).join('')}</tbody>
      </table></figure>
    </details>`;

  _attach_chart_hover(el.querySelector('svg'), px, unit, single);
}

// Crosshair + tooltip: snaps to the nearest data point on the x axis and
// lists every series at that date.
function _attach_chart_hover(svg, px, unit, single) {
  const wrap  = svg.parentElement;
  const tip   = wrap.querySelector('#ana-tooltip');
  const cross = svg.querySelector('#ana-crosshair');

  function nearest(evt) {
    const r  = svg.getBoundingClientRect();
    const sx = (evt.clientX - r.left) * (_ANA.W / r.width);   // px → viewBox units
    let best = px[0], bd = Infinity;
    for (const p of px) {
      const d = Math.abs(p.x - sx);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  const tip_row = (color, text, strong) => {
    const row = document.createElement(strong ? 'strong' : 'span');
    if (color) {
      const key = document.createElement('i');
      key.className = 'tip-key';
      key.style.background = color;
      row.appendChild(key);
    }
    row.appendChild(document.createTextNode(text));   // labels are data — no innerHTML
    return row;
  };

  svg.addEventListener('pointermove', evt => {
    const p = nearest(evt);
    cross.setAttribute('x1', p.x);
    cross.setAttribute('x2', p.x);
    cross.setAttribute('visibility', 'visible');

    tip.hidden = false;
    tip.textContent = '';
    tip.appendChild(tip_row(single ? null : 'var(--ana-series)', `${single ? '' : 'Max '}${p.max} ${unit}`, true));
    if (!single) tip.appendChild(tip_row('var(--ana-series2)', `Ø ${p.avg} ${unit}`, false));
    tip.appendChild(tip_row(null, p.date, false));

    const r  = svg.getBoundingClientRect();
    const cx = p.x  * (r.width / _ANA.W);
    const cy = p.ym * (r.height / _ANA.H);
    tip.style.left = Math.min(cx + 12, r.width - tip.offsetWidth - 4) + 'px';
    tip.style.top  = (cy - 14) + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────
load_workouts();
load_endurance();
load_sports();
load_settings().then(load_meals);   // targets must be known before rendering days
load_exercise_catalog();
_init_photo_dropzone();
// foods_db / body / analysis data loaded on demand when their tab is opened
