from __future__ import annotations

import json
import logging
import os
import socket
import time
import uuid
import webbrowser
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Protocol

import cv2
import numpy as np
import typer
import uvicorn

from .calibration import autocalibrate_regions, create_calibration_app
from .client import AutomationClient, AutomationStateFeed, AutomationStreamUpdate
from .config import Layout, load_layout, missing_template_files, save_layout
from .journal import ActionJournal
from .replay import ReplayMismatchError, replay_manifest
from .runner import PendingActionConflictError, RetryableWorkerError, Worker, automation_ready
from .stream import TwitchSource
from .vision import RapidOcrReader, VisionDetector


app = typer.Typer(no_args_is_help=True)
RUNTIME = Path(__file__).parents[2] / "runtime"
RUNNABLE_EVENT_STATUSES = {"draft", "live"}
TRANSIENT_LOG_INTERVAL = 30.0
HEARTBEAT_INTERVAL = 5.0
logger = logging.getLogger(__name__)


class StateFeed(Protocol):
    def start(self) -> None: ...

    def next(self, timeout: float | None) -> AutomationStreamUpdate | None: ...

    def close(self) -> None: ...


def layout_path() -> Path:
    return Path(os.environ.get("KOTH_CV_LAYOUT", RUNTIME / "layouts" / "hydramist-1080p.yaml"))


def channel_name() -> str:
    return os.environ.get("KOTH_TWITCH_CHANNEL", "hydramist")


def default_worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def automation_client() -> AutomationClient:
    secret = os.environ.get("PREDICTION_CV_SECRET")
    if not secret:
        raise typer.BadParameter("PREDICTION_CV_SECRET is required")
    return AutomationClient(os.environ.get("KOTH_SERVER_URL", "http://localhost:3002"), secret)


def complete_layout() -> tuple[Path, Layout]:
    path = layout_path()
    if not path.exists():
        raise typer.BadParameter(f"Missing calibration: {path}")
    layout = load_layout(path)
    if missing := [*layout.missing(), *missing_template_files(layout, path.parent)]:
        raise typer.BadParameter(f"Incomplete calibration: {', '.join(missing)}")
    return path, layout


def _log_transient_failure(
    last_logged: dict[str, float],
    *,
    operation: str,
    error: Exception,
    now: float,
    worker_id: str,
) -> None:
    previous = last_logged.get(operation)
    if previous is not None and now - previous < TRANSIENT_LOG_INTERVAL:
        return
    last_logged[operation] = now
    logger.warning(
        "Worker %s failed to %s: %s; retrying",
        worker_id,
        operation,
        error,
    )


def _run_worker_frames(
    source: TwitchSource,
    *,
    client: AutomationClient,
    worker: Worker,
    worker_id: str,
    dry_run: bool,
    fps: float,
    takeover: bool,
    monotonic: Callable[[], float] = time.monotonic,
    state_feed: StateFeed | None = None,
    max_iterations: int | None = None,
) -> None:
    next_frame_at = 0.0
    next_heartbeat_at = 0.0
    takeover_pending = takeover
    last_error_logs: dict[str, float] = {}
    interval = 1 / fps
    frame_iterator: Iterator[np.ndarray] | None = None
    iterations = 0
    state: dict[str, object] | None = None
    revision: str | None = None
    awaiting_revision: str | None = None
    feed = state_feed or AutomationStateFeed(client)

    def stop_capture() -> None:
        nonlocal frame_iterator
        if frame_iterator is None:
            return
        close = getattr(frame_iterator, "close", None)
        if callable(close):
            close()
        frame_iterator = None

    feed.start()
    try:
        while max_iterations is None or iterations < max_iterations:
            iterations += 1
            now = monotonic()
            deadlines: list[float] = []
            if state is not None:
                event = state.get("event")
                automation = state.get("automation")
                if isinstance(event, dict) and isinstance(event.get("id"), str):
                    if dry_run:
                        if awaiting_revision is None:
                            deadlines.append(next_frame_at)
                    elif isinstance(automation, dict) and automation.get("enabled") is True:
                        owner = automation.get("workerId")
                        if owner in {None, worker_id} or takeover_pending:
                            deadlines.append(next_heartbeat_at)
                        if (
                            owner == worker_id
                            and automation.get("status") == "running"
                            and awaiting_revision is None
                        ):
                            deadlines.append(next_frame_at)

            timeout = max(0.0, min(deadlines) - now) if deadlines else None
            update = feed.next(timeout)
            now = monotonic()
            if update is not None:
                if update.state is None:
                    stop_capture()
                    state = None
                    revision = None
                    awaiting_revision = None
                    _log_transient_failure(
                        last_error_logs,
                        operation="read the automation event stream",
                        error=update.error or ConnectionError("stream disconnected"),
                        now=now,
                        worker_id=worker_id,
                    )
                    continue
                state = update.state.payload
                revision = update.state.revision
                if awaiting_revision is not None and revision != awaiting_revision:
                    awaiting_revision = None

            if state is None:
                continue

            if not dry_run:
                try:
                    recovered = worker.recover_pending(state)
                except PendingActionConflictError:
                    raise
                except RetryableWorkerError as exc:
                    stop_capture()
                    next_frame_at = now + interval
                    _log_transient_failure(
                        last_error_logs,
                        operation="reconcile the pending action",
                        error=exc,
                        now=now,
                        worker_id=worker_id,
                    )
                    continue
                if recovered:
                    logger.info(
                        "Worker %s reconciled pending %s action for event %s",
                        worker_id,
                        recovered.get("type", "unknown"),
                        recovered.get("eventId", "unknown"),
                    )
                    awaiting_revision = revision
                    stop_capture()

            event = state.get("event")
            if not isinstance(event, dict):
                stop_capture()
                continue
            event_id = event.get("id")
            if not isinstance(event_id, str):
                stop_capture()
                _log_transient_failure(
                    last_error_logs,
                    operation="read the current event",
                    error=TypeError("server event has no string id"),
                    now=now,
                    worker_id=worker_id,
                )
                continue

            automation = state.get("automation")
            status = (
                automation.get("status", "disabled") if isinstance(automation, dict) else "disabled"
            )
            enabled = isinstance(automation, dict) and automation.get("enabled") is True
            owner = automation.get("workerId") if isinstance(automation, dict) else None
            can_heartbeat = enabled and (owner in {None, worker_id} or takeover_pending)

            if not dry_run and can_heartbeat and now >= next_heartbeat_at:
                next_heartbeat_at = now + HEARTBEAT_INTERVAL
                heartbeat: dict[str, object] = {
                    "type": "heartbeat",
                    "eventId": event_id,
                    "workerId": worker_id,
                    "observation": {"stream": "connected"},
                }
                if takeover_pending:
                    heartbeat["takeover"] = True
                try:
                    client.action(heartbeat, str(uuid.uuid4()))
                except Exception as exc:
                    stop_capture()
                    awaiting_revision = revision
                    _log_transient_failure(
                        last_error_logs,
                        operation="send a heartbeat",
                        error=exc,
                        now=now,
                        worker_id=worker_id,
                    )
                    continue
                if takeover_pending:
                    takeover_pending = False
                    logger.info("Worker %s acquired the stale worker lease", worker_id)
                if owner != worker_id:
                    awaiting_revision = revision
                    stop_capture()

            ready = automation_ready(str(status), dry_run=dry_run) and (
                dry_run or (enabled and owner == worker_id and awaiting_revision is None)
            )
            if not ready:
                stop_capture()
                continue
            if now < next_frame_at:
                continue
            next_frame_at = now + interval
            if frame_iterator is None:
                frame_iterator = iter(source.frames())
            try:
                frame = next(frame_iterator)
            except StopIteration:
                return
            try:
                action = worker.process(frame, state)
            except RetryableWorkerError as exc:
                if worker.journal.pending() is not None:
                    awaiting_revision = revision
                    stop_capture()
                _log_transient_failure(
                    last_error_logs,
                    operation="process a vision frame",
                    error=exc,
                    now=now,
                    worker_id=worker_id,
                )
                continue
            if action:
                typer.echo(json.dumps(action, separators=(",", ":")))
                if not dry_run:
                    awaiting_revision = revision
                    stop_capture()
    finally:
        stop_capture()
        feed.close()


@app.command()
def calibrate(port: Annotated[int, typer.Option()] = 8765) -> None:
    """Draw the fixed broadcast text regions locally."""
    source = TwitchSource(channel_name())
    calibration = create_calibration_app(layout_path(), source.capture)
    webbrowser.open(f"http://127.0.0.1:{port}")
    uvicorn.run(calibration, host="127.0.0.1", port=port, log_level="warning")


@app.command()
def autocalibrate() -> None:
    """Auto-detect roster and current-player regions from the live stream."""
    path = layout_path()
    source = TwitchSource(channel_name())
    frame = source.capture()
    ocr = RapidOcrReader()
    regions = autocalibrate_regions(frame, ocr)
    layout = (
        load_layout(path) if path.exists() else Layout(width=frame.shape[1], height=frame.shape[0])
    )
    layout.regions.update(regions)
    save_layout(layout, path)
    for name, region in regions.items():
        typer.echo(
            f"  {name}: x={region.x:.4f} y={region.y:.4f} w={region.width:.4f} h={region.height:.4f}"
        )
    debug = frame.copy()
    for name, region in regions.items():
        x, y, w, h = region.pixels(frame.shape[1], frame.shape[0])
        cv2.rectangle(debug, (x, y), (x + w, y + h), (0, 255, 0), 4)
        cv2.putText(debug, name, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
    debug_path = path.parent / "autocalibrate.png"
    cv2.imwrite(str(debug_path), debug)
    typer.echo(f"Saved {len(regions)} regions to {path}")
    typer.echo(f"Debug image: {debug_path}")
    typer.echo(f"Remaining: {', '.join(layout.missing()) or 'none'}")


@app.command()
def doctor() -> None:
    """Verify the stream, layout, OCR model, signature, and event state."""
    _, layout = complete_layout()
    frame = TwitchSource(channel_name(), layout.width, layout.height).capture()
    observation = VisionDetector(layout, RapidOcrReader()).detect(frame)
    if observation.metadata.get("overlayVisible") is not True:
        raise typer.BadParameter(
            "KOTH overlay not detected; show Leaderboard, Current player, and Queue on stream"
        )
    state = automation_client().state()
    event = state.get("event")
    if not event:
        raise typer.BadParameter("Create a KOTH event before starting the worker")
    if event.get("status") not in RUNNABLE_EVENT_STATUSES:
        raise typer.BadParameter(
            f"KOTH event is not runnable (status: {event.get('status')}); create a draft event"
        )
    typer.echo(
        f"ready: {channel_name()} {frame.shape[1]}x{frame.shape[0]} → "
        f"{event['name']} ({event['status']})"
    )


@app.command("run")
def run_worker(
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    fps: Annotated[float, typer.Option(min=0.25, max=5)] = 2.0,
    takeover: Annotated[
        bool,
        typer.Option(
            "--takeover",
            help="Claim a different worker's lease after its heartbeat has been stale for 15s.",
        ),
    ] = False,
) -> None:
    """Watch the Twitch stream and drive enabled event automation."""
    if dry_run and takeover:
        raise typer.BadParameter("--takeover cannot be used with --dry-run")
    path, layout = complete_layout()
    client = automation_client()
    worker_id = os.environ.get("KOTH_CV_WORKER_ID", default_worker_id())
    worker = Worker(
        client=client,
        detector=VisionDetector(layout),
        journal=ActionJournal(RUNTIME / "action-journal.json"),
        worker_id=worker_id,
        dry_run=dry_run,
    )
    source = TwitchSource(channel_name(), layout.width, layout.height)
    try:
        _run_worker_frames(
            source,
            client=client,
            worker=worker,
            worker_id=worker_id,
            dry_run=dry_run,
            fps=fps,
            takeover=takeover,
        )
    except PendingActionConflictError as exc:
        raise typer.BadParameter(str(exc)) from exc


@app.command()
def record(
    minutes: Annotated[float, typer.Option(min=0.1, max=120)] = 10,
    fps: Annotated[float, typer.Option(min=0.25, max=5)] = 2.0,
) -> None:
    """Save an opt-in timestamped frame set for deterministic replay."""
    destination = RUNTIME / "recordings" / time.strftime("%Y%m%d-%H%M%S")
    destination.mkdir(parents=True, exist_ok=True)
    source = TwitchSource(channel_name())
    started = time.monotonic()
    last_frame = 0.0
    index = 0
    for frame in source.frames():
        now = time.monotonic()
        if now - started >= minutes * 60:
            break
        if now - last_frame < 1 / fps:
            continue
        last_frame = now
        cv2.imwrite(str(destination / f"{index:06d}-{time.time_ns()}.jpg"), frame)
        index += 1
    typer.echo(f"saved {index} frames to {destination}")


@app.command()
def replay(
    manifest: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    layout_file: Annotated[Path | None, typer.Option("--layout", dir_okay=False)] = None,
    worker_id: Annotated[str, typer.Option()] = "replay",
) -> None:
    """Replay local frames through OCR and assert a lifecycle manifest."""
    selected_layout = layout_file or layout_path()
    if not selected_layout.exists():
        raise typer.BadParameter(f"Missing calibration: {selected_layout}")
    layout = load_layout(selected_layout)
    if missing := [
        *layout.missing(),
        *missing_template_files(layout, selected_layout.parent),
    ]:
        raise typer.BadParameter(f"Incomplete calibration: {', '.join(missing)}")
    try:
        results = replay_manifest(
            manifest,
            VisionDetector(layout),
            worker_id=worker_id,
        )
    except (ReplayMismatchError, ValueError) as exc:
        raise typer.BadParameter(str(exc)) from exc
    for result in results:
        typer.echo(json.dumps(result, separators=(",", ":")))
