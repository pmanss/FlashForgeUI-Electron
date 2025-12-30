# IPC Communication Architecture

This document covers the inter-process communication system between main and renderer processes.

---

## IPC Handler Layout

- `src/main/ipc/handlers/index.ts` is the authoritative registry. Add new handlers there and ensure they are registered **before** any BrowserWindow is created.

- Domain handlers: `backend-handlers.ts`, `camera-handlers.ts`, `component-dialog-handlers.ts`, `connection-handlers.ts`, `control-handlers.ts`, `dialog-handlers.ts`, `job-handlers.ts`, `material-handlers.ts`, `printer-settings-handlers.ts`, `shortcut-config-handlers.ts`, `spoolman-handlers.ts`.

- Supporting modules: `camera-ipc-handler.ts` (legacy camera IPC surface), `printer-context-handlers.ts` (context CRUD + switching), `WindowControlHandlers.ts` (custom title bar), and `DialogHandlers.ts` (loading overlay + connection dialogs). Keep APIs in sync with the preload's whitelist.

- When adding IPC channels, update `src/preload/index.ts` channel allowlists plus any typed surface (`PrinterContextsAPI`, `SpoolmanAPI`, etc.). Dialog-specific handlers should route through `component-dialog-handlers.ts` unless they are part of the legacy `DialogHandlers` path.

---

## Security Model

### Context Bridge Pattern

```
Renderer Process (Sandboxed)
    ↓ window.api calls
Preload Script (Privileged)
    ↓ Channel validation
    ↓ contextBridge
ipcRenderer
    ↓ Whitelisted channels
ipcMain Handlers
    ↓ Business logic
Services/Managers
```

---

## Preload Scripts

### Main Renderer (`src/preload.cts`)

- ~150 send channels
- ~70 receive channels
- ~30 invoke channels
- Specialized namespaces: `config`, `dialog`, `loading`, `camera`, `printerContexts`, `spoolman`

### Component Dialog (`src/ui/component-dialog/component-dialog-preload.cts`)

- Mirrors main preload API
- Adds `componentDialogAPI` for lifecycle
- Same security guarantees

### Channel Validation

```typescript
const validSendChannels = ['request-printer-data', 'pause-print', ...];

send: (channel, data) => {
  if (validSendChannels.includes(channel)) {
    ipcRenderer.send(channel, data);
  }
}
```

---

## Handler Registration

### Central Registry (`src/ipc/handlers/index.ts`)

```typescript
export function registerAllIpcHandlers(managers: AppManagers) {
  registerConnectionHandlers();
  registerBackendHandlers();
  registerJobHandlers();
  registerDialogHandlers();
  registerMaterialHandlers();
  registerControlHandlers();
  registerWebUIHandlers();
  registerCameraHandlers();
  registerSpoolmanHandlers();
  // ... 13+ handler modules
}
```

### Registration Order in index.ts

```
1. Domain handlers (via registerAllIpcHandlers)
2. Multi-context handlers (printer contexts, connection state)
3. Legacy handlers (dialog handlers)
4. Window controls
5. THEN create windows
```

---

## Domain Handlers

### Connection Domain (`connection-handlers.ts`)

- `printer-selection:start-discovery`
- `printer-connection:connect-to-ip`
- `printer-selection:cancel`

### Backend Domain (`backend-handlers.ts`)

- `request-model-preview`
- `request-printer-data`
- `get-material-station-status`
- `printer:get-features`

### Control Domain (`control-handlers.ts`)

- Temperature: `set-bed-temp`, `set-extruder-temp`, `turn-off-*-temp`
- LED: `led-on`, `led-off`
- Print: `pause-print`, `resume-print`, `cancel-print`
- Operations: `home-axes`, `set-filtration`, `clear-status`

### Job Domain (`job-handlers.ts`)

- `job:get-local-files`, `job:get-recent-files`
- `job:start-job` (with material mapping for AD5X)
- `job:upload-file` (with progress)
- `job:request-thumbnail`

### Spoolman Domain (`spoolman-handlers.ts`)

- `spoolman:open-dialog`
- `spoolman:search-spools`
- `spoolman:select-spool`
- `spoolman:get-active-spool`
- `spoolman:test-connection`

---

## Communication Patterns

### 1. Request-Response (invoke/handle)

```typescript
// Renderer
const result = await window.api.invoke('printer-contexts:switch', contextId);

// Main
ipcMain.handle('printer-contexts:switch', async (_event, contextId) => {
  contextManager.switchContext(contextId);
});
```

### 2. One-Way Send (send/on)

```typescript
// Renderer
window.api.send('pause-print');

// Main
ipcMain.on('pause-print', async () => {
  await backendManager.pausePrint(contextId);
});
```

### 3. Event Broadcasting (receive)

```typescript
// Main
mainWindow.webContents.send('polling-update', data);

// Renderer
window.api.receive('polling-update', (data) => {
  updateUI(data);
});
```

---

## Renderer API Surface

```typescript
interface ElectronAPI {
  send/receive/removeListener/invoke
  config: ConfigAPI
  dialog: DialogNamespace
  loading: LoadingAPI
  camera: CameraAPI
  printerContexts: PrinterContextsAPI
  connectionState: ConnectionStateAPI
  printerSettings: PrinterSettingsAPI
  spoolman: SpoolmanAPI
}
```

---

## Key File Locations

**IPC & Windows**
- `src/main/ipc/handlers/index.ts` + domain handlers in `src/main/ipc/handlers/*.ts`, `camera-ipc-handler.ts`, `printer-context-handlers.ts`, `WindowControlHandlers.ts`, `DialogHandlers.ts`
- `src/main/windows/WindowManager.ts`, `src/main/windows/WindowFactory.ts`, `src/main/windows/factories/*`, `src/main/windows/dialogs/*`
