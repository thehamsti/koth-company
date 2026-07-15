from __future__ import annotations

import logging
import os
import selectors
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator

import numpy as np
import streamlink
from streamlink.exceptions import StreamlinkError


logger = logging.getLogger(__name__)
RECOVERABLE_STREAM_ERRORS = (OSError, RuntimeError, subprocess.SubprocessError, StreamlinkError)


class StreamStalledError(RuntimeError):
    pass


def read_exact(fd: int, size: int, timeout: float) -> bytes:
    value = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while len(value) < size:
            if not selector.select(timeout):
                raise StreamStalledError(f"ffmpeg produced no frame data for {timeout:g}s")
            chunk = os.read(fd, size - len(value))
            if not chunk:
                break
            value.extend(chunk)
    return bytes(value)


class TwitchSource:
    def __init__(
        self,
        channel: str,
        width: int = 1920,
        height: int = 1080,
        frame_timeout: float = 10.0,
    ) -> None:
        self.channel = channel
        self.width = width
        self.height = height
        self.frame_timeout = frame_timeout
        self._latest: np.ndarray | None = None
        self._error: Exception | None = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def _stream_url(self) -> str:
        streams = streamlink.streams(f"https://twitch.tv/{self.channel}")
        for quality in ("1080p60", "1080p", "best"):
            selected = streams.get(quality)
            if selected:
                return selected.url
        raise RuntimeError(f"No public Twitch stream is available for {self.channel}")

    def _frames_once(self) -> Iterator[np.ndarray]:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("ffmpeg is required to decode the Twitch stream")
        process = subprocess.Popen(
            [
                ffmpeg,
                "-loglevel",
                "error",
                "-i",
                self._stream_url(),
                "-an",
                "-sn",
                "-vf",
                f"fps=5,scale={self.width}:{self.height}",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgr24",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        frame_size = self.width * self.height * 3
        try:
            assert process.stdout is not None
            while True:
                value = read_exact(process.stdout.fileno(), frame_size, self.frame_timeout)
                if len(value) != frame_size:
                    raise RuntimeError(
                        f"ffmpeg ended with an incomplete frame ({len(value)}/{frame_size} bytes)"
                    )
                yield np.frombuffer(value, dtype=np.uint8).reshape((self.height, self.width, 3))
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def frames(self) -> Iterator[np.ndarray]:
        backoff = 1.0
        outage_reported = False
        while True:
            try:
                for frame in self._frames_once():
                    if outage_reported:
                        logger.info("Twitch stream recovered for %s", self.channel)
                    outage_reported = False
                    backoff = 1.0
                    yield frame
                raise RuntimeError("Twitch stream ended")
            except RECOVERABLE_STREAM_ERRORS as exc:
                if not outage_reported:
                    logger.warning(
                        "Twitch stream unavailable for %s: %s; retrying",
                        self.channel,
                        exc,
                    )
                    outage_reported = True
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _capture_loop(self) -> None:
        backoff = 1.0
        while True:
            try:
                for frame in self._frames_once():
                    with self._lock:
                        self._latest = frame
                        self._error = None
                    backoff = 1.0
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
            except RECOVERABLE_STREAM_ERRORS as exc:
                with self._lock:
                    if self._latest is None:
                        self._error = exc
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def capture(self) -> np.ndarray:
        with self._lock:
            if self._thread is None:
                self._thread = threading.Thread(target=self._capture_loop, daemon=True)
                self._thread.start()
        while True:
            with self._lock:
                if self._latest is not None:
                    return self._latest
                if self._error is not None:
                    raise self._error
            time.sleep(0.05)
