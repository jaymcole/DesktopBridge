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
                                        └── mDNS + POST /register + POST /observed ┘
```

## System architecture (associated repositories)

This bridge is the **middle tier** of a three-part system. The other two live in
**sibling repositories**, normally checked out next to this one:

| Component | Repo | Role |
| --- | --- | --- |
| **ac-bridge** (this) | `DesktopBridge/` | Discovers nodes, holds *desired* state, proxies UI commands to nodes, receives observed-state pushes, serves the UI. Owns the shared token. |
| **ACController** | `ACController/` (sibling) | React/Vite UI. Talks only to this bridge; never sees the token. `src/api/bridge.ts` is the client mirror of this API. |
| **Firmware** | `ArduinoScripts/scripts/ac_controller/` (sibling) | ESP32-S3 node on each AC. See that folder's `README.md` for endpoints/hardware. |

- **Control path:** UI `POST /devices/:id/config` → bridge validates → node `POST /config` (Bearer) → node transmits IR.
- **Observe path:** physical remote → node decodes → node `POST /observed` (Bearer) → bridge stores `reportedConfig` → UI poll shows it.
- **Node learns the bridge's address**, not vice-versa: every request the bridge makes to a node carries an `X-Bridge-Port` header, and the node combines it with the request's source IP. So nodes have no hardcoded bridge address.

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
| `STALE_AFTER_MS`   | `900000` (15 min)        | A unit not seen for this long is marked `stale`. Must exceed `POLL_INTERVAL_MS`. |
| `UI_ORIGIN`        | `http://localhost:5173`  | Allowed CORS origin for the React UI (`*` allows any).              |
| `DEVICE_TIMEOUT_MS`| `5000`                   | Timeout for any HTTP call the bridge makes to a unit.               |

## Discovery

The registry is populated from two sources, keyed by device `id`:

1. **mDNS** — browses `_acctrl._tcp`. TXT records `id`, `loc`, `fw` plus host/ip/port. Handles `up`/`down`.
2. **Self-registration** — units `POST /register` on boot and every ~5 min.

`lastSeen` updates on any contact (mDNS, register, or a successful poll). A unit
not seen for `OFFLINE_AFTER_MS`, or that fires an mDNS `down` event, is marked
`offline`. Units are never automatically hard-deleted just for going offline,
so known-but-offline units stay visible — but see "Duplicate entries" below for
the one case where an entry *is* removed automatically.

### Duplicate entries (renamed/reflashed units)

Renaming a unit (giving it a new `id`, e.g. to match its real-world location)
leaves its old id behind in the registry as a separate entry — same ip, same
everything, since it's the same physical unit. Left alone this looks like a
permanent duplicate, because the reconciliation loop polls every known entry's
`GET /health` by ip: the still-reachable unit answers for **both** the old and
new id's poll, refreshing `lastSeen` on the stale entry forever instead of
letting it age out to offline.

The bridge closes this automatically: a unit's `/health` response includes its
own id, and if it doesn't match the entry being polled, that entry is the
orphaned old id and is removed on the spot (`reconcile.js`). As a
belt-and-suspenders fallback (e.g. a stale entry that never answers a poll to
report the mismatch), each reconciliation tick also prunes any entries that
still share an ip, keeping whichever was seen most recently. Existing
duplicates clean themselves up within one `POLL_INTERVAL_MS` of upgrading.

For manual cleanup (or to force it immediately) use `POST /devices/dedupe` or
`DELETE /devices/:id` — see the API reference below.

## Reconciliation

Every `POLL_INTERVAL_MS` the bridge polls each unit's `GET /health` (and
`GET /config` to learn the unit's reported state). If a **running** unit reports a
`configId` **lower** than the bridge's stored desired-state `configId`, a
fire-and-forget push was lost — the bridge best-effort re-pushes the desired
config (IR has no ACK, so this is expected). These events are logged
(`reassert_start` / `reassert_ok` / `reassert_failed`).

The bridge deliberately does **not** re-assert on reboot (`applied:false`): the
firmware is intentionally inert on boot (a power blip must not turn the AC on),
and re-pushing there would override a state the user set via the physical remote
and resurrect a stale `desiredConfig`. After a reboot a unit is left as-is until
the next UI push or remote press.

## Schedules (automated control)

The bridge can run **schedules**: a named, ordered list of *steps*, where each
step is a full schema-v1 config transmitted to a chosen set of devices at a time
of day. Schedules are created/edited by the React UI and executed by the bridge.

- **Recurrence: daily.** A step's `time` is `"HH:MM"` (24h) only — no date, no
  day-of-week — and fires **every day** at that time. (Per-step day-of-week is a
  natural future extension; the model leaves room for it but it isn't implemented.)
- **Timezone: the bridge host's local time.** `07:00` means 07:00 wherever the
  bridge runs. **DST-safe:** the next fire is recomputed from the wall clock each
  day (local-time date math), not by adding a fixed 24h interval, so a step never
  drifts an hour across a spring-forward / fall-back.
- **Missed fires are skipped, not replayed.** If the bridge is down at a step's
  time, that occurrence is lost; on boot only *future* occurrences are armed.
- **Execution reuses the manual push path.** At fire time each device in the
  schedule takes the exact same internal route as `POST /devices/:id/config`
  (validate → proxy to unit → update desired state → persist). **Per-device
  failures are isolated:** an offline/unreachable device is logged and skipped;
  the others in the step still update. Last-write-wins, same as manual control.
- **Live re-arm.** Saving or deleting a schedule cancels and rebuilds its
  triggers immediately — no restart needed.
- **Persistence.** Schedules are stored in `data/schedules.json` (atomic write,
  same pattern as `data/state.json`) and reloaded + re-armed on startup. Each
  step's config is re-validated on load; an invalid one is skipped with a warning.
- **Validation.** Writes are validated with a closed shape (unknown keys
  rejected). Each `time` must match `^([01]\d|2[0-3]):[0-5]\d$`; each step config
  passes the same schema-v1 validator as a device push (so e.g. `mode:"fan"` is
  rejected). Referencing a currently-unknown device does **not** fail the save —
  devices can be offline now and rediscovered later; the schedule just skips them
  per fire and logs a warning.
- **Device removal prunes schedules.** When a device's registry entry is
  deleted for good — via `DELETE /devices/:id`, dedup (`POST /devices/dedupe`
  or the automatic same-ip prune), or a rename/reflash reconciled away — its id
  is removed from every schedule's `deviceIds`. This is different from the
  unknown/offline case above: an entry that's merely offline is left alone
  since it may come back; an entry that's gone from the registry never will,
  so schedules stop referencing it rather than failing on it forever.
- **Observability.** Each fire logs `schedule_fire` plus a per-device
  `schedule_device_ok` / `schedule_device_failed`. `GET /health` includes a
  `schedules` array with each schedule's `nextRunAt` and `lastRun`.

### Outdoor-unit conflicts

Multi-zone minisplits often wire several indoor heads to one shared outdoor
(condenser) unit, which can only run **heat** or **cool** at a time — whichever
head calls for a direction first "wins" it, and a sibling head asking for the
opposite direction is simply ignored by the hardware until the winner backs
off. That means a scheduled `cool` can silently do nothing if a sibling head
sharing the same outdoor unit is already running `heat`.

- **Grouping.** A device can be assigned to an `outdoorUnit` group (a free-text
  id) via `POST /devices/:id/outdoor-unit`. This isn't learned automatically —
  the bridge has no way to discover the physical wiring — so it must be set
  once per device. Devices with no `outdoorUnit` set are never checked for
  conflicts.
- **Resolution: schedules win.** When a scheduled step pushes `heat` (or
  `cool`/`dry`, which shares the compressor's cooling side) to a device, the
  bridge checks every other device in the same `outdoorUnit` group. If a
  sibling is currently running the opposite direction — judged from its
  `reportedConfig` if known, else its `desiredConfig` — the bridge turns that
  sibling off (`power: "off"`) immediately after the scheduled push, so the
  schedule's intent actually takes effect. `mode: "auto"` is never treated as
  either direction, since the unit picks it dynamically and the bridge can't
  know which way it went.
- **Scope.** Only devices *not* targeted by the same step are checked — a
  step is free to set several of its own devices at once without them being
  treated as conflicting with each other. This check only runs for scheduled
  fires, not manual `POST /devices/:id/config` pushes.
- **Observability.** A detected conflict logs `schedule_conflict_detected`,
  then `schedule_conflict_resolved` on success or
  `schedule_conflict_resolve_failed` on failure (best-effort — a failed
  turn-off is logged, not thrown, and never aborts the rest of the step). The
  turn-off itself is a normal `scheduled`-source command, so it appears in the
  [command log](#command-log) like any other push, tagged with `conflictWith`.

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

### `DELETE /devices/:id` — remove a device entry

Manually removes a device entry from the registry — e.g. a stale duplicate left
behind after a unit was renamed/reflashed with a new id. Idempotent — removing
an unknown id is not an error.

```json
{ "ok": true, "removed": true }
```

### `POST /devices/dedupe` — remove duplicate entries sharing an ip

A unit is stationary at one ip, so two entries sharing an ip are always the
same physical unit registered under more than one id, never two distinct
units. This scans the registry and removes all but the most-recently-seen
entry per shared ip. Usually unnecessary — see "Duplicate entries" below —
but useful to force an immediate cleanup.

```json
{ "ok": true, "removed": ["ac-old-id"] }
```

### `POST /devices/:id/config` — set desired config

Body is a schema-v1 config object. The bridge validates it (rejecting unknown
keys / out-of-range `temp` with `400`) **before** proxying to the unit's
`POST /config` with the token attached, then stores it as desired state.

An optional `?source=` query tags what initiated the command for the audit log
(`manual` — a Controllers-page control, the default; `manual_immediate` — a
schedule step's "send now"; `scheduled` — the scheduler). Unknown/absent values
default to `manual`. Scheduled fires use the same internal path with
`source=scheduled`. See [Command log](#command-log).

```json
{ "ok": true, "device": { /* updated Device */ } }
```

- Unit rejected the config → `502 device_error`, unit's own message in `error.details`.
- Unit didn't answer → `502 device_unreachable`.

### `POST /devices/:id/outdoor-unit` — assign/clear the shared outdoor-unit group

Body: `{ "outdoorUnit": "condenser-a" }` (non-empty string), or `{ "outdoorUnit": null }`
to clear it. Used by the scheduler to detect and resolve heat/cool conflicts
between indoor heads sharing one outdoor unit — see
[Outdoor-unit conflicts](#outdoor-unit-conflicts).

```json
{ "ok": true, "device": { /* updated Device */ } }
```

### `POST /devices/:id/identify` — blink the unit's LED

```json
{ "ok": true }
```

### `POST /devices/:id/resend` — re-transmit the unit's last config

```json
{ "ok": true, "configId": 8 }
```

### `GET /schedules` — all schedules

```json
{ "schedules": [ /* Schedule objects */ ], "count": 2 }
```

### `GET /schedules/:id` — one schedule

```json
{ "schedule": { /* Schedule */ } }
```

`404 schedule_not_found` for an unknown id.

### `PUT /schedules/:id` — upsert a schedule

Body is a `Schedule` (`{ id, name, deviceIds, steps }`); `:id` **must** equal
`body.id`. The bridge validates it, persists it, and (re)arms its triggers, then
returns the persisted schedule.

```json
{ "schedule": { /* persisted Schedule */ } }
```

- Bad time → `400 invalid_time`; bad step config → `400 invalid_config`; other
  shape problems (unknown key, id mismatch, wrong types) → `400 invalid_schedule`.
- `POST /schedules` is also accepted as an upsert alias (id comes from the body).

### `DELETE /schedules/:id` — delete a schedule

Deletes it and cancels its triggers. Idempotent — deleting an unknown id is not
an error.

```json
{ "ok": true }
```

### The `Schedule` object

```jsonc
{
  "id": "b1f2…",              // client-generated uuid; the resource id
  "name": "Weekday mornings",
  "deviceIds": ["ac-basement", "ac-office"],
  "steps": [
    {
      "id": "3c4d…",          // client-generated uuid
      "time": "07:00",        // 24h HH:MM, bridge host local time, fires daily
      "config": { "schema": 1, "power": "on", "mode": "heat", "temp": 22 }
    }
  ]
}
```

### `POST /register` — unit self-registration (**requires bearer token**)

Called by units, not the UI. Body: `{ id, location, ip, firmware, schema, configId }`.
An optional `port` is also accepted, letting a unit that only self-registers
(no mDNS) advertise a non-80 HTTP port; if omitted the bridge assumes port 80.

```json
{ "ok": true }
```

### `POST /observed` — unit-pushed observed state (**requires bearer token**)

Called by a unit the instant it decodes a command from the AC's **physical
remote**, so the UI reflects it within a round-trip instead of waiting for the
next poll. Body: `{ id, configId, config }`. The `config` is stored as
`reportedConfig` and is **not** run through the config validator (a remote can
set firmware-only values like `fan:"silent"` that a push would reject).

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
  "reportedConfig": { "schema": 1, "power": "on", "mode": "cool", "temp": 21, "fan": "auto", "vaneVert": "auto", "vaneHoriz": "auto" },
  "lastCommand": { "source": "scheduled", "at": "2026-07-24T18:30:12Z" },
  "outdoorUnit": "condenser-a"
}
```

- `status`: `online` (seen within `STALE_AFTER_MS`) | `stale` (not seen for longer, but known) | `offline` (mDNS `down` or never contacted).
- `lastCommand`: the most recent command initiated against this unit (`source` + ISO `at`), or `null`. Reflects the last *initiated* command, success or not. Full history is in the [command log](#command-log).
- `desiredConfig`: what the user wants (bridge intent, set by UI pushes). `reportedConfig`: the unit's actual last state (from polls **and** `/observed` remote captures).
- `inSync`: `unitConfigId === desiredConfigId && applied === true`. The UI shows a "drift" badge when false.
- `outdoorUnit`: the shared outdoor/condenser unit group this device belongs to, or `null` if unset. Set via [`POST /devices/:id/outdoor-unit`](#post-devicesidoutdoor-unit--assignclear-the-shared-outdoor-unit-group). See [Outdoor-unit conflicts](#outdoor-unit-conflicts).

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
| `unauthorized`       | 401  | Missing/invalid bearer token (on `/register`, `/observed`).   |
| `device_not_found`   | 404  | Unknown device id / unknown route.                            |
| `device_unreachable` | 502  | Proxied unit didn't answer (timeout / connection refused).    |
| `device_error`       | 502  | Unit answered but rejected the request; its message in `details`. |
| `internal_error`     | 500  | Unexpected bridge failure.                                    |

## Command log

Every command pushed to a unit is appended to `data/commands.jsonl` (JSON-lines,
append-only), for later review. Each record carries the initiation time, target
device, `source` (`manual` | `manual_immediate` | `scheduled`), the config sent,
whether the unit accepted it (`ok`), the assigned `configId` (on success) or
`error` (on failure), and — for scheduled fires — the `scheduleId`/`stepId`. The
per-device `lastCommand` (source + time) is surfaced in `GET /devices`; the full
log is **not** exposed via the API yet. Automatic reconcile re-asserts are not
logged (they aren't user/scheduler-initiated commands).

## Logging

Structured one-JSON-object-per-line logs to stdout/stderr: request logs
(`method`, `path`, `status`, `durationMs`), discovery events, registrations,
config pushes, and reconciliation/re-assertion events.
