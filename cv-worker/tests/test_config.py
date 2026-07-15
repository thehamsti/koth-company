from pathlib import Path

from koth_cv.config import Layout, Region, load_layout, missing_template_files, save_layout


def test_layout_round_trips_normalized_regions(tmp_path: Path) -> None:
    path = tmp_path / "layout.yaml"
    layout = Layout(
        width=1920,
        height=1080,
        regions={"active_name": Region(x=0.1, y=0.2, width=0.3, height=0.1)},
        templates={"start": "templates/start.png"},
    )

    save_layout(layout, path)

    assert load_layout(path) == layout


def test_region_rejects_coordinates_outside_the_frame() -> None:
    try:
        Region(x=0.9, y=0.2, width=0.2, height=0.1)
    except ValueError as error:
        assert "frame" in str(error)
    else:
        raise AssertionError("invalid region was accepted")


def test_reports_template_files_missing_from_calibration(tmp_path: Path) -> None:
    layout = Layout(templates={"start": "templates/start.png"})

    assert missing_template_files(layout, tmp_path) == ["template-file:start"]


def test_layout_requires_dynamic_overlay_and_team_neutral_match_signals() -> None:
    layout = Layout(
        regions={
            "queue_header": Region(x=0, y=0, width=0.1, height=0.1),
            "leaderboard_header": Region(x=0.1, y=0, width=0.1, height=0.1),
            "roster": Region(x=0.2, y=0, width=0.1, height=0.1),
            "active_name": Region(x=0.3, y=0, width=0.1, height=0.1),
            "start": Region(x=0.4, y=0, width=0.1, height=0.1),
            "win": Region(x=0.5, y=0, width=0.1, height=0.1),
            "loss": Region(x=0.6, y=0, width=0.1, height=0.1),
        },
        templates={
            "start": "templates/start.png",
            "win": "templates/win.png",
            "loss": "templates/loss.png",
        },
    )

    assert layout.missing() == ["region:overlay", "region:result"]
