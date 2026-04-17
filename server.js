const express = require('express');
const fetch = require('node-fetch');
const COURSES = require('./courses');

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


const START_HOUR = 7;
const END_HOUR = 18;
const MAX_PLAYERS = 4;

// --- Data fetching ---

function generateTeeTimes(date) {
  const times = [];
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    for (let m = 0; m < 60; m += 10) {
      times.push(`${date} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    }
  }
  return times;
}

async function fetchCourseAvailability(course, date) {
  const url = `https://${course.domain}/api/1.0/reservations/?productid=${course.productId}&date=${date}&golf=${course.golfId}`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // Build reservationTimeId -> {start, status} map, optionally filtered by resourceId
  const rowById = {};
  for (const row of (data.rows || [])) {
    if (course.resourceId) {
      const hasResource = (row.resources || []).some(r => r.resourceId === course.resourceId);
      if (!hasResource) continue;
    }
    rowById[row.reservationTimeId] = { start: row.start, status: row.status };
  }

  // If no rows and course pre-creates slots, calendar is genuinely closed for this date
  if (Object.keys(rowById).length === 0 && course.closedIfNoRows) {
    return { course, slots: [], closed: true, error: null };
  }

  // Count booked players per start time
  const bookingCount = {};
  for (const player of (data.reservationsGolfPlayers || [])) {
    const row = rowById[player.reservationTimeId];
    if (row) bookingCount[row.start] = (bookingCount[row.start] || 0) + 1;
  }

  // For courses that pre-create slots, status-4 rows without players occupy capacity
  // (blocked by course admin — indistinguishable from available in API, but 4/4 status-4
  // with no players consistently means blocked in practice)
  const blockedCount = {};
  if (course.closedIfNoRows) {
    for (const { start, status } of Object.values(rowById)) {
      if (status === 4) blockedCount[start] = (blockedCount[start] || 0) + 1;
    }
  }

  const dow = new Date(date).getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6;

  const slots = generateTeeTimes(date).map(time => {
    const players = bookingCount[time] || 0;
    const blocked = blockedCount[time] || 0;
    const booked = Math.min(players + blocked, MAX_PLAYERS);
    const hour = parseInt(time.slice(11, 13));
    const minute = parseInt(time.slice(14, 16));

    let memberOnly = false;
    if (course.memberOnlyMinutes) {
      memberOnly = course.memberOnlyMinutes.includes(minute);
    }
    if (!memberOnly && course.memberOnlyRules) {
      memberOnly = course.memberOnlyRules.some(rule => {
        if (rule.weekendOnly && !isWeekend) return false;
        if (rule.hours && (hour < rule.hours.from || hour > rule.hours.to)) return false;
        return rule.minutes.includes(minute);
      });
    }

    return { time, booked, free: MAX_PLAYERS - booked, memberOnly };
  });

  return { course, slots, closed: false, error: null };
}

async function fetchAllCourses(date) {
  return Promise.all(
    COURSES.map(course =>
      fetchCourseAvailability(course, date).catch(e => ({
        course,
        slots: [],
        error: e.message,
      }))
    )
  );
}

// --- HTML rendering ---

function shiftDate(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderCourseCard({ course, slots, closed, error }) {
  if (error) {
    return `
      <div class="card error-card">
        <div class="card-header">
          <span class="card-name">${escHtml(course.name)}</span>
          <span class="card-error">Virhe: ${escHtml(error)}</span>
        </div>
      </div>`;
  }

  if (closed) {
    return `
      <div class="card closed-card">
        <div class="card-header" style="cursor:default">
          <div class="card-title">
            <span class="card-name">${escHtml(course.name)}</span>
            <span class="card-club">${escHtml(course.club)}</span>
          </div>
          <span class="closed-label">Kalenteri ei auki</span>
        </div>
      </div>`;
  }



  const slotRows = slots.map(s => {
    const timeDisplay = s.time.slice(11, 16);
    let statusClass;
    if (s.free === 0) statusClass = 'full';
    else if (s.booked === 0) statusClass = 'free';
    else statusClass = 'partial';

    const dots = Array.from({ length: MAX_PLAYERS }, (_, i) =>
      `<span class="dot ${i < s.booked ? 'booked' : 'open'}"></span>`
    ).join('');

    const label = s.free === 0 ? 'Täynnä' : `${s.free} vapaana`;

    const hour = parseInt(s.time.slice(11, 13));
    const memberTag = s.memberOnly
      ? `<span class="member-tag">Osakkaille</span>`
      : '';
    return `<div class="slot ${statusClass}" data-free="${s.free}" data-hour="${hour}">
      <span class="slot-time">${timeDisplay}</span>
      <div class="dots">${dots}</div>
      ${memberTag}
      <span class="slot-label">${label}</span>
    </div>`;
  }).join('');

  return `
    <div class="card" id="card-${escHtml(course.id)}">
      <button class="card-header" onclick="toggleCard('${escHtml(course.id)}')">
        <div class="card-title">
          <span class="card-name">${escHtml(course.name)}</span>
          <span class="card-club">${escHtml(course.club)}</span>
        </div>
        <div class="card-badge-wrap">
          <span class="badge-count">–</span>
          <span class="badge-label">vapaata lähtöä</span>
        </div>
        <span class="chevron">▸</span>
      </button>
      <div class="card-body" id="body-${escHtml(course.id)}">
        <div class="slots-grid">${slotRows}</div>
      </div>
    </div>`;
}

function renderPage(date, results) {
  const cards = results.map(renderCourseCard).join('');
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, +1);
  const updatedAt = new Date().toLocaleTimeString('fi-FI');

  return `<!DOCTYPE html>
<html lang="fi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nyt Golfaamaan – ${date}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1a0f;
      color: #e8f5e8;
      min-height: 100vh;
    }

    /* ---- Top bar ---- */
    .topbar {
      position: sticky; top: 0; z-index: 100;
      background: #0a130a;
      border-bottom: 1px solid #1e3a1e;
      padding: 12px 16px;
      display: flex; flex-direction: column; gap: 10px;
      max-width: 640px; margin: 0 auto;
    }
    h1 { font-size: 1.2rem; font-weight: 700; color: #7dd87d; letter-spacing: -0.3px; }

    .date-row {
      display: flex; align-items: center; gap: 10px;
    }
    .date-nav { display: flex; align-items: center; gap: 6px; }
    .date-nav a {
      color: #7ab87a; text-decoration: none; font-size: 1.3rem;
      padding: 3px 8px; border-radius: 6px;
    }
    .date-nav a:hover { background: #1e2e1e; }
    .date-nav .cur { font-size: 0.95rem; font-weight: 600; min-width: 100px; text-align: center; }
    .jump-form { display: flex; gap: 6px; margin-left: auto; }
    .jump-form input[type="date"] {
      background: #1e2e1e; border: 1px solid #3a5a3a; color: #e8f5e8;
      border-radius: 6px; padding: 4px 8px; font-size: 0.8rem;
    }
    .jump-form button {
      background: #2d7a2d; color: #fff; border: none; border-radius: 6px;
      padding: 4px 10px; cursor: pointer; font-size: 0.8rem;
    }

    .filter-row {
      display: flex; align-items: center; gap: 8px;
    }
    .filter-label { font-size: 0.8rem; color: #7a9a7a; white-space: nowrap; }
    .filter-btns { display: flex; gap: 5px; }
    .filter-btn {
      background: #1e2e1e; border: 1px solid #3a5a3a; color: #9ab89a;
      border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 0.85rem;
      transition: all 0.15s;
    }
    .filter-btn.active {
      background: #2d7a2d; border-color: #4aaa4a; color: #fff; font-weight: 600;
    }
    .meta { font-size: 0.75rem; color: #4a6a4a; margin-left: auto; }

    /* ---- Cards ---- */
    .cards {
      max-width: 640px; margin: 0 auto;
      padding: 12px 12px 40px;
      display: flex; flex-direction: column; gap: 8px;
    }

    .card {
      background: #141f14;
      border: 1px solid #1e3a1e;
      border-radius: 12px;
      overflow: hidden;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: #2a5a2a; }
    .card.hidden { display: none; }

    .card-header {
      width: 100%; background: none; border: none; color: inherit;
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; cursor: pointer; text-align: left;
    }
    .card-header:hover { background: #1a2a1a; }

    .card-title { display: flex; flex-direction: column; flex: 1; }
    .card-name { font-weight: 600; font-size: 0.95rem; }
    .card-club { font-size: 0.75rem; color: #5a8a5a; margin-top: 1px; }

    .card-badge-wrap { display: flex; align-items: baseline; gap: 4px; }
    .badge-count {
      font-size: 1.1rem; font-weight: 700; color: #5dd65d;
      min-width: 28px; text-align: right;
    }
    .badge-count.zero { color: #4a6a4a; }
    .badge-label { font-size: 0.72rem; color: #4a7a4a; white-space: nowrap; }

    .chevron { color: #3a6a3a; font-size: 0.85rem; transition: transform 0.2s; }
    .card.open .chevron { transform: rotate(90deg); }

    .card-error { font-size: 0.8rem; color: #e05555; margin-left: 8px; }
    .error-card, .closed-card { opacity: 0.45; }
    .closed-label { font-size: 0.78rem; color: #4a6a4a; white-space: nowrap; }

    /* ---- Slots ---- */
    .card-body { display: none; border-top: 1px solid #1e3a1e; padding: 10px 12px; }
    .card.open .card-body { display: block; }

    .slots-grid {
      display: flex; flex-direction: column; gap: 4px;
      max-height: 420px; overflow-y: auto;
    }
    .slot {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 10px; border-radius: 8px;
      border-left: 3px solid transparent;
      transition: opacity 0.15s;
    }
    .slot.hidden-by-filter { display: none; }

    .slot.free    { background: #182818; border-color: #3dba3d; }
    .slot.partial { background: #22200e; border-color: #c9a227; }
    .slot.full    { background: #221515; border-color: #c23b3b; opacity: 0.45; }

    .slot-time { font-size: 0.9rem; font-weight: 600; width: 38px; flex-shrink: 0; }
    .slot.free    .slot-time { color: #5dd65d; }
    .slot.partial .slot-time { color: #e6bb44; }
    .slot.full    .slot-time { color: #e05555; }

    .dots { display: flex; gap: 4px; flex: 1; }
    .dot { width: 14px; height: 14px; border-radius: 50%; }
    .dot.booked { background: #c23b3b; }
    .dot.open   { background: #1e3a1e; border: 2px solid #3a7a3a; }

    .slot-label { font-size: 0.75rem; color: #7a9a7a; width: 64px; text-align: right; flex-shrink: 0; }
    .slot.full .slot-label { color: #7a5050; }
    .member-tag {
      font-size: 0.65rem; color: #7a6a3a; background: #2a2010;
      border: 1px solid #4a3a1a; border-radius: 4px;
      padding: 1px 5px; white-space: nowrap; flex-shrink: 0;
    }

    /* ---- No-results notice ---- */
    .no-slots { font-size: 0.82rem; color: #4a6a4a; padding: 8px 4px; text-align: center; }

    /* ---- Time slider ---- */
    .slider-row {
      display: flex; align-items: center; gap: 10px;
    }
    .slider-wrap {
      position: relative; flex: 1; height: 28px;
    }
    .slider-track {
      position: absolute; top: 50%; left: 0; right: 0;
      height: 4px; background: #1e3a1e; border-radius: 2px;
      transform: translateY(-50%);
    }
    .slider-fill {
      position: absolute; top: 0; height: 100%;
      background: #3dba3d; border-radius: 2px;
    }
    .slider-wrap input[type=range] {
      position: absolute; width: 100%; top: 50%; transform: translateY(-50%);
      -webkit-appearance: none; appearance: none;
      background: transparent; pointer-events: none; margin: 0;
    }
    .slider-wrap input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 18px; height: 18px; border-radius: 50%;
      background: #5dd65d; border: 2px solid #0f1a0f;
      pointer-events: all; cursor: pointer;
    }
    .slider-wrap input[type=range]::-moz-range-thumb {
      width: 18px; height: 18px; border-radius: 50%;
      background: #5dd65d; border: 2px solid #0f1a0f;
      pointer-events: all; cursor: pointer;
    }
    .slider-label {
      font-size: 0.82rem; font-weight: 600; color: #7dd87d;
      white-space: nowrap; min-width: 90px; text-align: right;
    }

    /* ---- Card sort transition ---- */
    .cards { transition: none; }
    .card { transition: border-color 0.15s; }
  </style>
</head>
<body>

<div class="topbar">
  <h1>⛳ Nyt Golfaamaan</h1>
  <div class="date-row">
    <div class="date-nav">
      <a href="/?date=${prev}">‹</a>
      <span class="cur">${date}</span>
      <a href="/?date=${next}">›</a>
    </div>
    <form class="jump-form" method="get" action="/">
      <input type="date" name="date" value="${date}">
      <button type="submit">Hae</button>
    </form>
  </div>
  <div class="filter-row">
    <span class="filter-label">Pelaajia:</span>
    <div class="filter-btns" id="player-btns">
      <button class="filter-btn active" data-min="1" onclick="setPlayerFilter(1)">1</button>
      <button class="filter-btn" data-min="2" onclick="setPlayerFilter(2)">2</button>
      <button class="filter-btn" data-min="3" onclick="setPlayerFilter(3)">3</button>
      <button class="filter-btn" data-min="4" onclick="setPlayerFilter(4)">4</button>
    </div>
    <span class="meta">Päivitetty ${updatedAt}</span>
  </div>
  <div class="slider-row">
    <span class="filter-label">Kellonaika:</span>
    <div class="slider-wrap" id="slider-wrap">
      <div class="slider-track"><div class="slider-fill" id="slider-fill"></div></div>
      <input type="range" id="range-start" min="7" max="20" value="7" step="1">
      <input type="range" id="range-end"   min="7" max="20" value="20" step="1">
    </div>
    <span class="slider-label" id="slider-label">07:00–19:00</span>
  </div>
</div>

<div class="cards">${cards}</div>

<script>
  let minPlayers = 1;
  let timeStart = 7, timeEnd = 20;

  // --- Player filter ---
  function setPlayerFilter(min) {
    minPlayers = min;
    document.querySelectorAll('#player-btns .filter-btn').forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.min === min);
    });
    applyFilters();
  }

  // --- Time slider ---
  const rangeStart = document.getElementById('range-start');
  const rangeEnd   = document.getElementById('range-end');
  const sliderFill = document.getElementById('slider-fill');
  const sliderLabel = document.getElementById('slider-label');

  function fmt(h) { return String(h).padStart(2,'0') + ':00'; }

  function updateSliderUI() {
    const min = +rangeStart.min, max = +rangeStart.max;
    const s = +rangeStart.value, e = +rangeEnd.value;
    const pct = v => ((v - min) / (max - min)) * 100;
    sliderFill.style.left  = pct(s) + '%';
    sliderFill.style.width = (pct(e) - pct(s)) + '%';
    sliderLabel.textContent = fmt(s) + '–' + fmt(e);
    // Keep start thumb on top when handles cross
    rangeStart.style.zIndex = s >= e - 1 ? 3 : 1;
  }

  rangeStart.addEventListener('input', () => {
    if (+rangeStart.value > +rangeEnd.value) rangeStart.value = rangeEnd.value;
    timeStart = +rangeStart.value;
    updateSliderUI();
    applyFilters();
  });
  rangeEnd.addEventListener('input', () => {
    if (+rangeEnd.value < +rangeStart.value) rangeEnd.value = rangeStart.value;
    timeEnd = +rangeEnd.value;
    updateSliderUI();
    applyFilters();
  });

  // --- Core filter + sort ---
  function applyFilters() {
    document.querySelectorAll('.slot').forEach(slot => {
      const free = +slot.dataset.free;
      const hour = +slot.dataset.hour;
      slot.classList.toggle('hidden-by-filter',
        free < minPlayers || hour < timeStart || hour >= timeEnd
      );
    });
    updateBadgesAndSort();
  }

  function updateBadgesAndSort() {
    const container = document.querySelector('.cards');
    const cards = [...container.querySelectorAll('.card:not(.error-card):not(.closed-card)')];

    cards.forEach(card => {
      const count = card.querySelectorAll('.slot:not(.hidden-by-filter):not(.full)').length;
      const badge = card.querySelector('.badge-count');
      const label = card.querySelector('.badge-label');
      if (badge) {
        badge.textContent = count;
        badge.classList.toggle('zero', count === 0);
      }
      if (label) label.textContent = count === 1 ? 'vapaa lähtö' : 'vapaata lähtöä';
      card._sortCount = count;
    });

    // Sort descending by free slot count, stable for equal values
    cards.sort((a, b) => b._sortCount - a._sortCount);

    // Re-append in sorted order (closed/error cards stay at bottom)
    const bottomCards = [...container.querySelectorAll('.card.error-card, .card.closed-card')];
    cards.forEach(c => container.appendChild(c));
    bottomCards.forEach(c => container.appendChild(c));
  }

  function toggleCard(id) {
    document.getElementById('card-' + id).classList.toggle('open');
  }

  // Init
  updateSliderUI();
  applyFilters();
</script>
</body>
</html>`;
}

// --- Routes ---

app.get('/', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;

  const results = await fetchAllCourses(date);
  res.send(renderPage(date, results));
});

app.listen(PORT, () => {
  console.log(`Nyt Golfaamaan running at http://localhost:${PORT}`);
});
