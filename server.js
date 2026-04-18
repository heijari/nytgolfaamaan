const express = require('express');
const fetch = require('node-fetch');
const COURSES = require('./courses');

const app = express();
const PORT = process.env.PORT || 3000;

const START_HOUR = 7;
const END_HOUR = 18;
const MAX_PLAYERS = 4;

// --- Data fetching ---

function generateTeeTimes(date, offset = 0) {
  const times = [];
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    for (let m = offset; m < 60; m += 10) {
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

  const offset = course.teeTimeOffset || 0;
  const slots = generateTeeTimes(date, offset).map(time => {
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

    const matchedTags = [];
    if (course.infoTags) {
      const slotMins = hour * 60 + minute;
      for (const tag of course.infoTags) {
        if (tag.weekends && !isWeekend) continue;
        if (tag.minutes && tag.minutes.includes(minute)) { matchedTags.push(tag); continue; }
        if (tag.upto != null && slotMins <= tag.upto.h * 60 + tag.upto.m) { matchedTags.push(tag); continue; }
        if (tag.from != null && slotMins >= tag.from.h * 60 + tag.from.m) { matchedTags.push(tag); }
      }
    }
    const suppressed = new Set(matchedTags.flatMap(t => t.suppressTags || []));
    const tags = matchedTags.filter(t => !suppressed.has(t.label)).map(t => t.label);

    return { time, booked, free: MAX_PLAYERS - booked, memberOnly, tags };
  });

  const nowFiStr = new Date().toLocaleString('sv', { timeZone: 'Europe/Helsinki' }).slice(0, 16) + ':00';
  const visibleSlots = slots.filter(s => s.time >= nowFiStr);

  return { course, slots: visibleSlots, closed: false, error: null };
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
    const tagsHtml = [
      ...(s.memberOnly ? ['<span class="member-tag">Osakkaille</span>'] : []),
      ...(s.tags || []).map(t => `<span class="info-tag">${escHtml(t)}</span>`),
    ].join('');
    return `<div class="slot ${statusClass}" data-free="${s.free}" data-hour="${hour}">
      <span class="slot-time">${timeDisplay}</span>
      <div class="dots">${dots}</div>
      ${tagsHtml}
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

function renderPage(date, results, isToday, nowHour, courses) {
  const cards = results.map(renderCourseCard).join('');
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, +1);
  const updatedAt = new Date().toLocaleTimeString('fi-FI', { timeZone: 'Europe/Helsinki' });

  return `<!DOCTYPE html>
<html lang="fi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tänään Tiille – ${date}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f5f0;
      color: #1a2a1a;
      min-height: 100vh;
    }

    /* ---- Top bar ---- */
    .topbar {
      position: sticky; top: 0; z-index: 100;
      background: #fff;
      border-bottom: 1px solid #c8ddc8;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
      padding: 12px 16px;
      display: flex; flex-direction: column; gap: 10px;
      max-width: 640px; margin: 0 auto;
    }
    .topbar-title-row {
      display: flex; align-items: flex-start; justify-content: space-between;
    }
    .topbar-title { display: flex; flex-direction: column; gap: 1px; }
    h1 { font-size: 1.2rem; font-weight: 700; color: #1a7a1a; letter-spacing: -0.3px; }
    .subtitle { font-size: 0.75rem; color: #5a8a5a; font-weight: 400; }

    .info-btn {
      background: none; border: 1px solid #b0ccb0; color: #5a8a5a;
      border-radius: 50%; width: 26px; height: 26px; font-size: 0.8rem;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 2px;
      transition: background 0.15s, color 0.15s;
    }
    .info-btn:hover { background: #e8f4e8; color: #1a7a1a; }

    .date-row {
      display: flex; align-items: center; gap: 10px;
    }
    .date-nav { display: flex; align-items: center; gap: 6px; }
    .date-nav a {
      color: #2d8a2d; text-decoration: none; font-size: 1.3rem;
      padding: 3px 8px; border-radius: 6px;
    }
    .date-nav a:hover { background: #e8f4e8; }
    .date-nav .cur { font-size: 0.95rem; font-weight: 600; min-width: 100px; text-align: center; color: #1a2a1a; }
    .jump-form { display: flex; gap: 6px; margin-left: auto; }
    .jump-form input[type="date"] {
      background: #f4f8f4; border: 1px solid #b0ccb0; color: #1a2a1a;
      border-radius: 6px; padding: 4px 8px; font-size: 0.8rem;
    }
    .jump-form button {
      background: #2d8a2d; color: #fff; border: none; border-radius: 6px;
      padding: 4px 10px; cursor: pointer; font-size: 0.8rem;
    }
    .jump-form button:hover { background: #1a7a1a; }

    .filter-row {
      display: flex; align-items: center; gap: 8px;
    }
    .filter-label { font-size: 0.8rem; color: #6a8a6a; white-space: nowrap; }
    .filter-btns { display: flex; gap: 5px; }
    .filter-btn {
      background: #f4f8f4; border: 1px solid #b0ccb0; color: #4a7a4a;
      border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 0.85rem;
      transition: all 0.15s;
    }
    .filter-btn.active {
      background: #2d8a2d; border-color: #1a7a1a; color: #fff; font-weight: 600;
    }
    .meta { font-size: 0.75rem; color: #8aaa8a; margin-left: auto; }

    /* ---- Cards ---- */
    .cards {
      max-width: 640px; margin: 0 auto;
      padding: 12px 12px 16px;
      display: flex; flex-direction: column; gap: 8px;
    }

    .card {
      background: #fff;
      border: 1px solid #c8ddc8;
      border-radius: 12px;
      overflow: hidden;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .card:hover { border-color: #80bb80; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .card.hidden { display: none; }

    .card-header {
      width: 100%; background: none; border: none; color: inherit;
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; cursor: pointer; text-align: left;
    }
    .card-header:hover { background: #f4f8f4; }

    .card-title { display: flex; flex-direction: column; flex: 1; }
    .card-name { font-weight: 600; font-size: 0.95rem; color: #1a2a1a; }
    .card-club { font-size: 0.75rem; color: #7aaa7a; margin-top: 1px; }

    .card-badge-wrap { display: flex; align-items: baseline; gap: 4px; }
    .badge-count {
      font-size: 1.1rem; font-weight: 700; color: #2a8a2a;
      min-width: 28px; text-align: right;
    }
    .badge-count.zero { color: #aacaaa; }
    .badge-label { font-size: 0.72rem; color: #7aaa7a; white-space: nowrap; }

    .chevron { color: #90bb90; font-size: 0.85rem; transition: transform 0.2s; }
    .card.open .chevron { transform: rotate(90deg); }

    .card-error { font-size: 0.8rem; color: #c03030; margin-left: 8px; }
    .error-card, .closed-card { opacity: 0.5; }
    .closed-label { font-size: 0.78rem; color: #aacaaa; white-space: nowrap; }

    /* ---- Slots ---- */
    .card-body { display: none; border-top: 1px solid #dceadc; padding: 10px 12px; }
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

    .slot.free    { background: #edf7ed; border-color: #3dba3d; }
    .slot.partial { background: #fdf8ec; border-color: #c9a227; }
    .slot.full    { background: #fdf2f2; border-color: #e05555; opacity: 0.5; }

    .slot-time { font-size: 0.9rem; font-weight: 600; width: 38px; flex-shrink: 0; }
    .slot.free    .slot-time { color: #1a8a1a; }
    .slot.partial .slot-time { color: #8a6800; }
    .slot.full    .slot-time { color: #c03030; }

    .dots { display: flex; gap: 4px; flex: 1; }
    .dot { width: 14px; height: 14px; border-radius: 50%; }
    .dot.booked { background: #e05555; }
    .dot.open   { background: #d0ecd0; border: 2px solid #7acc7a; }

    .slot-label { font-size: 0.75rem; color: #6a9a6a; width: 64px; text-align: right; flex-shrink: 0; }
    .slot.full .slot-label { color: #b07070; }
    .member-tag {
      font-size: 0.65rem; color: #8a6a20; background: #fdf4e0;
      border: 1px solid #d4b870; border-radius: 4px;
      padding: 1px 5px; white-space: nowrap; flex-shrink: 0;
    }
    .info-tag {
      font-size: 0.65rem; color: #2a7a8a; background: #e6f4f7;
      border: 1px solid #90c4d0; border-radius: 4px;
      padding: 1px 5px; white-space: nowrap; flex-shrink: 0;
    }

    /* ---- No-results notice ---- */
    .no-slots { font-size: 0.82rem; color: #8aaa8a; padding: 8px 4px; text-align: center; }

    /* ---- Time slider ---- */
    .slider-row {
      display: flex; align-items: center; gap: 10px;
    }
    .slider-wrap {
      position: relative; flex: 1; height: 28px;
    }
    .slider-track {
      position: absolute; top: 50%; left: 0; right: 0;
      height: 4px; background: #d0e8d0; border-radius: 2px;
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
      background: #2d8a2d; border: 2px solid #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      pointer-events: all; cursor: pointer;
    }
    .slider-wrap input[type=range]::-moz-range-thumb {
      width: 18px; height: 18px; border-radius: 50%;
      background: #2d8a2d; border: 2px solid #fff;
      pointer-events: all; cursor: pointer;
    }
    .slider-label {
      font-size: 0.82rem; font-weight: 600; color: #2d8a2d;
      white-space: nowrap; min-width: 90px; text-align: right;
    }

    /* ---- Card sort transition ---- */
    .cards { transition: none; }
    .card { transition: border-color 0.15s, box-shadow 0.15s; }

    /* ---- View toggle ---- */
    .view-toggle { display: flex; gap: 5px; margin-left: auto; }
    .view-btn {
      background: #f4f8f4; border: 1px solid #b0ccb0; color: #4a7a4a;
      border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 0.85rem;
      transition: all 0.15s;
    }
    .view-btn.active { background: #2d8a2d; border-color: #1a7a1a; color: #fff; font-weight: 600; }

    /* ---- Map ---- */
    .map-container {
      display: none; max-width: 640px; margin: 0 auto;
      height: calc(100dvh - 180px); min-height: 300px;
    }
    .map-container.visible { display: block; }
    #map { width: 100%; height: 100%; }
    .map-marker {
      display: flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; border-radius: 50%;
      font-size: 0.85rem; font-weight: 700; color: #fff;
      border: 3px solid rgba(255,255,255,0.9);
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .map-marker.green  { background: #2d8a2d; }
    .map-marker.yellow { background: #b07800; }
    .map-marker.gray   { background: #999; }

    /* ---- Footer ---- */
    .footer {
      max-width: 640px; margin: 0 auto;
      padding: 12px 16px 32px;
      text-align: center;
      font-size: 0.75rem; color: #9aba9a;
    }

    /* ---- Info modal ---- */
    .modal-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,0.35); align-items: center; justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: #fff; border-radius: 14px;
      padding: 24px; max-width: 340px; width: calc(100% - 32px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    }
    .modal h2 { font-size: 1rem; color: #1a7a1a; margin-bottom: 12px; }
    .modal p { font-size: 0.84rem; color: #3a4a3a; line-height: 1.5; margin-bottom: 10px; }
    .modal ul { font-size: 0.82rem; color: #4a5a4a; line-height: 1.6; padding-left: 18px; margin-bottom: 16px; }
    .modal-close {
      background: #2d8a2d; color: #fff; border: none; border-radius: 8px;
      padding: 8px 20px; cursor: pointer; font-size: 0.85rem; width: 100%;
    }
    .modal-close:hover { background: #1a7a1a; }
  </style>
</head>
<body>

<div class="topbar">
  <div class="topbar-title-row">
    <div class="topbar-title">
      <h1>⛳ Tänään Tiille</h1>
      <span class="subtitle">Kultakorttikenttien vapaat lähdöt</span>
    </div>
    <button class="info-btn" onclick="document.getElementById('info-modal').classList.add('open')" title="Tietoa palvelusta">ℹ</button>
  </div>
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
    <div class="view-toggle">
      <button class="view-btn active" id="btn-list" onclick="setView('list')">Lista</button>
      <button class="view-btn" id="btn-map" onclick="setView('map')">Kartta</button>
    </div>
  </div>
  <div class="slider-row">
    <span class="filter-label">Kellonaika:</span>
    <div class="slider-wrap" id="slider-wrap">
      <div class="slider-track"><div class="slider-fill" id="slider-fill"></div></div>
      <input type="range" id="range-start" min="${isToday ? nowHour : 7}" max="20" value="${isToday ? nowHour : 7}" step="1">
      <input type="range" id="range-end"   min="${isToday ? nowHour : 7}" max="20" value="20" step="1">
    </div>
    <span class="slider-label" id="slider-label">07:00–19:00</span>
  </div>
</div>

<div class="cards">${cards}</div>
<div class="map-container" id="map-container"><div id="map"></div></div>

<footer class="footer">Palvelun tehnyt Niklas H</footer>

<div class="modal-overlay" id="info-modal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <h2>⛳ Tänään Tiille</h2>
    <p>Palvelu näyttää kultakorttikenttien vapaat lähtöajat reaaliajassa suoraan kenttien varausjärjestelmistä.</p>
    <p><strong>Rajoitukset:</strong></p>
    <ul>
      <li>Kentät on kovakoodattu – uusia kenttiä ei lisätä automaattisesti</li>
      <li>Vain kultakorttikenttinä merkityt kentät näkyvät</li>
      <li>Palloränni- ja Caddiemaster-merkinnät perustuvat kiinteisiin kellonaikarajoihin, ei reaaliaikaiseen tietoon</li>
      <li>Tiedot päivitetään joka sivulatauksella</li>
      <li>Näytetään vain kuluvan päivän tai valitun päivän tilanne</li>
    </ul>
    <div style="display:flex;gap:8px;margin-top:4px">
      <a href="/saannot" target="_blank" style="flex:1;text-align:center;padding:8px;border:1px solid #b0ccb0;border-radius:8px;font-size:0.85rem;color:#2d8a2d;text-decoration:none;">Kovakoodatut säännöt ›</a>
      <button class="modal-close" style="flex:1" onclick="document.getElementById('info-modal').classList.remove('open')">Sulje</button>
    </div>
  </div>
</div>

<script>
  const IS_TODAY = ${isToday};
  const NOW_HOUR = ${nowHour};

  let minPlayers = 1;
  let timeStart = IS_TODAY ? NOW_HOUR : 7, timeEnd = 20;

  const _saved = JSON.parse(localStorage.getItem('golfFilters') || 'null');
  if (_saved) {
    if (_saved.minPlayers) minPlayers = _saved.minPlayers;
    if (_saved.timeStart != null) timeStart = IS_TODAY ? Math.max(_saved.timeStart, NOW_HOUR) : _saved.timeStart;
    if (_saved.timeEnd   != null) timeEnd   = _saved.timeEnd;
  }

  function saveFilters() {
    localStorage.setItem('golfFilters', JSON.stringify({ minPlayers, timeStart, timeEnd }));
  }

  // --- Player filter ---
  function setPlayerFilter(min) {
    minPlayers = min;
    document.querySelectorAll('#player-btns .filter-btn').forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.min === min);
    });
    saveFilters();
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
    saveFilters();
    updateSliderUI();
    applyFilters();
  });
  rangeEnd.addEventListener('input', () => {
    if (+rangeEnd.value < +rangeStart.value) rangeEnd.value = rangeStart.value;
    timeEnd = +rangeEnd.value;
    saveFilters();
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

  // Init — restore saved filter state
  rangeStart.value = timeStart;
  rangeEnd.value   = timeEnd;
  document.querySelectorAll('#player-btns .filter-btn').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.min === minPlayers);
  });
  updateSliderUI();
  applyFilters();

  // --- Map view ---
  const COURSE_COORDS = ${JSON.stringify(courses.filter(c => c.lat).map(c => ({ id: c.id, name: c.name, lat: c.lat, lng: c.lng })))};

  let map = null;
  let mapMarkers = [];

  function setView(view) {
    const isList = view === 'list';
    document.getElementById('btn-list').classList.toggle('active', isList);
    document.getElementById('btn-map').classList.toggle('active', !isList);
    document.querySelector('.cards').style.display = isList ? '' : 'none';
    document.querySelector('.footer').style.display = isList ? '' : 'none';
    const mapEl = document.getElementById('map-container');
    mapEl.classList.toggle('visible', !isList);
    if (!isList) initMap();
  }

  function initMap() {
    if (map) { updateMapMarkers(); return; }
    map = L.map('map').setView([60.35, 24.9], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 18,
    }).addTo(map);

    COURSE_COORDS.forEach(c => {
      const marker = L.marker([c.lat, c.lng], { icon: makeIcon(c.id) });
      marker.addTo(map);
      marker.on('click', () => {
        const card = document.getElementById('card-' + c.id);
        const count = card ? +card.querySelector('.badge-count').textContent : '?';
        const label = card ? card.querySelector('.badge-label').textContent : '';
        marker.bindPopup(\`<strong>\${c.name}</strong><br>\${count} \${label}\`).openPopup();
      });
      mapMarkers.push({ id: c.id, marker });
    });

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const { latitude: lat, longitude: lng } = pos.coords;
        L.circleMarker([lat, lng], {
          radius: 8, fillColor: '#1a6aff', color: '#fff',
          weight: 2, fillOpacity: 0.9,
        }).addTo(map).bindPopup('Sijaintisi');
      });
    }
  }

  function makeIcon(id) {
    const card = document.getElementById('card-' + id);
    const count = card ? +card.querySelector('.badge-count').textContent : 0;
    const cls = count > 5 ? 'green' : count > 0 ? 'yellow' : 'gray';
    return L.divIcon({
      html: \`<div class="map-marker \${cls}">\${count}</div>\`,
      className: '', iconSize: [36, 36], iconAnchor: [18, 18],
    });
  }

  function updateMapMarkers() {
    mapMarkers.forEach(({ id, marker }) => marker.setIcon(makeIcon(id)));
  }

  const _origApply = applyFilters;
  applyFilters = function() { _origApply(); if (map) updateMapMarkers(); };
</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</body>
</html>`;
}

// --- Routes ---

app.get('/', async (req, res) => {
  const nowFi = new Date().toLocaleString('sv', { timeZone: 'Europe/Helsinki' });
  const today = nowFi.slice(0, 10);
  const nowHour = parseInt(nowFi.slice(11, 13));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;
  const isToday = date === today;

  const results = await fetchAllCourses(date);
  res.send(renderPage(date, results, isToday, nowHour, COURSES));
});

app.get('/saannot', (req, res) => {
  const rows = COURSES.map(c => {
    const rules = [];
    if (c.teeTimeOffset) rules.push(`Lähtöaikaoffset: ${c.teeTimeOffset} min`);
    if (c.memberOnlyMinutes) rules.push(`Osakkaille minuutit: ${c.memberOnlyMinutes.join(', ')}`);
    if (c.memberOnlyRules) c.memberOnlyRules.forEach(r =>
      rules.push(`Osakkaille (${r.weekendOnly ? 'vklp' : 'aina'}): min ${r.minutes.join(',')} h ${r.hours ? r.hours.from+'–'+r.hours.to : 'kaikki'}`)
    );
    if (c.infoTags) c.infoTags.forEach(t => {
      const when = [
        t.weekends ? 'vklp' : null,
        t.minutes ? `min ${t.minutes.join(',')}` : null,
        t.upto ? `→ ${t.upto.h}:${String(t.upto.m).padStart(2,'0')}` : null,
        t.from ? `${t.from.h}:${String(t.from.m).padStart(2,'0')} →` : null,
        t.suppressTags ? `(poistaa: ${t.suppressTags.join(', ')})` : null,
      ].filter(Boolean).join(' ');
      rules.push(`${t.label}: ${when}`);
    });
    return `<tr><td><strong>${c.name}</strong><br><small style="color:#888">${c.id} · ${c.domain}</small></td><td>${rules.map(r => `<div>${r}</div>`).join('') || '–'}</td></tr>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="fi"><head><meta charset="UTF-8"><title>Säännöt – Tänään Tiille</title>
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 16px;color:#1a2a1a;background:#f0f5f0}
h1{color:#1a7a1a;margin-bottom:20px}table{width:100%;border-collapse:collapse}
td{padding:10px 12px;vertical-align:top;border-bottom:1px solid #d0e8d0;font-size:0.88rem}
td:first-child{width:40%;color:#1a3a1a}td div{margin-bottom:2px}
a{color:#2d8a2d}</style></head><body>
<h1>⛳ Kovakoodatut säännöt</h1>
<p style="margin-bottom:16px;font-size:0.85rem;color:#5a8a5a">Muokkaa tiedostoa <code>courses.js</code></p>
<table>${rows}</table>
<p style="margin-top:24px"><a href="/">← Takaisin</a></p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Nyt Golfaamaan running at http://localhost:${PORT}`);
});
