# go2rtc Camera Streaming Refactor Specification

**Document Version:** 1.0.0
**Created:** 2026-01-09
**Status:** Draft - Ready for Implementation
**Branch:** `claude/investigate-issue-1-90NFZ`

## Executive Summary

This specification details the complete replacement of the current camera streaming infrastructure (node-rtsp-stream + JSMpeg for RTSP, Express proxy for MJPEG) with go2rtc as a unified streaming gateway. This refactor will:

1. **Eliminate the rotation drift bug** by removing JSMpeg canvas rendering entirely
2. **Unify RTSP and MJPEG handling** under a single service
3. **Improve latency** from 1-3 seconds to ~500ms using WebRTC/MSE
4. **Add automatic reconnection** handling (currently missing for RTSP)
5. **Reduce resource usage** by using codec passthrough instead of transcoding
6. **Remove ffmpeg as a hard dependency** for basic RTSP viewing

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [go2rtc Overview](#2-go2rtc-overview)
3. [Target Architecture](#3-target-architecture)
4. [Component Mapping](#4-component-mapping)
5. [Implementation Plan](#5-implementation-plan)
6. [API Contracts](#6-api-contracts)
7. [Binary Bundling Strategy](#7-binary-bundling-strategy)
8. [Migration Path](#8-migration-path)
9. [Testing Strategy](#9-testing-strategy)
10. [Rollback Plan](#10-rollback-plan)

---

## 1. Current Architecture Analysis

### 1.1 Current MJPEG Flow (Built-in Printer Cameras)

```
┌─────────────────┐     HTTP GET      ┌──────────────────────────┐
│  Printer Camera │ ───────────────▶ │  CameraProxyService.ts   │
│   (MJPEG)       │                   │  - Express HTTP server   │
│  :8080/?action= │                   │  - Per-context ports     │
│    stream       │                   │    (8181-8191)           │
└─────────────────┘                   │  - Client distribution   │
                                      │  - Reconnection logic    │
                                      └───────────┬──────────────┘
                                                  │
                                      HTTP MJPEG passthrough
                                                  │
                    ┌─────────────────────────────┴─────────────────────────────┐
                    ▼                                                           ▼
         ┌──────────────────┐                                       ┌──────────────────┐
         │   Desktop UI     │                                       │     WebUI        │
         │  <img> element   │                                       │  <img> element   │
         │  http://localhost│                                       │  http://host     │
         │  :${port}/stream │                                       │  :${port}/stream │
         └──────────────────┘                                       └──────────────────┘
```

**Files Involved:**
- `src/services/CameraProxyService.ts` (760 lines)
- `src/utils/PortAllocator.ts`
- `src/ui/components/camera-preview/camera-preview.ts` (lines 307-329)
- `src/webui/static/features/camera.ts` (lines 113-133)

**Strengths:**
- Simple and reliable for MJPEG
- Per-context port allocation works well
- Reconnection with exponential backoff

**Weaknesses:**
- Separate service from RTSP handling
- No codec information available
- Limited monitoring capabilities

---

### 1.2 Current RTSP Flow (Custom Cameras)

```
┌─────────────────┐                   ┌──────────────────────────┐
│  RTSP Camera    │ ───────────────▶ │  RtspStreamService.ts    │
│  rtsp://...     │     RTSP          │  - node-rtsp-stream lib  │
└─────────────────┘                   │  - ffmpeg transcoding    │
                                      │    (RTSP → MPEG1)        │
                                      │  - Per-context WS ports  │
                                      │    (9000-9009)           │
                                      └───────────┬──────────────┘
                                                  │
                                      WebSocket (MPEG1 frames)
                                                  │
                    ┌─────────────────────────────┴─────────────────────────────┐
                    ▼                                                           ▼
         ┌──────────────────┐                                       ┌──────────────────┐
         │   Desktop UI     │                                       │     WebUI        │
         │  JSMpeg Player   │                                       │  JSMpeg Player   │
         │  <canvas>        │◀── THE ROTATION BUG HAPPENS HERE     │  <canvas>        │
         │                  │                                       │                  │
         └──────────────────┘                                       └──────────────────┘
```

**Files Involved:**
- `src/services/RtspStreamService.ts` (500 lines)
- `src/types/node-rtsp-stream.d.ts`
- `src/types/jsmpeg.d.ts`
- `src/ui/components/camera-preview/camera-preview.ts` (lines 334-370)
- `src/webui/static/features/camera.ts` (lines 75-106)

**Critical Issues:**
1. **Rotation Bug Root Cause**: JSMpeg renders to `<canvas>` using GPU compositor
   - Long-running streams accumulate GPU layer transform state
   - Canvas rotation drifts over time
   - Only restart fixes it
2. **Transcoding Overhead**: ffmpeg converts RTSP → MPEG1 (ancient codec)
3. **No Reconnection**: If RTSP stream drops, no automatic recovery
4. **ffmpeg Required**: Hard dependency for any RTSP viewing
5. **High Latency**: 1-3 second delay due to transcoding pipeline

---

### 1.3 IPC Handler Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     camera-ipc-handler.ts                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ IPC Channels:                                               │ │
│  │ - camera:get-proxy-port      → CameraProxyService          │ │
│  │ - camera:get-status          → CameraProxyService          │ │
│  │ - camera:set-enabled         → (no-op currently)           │ │
│  │ - camera:get-config          → resolveCameraConfig()       │ │
│  │ - camera:get-proxy-url       → CameraProxyService          │ │
│  │ - camera:get-rtsp-info       → RtspStreamService           │ │
│  │ - camera:get-rtsp-relay-info → RtspStreamService           │ │
│  │ - camera:restore-stream      → CameraProxyService          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Event Handlers:                                                 │
│  - handlePrinterConnected(contextId) → Setup camera stream      │
│  - handlePrinterDisconnected()       → Cleanup camera stream    │
│  - handleContextUpdate(contextId)    → Refresh camera config    │
└─────────────────────────────────────────────────────────────────┘
```

---

### 1.4 Camera Configuration Resolution

```
┌─────────────────────────────────────────────────────────────────┐
│                     camera-utils.ts                              │
│                                                                  │
│  resolveCameraConfig() Priority:                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 1. Custom Camera (if customCameraEnabled)                   │ │
│  │    - User-provided URL (RTSP or MJPEG detected by protocol) │ │
│  │    - Auto-generated: http://${ip}:8080/?action=stream       │ │
│  │                                                             │ │
│  │ 2. Built-in Camera (if printerFeatures.camera.builtin)      │ │
│  │    - http://${ip}:8080/?action=stream (always MJPEG)        │ │
│  │                                                             │ │
│  │ 3. None (camera unavailable)                                │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Returns: ResolvedCameraConfig {                                 │
│    sourceType: 'builtin' | 'custom' | 'none'                     │
│    streamType: 'mjpeg' | 'rtsp'                                  │
│    streamUrl: string | null                                      │
│    isAvailable: boolean                                          │
│    unavailableReason?: string                                    │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. go2rtc Overview

### 2.1 What is go2rtc?

go2rtc is an open-source, zero-dependency streaming server written in Go. It acts as a universal protocol gateway that can:

- **Accept any input**: RTSP, RTMP, HTTP (FLV/MJPEG/JPEG), HomeKit, USB cameras
- **Output to any format**: WebRTC, MSE/MP4, HLS, MJPEG, RTSP
- **No transcoding required**: Codec passthrough for H.264/H.265
- **Automatic reconnection**: Built-in connection recovery
- **REST API**: Full programmatic control via HTTP endpoints
- **WebSocket API**: Real-time stream negotiation

### 2.2 Why go2rtc Eliminates the Rotation Bug

| Current Stack | go2rtc Stack |
|---------------|--------------|
| RTSP → ffmpeg → MPEG1 → WebSocket → JSMpeg → **Canvas** | RTSP → go2rtc → WebRTC/MSE → **Native &lt;video&gt;** |
| Canvas uses GPU compositor layer | Browser-native hardware decoding |
| Long-running canvas accumulates state | Native video element is stateless |
| **ROTATION BUG** | **NO ROTATION BUG** |

### 2.3 go2rtc Binary Details (January 2026)

| Platform | Binary Name | Approximate Size |
|----------|-------------|------------------|
| Windows x64 | `go2rtc_win64.exe` | ~15 MB |
| Windows ARM64 | `go2rtc_win_arm64.exe` | ~14 MB |
| macOS Intel | `go2rtc_mac_amd64` | ~15 MB |
| macOS ARM (M1/M2/M3) | `go2rtc_mac_arm64` | ~14 MB |
| Linux x64 | `go2rtc_linux_amd64` | ~15 MB |
| Linux ARM64 | `go2rtc_linux_arm64` | ~14 MB |
| Linux ARMv7 | `go2rtc_linux_arm` | ~13 MB |

**Source:** [github.com/AlexxIT/go2rtc/releases](https://github.com/AlexxIT/go2rtc/releases)

### 2.4 go2rtc Configuration

```yaml
# Minimal configuration for FlashForgeUI
api:
  listen: ":1984"  # REST API + WebSocket

# Streams configured via REST API at runtime
streams: {}

# WebRTC configuration
webrtc:
  listen: ":8555/tcp"
  ice_servers:
    - urls: ["stun:stun.l.google.com:19302"]

# RTSP server (optional, for restreaming)
rtsp:
  listen: ":8554"

# Logging
log:
  format: "text"
  level: "info"
```

### 2.5 go2rtc REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/streams` | GET | List all configured streams |
| `/api/streams?src={name}` | PUT | Add/update a stream source |
| `/api/streams?src={name}` | DELETE | Remove a stream |
| `/api/ws?src={name}` | WebSocket | Stream negotiation endpoint |

**Adding a stream via API:**
```http
PUT /api/streams?src=printer1&name=printer1
Content-Type: application/json

{
  "sources": ["rtsp://admin:password@192.168.1.100/stream"]
}
```

**Response:**
```json
{
  "producers": [
    {
      "url": "rtsp://admin:password@192.168.1.100/stream",
      "medias": [
        {"kind": "video", "codecs": [{"name": "H264"}]},
        {"kind": "audio", "codecs": [{"name": "AAC"}]}
      ]
    }
  ]
}
```

### 2.6 go2rtc Browser Integration

go2rtc provides a custom HTML element `<video-rtc>` that handles all stream negotiation:

```html
<!-- Include the player script -->
<script src="/video-rtc.js"></script>

<!-- Use the custom element -->
<video-rtc
  src="/api/ws?src=printer1"
  mode="webrtc,mse,mjpeg"
  style="width: 100%; height: 100%;"
></video-rtc>
```

**Protocol Selection (in order of preference):**
1. **WebRTC** - Lowest latency (~500ms), requires UDP
2. **MSE** - Good latency (~1s), works over HTTP
3. **MJPEG** - Fallback, works everywhere

---

## 3. Target Architecture

### 3.1 Unified Camera Flow

```
┌─────────────────┐                   ┌──────────────────────────┐
│  MJPEG Camera   │ ───────────────▶ │                          │
│  (Built-in)     │     HTTP          │                          │
└─────────────────┘                   │                          │
                                      │   Go2rtcService.ts       │
┌─────────────────┐                   │                          │
│  RTSP Camera    │ ───────────────▶ │   - Manages go2rtc       │
│  (Custom)       │     RTSP          │     binary lifecycle     │
└─────────────────┘                   │   - REST API calls       │
                                      │   - Stream management    │
                                      │   - Port allocation      │
                                      │                          │
                                      └───────────┬──────────────┘
                                                  │
                                      ┌───────────┴───────────┐
                                      │   go2rtc binary       │
                                      │   (embedded)          │
                                      │                       │
                                      │   API: :1984          │
                                      │   WebRTC: :8555       │
                                      └───────────┬───────────┘
                                                  │
                              ┌───────────────────┴───────────────────┐
                              │              Output                    │
                              ├───────────────────────────────────────┤
                              │  WebRTC: ws://localhost:1984/api/ws   │
                              │  MSE:    ws://localhost:1984/api/ws   │
                              │  MJPEG:  http://localhost:1984/api/   │
                              │          frame.jpeg?src={name}        │
                              └───────────────────┬───────────────────┘
                                                  │
                    ┌─────────────────────────────┴─────────────────────────────┐
                    ▼                                                           ▼
         ┌──────────────────┐                                       ┌──────────────────┐
         │   Desktop UI     │                                       │     WebUI        │
         │  <video-rtc>     │◀── NATIVE VIDEO ELEMENT              │  <video-rtc>     │
         │  or <video>      │    NO CANVAS = NO ROTATION BUG       │  or <video>      │
         └──────────────────┘                                       └──────────────────┘
```

### 3.2 Stream Naming Convention

Each printer context maps to a go2rtc stream name:

```
Context ID: context-1-1736444800000
Stream Name: printer_context_1_1736444800000

Context ID: context-2-1736444900000
Stream Name: printer_context_2_1736444900000
```

---

## 4. Component Mapping

### 4.1 Files to Remove

| Current File | Reason for Removal |
|--------------|-------------------|
| `src/services/CameraProxyService.ts` | Replaced by Go2rtcService |
| `src/services/RtspStreamService.ts` | Replaced by Go2rtcService |
| `src/types/node-rtsp-stream.d.ts` | node-rtsp-stream removed |
| `src/types/jsmpeg.d.ts` | JSMpeg removed |

### 4.2 Files to Create

| New File | Purpose |
|----------|---------|
| `src/services/Go2rtcService.ts` | Main service managing go2rtc binary |
| `src/services/Go2rtcBinaryManager.ts` | Binary extraction, lifecycle |
| `src/types/go2rtc.types.ts` | Type definitions for go2rtc API |
| `src/webui/static/lib/video-rtc.js` | go2rtc browser player (vendored) |

### 4.3 Files to Modify

| File | Changes Required |
|------|------------------|
| `src/ipc/camera-ipc-handler.ts` | Replace service calls, update handlers |
| `src/ipc/handlers/camera-handlers.ts` | Update registration |
| `src/ui/components/camera-preview/camera-preview.ts` | Replace JSMpeg with video-rtc or native video |
| `src/webui/static/features/camera.ts` | Replace JSMpeg with video-rtc |
| `src/webui/server/routes/camera-routes.ts` | Update proxy-config response |
| `src/utils/camera-utils.ts` | Update stream type detection |
| `src/managers/HeadlessManager.ts` | Update camera initialization |
| `src/preload.ts` | Update camera API (may need new methods) |
| `package.json` | Remove node-rtsp-stream, @cycjimmy/jsmpeg-player |

### 4.4 Dependencies to Remove

```json
{
  "dependencies": {
    "@cycjimmy/jsmpeg-player": "^6.1.2",  // REMOVE
    "node-rtsp-stream": "^0.0.9"          // REMOVE
  }
}
```

### 4.5 Resources to Bundle

```
resources/
├── bin/
│   ├── darwin-arm64/
│   │   └── go2rtc
│   ├── darwin-x64/
│   │   └── go2rtc
│   ├── linux-arm64/
│   │   └── go2rtc
│   ├── linux-x64/
│   │   └── go2rtc
│   ├── win32-arm64/
│   │   └── go2rtc.exe
│   └── win32-x64/
│       └── go2rtc.exe
└── go2rtc/
    ├── video-rtc.js      # Browser player
    └── go2rtc.yaml       # Default config template
```

---

## 5. Implementation Plan

### Phase 1: Go2rtcService Foundation

**Goal:** Create the core service that manages go2rtc binary lifecycle and API communication.

#### 5.1.1 Go2rtcBinaryManager.ts

```typescript
/**
 * @fileoverview Manages go2rtc binary extraction, platform detection, and process lifecycle.
 */

export interface Go2rtcBinaryInfo {
  path: string;
  platform: NodeJS.Platform;
  arch: string;
}

export class Go2rtcBinaryManager {
  private process: ChildProcess | null = null;
  private readonly apiPort = 1984;
  private readonly webrtcPort = 8555;

  /**
   * Get path to bundled go2rtc binary for current platform
   */
  public getBinaryPath(): string;

  /**
   * Start go2rtc process
   */
  public async start(configPath: string): Promise<void>;

  /**
   * Stop go2rtc process gracefully
   */
  public async stop(): Promise<void>;

  /**
   * Check if go2rtc is running and healthy
   */
  public async isHealthy(): Promise<boolean>;

  /**
   * Get API base URL
   */
  public getApiUrl(): string;
}
```

#### 5.1.2 Go2rtcService.ts

```typescript
/**
 * @fileoverview Unified camera streaming service using go2rtc.
 * Replaces both CameraProxyService and RtspStreamService.
 */

export interface StreamConfig {
  contextId: string;
  streamName: string;
  sourceUrl: string;
  sourceType: 'mjpeg' | 'rtsp';
}

export interface StreamInfo {
  name: string;
  sources: string[];
  consumers: number;
  codecs: string[];
}

export class Go2rtcService extends EventEmitter {
  private readonly binaryManager: Go2rtcBinaryManager;
  private readonly streams = new Map<string, StreamConfig>();

  /**
   * Initialize go2rtc service
   */
  public async initialize(): Promise<void>;

  /**
   * Add a stream for a printer context
   */
  public async addStream(config: StreamConfig): Promise<void>;

  /**
   * Remove a stream for a printer context
   */
  public async removeStream(contextId: string): Promise<void>;

  /**
   * Get WebSocket URL for stream playback
   */
  public getStreamUrl(contextId: string): string;

  /**
   * Get stream info for a context
   */
  public getStreamInfo(contextId: string): Promise<StreamInfo | null>;

  /**
   * Shutdown service and stop go2rtc process
   */
  public async shutdown(): Promise<void>;
}
```

### Phase 2: IPC Handler Updates

**Goal:** Update camera-ipc-handler.ts to use Go2rtcService.

#### 5.2.1 Updated IPC Channels

| Channel | Current Implementation | New Implementation |
|---------|----------------------|-------------------|
| `camera:get-proxy-port` | CameraProxyService.getStatus().port | Go2rtcService.getApiPort() |
| `camera:get-status` | CameraProxyService.getStatus() | Go2rtcService.getServiceStatus() |
| `camera:get-config` | resolveCameraConfig() | resolveCameraConfig() (unchanged) |
| `camera:get-proxy-url` | formatCameraProxyUrl(port) | Go2rtcService.getStreamUrl(contextId) |
| `camera:get-rtsp-info` | RtspStreamService.getStreamStatus() | **REMOVE** (unified) |
| `camera:get-rtsp-relay-info` | RtspStreamService wsUrl | **REMOVE** (unified) |
| `camera:restore-stream` | CameraProxyService.removeContext/setStreamUrl | Go2rtcService.restartStream() |
| **NEW** `camera:get-stream-config` | N/A | Returns { wsUrl, streamType, mode } |

#### 5.2.2 New Camera Stream Config Response

```typescript
interface CameraStreamConfig {
  /** WebSocket URL for stream negotiation */
  wsUrl: string;

  /** Original source type */
  sourceType: 'builtin' | 'custom';

  /** Original stream type */
  streamType: 'mjpeg' | 'rtsp';

  /** Preferred playback modes (comma-separated) */
  mode: 'webrtc,mse,mjpeg';

  /** Whether go2rtc is running */
  isAvailable: boolean;
}
```

### Phase 3: UI Component Updates

**Goal:** Replace JSMpeg/canvas with video-rtc/native video.

#### 5.3.1 Desktop Camera Preview (camera-preview.ts)

**Current flow:**
```typescript
// RTSP
const rtspStreamInfo = await window.api.invoke('camera:get-rtsp-relay-info');
this.jsmpegPlayer = new JSMpeg.Player(rtspStreamInfo.wsUrl, { canvas: canvasElement });

// MJPEG
const proxyUrl = await window.api.camera.getProxyUrl();
imgElement.src = proxyUrl;
```

**New flow:**
```typescript
// Unified - works for both RTSP and MJPEG
const streamConfig = await window.api.camera.getStreamConfig();

// Option 1: Use video-rtc custom element
const videoRtc = document.createElement('video-rtc') as VideoRtcElement;
videoRtc.src = streamConfig.wsUrl;
videoRtc.mode = streamConfig.mode;
cameraView.appendChild(videoRtc);

// Option 2: Use native video with MSE (if preferred)
const video = document.createElement('video');
// ... MSE initialization via WebSocket
```

#### 5.3.2 WebUI Camera (camera.ts)

**Current flow:**
```typescript
if (config.streamType === 'rtsp') {
  jsmpegPlayer = new JSMpeg.Player(wsUrl, { canvas: cameraCanvas });
} else {
  cameraStream.src = config.url;
}
```

**New flow:**
```typescript
// Unified
const videoRtc = document.createElement('video-rtc');
videoRtc.src = config.wsUrl;
videoRtc.mode = config.mode;
cameraContainer.appendChild(videoRtc);
```

### Phase 4: WebUI Server Updates

**Goal:** Update camera routes to return go2rtc stream URLs.

#### 5.4.1 Updated camera-routes.ts

```typescript
router.get('/camera/proxy-config', async (req, res) => {
  const go2rtcService = getGo2rtcService();
  const streamUrl = go2rtcService.getStreamUrl(contextId);

  return res.json({
    success: true,
    wsUrl: streamUrl,
    sourceType: cameraConfig.sourceType,
    streamType: cameraConfig.streamType,
    mode: 'webrtc,mse,mjpeg'
  });
});
```

### Phase 5: Headless Mode Integration

**Goal:** Ensure go2rtc works correctly in headless mode.

```typescript
// HeadlessManager.ts
private async initializeCameraProxies(): Promise<void> {
  const go2rtcService = getGo2rtcService();

  // Ensure go2rtc is started
  if (!go2rtcService.isRunning()) {
    await go2rtcService.initialize();
  }

  for (const contextId of this.connectedContexts) {
    try {
      await cameraIPCHandler.handlePrinterConnected(contextId);
      this.logger.logInfo(`Camera stream initialized for context: ${contextId}`);
    } catch (error) {
      this.logger.logError(`Failed to initialize camera for context ${contextId}`, error as Error);
    }
  }
}
```

---

## 6. API Contracts

### 6.1 Go2rtcService Public API

```typescript
export interface IGo2rtcService {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  isRunning(): boolean;

  // Stream management
  addStream(contextId: string, sourceUrl: string, sourceType: CameraStreamType): Promise<void>;
  removeStream(contextId: string): Promise<void>;
  restartStream(contextId: string): Promise<void>;

  // URL generation
  getStreamWsUrl(contextId: string): string;
  getStreamMjpegUrl(contextId: string): string;
  getStreamRtspUrl(contextId: string): string;

  // Status
  getStreamInfo(contextId: string): Promise<StreamInfo | null>;
  getServiceStatus(): Go2rtcServiceStatus;
  getActiveStreams(): string[];

  // Events
  on(event: 'stream-started', handler: (contextId: string) => void): this;
  on(event: 'stream-stopped', handler: (contextId: string) => void): this;
  on(event: 'stream-error', handler: (contextId: string, error: Error) => void): this;
  on(event: 'service-ready', handler: () => void): this;
  on(event: 'service-stopped', handler: () => void): this;
}
```

### 6.2 Updated Preload Camera API

```typescript
interface CameraAPI {
  // Existing (keeping for compatibility)
  getProxyPort: () => Promise<number>;
  getStatus: () => Promise<unknown>;
  setEnabled: (enabled: boolean) => Promise<void>;
  getConfig: () => Promise<ResolvedCameraConfig | null>;
  restoreStream: () => Promise<boolean>;

  // Updated
  getStreamUrl: (contextId?: string) => Promise<string | null>;  // Now returns WS URL

  // New
  getStreamConfig: (contextId?: string) => Promise<CameraStreamConfig | null>;
}
```

### 6.3 WebUI API Response

```typescript
// GET /api/camera/proxy-config
interface CameraProxyConfigResponse {
  success: boolean;

  // Stream connection info
  wsUrl: string;           // WebSocket URL for video-rtc

  // Original stream info
  sourceType: 'builtin' | 'custom';
  streamType: 'mjpeg' | 'rtsp';

  // Playback configuration
  mode: string;            // e.g., 'webrtc,mse,mjpeg'

  // Alternative URLs (optional)
  mjpegUrl?: string;       // Direct MJPEG URL if needed
  rtspUrl?: string;        // RTSP URL for external players
}
```

---

## 7. Binary Bundling Strategy

### 7.1 Directory Structure

```
resources/
├── bin/
│   ├── darwin-arm64/
│   │   └── go2rtc                    # macOS Apple Silicon
│   ├── darwin-x64/
│   │   └── go2rtc                    # macOS Intel
│   ├── linux-arm64/
│   │   └── go2rtc                    # Linux ARM64 (Raspberry Pi 4)
│   ├── linux-x64/
│   │   └── go2rtc                    # Linux x64
│   ├── win32-arm64/
│   │   └── go2rtc.exe               # Windows ARM64
│   └── win32-x64/
│       └── go2rtc.exe               # Windows x64
└── go2rtc/
    ├── video-rtc.js                  # Browser player (vendored)
    ├── video-rtc.min.js              # Minified version
    └── go2rtc-template.yaml          # Config template
```

### 7.2 Electron Builder Configuration

Update `electron-builder.json`:

```json
{
  "asarUnpack": [
    "resources/bin/**/*"
  ],
  "extraResources": [
    {
      "from": "resources/bin/${platform}-${arch}",
      "to": "bin",
      "filter": ["**/*"]
    },
    {
      "from": "resources/go2rtc",
      "to": "go2rtc",
      "filter": ["**/*"]
    }
  ],
  "files": [
    "!resources/bin/**/*"
  ]
}
```

### 7.3 Binary Path Resolution

```typescript
// Go2rtcBinaryManager.ts
private getBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;

  const binaryName = platform === 'win32' ? 'go2rtc.exe' : 'go2rtc';

  // Development: resources/bin/{platform}-{arch}/go2rtc
  // Production: resources/bin/go2rtc

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', binaryName);
  } else {
    return path.join(
      app.getAppPath(),
      'resources',
      'bin',
      `${platform}-${arch}`,
      binaryName
    );
  }
}
```

### 7.4 Download Script

Create `scripts/download-go2rtc.js`:

```javascript
#!/usr/bin/env node
/**
 * Downloads go2rtc binaries for all supported platforms
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = '1.9.9';  // Update as needed
const BASE_URL = `https://github.com/AlexxIT/go2rtc/releases/download/v${VERSION}`;

const PLATFORMS = {
  'darwin-arm64': 'go2rtc_mac_arm64.zip',
  'darwin-x64': 'go2rtc_mac_amd64.zip',
  'linux-arm64': 'go2rtc_linux_arm64',
  'linux-x64': 'go2rtc_linux_amd64',
  'win32-arm64': 'go2rtc_win_arm64.zip',
  'win32-x64': 'go2rtc_win64.zip'
};

// ... download and extract logic
```

---

## 8. Migration Path

### 8.1 Feature Flag Approach

For safe rollout, implement a feature flag:

```typescript
// ConfigManager
interface AppConfig {
  // ... existing
  UseGo2rtcStreaming: boolean;  // Default: true for new installs
}
```

```typescript
// camera-ipc-handler.ts
private async handlePrinterConnected(contextId: string): Promise<void> {
  const useGo2rtc = this.configManager.get('UseGo2rtcStreaming');

  if (useGo2rtc) {
    await this.go2rtcService.addStream(contextId, config.streamUrl, config.streamType);
  } else {
    // Legacy path (temporary)
    if (config.streamType === 'rtsp') {
      await this.rtspStreamService.setupStream(contextId, config.streamUrl);
    } else {
      await this.cameraProxyService.setStreamUrl(contextId, config.streamUrl);
    }
  }
}
```

### 8.2 Migration Phases

| Phase | Description | Duration |
|-------|-------------|----------|
| 1 | Add Go2rtcService alongside existing services | 1-2 days |
| 2 | Implement feature flag, test go2rtc path | 1 day |
| 3 | Update UI components for unified video-rtc | 1-2 days |
| 4 | Enable go2rtc by default, legacy as fallback | Testing period |
| 5 | Remove legacy services after confirmation | Final cleanup |

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Component | Test Cases |
|-----------|-----------|
| Go2rtcBinaryManager | Platform detection, binary path resolution, process spawn/kill |
| Go2rtcService | Stream add/remove, URL generation, API calls |
| camera-utils | Updated stream type detection, go2rtc URL formatting |

### 9.2 Integration Tests

| Scenario | Expected Behavior |
|----------|------------------|
| Start with MJPEG camera | go2rtc starts, stream added, video plays |
| Start with RTSP camera | go2rtc starts, stream added, video plays via WebRTC/MSE |
| Context switch | Stream switched to new printer's camera |
| Printer disconnect | Stream removed from go2rtc |
| App close | go2rtc process terminated gracefully |
| Headless mode | go2rtc serves WebUI camera streams |
| Multi-printer | Multiple streams managed simultaneously |

### 9.3 Long-Running Tests (Critical for Rotation Bug)

| Test | Duration | Expected Result |
|------|----------|-----------------|
| RTSP stream continuous play | 24 hours | No rotation drift |
| RTSP stream continuous play | 48 hours | No rotation drift |
| MJPEG stream continuous play | 24 hours | No issues |
| Stream disconnect/reconnect cycle | 1000 cycles | Stable recovery |

### 9.4 Platform Testing Matrix

| Platform | MJPEG | RTSP via WebRTC | RTSP via MSE |
|----------|-------|-----------------|--------------|
| Windows x64 | ✓ | ✓ | ✓ |
| Windows ARM64 | ✓ | ✓ | ✓ |
| macOS Intel | ✓ | ✓ | ✓ |
| macOS ARM | ✓ | ✓ | ✓ |
| Linux x64 | ✓ | ✓ | ✓ |
| Linux ARM64 | ✓ | ✓ | ✓ |

---

## 10. Rollback Plan

### 10.1 If go2rtc Fails During Development

1. Feature flag `UseGo2rtcStreaming: false` reverts to legacy services
2. Legacy services remain in codebase until go2rtc proven stable
3. No code removal until Phase 5 confirmed successful

### 10.2 If go2rtc Fails in Production

1. User sets `UseGo2rtcStreaming: false` in settings
2. App restarts with legacy MJPEG proxy + RTSP/JSMpeg
3. Report bug with go2rtc logs for investigation

### 10.3 Emergency Hotfix Release

If go2rtc causes critical issues:
1. Revert to last known-good release
2. Disable go2rtc feature flag by default
3. Investigate root cause with user-provided logs

---

## Appendix A: go2rtc vs Current Stack Comparison

| Feature | Current (node-rtsp-stream + JSMpeg) | go2rtc |
|---------|-------------------------------------|--------|
| RTSP Support | ffmpeg required | Built-in |
| MJPEG Support | CameraProxyService | Built-in |
| Latency | 1-3 seconds | ~500ms (WebRTC) |
| Transcoding | Always (MPEG1) | Only when needed |
| Reconnection | Manual/None | Automatic |
| Browser Rendering | Canvas (JSMpeg) | Native &lt;video&gt; |
| **Rotation Bug** | **YES** | **NO** |
| CPU Usage | High (transcoding) | Low (passthrough) |
| Codebase Size | ~1300 lines | ~500 lines |
| Dependencies | node-rtsp-stream, jsmpeg-player | None (bundled binary) |
| Audio Support | No | Yes |

---

## Appendix B: Reference Links

- [go2rtc GitHub Repository](https://github.com/AlexxIT/go2rtc)
- [go2rtc Releases](https://github.com/AlexxIT/go2rtc/releases)
- [go2rtc API Documentation](https://github.com/AlexxIT/go2rtc/blob/master/api/README.md)
- [go2rtc Wiki](https://github.com/AlexxIT/go2rtc/wiki)
- [video-rtc.js Source](https://github.com/AlexxIT/go2rtc/blob/master/www/video-rtc.js)
- [Frigate go2rtc Configuration](https://docs.frigate.video/guides/configuring_go2rtc/)
- [FlashForgeUI GitHub Issue #1](https://github.com/Parallel-7/FlashForgeUI-Electron/issues/1)

---

## Appendix C: Estimated Impact

### Build Size Increase

| Platform | Current Size | go2rtc Binary | New Size | Increase |
|----------|--------------|---------------|----------|----------|
| Windows x64 | ~150 MB | +15 MB | ~165 MB | +10% |
| macOS | ~160 MB | +15 MB | ~175 MB | +9% |
| Linux | ~145 MB | +15 MB | ~160 MB | +10% |

### Runtime Memory

| Scenario | Current | With go2rtc | Change |
|----------|---------|-------------|--------|
| Idle (no camera) | ~200 MB | ~200 MB | Same |
| 1 MJPEG stream | ~250 MB | ~220 MB | -30 MB |
| 1 RTSP stream | ~350 MB | ~240 MB | -110 MB |
| 3 RTSP streams | ~550 MB | ~300 MB | -250 MB |

*Note: go2rtc uses less memory due to codec passthrough instead of transcoding.*

---

## Appendix D: Code Removal Checklist

After go2rtc is confirmed stable, remove:

- [ ] `src/services/CameraProxyService.ts`
- [ ] `src/services/RtspStreamService.ts`
- [ ] `src/types/node-rtsp-stream.d.ts`
- [ ] `src/types/jsmpeg.d.ts`
- [ ] `package.json`: `@cycjimmy/jsmpeg-player`
- [ ] `package.json`: `node-rtsp-stream`
- [ ] Legacy feature flag `UseGo2rtcStreaming`
- [ ] Legacy code paths in camera-ipc-handler.ts
- [ ] JSMpeg references in camera-preview.ts
- [ ] JSMpeg references in webui/static/features/camera.ts
- [ ] `src/utils/PortAllocator.ts` (if only used for camera)

---

*End of Specification*
