const TZ = 'Europe/Berlin';
const MAX_DAYS_AHEAD = 14;
const LABELS = { free: 'free', pending: 'pre-booked (unconfirmed)', booked: 'booked', closed: 'closed', unknown: 'unknown' };

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

function berlinNow() {
  // "sv-SE" formats as "YYYY-MM-DD HH:MM:SS"
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const state = {
  building: params.get('building') === 'Neuenheim' ? 'Neuenheim' : 'Altstadt',
  date: params.get('date') || berlinNow().date,
  duration: Number(params.get('duration') || 0),
  data: null,
};

function syncUrl() {
  const p = new URLSearchParams({ building: state.building, date: state.date });
  if (state.duration) p.set('duration', state.duration);
  history.replaceState(null, '', '?' + p);
}

// For every room: length (in slots) of the contiguous free block each slot belongs to,
// and how many free slots follow from each slot (inclusive).
function analyze(data) {
  const n = data.slots.length;
  const step = data.slot_minutes;
  const contiguous = (i) => i + 1 < n && toMin(data.slots[i + 1].time) - toMin(data.slots[i].time) === step;
  return data.rooms.map((_, j) => {
    const runAhead = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      if (data.slots[i].cells[j]?.state === 'free') runAhead[i] = 1 + (contiguous(i) ? runAhead[i + 1] : 0);
    }
    const blockLen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (runAhead[i] && (i === 0 || !blockLen[i - 1] || !contiguous(i - 1))) {
        for (let k = i; k < i + runAhead[i]; k++) blockLen[k] = runAhead[i];
      }
    }
    return { runAhead, blockLen };
  });
}

function render() {
  const data = state.data;
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!data) return;

  const info = analyze(data);
  const now = berlinNow();
  const isToday = data.date === now.date;
  const nowMin = toMin(now.time);
  const currentIdx = isToday
    ? data.slots.findIndex((s) => toMin(s.time) <= nowMin && nowMin < toMin(s.time) + data.slot_minutes)
    : -1;

  const thead = grid.createTHead().insertRow();
  thead.innerHTML = '<th class="time"></th>' + data.rooms.map((r) => `<th>${r}</th>`).join('');

  const tbody = grid.createTBody();
  data.slots.forEach((slot, i) => {
    const tr = tbody.insertRow();
    if (i === currentIdx) tr.className = 'current';
    tr.insertCell().outerHTML = `<td class="time">${slot.time}</td>`;
    slot.cells.forEach((cell, j) => {
      const td = tr.insertCell();
      let cls = cell.state;
      const end = fromMin(toMin(slot.time) + data.slot_minutes);
      let title = `${data.rooms[j]} ${slot.time}–${end}: ${LABELS[cell.state] || cell.state}`;
      if (cell.state === 'free') {
        const until = fromMin(toMin(slot.time) + info[j].runAhead[i] * data.slot_minutes);
        title += ` (until ${until})`;
        if (state.duration) cls = info[j].blockLen[i] >= state.duration ? 'fits' : 'free dim';
      } else if (cell.from && cell.to && cell.state !== 'closed') {
        title += ` (${cell.from}–${cell.to})`;
      }
      td.className = cls;
      td.title = title;
    });
  });

  renderNow(data, info, currentIdx, isToday);
  $('#book').href = data.booking_url;
}

function renderNow(data, info, idx, isToday) {
  const section = $('#now');
  const list = $('#now-list');
  if (!isToday || idx < 0) { section.hidden = true; return; }
  section.hidden = false;
  const need = Math.max(state.duration, 1);
  const items = data.rooms
    .map((room, j) => ({ room, run: info[j].runAhead[idx] }))
    .filter((x) => x.run >= need)
    .sort((a, b) => b.run - a.run);
  list.innerHTML = items.length
    ? items.map((x) => `<li><b>${x.room}</b>until ${fromMin(toMin(data.slots[idx].time) + x.run * data.slot_minutes)}</li>`).join('')
    : '<li class="none">No room free right now' + (state.duration ? ' for that long' : '') + '.</li>';
}

async function load() {
  syncUrl();
  const status = $('#status');
  status.className = '';
  status.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/availability?building=${state.building}&date=${state.date}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    state.data = json;
    status.textContent = json.slots.length
      ? `Updated ${new Date(json.fetched_at * 1000).toLocaleTimeString('de-DE', { timeZone: TZ })}`
      : 'No bookable slots for this day.';
    render();
  } catch (err) {
    status.className = 'error';
    status.textContent = `Could not load data: ${err.message}`;
  }
}

function init() {
  const today = berlinNow().date;
  const dateInput = $('#date');
  dateInput.min = today;
  dateInput.max = addDays(today, MAX_DAYS_AHEAD);
  if (state.date < dateInput.min || state.date > dateInput.max) state.date = today;
  dateInput.value = state.date;
  dateInput.addEventListener('change', () => { if (dateInput.value) { state.date = dateInput.value; load(); } });

  $('#duration').value = String(state.duration);
  $('#duration').addEventListener('change', (e) => { state.duration = Number(e.target.value); syncUrl(); render(); });

  document.querySelectorAll('#building button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.building === state.building);
    btn.addEventListener('click', () => {
      state.building = btn.dataset.building;
      document.querySelectorAll('#building button').forEach((b) => b.classList.toggle('active', b === btn));
      load();
    });
  });

  load();
  setInterval(load, 60_000);
}

init();
