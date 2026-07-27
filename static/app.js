'use strict';

// ─── State ────────────────────────────────────────────────────────────────
let workouts  = [];
let endurance = [];
let sports    = [];
let meals     = [];
let foods_db  = [];
let recipes   = [];
let exercise_catalog = [];
let training_plans   = [];

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

// Weight: "100.0 kg (220.5 lbs)"  or  "BW"; per-hand weights marked "je Hand"
function fmt_weight(wkg_json, wlbs_json, per_hand = false) {
  if (!wkg_json) return 'BW';
  const kg  = JSON.parse(wkg_json);
  const lbs = wlbs_json ? JSON.parse(wlbs_json) : null;
  const kg_s  = [...new Set(kg)].length  === 1 ? String(kg[0])  : kg.join(', ');
  const hand  = per_hand ? ' <small>pro Seite</small>' : '';
  if (lbs) {
    const lbs_s = [...new Set(lbs)].length === 1 ? String(lbs[0]) : lbs.join(', ');
    return `${kg_s}&thinsp;kg (${lbs_s}&thinsp;lbs)${hand}`;
  }
  return `${kg_s}&thinsp;kg${hand}`;
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

// Swimming pace: minutes per 100 m
function fmt_pace100(distance_km, duration_s) {
  if (!distance_km || !duration_s) return '—';
  const pace_s = duration_s / (distance_km * 10);   // km → 100 m units
  const m = Math.floor(pace_s / 60);
  const s = Math.round(pace_s % 60);
  return `${m}:${String(s).padStart(2, '0')} /100m`;
}

function opt(val, suffix = '', fallback = '—') {
  return (val != null && val !== '') ? (val + suffix) : fallback;
}

// Today's date in LOCAL time (toISOString() is UTC and rolls over to the
// next day in the evening for negative UTC offsets).
function today_local() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// The shared <datalist> elements normally live on document.body — which the
// browser marks INERT while a modal <dialog> is open. Picking an option from
// an inert datalist can strand keyboard focus (inputs stop accepting text
// until reload). Fix: move the datalists INTO the open dialog and rescue
// them back to <body> before the dialog content is cleared on close.
const _SHARED_DATALISTS = ['foods-datalist', 'exercises-datalist'];

function _mount_datalists(container) {
  _SHARED_DATALISTS.forEach(id => {
    const dl = document.getElementById(id);
    if (dl) container.appendChild(dl);
  });
}

function _rescue_datalists() {
  _SHARED_DATALISTS.forEach(id => {
    const dl = document.getElementById(id);
    if (dl && dl.parentElement !== document.body) document.body.appendChild(dl);
  });
}

function open_modal(title, body_html, on_submit) {
  if (modal.open) modal.close();   // never call showModal() on an open dialog
  _rescue_datalists();             // BEFORE the overwrite — innerHTML would destroy them
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = body_html;
  _mount_datalists(body);

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

// Cleanup is done IMPERATIVELY here (not only via the 'close' event, which
// does not fire reliably in every environment): rescue the shared datalists,
// then drop the stale content so no duplicate IDs / dead focus targets remain.
function close_modal() {
  _rescue_datalists();
  modal.close();
  document.getElementById('modal-body').innerHTML = '';
}
// Outside-click does NOT close the modal — prevents accidental closure while selecting text.

// Belt-and-braces for paths that call modal.close() directly (form submits):
modal.addEventListener('close', () => {
  _rescue_datalists();
  document.getElementById('modal-body').innerHTML = '';
});

// Second modal — used for pickers (e.g. recipe selection) opened ON TOP of the
// first modal. It has its own dialog element so it does not destroy the meal
// editor form underneath (which lives in #modal-body).
const modal2 = document.getElementById('modal2');

function open_modal2(title, body_html) {
  // If already open (e.g. recipe picker → "Anpassen…"), swap the content in
  // place. Closing first would queue an async `close` event that wipes the new
  // body after we set it — leaving an empty modal.
  const already = modal2.open;
  _rescue_datalists();
  document.getElementById('modal2-title').textContent = title;
  const body2 = document.getElementById('modal2-body');
  body2.innerHTML = body_html;
  if (!already) modal2.showModal();
  _focus_first_field(body2);
}

function close_modal2() {
  _rescue_datalists();
  modal2.close();
  document.getElementById('modal2-body').innerHTML = '';
  // Hand focus back to the underlying editor dialog if it is still open.
  if (modal.open) _focus_first_field(document.getElementById('modal-body'));
}

modal2.addEventListener('close', () => {
  document.getElementById('modal2-body').innerHTML = '';
  if (modal.open) _focus_first_field(document.getElementById('modal-body'));
});

// ─── Form templates ───────────────────────────────────────────────────────

function tpl_workout_session(date = '', comment = '', extra_html = '') {
  return `<form>
    <label>Datum<input type="date" name="date" value="${esc(date)}" required></label>
    <label>Kommentar (optional)<input type="text" name="comment" value="${esc(comment)}"></label>
    ${extra_html}
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
             placeholder="z.B. Bankdrücken" required
             onchange="update_exercise_history(this.value)">
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
    <div style="display:flex; gap:.5rem; align-items:center; margin-bottom:.5rem">
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
    <details id="ex-history-box" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-size:.9rem;color:var(--pico-primary)">Verlauf dieser Übung</summary>
      <div id="ex-history" style="font-size:.85rem;margin-top:.4rem"></div>
    </details>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

// "Gewichtsangabe" is a two-checkbox either/or: exactly one stays active.
// per_hand=true ⇔ "pro Seite" checked.
function _wmode_pick(cb) {
  // scoped to the modal body so it works in the exercise editor (a plain div)
  const root  = cb.closest('#modal-body') || document.getElementById('modal-body');
  const side  = root.querySelector('[name="per_hand"]');
  const total = root.querySelector('[name="wm_total"]');
  if (cb === side) { side.checked = true;  total.checked = false; }
  else             { total.checked = true; side.checked  = false; }
}

// Kraftübung / Dehnübung: exactly one active; muscles only apply to Kraft.
function _art_pick(cb) {
  const root  = cb.closest('#modal-body') || document.getElementById('modal-body');
  const kraft = root.querySelector('[name="art_kraft"]');
  const dehn  = root.querySelector('[name="art_dehn"]');
  if (cb === kraft) { kraft.checked = true;  dehn.checked = false; }
  else              { dehn.checked  = true;  kraft.checked = false; }
  root.querySelector('#exdb-muscle-box').disabled = dehn.checked;
}

// Personal history of one exercise: when it was done and with which weights.
function update_exercise_history(name) {
  const el = document.getElementById('ex-history');
  if (!el) return;
  const clean = (name || '').trim().toLowerCase();
  const rows = [];
  for (const s of workouts) {                       // newest first already
    for (const ex of s.exercises) {
      if (ex.exercise_name.toLowerCase() !== clean) continue;
      rows.push(`<tr>
        <td style="white-space:nowrap">${esc(s.date)}</td>
        <td>${ex.sets}×${fmt_reps(ex.reps_per_set)}</td>
        <td>${fmt_weight(ex.weight_kg, ex.weight_lbs, _is_per_hand(ex.exercise_name))}</td>
      </tr>`);
    }
  }
  el.innerHTML = rows.length
    ? `<figure style="margin:0"><table style="font-size:.85rem;margin:0">
         <thead><tr><th>Datum</th><th>Sätze×Reps</th><th>Gewicht</th></tr></thead>
         <tbody>${rows.slice(0, 10).join('')}</tbody>
       </table></figure>${rows.length > 10 ? `<small style="color:var(--pico-muted-color)">… und ${rows.length - 10} ältere</small>` : ''}`
    : '<p style="color:var(--pico-muted-color);margin:0">Noch keine Einträge für diese Übung.</p>';
  // auto-open when there is history to see
  const box = document.getElementById('ex-history-box');
  if (box) box.open = rows.length > 0;
}

function tpl_endurance(s = null, default_type = 'run') {
  const type = s ? s.activity_type : default_type;
  const swim = type === 'swim';
  // Swimming distances are entered in metres, run/ride in km (stored: km)
  const dist_val = s && s.distance_km != null
    ? (swim ? Math.round(s.distance_km * 1000) : s.distance_km) : '';
  return `<form>
    <div class="grid">
      <label>Datum<input type="date" name="date" value="${s ? esc(s.date) : ''}" required></label>
      <label>Typ
        <select name="activity_type" onchange="on_endurance_type_change(this)">
          <option value="run"  ${type === 'run'  ? 'selected' : ''}>🏃 Lauf</option>
          <option value="ride" ${type === 'ride' ? 'selected' : ''}>🚴 Radfahrt</option>
          <option value="swim" ${type === 'swim' ? 'selected' : ''}>🏊 Schwimmen</option>
        </select>
      </label>
    </div>
    <div class="grid">
      <label><span id="en-dist-label">Distanz (${swim ? 'm' : 'km'})</span>
        <input type="number" name="distance_km" step="${swim ? 1 : 0.01}" min="0"
               value="${dist_val}">
      </label>
      <label>Zeit (h:mm:ss)
        <input type="text" name="duration_str" placeholder="0:45:00"
               value="${s ? duration_to_input(s.duration_s) : ''}">
      </label>
    </div>
    <div class="grid">
      <label id="en-elev-field" ${swim ? 'hidden' : ''}>Höhenmeter (m)
        <input type="number" name="elevation_m" step="1" min="0"
               value="${s && s.elevation_m != null ? s.elevation_m : ''}">
      </label>
      <label>Ø Herzfrequenz (bpm, optional)
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

// ─── Row drag & drop (exercises within a workout, meals within a day) ─────
// The dragged row is moved live within its tbody on dragover; the new order
// is committed on dragend via the existing reorder endpoints.

let _drag_row = null;

function row_drag_start(e) {
  _drag_row = e.currentTarget;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', ''); } catch {}   // Firefox needs data
  _drag_row.classList.add('dragging');
}

function row_drag_over(e) {
  if (!_drag_row) return;
  const row = e.currentTarget;
  if (row === _drag_row || row.parentElement !== _drag_row.parentElement) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  const after = (e.clientY - r.top) > r.height / 2;
  row.parentElement.insertBefore(_drag_row, after ? row.nextSibling : row);
}

async function ex_drag_end() {
  const row = _drag_row;
  _drag_row = null;
  if (!row) return;
  row.classList.remove('dragging');
  const sid = parseInt(row.dataset.sessionId);
  const ids = [...row.parentElement.querySelectorAll('tr[data-ex-id]')]
    .map(tr => parseInt(tr.dataset.exId));
  const s = workouts.find(w => w.id === sid);
  if (!s) return;
  s.exercises.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  render_activities();
  try {
    await api('PUT', `/api/workouts/${sid}/exercises/reorder`, { ids });
  } catch (err) {
    alert('Fehler beim Umsortieren: ' + err.message);
    await load_workouts();
  }
}

async function meal_drag_end() {
  const row = _drag_row;
  _drag_row = null;
  if (!row) return;
  row.classList.remove('dragging');
  const date    = row.dataset.date;
  const day_ids = [...row.parentElement.querySelectorAll('tr[data-meal-id]')]
    .map(tr => parseInt(tr.dataset.mealId));
  const by_id     = new Map(meals.map(m => [m.id, m]));
  const reordered = day_ids.map(id => by_id.get(id)).filter(Boolean);
  // Rebuild the global meals order: this day's sessions take their new
  // sequence, everything else keeps its position.
  let qi = 0;
  meals = meals.map(m => m.date === date ? reordered[qi++] : m);
  render_meals();
  try {
    await api('PUT', '/api/meals/reorder', { ids: meals.map(m => m.id) });
  } catch (err) {
    alert('Fehler beim Umsortieren: ' + err.message);
    await load_meals();
  }
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
          <tr><th></th><th>Übung</th><th>Sätze</th><th>Reps</th><th>Gewicht</th><th>Gruppe</th><th></th></tr>
        </thead>
        <tbody>
          ${s.exercises.map((ex, idx) => `
          <tr draggable="true" data-ex-id="${ex.id}" data-session-id="${s.id}"
              ondragstart="row_drag_start(event)" ondragover="row_drag_over(event)"
              ondragend="ex_drag_end()">
            <td class="reorder-col">
              <span class="drag-handle" title="Ziehen zum Umsortieren">⠿</span>
              <button class="reorder-btn" title="Nach oben"
                      ${idx === 0 ? 'disabled' : ''}
                      onclick="move_exercise(${s.id}, ${ex.id}, -1)">▲</button>
              <button class="reorder-btn" title="Nach unten"
                      ${idx === s.exercises.length - 1 ? 'disabled' : ''}
                      onclick="move_exercise(${s.id}, ${ex.id}, 1)">▼</button>
            </td>
            <td>${esc(ex.exercise_name)} ${_hints_btn(ex.exercise_name)}</td>
            <td>${ex.sets}</td>
            <td>${fmt_reps(ex.reps_per_set)}</td>
            <td>${fmt_weight(ex.weight_kg, ex.weight_lbs, _is_per_hand(ex.exercise_name))}</td>
            ${_ex_group_muscle_cells(ex.exercise_name)}
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

const ENDURANCE_LABELS = { run: '🏃 Lauf', ride: '🚴 Radfahrt', swim: '🏊 Schwimmen' };

function _endurance_card(s) {
  const type  = s.activity_type;
  const label = ENDURANCE_LABELS[type] || type;
  const derived_label = type === 'ride' ? 'Tempo' : 'Pace';
  const derived = type === 'run'  ? fmt_pace(s.distance_km, s.duration_s)
                : type === 'swim' ? fmt_pace100(s.distance_km, s.duration_s)
                :                   fmt_speed(s.distance_km, s.duration_s);
  const dist = type === 'swim'
    ? opt(s.distance_km != null ? Math.round(s.distance_km * 1000) : null, ' m')
    : opt(s.distance_km, ' km');
  // No Höhenmeter column for swimming
  const elev_th = type === 'swim' ? '' : '<th>Höhenmeter</th>';
  const elev_td = type === 'swim' ? '' : `<td>${opt(s.elevation_m, ' m')}</td>`;
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
            ${elev_th}<th>Ø HR</th><th>kcal</th><th>Kommentar</th>
          </tr>
          <tr>
            <td>${dist}</td>
            <td>${fmt_duration(s.duration_s)}</td>
            <td>${derived}</td>
            ${elev_td}
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
      <button onclick="close_modal(); setTimeout(() => open_new_endurance('swim'), 0)">🏊 Schwimmen</button>
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

async function open_new_workout() {
  const today = today_local();
  try { training_plans = await api('GET', '/api/plans'); } catch { training_plans = []; }
  const plan_select = training_plans.length ? `
    <label>Trainingsplan übernehmen (optional)
      <select name="plan_id">
        <option value="">— kein Plan —</option>
        ${training_plans.map(p =>
          `<option value="${p.id}">${esc(p.name)} (${p.items.length} Übungen)</option>`).join('')}
      </select>
    </label>` : '';
  open_modal('Neue Kraft-Session', tpl_workout_session(today, '', plan_select), async data => {
    const { id: session_id } = await api('POST', '/api/workouts',
      { date: data.date, comment: data.comment || null });
    const plan = training_plans.find(p => p.id === parseInt(data.plan_id));
    if (plan) {
      for (const i of plan.items) {
        await api('POST', `/api/workouts/${session_id}/exercises`, {
          exercise_name: i.exercise_name,
          sets:          i.sets,
          reps_str:      i.reps_str,
          weight_str:    i.weight_str || null,
          weight_unit:   i.weight_unit || 'kg',
          comment:       null,
        });
      }
    }
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
  const today = today_local();
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

// Count the comma-separated values in a "8" / "8,8,7" style field.
function _csv_count(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(x => x !== '').length;
}

// A multi-value reps/weight list must have exactly one entry per set.
// (A single value is fine — it applies to every set.) Throws on mismatch.
function _validate_set_lengths(sets, reps_str, weight_str) {
  const n  = parseInt(sets);
  const rc = _csv_count(reps_str);
  if (rc > 1 && rc !== n)
    throw new Error(`Wiederholungen: ${rc} Werte, aber ${n} Sätze — Anzahl muss übereinstimmen.`);
  const wc = _csv_count(weight_str);
  if (wc > 1 && wc !== n)
    throw new Error(`Gewicht: ${wc} Werte, aber ${n} Sätze — Anzahl muss übereinstimmen.`);
}

async function open_add_exercise(session_id) {
  await ensure_exercises_loaded();
  open_modal('Übung hinzufügen', tpl_exercise(), async data => {
    _validate_set_lengths(data.sets, data.reps_str, data.weight_str);
    await api('POST', `/api/workouts/${session_id}/exercises`, data);
    await load_workouts();
    await load_exercise_catalog();
  });
  update_exercise_history('');
}

async function open_edit_exercise(exercise_id) {
  await ensure_exercises_loaded();
  const found = find_exercise(exercise_id);
  if (!found) return;
  open_modal('Übung bearbeiten', tpl_exercise(found.exercise), async data => {
    _validate_set_lengths(data.sets, data.reps_str, data.weight_str);
    await api('PUT', `/api/exercises/${exercise_id}`, data);
    await load_workouts();
    await load_exercise_catalog();
  });
  update_exercise_history(found.exercise.exercise_name);
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
    'Wiederholungen', 'Gewicht (kg)', 'Gewicht (lbs)', 'Pro Seite', 'Übungs-Kommentar',
  ]];
  const join_w = raw => raw
    ? JSON.parse(raw).map(v => v == null ? 'BW' : v).join(' ')
    : 'BW';
  for (const s of list) {
    if (!s.exercises.length) {
      rows.push([s.date, s.comment || '', '', '', '', '', '', '', '']);
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
        _is_per_hand(ex.exercise_name) ? 'ja' : '',
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

// Swap the distance unit hint and hide Höhenmeter when the type is switched
// to swimming inside the form.
function on_endurance_type_change(sel) {
  const form = sel.closest('form');
  const swim = sel.value === 'swim';
  form.querySelector('#en-dist-label').textContent = `Distanz (${swim ? 'm' : 'km'})`;
  form.querySelector('#en-elev-field').hidden = swim;
  form.querySelector('[name="distance_km"]').step = swim ? 1 : 0.01;
}

function _parse_endurance_form(data) {
  const swim = data.activity_type === 'swim';
  const dist = data.distance_km ? parseFloat(data.distance_km) : null;
  return {
    date:          data.date,
    activity_type: data.activity_type,
    // swimming is entered in metres, stored in km like everything else
    distance_km:   dist != null ? (swim ? dist / 1000 : dist) : null,
    duration_s:    parse_duration(data.duration_str),
    elevation_m:   swim ? null : (data.elevation_m ? parseFloat(data.elevation_m) : null),
    avg_hr:        data.avg_hr      ? parseInt(data.avg_hr)         : null,
    kcal:          data.kcal        ? parseFloat(data.kcal)         : null,
    comment:       data.comment     || null,
  };
}

function open_new_endurance(default_type = 'run') {
  const title = { run: 'Neuer Lauf', ride: 'Neue Radfahrt', swim: 'Neues Schwimmen' }[default_type] || 'Neue Aktivität';
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
  const label = { run: 'Lauf', ride: 'Radfahrt', swim: 'Schwimmen' }[s.activity_type] || 'Aktivität';
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
  // weight labels ("pro Seite") come from the catalog — refresh the cards
  if (workouts.length) render_activities();
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

// Base-exercise attributes live in the catalog (per_hand, muscles, comment).
function _exercise_meta(name) {
  const n = (name || '').trim().toLowerCase();
  return exercise_catalog.find(e => e.name.toLowerCase() === n) || null;
}

// "pro Seite" is a property of the exercise itself, not of a single entry.
function _is_per_hand(name) {
  const m = _exercise_meta(name);
  return !!(m && m.per_hand);
}

// One <td> cell (Gruppe) for an exercise in the workout view. Individual
// muscles are only shown in the Übungen tab — the group is enough here.
function _ex_group_muscle_cells(name) {
  const m = _exercise_meta(name);
  const dash = '<span style="color:var(--pico-muted-color)">&ndash;</span>';
  const grp  = (m && m.muscle_group) ? esc(m.muscle_group) : dash;
  return `<td>${grp}</td>`;
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
    if (food.unit_name) row.dataset.unitName = food.unit_name;
    else delete row.dataset.unitName;
    if (unit_sel) {
      // Default the row to the food's own serving unit — for a drink sold by
      // the can, "1 Dose/Glas" is the natural entry, not "473 g". Only auto-pick
      // while the unit is still the untouched default; once the user changes it
      // manually (unitManual) we leave their choice alone.
      const auto = row.dataset.unitManual !== '1' && unit_sel.value === 'g' && food.unit_name;
      unit_sel.innerHTML = _unit_options_html(food, auto ? food.unit_name : unit_sel.value);
    }
    if (badge) { badge.className = 'food-badge match'; badge.textContent = '✓'; }
    _set_macros_readonly(row, true);
    const g = _row_grams(row);
    if (!isNaN(g) && g > 0) _recalc_macros(row, g);
  } else {
    delete row.dataset.per100kcal;
    delete row.dataset.unitGrams;
    delete row.dataset.unitName;
    if (unit_sel) unit_sel.innerHTML = _unit_options_html(null, unit_sel.value);
    _set_macros_readonly(row, false);
    if (badge) {
      badge.className = 'food-badge' + (input.value.trim() ? ' new' : '');
      badge.textContent = input.value.trim() ? 'neu' : '';
    }
  }
  // Manually typing an ingredient invalidates any remembered recipe origin, so
  // the auto-derived meal name reflects what's actually in the list.
  const tbody = document.getElementById('em-items');
  if (tbody && !row.dataset.fromRecipe) delete tbody.dataset.recipeName;
  update_meal_name_placeholder();
}

function on_amount_change(input) {
  const row = input.closest('tr');
  const g   = _row_grams(row);
  if (!isNaN(g) && g > 0 && row.dataset.per100kcal !== undefined) {
    _recalc_macros(row, g);
  }
}

// Rounding: calories → whole numbers, nutrition → 1 decimal.
function r_kcal(v) { return Math.round(Number(v) || 0); }
function r_nut(v)  { return Math.round((Number(v) || 0) * 10) / 10; }

function _recalc_macros(row, amount_grams) {
  const f = amount_grams / 100;
  row.querySelector('[name="kcal"]').value      = r_kcal(parseFloat(row.dataset.per100kcal)    * f);
  row.querySelector('[name="protein_g"]').value = r_nut(parseFloat(row.dataset.per100protein)  * f);
  row.querySelector('[name="carbs_g"]').value   = r_nut(parseFloat(row.dataset.per100carbs)    * f);
  row.querySelector('[name="fat_g"]').value     = r_nut(parseFloat(row.dataset.per100fat)      * f);
}

// Macros to persist for a meal-item row. If the ingredient is a known catalog
// food with a convertible amount, they are computed fresh from its per-100g
// values — this is authoritative and does NOT depend on any change/input event
// having fired, so typing a food + amount and hitting save always works
// (edits: single-ingredient meals were saving 0). Otherwise the values typed
// into the row (manual/one-off items, non-convertible units) are used.
function _row_macros_for_save(row) {
  const name = row.querySelector('[name="food_name"]').value.trim();
  const food = row.dataset.skipDb === 'true' ? null : _food_lookup(name);
  const g    = _row_grams(row);
  const read = n => { const v = row.querySelector(`[name="${n}"]`).value; return v ? parseFloat(v) : 0; };
  if (food && !isNaN(g) && g > 0) {
    const f = g / 100;
    return {
      kcal:      r_kcal(food.kcal_per_100g    * f),
      protein_g: r_nut(food.protein_per_100g  * f),
      carbs_g:   r_nut(food.carbs_per_100g    * f),
      fat_g:     r_nut(food.fat_per_100g      * f),
    };
  }
  return { kcal: read('kcal'), protein_g: read('protein_g'), carbs_g: read('carbs_g'), fat_g: read('fat_g') };
}

function switch_acts_tab(btn) {
  document.querySelectorAll('[data-acts-tab]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const tab = btn.dataset.actsTab;
  document.getElementById('acts-subtab-history').hidden   = (tab !== 'history');
  document.getElementById('acts-subtab-exercises').hidden = (tab !== 'exercises');
  document.getElementById('acts-subtab-plans').hidden     = (tab !== 'plans');
  document.getElementById('activities-add-btn').hidden    = (tab !== 'history');
  document.getElementById('activities-export-btn').hidden = (tab !== 'history');
  if (tab === 'exercises') load_exercise_catalog();
  if (tab === 'plans')     load_plans();
}

// Convert bare URLs in a (already plain) string into clickable links.
function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// Small "?" button that reveals an exercise's Ausführungshinweise on demand —
// hints are never shown by default in any exercise list. Emits nothing when
// the exercise has no hints stored.
function _hints_btn(name) {
  const m = _exercise_meta(name);
  if (!m || (!m.hints && !m.comment)) return '';   // shown when video OR hints exist
  return `<button type="button" class="outline secondary hints-btn" title="Video & Ausführungshinweise"
            data-ex="${esc(name)}" onclick="show_exercise_hints(this.dataset.ex)">?</button>`;
}

function show_exercise_hints(name) {
  const m = _exercise_meta(name);
  const parts = [];
  if (m && m.comment)
    parts.push(`<div style="margin-bottom:.7rem"><strong>Video:</strong> ${linkify(m.comment)}</div>`);
  if (m && m.hints)
    parts.push(`<div style="white-space:pre-wrap;font-size:.9rem;line-height:1.5">${linkify(m.hints)}</div>`);
  const body = parts.length ? parts.join('') : 'Keine Angaben hinterlegt.';
  open_modal2('Übung: ' + name, `<div>
    ${body}
    <div class="form-footer"><button type="button" onclick="close_modal2()">Schließen</button></div>
  </div>`);
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
  const dash = '<span style="color:var(--pico-muted-color)">&ndash;</span>';
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr><th>Übung</th><th>Gruppe</th><th>Hauptmuskeln</th><th>Nebenmuskeln</th><th></th></tr></thead>
    <tbody>${sorted.map(e => {
      const dehn = e.is_strength === 0;
      const primary   = dehn ? '' : (e.muscles || '');
      const secondary = dehn ? '' : (e.secondary_muscles || '');
      return `
      <tr>
        <td>${esc(e.name)}${dehn ? ' <small style="color:var(--pico-muted-color)">(Dehnübung)</small>' : ''}</td>
        <td>${e.muscle_group ? esc(e.muscle_group) : dash}</td>
        <td>${primary ? esc(primary) : dash}</td>
        <td>${secondary ? esc(secondary) : dash}</td>
        <td class="row-actions">
          ${_hints_btn(e.name)}
          <button class="outline secondary" onclick="open_edit_exercise_db(${e.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_exercise_db(${e.id})">&#10005;</button>
        </td>
      </tr>`;}).join('')}
    </tbody>
  </table></figure>`;
}

const MUSCLE_GROUPS = ['Brust', 'Rücken', 'Schulter', 'Arme', 'Beine', 'Bauch'];

function _exercise_db_modal_body(e) {
  const name    = e ? esc(e.name) : '';
  const comment = e ? esc(e.comment || '') : '';
  const muscles = e ? esc(e.muscles || '') : '';
  const secondary = e ? esc(e.secondary_muscles || '') : '';
  const group   = e ? (e.muscle_group || '') : '';
  const is_dehn = e && e.is_strength === 0;
  return `<div>
    <label>Übung
      <input type="text" id="exdb-name" value="${name}" placeholder="z.B. Bankdrücken" required>
    </label>
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:.6rem;flex-wrap:wrap">
      <strong style="font-size:.9rem">Art:</strong>
      <label style="margin:0;display:inline-flex;align-items:center;gap:.35rem">
        <input type="checkbox" name="art_kraft" onchange="_art_pick(this)" ${is_dehn ? '' : 'checked'}> Kraftübung
      </label>
      <label style="margin:0;display:inline-flex;align-items:center;gap:.35rem">
        <input type="checkbox" name="art_dehn" onchange="_art_pick(this)" ${is_dehn ? 'checked' : ''}> Dehnübung
      </label>
    </div>
    <fieldset id="exdb-muscle-box" ${is_dehn ? 'disabled' : ''} style="border:0;padding:0;margin:0 0 .5rem">
      <div class="grid">
        <label>Gruppe
          <select id="exdb-group">
            <option value="" ${!group ? 'selected' : ''}>—</option>
            ${MUSCLE_GROUPS.map(g => `<option value="${g}" ${group === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </label>
        <label>Hauptmuskeln
          <input type="text" id="exdb-muscles" value="${muscles}" placeholder="z.B. Latissimus, Bizeps">
        </label>
      </div>
      <label>Nebenmuskeln
        <input type="text" id="exdb-secondary" value="${secondary}" placeholder="z.B. hintere Schulter">
      </label>
    </fieldset>
    <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem;flex-wrap:wrap">
      <strong style="font-size:.9rem">Gewichtsangabe:</strong>
      <label style="margin:0;display:inline-flex;align-items:center;gap:.35rem">
        <input type="checkbox" name="per_hand" onchange="_wmode_pick(this)" ${e && e.per_hand ? 'checked' : ''}> pro Seite
      </label>
      <label style="margin:0;display:inline-flex;align-items:center;gap:.35rem">
        <input type="checkbox" name="wm_total" onchange="_wmode_pick(this)" ${e && e.per_hand ? '' : 'checked'}> Gesamt
      </label>
    </div>
    <label>Video (z.B. YouTube-Link)
      <input type="text" id="exdb-comment" value="${comment}" placeholder="https://youtu.be/...">
    </label>
    <label>Ausführungshinweise (nur über den „?"-Button sichtbar)
      <textarea id="exdb-hints" rows="3" placeholder="z.B. Schulterblätter zusammen, kontrolliert ablassen …">${e ? esc(e.hints || '') : ''}</textarea>
    </label>
    <details id="ex-history-box" style="margin-bottom:1rem">
      <summary style="cursor:pointer;font-size:.9rem;color:var(--pico-primary)">Verlauf dieser Übung</summary>
      <div id="ex-history" style="font-size:.85rem;margin-top:.4rem"></div>
    </details>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="exdb-save-btn" onclick="save_exercise_db(${e ? e.id : 'null'})">Speichern</button>
    </div>
  </div>`;
}

function open_new_exercise_db() {
  open_modal('Neue Übung', _exercise_db_modal_body(null), null);
  update_exercise_history('');
}

function open_edit_exercise_db(exercise_id) {
  const e = exercise_catalog.find(x => x.id === exercise_id);
  if (!e) return;
  open_modal('Übung bearbeiten', _exercise_db_modal_body(e), null);
  update_exercise_history(e.name);
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
  const hints   = document.getElementById('exdb-hints').value.trim() || null;
  const per_hand = document.querySelector('#modal-body [name="per_hand"]').checked;
  const is_strength = document.querySelector('#modal-body [name="art_kraft"]').checked;
  // Muscles only apply to Kraftübungen — cleared for Dehnübungen
  const muscles           = is_strength ? (document.getElementById('exdb-muscles').value.trim()   || null) : null;
  const secondary_muscles = is_strength ? (document.getElementById('exdb-secondary').value.trim() || null) : null;
  const muscle_group      = is_strength ? (document.getElementById('exdb-group').value || null)             : null;
  if (!name) { alert('Bitte Übungsname eingeben.'); return; }
  const btn = document.getElementById('exdb-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  const payload = { name, comment, muscles, per_hand, hints, is_strength, muscle_group, secondary_muscles };
  try {
    if (exercise_id === null) {
      await api('POST', '/api/exercise-catalog', payload);
    } else {
      await api('PUT', `/api/exercise-catalog/${exercise_id}`, payload);
    }
    close_modal();
    await load_exercise_catalog();
    render_activities();          // weight labels depend on per_hand
  } catch (err) {
    alert('Fehler: ' + err.message);
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ─── Training plans ───────────────────────────────────────────────────────

async function load_plans() {
  training_plans = await api('GET', '/api/plans');
  render_plans();
}

// e.g. "Arme - 2×8 Trizepsdrücken Kabelzug @15, 10 lbs pro Seite"
function _plan_item_summary(i) {
  const group = _exercise_meta(i.exercise_name)?.muscle_group;
  const prefix = group ? `${esc(group)} - ` : '';
  const w = i.weight_str
    ? ` @${i.weight_str} ${i.weight_unit}${_is_per_hand(i.exercise_name) ? ' pro Seite' : ''}` : '';
  return `${prefix}${i.sets}×${i.reps_str} ${esc(i.exercise_name)}${w}`;
}

// Collapsible Ausführungshinweise for the plan overview: hidden by default,
// each hint line becomes a sub-bullet. The toggle is an icon-only span (its
// triangle is a CSS ::before, never part of the text), so a copy-paste of the
// expanded plan contains only the exercise lines + the visible bullets — no
// "Hinweise" label and no <details> chevron.
function _plan_hints_details(name) {
  const m = _exercise_meta(name);
  if (!m || !m.hints) return '';
  const bullets = m.hints.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => `<li>${linkify(l)}</li>`).join('');
  return `<span class="plan-hint-toggle" title="Hinweise ein-/ausblenden"
            onclick="this.closest('li').classList.toggle('hint-open')"></span>` +
         `<ul class="plan-hint-list">${bullets}</ul>`;
}

function render_plans() {
  const el = document.getElementById('plans-list');
  if (!el) return;
  const add_btn = `<div style="display:flex;justify-content:flex-end;margin-bottom:.75rem">
    <button onclick="open_new_plan()" style="width:auto;margin:0">+ Neuer Trainingsplan</button>
  </div>`;
  if (!training_plans.length) {
    el.innerHTML = add_btn + '<p class="empty">Noch keine Trainingspläne vorhanden.</p>';
    return;
  }
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr><th>Name</th><th>Übungen</th><th></th></tr></thead>
    <tbody>${training_plans.map(p => `
      <tr>
        <td>
          <details class="recipe-details">
            <summary><strong>${esc(p.name)}</strong></summary>
            <ul class="recipe-ingredients">${p.items.map(i => `<li>${_plan_item_summary(i)}${_plan_hints_details(i.exercise_name)}</li>`).join('') || '<li>leer</li>'}</ul>
          </details>
        </td>
        <td>${p.items.length}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_plan(${p.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_plan(${p.id})">&#10005;</button>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></figure>`;
}

function _plan_item_row_html(i = null) {
  const muscles = i ? (_exercise_meta(i.exercise_name)?.muscles || '') : '';
  return `<tr>
    <td class="reorder-col">
      <button type="button" class="reorder-btn" title="Nach oben"  onclick="move_plan_row(this,-1)">▲</button>
      <button type="button" class="reorder-btn" title="Nach unten" onclick="move_plan_row(this, 1)">▼</button>
    </td>
    <td style="white-space:nowrap"><input type="text" name="p-ex" value="${i ? esc(i.exercise_name) : ''}" list="exercises-datalist"
               placeholder="Übung" onchange="on_plan_exercise_change(this)" style="margin:0;min-width:8rem;display:inline-block;width:auto">
        <span class="plan-hint">${i ? _hints_btn(i.exercise_name) : ''}</span></td>
    <td><input type="number" name="p-sets" value="${i ? i.sets : ''}" min="1" max="50" placeholder="3"
               style="margin:0;width:3.8rem"></td>
    <td><input type="text" name="p-reps" value="${i ? esc(i.reps_str) : ''}" placeholder="8 oder 8,8,6"
               style="margin:0;width:6rem"></td>
    <td><input type="text" name="p-weight" value="${i && i.weight_str ? esc(i.weight_str) : ''}" placeholder="leer = BW"
               style="margin:0;width:6rem"></td>
    <td><select name="p-unit" style="margin:0;width:auto;padding:.2rem 1.4rem .2rem .4rem">
          <option value="kg"  ${!i || i.weight_unit !== 'lbs' ? 'selected' : ''}>kg</option>
          <option value="lbs" ${i && i.weight_unit === 'lbs' ? 'selected' : ''}>lbs</option>
        </select></td>
    <td class="plan-muscle" style="font-size:.8rem;color:var(--pico-muted-color);white-space:nowrap">${esc(muscles)}</td>
    <td><button type="button" class="outline contrast" style="margin:0;padding:.15rem .4rem;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

function add_plan_item_row() {
  document.getElementById('pl-items').insertAdjacentHTML('beforeend', _plan_item_row_html());
  document.querySelector('#pl-items tr:last-child [name="p-ex"]').focus();
}

// Move a plan row up/down within the editor (order is read from the DOM on save).
function move_plan_row(btn, dir) {
  const row = btn.closest('tr');
  if (dir < 0 && row.previousElementSibling)
    row.parentElement.insertBefore(row, row.previousElementSibling);
  else if (dir > 0 && row.nextElementSibling)
    row.parentElement.insertBefore(row.nextElementSibling, row);
}

// Most recent logged sets/reps/weight for an exercise (newest workout wins).
function _last_workout_entry(name) {
  const n = name.trim().toLowerCase();
  const sorted = [...workouts].sort((a, b) => b.date.localeCompare(a.date));
  for (const s of sorted) {
    for (const ex of s.exercises) {
      if (ex.exercise_name.toLowerCase() !== n) continue;
      const unit = pick_weight_unit(ex);
      const wraw = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
      return {
        sets:       ex.sets,
        reps_str:   reps_to_input(ex.reps_per_set),
        weight_str: wraw ? weight_to_input(wraw) : '',
        unit,
      };
    }
  }
  return null;
}

// On picking an exercise: show its main muscles and prefill empty
// sets/reps/weight from the last time it was trained.
function on_plan_exercise_change(input) {
  const row  = input.closest('tr');
  const name = input.value.trim();
  row.querySelector('.plan-muscle').textContent = _exercise_meta(name)?.muscles || '';
  row.querySelector('.plan-hint').innerHTML = _hints_btn(name);
  if (!name) return;
  const last = _last_workout_entry(name);
  if (!last) return;
  const sets   = row.querySelector('[name="p-sets"]');
  const reps   = row.querySelector('[name="p-reps"]');
  const weight = row.querySelector('[name="p-weight"]');
  const unit   = row.querySelector('[name="p-unit"]');
  if (!sets.value)   sets.value = last.sets;
  if (!reps.value)   reps.value = last.reps_str;
  if (!weight.value && last.weight_str) { weight.value = last.weight_str; unit.value = last.unit; }
}

async function _open_plan_modal(p) {
  await ensure_exercises_loaded();
  const rows = p ? p.items.map(i => _plan_item_row_html(i)).join('') : '';
  open_modal(p ? 'Trainingsplan bearbeiten' : 'Neuer Trainingsplan', `<div>
    <label>Name<input type="text" id="pl-name" value="${p ? esc(p.name) : ''}" placeholder="z.B. Push A" required></label>
    <strong style="font-size:.9rem">Übungen</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr><th></th><th>Übung</th><th>Sätze</th><th>Reps</th><th>Gewicht</th><th></th><th>Muskeln</th><th></th></tr></thead>
        <tbody id="pl-items">${rows}</tbody>
      </table>
    </div>
    <button type="button" class="secondary outline"
            style="width:auto;font-size:.85rem;margin:.6rem 0 1rem"
            onclick="add_plan_item_row()">+ Übung hinzufügen</button>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="pl-save-btn" onclick="save_plan(${p ? p.id : 'null'})">Speichern</button>
    </div>
  </div>`, null);
}

function open_new_plan() { _open_plan_modal(null); }

function open_edit_plan(plan_id) {
  const p = training_plans.find(x => x.id === plan_id);
  if (p) _open_plan_modal(p);
}

async function del_plan(plan_id) {
  const p = training_plans.find(x => x.id === plan_id);
  if (!p || !confirm(`Trainingsplan "${p.name}" löschen?`)) return;
  await api('DELETE', `/api/plans/${plan_id}`);
  await load_plans();
}

function _read_plan_rows() {
  const items = [];
  for (const row of document.querySelectorAll('#pl-items tr')) {
    const g = n => row.querySelector(`[name="${n}"]`);
    const name = g('p-ex').value.trim();
    const sets = parseInt(g('p-sets').value);
    const reps = g('p-reps').value.trim();
    if (!name || isNaN(sets) || sets < 1 || !reps) continue;
    const weight = g('p-weight').value.trim() || null;
    _validate_set_lengths(sets, reps, weight);   // throws on length mismatch
    items.push({
      exercise_name: name,
      sets,
      reps_str:    reps,
      weight_str:  weight,
      weight_unit: g('p-unit').value,
    });
  }
  return items;
}

async function save_plan(plan_id) {
  const name = document.getElementById('pl-name').value.trim();
  if (!name) { alert('Bitte Plan-Namen eingeben.'); return; }
  let items;
  try { items = _read_plan_rows(); }
  catch (err) { alert('Fehler: ' + err.message); return; }
  const btn = document.getElementById('pl-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    if (plan_id === null) await api('POST', '/api/plans', { name, items });
    else                  await api('PUT', `/api/plans/${plan_id}`, { name, items });
    close_modal();
    await load_plans();
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

// ─── Catalog sync via shared folder (e.g. OneDrive) ───────────────────────

function open_sync_modal() {
  open_modal('Katalog-Sync', `<form>
    <p style="font-size:.9rem;color:var(--pico-muted-color);margin-bottom:.75rem">
      Teilt <strong>Lebensmittel und Rezepte</strong> über einen gemeinsamen
      Ordner (z.B. OneDrive/Dropbox). Übungen, Workouts, Tagebuch und Körperdaten
      bleiben privat. Fehlende Einträge werden übernommen, bestehende nie überschrieben.
    </p>
    <label>Pfad zum gemeinsamen Ordner
      <input type="text" name="sync_dir" value="${esc(settings.sync_dir || '')}"
             placeholder="z.B. C:\\Users\\du\\OneDrive\\fitrack-shared">
      <small style="color:var(--pico-muted-color)">Leer lassen, solange noch kein Ordner eingerichtet ist.</small>
    </label>
    <div id="sync-result" style="font-size:.9rem;margin:.5rem 0"></div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Schließen</button>
      <button type="button" class="secondary" style="width:auto"
              onclick="run_catalog_sync(true)">Speichern &amp; jetzt synchronisieren</button>
    </div>
  </form>`, null);
}

async function run_catalog_sync(from_modal = false) {
  if (from_modal) {
    const dir = document.querySelector('#modal-body [name="sync_dir"]').value.trim();
    await api('PUT', '/api/settings', { sync_dir: dir || null });
    await load_settings();
    if (!dir) {
      document.getElementById('sync-result').textContent = 'Kein Ordner konfiguriert — Pfad gespeichert (leer).';
      return;
    }
  }
  const res = await api('POST', '/api/sync/run');
  const out = document.getElementById('sync-result');
  if (!res.ok) {
    if (out) { out.textContent = '⚠ ' + res.error; out.style.color = 'var(--pico-del-color)'; }
    return res;
  }
  const a = res.added;
  const summary = `✓ Sync ok — übernommen: ${a.foods} Lebensmittel, ${a.recipes} Rezept(e)`
    + `${res.peers.length ? ` (von: ${res.peers.join(', ')})` : ' (noch keine Partner-Datei)'}`;
  if (out) { out.textContent = summary; out.style.color = 'inherit'; }
  if (a.foods || a.recipes) {
    await load_foods_db();
    recipes = await api('GET', '/api/recipes');
    render_recipes();
  }
  return res;
}

// Silent auto-sync on startup when a shared folder is configured — the whole
// point is that neither user has to think about it.
async function auto_sync_on_start() {
  try {
    const st = await api('GET', '/api/sync/status');
    if (st.dir_exists) await run_catalog_sync(false);
  } catch (e) { console.warn('Auto-Sync übersprungen:', e.message); }
}

// Soll/Ist balance row for one day.
// Colors by relative deviation from the target: within ±5% green, within
// ±15% orange, outside red. Protein: anything ABOVE target is always green
// (it's a goal, not a limit); below target the same bands apply.
function _target_band(actual, target, above_is_ok) {
  const dev = (actual - target) / target;
  if (above_is_ok && dev >= 0) return 'target-ok';
  const a = Math.abs(dev);
  return a <= 0.05 ? 'target-ok' : a <= 0.15 ? 'target-warn' : 'target-bad';
}

function _target_row_html(dk, dp) {
  const kcal_t = parseFloat(settings.kcal_target);
  const prot_t = parseFloat(settings.protein_target);
  if (isNaN(kcal_t) && isNaN(prot_t)) return '';
  let kcal_cell = '', prot_cell = '';
  if (!isNaN(kcal_t) && kcal_t > 0) {
    const diff = Math.round(kcal_t - dk);
    const cls  = _target_band(dk, kcal_t, false);
    kcal_cell  = `<span class="${cls}">${diff >= 0 ? diff + ' übrig' : (-diff) + ' drüber'}</span>
                  <small>/ ${Math.round(kcal_t)}</small>`;
  }
  if (!isNaN(prot_t) && prot_t > 0) {
    const diff = dp - prot_t;
    const cls  = _target_band(dp, prot_t, true);
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
            const multi = s.items.length > 1;
            const label = s.meal_name ? esc(s.meal_name) : (s.items[0] ? esc(s.items[0].food_name) : '&ndash;');
            // Meals with several ingredients collapse to name + cumulative
            // nutrition; a caret expands the per-ingredient breakdown (edits #11).
            const name_cell = multi
              ? `<button class="meal-toggle" aria-expanded="false" onclick="toggle_meal_details(${s.id}, this)"><span class="caret">▸</span> ${label} <small style="color:var(--pico-muted-color)">(${s.items.length})</small></button>`
              : label;
            const detail_rows = multi ? s.items.map(i => `
              <tr class="meal-detail" data-parent="${s.id}" hidden>
                <td></td>
                <td style="padding-left:1.6rem;color:var(--pico-muted-color)">${esc(i.food_name)}</td>
                <td>${Math.round(i.kcal)}</td>
                <td>${i.protein_g.toFixed(1)}g</td>
                <td>${i.carbs_g.toFixed(1)}g</td>
                <td>${i.fat_g.toFixed(1)}g</td>
                <td></td>
              </tr>`).join('') : '';
            return `<tr draggable="true" data-meal-id="${s.id}" data-date="${date}"
                ondragstart="row_drag_start(event)" ondragover="row_drag_over(event)"
                ondragend="meal_drag_end()">
              <td class="reorder-col">
                <span class="drag-handle" title="Ziehen zum Umsortieren">⠿</span>
                <button class="reorder-btn" title="Nach oben"  ${idx === 0             ? 'disabled' : ''} onclick="move_meal_in_day(${s.id},'${date}',-1)">▲</button>
                <button class="reorder-btn" title="Nach unten" ${idx === ss.length - 1 ? 'disabled' : ''} onclick="move_meal_in_day(${s.id},'${date}', 1)">▼</button>
              </td>
              <td>${name_cell}</td>
              <td>${Math.round(tk)}</td>
              <td>${tp.toFixed(1)}g</td>
              <td>${tc.toFixed(1)}g</td>
              <td>${tf.toFixed(1)}g</td>
              <td class="row-actions">
                <button class="outline secondary" title="Kopieren"   onclick="copy_meal(${s.id})">&#10064;</button>
                <button class="outline secondary" title="Bearbeiten" onclick="open_edit_meal(${s.id})">&#9998;</button>
                <button class="outline contrast"  title="Löschen"    onclick="del_meal(${s.id})">&#10005;</button>
              </td>
            </tr>${detail_rows}`;
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


// Expand/collapse the per-ingredient rows of a multi-ingredient meal (edits #11).
function toggle_meal_details(meal_id, btn) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  const caret = btn.querySelector('.caret');
  if (caret) caret.textContent = open ? '▸' : '▾';
  document.querySelectorAll(`tr.meal-detail[data-parent="${meal_id}"]`)
    .forEach(tr => { tr.hidden = open; });
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
  const category_badge = f => {
    if (!f.category || f.category === 'standard') return '';
    const cfg = {
      kalorien: { label: 'K', title: 'Kalorienfokus',                          cls: 'match' },
      protein:  { label: 'P', title: 'Proteinquelle',                          cls: 'match' },
      nebenbei: { label: '≈', title: 'Nebenbei — grobe Schätzung reicht',      cls: 'skip'  },
    }[f.category];
    return cfg ? ` <span class="food-badge ${cfg.cls}" title="${cfg.title}">${cfg.label}</span>` : '';
  };
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr>
      <th>Lebensmittel</th><th>Basis</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th>
    </tr></thead>
    <tbody>${sorted.map(f => {
      // Unit-based foods are shown per 1 unit (their entry basis), others per 100 g
      const fac   = f.unit_name ? (f.unit_grams || 100) / 100 : 1;
      const basis = f.unit_name
        ? `1 ${esc(f.unit_name)}${f.unit_grams ? ` (${f.unit_grams}&thinsp;g)` : ''}`
        : '100 g';
      return `
      <tr>
        <td>${esc(f.name)}${category_badge(f)}</td>
        <td style="white-space:nowrap">${basis}</td>
        <td>${r_kcal(f.kcal_per_100g * fac)}</td>
        <td>${r_nut(f.protein_per_100g * fac)}g</td>
        <td>${r_nut(f.carbs_per_100g * fac)}g</td>
        <td>${r_nut(f.fat_per_100g * fac)}g</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_food(${f.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_food(${f.id})">&#10005;</button>
        </td>
      </tr>`;}).join('')}
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
    const ing_list = r.items.map(i => {
      const amt = (i.unit_name && i.amount_units != null)
        ? `${i.amount_units} ${esc(i.unit_name)}` : `${i.amount_grams} g`;
      return `<li>${amt} ${esc(i.food_name)}</li>`;
    }).join('');
    const portions = r.portions ? ` · ${(+r.portions)} Portion${r.portions === 1 ? '' : 'en'}` : '';
    return `<tr>
      <td>
        <details class="recipe-details">
          <summary><strong>${esc(r.name)}</strong></summary>
          <ul class="recipe-ingredients">${ing_list || '<li>keine Zutaten</li>'}</ul>
        </details>
      </td>
      <td>${r.items.length} Zutat${r.items.length !== 1 ? 'en' : ''} (${Math.round(total_g)}&thinsp;g${portions})</td>
      <td>${r_kcal(tk)}&thinsp;kcal</td>
      <td>${r_nut(tp)}g P</td>
      <td>${r_nut(tc)}g KH</td>
      <td>${r_nut(tf)}g F</td>
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

// Recipe ingredient row: name + amount + unit dropdown (g plus the food's own
// serving unit, that unit preselected when defined). Amount converts to grams
// on save, exactly like meal items.
function _recipe_item_row_html(food_name = '', amount = '', unit = 'g') {
  const food = food_name ? _food_lookup(food_name) : null;
  const un   = (food && food.unit_name)  ? ` data-unit-name="${esc(food.unit_name)}"` : '';
  const ug   = (food && food.unit_grams) ? ` data-unit-grams="${food.unit_grams}"` : '';
  return `<tr${un}${ug}>
    <td><input type="text" name="ri-food" value="${esc(food_name)}" list="foods-datalist" placeholder="Lebensmittel"
               onchange="on_recipe_food_change(this)" style="margin:0;min-width:8rem"></td>
    <td style="white-space:nowrap">
      <input type="number" name="ri-amt" value="${amount}" step="any" min="0" placeholder="Menge"
             style="margin:0;width:4.5rem;display:inline-block">
      <select name="ri-unit" style="margin:0;width:auto;display:inline-block;padding:.2rem 1.4rem .2rem .4rem">${_unit_options_html(food, unit)}</select>
    </td>
    <td><button type="button" class="outline contrast"
                style="padding:.15rem .4rem;margin:0;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

// Keep a recipe row's unit dropdown in sync with the chosen food.
function on_recipe_food_change(input) {
  const row = input.closest('tr');
  const food = _food_lookup(input.value);
  const sel = row.querySelector('[name="ri-unit"]');
  if (food && food.unit_name) { row.dataset.unitName = food.unit_name; } else { delete row.dataset.unitName; }
  if (food && food.unit_grams) { row.dataset.unitGrams = food.unit_grams; } else { delete row.dataset.unitGrams; }
  if (sel) sel.innerHTML = _unit_options_html(food, (food && food.unit_name) || sel.value);
}

// Grams for a recipe row (mirrors _row_grams for meal items).
function _recipe_row_grams(row) {
  const val = parseFloat(row.querySelector('[name="ri-amt"]').value);
  if (isNaN(val)) return NaN;
  const unit = row.querySelector('[name="ri-unit"]').value;
  if (unit === 'g') return val;
  if (unit === row.dataset.unitName) {
    const ug = parseFloat(row.dataset.unitGrams);
    return val * (isNaN(ug) ? 100 : ug);
  }
  return NaN;
}

function add_recipe_item_row() {
  document.getElementById('rm-items').insertAdjacentHTML('beforeend', _recipe_item_row_html());
  document.querySelector('#rm-items tr:last-child input').focus();
}

function _recipe_modal_body(r) {
  const name = r ? esc(r.name) : '';
  const rows = r ? r.items.map(i =>
    _recipe_item_row_html(i.food_name,
      (i.unit_name && i.amount_units != null) ? i.amount_units : i.amount_grams,
      (i.unit_name && i.amount_units != null) ? i.unit_name : 'g')).join('') : '';
  return `<div>
    <div class="grid">
      <label>Rezeptname<input type="text" id="rm-name" value="${name}" placeholder="z.B. Chili con Carne" required></label>
      <label>Portionen (optional)<input type="number" id="rm-portions" step="any" min="0"
             value="${r && r.portions != null ? (+r.portions) : ''}" placeholder="z.B. 4"></label>
    </div>
    <strong style="font-size:.9rem">Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr><th>Lebensmittel</th><th>Menge</th><th></th></tr></thead>
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
  const portions = parseFloat(document.getElementById('rm-portions').value);
  const rows = document.querySelectorAll('#rm-items tr');
  const items = [];
  for (const row of rows) {
    const food = row.querySelector('[name="ri-food"]').value.trim();
    const grams = _recipe_row_grams(row);
    if (!food || isNaN(grams) || grams <= 0) continue;
    const unit = row.querySelector('[name="ri-unit"]').value;
    const raw  = parseFloat(row.querySelector('[name="ri-amt"]').value);
    items.push({
      food_name: food, amount_grams: grams,
      amount_units: unit !== 'g' && !isNaN(raw) ? raw : null,
      unit_name:    unit !== 'g' && !isNaN(raw) ? unit : null,
    });
  }
  const payload = { name, items, portions: isNaN(portions) || portions <= 0 ? null : portions };
  const btn = document.getElementById('rm-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    if (recipe_id === null) {
      await api('POST', '/api/recipes', payload);
    } else {
      await api('PUT', `/api/recipes/${recipe_id}`, payload);
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
    return `<option value="${r.id}" data-total="${total_g}" data-portions="${r.portions || ''}" ${r.id === preselect_id ? 'selected' : ''}>${esc(r.name)} (${Math.round(total_g)}&thinsp;g gesamt)</option>`;
  }).join('');
  open_modal2('Rezept hinzufügen', `<div>
    <label>Rezept<select id="ra-select" onchange="update_recipe_add_hint()">${opts}</select></label>
    <div class="grid" style="margin-bottom:.25rem">
      <label style="margin:0">Menge
        <input type="number" id="ra-amount" step="any" min="0" placeholder="z.B. 300" autofocus>
      </label>
      <label style="margin:0">Einheit
        <select id="ra-mode" onchange="update_recipe_add_hint()">
          <option value="g">Gramm</option>
          <option value="portion">Portionen</option>
        </select>
      </label>
    </div>
    <small id="ra-hint" style="color:var(--pico-muted-color)"></small>
    <div class="form-footer" style="flex-wrap:wrap;gap:.5rem;margin-top:.75rem">
      <button type="button" class="secondary outline" onclick="close_modal2()">Abbrechen</button>
      <button type="button" class="secondary" style="width:auto" onclick="open_recipe_adapt()">Anpassen…</button>
      <button type="button" style="width:auto" onclick="apply_recipe_to_meal()">Original hinzufügen</button>
    </div>
  </div>`);
  update_recipe_add_hint();
}

// Resolve the entered amount + unit-mode into a scale factor relative to the
// stored recipe (1.0 = the recipe exactly as saved). Returns null if it can't
// be computed (e.g. portions requested but the recipe defines none).
function _recipe_scale(r, mode, amount) {
  if (isNaN(amount) || amount <= 0) return null;
  if (mode === 'portion') {
    if (!r.portions || r.portions <= 0) return null;
    return amount / r.portions;
  }
  const total = r.items.reduce((s, i) => s + (i.amount_grams || 0), 0);
  return total > 0 ? amount / total : null;
}

// Adapt a recipe just for this day: edit the (scaled) ingredient amounts before
// adding. Changes affect only the meal being logged — the stored recipe is
// never modified.
function open_recipe_adapt() {
  const sel       = document.getElementById('ra-select');
  const recipe_id = parseInt(sel.value);
  const mode      = document.getElementById('ra-mode')?.value || 'g';
  const amount    = parseFloat(document.getElementById('ra-amount').value);
  const r = recipes.find(x => x.id === recipe_id);
  if (!r) return;
  const scale = _recipe_scale(r, mode, amount);
  if (scale === null) {
    alert(mode === 'portion'
      ? 'Bitte Portionen eingeben (Rezept muss Portionen hinterlegt haben).'
      : 'Bitte Menge eingeben.');
    return;
  }
  const rows = r.items.map(i => {
    const amt = Math.round(i.amount_grams * scale * 10) / 10;
    return `<tr>
      <td>${esc(i.food_name)}<input type="hidden" name="ra-food" value="${esc(i.food_name)}"></td>
      <td style="white-space:nowrap">
        <input type="number" name="ra-amt" value="${amt}" step="0.1" min="0" style="margin:0;width:5.5rem"> g
      </td>
    </tr>`;
  }).join('');
  open_modal2('Rezept anpassen: ' + r.name, `<div data-recipe-name="${esc(r.name)}">
    <p style="font-size:.85rem;color:var(--pico-muted-color)">
      Änderungen gelten nur für diesen Tag — das gespeicherte Rezept bleibt unverändert.
    </p>
    <table style="font-size:.85rem;margin:0">
      <thead><tr><th>Zutat</th><th>Menge</th></tr></thead>
      <tbody id="ra-adapt">${rows}</tbody>
    </table>
    <div class="form-footer" style="margin-top:.75rem">
      <button type="button" class="secondary outline" onclick="close_modal2()">Abbrechen</button>
      <button type="button" onclick="apply_recipe_adapted()">Übernehmen</button>
    </div>
  </div>`);
}

function apply_recipe_adapted() {
  const rows = [...document.querySelectorAll('#ra-adapt tr')];
  const rname = document.querySelector('#modal2-body [data-recipe-name]')?.dataset.recipeName;
  close_modal2();
  if (rname) _tag_recipe_name(rname);
  const round1 = v => Math.round(v * 10) / 10;
  for (const row of rows) {
    const food   = row.querySelector('[name="ra-food"]').value;
    const amount = parseFloat(row.querySelector('[name="ra-amt"]').value);
    if (!food || isNaN(amount) || amount <= 0) continue;
    const f = _food_lookup(food);
    let kcal = 0, protein = 0, carbs = 0, fat = 0;
    if (f) {
      const fac = amount / 100;
      kcal    = r_kcal(f.kcal_per_100g    * fac);
      protein = round1(f.protein_per_100g * fac);
      carbs   = round1(f.carbs_per_100g   * fac);
      fat     = round1(f.fat_per_100g     * fac);
    }
    add_em_item_row(food, amount, kcal, protein, carbs, fat);
  }
  update_meal_name_placeholder();
}

function update_recipe_add_hint() {
  const sel  = document.getElementById('ra-select');
  const hint = document.getElementById('ra-hint');
  if (!sel || !hint) return;
  const total    = parseFloat(sel.options[sel.selectedIndex]?.dataset.total) || 0;
  const portions = parseFloat(sel.options[sel.selectedIndex]?.dataset.portions) || 0;
  const mode_sel = document.getElementById('ra-mode');
  const mode     = mode_sel ? mode_sel.value : 'g';
  // Portions option is only meaningful when the recipe defines a portion count.
  if (mode_sel) {
    const popt = [...mode_sel.options].find(o => o.value === 'portion');
    if (popt) {
      popt.disabled = portions <= 0;
      if (portions <= 0 && mode_sel.value === 'portion') mode_sel.value = 'g';
    }
  }
  const parts = [];
  if (total > 0)    parts.push(`Rezept gesamt: ${Math.round(total)} g`);
  if (portions > 0) parts.push(`${Math.round(portions * 10) / 10} Portion(en)`);
  else if (mode === 'portion') parts.push('— keine Portionen hinterlegt');
  if (portions > 0 && mode === 'portion') {
    parts.push(`1 Portion ≈ ${Math.round(total / portions)} g`);
  }
  hint.textContent = parts.join(' · ');
}

async function apply_recipe_to_meal() {
  await ensure_foods_loaded();
  const sel      = document.getElementById('ra-select');
  const recipe_id = parseInt(sel.value);
  const mode     = document.getElementById('ra-mode')?.value || 'g';
  const amount_in = parseFloat(document.getElementById('ra-amount').value);
  const r = recipes.find(x => x.id === recipe_id);
  if (!r) return;
  const scale = _recipe_scale(r, mode, amount_in);
  if (scale === null) {
    alert(mode === 'portion'
      ? 'Bitte Portionen eingeben (Rezept muss Portionen hinterlegt haben).'
      : 'Bitte Menge eingeben.');
    return;
  }
  close_modal2();
  _tag_recipe_name(r.name);
  const round1 = v => Math.round(v * 10) / 10;
  for (const item of r.items) {
    const amount = round1(item.amount_grams * scale);
    const food = _food_lookup(item.food_name);
    let kcal = 0, protein = 0, carbs = 0, fat = 0;
    if (food) {
      const f = amount / 100;
      kcal    = r_kcal(food.kcal_per_100g    * f);
      protein = round1(food.protein_per_100g * f);
      carbs   = round1(food.carbs_per_100g   * f);
      fat     = round1(food.fat_per_100g     * f);
    }
    add_em_item_row(item.food_name, amount, kcal, protein, carbs, fat);
  }
  update_meal_name_placeholder();
}

// Remember which recipe the current ingredient rows came from, so the meal name
// can be auto-derived from it (edits.txt #10). Only meaningful inside the meal
// editor (em-items); harmless elsewhere.
function _tag_recipe_name(name) {
  const tbody = document.getElementById('em-items');
  if (tbody) tbody.dataset.recipeName = name;
}


// Units offered for "Nährwerte je …". Grams are the canonical storage unit;
// everything else is a serving unit whose weight MAY be given (optional).
const FOOD_UNITS = ['g', 'Stk.', 'Scheibe', 'Handvoll', 'EL', 'TL', 'Portion', 'Dose/Glas'];

function _food_modal_body(f) {
  const name    = f ? esc(f.name) : '';
  const has_unit = !!(f && f.unit_name);
  // Editing a unit-based food: show the macros per 1 unit (that's how they
  // were entered), derived from the stored per-100g values.
  const to_unit = v => has_unit ? Math.round(v * ((f.unit_grams || 100) / 100) * 100) / 100 : v;
  const kcal    = f ? to_unit(f.kcal_per_100g)    : '';
  const protein = f ? to_unit(f.protein_per_100g) : '';
  const carbs   = f ? to_unit(f.carbs_per_100g)   : '';
  const fat     = f ? to_unit(f.fat_per_100g)     : '';
  const cur_unit = has_unit ? f.unit_name : 'g';
  const unit_opts = FOOD_UNITS.map(u =>
    `<option value="${u}" ${u === cur_unit ? 'selected' : ''}>${u}</option>`).join('')
    + (FOOD_UNITS.includes(cur_unit) ? '' : `<option value="${esc(cur_unit)}" selected>${esc(cur_unit)}</option>`);
  return `<form>
    <label>Name<input type="text" name="name" value="${name}" required></label>
    <label style="font-weight:600">Nährwerte je
      <input type="number" name="per_g" value="${has_unit ? 1 : 100}" min="0.1" step="any"
             style="display:inline-block;width:5rem;margin:0 .4rem"
             oninput="update_per_g_label()">
      <select name="per_unit" onchange="on_per_unit_change(this)"
              style="display:inline-block;width:auto;margin:0 .4rem;padding:.2rem 1.6rem .2rem .5rem">${unit_opts}</select>
      <span id="per-g-hint" style="font-weight:normal;color:var(--pico-muted-color);font-size:.85rem"></span>
    </label>
    <label id="unit-weight-field" ${has_unit ? '' : 'hidden'}>Gewicht je Einheit (g, optional)
      <input type="number" name="unit_weight" step="0.1" min="0"
             value="${f && f.unit_grams != null ? f.unit_grams : ''}"
             placeholder="leer = unbekannt, Angaben bleiben je Einheit">
    </label>
    <label>Kategorie
      <select name="category" onchange="on_category_change(this)">
        <option value="standard" ${!f || !f.category || f.category === 'standard' ? 'selected' : ''}>Standard — genaue Angaben</option>
        <option value="kalorien" ${f && f.category === 'kalorien' ? 'selected' : ''}>Kalorienfokus — energiedicht, Kalorien zählen</option>
        <option value="protein"  ${f && f.category === 'protein'  ? 'selected' : ''}>Proteinquelle — Eiweißbedarf decken</option>
        <option value="nebenbei" ${f && f.category === 'nebenbei' ? 'selected' : ''}>Nebenbei — geringe Energiedichte, Schätzung reicht</option>
      </select>
    </label>
    <div class="grid">
      <label>kcal<input type="number" name="kcal" step="0.01" value="${kcal}" required></label>
      <label>Eiweiß (g)<input type="number" name="protein" step="0.01" value="${protein}" required></label>
    </div>
    <div class="grid">
      <label>KH (g)<input type="number" name="carbs" step="0.01" value="${carbs}" required></label>
      <label>Fett (g)<input type="number" name="fat" step="0.01" value="${fat}" required></label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function on_per_unit_change(sel) {
  const form = sel.closest('form');
  form.querySelector('#unit-weight-field').hidden = (sel.value === 'g');
  update_per_g_label();
}

function update_per_g_label() {
  const hint = document.getElementById('per-g-hint');
  const form = hint && hint.closest('form');
  if (!form) return;
  const x    = parseFloat(form.querySelector('[name="per_g"]').value);
  const unit = form.querySelector('[name="per_unit"]').value;
  if (unit === 'g') {
    hint.textContent = (!isNaN(x) && x !== 100) ? '(wird auf 100 g umgerechnet)' : '';
  } else {
    hint.textContent = '(gespeichert je Einheit)';
  }
}

// "Nebenbei" (low energy density) → exact macros don't matter; dim the fields
// as a visual cue but keep them fully editable — rough values are welcome.
function on_category_change(sel) {
  const form     = sel.closest('form');
  const nebenbei = sel.value === 'nebenbei';
  ['kcal', 'protein', 'carbs', 'fat'].forEach(n => {
    const inp = form.querySelector(`[name="${n}"]`);
    if (nebenbei && inp.value === '') inp.value = 0;   // satisfy `required`
    inp.classList.toggle('macro-dim', nebenbei);
  });
}

function _food_macros_from_form(data) {
  const num  = v => { const f = parseFloat(v); return isNaN(f) ? 0 : f; };
  const unit = data.per_unit || 'g';
  let factor, unit_name = null, unit_grams = null;
  if (unit === 'g') {
    const x = parseFloat(data.per_g) || 100;
    factor  = 100 / x;
  } else {
    // Macros were entered per X units. If the unit weight is unknown we
    // normalise against a virtual 100 g per unit — meal entries in this unit
    // use the same basis (see _row_grams), so all math stays consistent.
    const x = parseFloat(data.per_g) || 1;
    const w = parseFloat(data.unit_weight);
    unit_name  = unit;
    unit_grams = (!isNaN(w) && w > 0) ? w : null;
    factor     = 100 / (x * (unit_grams || 100));
  }
  return {
    name:             data.name,
    kcal_per_100g:    num(data.kcal)    * factor,
    protein_per_100g: num(data.protein) * factor,
    carbs_per_100g:   num(data.carbs)   * factor,
    fat_per_100g:     num(data.fat)      * factor,
    unit_name,
    unit_grams,
    category:         data.category || 'standard',
  };
}

function _init_density_state() {
  const sel = document.querySelector('#modal-body [name="category"]');
  if (sel) on_category_change(sel);
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
  open_new_meal_for(today_local());
}

// "Tag hinzufügen": pick a day that has no entries yet, then open the meal
// editor for it. Meals themselves are added per day via "+ Mahlzeit".
// (Native date inputs can't grey individual dates, so existing days are
// rejected on submit instead.)
function open_add_day() {
  const existing = new Set(meals.map(m => m.date));
  const def = today_local();
  const days_hint = existing.size
    ? `Bereits vorhanden: ${[...existing].sort((a, b) => b.localeCompare(a)).slice(0, 8).join(', ')}${existing.size > 8 ? ' …' : ''}`
    : '';
  open_modal('Tag hinzufügen', `<form>
    <label>Neuer Tag
      <input type="date" name="date" value="${existing.has(def) ? '' : def}" required>
      <small style="color:var(--pico-muted-color)">
        Vorhandene Tage bitte beim jeweiligen Tag über „+ Mahlzeit" ergänzen.<br>${days_hint}
      </small>
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Weiter</button>
    </div>
  </form>`, data => {
    if (!data.date) throw new Error('Bitte ein Datum wählen.');
    if (existing.has(data.date))
      throw new Error('Dieser Tag existiert bereits — bitte über „+ Mahlzeit" ergänzen.');
    // open the meal editor for the new day once this dialog has closed
    setTimeout(() => open_new_meal_for(data.date), 0);
  });
}

// Meal-name suggestions: recipe names only. Picking a recipe name offers to
// pull in its ingredients directly.
function _mealname_datalist_html() {
  return `<datalist id="mealnames-datalist">
    ${recipes.map(r => `<option value="${esc(r.name)}">`).join('')}
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
    <label style="margin-bottom:.5rem">Datum
      <input type="date" id="em-date" value="${date}" readonly
             title="Der Tag wird über „+ Tag hinzufügen" bzw. „+ Mahlzeit" bestimmt">
    </label>

    <button type="button" class="em-recipe-btn" onclick="open_add_recipe_to_meal()">
      🍽️ Aus Rezept hinzufügen…
    </button>

    ${meals.length ? `
    <details style="margin-bottom:.75rem">
      <summary style="cursor:pointer;color:var(--pico-primary);font-size:.9rem;user-select:none">
        Mahlzeit kopieren…
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
              onclick="add_em_skip_row()" title="Einmalige Zutat — nicht in Lebensmitteldatenbank speichern und nicht daraus vorschlagen">+ Einmalig</button>
    </div>
    <hr style="margin:.25rem 0 .75rem">
    <label style="margin-bottom:.5rem">Name <small style="color:var(--pico-muted-color)">(optional)</small>
      <input type="text" id="em-name" placeholder="wird automatisch aus den Zutaten gebildet"
             list="mealnames-datalist" onchange="on_meal_name_change(this)">
    </label>
    ${_mealname_datalist_html()}
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" id="em-save-btn" onclick="save_new_meal()">Speichern</button>
    </div>`;

  open_modal('Neue Mahlzeit', body, null);
}

// Auto-derived meal name (edits.txt #10): a recipe import uses the recipe name;
// a single ingredient uses that ingredient's name; otherwise the ingredient
// names are concatenated. Used both as the live placeholder and as the fallback
// when the user leaves the name blank.
function _derive_meal_name() {
  const tbody = document.getElementById('em-items');
  if (!tbody) return '';
  if (tbody.dataset.recipeName) return tbody.dataset.recipeName;
  const names = [...tbody.querySelectorAll('[name="food_name"]')]
    .map(i => i.value.trim()).filter(Boolean);
  if (names.length === 1) return names[0];
  if (names.length > 1)  return names.join(', ');
  return '';
}

function update_meal_name_placeholder() {
  const inp = document.getElementById('em-name');
  if (!inp) return;
  const derived = _derive_meal_name();
  inp.placeholder = derived || 'wird automatisch aus den Zutaten gebildet';
}

// Unit <select> options for a row: the full serving-unit list (g, Stk., …),
// plus the food's own custom unit if it isn't already one of them.
function _unit_options_html(food, selected = 'g') {
  const units = [...FOOD_UNITS];
  if (food && food.unit_name && !units.includes(food.unit_name)) units.push(food.unit_name);
  return units.map(u => `<option value="${esc(u)}" ${u === selected ? 'selected' : ''}>${esc(u)}</option>`).join('');
}

// Amount of a row in grams. Only 'g' and the food's OWN serving unit convert
// (its weight, or a virtual 100 g if none is set). Any other unit has no known
// grams-per-unit → NaN, and the macros are entered manually for that item.
function _row_grams(row) {
  const val = parseFloat(row.querySelector('[name="amount_grams"]').value);
  if (isNaN(val)) return NaN;
  const unit = row.querySelector('[name="unit"]').value;
  if (unit === 'g') return val;
  if (unit === row.dataset.unitName) {
    const ug = parseFloat(row.dataset.unitGrams);
    return val * (isNaN(ug) ? 100 : ug);
  }
  return NaN;
}

function on_unit_change(sel) {
  const row = sel.closest('tr');
  row.dataset.unitManual = '1';                       // respect the user's choice from now on
  if (row.dataset.per100kcal === undefined) return;   // one-time item → macros are manual
  const g = _row_grams(row);
  if (!isNaN(g)) {
    _set_macros_readonly(row, true);                  // convertible → auto-compute
    if (g > 0) _recalc_macros(row, g);
  } else {
    _set_macros_readonly(row, false);                 // no conversion → enter macros by hand
  }
}

function _item_row_html(item_id, food_name = '', amount = '', kcal = '', protein = '', carbs = '', fat = '', per100 = null, skip_db = false, unit = 'g') {
  // Keep field values at the display precision so step-constrained inputs accept them.
  const _rv = (v, f) => (v === '' || v == null) ? '' : f(v);
  kcal = _rv(kcal, r_kcal); protein = _rv(protein, r_nut); carbs = _rv(carbs, r_nut); fat = _rv(fat, r_nut);
  const food = food_name ? _food_lookup(food_name) : null;
  const pa   = per100 ? ` data-per100kcal="${per100.kcal}" data-per100protein="${per100.protein}" data-per100carbs="${per100.carbs}" data-per100fat="${per100.fat}"` : '';
  const ug   = (food && food.unit_grams) ? ` data-unit-grams="${food.unit_grams}"` : '';
  const un   = (food && food.unit_name)  ? ` data-unit-name="${esc(food.unit_name)}"` : '';
  const skip_attr  = skip_db ? ' data-skip-db="true"' : '';
  const badge_cls  = skip_db ? 'skip' : (per100 ? 'match' : (food_name ? 'new' : ''));
  const badge_text = skip_db ? 'einmalig' : (per100 ? '✓' : (food_name ? 'neu' : ''));
  return `<tr data-item-id="${item_id}"${pa}${ug}${un}${skip_attr}>
    <td style="white-space:nowrap">
      <input type="text" name="food_name" value="${esc(food_name)}" placeholder="Lebensmittel"
             ${skip_db ? 'oninput="update_meal_name_placeholder()"' : 'list="foods-datalist" oninput="on_food_name_change(this)" onchange="on_food_name_change(this)"'}
             style="margin:0;min-width:8rem;display:inline-block;width:auto">
      <span class="food-badge ${badge_cls}">${badge_text}</span>
    </td>
    <td style="white-space:nowrap">
      <input type="number" name="amount_grams" value="${amount}" step="any" min="0" placeholder="Menge"
             oninput="on_amount_change(this)" style="margin:0;width:4.5rem;display:inline-block">
      <select name="unit" onchange="on_unit_change(this)"
              style="margin:0;width:auto;display:inline-block;padding:.2rem 1.4rem .2rem .4rem">${_unit_options_html(food, unit)}</select>
    </td>
    <td><input type="number" name="kcal"         value="${kcal}"     step="1"   placeholder="kcal" style="margin:0;width:4.5rem" ${per100 ? 'readonly class="macro-auto"' : ''}></td>
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
  update_meal_name_placeholder();
}

function add_em_skip_row() {
  const tbody = document.getElementById('em-items');
  tbody.insertAdjacentHTML('beforeend', _item_row_html('new', '', '', '', '', '', '', null, true));
  tbody.lastElementChild.querySelector('input').focus();
  update_meal_name_placeholder();
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
  update_meal_name_placeholder();
}

async function save_new_meal() {
  const date = document.getElementById('em-date').value;
  const name = document.getElementById('em-name').value.trim() || _derive_meal_name();
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
      const g = _row_grams(row);
      const unit = row.querySelector('[name="unit"]').value;
      const raw  = parseFloat(row.querySelector('[name="amount_grams"]').value);
      const m = _row_macros_for_save(row);
      return api('POST', `/api/meals/${session_id}/items`, {
        food_name,
        amount_grams: isNaN(g) ? null : g,
        kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g,
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
               placeholder="z.B. Chili oder Rezeptname" list="mealnames-datalist" onchange="on_meal_name_change(this)">
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

      if (!food_name) continue; // skip blank rows

      const g    = _row_grams(row);
      const unit = row.querySelector('[name="unit"]').value;
      const raw  = amount_raw ? parseFloat(amount_raw) : NaN;
      const m    = _row_macros_for_save(row);
      const payload = {
        food_name,
        amount_grams: isNaN(g) ? null : g,
        kcal:      m.kcal,
        protein_g: m.protein_g,
        carbs_g:   m.carbs_g,
        fat_g:     m.fat_g,
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
  const today = today_local();
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
  const today = today_local();
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
  const today = today_local();
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
  const today = today_local();
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
  on_ana_type_change();   // populate series + plot dropdowns for the current Typ, then draw
}

// Plots available per Typ (dropdown 3 depends on dropdown 1).
const ANA_KINDS = {
  uebung:  [['verlauf', 'Gewichts-Verlauf'], ['volumen', 'Volumen pro Woche'],
            ['volumen_workout', 'Volumen pro Workout'], ['reps', 'Wiederholungen']],
  muskel:  [['sets_workout', 'Sätze pro Workout']],
  koerper: [['koerper', 'Verlauf']],
};

// Dropdown 1 (Typ) changed → repopulate dropdowns 2 (series) and 3 (plot).
function on_ana_type_change() {
  const type = document.getElementById('ana-type').value;
  _fill_analysis_series(type);
  _fill_analysis_kind(type);
  // Körpergewicht has no sub-selection → hide the series picker
  const field = document.getElementById('ana-series-field');
  if (field) field.style.display = (type === 'koerper') ? 'none' : '';
  render_analysis();
}

function _fill_analysis_kind(type) {
  const sel = document.getElementById('ana-kind');
  const prev = sel.value;
  sel.innerHTML = (ANA_KINDS[type] || []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function _fill_analysis_series(type) {
  const sel = document.getElementById('ana-series');
  const prev = sel.value;
  if (type === 'muskel') {
    const groups = _all_muscle_groups();
    const muscles = _all_muscles();
    if (!groups.length && !muscles.length) {
      sel.innerHTML = '<option value="">— keine Muskeln hinterlegt —</option>';
    } else {
      const gOpts = groups.map(g => `<option value="mg:${esc(g)}">${esc(g)}</option>`).join('');
      const mOpts = muscles.map(m => `<option value="mu:${esc(m)}">${esc(m)}</option>`).join('');
      sel.innerHTML =
        (gOpts ? `<optgroup label="Muskelgruppe">${gOpts}</optgroup>` : '') +
        (mOpts ? `<optgroup label="Muskel">${mOpts}</optgroup>` : '');
    }
  } else if (type === 'koerper') {
    sel.innerHTML = '<option value="bw">Körpergewicht</option>';
  } else {   // uebung — Kraftübungen only (Dehnübungen aren't plotted)
    const names = new Set();
    for (const s of workouts) for (const ex of s.exercises)
      if (_is_strength_ex(ex.exercise_name)) names.add(ex.exercise_name);
    sel.innerHTML = [...names].sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="ex:${esc(n)}">${esc(n)}</option>`).join('')
      || '<option value="">— keine Kraftübungen —</option>';
  }
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// An exercise counts as a Kraftübung unless explicitly flagged Dehnübung.
function _is_strength_ex(name) {
  const m = _exercise_meta(name);
  return !m || m.is_strength !== 0;
}

// Date range across ALL workouts — used so every time axis spans the full
// training history by default (not just the selected series' active range).
function _workout_date_range() {
  if (!workouts.length) return null;
  let min = workouts[0].date, max = workouts[0].date;
  for (const s of workouts) { if (s.date < min) min = s.date; if (s.date > max) max = s.date; }
  return { min, max };
}

function _bw_hint(name) {
  return `<p class="empty">„${esc(name)}" ist eine reine Körpergewichtsübung — ` +
         `kein Gewicht/Volumen verfügbar. Bitte „Wiederholungen" wählen.</p>`;
}

// Dispatch: Typ + Plot decide which chart to draw.
// Custom x-axis (time) window; null = full workout history.
let ana_x_range = null;

function _effective_range() {
  return ana_x_range || _workout_date_range();
}

// Drop bars outside the active range (bars carry a full `date`).
function _range_bars(res) {
  if (!ana_x_range || !res || !res.bars) return res;
  const { min, max } = ana_x_range;
  return { ...res, bars: res.bars.filter(b => b.date >= min && b.date <= max) };
}

function render_analysis() {
  const el   = document.getElementById('analysis-chart');
  const type = document.getElementById('ana-type')?.value || 'uebung';
  const kind = document.getElementById('ana-kind')?.value || 'verlauf';
  const ser  = document.getElementById('ana-series')?.value || '';
  const range = _effective_range();

  if (type === 'koerper') {
    render_line_chart(el, _bodyweight_points(), 'Körpergewicht', ana_x_range || undefined);
  } else if (type === 'muskel') {
    if (!ser.startsWith('mg:') && !ser.startsWith('mu:')) {
      el.innerHTML = '<p class="empty">Keine Muskelgruppe/Muskeln hinterlegt — bitte im Übungen-Tab eintragen.</p>';
    } else {
      const is_group = ser.startsWith('mg:');
      const what = ser.slice(3);
      render_stacked_bars(el, _range_bars(_stacked_sets(ser)),
        `Sätze pro Workout — ${is_group ? 'Gruppe' : 'Muskel'}: ${esc(what)}`);
    }
  } else if (!ser.startsWith('ex:')) {
    el.innerHTML = '<p class="empty">Bitte eine Übung wählen.</p>';
  } else {
    const name  = ser.slice(3);
    const is_bw = _is_bodyweight(name);
    if (kind === 'reps') {
      render_line_chart(el, _reps_points(name), 'Wiederholungen: ' + name, range);
    } else if (is_bw) {
      el.innerHTML = _bw_hint(name);
    } else if (kind === 'verlauf') {
      render_line_chart(el, _weight_points(name), 'Gewichts-Verlauf: ' + name, range);
    } else if (kind === 'volumen') {
      _render_bars(el, _range_bars(_volume_weeks(name)), 'Wöchentliches Volumen', '');
    } else if (kind === 'volumen_workout') {
      _render_bars(el, _range_bars(_volume_all_workouts(name)), 'Volumen pro Workout', '');
    }
  }
  _render_range_bar();
}

// ── x-axis range control (small button under the chart) ──
function _render_range_bar() {
  const bar = document.getElementById('ana-range-bar');
  if (!bar) return;
  const eff = _effective_range();
  const label = eff ? `${eff.min} – ${eff.max}` : 'ganzer Zeitraum';
  bar.innerHTML =
    `<button class="outline secondary" style="width:auto;margin:0;font-size:.8rem" onclick="open_range_picker()">📅 Zeitraum: ${label}</button>` +
    (ana_x_range ? ` <button class="outline secondary" style="width:auto;margin:0;font-size:.8rem" onclick="reset_range()">Ganzer Zeitraum</button>` : '');
}

function open_range_picker() {
  const eff = _effective_range() || { min: '', max: '' };
  open_modal2('Zeitraum anpassen', `<div>
    <div class="grid">
      <label>Von<input type="date" id="ana-range-from" value="${eff.min}"></label>
      <label>Bis<input type="date" id="ana-range-to"   value="${eff.max}"></label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal2()">Abbrechen</button>
      <button type="button" onclick="apply_range()">Übernehmen</button>
    </div>
  </div>`);
}

function apply_range() {
  const from = document.getElementById('ana-range-from').value;
  const to   = document.getElementById('ana-range-to').value;
  if (!from || !to) { alert('Bitte Von und Bis wählen.'); return; }
  ana_x_range = from <= to ? { min: from, max: to } : { min: to, max: from };
  close_modal2();
  render_analysis();
}

function reset_range() { ana_x_range = null; render_analysis(); }

// True if the exercise entry has at least one real (non-null) weight value.
function _has_weight(ex) {
  if (!ex.weight_kg) return false;
  return JSON.parse(ex.weight_kg).some(v => v != null);
}

// An exercise is pure bodyweight if it never had an added-weight set.
function _is_bodyweight(name) {
  for (const s of workouts)
    for (const ex of s.exercises)
      if (ex.exercise_name === name && _has_weight(ex)) return false;
  return true;
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

// Body weight: single-series line, latest entry per date, in kg.
function _bodyweight_points() {
  const by_date = new Map();
  for (const w of [...body_weight].reverse()) by_date.set(w.date, w.weight_kg);
  const points = [...by_date.entries()]
    .map(([date, v]) => ({ date, avg: v, max: v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { points, unit: 'kg', single: true };
}

// Weight progression for an exercise: max = heaviest set that day, avg = mean
// over all sets that day, in the series' original entry unit (as logged).
// Bodyweight sets (no added weight) count as 0 — so a partially-weighted
// exercise (e.g. Situps) shows the BW workouts as zero rather than skipping them.
function _weight_points(name) {
  const unit = _series_unit(name);
  const by_date = new Map();               // date -> flat list of set weights
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name) continue;
      const nsets = ex.sets || JSON.parse(ex.reps_per_set).length;
      let vals;
      if (_has_weight(ex)) {
        const raw = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
        vals = JSON.parse(raw).map(v => v ?? 0);   // BW sets within the entry → 0
      } else {
        vals = Array(nsets).fill(0);               // whole entry was bodyweight → 0
      }
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

// Total reps of an exercise per workout date — a single-series line, drawn
// exactly like the weight progression. Works for any exercise (incl. BW).
function _reps_points(name) {
  const by_date = new Map();
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name) continue;
      const reps = JSON.parse(ex.reps_per_set).reduce((a, r) => a + (r || 0), 0);
      by_date.set(s.date, (by_date.get(s.date) || 0) + reps);
    }
  }
  const points = [...by_date.entries()]
    .map(([date, v]) => ({ date, avg: v, max: v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { points, unit: 'Wdh', single: true };
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

// ISO week of a YYYY-MM-DD date; key sorts correctly across years.
function _iso_week(date_str) {
  const d = new Date(date_str + 'T00:00:00');
  const t = new Date(d);
  t.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));   // Thursday of that week
  const week1 = new Date(t.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return { key: `${t.getFullYear()}-W${String(wk).padStart(2, '0')}`, label: `KW${wk}`, thursday: t };
}

// Volume of one workout_exercise entry.
// Weighted: Σ reps × weight (per-side weights count double). Bodyweight: Σ reps.
function _exercise_volume(ex, is_bw, unit, mult) {
  const reps = JSON.parse(ex.reps_per_set);
  if (is_bw) return reps.reduce((a, r) => a + (r || 0), 0);
  if (!_has_weight(ex)) return 0;
  const raw = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
  if (!raw) return 0;
  const w = JSON.parse(raw);
  let v = 0;
  for (let i = 0; i < reps.length; i++) v += (reps[i] || 0) * ((w[i] ?? 0) * mult);
  return v;
}

// Weekly training volume for a (weighted) exercise. The week axis spans the
// full workout history (first→last workout week); untrained weeks show zero.
function _volume_weeks(name) {
  const unit  = `${_series_unit(name)}×Wdh`;
  const wunit = _series_unit(name);
  const mult  = _is_per_hand(name) ? 2 : 1;
  const by_week = new Map();
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name) continue;
      const vol = _exercise_volume(ex, false, wunit, mult);
      if (vol <= 0) continue;
      const wk = _iso_week(s.date);
      by_week.set(wk.key, (by_week.get(wk.key) || 0) + vol);
    }
  }
  const range = _workout_date_range();
  if (!range) return { bars: [], unit };
  const local_iso = t =>
    `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const bars = [];
  const end = _iso_week(range.max).thursday;
  for (let t = _iso_week(range.min).thursday; t <= end; t.setDate(t.getDate() + 7)) {
    const iso = local_iso(t);
    const wk = _iso_week(iso);
    const value = Math.round(by_week.get(wk.key) || 0);
    bars.push({ label: wk.label, value, date: iso, title: `${wk.key}: ${value} ${unit}` });
  }
  return { bars, unit };
}

// Every workout session sorted oldest→newest (one bar per session).
function _all_sessions_sorted() {
  return [...workouts].sort((a, b) => a.date.localeCompare(b.date) || (a.id - b.id));
}

// Volume for a (weighted) exercise, one bar per workout — INCLUDING workouts
// where the exercise wasn't trained (empty bar).
function _volume_all_workouts(name) {
  const unit  = `${_series_unit(name)}×Wdh`;
  const wunit = _series_unit(name);
  const mult  = _is_per_hand(name) ? 2 : 1;
  const short = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  const bars = _all_sessions_sorted().map(s => {
    let v = 0;
    for (const ex of s.exercises)
      if (ex.exercise_name === name) v += _exercise_volume(ex, false, wunit, mult);
    v = Math.round(v);
    return { label: short(s.date), value: v, date: s.date, title: `${s.date}: ${v} ${unit}` };
  });
  return { bars, unit };
}

// Muscle groups actually assigned to Kraftübungen (the fixed Gruppe field).
function _all_muscle_groups() {
  const set = new Set();
  for (const e of exercise_catalog)
    if (e.is_strength !== 0 && e.muscle_group) set.add(e.muscle_group);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Distinct Hauptmuskeln across Kraftübungen (muscle plotting uses Hauptmuskel only).
function _all_muscles() {
  const set = new Set();
  for (const e of exercise_catalog) {
    if (e.is_strength === 0 || !e.muscles) continue;
    e.muscles.split(',').map(m => m.trim()).filter(Boolean).forEach(m => set.add(m));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Exercise names (Kraftübungen) matching a selector: 'mg:Group' → by Gruppe,
// 'mu:Muscle' → the muscle is that exercise's Hauptmuskel (Nebenmuskeln ignored).
function _exercises_for_selector(sel) {
  const key = sel.slice(3).trim().toLowerCase();
  const names = new Set();
  for (const e of exercise_catalog) {
    if (e.is_strength === 0) continue;
    let hit = false;
    if (sel.startsWith('mg:')) {
      hit = e.muscle_group && e.muscle_group.toLowerCase() === key;
    } else {
      hit = e.muscles && e.muscles.split(',').map(m => m.trim().toLowerCase()).includes(key);
    }
    if (hit) names.add(e.name);
  }
  return names;
}

// Sets per workout for a group/muscle, broken down (stacked) by exercise.
// Every workout is a bar; exercises are the stack segments. Returns
// { bars:[{label,date,total,segments:{exName:sets}}], series:[{key,label,color}], unit }.
function _stacked_sets(sel) {
  const names = _exercises_for_selector(sel);
  const totals = new Map();               // exercise → total sets (for ordering/colours)
  const bars = _all_sessions_sorted().map(s => {
    const segments = {};
    let total = 0;
    for (const ex of s.exercises) {
      if (!names.has(ex.exercise_name)) continue;
      const sets = ex.sets || JSON.parse(ex.reps_per_set).length;
      segments[ex.exercise_name] = (segments[ex.exercise_name] || 0) + sets;
      total += sets;
      totals.set(ex.exercise_name, (totals.get(ex.exercise_name) || 0) + sets);
    }
    return { label: `${s.date.slice(8, 10)}.${s.date.slice(5, 7)}.`, date: s.date, total, segments };
  });
  // Colour follows the exercise (entity), fixed order by total sets desc.
  // Beyond the palette size, fold the rest into "Other".
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const series = [];
  ranked.slice(0, ANA_PALETTE.length).forEach((n, i) => series.push({ key: n, label: n, color: ANA_PALETTE[i] }));
  if (ranked.length > ANA_PALETTE.length) {
    const others = new Set(ranked.slice(ANA_PALETTE.length));
    series.push({ key: '__other__', label: 'Weitere', color: ANA_OTHER });
    for (const b of bars) {
      let o = 0;
      for (const n of others) { if (b.segments[n]) { o += b.segments[n]; delete b.segments[n]; } }
      if (o) b.segments['__other__'] = o;
    }
  }
  return { bars, series, unit: 'Sätze' };
}

// Generic vertical bar chart. bars: [{label, value, title}].
function _render_bars(el, res, caption, empty_msg) {
  if (res === null) { el.innerHTML = `<p class="empty">${empty_msg}</p>`; return; }
  const { bars, unit } = res;
  if (!bars.length) { el.innerHTML = '<p class="empty">Keine Daten für diese Auswahl vorhanden.</p>'; return; }

  const { W, H, top, right, bottom, left } = _ANA;
  const iw = W - left - right, ih = H - top - bottom;
  const ticks = _nice_ticks(0, Math.max(...bars.map(b => b.value)));
  const y_max = ticks[ticks.length - 1] || 1;
  const Y = v => top + ih - (v / y_max) * ih;

  const n    = bars.length;
  const slot = iw / n;
  const bw   = Math.min(slot * 0.62, 64);
  const grid = ticks.map(v =>
    `<line x1="${left}" y1="${Y(v)}" x2="${left + iw}" y2="${Y(v)}" stroke="var(--ana-grid)" stroke-width="1"/>
     <text x="${left - 8}" y="${Y(v) + 4}" text-anchor="end" class="ana-tick">${v}</text>`).join('');
  const lbl_every = Math.ceil(n / 12);
  const svg_bars = bars.map((b, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    const y = Y(b.value);
    const lbl = i % lbl_every === 0
      ? `<text x="${left + i * slot + slot / 2}" y="${top + ih + 22}" text-anchor="middle" class="ana-tick">${esc(b.label)}</text>` : '';
    const val = (n <= 14 && b.value > 0)
      ? `<text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" class="ana-endlabel">${b.value}</text>` : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(top + ih - y).toFixed(1)}"
                  fill="var(--ana-series)" rx="2"><title>${esc(b.title)}</title></rect>${val}${lbl}`;
  }).join('');

  el.innerHTML = `
    <p class="chart-caption">${caption} &mdash; Einheit: <strong>${esc(unit)}</strong></p>
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${caption}" style="width:100%;height:auto;display:block">
        <rect x="0" y="0" width="${W}" height="${H}" fill="var(--ana-surface)"/>
        ${grid}
        <line x1="${left}" y1="${top + ih}" x2="${left + iw}" y2="${top + ih}" stroke="var(--ana-axis)" stroke-width="1"/>
        ${svg_bars}
      </svg>
    </div>
    <details style="margin-top:.75rem">
      <summary style="cursor:pointer;font-size:.9rem;color:var(--pico-muted-color)">Datentabelle</summary>
      <figure><table style="font-size:.85rem">
        <thead><tr><th>x</th><th>${esc(unit)}</th></tr></thead>
        <tbody>${bars.map(b => `<tr><td>${esc(b.label)}</td><td>${b.value}</td></tr>`).join('')}</tbody>
      </table></figure>
    </details>`;
}

// Validated categorical palette (light mode) from the data-viz reference.
// Colour follows the entity; assigned in fixed order, never cycled.
const ANA_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
                     '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const ANA_OTHER = '#898781';

// Stacked bar chart: one bar per workout, segments coloured by exercise.
// res = { bars:[{label,date,total,segments}], series:[{key,label,color}], unit }.
function render_stacked_bars(el, res, caption) {
  const { bars, series, unit } = res;
  if (!bars || !bars.length || !series.length) {
    el.innerHTML = '<p class="empty">Keine Daten für diese Auswahl vorhanden.</p>';
    return;
  }
  const { W, H, top, right, bottom, left } = _ANA;
  const iw = W - left - right, ih = H - top - bottom;
  const ticks = _nice_ticks(0, Math.max(1, ...bars.map(b => b.total)));
  const y_max = ticks[ticks.length - 1] || 1;
  const Y = v => top + ih - (v / y_max) * ih;

  const n    = bars.length;
  const slot = iw / n;
  const bw   = Math.min(slot * 0.62, 64);
  const grid = ticks.map(v =>
    `<line x1="${left}" y1="${Y(v)}" x2="${left + iw}" y2="${Y(v)}" stroke="var(--ana-grid)" stroke-width="1"/>
     <text x="${left - 8}" y="${Y(v) + 4}" text-anchor="end" class="ana-tick">${v}</text>`).join('');
  const lbl_every = Math.ceil(n / 12);

  const svg_bars = bars.map((b, i) => {
    const x = left + i * slot + (slot - bw) / 2;
    let acc = 0;                                  // running total from the baseline up
    const segs = series.filter(s => b.segments[s.key]).map(s => {
      const val = b.segments[s.key];
      const y0 = Y(acc), y1 = Y(acc + val);
      acc += val;
      const h = Math.max(0, y0 - y1 - 2);         // 2px surface gap between segments
      return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"
                    fill="${s.color}" rx="2"><title>${esc(b.date)} · ${esc(s.label)}: ${val} Sätze</title></rect>`;
    }).join('');
    const lbl = i % lbl_every === 0
      ? `<text x="${left + i * slot + slot / 2}" y="${top + ih + 22}" text-anchor="middle" class="ana-tick">${esc(b.label)}</text>` : '';
    const tot = (n <= 14 && b.total > 0)
      ? `<text x="${x + bw / 2}" y="${(Y(b.total) - 5).toFixed(1)}" text-anchor="middle" class="ana-endlabel">${b.total}</text>` : '';
    return segs + lbl + tot;
  }).join('');

  const legend = `<div class="ana-legend">${series.map(s =>
    `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;

  // Data table: exercises as columns
  const head = `<tr><th>Datum</th>${series.map(s => `<th>${esc(s.label)}</th>`).join('')}</tr>`;
  const body = bars.map(b =>
    `<tr><td>${esc(b.date)}</td>${series.map(s => `<td>${b.segments[s.key] || 0}</td>`).join('')}</tr>`).join('');

  el.innerHTML = `
    <p class="chart-caption">${caption} &mdash; Einheit: <strong>${esc(unit)}</strong>, gestapelt nach Übung</p>
    ${legend}
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${caption}" style="width:100%;height:auto;display:block">
        <rect x="0" y="0" width="${W}" height="${H}" fill="var(--ana-surface)"/>
        ${grid}
        <line x1="${left}" y1="${top + ih}" x2="${left + iw}" y2="${top + ih}" stroke="var(--ana-axis)" stroke-width="1"/>
        ${svg_bars}
      </svg>
    </div>
    <details style="margin-top:.75rem">
      <summary style="cursor:pointer;font-size:.9rem;color:var(--pico-muted-color)">Datentabelle</summary>
      <figure><table style="font-size:.8rem"><thead>${head}</thead><tbody>${body}</tbody></table></figure>
    </details>`;
}

// Step path: horizontal to the next x first, then vertical to its y (no
// linear interpolation between points).
function _step_path(px, key) {
  return px.map((p, i) => i
    ? `H${p.x.toFixed(1)} V${p[key].toFixed(1)}`
    : `M${p.x.toFixed(1)},${p[key].toFixed(1)}`).join(' ');
}

// Line chart for a points-result {points:[{date,avg,max}], unit, single}.
// x_range (optional {min,max} dates) fixes the time axis — e.g. the full
// workout history — instead of auto-fitting to the data points.
function render_line_chart(el, res, label, x_range) {
  const { unit, single } = res;
  // Drop points outside a custom window (a full-range x_range keeps them all).
  const pts = x_range
    ? res.points.filter(p => p.date >= x_range.min && p.date <= x_range.max)
    : res.points;

  if (pts.length === 0) {
    el.innerHTML = '<p class="empty">Keine Daten für diese Auswahl vorhanden.</p>';
    return;
  }

  const { W, H, top, right, bottom, left } = _ANA;
  const iw = W - left - right, ih = H - top - bottom;

  const ts     = pts.map(p => new Date(p.date + 'T00:00:00').getTime());
  const t_min  = x_range ? new Date(x_range.min + 'T00:00:00').getTime() : Math.min(...ts);
  const t_max  = x_range ? new Date(x_range.max + 'T00:00:00').getTime() : Math.max(...ts);
  const t_span = Math.max(t_max - t_min, 1);
  const vals   = pts.flatMap(p => single ? [p.max] : [p.avg, p.max]);
  const ticks  = _nice_ticks(Math.min(...vals), Math.max(...vals));
  const y_min  = ticks[0], y_max = ticks[ticks.length - 1];

  const X = t => left + ((t - t_min) / t_span) * iw;
  const Y = v => top + ih - ((v - y_min) / (y_max - y_min || 1)) * ih;

  const px = pts.map((p, i) => ({
    ...p,
    x:  (pts.length === 1 && !x_range) ? left + iw / 2 : X(ts[i]),
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
load_settings().then(load_meals).then(auto_sync_on_start);   // targets before rendering; sync after
load_exercise_catalog();
_init_photo_dropzone();
// foods_db / body / analysis data loaded on demand when their tab is opened
