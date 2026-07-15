# Hydramist KOTH CV worker

This package runs locally, reads the public `twitch.tv/hydramist` stream, and sends signed automation actions to the prediction server. Video inference stays on the local machine. The only uploaded image is the bounded evidence frame attached when automation pauses.

## Setup

```bash
cd cv-worker
UV_CACHE_DIR=.uv-cache uv sync
export PREDICTION_CV_SECRET='the-same-secret-used-by-the-server'
export KOTH_SERVER_URL='http://localhost:3002'
```

Use `https://koth.company` for the hosted server. Remote plain HTTP URLs are rejected.

## Calibrate the fixed broadcast layout

```bash
UV_CACHE_DIR=.uv-cache uv run koth-cv autocalibrate
UV_CACHE_DIR=.uv-cache uv run koth-cv calibrate
```

Autocalibration locates one broad overlay region. The worker finds `Leaderboard`, `Current player`, and `Queue` inside that region on every frame, so growing leaderboard rows cannot stale the player or queue coordinates. The local calibration page then opens at `127.0.0.1:8765`; draw and save the two match-state regions:

1. `start` around the `Shadowsight … spawns` arena-start text while it is visible.
2. `result` around the scoreboard title containing `Purple Team Wins` or `Gold Team Wins`.

The worker reads both transition phrases with OCR. The team-neutral result region gates settlement; the worker compares the overlay's current-player win counter with the server's pre-arena count, so either team color can represent a contestant win. Calibration data and captured frames live under `runtime/` and are ignored by Git.

## Run

Create a draft event in `/predictions/control`, enable CV automation, and start the worker:

```bash
UV_CACHE_DIR=.uv-cache uv run koth-cv doctor
UV_CACHE_DIR=.uv-cache uv run koth-cv run --dry-run
UV_CACHE_DIR=.uv-cache uv run koth-cv run
```

The default worker identity is `hostname:pid`, so overlapping local processes are visible as separate workers. After restarting a worker, wait until the previous heartbeat is stale, then explicitly claim its lease:

```bash
UV_CACHE_DIR=.uv-cache uv run koth-cv run --takeover
```

`--takeover` is sent only until the first heartbeat succeeds. The server rejects takeover while the previous worker's 15-second lease is still active, and the worker retries without exiting.

The worker fills the draft roster and reconciles removals only after ten matched reads of the
same queue page. A removed name must have been seen on that page, and every absence read must
still include a later known queue member. Empty reads, faction-page switches, and truncated OCR
therefore fail safe without deleting contestants. Accent differences such as `Kaptèn`/`Kapten`
share one identity while the first observed display label is retained. Review the roster and
activate the event from the control page. After activation, the roster is immutable: the worker
opens arenas, locks markets at the calibrated start signal, and records results after three
consecutive high-confidence result-and-counter reads.

Low-confidence or contradictory results pause automation. Inspect the evidence in the control page, correct state manually if needed, and explicitly resume.

## Run persistently against production on macOS

The production worker can run as a per-user LaunchAgent on the streaming Mac. Video and OCR remain local; the worker needs only outbound HTTPS access to `https://koth.company`. The bounded pause-evidence image remains the only uploaded frame.

The service reads `PREDICTION_CV_SECRET` and other worker settings from the repository root's `.env.local` at runtime. The generated plist contains no secrets and forces `KOTH_SERVER_URL=https://koth.company`, even if `.env.local` points local development at another URL. The same `PREDICTION_CV_SECRET` must be configured in the Vercel production environment.

Before installation, confirm `.env.local` is readable only by your user and that the production server, stream overlay, calibration, and event are ready:

```bash
chmod 600 ../.env.local
KOTH_SERVER_URL=https://koth.company UV_CACHE_DIR=.uv-cache uv run --frozen koth-cv doctor
```

Then manage the service from `cv-worker/`:

```bash
./scripts/service.sh install
./scripts/service.sh status
./scripts/service.sh logs
./scripts/service.sh logs --follow
./scripts/service.sh restart
./scripts/service.sh uninstall
```

Installation writes `~/Library/LaunchAgents/com.koth-company.cv-worker.plist` with mode `0600`. Launchd starts the worker at login, restarts it after failures with a 15-second throttle, and records output under `~/Library/Logs/koth-company/`. The worker also reconnects internally when Twitch, ffmpeg, OCR, or the production API is temporarily unavailable. It starts with `--takeover`, so a restarted process waits out and then claims a stale 15-second worker lease without bypassing an active worker.

With no enabled event, the service polls production every five seconds without opening Twitch or ffmpeg. Pausing, disabling, or losing the production connection closes the active decoder; a running session opens a fresh stream iterator.

A user LaunchAgent runs only while this account is logged in and the Mac is awake. Keep the Mac awake during KOTH broadcasts; no cloud vision process or inbound network tunnel is required.

## Record a replay fixture

Recording is opt-in and local:

```bash
UV_CACHE_DIR=.uv-cache uv run koth-cv record --minutes 10 --fps 2
```

Replay manifests keep server state and expected actions beside local frames, so an entire
draft-to-result lifecycle can run at CPU speed without contacting the prediction API:

```bash
UV_CACHE_DIR=.uv-cache uv run koth-cv replay runtime/recordings/koth/replay.json
```

Each JSON step contains `frame`, `state`, and an optional `repeat`. Add `expectedActions`
with one exact action or `null` per repetition to turn the replay into a machine-checkable
regression. Frame paths are relative to the manifest; OCR remains entirely local.

## Configuration

| Variable               | Default                                | Purpose                               |
| ---------------------- | -------------------------------------- | ------------------------------------- |
| `PREDICTION_CV_SECRET` | required                               | HMAC secret shared with the server    |
| `KOTH_SERVER_URL`      | `http://localhost:3002`                | Prediction server base URL            |
| `KOTH_TWITCH_CHANNEL`  | `hydramist`                            | Public Twitch channel name            |
| `KOTH_CV_LAYOUT`       | `runtime/layouts/hydramist-1080p.yaml` | Calibration file                      |
| `KOTH_CV_WORKER_ID`    | local hostname                         | Worker identity shown to the operator |

## Tests

```bash
UV_CACHE_DIR=.uv-cache uv run pytest
```
