import logging
import os

import numpy as np
import pytest
from streamlink.exceptions import PluginError

from koth_cv.stream import StreamStalledError, TwitchSource, read_exact


class OfflineSource(TwitchSource):
    def _stream_url(self) -> str:
        raise RuntimeError("offline")


def test_single_frame_capture_fails_immediately_when_channel_is_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("koth_cv.stream.shutil.which", lambda _name: "/usr/bin/ffmpeg")
    with pytest.raises(RuntimeError, match="offline"):
        OfflineSource("hydramist").capture()


def test_frame_read_times_out_when_ffmpeg_stalls() -> None:
    read_fd, write_fd = os.pipe()
    try:
        with pytest.raises(StreamStalledError, match="no frame data"):
            read_exact(read_fd, 4, 0.01)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_reconnects_after_streamlink_error_and_resets_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sleeps: list[float] = []

    class RecoveringSource(TwitchSource):
        attempts = 0

        def _frames_once(self):
            self.attempts += 1
            if self.attempts == 1:
                raise PluginError("temporary Twitch failure")
            yield np.full((1, 1, 3), self.attempts, dtype=np.uint8)

    monkeypatch.setattr("koth_cv.stream.time.sleep", sleeps.append)
    frames = RecoveringSource("hydramist", width=1, height=1).frames()

    assert int(next(frames)[0, 0, 0]) == 2
    assert int(next(frames)[0, 0, 0]) == 3
    assert sleeps == [1.0, 1.0]


def test_reports_one_warning_per_outage(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    class RecoveringSource(TwitchSource):
        attempts = 0

        def _frames_once(self):
            self.attempts += 1
            if self.attempts <= 2:
                raise PluginError(f"failure {self.attempts}")
            yield np.zeros((1, 1, 3), dtype=np.uint8)

    monkeypatch.setattr("koth_cv.stream.time.sleep", lambda _seconds: None)
    caplog.set_level(logging.INFO, logger="koth_cv.stream")

    next(RecoveringSource("hydramist", width=1, height=1).frames())

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "failure 1" in warnings[0].message
    assert any("recovered" in record.message for record in caplog.records)
