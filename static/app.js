const TZ = 'Europe/Berlin';
const MAX_DAYS_AHEAD = 14;
const SOON_MINUTES = 10;
const REFRESH_MS = 60_000;
const BUILDINGS = ['Altstadt', 'Neuenheim'];
const DURATIONS = [[0, 'Any'], [1, '30 min'], [2, '1 h'], [3, '1.5 h'], [4, '2 h'], [6, '3 h']];
const svg = (d) => `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  free: svg('<path d="M20 6 9 17l-5-5"/>'),
  soon: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>'),
  next: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
};
const LABELS = { free: 'Free', pending: 'Pre-booked', booked: 'Booked', closed: 'Closed', unknown: 'Unknown' };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fmtDuration = (slots, step = 30) => { const m = slots * step; const h = Math.floor(m / 60); return h ? `${h} h${m % 60 ? ' 30' : ''}` : `${m} min`; };

function berlinNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: TZ }); // "YYYY-MM-DD HH:MM:SS"
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function roomFeatures(building, room) {
  const r = room.toUpperCase();
  if (building === 'Neuenheim') return { tags: ['Smartboard'], accessible: true };
  let tags = ['Whiteboard'];
  if (r === 'O2.1' || r === 'O3.1') tags = ['Smartboard', 'Beamer'];
  else if (r === 'W3.1' || r === 'W3.2') tags = ['Smartscreen'];
  return { tags, accessible: r.startsWith('W3.') };
}

/* ---------- persistent state ---------- */
const params = new URLSearchParams(location.search);
const state = {
  building: BUILDINGS.includes(params.get('building')) ? params.get('building') : 'Altstadt',
  date: params.get('date') || berlinNow().date,
  duration: Number(params.get('duration') || 0),
  data: null,
  announce: false,
};

const notify = Object.assign(
  { enabled: false, mode: 'page', buildings: [state.building], minSlots: 0 },
  JSON.parse(localStorage.getItem('notify') || '{}'),
);
const saveNotify = () => localStorage.setItem('notify', JSON.stringify(notify));

const notified = new Set(JSON.parse(localStorage.getItem('notified') || '[]').filter((k) => k.startsWith(berlinNow().date)));
const saveNotified = () => localStorage.setItem('notified', JSON.stringify([...notified]));

function syncUrl() {
  const p = new URLSearchParams({ building: state.building, date: state.date });
  if (state.duration) p.set('duration', state.duration);
  history.replaceState(null, '', '?' + p);
}

/* ---------- data analysis ---------- */
// Per room: runAhead[i] = free slots starting at i (inclusive); blockLen[i] = length of the free block containing i.
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

function summarize(data, minSlots) {
  const info = analyze(data);
  const now = berlinNow();
  const step = data.slot_minutes;
  const isToday = data.date === now.date;
  const nowMin = toMin(now.time);
  const currentIdx = isToday ? data.slots.findIndex((s) => toMin(s.time) <= nowMin && nowMin < toMin(s.time) + step) : -1;
  const startIdx = !isToday ? 0 : currentIdx >= 0 ? currentIdx : data.slots.findIndex((s) => toMin(s.time) > nowMin);
  const need = Math.max(minSlots, 1);

  const rooms = data.rooms.map((name, j) => {
    const { runAhead } = info[j];
    const cells = data.slots.map((s) => s.cells[j]?.state || 'unknown');
    let next = null;
    if (startIdx >= 0) {
      for (let i = startIdx; i < cells.length; i++) {
        if (runAhead[i] >= need) {
          next = { idx: i, from: data.slots[i].time, to: fromMin(toMin(data.slots[i].time) + runAhead[i] * step), slots: runAhead[i] };
          break;
        }
      }
    }
    const freeNow = Boolean(isToday && next && next.idx === currentIdx);
    const minutesUntil = isToday && next ? toMin(next.from) - nowMin : null;
    const soon = Boolean(isToday && next && !freeNow && minutesUntil > 0 && minutesUntil <= SOON_MINUTES);
    const allClosed = cells.length > 0 && cells.every((c) => c === 'closed');
    return { name, j, cells, next, freeNow, soon, minutesUntil, allClosed, features: roomFeatures(data.building, name) };
  });
  return { rooms, info, isToday, currentIdx };
}

/* ---------- rendering ---------- */
function renderDates() {
  const today = berlinNow().date;
  if (state.date < today || state.date > addDays(today, MAX_DAYS_AHEAD)) state.date = today;
  const el = $('#dates');
  el.innerHTML = '';
  for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
    const d = addDays(today, i);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const b = document.createElement('button');
    b.className = 'chip' + (d === state.date ? ' active' : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(d === state.date));
    b.setAttribute('aria-label', new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) + (i < 2 ? ` (${label})` : ''));
    b.onclick = () => { state.date = d; state.announce = true; renderDates(); el.querySelector('.active')?.focus(); load(); };
    el.appendChild(b);
  }
  const a = el.querySelector('.active');
  if (a) el.scrollTo({ left: Math.max(0, a.offsetLeft - el.offsetLeft - 24), behavior: 'auto' });
  updateDayArrows();
}

function updateDayArrows() {
  const el = $('#dates');
  const max = el.scrollWidth - el.clientWidth - 1;
  el.classList.toggle('at-start', el.scrollLeft <= 1);
  el.classList.toggle('at-end', el.scrollLeft >= max);
  $('#days-prev').disabled = el.scrollLeft <= 1;
  $('#days-next').disabled = el.scrollLeft >= max;
}

function initDayStrip() {
  const el = $('#dates');
  const page = (dir) => el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#days-prev').onclick = () => page(-1);
  $('#days-next').onclick = () => page(1);
  el.addEventListener('scroll', updateDayArrows, { passive: true });
  addEventListener('resize', updateDayArrows);
}

function renderChips(el, value, onPick) {
  el.innerHTML = '';
  for (const [v, label] of DURATIONS) {
    const b = document.createElement('button');
    b.className = 'chip' + (v === value ? ' active' : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(v === value));
    b.onclick = () => { onPick(v); el.querySelector('.active')?.focus(); };
    el.appendChild(b);
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  const sum = summarize(data, state.duration);
  const focusKey = document.activeElement?.dataset?.key;
  renderStats(data, sum);
  renderRooms(data, sum);
  renderGrid(data, sum);
  $('#book-footer').href = data.booking_url;
  if (focusKey) document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  if (state.announce) {
    state.announce = false;
    announce(describe(data, sum));
  }
}

function describe(data, sum) {
  const day = sum.isToday ? 'today' : new Date(data.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const need = state.duration ? ` for at least ${fmtDuration(state.duration)}` : '';
  const open = sum.rooms.filter((r) => !r.allClosed).length;
  if (!data.slots.length) return `${data.building}, ${day}: no bookable slots.`;
  if (sum.isToday) {
    const now = sum.rooms.filter((r) => r.freeNow).length;
    const soon = sum.rooms.filter((r) => r.soon).length;
    return `${data.building}, ${day}: ${now} of ${open} rooms free now${need}, ${soon} more within ${SOON_MINUTES} minutes.`;
  }
  return `${data.building}, ${day}: ${sum.rooms.filter((r) => r.next).length} of ${sum.rooms.length} rooms have free time${need}.`;
}

function announce(text) {
  const el = $('#announce');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 50);
}

function statCard(icon, cls, value, label) {
  return `<div class="card stat"><div class="icon ${cls}">${icon}</div><div><b>${value}</b><span>${label}</span></div></div>`;
}

function renderStats(data, sum) {
  const total = sum.rooms.length;
  const open = sum.rooms.filter((r) => !r.allClosed).length;
  let html;
  if (sum.isToday) {
    const freeNow = sum.rooms.filter((r) => r.freeNow).length;
    const soon = sum.rooms.filter((r) => r.soon).length;
    const upcoming = sum.rooms.filter((r) => r.next && !r.freeNow).map((r) => r.next.from).sort()[0];
    html = statCard(ICON.free, 'free', `${freeNow}<small class="muted" style="font-size:.9rem;font-weight:600"> / ${open}</small>`, 'free right now')
      + statCard(ICON.soon, 'soon', soon, `free within ${SOON_MINUTES} min`)
      + statCard(ICON.next, 'booked', upcoming || '—', 'next room frees up');
  } else {
    const withFree = sum.rooms.filter((r) => r.next).length;
    const freeSlots = sum.rooms.reduce((a, r) => a + r.cells.filter((c) => c === 'free').length, 0);
    const earliest = sum.rooms.filter((r) => r.next).map((r) => r.next.from).sort()[0];
    html = statCard(ICON.free, 'free', `${withFree}<small class="muted" style="font-size:.9rem;font-weight:600"> / ${total}</small>`, 'rooms with free time')
      + statCard(ICON.soon, 'soon', `${(freeSlots * data.slot_minutes / 60).toFixed(1)} h`, 'free room-hours')
      + statCard(ICON.next, 'booked', earliest || '—', 'earliest free slot');
  }
  $('#stats').innerHTML = html;
}

function roomView(r, sum) {
  const need = state.duration ? ` for ${fmtDuration(state.duration)}` : '';
  if (r.allClosed) return { cls: 'closed', badge: ['', 'Closed'], main: 'Closed all day' };
  if (r.freeNow) return { cls: 'free', badge: ['free', 'Free now'], main: `Free until ${r.next.to}`, sub: `${fmtDuration(r.next.slots)} available` };
  if (r.soon) return { cls: 'soon', badge: ['soon', `In ${r.minutesUntil} min`], main: `Free ${r.next.from} – ${r.next.to}`, sub: `${fmtDuration(r.next.slots)} available` };
  if (r.next) {
    return sum.isToday
      ? { cls: 'later', badge: ['booked', 'Busy now'], main: `Free from ${r.next.from}`, sub: `until ${r.next.to} · ${fmtDuration(r.next.slots)}` }
      : { cls: 'free', badge: ['free', 'Available'], main: `First free ${r.next.from}`, sub: `until ${r.next.to} · ${fmtDuration(r.next.slots)}` };
  }
  return { cls: 'booked', badge: ['booked', 'Fully booked'], main: `No free slot${need}`, sub: sum.isToday ? 'for the rest of today' : '' };
}

function renderRooms(data, sum) {
  const rank = (r) => (r.allClosed ? 5 : r.freeNow ? 0 : r.soon ? 1 : r.next ? 2 : 4);
  const rooms = [...sum.rooms].sort((a, b) => rank(a) - rank(b)
    || (a.freeNow && b.freeNow ? b.next.slots - a.next.slots : 0)
    || (a.next && b.next ? a.next.idx - b.next.idx : 0));
  const el = $('#rooms');
  if (!rooms.length || !data.slots.length) {
    el.innerHTML = `<div class="card empty">${sum.isToday ? 'The library is closed for today — pick another day.' : 'No bookable slots on this day.'}</div>`;
    return;
  }
  el.innerHTML = rooms.map((r) => {
    const v = roomView(r, sum);
    const bar = r.cells.map((c, i) => `<i class="${c}${i === sum.currentIdx ? ' now' : ''}"></i>`).join('');
    const tags = r.features.tags.map((t) => `<span class="tag">${t}</span>`).join('')
      + (r.features.accessible ? '<span class="tag"><span aria-hidden="true">♿ </span>Barrier-free</span>' : '');
    const id = `room-${r.j}`;
    return `<article class="card room ${v.cls}${r.allClosed ? ' dim' : ''}" aria-labelledby="${id}">
      <div class="room-top"><h3 class="room-name" id="${id}">${esc(r.name)}</h3><span class="badge ${v.badge[0]}">${v.badge[1]}</span></div>
      <p class="room-main">${v.main}${v.sub ? `<small>${v.sub}</small>` : ''}</p>
      <div class="bar" aria-hidden="true">${bar}</div>
      <div class="room-foot"><div class="tags" aria-label="Equipment">${tags}</div>${r.next ? `<a class="book" data-key="book-${esc(r.name)}" href="${esc(data.booking_url)}" target="_blank" rel="noopener" aria-label="Book ${esc(r.name)} on the UB website (opens in new tab)">Book <span aria-hidden="true">↗</span></a>` : ''}</div>
    </article>`;
  }).join('');
}

function renderGrid(data, sum) {
  const grid = $('#grid');
  grid.innerHTML = '';
  const step = data.slot_minutes;
  grid.createCaption().outerHTML = `<caption class="sr-only">Availability of every room in ${esc(data.building)} by half-hour slot</caption>`;
  grid.createTHead().insertRow().innerHTML = '<th class="time" scope="col"><span class="sr-only">Time</span></th>' + data.rooms.map((r) => `<th scope="col">${esc(r)}</th>`).join('');
  const tbody = grid.createTBody();
  data.slots.forEach((slot, i) => {
    const tr = tbody.insertRow();
    if (i === sum.currentIdx) tr.className = 'current';
    tr.insertCell().outerHTML = `<th class="time" scope="row">${esc(slot.time)}${i === sum.currentIdx ? '<span class="sr-only"> (now)</span>' : ''}</th>`;
    slot.cells.forEach((cell, j) => {
      const td = tr.insertCell();
      const { runAhead, blockLen } = sum.info[j];
      let label = LABELS[cell.state] || cell.state;
      let cls = cell.state;
      if (cell.state === 'free') {
        label += ` until ${fromMin(toMin(slot.time) + runAhead[i] * step)}`;
        if (state.duration && blockLen[i] < state.duration) { cls += ' dim'; label += ' (too short)'; }
      } else if (cell.from && cell.to && cell.state !== 'closed') {
        label += ` ${cell.from}–${cell.to}`;
      }
      td.className = cls;
      td.title = `${data.rooms[j]} ${slot.time}: ${label}`;
      td.innerHTML = `<span class="sr-only">${esc(label)}</span>`;
    });
  });
}

/* ---------- data loading ---------- */
async function fetchData(building, date) {
  const res = await fetch(`/api/availability?building=${encodeURIComponent(building)}&date=${encodeURIComponent(date)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function load() {
  syncUrl();
  const status = $('#status');
  try {
    const data = await fetchData(state.building, state.date);
    if (data.building !== state.building || data.date !== state.date) return; // stale response
    state.data = data;
    status.className = 'status';
    status.textContent = `${data.building} · updated ${new Date(data.fetched_at * 1000).toLocaleTimeString('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`;
    render();
  } catch (err) {
    status.className = 'status error';
    status.textContent = `Could not load data: ${err.message}`;
  }
}

/* ---------- notifications ---------- */
function toast(title, body) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span><button type="button" aria-label="Dismiss notification">×</button>`;
  el.querySelector('button').onclick = () => el.remove();
  $('#toasts').appendChild(el);
  let timer = setTimeout(() => el.remove(), 12_000);
  const pause = () => clearTimeout(timer);
  const resume = () => { timer = setTimeout(() => el.remove(), 4_000); };
  el.addEventListener('mouseenter', pause);
  el.addEventListener('focusin', pause);
  el.addEventListener('mouseleave', resume);
  el.addEventListener('focusout', resume);
}

async function sendNotification(title, body, tag) {
  toast(title, body);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'icon-192.png', badge: 'badge-96.png', data: { url: location.href } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch (e) {
    console.warn('Notification failed', e);
  }
}

/* ---------- push (alerts while the app is closed) ---------- */
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const push = { supported: false, publicKey: null };
const permissionGranted = () => 'Notification' in window && Notification.permission === 'granted';

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const r = await (await fetch('/api/push/key')).json();
    Object.assign(push, { supported: Boolean(r.enabled), publicKey: r.publicKey });
  } catch { /* offline: keep in-page alerts */ }
}

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function syncPush(confirm = false) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(push.publicKey) });
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), buildings: notify.buildings, minSlots: notify.minSlots, confirm }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
}

async function stopPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe();
}

function onNotifyPrefsChange() {
  saveNotify();
  if (notify.enabled && notify.mode === 'push' && notify.buildings.length) syncPush().catch(() => {});
  renderNotify();
  checkAlerts();
}

// Re-register on every visit so the server learns the subscription again after a restart.
async function resumePush() {
  if (!notify.enabled || !push.supported || !permissionGranted() || !notify.buildings.length) return;
  try {
    await syncPush();
    notify.mode = 'push';
  } catch {
    notify.mode = 'page';
  }
  saveNotify();
  renderNotify();
}

async function checkAlerts() {
  if (!notify.enabled || notify.mode === 'push') return;
  const today = berlinNow().date;
  for (const building of notify.buildings) {
    let data = state.data;
    if (!data || data.building !== building || data.date !== today) {
      try { data = await fetchData(building, today); } catch { continue; }
    }
    for (const r of summarize(data, notify.minSlots).rooms) {
      if (!r.soon) continue;
      const key = `${today}|${building}|${r.name}|${r.next.from}`;
      if (notified.has(key)) continue;
      notified.add(key);
      saveNotified();
      sendNotification(
        `${r.name} is free in ${r.minutesUntil} min`,
        `${building} · free ${r.next.from}–${r.next.to} (${fmtDuration(r.next.slots)})`,
        key,
      );
    }
  }
}

function renderNotify() {
  const on = notify.enabled;
  $('#notify-btn').classList.toggle('on', on);
  $('#notify-label').textContent = on ? 'Alerts on' : 'Notify me';
  const toggle = $('#notify-toggle');
  toggle.textContent = on ? 'Turn off' : 'Turn on';
  toggle.classList.toggle('off', on);
  let status;
  if (on && !notify.buildings.length) status = 'Choose at least one building.';
  else if (on && notify.mode === 'push') status = 'Alerts arrive even when the app is closed.';
  else if (isIOS && !isStandalone) status = 'On iPhone/iPad: tap Share → “Add to Home Screen”, open Room Finder from your Home Screen and turn alerts on there to get them while the app is closed.';
  else if (push.supported && !on) status = 'Alerts arrive even when the app is closed.';
  else status = 'Alerts appear only while this page is open.';
  $('#notify-status').textContent = status;
  $$('input[name="watch-building"]').forEach((cb) => { cb.checked = notify.buildings.includes(cb.value); });
  renderChips($('#watch-duration'), notify.minSlots, (v) => { notify.minSlots = v; onNotifyPrefsChange(); });
}

async function toggleNotify() {
  if (notify.enabled) {
    if (notify.mode === 'push') stopPush().catch(() => {});
    notify.enabled = false;
    notify.mode = 'page';
    saveNotify();
    renderNotify();
    return;
  }
  if (!notify.buildings.length) notify.buildings = [state.building];
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  notify.mode = 'page';
  if (permissionGranted() && push.supported) {
    try {
      await syncPush(true);
      notify.mode = 'push';
    } catch (err) {
      console.warn('Push subscription failed, using in-page alerts', err);
    }
  }
  notify.enabled = true;
  saveNotify();
  renderNotify();
  const where = notify.buildings.join(' & ');
  if (notify.mode === 'push') {
    toast('Alerts on', `You'll get a notification when a room in ${where} frees up within ${SOON_MINUTES} minutes — even when the app is closed.`);
  } else if (!permissionGranted()) {
    toast('Alerts on (in-page only)', 'Browser notifications are blocked or unsupported — alerts will appear here while this page is open.');
  } else {
    sendNotification('Alerts on', `We'll tell you when a room in ${where} frees up within ${SOON_MINUTES} minutes while this page is open.`, 'enabled');
  }
  checkAlerts();
}

/* ---------- install ---------- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-btn').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-btn').hidden = true;
});

/* ---------- init ---------- */
function tick() {
  $('#clock').textContent = berlinNow().time;
}

function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  initDayStrip();
  renderDates();
  const pickDuration = (v) => {
    state.duration = v;
    state.announce = true;
    syncUrl();
    renderChips($('#duration'), v, pickDuration);
    render();
  };
  renderChips($('#duration'), state.duration, pickDuration);

  $$('#building button').forEach((btn) => {
    const sync = () => $$('#building button').forEach((b) => {
      b.classList.toggle('active', b.dataset.building === state.building);
      b.setAttribute('aria-pressed', String(b.dataset.building === state.building));
    });
    sync();
    btn.onclick = () => {
      state.building = btn.dataset.building;
      state.announce = true;
      sync();
      load();
    };
  });

  const setPanel = (open) => {
    $('#notify-panel').hidden = !open;
    $('#notify-btn').setAttribute('aria-expanded', String(open));
    if (open) $('#notify-title').focus();
  };
  $('#notify-btn').onclick = () => setPanel($('#notify-panel').hidden);
  $('#notify-panel').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setPanel(false); $('#notify-btn').focus(); }
  });
  $('#notify-toggle').onclick = toggleNotify;
  $$('input[name="watch-building"]').forEach((cb) => {
    cb.onchange = () => {
      notify.buildings = $$('input[name="watch-building"]:checked').map((x) => x.value);
      onNotifyPrefsChange();
    };
  });
  renderNotify();
  initPush().then(resumePush).then(renderNotify);

  if (isIOS && !isStandalone) $('#install-btn').hidden = false;
  $('#install-btn').onclick = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $('#install-btn').hidden = true;
    } else {
      toast('Install on iPhone / iPad', 'In Safari, tap the Share button, then “Add to Home Screen”.');
    }
  };

  tick();
  setInterval(tick, 10_000);
  load().then(checkAlerts);
  setInterval(async () => {
    if (state.date < berlinNow().date) renderDates();
    await load();
    checkAlerts();
  }, REFRESH_MS);
}

init();
