# FlashForgeUI-Electron Architecture Overview

**Last Updated:** 2025-12-29

This document provides a high-level architectural overview of FlashForgeUI-Electron. For detailed information on specific systems, see the specialized reference documents listed at the end.

---

## System Overview

FlashForgeUI-Electron is a sophisticated desktop and headless controller for FlashForge 3D printers built on Electron. The application supports:

- **Multi-Printer Contexts**: Simultaneous connections to multiple printers
- **Dual Operating Modes**: Desktop GUI and headless server modes
- **Real-Time Monitoring**: 3-second polling intervals with instant context switching
- **Advanced Features**: Material station support (AD5X), Spoolman filament tracking, RTSP/MJPEG camera streaming
- **Remote Access**: Full-featured WebUI with WebSocket real-time updates
- **External Integrations**: Discord notifications, desktop notifications, Spoolman integration

---

## Core Architecture Principles

1. **Singleton Managers with Branded Types**: Single source of truth for application state
2. **Event-Driven Communication**: Loose coupling via EventEmitter pattern
3. **Multi-Context Isolation**: Per-printer service instances coordinated by singleton coordinators
4. **Unified GUI/Headless Stack**: Same services for both modes, minimal conditional branching
5. **Security First**: Context isolation, IPC channel whitelisting, no direct Node.js access in renderers
6. **Type Safety**: Strict TypeScript throughout with branded types and comprehensive validation

---

## Bootstrap and Entry Points

### Critical Bootstrap Sequence

**CRITICAL**: `src/main/bootstrap.ts` **MUST** be the first import inside `src/main/index.ts`.

**Purpose**: Set Electron app name before any singleton captures `app.getPath('userData')`.

```typescript
// src/main/bootstrap.ts
app.setName('FlashForgeUI');
app.setAppUserModelId('com.ghosttypes.flashforgeui');
```

**Problem Solved**: Without bootstrap, singletons like `ConfigManager` and `PrinterDetailsManager` lock in the default "Electron" app name, causing GUI/headless configuration desynchronization.

**Platform-Specific Paths**:
- **macOS**: `~/Library/Application Support/FlashForgeUI/`
- **Linux**: `~/.config/FlashForgeUI/`
- **Windows**: `%APPDATA%/FlashForgeUI/`

### Entry Points

- `src/main/bootstrap.ts` – **must** be the first import inside `src/main/index.ts`. It sets the Electron app name/AppUserModelID before singletons (ConfigManager, PrinterDetailsManager, etc.) read `app.getPath('userData')`, preventing headless/Desktop desync.

- `src/main/index.ts` – orchestrates the main process: enforces single-instance locks, parses CLI/headless flags, registers all IPC handlers (`src/main/ipc/handlers/index.ts` + legacy handlers), instantiates managers/services, and only creates windows after everything else is wired.

- `src/preload/index.ts` – exposes the typed `window.api` bridge with whitelisted channels plus scoped APIs (`loading`, `camera`, `printerContexts`, `printerSettings`, `spoolman`, etc.). Every renderer (main window + dialogs) depends on this contract, so keep backward compatibility and cleanup helpers (`removeListener`, `removeAllListeners`) intact.

- `src/renderer/src/renderer.ts` – initializes the component system, printer tabs, shortcut buttons, layout persistence, and logging hooks before delegating most logic to components/services in the main process.

---

## Manager Layer

### Core Managers

- **`ConfigManager`** – centralized config store wrapping `AppConfig` (`src/types/config.ts`)
- **`PrinterContextManager`** – issues context IDs, tracks active context, propagates lifecycle events
- **`ConnectionFlowManager`** – discovery flows (GUI + headless), manual IP, auto-connect, saved printer restore
- **`PrinterBackendManager`** – instantiates + maps printer backends (`src/printer-backends/*`) per context
- **`PrinterDetailsManager`** – persists `printer_details.json` + per-printer settings inside `app.getPath('userData')`
- **`HeadlessManager`** – orchestrates `--headless` boot, WebUI startup, polling, and graceful shutdown
- **`LoadingManager`** – modal loading overlays surfaced via IPC (main window + dialogs)
- **`WindowManager`** / **`WindowFactory`** – renderer/window lifecycle coordination (main window + dialogs)

---

## Service Layer

### Polling & Monitoring

- `PrinterPollingService`, `MainProcessPollingCoordinator` (single-printer), `MultiContextPollingCoordinator`
- `PrintStateMonitor`, `MultiContextPrintStateMonitor`
- `TemperatureMonitoringService`, `MultiContextTemperatureMonitor`

### Connection/Discovery

- `PrinterDiscoveryService`, `ConnectionEstablishmentService`, `ConnectionStateManager`
- `AutoConnectService`, `SavedPrinterService`, `DialogIntegrationService`

### Camera & Streaming

- `CameraProxyService`, `RtspStreamService`, `PortAllocator`
- `ThumbnailCacheService`, `ThumbnailRequestQueue`

### Notifications

- `PrinterNotificationCoordinator`, `MultiContextNotificationCoordinator`
- `services/notifications/*`, `services/discord/DiscordNotificationService.ts`

### Filament

- `SpoolmanService`, `SpoolmanIntegrationService`, `SpoolmanUsageTracker`
- `MultiContextSpoolmanTracker`, `SpoolmanHealthMonitor`

### Misc/System

- `PrinterDataTransformer`, `PrintStateMonitor`, `EnvironmentDetectionService`
- `AutoUpdateService`, `LogService`, `StaticFileManager`

---

## Printer Backend System

### Backend Hierarchy

```
BasePrinterBackend (abstract)
├── GenericLegacyBackend
│   └── Uses: FlashForgeClient only
│   └── Features: Basic legacy support
│
└── DualAPIBackend (abstract)
    ├── Adventurer5MBackend
    │   └── Uses: FiveMClient + FlashForgeClient
    │   └── Features: Auto-enabled LED (TCP)
    │
    ├── Adventurer5MProBackend
    │   └── Uses: FiveMClient + FlashForgeClient
    │   └── Features: Built-in RTSP, LED (HTTP), filtration
    │
    └── AD5XBackend
        └── Uses: FiveMClient + FlashForgeClient
        └── Features: 4-slot material station
```

### Backend Selection Logic

```typescript
Adventurer5MBackend     → model.startsWith('Adventurer 5M') && !includes('Pro')
Adventurer5MProBackend  → model.startsWith('Adventurer 5M Pro')
AD5XBackend            → model.startsWith('AD5X')
GenericLegacyBackend   → All others (fallback)
```

---

## Key Architectural Patterns

### Multi-Context Coordinator Pattern

```
MultiContextPollingCoordinator (singleton)
├── PrinterPollingService (context-1)
├── PrinterPollingService (context-2)
└── PrinterPollingService (context-3)
```

See [MULTI_CONTEXT.md](./MULTI_CONTEXT.md) for details.

### Event-Driven Communication

All major systems use EventEmitter for loose coupling:
- Managers emit lifecycle events
- Services listen and react
- No circular dependencies
- Clean separation of concerns

### IPC Security Model

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

See [IPC_COMMUNICATION.md](./IPC_COMMUNICATION.md) for details.

---

## File Organization

### Bootstrapping & Entry

- `src/main/bootstrap.ts` – sets app name/userData path before anything else loads
- `src/main/index.ts` – main-process orchestrator (imports bootstrap first, registers IPC, creates windows)
- `src/preload/index.ts` / `src/renderer/src/ui/component-dialog/component-dialog-preload.ts` – context bridges for main + dialog renderers

### Managers & Multi-Context Core

- `src/main/managers/PrinterContextManager.ts`, `PrinterBackendManager.ts`, `ConnectionFlowManager.ts`, `PrinterDetailsManager.ts`, `HeadlessManager.ts`, `LoadingManager.ts`
- `src/main/services/MultiContextPollingCoordinator.ts`, `MultiContextPrintStateMonitor.ts`, `MultiContextTemperatureMonitor.ts`, `MultiContextSpoolmanTracker.ts`, `MultiContextNotificationCoordinator.ts`
- `src/main/services/MainProcessPollingCoordinator.ts`, `PrinterPollingService.ts` for legacy single-printer paths

### Backends & Printers

- `src/main/printer-backends/*.ts` – Legacy, Adventurer5M, Adventurer5M Pro, AD5X implementations
- `src/main/printer-backends/ad5x/*` – material station transforms/types/utils

### Renderer & Components

- `src/renderer/src/renderer.ts`, `src/renderer/src/gridController.ts`, `src/renderer/src/shortcutButtons.ts`, `src/renderer/src/perPrinterStorage.ts`, `src/renderer/src/logging.ts`
- `src/renderer/src/ui/components/**` (ComponentManager, printer tabs, job info, etc.) + `src/renderer/src/ui/gridstack/**` for layout/palette logic
- `src/renderer/src/ui/component-dialog/**` – component dialog renderer + preload mirrors

### IPC & Windows

- `src/main/ipc/handlers/index.ts` + domain handlers in `src/main/ipc/handlers/*.ts`, `camera-ipc-handler.ts`, `printer-context-handlers.ts`, `WindowControlHandlers.ts`, `DialogHandlers.ts`
- `src/main/windows/WindowManager.ts`, `src/main/windows/WindowFactory.ts`, `src/main/windows/factories/*`, `src/main/windows/dialogs/*`

### Settings Dialog

- `src/renderer/src/ui/settings/settings-renderer.ts` – main orchestrator for dual settings management (global + per-printer)
- `src/renderer/src/ui/settings/sections/SettingsSection.ts` – base interface for modular sections
- `src/renderer/src/ui/settings/sections/*.ts` – individual setting sections (AutoUpdate, DesktopTheme, Discord, InputDependency, PrinterContext, RoundedUI, SpoolmanTest, Tab)
- `src/renderer/src/ui/settings/types.ts`, `src/renderer/src/ui/settings/types/external.ts` – shared type definitions

### Utilities & Types

- `src/main/utils/PortAllocator.ts` – per-context camera proxy ports (8181–8191 range)
- `src/main/utils/HeadlessArguments.ts`, `HeadlessDetection.ts`, `HeadlessLogger.ts`, `RoundedUICompatibility.ts`, `CSSVariables.ts`, `time|camera|error|extraction.utils.ts`, `EventEmitter.ts`
- `src/shared/types/` – contexts, polling, config, printers, spoolman, discord, camera, printer backend operations, IPC

---

## Reference Documentation

For detailed information on specific systems, see:

- **[MULTI_CONTEXT.md](./MULTI_CONTEXT.md)** - Multi-printer context system, coordinators, polling architecture
- **[IPC_COMMUNICATION.md](./IPC_COMMUNICATION.md)** - IPC handlers, security model, communication patterns
- **[UI_COMPONENTS.md](./UI_COMPONENTS.md)** - Renderer architecture, component system, settings dialog
- **[WEBUI_HEADLESS.md](./WEBUI_HEADLESS.md)** - Headless mode, WebUI server, static client
- **[INTEGRATIONS.md](./INTEGRATIONS.md)** - Camera streaming, Spoolman, notifications, Discord
- **[THEME_SYSTEM.md](./THEME_SYSTEM.md)** - CSS variables, theme computation, design patterns
- **[TOOLING.md](./TOOLING.md)** - Development tools, commands, testing constraints
