# ac-bridge

Always-on hub for a fleet of ESP32-S3 minisplit IR controllers. It discovers
units, remembers the config you *want* each unit to run ("desired state"),
proxies commands to units, best-effort re-asserts desired state after a unit
reboots, and serves everything to a separate React UI.

The shared bearer token stays **server-side only**. The React app talks solely
to this bridge and never sees the token.

```
React UI ──HTTP(JSON, no token)──▶  ac-bridge  ──HTTP(JSON + Bearer token)──▶  ESP32 units
                                        ▲                                         │
                                        └──────── mDNS + POST /register ──────────┘
```

## Requirements

- Node.js >= 18 (uses the built-in global `fetch`). Developed on Node 22.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env and set TOKEN
npm start                 # or: npm run dev  (auto-restart)
```

State is persisted to `data/state.json` and reloaded on restart, so a bridge
restart doesn't lose your intended configs. On startup, units are shown offline
until the reconciliation loop reaches them; the bridge does **not** push configs
on startup beyond the normal loop.

## Environment (`.env`)

| Var                | Default                  | Meaning                                                              |
| ------------------ | ------------------------ | ------------------------------------------------------------------- |
| `TOKEN`            | *(required)*             | Shared bearer token for all units + this bridge. Server-side only.  |
| `PORT`             | `8080`                   | Port the bridge listens on (UI + unit self-registration).           |
| `POLL_INTERVAL_MS` | `60000`                  | How often the reconciliation loop polls each unit's `GET /health`.  |
| `STALE_AFTER_MS`   | `900000` (15 min)        | A unit not seen for this long is marked `stale`.                    |
| `UI_ORIGIN`        | `http://localhost:5173`  | Allowed CORS origin for the React UI (`*` allows any).              |
| `DEVICE_TIMEOUT_MS`| `5000`                   | Timeout for any HTTP call the bridge makes to a unit.               |

## Discovery

The registry is populated from two sources, keyed by device `id`:

1. **mDNS** — browses `_acctrl._tcp`. TXT records `id`, `loc`, `fw` plus host/ip/port. Handles `up`/`down`.
2. **Self-registration** — units `POST /register` on boot and every ~5 min.

`lastSeen` updates on any contact (mDNS, register, or a successful poll). A unit
not seen for `STALE_AFTER_MS` becomes `stale`; an mDNS `down` event marks it
`offline`. Units are never hard-deleted, so known-but-offline units stay visible.

## Reconciliation

Every `POLL_INTERVAL_MS` the bridge polls each unit's `GET /health` (and
`GET /config` to learn the unit's reported state). If a unit reports
`applied:false` or a `configId` **lower** than the bridge's stored desired-state
`configId`, it rebooted or missed a command — the bridge re-pushes the stored
desired config. IR is fire-and-forget (no ACK), so this best-effort re-assertion
is expected. These events are logged (`reassert_start` / `reassert_ok` / `reassert_failed`).

## Bridge HTTP API (for the React UI)

All responses are JSON. Success bodies include `"ok": true` (where wrapped);
every non-2xx uses the uniform error shape below. CORS is enabled for `UI_ORIGIN`.

### `GET /health` — bridge liveness

```json
{
  "ok": true,
  "service": "ac-bridge",
  "version": "1.0.0",
  "uptimeSec": 3600,
  "deviceCount": 5,
  "onlineCount": 4,
  "startedAt": "2026-07-24T17:00:00Z"
}
```

### `GET /devices` — all devices

```json
{ "devices": [ /* Device objects */ ], "count": 5 }
```

### `GET /devices/:id` — one device

Returns a bare `Device` object (not wrapped). `404 device_not_found` for unknown ids.

### `POST /devices/:id/config` — set desired config

Body is a schema-v1 config object. The bridge validates it (rejecting unknown
keys / out-of-range `temp` with `400`) **before** proxying to the unit's
`POST /config` with the token attached, then stores it as desired state.

```json
{ "ok": true, "device": { /* updated Device */ } }
```

- Unit rejected the config → `502 device_error`, unit's own message in `error.details`.
- Unit didn't answer → `502 device_unreachable`.

### `POST /devices/:id/identify` — blink the unit's LED

```json
{ "ok": true }
```

### `POST /devices/:id/resend` — re-transmit the unit's last config

```json
{ "ok": true, "configId": 8 }
```

### `POST /register` — unit self-registration (**requires bearer token**)

Called by units, not the UI. Body: `{ id, location, ip, firmware, schema, configId }`.
An optional `port` is also accepted, letting a unit that only self-registers
(no mDNS) advertise a non-80 HTTP port; if omitted the bridge assumes port 80.

```json
{ "ok": true }
```

## The `Device` object

Every field always present; unknown values are `null`, never omitted. Timestamps
are ISO-8601 UTC; temperatures are °C.

```json
{
  "id": "ac-basement",
  "location": "basement",
  "firmware": "1.0.0",
  "schema": 1,
  "ip": "192.168.1.42",
  "port": 80,
  "status": "online",
  "lastSeen": "2026-07-24T18:30:12Z",
  "rssi": -58,
  "uptimeSec": 84213,
  "unitConfigId": 7,
  "desiredConfigId": 7,
  "inSync": true,
  "applied": true,
  "desiredConfig": { "schema": 1, "power": "on", "mode": "cool", "temp": 21, "fan": "auto", "vaneVert": "auto", "vaneHoriz": "auto" },
  "reportedConfig": { "schema": 1, "power": "on", "mode": "cool", "temp": 21, "fan": "auto", "vaneVert": "auto", "vaneHoriz": "auto" }
}
```

- `status`: `online` (seen within `STALE_AFTER_MS`) | `stale` (aged out) | `offline` (mDNS down / never contacted).
- `desiredConfig`: what the user wants (bridge intent). `reportedConfig`: what the unit says it last sent.
- `inSync`: `unitConfigId === desiredConfigId && applied === true`. The UI shows a "drift" badge when false.

## Config schema v1

```jsonc
{
  "schema": 1,
  "power": "on",          // "on" | "off"                              (required)
  "mode": "cool",         // "auto"|"cool"|"heat"|"dry"                (required when on)
  "temp": 21,             // 16–31 °C, integer                        (required when on)
  "fan": "auto",          // "auto" | "1".."4"                        (optional)
  "vaneVert": "auto",     // "auto" | "1".."5" | "swing"              (optional)
  "vaneHoriz": "auto"     // "left"|"mleft"|"middle"|"mright"|"right"|"wide"|"auto"  (optional)
}
```

## Uniform error shape

Every non-2xx bridge response:

```json
{ "ok": false, "error": { "code": "validation_error", "message": "temp out of range (16-31)", "details": null } }
```

| `code`               | HTTP | Meaning                                                        |
| -------------------- | ---- | ------------------------------------------------------------- |
| `validation_error`   | 400  | Bad input to the bridge (unknown key, out-of-range value).    |
| `unauthorized`       | 401  | Missing/invalid bearer token (on `/register`).                |
| `device_not_found`   | 404  | Unknown device id / unknown route.                            |
| `device_unreachable` | 502  | Proxied unit didn't answer (timeout / connection refused).    |
| `device_error`       | 502  | Unit answered but rejected the request; its message in `details`. |
| `internal_error`     | 500  | Unexpected bridge failure.                                    |

## Logging

Structured one-JSON-object-per-line logs to stdout/stderr: request logs
(`method`, `path`, `status`, `durationMs`), discovery events, registrations,
config pushes, and reconciliation/re-assertion events.
