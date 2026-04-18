# Tänään Tiille

Node.js/Express app showing available tee times for Finnish golf courses with kultakortti (gold card) access. Deployed on Railway, repo at github.com/heijari/nytgolfaamaan.

## Architecture

- `courses.js` — single source of truth for all course config
- `server.js` — data fetching, HTML rendering (server-side, no build step)
- All times are `Europe/Helsinki` — use `toLocaleString('sv', { timeZone: 'Europe/Helsinki' })` for local time

## Course config: infoTags

Tags shown on individual time slots. Supports:

```js
{ label: 'Caddiemasterilta', minutes: [30, 35] }         // matches minute of hour
{ label: 'Caddiemasterilta', minutes: [0], weekends: true } // weekends only
{ label: 'Palloränni', upto: { h: 9, m: 5 } }            // slots up to 09:05
{ label: 'Palloränni', from: { h: 17, m: 1 } }           // slots from 17:01
{ ..., suppressTags: ['Caddiemasterilta'] }               // removes other tags when this matches
```

`teeTimeOffset` shifts the minute loop start (e.g. 5 → slots at :05, :15, :25...).

## Rules page

`/saannot` renders all courses and their configured rules — check here before editing `courses.js`.
