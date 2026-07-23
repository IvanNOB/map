# Frontend Module Architecture

The frontend uses vanilla JavaScript (no bundler). Large files are organized by
convention into logical sections marked with `// ─── Section Name ───` comments.

## Current Structure

### dispatcher.js (~2950 lines) — Admin Panel
Sections:
1. **State & Config** (1-30) — shared variables
2. **UI Helpers** (31-180) — icons, sounds, SOS, theme, DOM refs
3. **Auth** (234-272) — login/logout flow
4. **Lifecycle** (273-402) — auto-cleanup, refresh, tabs
5. **Zones/Branches/Restaurants/Places** (403-965) — CRUD panels
6. **Settings & Activity** (966-1066) — config, password, caja
7. **Chat & Walkie** (1067-1200) — messaging + push-to-talk
8. **Data Loading** (1202-1262) — API calls for orders/stats/drivers
9. **Orders UI** (1263-2090) — render, create, assign, cancel, search, filter
10. **Drivers UI** (2110-2366) — render, edit, delete, vibrate, history
11. **Map** (2367-2570) — Leaflet, markers, layers
12. **Socket.IO** (2571-2718) — real-time event handlers
13. **Reports & Charts** (2784-2935) — CSV/PDF export, Chart.js
14. **Init** (2936-2947) — bootstrap

### driver.js (~1690 lines) — Driver App
Sections:
1. **State & Auth** (1-300) — login, token, user
2. **Orders** (300-600) — load, render, status update
3. **Location/GPS** (600-900) — watchPosition, map
4. **Socket.IO** (900-1200) — events, competitive acceptance
5. **Competitive Orders** (1200-1400) — modal, accept logic
6. **Auto-Update** (1400-1690) — APK version check, banner

## Modular Files (new)

- `modules/dispatcher-shared.js` — Shared state, helpers, API wrapper
- `modules/dispatcher-map.js` — Map initialization and marker management
- `modules/dispatcher-socket.js` — Socket.IO event handlers
- `walkie-talkie.js` — Push-to-talk audio (already separate)
- `contacts-ui.js` — Contacts panel (already separate)
- `dispatcher-enhancements.js` — Charts and enhancements (already separate)
- `pwa.js` — Service Worker registration (already separate)

## Guidelines for New Features

1. Create a new file in `public/js/modules/` 
2. Attach functionality to `window.App` namespace
3. Load via `<script>` tag in the HTML (after the main file)
4. Access shared state through `window.App.state`

## Future: Migration to ES Modules

When ready to add a bundler (Vite/esbuild):
1. Convert IIFEs to ES module exports
2. Replace `window.App` with proper imports
3. Add `<script type="module" src="/js/main.js">`
