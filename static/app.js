'use strict';

// ─── State ────────────────────────────────────────────────────────────────
let workouts  = [];
let endurance = [];
let sports    = [];
let meals     = [];
let sleep_log = [];
let empty_days = [];   // dates added to the diary that have no meal yet
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
  if (!resp.ok) {
    // FastAPI reports errors as {"detail": "..."} — surface just that text so
    // the user sees the message instead of raw JSON.
    const raw = await resp.text();
    let msg = raw;
    try {
      const d = JSON.parse(raw).detail;
      if (typeof d === 'string') msg = d;
    } catch { /* not JSON — show it as-is */ }
    throw new Error(msg);
  }
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

// Per-set hold times for isometric exercises: "30 s" or "30, 25, 20 s".
function fmt_hold_times(dur_json) {
  if (!dur_json) return '';
  const d = JSON.parse(dur_json).map(v => v == null ? 0 : v);
  const unique = [...new Set(d)];
  return (unique.length === 1 ? String(d[0]) : d.join(', ')) + ' s';
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
// Local date `days` away from today as YYYY-MM-DD; Date handles month/year
// rollover, so -1 on the 1st lands on the last day of the previous month.
function date_offset_local(days = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function today_local() { return date_offset_local(0); }

// Format an ISO date (YYYY-MM-DD) as German dd.mm.yyyy for display. Inputs that
// aren't a full ISO date are returned unchanged.
function fmt_de(iso) {
  return (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso))
    ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
    : (iso ?? '');
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
    if (link.dataset.tab === 'sleep')    load_sleep();
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
  const iso = ex && !!_exercise_meta(ex.exercise_name)?.is_isometric;
  const dur_val = ex && ex.duration_s
    ? esc(JSON.parse(ex.duration_s).map(v => v == null ? '' : v).join(','))
    : '';
  return `<form>
    <label>Übung
      <input type="text" name="exercise_name" list="exercises-datalist"
             value="${ex ? esc(ex.exercise_name) : ''}"
             placeholder="z.B. Bankdrücken" required
             onchange="on_ex_name_change(this)">
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
    <label id="ex-duration-box" style="display:${iso ? 'block' : 'none'};margin-bottom:.5rem">
      Dauer pro Satz (Sekunden) &mdash; für isometrische Übungen
      <input type="text" name="duration_str" value="${dur_val}"
             placeholder="30  oder  30,25,20">
    </label>
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

// Exercise chosen in the log form → refresh its history and reveal the duration
// field for isometric exercises (held for time).
function on_ex_name_change(input) {
  update_exercise_history(input.value);
  const box = document.getElementById('ex-duration-box');
  if (box) box.style.display = _exercise_meta(input.value)?.is_isometric ? 'block' : 'none';
  _prefill_from_last_entry(input);
}

// Picking a known exercise prefills Sätze/Reps/Gewicht from the last time it
// was logged (same as the plan editor). Only empty fields are touched, so
// editing an existing entry never clobbers what is already there.
function _prefill_from_last_entry(input) {
  const form = input.closest('form');
  if (!form) return;
  const last = _last_workout_entry(input.value);
  if (!last) return;
  const fill = (name, val) => {
    const f = form.querySelector(`[name="${name}"]`);
    if (!f || f.value || val == null || val === '') return false;
    f.value = val;
    return true;
  };
  fill('sets', last.sets);
  fill('reps_str', last.reps_str);
  // Only adopt the unit when the weight itself was prefilled.
  if (fill('weight_str', last.weight_str)) {
    const unit = form.querySelector('[name="weight_unit"]');
    if (unit) unit.value = last.unit;
  }
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
        <td style="white-space:nowrap">${fmt_de(s.date)}</td>
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
          <strong>${fmt_de(s.date)}</strong>
          ${s.comment ? `<small style="margin-left:.5rem">${esc(s.comment)}</small>` : ''}
          <small style="margin-left:.5rem;color:var(--pico-muted-color)">
            (${s.exercises.length} Übung${s.exercises.length !== 1 ? 'en' : ''})
          </small>
        </span>
        <div>
          <button class="outline secondary" title="Kopieren" onclick="copy_workout(${s.id})">&#10064;</button>
          <button class="outline secondary" title="Als Text exportieren"
                  onclick="open_export_text('workout',${s.id})">&#128203;</button>
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
            <td>${_is_isometric_ex(ex.exercise_name) && ex.duration_s ? esc(fmt_hold_times(ex.duration_s)) + ' &nbsp;' : ''}${fmt_weight(ex.weight_kg, ex.weight_lbs, _is_per_hand(ex.exercise_name))}</td>
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
          <strong>${fmt_de(s.date)}</strong>
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
          <strong>${fmt_de(s.date)}</strong>
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
  if (!confirm(`Session vom ${fmt_de(s.date)} und alle ${s.exercises.length} Übung(en) löschen?`)) return;
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
// The per-exercise comment is deliberately NOT copied — it describes that one
// session ("letzter Satz abgebrochen"), not the exercise itself.
function _exercise_copy_payload(ex) {
  const unit = pick_weight_unit(ex);
  const raw  = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
  const w    = raw ? JSON.parse(raw) : null;
  const dur  = ex.duration_s ? JSON.parse(ex.duration_s) : null;
  return {
    exercise_name: ex.exercise_name,
    sets:          ex.sets,
    reps_str:      JSON.parse(ex.reps_per_set).join(','),
    weight_str:    w ? w.join(',') : null,
    weight_unit:   unit,
    duration_str:  dur ? dur.map(v => v == null ? '' : v).join(',') : null,
    comment:       null,
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

async function copy_exercise(exercise_id, session_id) {
  // Refetch so the target list always covers every workout, even if the global
  // `workouts` was somehow stale when the copy button was clicked.
  try { workouts = await api('GET', '/api/workouts'); } catch { /* fall back to cache */ }
  const s  = workouts.find(w => w.id === session_id);
  const ex = s?.exercises.find(e => e.id === exercise_id);
  if (!ex) return;
  const sorted = [...workouts].sort((a, b) => b.date.localeCompare(a.date));
  const opts = sorted.map(w =>
    `<option value="${w.id}" ${w.id === session_id ? 'selected' : ''}>${fmt_de(w.date)}${w.comment ? ' — ' + esc(w.comment) : ''} (${w.exercises.length} Übungen)</option>`
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

// ─── Food diary CSV export (same mechanism as the workout export) ──────────

function open_export_meals() {
  if (!meals.length) { alert('Noch keine Mahlzeiten zum Exportieren vorhanden.'); return; }
  const dates = meals.map(m => m.date).sort();
  const min = dates[0], max = dates[dates.length - 1];
  open_modal('Ernährungs-Tagebuch exportieren', `
    <fieldset>
      <label><input type="radio" name="exp-range" value="all" checked onchange="_toggle_export_dates()"> Gesamtes Tagebuch</label>
      <label><input type="radio" name="exp-range" value="range" onchange="_toggle_export_dates()"> Zeitraum</label>
    </fieldset>
    <div id="exp-dates" hidden class="grid">
      <label>Von<input type="date" id="exp-from" value="${min}"></label>
      <label>Bis<input type="date" id="exp-to"   value="${max}"></label>
    </div>
    <fieldset style="margin-top:.75rem">
      <legend style="font-size:.9rem;font-weight:600">Umfang</legend>
      <label><input type="radio" name="exp-level" value="items" checked> Alle Zutaten &mdash; eine Zeile je Zutat</label>
      <label><input type="radio" name="exp-level" value="meals"> Nur Mahlzeiten &mdash; eine Zeile je Mahlzeit</label>
      <label><input type="radio" name="exp-level" value="days"> Tagesübersicht &mdash; eine Zeile je Tag</label>
    </fieldset>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="button" onclick="do_export_meals()">Als CSV herunterladen</button>
    </div>
  `);
}

function do_export_meals() {
  const range = document.querySelector('input[name="exp-range"]:checked').value;
  let list = [...meals];
  let from = '', to = '';
  if (range === 'range') {
    from = document.getElementById('exp-from').value;
    to   = document.getElementById('exp-to').value;
    if (!from || !to) { alert('Bitte Von- und Bis-Datum wählen.'); return; }
    if (from > to) [from, to] = [to, from];
    list = list.filter(m => m.date >= from && m.date <= to);
  }
  if (!list.length) { alert('Keine Mahlzeiten im gewählten Zeitraum.'); return; }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  const level = document.querySelector('input[name="exp-level"]:checked')?.value || 'items';
  const meal_label = m => m.meal_name || (m.items[0] ? m.items[0].food_name : '');
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const macro_cells = arr => [
    r_kcal(sum(arr, x => x.kcal)), r_nut(sum(arr, x => x.protein_g)),
    r_nut(sum(arr, x => x.carbs_g)), r_nut(sum(arr, x => x.fat_g)),
  ];

  let rows;
  if (level === 'days') {
    // One row per day: that day's totals, nothing else.
    rows = [['Datum', 'Mahlzeiten', 'Menge (g)', 'kcal', 'Eiweiß (g)', 'KH (g)', 'Fett (g)']];
    const by_date = new Map();
    for (const m of list) {
      if (!by_date.has(m.date)) by_date.set(m.date, []);
      by_date.get(m.date).push(m);
    }
    for (const date of [...by_date.keys()].sort()) {
      const day   = by_date.get(date);
      const items = day.flatMap(m => m.items);
      rows.push([date, day.length, r_nut(sum(items, i => i.amount_grams)), ...macro_cells(items)]);
    }
  } else if (level === 'meals') {
    // One row per meal: its totals, ingredients not broken out.
    rows = [['Datum', 'Mahlzeit', 'Zutaten', 'Menge (g)', 'kcal', 'Eiweiß (g)', 'KH (g)', 'Fett (g)', 'Kommentar']];
    for (const m of list) {
      rows.push([
        m.date, meal_label(m), m.items.length,
        r_nut(sum(m.items, i => i.amount_grams)),
        ...macro_cells(m.items),
        m.comment || '',
      ]);
    }
  } else {
    // Full export: one row per ingredient.
    rows = [[
      'Datum', 'Mahlzeit', 'Zutat', 'Menge (g)', 'Menge', 'Einheit',
      'kcal', 'Eiweiß (g)', 'KH (g)', 'Fett (g)', 'Kommentar',
    ]];
    for (const m of list) {
      const label = meal_label(m);
      if (!m.items.length) {
        rows.push([m.date, label, '', '', '', '', '', '', '', '', m.comment || '']);
        continue;
      }
      for (const it of m.items) {
        rows.push([
          m.date, label, it.food_name,
          it.amount_grams ?? '',
          it.amount_units ?? '',
          it.unit_name || '',
          r_kcal(it.kcal), r_nut(it.protein_g), r_nut(it.carbs_g), r_nut(it.fat_g),
          it.comment || '',
        ]);
      }
    }
  }
  // Leading BOM so Excel reads UTF-8 (umlauts) correctly.
  const csv = '﻿' + rows.map(r => r.map(_csv_cell).join(',')).join('\r\n');
  const suffix = { items: 'zutaten', meals: 'mahlzeiten', days: 'tage' }[level];
  const fname = range === 'range'
    ? `ernaehrung_${suffix}_${from}_bis_${to}.csv`
    : `ernaehrung_${suffix}_alle.csv`;
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
  if (!confirm(`${label} vom ${fmt_de(s.date)} löschen?`)) return;
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
  if (!confirm(`"${s.sport_name}" vom ${fmt_de(s.date)} löschen?`)) return;
  await api('DELETE', `/api/sports/${id}`);
  await load_sports();
}

// ─── Meals ────────────────────────────────────────────────────────────────

async function load_meals() {
  try {
    meals = await api('GET', '/api/meals');
    try { empty_days = await api('GET', '/api/diary-days'); } catch { empty_days = []; }
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
  });
}

function on_food_name_change(input) {
  const food  = _food_lookup(input.value);
  const row   = input.closest('tr');
  const badge = row.querySelector('.food-badge');
  const unit_sel = row.querySelector('[name="unit"]');
  // Offer "+ DB" only for a typed food the catalog doesn't know yet.
  const add_btn = row.querySelector('.add-food-btn');
  if (add_btn) add_btn.style.display = (!food && input.value.trim()) ? 'inline-block' : 'none';
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
      // Offer only this food's units and default to its own serving unit — for
      // a drink sold by the can "1 Dose/Glas" is the natural entry, not "473 g".
      // Once the user picks a unit by hand (unitManual) that choice is kept.
      const keep = row.dataset.unitManual === '1' ? unit_sel.value : null;
      unit_sel.innerHTML = _unit_options_html(food, keep);
    }
    if (badge) { badge.className = 'food-badge match'; badge.textContent = '✓'; }
    _set_macros_readonly(row, true);
    // A serving unit is counted, not weighed — "1 Stk." is the obvious start.
    // Only for a food typed in by hand: rows filled from a recipe or a copied
    // meal never reach this handler, so their amounts stay untouched.
    const amt_inp = row.querySelector('[name="amount_grams"]');
    if (amt_inp && !amt_inp.value && unit_sel && !_is_canonical_unit(unit_sel.value)) {
      amt_inp.value = 1;
    }
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
  const food = _food_lookup(name);
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

// Whether to KEEP a meal ingredient out of the food catalog. Einmalig rows are
// always kept out; a name already in the catalog is unaffected; a new (unknown)
// name is kept out unless the user ticked "In Datenbank speichern".
// Saving a meal never writes to the Lebensmitteldatenbank: a new food only
// gets in through the explicit "+ DB" button on its row.
function _row_skip_db(row) {
  return true;
}

// "+ DB": take the row's own numbers and register the food, normalised to
// 100 g/ml exactly like the Lebensmittel editor does. For a serving unit
// (Stk., Dose/Glas …) no gram weight is known — that optional field simply
// stays empty, which the rest of the app already handles.
async function add_row_food_to_db(btn) {
  const row  = btn.closest('tr');
  const name = row.querySelector('[name="food_name"]').value.trim();
  const amt  = parseFloat(row.querySelector('[name="amount_grams"]').value);
  const unit = row.querySelector('[name="unit"]').value;
  const num  = n => {
    const raw = row.querySelector(`[name="${n}"]`).value;
    return raw === '' ? NaN : parseFloat(raw);
  };
  const kcal = num('kcal'), protein = num('protein_g'),
        carbs = num('carbs_g'), fat = num('fat_g');

  if (!name)                    { alert('Bitte zuerst einen Namen eingeben.'); return; }
  if (isNaN(amt) || amt <= 0)   { alert('Bitte zuerst eine Menge eingeben — ohne Bezugsmenge lassen sich die Nährwerte nicht umrechnen.'); return; }
  if ([kcal, protein, carbs, fat].some(isNaN)) {
    alert('Bitte zuerst alle Nährwerte (kcal, Eiweiß, KH, Fett) eintragen.');
    return;
  }

  // Canonical units are per-100; a serving unit is stored per 1 unit against
  // the same virtual 100 g basis the meal rows use (see _row_grams).
  let unit_name = null, unit_grams = null, factor;
  if (_is_canonical_unit(unit)) {
    factor = 100 / amt;
    if (unit === 'ml') { unit_name = 'ml'; unit_grams = 1; }
  } else {
    unit_name = unit;
    factor    = 100 / (amt * 100);
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/foods', {
      name,
      kcal_per_100g:    kcal    * factor,
      protein_per_100g: protein * factor,
      carbs_per_100g:   carbs   * factor,
      fat_per_100g:     fat     * factor,
      unit_name, unit_grams,
      unit_weight_unit: _is_canonical_unit(unit) ? unit : null,
      estimated: false,
    });
    await load_foods_db();
    // Re-resolve the row so it picks up the badge, per-100 data and units.
    on_food_name_change(row.querySelector('[name="food_name"]'));
  } catch (err) {
    alert('Fehler beim Speichern: ' + err.message);
  } finally {
    btn.disabled = false;
  }
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
    <label style="margin:0 0 1rem;display:inline-flex;align-items:center;gap:.4rem">
      <input type="checkbox" id="exdb-isometric" ${e && e.is_isometric ? 'checked' : ''}>
      Isometrisch (Halten auf Zeit — Dauer statt Wiederholungen; Volumen = Sekunden)
    </label>
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
  const is_isometric = document.getElementById('exdb-isometric').checked;
  // Muscles only apply to Kraftübungen — cleared for Dehnübungen
  const muscles           = is_strength ? (document.getElementById('exdb-muscles').value.trim()   || null) : null;
  const secondary_muscles = is_strength ? (document.getElementById('exdb-secondary').value.trim() || null) : null;
  const muscle_group      = is_strength ? (document.getElementById('exdb-group').value || null)             : null;
  if (!name) { alert('Bitte Übungsname eingeben.'); return; }
  const btn = document.getElementById('exdb-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  const payload = { name, comment, muscles, per_hand, hints, is_strength, muscle_group, secondary_muscles, is_isometric };
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

// ─── Text export (copy-paste, e.g. to WhatsApp) ────────────────────────────
// One line, PLAIN text (escaped only where it is rendered):
//   "Arme - 2×8 Trizepsdrücken Kabelzug @15, 10 lbs pro Seite"
function _export_item_line(i) {
  const group  = _exercise_meta(i.exercise_name)?.muscle_group;
  const prefix = group ? `${group} - ` : '';
  const hold   = i.duration_s ? ` ${fmt_hold_times(i.duration_s)}` : '';
  const w = i.weight_str
    ? ` @${i.weight_str} ${i.weight_unit}${_is_per_hand(i.exercise_name) ? ' pro Seite' : ''}` : '';
  return `${prefix}${i.sets}×${i.reps_str} ${i.exercise_name}${hold}${w}`;
}

// Ausführungshinweise of an exercise as plain lines (one per sub-bullet).
function _export_hint_lines(name) {
  const m = _exercise_meta(name);
  if (!m || !m.hints) return [];
  return m.hints.split('\n').map(l => l.trim()).filter(Boolean);
}

// A logged workout exercise reshaped like a plan item, so both export
// identically through _export_item_line().
function _wx_as_plan_item(ex) {
  const unit = pick_weight_unit(ex);
  const raw  = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
  return {
    exercise_name: ex.exercise_name,
    sets:          ex.sets,
    reps_str:      reps_to_input(ex.reps_per_set),
    weight_str:    raw ? weight_to_input(raw) : '',
    weight_unit:   unit,
    duration_s:    _is_isometric_ex(ex.exercise_name) ? ex.duration_s : null,
  };
}

let _export_data       = null;    // { title, items } currently shown in the popup
let _export_show_hints = false;   // hints are OFF by default — the copy stays clean

function open_export_text(kind, id) {
  if (kind === 'plan') {
    const p = training_plans.find(x => x.id === id);
    if (!p) return;
    _export_data = { title: p.name, items: p.items };
  } else {
    const s = workouts.find(w => w.id === id);
    if (!s) return;
    _export_data = {
      title: `Kraft ${fmt_de(s.date)}${s.comment ? ' — ' + s.comment : ''}`,
      items: s.exercises.map(_wx_as_plan_item),
    };
  }
  _export_show_hints = false;
  open_modal('Zum Kopieren', `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.7rem">
      <button type="button" class="secondary outline" id="exp-hints-btn"
              style="width:auto;margin:0;font-size:.85rem" onclick="toggle_export_hints()">
        Hinweise anzeigen
      </button>
      <button type="button" class="secondary outline" id="exp-copy-btn"
              style="width:auto;margin:0;font-size:.85rem" onclick="copy_export_text()">
        Kopieren
      </button>
    </div>
    <div id="export-text" class="export-text"></div>
    <div class="form-footer">
      <button type="button" onclick="close_modal()">Schließen</button>
    </div>
  `);
  render_export_text();
}

function render_export_text() {
  const el = document.getElementById('export-text');
  if (!el || !_export_data) return;
  const rows = _export_data.items.map(i => {
    const hints = _export_show_hints ? _export_hint_lines(i.exercise_name) : [];
    const sub = hints.length
      ? `<ul class="export-hints">${hints.map(h => `<li>${linkify(h)}</li>`).join('')}</ul>` : '';
    return `<li>${esc(_export_item_line(i))}${sub}</li>`;
  }).join('');
  el.innerHTML = `<strong>${esc(_export_data.title)}</strong>
    <ul class="recipe-ingredients">${rows || '<li>leer</li>'}</ul>`;
}

function toggle_export_hints() {
  _export_show_hints = !_export_show_hints;
  const btn = document.getElementById('exp-hints-btn');
  if (btn) btn.textContent = _export_show_hints ? 'Hinweise ausblenden' : 'Hinweise anzeigen';
  render_export_text();
}

// Same text as shown, as plain lines — what lands in the clipboard.
function _export_plain_text() {
  if (!_export_data) return '';
  const lines = [_export_data.title];
  for (const i of _export_data.items) {
    lines.push('• ' + _export_item_line(i));
    if (_export_show_hints)
      for (const h of _export_hint_lines(i.exercise_name)) lines.push('   - ' + h);
  }
  return lines.join('\n');
}

async function copy_export_text() {
  const btn  = document.getElementById('exp-copy-btn');
  const done = msg => {
    if (!btn) return;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000);
  };
  try {
    await navigator.clipboard.writeText(_export_plain_text());
    done('✓ Kopiert');
    return;
  } catch { /* no clipboard permission (or insecure context) → select instead */ }
  // Fallback that works everywhere: select the block so Strg+C copies it.
  const el = document.getElementById('export-text');
  if (!el) { done('Kopieren fehlgeschlagen'); return; }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  done('markiert → Strg+C');
}

// Weight cell for a plan row, mirroring fmt_weight() in the workout table.
function _plan_weight_html(i) {
  if (!i.weight_str) return 'BW';
  const hand = _is_per_hand(i.exercise_name) ? ' <small>pro Seite</small>' : '';
  return `${esc(i.weight_str)}&thinsp;${esc(i.weight_unit || 'kg')}${hand}`;
}

// A training plan is shown exactly like a logged workout: same card, same
// header layout, same table columns. Hints stay behind the "?" button.
function _plan_card(p) {
  return `
  <article>
    <header>
      <div class="session-header">
        <span>
          <span class="activity-badge badge-workout">📋 Plan</span>
          <strong>${esc(p.name)}</strong>
          <small style="margin-left:.5rem;color:var(--pico-muted-color)">
            (${p.items.length} Übung${p.items.length !== 1 ? 'en' : ''})
          </small>
        </span>
        <div>
          <button class="outline secondary" title="Als Text exportieren"
                  onclick="open_export_text('plan',${p.id})">&#128203;</button>
          <button class="outline secondary" onclick="open_edit_plan(${p.id})">Bearbeiten</button>
          <button class="outline contrast"  onclick="del_plan(${p.id})">Löschen</button>
        </div>
      </div>
    </header>

    ${p.items.length ? `
    <figure>
      <table>
        <thead>
          <tr><th></th><th>Übung</th><th>Sätze</th><th>Reps</th><th>Gewicht</th><th>Gruppe</th><th></th></tr>
        </thead>
        <tbody>
          ${p.items.map((i, idx) => `
          <tr>
            <td class="reorder-col">
              <button class="reorder-btn" title="Nach oben"
                      ${idx === 0 ? 'disabled' : ''}
                      onclick="move_plan_item(${p.id}, ${idx}, -1)">▲</button>
              <button class="reorder-btn" title="Nach unten"
                      ${idx === p.items.length - 1 ? 'disabled' : ''}
                      onclick="move_plan_item(${p.id}, ${idx}, 1)">▼</button>
            </td>
            <td>${esc(i.exercise_name)} ${_hints_btn(i.exercise_name)}</td>
            <td>${i.sets}</td>
            <td>${esc(i.reps_str)}</td>
            <td>${_plan_weight_html(i)}</td>
            ${_ex_group_muscle_cells(i.exercise_name)}
            <td class="row-actions">
              <button class="outline secondary" title="Bearbeiten"
                      onclick="open_edit_plan(${p.id})">&#9998;</button>
              <button class="outline contrast" title="Aus Plan entfernen"
                      onclick="del_plan_item(${p.id}, ${idx})">&#10005;</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </figure>` : `<p class="empty">Noch keine Übungen.</p>`}

    <footer>
      <button class="secondary outline" onclick="open_edit_plan(${p.id})">+ Übung hinzufügen</button>
    </footer>
  </article>`;
}

// The plan API replaces all items at once, so the per-row reorder/delete
// buttons mutate the local list and save the whole plan back.
async function _save_plan_items(p) {
  await api('PUT', `/api/plans/${p.id}`, {
    name:  p.name,
    items: p.items.map(i => ({
      exercise_name: i.exercise_name,
      sets:          i.sets,
      reps_str:      i.reps_str,
      weight_str:    i.weight_str || null,
      weight_unit:   i.weight_unit,
    })),
  });
  await load_plans();
}

async function move_plan_item(plan_id, idx, dir) {
  const p = training_plans.find(x => x.id === plan_id);
  const j = idx + dir;
  if (!p || j < 0 || j >= p.items.length) return;
  [p.items[idx], p.items[j]] = [p.items[j], p.items[idx]];
  await _save_plan_items(p);
}

async function del_plan_item(plan_id, idx) {
  const p = training_plans.find(x => x.id === plan_id);
  if (!p || !p.items[idx]) return;
  if (!confirm(`"${p.items[idx].exercise_name}" aus dem Plan entfernen?`)) return;
  p.items.splice(idx, 1);
  await _save_plan_items(p);
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
  el.innerHTML = add_btn + training_plans.map(_plan_card).join('');
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
  document.getElementById('meals-export-btn').hidden     = (tab !== 'diary');
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
    <td></td>
    <td>${kcal_cell}</td>
    <td>${prot_cell}</td>
    <td></td><td></td><td></td>
  </tr>`;
}

// Amount of one ingredient, shown in the unit it was entered in ("2 Stk.",
// "250 ml", "85 g"); blank when no amount was recorded.
function _item_amount_label(i) {
  if (i.unit_name && i.amount_units != null)
    return `${_fmt_amount(i.amount_units)} ${esc(i.unit_name)}`;
  if (i.amount_grams != null) return `${_fmt_amount(i.amount_grams)} g`;
  return '';
}

// Amount of a whole meal: a single-ingredient meal shows that ingredient's own
// amount, a multi-ingredient one the summed weight (the only comparable unit).
function _meal_amount_label(s) {
  if (s.items.length === 1) return _item_amount_label(s.items[0]);
  const g = s.items.reduce((a, i) => a + (i.amount_grams || 0), 0);
  return g > 0 ? `${_fmt_amount(g)} g` : '';
}

function _fmt_amount(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function render_meals() {
  const el = document.getElementById('meals-list');
  // Group by date, newest first — including days the user added without a meal.
  const by_date = {};
  for (const s of meals) (by_date[s.date] = by_date[s.date] || []).push(s);
  const all_dates = new Set([...Object.keys(by_date), ...empty_days]);
  if (!all_dates.size) {
    el.innerHTML = '<p class="empty">Noch keine Mahlzeiten vorhanden.</p>';
    return;
  }
  const dates = [...all_dates].sort((a, b) => b.localeCompare(a));
  el.innerHTML = dates.map(date => {
    const ss = by_date[date] || [];
    if (!ss.length) return _empty_day_html(date);
    const dk = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.kcal,      0), 0);
    const dp = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.protein_g, 0), 0);
    const dc = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.carbs_g,   0), 0);
    const df = ss.reduce((a, s) => a + s.items.reduce((b, i) => b + i.fat_g,     0), 0);
    return `
    <article>
      <header>
        <div class="session-header">
          <strong>${fmt_de(date)}</strong>
          <span class="day-macros">${Math.round(dk)}&thinsp;kcal &nbsp;·&nbsp; ${dp.toFixed(1)}g P &nbsp;·&nbsp; ${dc.toFixed(1)}g KH &nbsp;·&nbsp; ${df.toFixed(1)}g F</span>
          <button onclick="open_new_meal_for('${date}')">+ Mahlzeit</button>
          <button class="outline contrast" title="Ganzen Tag löschen" style="width:auto"
                  onclick="del_day('${date}')">&#10005;</button>
        </div>
      </header>
      <figure>
        <table>
          <thead><tr><th></th><th>Mahlzeit</th><th>Menge</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th></tr></thead>
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
                <td style="color:var(--pico-muted-color);white-space:nowrap">${_item_amount_label(i)}</td>
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
              <td style="white-space:nowrap">${_meal_amount_label(s)}</td>
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
            <td></td>
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


// A day added to the diary that has no meal yet (edits: add a day without a meal).
function _empty_day_html(date) {
  return `
    <article>
      <header>
        <div class="session-header">
          <strong>${fmt_de(date)}</strong>
          <span class="day-macros" style="color:var(--pico-muted-color)">noch keine Mahlzeit</span>
          <button onclick="open_new_meal_for('${date}')">+ Mahlzeit</button>
          <button class="outline contrast" title="Tag entfernen" style="width:auto"
                  onclick="remove_empty_day('${date}')">&#10005;</button>
        </div>
      </header>
    </article>`;
}

async function remove_empty_day(date) {
  try { await api('DELETE', `/api/diary-days/${date}`); } catch { /* ignore */ }
  await load_meals();
}

// Delete a whole day from the diary: all its meals plus any empty-day marker.
async function del_day(date) {
  const ss = meals.filter(m => m.date === date);
  const items = ss.reduce((a, s) => a + s.items.length, 0);
  if (!confirm(`Tag ${fmt_de(date)} mit ${ss.length} Mahlzeit(en) und ${items} Zutat(en) löschen?`)) return;
  for (const s of ss) await api('DELETE', `/api/meals/${s.id}`);
  try { await api('DELETE', `/api/diary-days/${date}`); } catch { /* no marker */ }
  await load_meals();
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
  const estimated_badge = f => f.estimated
    ? ' <span class="food-badge skip" title="geringe Kalorien — geschätzt">≈</span>' : '';
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr>
      <th>Lebensmittel</th><th>Basis</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th>
    </tr></thead>
    <tbody>${sorted.map(f => {
      // Named-unit foods are shown per 1 unit (their entry basis); g/ml are
      // canonical and shown per 100 (ml is 1:1 with grams).
      const named = f.unit_name && !_is_canonical_unit(f.unit_name);
      const fac   = named ? (f.unit_grams || 100) / 100 : 1;
      // Match the editor's default: only 'g' is grams, everything else (incl.
      // not-yet-saved null) is shown as ml — g and ml are 1:1 anyway.
      const wu    = f.unit_weight_unit === 'g' ? 'g' : 'ml';
      const basis = named
        ? `1 ${esc(f.unit_name)}${f.unit_grams ? ` (${f.unit_grams}&thinsp;${esc(wu)})` : ''}`
        : `100 ${esc(f.unit_name || 'g')}`;
      return `
      <tr>
        <td>${esc(f.name)}${estimated_badge(f)}</td>
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
      const m = _recipe_item_macros(item, item.amount_grams || 0);
      tk += m.kcal; tp += m.protein; tc += m.carbs; tf += m.fat;
      total_g += item.amount_grams || 0;
    }
    const portions = r.portions ? ` · ${(+r.portions)} Portion${r.portions === 1 ? '' : 'en'}` : '';
    // Expanding a recipe reveals its ingredients (with their own nutrition) as
    // rows in the same table — exactly like collapsing a meal in the diary.
    const has_ing = r.items.length > 0;
    const name_cell = has_ing
      ? `<button class="meal-toggle" aria-expanded="false" onclick="toggle_recipe_details(${r.id}, this)"><span class="caret">▸</span> <strong>${esc(r.name)}</strong> <small style="color:var(--pico-muted-color)">(${r.items.length})</small></button>`
      : `<strong>${esc(r.name)}</strong>`;
    const detail_rows = r.items.map(i => {
      const amt  = (i.unit_name && i.amount_units != null)
        ? `${i.amount_units} ${esc(i.unit_name)}` : `${i.amount_grams} g`;
      const m = _recipe_item_macros(i, i.amount_grams || 0);
      const onetime = i.kcal != null && !_food_lookup(i.food_name);
      return `<tr class="recipe-detail" data-parent="${r.id}" hidden>
        <td style="padding-left:1.6rem;color:var(--pico-muted-color)">${esc(i.food_name)}${onetime ? ' <small>(einmalig)</small>' : ''}</td>
        <td style="color:var(--pico-muted-color)">${amt}</td>
        <td>${m.kcal}</td><td>${m.protein}g</td><td>${m.carbs}g</td><td>${m.fat}g</td>
        <td></td>
      </tr>`;
    }).join('');
    return `<tr>
      <td>${name_cell}</td>
      <td>${r.items.length} Zutat${r.items.length !== 1 ? 'en' : ''} (${Math.round(total_g)}&thinsp;g${portions})</td>
      <td>${r_kcal(tk)}</td>
      <td>${r_nut(tp)}g</td>
      <td>${r_nut(tc)}g</td>
      <td>${r_nut(tf)}g</td>
      <td class="row-actions">
        <button class="outline secondary" onclick="open_edit_recipe(${r.id})">&#9998;</button>
        <button class="outline contrast"  onclick="del_recipe(${r.id})">&#10005;</button>
      </td>
    </tr>${detail_rows}`;
  }).join('');
  el.innerHTML = add_btn + `<figure><table>
    <thead><tr><th>Name</th><th>Zutaten</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></figure>`;
}

function toggle_recipe_details(recipe_id, btn) {
  const open = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', String(!open));
  const caret = btn.querySelector('.caret');
  if (caret) caret.textContent = open ? '▸' : '▾';
  document.querySelectorAll(`tr.recipe-detail[data-parent="${recipe_id}"]`)
    .forEach(tr => { tr.hidden = open; });
}

// Macros of a recipe item scaled to `grams`. A one-time ingredient (macros
// stored on the item, and not shadowed by a catalog food) carries its own
// nutrition; a regular ingredient derives it live from the food (edits.txt #3
// + #4: recipes stay live-linked to the catalog, the diary does not).
function _recipe_item_macros(item, grams) {
  if (item.kcal != null && !_food_lookup(item.food_name)) {
    const base = item.amount_grams || 0;
    const s = base ? grams / base : 0;
    return { kcal: r_kcal(item.kcal * s), protein: r_nut(item.protein_g * s),
             carbs: r_nut(item.carbs_g * s), fat: r_nut(item.fat_g * s) };
  }
  const food = _food_lookup(item.food_name);
  const f = grams / 100;
  return food
    ? { kcal: r_kcal(food.kcal_per_100g * f), protein: r_nut(food.protein_per_100g * f),
        carbs: r_nut(food.carbs_per_100g * f), fat: r_nut(food.fat_per_100g * f) }
    : { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}

// Recipe ingredient row: name + amount + unit dropdown + per-ingredient macros.
// When the name matches a catalog food the macros are auto-computed & read-only;
// a one-time ingredient (not in the catalog) has editable macros stored on the
// recipe. `macros` prefills the four fields; `onetime` forces manual entry.
function _recipe_item_row_html(food_name = '', amount = '', unit = null, onetime = false, macros = null) {
  const food = (!onetime && food_name) ? _food_lookup(food_name) : null;
  const un   = (food && food.unit_name)  ? ` data-unit-name="${esc(food.unit_name)}"` : '';
  const ug   = (food && food.unit_grams) ? ` data-unit-grams="${food.unit_grams}"` : '';
  const pa   = food ? ` data-per100kcal="${food.kcal_per_100g}" data-per100protein="${food.protein_per_100g}" data-per100carbs="${food.carbs_per_100g}" data-per100fat="${food.fat_per_100g}"` : '';
  const ot   = onetime ? ' data-onetime="true"' : '';
  const ro   = !!food;                                     // catalog food drives the macros
  const rv   = (v, f) => (v === '' || v == null) ? '' : f(v);
  const mk = macros ? rv(macros.kcal, r_kcal) : '';
  const mp = macros ? rv(macros.protein, r_nut) : '';
  const mc = macros ? rv(macros.carbs, r_nut) : '';
  const mf = macros ? rv(macros.fat, r_nut) : '';
  const roAttr = ro ? 'readonly class="macro-auto"' : '';
  return `<tr${un}${ug}${pa}${ot}>
    <td><input type="text" name="ri-food" value="${esc(food_name)}" placeholder="Lebensmittel"
               ${onetime ? '' : 'list="foods-datalist" oninput="on_recipe_food_change(this)" onchange="on_recipe_food_change(this)"'}
               style="margin:0;min-width:8rem"></td>
    <td style="white-space:nowrap">
      <input type="number" name="ri-amt" value="${amount}" step="any" min="0" placeholder="Menge"
             oninput="on_recipe_amt_change(this)" style="margin:0;width:4.5rem;display:inline-block">
      <select name="ri-unit" onchange="on_recipe_unit_change(this)"
              style="margin:0;width:auto;display:inline-block;padding:.2rem 1.4rem .2rem .4rem">${_unit_options_html(food, unit)}</select>
    </td>
    <td><input type="number" name="ri-kcal"    value="${mk}" step="1"   placeholder="kcal" style="margin:0;width:4.5rem" ${roAttr}></td>
    <td><input type="number" name="ri-protein" value="${mp}" step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${roAttr}></td>
    <td><input type="number" name="ri-carbs"   value="${mc}" step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${roAttr}></td>
    <td><input type="number" name="ri-fat"     value="${mf}" step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${roAttr}></td>
    <td><button type="button" class="outline contrast"
                style="padding:.15rem .4rem;margin:0;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

function _recipe_set_macros_readonly(row, readonly) {
  ['ri-kcal', 'ri-protein', 'ri-carbs', 'ri-fat'].forEach(n => {
    const el = row.querySelector(`[name="${n}"]`);
    if (!el) return;
    el.readOnly = readonly;
    el.classList.toggle('macro-auto', readonly);
  });
}

function _recipe_recalc(row) {
  if (row.dataset.per100kcal === undefined) return;   // one-time → manual macros
  const g = _recipe_row_grams(row);
  if (isNaN(g)) return;
  const f = g / 100;
  const set = (n, v) => { const el = row.querySelector(`[name="${n}"]`); if (el) el.value = v; };
  set('ri-kcal',    r_kcal(parseFloat(row.dataset.per100kcal)    * f));
  set('ri-protein', r_nut(parseFloat(row.dataset.per100protein)  * f));
  set('ri-carbs',   r_nut(parseFloat(row.dataset.per100carbs)    * f));
  set('ri-fat',     r_nut(parseFloat(row.dataset.per100fat)      * f));
}

// Name typed/picked → resolve the food, sync unit + per-100 data, auto-fill or
// free up the macro fields.
function on_recipe_food_change(input) {
  const row = input.closest('tr');
  if (row.dataset.onetime === 'true') return;         // one-time: always manual
  const food = _food_lookup(input.value);
  const sel  = row.querySelector('[name="ri-unit"]');
  if (food) {
    row.dataset.per100kcal    = food.kcal_per_100g;
    row.dataset.per100protein = food.protein_per_100g;
    row.dataset.per100carbs   = food.carbs_per_100g;
    row.dataset.per100fat     = food.fat_per_100g;
    if (food.unit_grams) row.dataset.unitGrams = food.unit_grams; else delete row.dataset.unitGrams;
    if (food.unit_name)  row.dataset.unitName  = food.unit_name;  else delete row.dataset.unitName;
    if (sel) {
      const keep = row.dataset.unitManual === '1' ? sel.value : null;
      sel.innerHTML = _unit_options_html(food, keep);
    }
    _recipe_set_macros_readonly(row, true);
    _recipe_recalc(row);
  } else {
    delete row.dataset.per100kcal; delete row.dataset.per100protein;
    delete row.dataset.per100carbs; delete row.dataset.per100fat;
    delete row.dataset.unitName; delete row.dataset.unitGrams;
    if (sel) sel.innerHTML = _unit_options_html(null, sel.value);
    _recipe_set_macros_readonly(row, false);           // unknown food → enter macros by hand
  }
}

function on_recipe_amt_change(input) { _recipe_recalc(input.closest('tr')); }
function on_recipe_unit_change(sel)  { sel.closest('tr').dataset.unitManual = '1'; _recipe_recalc(sel.closest('tr')); }

// Grams for a recipe row (mirrors _row_grams for meal items).
function _recipe_row_grams(row) {
  const val = parseFloat(row.querySelector('[name="ri-amt"]').value);
  if (isNaN(val)) return NaN;
  const unit = row.querySelector('[name="ri-unit"]').value;
  if (unit === 'g' || unit === 'ml') return val;   // ml treated 1:1 with grams
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

// A one-time recipe ingredient: not from the catalog, macros entered by hand.
function add_recipe_skip_row() {
  document.getElementById('rm-items').insertAdjacentHTML('beforeend',
    _recipe_item_row_html('', '', 'g', true));
  document.querySelector('#rm-items tr:last-child input').focus();
}

// True when the stored item is a one-time ingredient (its own macros, and no
// catalog food shadowing it).
function _recipe_item_is_onetime(i) {
  return i.kcal != null && !_food_lookup(i.food_name);
}

function _recipe_modal_body(r) {
  const name = r ? esc(r.name) : '';
  const rows = r ? r.items.map(i => {
    const onetime = _recipe_item_is_onetime(i);
    const in_units = i.unit_name && i.amount_units != null;
    return _recipe_item_row_html(
      i.food_name,
      in_units ? i.amount_units : i.amount_grams,
      // A stored gram/ml amount keeps ITS unit — never the food's serving unit,
      // or "40 g Apfel" would silently re-read as "40 Stk.".
      in_units ? i.unit_name : _food_canonical_unit(_food_lookup(i.food_name)),
      onetime,
      _recipe_item_macros(i, i.amount_grams || 0));
  }).join('') : '';
  return `<div>
    <div class="grid">
      <label>Rezeptname<input type="text" id="rm-name" value="${name}" placeholder="z.B. Chili con Carne" required></label>
      <label>Portionen (optional)<input type="number" id="rm-portions" step="any" min="0"
             value="${r && r.portions != null ? (+r.portions) : ''}" placeholder="z.B. 4"></label>
    </div>
    <strong style="font-size:.9rem">Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr><th>Lebensmittel</th><th>Menge</th><th>kcal</th><th>Eiweiß</th><th>KH</th><th>Fett</th><th></th></tr></thead>
        <tbody id="rm-items">${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:.5rem;margin:.6rem 0 1rem;flex-wrap:wrap">
      <button type="button" class="secondary outline" style="width:auto;font-size:.85rem;margin:0"
              onclick="add_recipe_item_row()">+ Zutat</button>
      <button type="button" class="secondary outline" style="width:auto;font-size:.85rem;margin:0"
              onclick="add_recipe_skip_row()" title="Einmalige Zutat — nicht aus der Datenbank, Nährwerte selbst eingeben">+ Einmalig</button>
    </div>
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
    // A one-time ingredient (flagged, or a name not in the catalog) stores its
    // own macros; a regular ingredient leaves them null and stays linked to the
    // food so future edits to that food flow through to the recipe.
    const onetime = row.dataset.onetime === 'true' || !_food_lookup(food);
    const num = n => { const v = row.querySelector(`[name="${n}"]`).value; return v === '' ? 0 : parseFloat(v); };
    items.push({
      food_name: food, amount_grams: grams,
      amount_units: unit !== 'g' && !isNaN(raw) ? raw : null,
      unit_name:    unit !== 'g' && !isNaN(raw) ? unit : null,
      kcal:      onetime ? num('ri-kcal')    : null,
      protein_g: onetime ? num('ri-protein') : null,
      carbs_g:   onetime ? num('ri-carbs')   : null,
      fat_g:     onetime ? num('ri-fat')     : null,
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
    const has_p   = r.portions > 0;
    const label   = has_p
      ? `${esc(r.name)} (${+r.portions} Portion${+r.portions === 1 ? '' : 'en'})`
      : `${esc(r.name)} (${Math.round(total_g)} g gesamt)`;
    return `<option value="${r.id}" data-total="${total_g}" data-portions="${r.portions || ''}" ${r.id === preselect_id ? 'selected' : ''}>${label}</option>`;
  }).join('');
  open_modal2('Rezept hinzufügen', `<div>
    <label>Rezept<select id="ra-select" onchange="on_recipe_select_change()">${opts}</select></label>
    <div class="grid" style="margin-bottom:.25rem">
      <label style="margin:0">Menge
        <input type="number" id="ra-amount" step="any" min="0" placeholder="z.B. 1" autofocus>
      </label>
      <label style="margin:0">Einheit
        <select id="ra-mode" onchange="update_recipe_add_hint()">
          <option value="portion">Portionen</option>
          <option value="g">Gramm</option>
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
  on_recipe_select_change();
}

// Recipe picked → default the unit to Portionen when the recipe defines a
// portion count, otherwise Gramm.
function on_recipe_select_change() {
  const sel  = document.getElementById('ra-select');
  const mode = document.getElementById('ra-mode');
  const portions = parseFloat(sel.options[sel.selectedIndex]?.dataset.portions) || 0;
  if (mode) mode.value = portions > 0 ? 'portion' : 'g';
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

// Adapt a recipe just for this day: opens the full ingredient editor (same as
// creating a recipe) prefilled with the recipe — add/remove ingredients, change
// amounts and the portion count. NOTHING here is written back to the stored
// recipe; the edited version is only scaled into the meal being logged. The
// amount actually taken (grams or portions) is entered at the bottom.
function open_recipe_adapt() {
  const sel = document.getElementById('ra-select');
  const r   = recipes.find(x => x.id === parseInt(sel.value));
  if (!r) return;
  const rows = r.items.map(i => _recipe_item_row_html(
    i.food_name,
    (i.unit_name && i.amount_units != null) ? i.amount_units : i.amount_grams,
    (i.unit_name && i.amount_units != null)
      ? i.unit_name
      : _food_canonical_unit(_food_lookup(i.food_name)))).join('');
  const portions = r.portions != null ? +r.portions : '';
  open_modal2('Rezept anpassen: ' + r.name, `<div data-recipe-name="${esc(r.name)}">
    <p style="font-size:.85rem;color:var(--pico-muted-color)">
      Änderungen gelten nur für diesen Tag — das gespeicherte Rezept bleibt unverändert.
    </p>
    <label>Portionen (optional)<input type="number" id="ra-portions" step="any" min="0"
           value="${portions}" placeholder="z.B. 4" oninput="update_adapt_hint()"></label>
    <strong style="font-size:.9rem">Zutaten</strong>
    <div style="overflow-x:auto;margin-top:.4rem">
      <table style="font-size:.85rem;margin:0">
        <thead><tr><th>Lebensmittel</th><th>Menge</th><th></th></tr></thead>
        <tbody id="ra-adapt">${rows}</tbody>
      </table>
    </div>
    <button type="button" class="secondary outline"
            style="width:auto;font-size:.85rem;margin:.6rem 0 1rem"
            onclick="add_adapt_item_row()">+ Zutat hinzufügen</button>
    <hr style="margin:.25rem 0 .75rem">
    <strong style="font-size:.9rem">Wie viel hast du genommen?</strong>
    <div class="grid" style="margin:.4rem 0 .25rem">
      <label style="margin:0">Menge
        <input type="number" id="ra-adapt-amount" step="any" min="0" placeholder="z.B. 1"
               oninput="update_adapt_hint()">
      </label>
      <label style="margin:0">Einheit
        <select id="ra-adapt-mode" onchange="update_adapt_hint()">
          <option value="portion">Portionen</option>
          <option value="g">Gramm</option>
        </select>
      </label>
    </div>
    <small id="ra-adapt-hint" style="color:var(--pico-muted-color)"></small>
    <div class="form-footer" style="margin-top:.75rem">
      <button type="button" class="secondary outline" onclick="close_modal2()">Abbrechen</button>
      <button type="button" onclick="apply_recipe_adapted()">Übernehmen</button>
    </div>
  </div>`);
  document.getElementById('ra-adapt-mode').value = portions !== '' ? 'portion' : 'g';
  update_adapt_hint();
}

function add_adapt_item_row() {
  document.getElementById('ra-adapt').insertAdjacentHTML('beforeend', _recipe_item_row_html());
  document.querySelector('#ra-adapt tr:last-child input').focus();
}

// Build the temporary (edited) recipe from the adapt dialog's current rows,
// carrying one-time ingredients' hand-entered macros just like save_recipe.
function _adapt_temp_recipe() {
  const items = [...document.querySelectorAll('#ra-adapt tr')].map(row => {
    const food  = row.querySelector('[name="ri-food"]').value.trim();
    const grams = _recipe_row_grams(row);
    const onetime = row.dataset.onetime === 'true' || !_food_lookup(food);
    const num = n => { const v = row.querySelector(`[name="${n}"]`).value; return v === '' ? 0 : parseFloat(v); };
    return {
      food_name: food, amount_grams: grams,
      kcal:      onetime ? num('ri-kcal')    : null,
      protein_g: onetime ? num('ri-protein') : null,
      carbs_g:   onetime ? num('ri-carbs')   : null,
      fat_g:     onetime ? num('ri-fat')     : null,
    };
  }).filter(i => i.food_name && !isNaN(i.amount_grams) && i.amount_grams > 0);
  const p = parseFloat(document.getElementById('ra-portions').value);
  return { items, portions: isNaN(p) || p <= 0 ? null : p };
}

function update_adapt_hint() {
  const hint = document.getElementById('ra-adapt-hint');
  if (!hint) return;
  hint.style.color = 'var(--pico-muted-color)';   // clear any inline error state
  const tmp   = _adapt_temp_recipe();
  const total = tmp.items.reduce((s, i) => s + i.amount_grams, 0);
  const mode  = document.getElementById('ra-adapt-mode').value;
  const amt   = parseFloat(document.getElementById('ra-adapt-amount').value);
  const parts = [`Rezept gesamt: ${Math.round(total)} g`];
  if (tmp.portions) parts.push(`${Math.round(tmp.portions * 10) / 10} Portion(en) · 1 Portion ≈ ${Math.round(total / tmp.portions)} g`);
  const scale = _recipe_scale(tmp, mode, amt);
  if (scale !== null) parts.push(`entnommen ≈ ${Math.round(total * scale)} g`);
  else if (mode === 'portion' && !tmp.portions) parts.push('— bitte Portionen oben eintragen');
  hint.textContent = parts.join(' · ');
}

// Show an inline error in a recipe-picker hint span (never alert() — see
// apply_recipe_to_meal) and focus the field that needs input.
function _ra_hint_error(hint_id, msg, focus_id) {
  const h = document.getElementById(hint_id);
  if (h) { h.textContent = msg; h.style.color = 'var(--pico-del-color)'; }
  document.getElementById(focus_id)?.focus();
}

function apply_recipe_adapted() {
  const rname = document.querySelector('#modal2-body [data-recipe-name]')?.dataset.recipeName;
  const tmp   = _adapt_temp_recipe();
  if (!tmp.items.length) { _ra_hint_error('ra-adapt-hint', 'Bitte mindestens eine Zutat angeben.', 'ra-adapt-amount'); return; }
  const mode  = document.getElementById('ra-adapt-mode').value;
  const amt   = parseFloat(document.getElementById('ra-adapt-amount').value);
  const scale = _recipe_scale(tmp, mode, amt);
  if (scale === null) {
    _ra_hint_error('ra-adapt-hint', mode === 'portion'
      ? 'Bitte Portionen eingeben (oben eine Portionenzahl hinterlegen).'
      : 'Bitte Menge eingeben.', 'ra-adapt-amount');
    return;
  }
  close_modal2();
  _drop_blank_em_rows();
  if (rname) _tag_recipe_name(rname);
  const round1 = v => Math.round(v * 10) / 10;
  for (const item of tmp.items) {
    const amount = round1(item.amount_grams * scale);
    const m = _recipe_item_macros(item, amount);
    add_em_item_row(item.food_name, amount, m.kcal, m.protein, m.carbs, m.fat);
  }
  update_meal_name_placeholder();
}

function update_recipe_add_hint() {
  const sel  = document.getElementById('ra-select');
  const hint = document.getElementById('ra-hint');
  if (!sel || !hint) return;
  hint.style.color = 'var(--pico-muted-color)';   // clear any inline error state
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
    // Inline message — a blocking alert() over the nested <dialog> leaves the
    // dialog inert in Chromium (inputs stop responding), so never alert here.
    _ra_hint_error('ra-hint', mode === 'portion'
      ? 'Bitte Portionen eingeben (Rezept muss Portionen hinterlegt haben).'
      : 'Bitte Menge eingeben.', 'ra-amount');
    return;
  }
  close_modal2();
  _drop_blank_em_rows();
  _tag_recipe_name(r.name);
  const round1 = v => Math.round(v * 10) / 10;
  for (const item of r.items) {
    const amount = round1(item.amount_grams * scale);
    const m = _recipe_item_macros(item, amount);
    const { kcal, protein, carbs, fat } = m;
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
const FOOD_UNITS = ['g', 'ml', 'Stk.', 'Scheibe', 'Handvoll', 'EL', 'TL', 'Portion', 'Dose/Glas'];

// Grams and millilitres are the canonical measures (stored 1:1); every other
// unit is a named serving unit whose gram weight may be given.
function _is_canonical_unit(u) { return u === 'g' || u === 'ml'; }

function _food_modal_body(f) {
  const name    = f ? esc(f.name) : '';
  // A "named" unit (Stk., Dose/Glas, …) stores macros per 1 unit; g and ml are
  // canonical (per 100), so they use the plain per-100 entry like grams.
  // Round the shown value to 2 decimals so extrapolated per-100 figures (e.g.
  // 133.33 from a per-15 entry) stay editable instead of being repeating
  // decimals that fail the input's step validation.
  const named   = !!(f && f.unit_name && !_is_canonical_unit(f.unit_name));
  const to_unit = v => Math.round(v * (named ? (f.unit_grams || 100) / 100 : 1) * 100) / 100;
  const kcal    = f ? to_unit(f.kcal_per_100g)    : '';
  const protein = f ? to_unit(f.protein_per_100g) : '';
  const carbs   = f ? to_unit(f.carbs_per_100g)   : '';
  const fat     = f ? to_unit(f.fat_per_100g)     : '';
  const cur_unit = (f && f.unit_name) ? f.unit_name : 'g';
  const unit_opts = FOOD_UNITS.map(u =>
    `<option value="${u}" ${u === cur_unit ? 'selected' : ''}>${u}</option>`).join('')
    + (FOOD_UNITS.includes(cur_unit) ? '' : `<option value="${esc(cur_unit)}" selected>${esc(cur_unit)}</option>`);
  return `<form>
    <label>Name<input type="text" name="name" value="${name}" required></label>
    <label style="font-weight:600">Nährwerte je
      <input type="number" name="per_g" value="${named ? 1 : 100}" min="0.1" step="any"
             style="display:inline-block;width:5rem;margin:0 .4rem"
             oninput="update_per_g_label()">
      <select name="per_unit" onchange="on_per_unit_change(this)"
              style="display:inline-block;width:auto;margin:0 .4rem;padding:.2rem 1.6rem .2rem .5rem">${unit_opts}</select>
      <span id="per-g-hint" style="font-weight:normal;color:var(--pico-muted-color);font-size:.85rem"></span>
    </label>
    <label id="unit-weight-field" ${named ? '' : 'hidden'}>Menge je Einheit (optional)
      <span style="display:flex;gap:.5rem;align-items:center">
        <input type="number" name="unit_weight" step="0.1" min="0" style="flex:1;margin:0"
               value="${f && f.unit_grams != null ? f.unit_grams : ''}"
               placeholder="leer = unbekannt, z.B. 540">
        <select name="unit_weight_unit" style="width:auto;margin:0;padding:.2rem 1.6rem .2rem .5rem">
          <option value="ml" ${(f && f.unit_weight_unit === 'g') ? '' : 'selected'}>ml</option>
          <option value="g"  ${(f && f.unit_weight_unit === 'g') ? 'selected' : ''}>g</option>
        </select>
      </span>
    </label>
    <label style="margin:0;display:inline-flex;align-items:center;gap:.4rem">
      <input type="checkbox" name="estimated" ${f && f.estimated ? 'checked' : ''}
             onchange="on_estimated_change(this)">
      geringe Kalorien &ndash; geschätzt
    </label>
    <small style="display:block;margin:0 0 1rem;color:var(--pico-muted-color)">
      Nährwerte dürfen grob oder leer bleiben.
    </small>
    <div class="grid">
      <label>kcal<input type="number" name="kcal" step="any" value="${kcal}" required></label>
      <label>Eiweiß (g)<input type="number" name="protein" step="any" value="${protein}" required></label>
    </div>
    <div class="grid">
      <label>KH (g)<input type="number" name="carbs" step="any" value="${carbs}" required></label>
      <label>Fett (g)<input type="number" name="fat" step="any" value="${fat}" required></label>
    </div>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

function on_per_unit_change(sel) {
  const form = sel.closest('form');
  // g and ml are canonical (1:1) → no per-unit gram weight; per 100 like grams.
  const canonical = _is_canonical_unit(sel.value);
  form.querySelector('#unit-weight-field').hidden = canonical;
  const per_g = form.querySelector('[name="per_g"]');
  if (per_g && (per_g.value === '' || per_g.value === '1' || per_g.value === '100')) {
    per_g.value = canonical ? 100 : 1;
  }
  update_per_g_label();
}

function update_per_g_label() {
  const hint = document.getElementById('per-g-hint');
  const form = hint && hint.closest('form');
  if (!form) return;
  const x    = parseFloat(form.querySelector('[name="per_g"]').value);
  const unit = form.querySelector('[name="per_unit"]').value;
  if (_is_canonical_unit(unit)) {
    hint.textContent = (!isNaN(x) && x !== 100) ? `(wird auf 100 ${unit} umgerechnet)` : '';
  } else {
    hint.textContent = '(gespeichert je Einheit)';
  }
}

// "geringe Kalorien – geschätzt": exact macros don't matter. The fields are
// dimmed as a visual cue and may be left empty (missing values save as 0).
// Unticked, all four stay `required`, so the browser warns on an empty field.
function on_estimated_change(cb) {
  const form = cb.closest('form');
  ['kcal', 'protein', 'carbs', 'fat'].forEach(n => {
    const inp = form.querySelector(`[name="${n}"]`);
    if (!inp) return;
    inp.required = !cb.checked;
    inp.classList.toggle('macro-dim', cb.checked);
  });
}

function _food_macros_from_form(data) {
  const num  = v => { const f = parseFloat(v); return isNaN(f) ? 0 : f; };
  const unit = data.per_unit || 'g';
  let factor, unit_name = null, unit_grams = null, weight_unit = null;
  if (_is_canonical_unit(unit)) {
    // g / ml — entered per 100, stored per 100 g (ml is 1:1 with grams). ml is
    // remembered as the food's unit so it defaults to ml when logging.
    const x = parseFloat(data.per_g) || 100;
    factor  = 100 / x;
    if (unit === 'ml') { unit_name = 'ml'; unit_grams = 1; }
    weight_unit = unit;          // g stays g — never stamp 'ml' on a gram food
  } else {
    // Macros were entered per X units. If the unit weight is unknown we
    // normalise against a virtual 100 g per unit — meal entries in this unit
    // use the same basis (see _row_grams), so all math stays consistent.
    const x = parseFloat(data.per_g) || 1;
    const w = parseFloat(data.unit_weight);
    unit_name  = unit;
    unit_grams = (!isNaN(w) && w > 0) ? w : null;
    factor     = 100 / (x * (unit_grams || 100));
    // The unit's weight can be given in g or ml (both 1:1) — remember which.
    weight_unit = (unit_grams != null) ? (data.unit_weight_unit || 'ml') : null;
  }
  return {
    name:             data.name,
    kcal_per_100g:    num(data.kcal)    * factor,
    protein_per_100g: num(data.protein) * factor,
    carbs_per_100g:   num(data.carbs)   * factor,
    fat_per_100g:     num(data.fat)      * factor,
    unit_name,
    unit_grams,
    unit_weight_unit: weight_unit,
    estimated:        !!data.estimated,
  };
}

function _init_density_state() {
  const cb = document.querySelector('#modal-body [name="estimated"]');
  if (cb) on_estimated_change(cb);
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
  const existing = new Set([...meals.map(m => m.date), ...empty_days]);
  const def = today_local();
  const days_hint = existing.size
    ? `Bereits vorhanden: ${[...existing].sort((a, b) => b.localeCompare(a)).slice(0, 8).map(fmt_de).join(', ')}${existing.size > 8 ? ' …' : ''}`
    : '';
  open_modal('Tag hinzufügen', `<form>
    <label>Neuer Tag
      <input type="date" name="date" value="${existing.has(def) ? '' : def}" required>
      <small style="color:var(--pico-muted-color)">
        Der Tag wird leer angelegt — Mahlzeiten fügst du danach über „+ Mahlzeit" hinzu.<br>${days_hint}
      </small>
    </label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Tag anlegen</button>
    </div>
  </form>`, async data => {
    if (!data.date) throw new Error('Bitte ein Datum wählen.');
    if (existing.has(data.date))
      throw new Error('Dieser Tag existiert bereits.');
    await api('POST', '/api/diary-days', { date: data.date });
    await load_meals();
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
    return `<option value="${m.id}">${esc(label)} (${fmt_de(m.date)})</option>`;
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
  add_em_item_row();   // start with an empty Lebensmittel row, ready to type
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

// A food is measured either in grams or in millilitres — never both. Which one
// applies follows from how the food was defined: an "ml" food, or a named unit
// whose size was given in ml, is a millilitre food; everything else is grams.
function _food_canonical_unit(food) {
  if (!food) return 'g';
  if (food.unit_name === 'ml') return 'ml';                 // defined per 100 ml
  // unit_weight_unit describes the size of a NAMED unit ("1 Dose = 540 ml"),
  // so it only matters when such a unit exists.
  if (_food_named_unit(food) && food.unit_weight_unit === 'ml') return 'ml';
  return 'g';
}

// The food's own serving unit (Stk., Dose/Glas, …), or null if it has none.
function _food_named_unit(food) {
  const u = food && food.unit_name;
  return (u && !_is_canonical_unit(u)) ? u : null;
}

// Default unit for an ingredient row: the food's own serving unit when it has
// one (a can of beans is naturally counted in cans), otherwise its canonical
// measure.
function _default_unit_for(food) {
  return _food_named_unit(food) || _food_canonical_unit(food);
}

// Unit <select> options for an ingredient row: ONLY the units that apply to
// this food — its canonical measure (g or ml, mutually exclusive) plus its own
// serving unit if defined. A unit already stored on the row is kept selectable
// so an existing entry never silently loses its value.
function _unit_options_html(food, selected = null) {
  const units = [_food_canonical_unit(food)];
  const named = _food_named_unit(food);
  if (named) units.push(named);
  if (selected && !units.includes(selected)) units.push(selected);
  const sel = selected || _default_unit_for(food);
  return units.map(u => `<option value="${esc(u)}" ${u === sel ? 'selected' : ''}>${esc(u)}</option>`).join('');
}

// Amount of a row in grams. Only 'g' and the food's OWN serving unit convert
// (its weight, or a virtual 100 g if none is set). Any other unit has no known
// grams-per-unit → NaN, and the macros are entered manually for that item.
function _row_grams(row) {
  const val = parseFloat(row.querySelector('[name="amount_grams"]').value);
  if (isNaN(val)) return NaN;
  const unit = row.querySelector('[name="unit"]').value;
  if (unit === 'g' || unit === 'ml') return val;   // ml treated 1:1 with grams
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

function _item_row_html(item_id, food_name = '', amount = '', kcal = '', protein = '', carbs = '', fat = '', per100 = null, skip_db = false, unit = null) {
  // Keep field values at the display precision so step-constrained inputs accept them.
  const _rv = (v, f) => (v === '' || v == null) ? '' : f(v);
  kcal = _rv(kcal, r_kcal); protein = _rv(protein, r_nut); carbs = _rv(carbs, r_nut); fat = _rv(fat, r_nut);
  const food = food_name ? _food_lookup(food_name) : null;
  const pa   = per100 ? ` data-per100kcal="${per100.kcal}" data-per100protein="${per100.protein}" data-per100carbs="${per100.carbs}" data-per100fat="${per100.fat}"` : '';
  const ug   = (food && food.unit_grams) ? ` data-unit-grams="${food.unit_grams}"` : '';
  const un   = (food && food.unit_name)  ? ` data-unit-name="${esc(food.unit_name)}"` : '';
  const badge_cls  = food ? 'match' : (food_name ? 'new' : '');
  const badge_text = food ? '✓'     : (food_name ? 'neu' : '');
  return `<tr data-item-id="${item_id}"${pa}${ug}${un}>
    <td style="white-space:nowrap">
      <input type="text" name="food_name" value="${esc(food_name)}" placeholder="Lebensmittel"
             list="foods-datalist" oninput="on_food_name_change(this)" onchange="on_food_name_change(this)"
             style="margin:0;min-width:8rem;display:inline-block;width:auto">
      <span class="food-badge ${badge_cls}">${badge_text}</span>
      <button type="button" class="add-food-btn" title="Als Lebensmittel in die Datenbank aufnehmen"
              style="display:${food || !food_name ? 'none' : 'inline-block'}"
              onclick="add_row_food_to_db(this)">+ DB</button>
    </td>
    <td style="white-space:nowrap">
      <input type="number" name="amount_grams" value="${amount}" step="any" min="0" placeholder="Menge"
             oninput="on_amount_change(this)" style="margin:0;width:4.5rem;display:inline-block">
      <select name="unit" onchange="on_unit_change(this)"
              style="margin:0;width:auto;display:inline-block;padding:.2rem 1.4rem .2rem .4rem">${_unit_options_html(food, unit)}</select>
    </td>
    <td><input type="number" name="kcal"         value="${kcal}"     step="1"   placeholder="kcal" style="margin:0;width:4.5rem" ${per100 ? 'readonly' : ''}></td>
    <td><input type="number" name="protein_g"    value="${protein}"  step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly' : ''}></td>
    <td><input type="number" name="carbs_g"      value="${carbs}"    step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly' : ''}></td>
    <td><input type="number" name="fat_g"        value="${fat}"      step="0.1" placeholder="g"    style="margin:0;width:4rem"   ${per100 ? 'readonly' : ''}></td>
    <td><button type="button" class="outline contrast" style="margin:0;padding:.15rem .4rem;width:auto;font-size:.8rem"
                onclick="this.closest('tr').remove()">&#10005;</button></td>
  </tr>`;
}

// Every caller that supplies a food name (recipe import, meal import) passes
// the amount in GRAMS, so the row must be labelled with the food's canonical
// measure — not its serving unit, or "49 g Möhre" would read as "49 Stk.".
// A blank row keeps no unit: the serving-unit default is applied by
// on_food_name_change once the user actually types a food.
// Drop rows that have no food name — used before a bulk import so the empty
// starter row doesn't linger between the imported ingredients.
function _drop_blank_em_rows() {
  document.querySelectorAll('#em-items tr').forEach(tr => {
    if (!tr.querySelector('[name="food_name"]').value.trim()) tr.remove();
  });
}

function add_em_item_row(food_name = '', amount = '', kcal = '', protein = '', carbs = '', fat = '') {
  const food   = food_name ? _food_lookup(food_name) : null;
  const per100 = food ? {
    kcal:    food.kcal_per_100g,
    protein: food.protein_per_100g,
    carbs:   food.carbs_per_100g,
    fat:     food.fat_per_100g,
  } : null;
  const unit = food_name ? _food_canonical_unit(food) : null;
  const tbody = document.getElementById('em-items');
  tbody.insertAdjacentHTML('beforeend', _item_row_html('new', food_name, amount, kcal, protein, carbs, fat, per100, false, unit));
  const row = tbody.lastElementChild;
  if (!food_name) row.querySelector('input').focus();
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
  _drop_blank_em_rows();
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

  // Don't create an empty (0-kcal) meal — a day exists only through its meals.
  const rows = Array.from(document.querySelectorAll('#em-items tr'))
    .filter(row => row.querySelector('[name="food_name"]').value.trim());
  if (!rows.length) { alert('Bitte mindestens eine Zutat hinzufügen.'); return; }

  const btn = document.getElementById('em-save-btn');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const { id: session_id } = await api('POST', '/api/meals', {
      date, meal_name: name || null, comment: null,
    });
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
        skip_food_db: _row_skip_db(row),
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
              in_units ? i.unit_name : _food_canonical_unit(food));
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
        skip_food_db: _row_skip_db(row),
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
  if (!confirm(`Mahlzeit vom ${fmt_de(s.date)} und alle ${s.items.length} Zutat(en) löschen?`)) return;
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
      <input type="date" id="copy-date" value="${today}" lang="de">
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

// ─── Schlaf ───────────────────────────────────────────────────────────────
// One row per night, keyed by the date the night STARTS on: 18.08. is the
// night from the 18th to the 19th. All times are wall-clock 'HH:MM', so every
// duration is measured forward from lights-out, wrapping past midnight.

function _hm_to_min(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

// Minutes from `bed` forward to `t`, wrapping around midnight (0…1439).
function _mins_after(bed, t) {
  return ((_hm_to_min(t) - _hm_to_min(bed)) + 1440) % 1440;
}

function fmt_dur_min(min) {
  return `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, '0')} h`;
}

// Both durations are computed and stored server-side (see sleep_durations), so
// the table just reads them. Older rows without them fall back to the times.
function _sleep_stats(s) {
  const shift  = (s.tz_shift || 0) * 60;
  const in_bed = s.in_bed_min != null ? s.in_bed_min
               : (_mins_after(s.bed_time, s.up_time) || 1440) + shift;
  const slept  = s.sleep_min != null ? s.sleep_min
               : (_mins_after(s.asleep_time || s.bed_time, s.awake_time || s.up_time) || 1440) + shift;
  return { in_bed, slept, efficiency: in_bed > 0 ? slept / in_bed : null };
}

async function load_sleep() {
  try {
    sleep_log = await api('GET', '/api/sleep');
    render_sleep();
  } catch (err) {
    document.getElementById('sleep-list').innerHTML =
      `<p style="color:var(--pico-del-color)">Fehler beim Laden: ${esc(err.message)}</p>`;
  }
}

function render_sleep() {
  const el = document.getElementById('sleep-list');
  if (!el) return;
  if (!sleep_log.length) {
    el.innerHTML = '<p class="empty">Noch keine Nächte erfasst.</p>';
    return;
  }
  const dash = '<span style="color:var(--pico-muted-color)">&ndash;</span>';
  el.innerHTML = `<figure><table>
    <thead><tr>
      <th>Nacht</th><th>Zu Bett</th><th>Eingeschlafen</th><th>Aufgewacht</th><th>Aufgestanden</th>
      <th>Zeit im Bett</th><th>Schlafdauer</th><th>Score</th><th>Kommentar</th><th></th>
    </tr></thead>
    <tbody>${sleep_log.map(s => {
      const st = _sleep_stats(s);
      const tz = s.tz_shift ? ` <small style="color:var(--pico-muted-color)">${s.tz_shift > 0 ? '+' : ''}${s.tz_shift} h</small>` : '';
      return `
      <tr>
        <td style="white-space:nowrap">${fmt_de(s.date)}</td>
        <td>${esc(s.bed_time)}</td>
        <td>${s.asleep_time ? esc(s.asleep_time) : dash}</td>
        <td>${s.awake_time  ? esc(s.awake_time)  : dash}</td>
        <td>${esc(s.up_time)}</td>
        <td style="white-space:nowrap">${fmt_dur_min(st.in_bed)}${tz}</td>
        <td style="white-space:nowrap">${fmt_dur_min(st.slept)}</td>
        <td>${s.score}</td>
        <td>${s.comment ? esc(s.comment) : dash}</td>
        <td class="row-actions">
          <button class="outline secondary" onclick="open_edit_sleep(${s.id})">&#9998;</button>
          <button class="outline contrast"  onclick="del_sleep(${s.id})">&#10005;</button>
        </td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></figure>`;
}

// Times are plain text fields, not <input type="time">: browsers render that
// one in their own UI language, which turns 23:30 into "11:30 PM" for anyone
// whose browser isn't German. A text field is always 24 h.
// A leading zero is optional (7:00 = 07:00) and 24:00 means midnight.
const _TIME_RE = /^(\d{1,2}):([0-5][0-9])$/;
const _time_attrs = ph =>
  `type="text" inputmode="numeric" maxlength="5" placeholder="${ph}" ` +
  `pattern="([01]?[0-9]|2[0-4]):[0-5][0-9]" onblur="_normalize_time_field(this)" ` +
  `style="font-variant-numeric:tabular-nums"`;

// Canonical 'HH:MM', or null if it isn't a time. "2330"/"23.30"/"7:00"/"24:00"
// all resolve; 24:00 folds onto 00:00 so it can be entered either way.
function _norm_hm(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, '');
  if (!t.includes(':')) {
    if (digits.length === 3)      t = `${digits[0]}:${digits.slice(1)}`;
    else if (digits.length === 4) t = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    else return null;
  }
  const m = t.replace('.', ':').match(_TIME_RE);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 24) return null;
  return `${String(h % 24).padStart(2, '0')}:${m[2]}`;
}

function _normalize_time_field(inp) {
  const t = _norm_hm(inp.value);
  if (t) inp.value = t;
}

// −12…+12 full hours; blank means "no shift".
function _tz_options(sel) {
  const opts = ['<option value="">&mdash;</option>'];
  for (let h = 12; h >= -12; h--) {
    if (h === 0) continue;
    const label = h > 0 ? `+${h} h` : `${h} h`;
    opts.push(`<option value="${h}" ${String(sel) === String(h) ? 'selected' : ''}>${label}</option>`);
  }
  return opts.join('');
}

function update_sleep_night_hint() {
  const inp = document.querySelector('#modal-body [name="date"]');
  const el  = document.getElementById('sleep-night-hint');
  if (!inp || !el) return;
  if (!inp.value) { el.textContent = ''; return; }   // nothing chosen → say nothing
  const d = new Date(inp.value + 'T00:00:00');
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  const p  = x => String(x).padStart(2, '0');
  const dm = x => `${p(x.getDate())}.${p(x.getMonth() + 1)}.`;
  el.textContent = `Nacht vom ${dm(d)} auf den ${dm(n)}${n.getFullYear()}`;
}

function tpl_sleep(s = null) {
  const v = (k, d = '') => s && s[k] != null ? esc(s[k]) : d;
  return `<form>
    <label>Nacht vom
      <input type="date" name="date" value="${v('date', date_offset_local(-1))}" required
             oninput="update_sleep_night_hint()">
      <small id="sleep-night-hint" style="color:var(--pico-muted-color)"></small>
    </label>
    <div class="grid">
      <label>Zu Bett<input ${_time_attrs('23:00')} name="bed_time" value="${v('bed_time')}" required></label>
      <label>Aufgestanden<input ${_time_attrs('07:30')} name="up_time" value="${v('up_time')}" required></label>
    </div>
    <label>Schlafqualität (1&ndash;10)
      <input type="number" name="score" min="1" max="10" step="1" value="${v('score')}" required>
      <small style="color:var(--pico-muted-color)">Subjektiv: 1 = sehr schlecht, 10 = sehr gut</small>
    </label>
    <div class="grid">
      <label>Eingeschlafen (optional)<input ${_time_attrs('23:15')} name="asleep_time" value="${v('asleep_time')}"></label>
      <label>Aufgewacht (optional)<input ${_time_attrs('07:15')} name="awake_time" value="${v('awake_time')}"></label>
    </div>
    <label>Zeitverschiebung (optional)
      <select name="tz_shift">${_tz_options(s ? s.tz_shift : null)}</select>
      <small style="color:var(--pico-muted-color)">
        Wird auf beide Dauern gerechnet &mdash; z.B. +1 = eine Stunde mehr.
      </small>
    </label>
    <label>Kommentar (optional)<input type="text" name="comment" value="${v('comment')}"></label>
    <div class="form-footer">
      <button type="button" class="secondary outline" onclick="close_modal()">Abbrechen</button>
      <button type="submit">Speichern</button>
    </div>
  </form>`;
}

// Validate and shape the form. Throws with a German message, which open_modal
// surfaces to the user and which keeps the dialog open.
function _parse_sleep_form(data) {
  const { date, bed_time, up_time } = data;
  if (!date || !bed_time || !up_time) throw new Error('Datum, Zubettgeh- und Aufstehzeit sind nötig.');
  // Free-text time fields, so parse/normalise here (7:00 → 07:00, 24:00 → 00:00).
  const times = {};
  for (const [key, label] of [['bed_time', 'Zubettgeh'], ['up_time', 'Aufsteh'],
                              ['asleep_time', 'Einschlaf'], ['awake_time', 'Aufwach']]) {
    if (!data[key]) { times[key] = null; continue; }
    const t = _norm_hm(data[key]);
    if (!t) throw new Error(`${label}zeit bitte als 24-Stunden-Zeit angeben, z.B. 23:30.`);
    times[key] = t;
  }
  const score = parseInt(data.score, 10);
  if (isNaN(score) || score < 1 || score > 10) throw new Error('Schlafqualität muss zwischen 1 und 10 liegen.');

  const bed = times.bed_time, up = times.up_time;
  const in_bed = _mins_after(bed, up) || 1440;   // equal times = a full 24 h

  const asleep = times.asleep_time, awake = times.awake_time;
  // Offsets are measured from lights-out, so "after midnight" needs no special
  // case — anything past getting up simply lands beyond `in_bed`.
  if (asleep && _mins_after(bed, asleep) > in_bed)
    throw new Error('Einschlafzeit muss zwischen Zubettgehen und Aufstehen liegen.');
  if (awake && _mins_after(bed, awake) > in_bed)
    throw new Error('Aufwachzeit muss zwischen Zubettgehen und Aufstehen liegen.');
  if (asleep && awake && _mins_after(bed, asleep) > _mins_after(bed, awake))
    throw new Error('Aufwachzeit muss nach der Einschlafzeit liegen.');

  const tz = data.tz_shift ? parseInt(data.tz_shift, 10) : null;
  if (tz != null && (isNaN(tz) || tz < -12 || tz > 12))
    throw new Error('Zeitverschiebung muss zwischen -12 und +12 Stunden liegen.');

  return { date, bed_time: bed, up_time: up, score,
           asleep_time: asleep, awake_time: awake,
           tz_shift: tz, comment: data.comment || null };
}

function open_new_sleep() {
  open_modal('Nacht hinzufügen', tpl_sleep(), async data => {
    await api('POST', '/api/sleep', _parse_sleep_form(data));
    await load_sleep();
  });
  update_sleep_night_hint();
}

function open_edit_sleep(id) {
  const s = sleep_log.find(x => x.id === id);
  if (!s) return;
  open_modal('Nacht bearbeiten', tpl_sleep(s), async data => {
    await api('PUT', `/api/sleep/${id}`, _parse_sleep_form(data));
    await load_sleep();
  });
  update_sleep_night_hint();
}

async function del_sleep(id) {
  const s = sleep_log.find(x => x.id === id);
  if (!s || !confirm(`Eintrag für die Nacht vom ${fmt_de(s.date)} löschen?`)) return;
  await api('DELETE', `/api/sleep/${id}`);
  await load_sleep();
}

// ─── Körper ───────────────────────────────────────────────────────────────

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
        <td>${fmt_de(w.date)}</td>
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
  if (!w || !confirm(`Gewichts-Eintrag vom ${fmt_de(w.date)} (${w.weight_kg} kg) löschen?`)) return;
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
        <td>${fmt_de(m.date)}</td>
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
  if (!m || !confirm(`"${m.name}" vom ${fmt_de(m.date)} löschen?`)) return;
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
        <span>${fmt_de(p.date)}</span>
        <button class="photo-del" title="Löschen" onclick="del_body_photo(${p.id})">&#10005;</button>
      </figcaption>
    </figure>`).join('');
}

async function del_body_photo(id) {
  const p = body_photos.find(x => x.id === id);
  if (!p || !confirm(`Foto vom ${fmt_de(p.date)} löschen?`)) return;
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
  // Needs workouts (already loaded at init) + body weight + meals (Ernährung)
  try {
    if (!body_weight.length) {
      body_weight = await api('GET', '/api/body/weight');
    }
  } catch { /* body weight simply unavailable */ }
  try {
    if (!meals.length) meals = await api('GET', '/api/meals');
  } catch { /* meals simply unavailable */ }
  on_ana_type_change();   // populate series + plot dropdowns for the current Typ, then draw
}

// Plots available per Typ (dropdown 3 depends on dropdown 1).
const ANA_KINDS = {
  uebung:  [['verlauf', 'Gewichts-Verlauf'], ['volumen', 'Volumen pro Woche'],
            ['volumen_workout', 'Volumen pro Workout'], ['reps', 'Wiederholungen']],
  muskel:  [['sets_workout', 'Sätze pro Workout']],
  koerper: [['koerper', 'Verlauf']],
  ernaehrung: [['balken', 'Balken pro Tag']],
};

// Nutrition metrics for the Ernährung analysis type. `target` names the
// settings key whose value (if set) is drawn as a red reference line.
const ANA_NUTRITION = {
  kcal:    { label: 'Kalorien',      unit: 'kcal', field: 'kcal',      round: r_kcal, target: 'kcal_target' },
  protein: { label: 'Eiweiß',        unit: 'g',    field: 'protein_g', round: r_nut,  target: 'protein_target' },
  carbs:   { label: 'Kohlenhydrate', unit: 'g',    field: 'carbs_g',   round: r_nut,  target: null },
  fat:     { label: 'Fett',          unit: 'g',    field: 'fat_g',     round: r_nut,  target: null },
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
  } else if (type === 'ernaehrung') {
    sel.innerHTML = Object.entries(ANA_NUTRITION)
      .map(([v, c]) => `<option value="${v}">${esc(c.label)}</option>`).join('');
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

// Full date span of logged meals — the default x-axis for Ernährung charts.
function _nutrition_date_range() {
  if (!meals.length) return null;
  let min = meals[0].date, max = meals[0].date;
  for (const m of meals) { if (m.date < min) min = m.date; if (m.date > max) max = m.date; }
  return { min, max };
}

// One bar per day summing the chosen nutrition metric across that day's meals.
function _nutrition_daily(metric) {
  const cfg = ANA_NUTRITION[metric];
  if (!cfg || !meals.length) return null;
  const by = new Map();
  for (const m of meals) {
    let sum = 0;
    for (const it of m.items) sum += (it[cfg.field] || 0);
    by.set(m.date, (by.get(m.date) || 0) + sum);
  }
  const bars = [...by.keys()].sort().map(d => {
    const v = cfg.round(by.get(d));
    return { label: `${d.slice(8, 10)}.${d.slice(5, 7)}.`, date: d, value: v,
             title: `${fmt_de(d)}: ${v} ${cfg.unit}` };
  });
  return { bars, unit: cfg.unit };
}

function _bw_hint(name) {
  return `<p class="empty">„${esc(name)}" ist eine reine Körpergewichtsübung — ` +
         `kein Gewicht/Volumen verfügbar. Bitte „Wiederholungen" wählen.</p>`;
}

// Dispatch: Typ + Plot decide which chart to draw.
// Custom x-axis (time) window; null = full workout history.
let ana_x_range = null;

function _effective_range() {
  if (ana_x_range) return ana_x_range;
  const type = document.getElementById('ana-type')?.value;
  if (type === 'ernaehrung') return _nutrition_date_range();
  return _workout_date_range();
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

  if (type === 'ernaehrung') {
    const metric = ANA_NUTRITION[ser] ? ser : 'kcal';
    const cfg = ANA_NUTRITION[metric];
    const t = cfg.target ? parseFloat(settings[cfg.target]) : NaN;
    const target = (!isNaN(t) && t > 0) ? { value: t, label: 'Ziel' } : null;
    _render_bars(el, _range_bars(_nutrition_daily(metric)),
      cfg.label, 'Noch keine Ernährungsdaten vorhanden.', target, range);
  } else if (type === 'koerper') {
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
    // Isometric holds have volume (seconds) even without added weight, so they
    // are never treated as "just bodyweight" for plotting.
    const is_bw = !_is_isometric_ex(name) && _is_bodyweight(name);
    if (kind === 'reps') {
      render_line_chart(el, _reps_points(name), 'Wiederholungen: ' + name, range);
    } else if (is_bw) {
      el.innerHTML = _bw_hint(name);
    } else if (kind === 'verlauf') {
      render_line_chart(el, _weight_points(name), 'Gewichts-Verlauf: ' + name, range);
    } else if (kind === 'volumen') {
      _render_bars(el, _range_bars(_volume_weeks(name)), 'Wöchentliches Volumen', '');
    } else if (kind === 'volumen_workout') {
      _render_bars(el, _range_bars(_volume_all_workouts(name)), 'Volumen pro Workout', '', null, range);
    }
  }
  _render_range_bar();
}

// ── x-axis range control (small button under the chart) ──
function _render_range_bar() {
  const bar = document.getElementById('ana-range-bar');
  if (!bar) return;
  const eff = _effective_range();
  const label = eff ? `${fmt_de(eff.min)} – ${fmt_de(eff.max)}` : 'ganzer Zeitraum';
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

// Weight progression for an exercise: max = heaviest set that day, avg =
// reps-weighted mean over all sets that day (a set carries more weight in the
// average the more reps it had), in the series' original entry unit (as logged).
// Bodyweight sets (no added weight) count as 0 — so a partially-weighted
// exercise (e.g. Situps) shows the BW workouts as zero rather than skipping them.
function _weight_points(name) {
  const unit = _series_unit(name);
  const by_date = new Map();               // date -> [{ w, r }] per set
  for (const s of workouts) {
    for (const ex of s.exercises) {
      if (ex.exercise_name !== name) continue;
      const reps  = JSON.parse(ex.reps_per_set);
      const nsets = ex.sets || reps.length;
      let weights;
      if (_has_weight(ex)) {
        const raw = unit === 'lbs' ? ex.weight_lbs : ex.weight_kg;
        weights = JSON.parse(raw).map(v => v ?? 0);   // BW sets within the entry → 0
      } else {
        weights = Array(nsets).fill(0);               // whole entry was bodyweight → 0
      }
      if (!weights.length) continue;
      if (!by_date.has(s.date)) by_date.set(s.date, []);
      const arr = by_date.get(s.date);
      weights.forEach((w, i) => arr.push({ w, r: reps[i] ?? 1 }));
    }
  }
  const round1 = v => Math.round(v * 10) / 10;
  const points = [...by_date.entries()].map(([date, sets]) => {
    const rep_sum = sets.reduce((a, s) => a + (s.r || 0), 0);
    const avg = rep_sum > 0
      ? sets.reduce((a, s) => a + s.w * (s.r || 0), 0) / rep_sum   // reps-weighted
      : sets.reduce((a, s) => a + s.w, 0) / sets.length;          // no reps → plain mean
    return { date, avg: round1(avg), max: Math.max(...sets.map(s => s.w)) };
  }).sort((a, b) => a.date.localeCompare(b.date));
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
// Isometric: Σ hold time (seconds). Weighted: Σ reps × weight (per-side weights
// count double). Bodyweight: Σ reps.
function _exercise_volume(ex, is_bw, unit, mult) {
  if (_is_isometric_ex(ex.exercise_name)) {
    if (!ex.duration_s) return 0;
    return JSON.parse(ex.duration_s).reduce((a, d) => a + (d || 0), 0);
  }
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

function _is_isometric_ex(name) {
  return !!_exercise_meta(name)?.is_isometric;
}

// Unit label for a volume chart: seconds for isometric holds, else weight×reps.
function _volume_unit(name) {
  return _is_isometric_ex(name) ? 's' : `${_series_unit(name)}×Wdh`;
}

// Weekly training volume for a (weighted) exercise. The week axis spans the
// full workout history (first→last workout week); untrained weeks show zero.
function _volume_weeks(name) {
  const unit  = _volume_unit(name);
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
  const unit  = _volume_unit(name);
  const wunit = _series_unit(name);
  const mult  = _is_per_hand(name) ? 2 : 1;
  const short = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  const bars = _all_sessions_sorted().map(s => {
    let v = 0;
    for (const ex of s.exercises)
      if (ex.exercise_name === name) v += _exercise_volume(ex, false, wunit, mult);
    v = Math.round(v);
    return { label: short(s.date), value: v, date: s.date, title: `${fmt_de(s.date)}: ${v} ${unit}` };
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

// Generic vertical bar chart. bars: [{label, value, title, date}].
// `target` (optional) = {value, label} → drawn as a red reference line.
// `x_range` (optional) = {min, max} → bars are placed on a proportional time
// axis (equidistant by date, gaps preserved) instead of packed edge-to-edge.
function _render_bars(el, res, caption, empty_msg, target = null, x_range = null) {
  if (res === null) { el.innerHTML = `<p class="empty">${empty_msg}</p>`; return; }
  const { bars, unit } = res;
  if (!bars.length) { el.innerHTML = '<p class="empty">Keine Daten für diese Auswahl vorhanden.</p>'; return; }

  const { W, H, top, right, bottom, left } = _ANA;
  const iw = W - left - right, ih = H - top - bottom;
  const max_v = Math.max(0, ...bars.map(b => b.value), target ? target.value : 0);
  const ticks = _nice_ticks(0, max_v);
  const y_max = ticks[ticks.length - 1] || 1;
  const Y = v => top + ih - (v / y_max) * ih;
  const target_svg = target ? `
    <line x1="${left}" y1="${Y(target.value).toFixed(1)}" x2="${left + iw}" y2="${Y(target.value).toFixed(1)}"
          stroke="#e34948" stroke-width="2" stroke-dasharray="6 4"/>
    <text x="${left + iw}" y="${(Y(target.value) - 6).toFixed(1)}" text-anchor="end"
          class="ana-endlabel" fill="#e34948">${esc(target.label)}: ${target.value}</text>` : '';

  const n    = bars.length;
  const grid = ticks.map(v =>
    `<line x1="${left}" y1="${Y(v)}" x2="${left + iw}" y2="${Y(v)}" stroke="var(--ana-grid)" stroke-width="1"/>
     <text x="${left - 8}" y="${Y(v) + 4}" text-anchor="end" class="ana-tick">${v}</text>`).join('');

  // Per-bar centre x + bar width, and which bars get an x-axis date label.
  const time_axis = x_range && bars.every(b => b.date);
  let center, bw, show_lbl;
  if (time_axis) {
    const t     = d => new Date(d + 'T00:00:00').getTime();
    const t_min = t(x_range.min), t_max = t(x_range.max);
    const span  = Math.max(t_max - t_min, 1);
    center = b => left + ((t(b.date) - t_min) / span) * iw;
    if (n === 1) {
      bw = Math.min(64, iw * 0.3);
      center = () => left + iw / 2;
    } else {
      const xs = bars.map(center).sort((a, b) => a - b);
      let gap = Infinity;
      for (let i = 1; i < xs.length; i++) gap = Math.min(gap, xs[i] - xs[i - 1]);
      bw = Math.max(6, Math.min(gap * 0.7, 56));
    }
    // ≤6 evenly-picked dates as x labels (matches the line chart).
    const n_lbl = Math.min(6, n);
    const lbl_ix = new Set(Array.from({ length: n_lbl },
      (_, i) => Math.round(i * (n - 1) / Math.max(n_lbl - 1, 1))));
    show_lbl = i => lbl_ix.has(i);
  } else {
    const slot = iw / n;
    bw = Math.min(slot * 0.62, 64);
    center = (_b, i) => left + i * slot + slot / 2;
    const lbl_every = Math.ceil(n / 12);
    show_lbl = i => i % lbl_every === 0;
  }
  const fmt_d = d => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}`;

  const svg_bars = bars.map((b, i) => {
    const cx = center(b, i);
    const x  = Math.max(left, Math.min(cx - bw / 2, left + iw - bw));
    const y  = Y(b.value);
    const lbl = show_lbl(i)
      ? `<text x="${cx.toFixed(1)}" y="${top + ih + 22}" text-anchor="middle" class="ana-tick">${esc(time_axis ? fmt_d(b.date) : b.label)}</text>` : '';
    const val = (n <= 14 && b.value > 0)
      ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" class="ana-endlabel">${b.value}</text>` : '';
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
        ${target_svg}
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
                    fill="${s.color}" rx="2"><title>${fmt_de(b.date)} · ${esc(s.label)}: ${val} Sätze</title></rect>`;
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
    `<tr><td>${fmt_de(b.date)}</td>${series.map(s => `<td>${b.segments[s.key] || 0}</td>`).join('')}</tr>`).join('');

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
          `<tr><td>${fmt_de(p.date)}</td><td>${p.max}</td>${single ? '' : `<td>${p.avg}</td>`}</tr>`).join('')}</tbody>
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
    tip.appendChild(tip_row(null, fmt_de(p.date), false));

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
load_settings().then(load_meals);   // targets before rendering
load_exercise_catalog();
_init_photo_dropzone();
// foods_db / body / analysis data loaded on demand when their tab is opened
