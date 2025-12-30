# External Integrations

This document covers camera streaming, Spoolman filament tracking, and notification systems.

---

## Camera & Streaming Stack

- `CameraProxyService` (MJPEG) spins up an Express proxy per context on ports 8181–8191 (managed by `PortAllocator`). Keep-alive timers were moved to the shared `CameraPriority` spec—do not recycle ports manually or short-circuit the allocator.

- `RtspStreamService` enables RTSP cameras by wrapping `node-rtsp-stream` + ffmpeg, exposing WebSocket ports starting at 9000 (per context). It auto-detects ffmpeg in common OS paths; missing ffmpeg should produce warnings but never crash the app.

- Renderer-side components (`src/renderer/src/ui/components/camera-preview`) and the WebUI both expect the proxy URLs emitted by these services. Maintain parity across GUI/headless flows (see `ai_specs/CAMERA_PRIORITY_SPEC.md` for rationale).

### CameraProxyService (`src/services/CameraProxyService.ts`)

- Multi-context MJPEG proxies
- Unique ports (8181-8191 via PortAllocator)
- Keep-alive with 5s idle timeout
- Automatic reconnection (exponential backoff)
- Per-context Express servers

### RtspStreamService (`src/services/RtspStreamService.ts`)

- RTSP-to-WebSocket via ffmpeg
- node-rtsp-stream library
- Cross-platform ffmpeg detection
- Unique WebSocket ports (9000+)
- JSMpeg player support
- Max 10 concurrent streams

---

## Spoolman Integration & Filament Tracking

- Configuration toggles live in `AppConfig`: `SpoolmanEnabled`, `SpoolmanServerUrl`, `SpoolmanUpdateMode`. IPC handlers in `src/main/ipc/handlers/spoolman-handlers.ts` expose config/get/set/selection APIs to both renderer and WebUI.

- `SpoolmanIntegrationService` is the source of truth for active spool assignments. It persists selections per printer in `printer_details.json`, enforces AD5X/material-station blocking (feature detection + model prefix), validates configuration, and emits events for desktop/WebUI consumers. Do **not** bypass it.

- `SpoolmanService` wraps the REST API with 10 s timeouts, usage updates (weight or length), search, and connectivity checks. `SpoolmanUsageTracker` + `MultiContextSpoolmanTracker` listen for print completion/cooling to submit usage updates, while `SpoolmanHealthMonitor` pings the server and resets cache/UI state when connectivity flips.

- WebUI routing lives in `src/main/webui/server/routes/spoolman-routes.ts`; the static client feature is `src/main/webui/static/features/spoolman.ts`. Keep API responses consistent between desktop and WebUI flows.

- Renderer dialogs: `src/renderer/src/ui/spoolman-dialog`, `src/renderer/src/ui/spoolman-offline-dialog`, and spool badges/components embedded in both the main gridstack dashboard and component dialogs. Maintain `spoolman-changed` events so everything rehydrates correctly.

### SpoolmanService (`src/services/SpoolmanService.ts`)

- REST API client (10s timeout)
- Operations: ping, getSpool, searchSpools, useFilament

### SpoolmanIntegrationService (`src/services/SpoolmanIntegrationService.ts`)

- Single source of truth for active spool selections
- Per-printer persistence in printer_details.json
- AD5X/material-station blocking
- Event broadcasting: 'spoolman-changed'

### SpoolmanUsageTracker / MultiContextSpoolmanTracker

- Listen to 'cooling-complete' events
- Calculate usage from job metadata
- Submit to Spoolman API
- Per-context tracker instances

---

## Notifications & External Integrations

- Desktop notifications flow through `services/notifications/NotificationService` + `PrinterNotificationCoordinator`.

- `MultiContextNotificationCoordinator` ensures every context gets its own coordinator regardless of which tab is active.

- Discord integration (`src/services/discord/DiscordNotificationService.ts`) mirrors printer events to webhook embeds with rate limiting and per-context timers. Config keys: `DiscordSync`, `WebhookUrl`, `DiscordUpdateIntervalMinutes`.

- Web push notifications are specced in `ai_specs/webui-push-notifications.md`. Implementations should add `WebPushService`, subscription managers, and WebUI UI/worker updates without regressing desktop/Discord flows.

### NotificationService (`src/services/notifications/NotificationService.ts`)

- Desktop notification wrapper
- Platform compatibility detection
- Lifecycle events (sent, clicked, closed)
- 24-hour retention
- Silent notification support

### MultiContextNotificationCoordinator

- Per-printer notification coordinators
- Shared NotificationService
- Independent state per context
- Notification types: completion, cooling, errors, material station

### DiscordNotificationService (`src/services/discord/DiscordNotificationService.ts`)

- Webhook integration
- Timer-based updates (configurable interval, default 5min)
- Event-driven: Print complete, printer cooled, idle transition
- Per-context tracking with state caching
- Rich embeds with temperatures, progress, material usage
- Rate limiting (1s delay between messages)

---

## Persistence & Saved Printers

- `PrinterDetailsManager` manages JSON persistence for printers, last-used serials, per-printer settings (camera, LEDs, spoolman, custom features) and stores runtime context-to-printer mappings.

- `SavedPrinterService` exposes helpers to match discovered printers, track IP changes, and update `lastConnected`. It is the single source for UI lists and headless boot data.

- `AutoConnectService` and `ConnectionFlowManager` rely on these stores to auto-launch saved printers or rehydrate contexts after restarts.

---

## Key File Locations

**Camera, Notifications & Ports**
- `src/main/services/CameraProxyService.ts`, `RtspStreamService.ts`, `src/main/utils/PortAllocator.ts`
- `src/main/services/notifications/*`, `src/main/services/discord/DiscordNotificationService.ts`

**Spoolman & Filament**
- `src/main/services/SpoolmanIntegrationService.ts`, `SpoolmanService.ts`, `SpoolmanUsageTracker.ts`, `SpoolmanHealthMonitor.ts`
- `src/main/ipc/handlers/spoolman-handlers.ts`, `src/renderer/src/ui/spoolman-dialog/*`, `src/renderer/src/ui/spoolman-offline-dialog/*`
- `src/main/webui/server/routes/spoolman-routes.ts`, `src/main/webui/static/features/spoolman.ts`
