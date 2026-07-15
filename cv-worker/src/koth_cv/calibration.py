from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from .config import Layout, Region, load_layout, save_layout
from .vision import OcrReader


class CalibrationStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def layout(self) -> Layout:
        return load_layout(self.path) if self.path.exists() else Layout()

    def save(self, name: str, region: Region) -> None:
        layout = self.layout()
        layout.regions[name] = region
        save_layout(layout, self.path)


class RegionSelection(BaseModel):
    name: str
    x: float
    y: float
    width: float
    height: float


CALIBRATION_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>KOTH CV calibration</title>
<style>body{margin:0;background:#101515;color:#f5f0df;font:16px system-ui}header{padding:16px 24px;display:flex;gap:16px;align-items:center}canvas{display:block;max-width:100%;cursor:crosshair}button,select{font:inherit;padding:8px 12px}.hint{color:#a9b4ad}</style></head>
<body><header><strong>Hydramist 1080p calibration</strong><select id="name"><option>overlay</option><option>start</option><option>result</option></select><button id="refresh">Refresh live frame</button><button id="save">Save selection</button><span class="hint">Overlay must contain Leaderboard, Current player, and Queue. Capture start around Shadowsight…spawns and result around either team-wins title.</span></header><canvas id="canvas"></canvas>
<script>
const canvas=document.querySelector('#canvas'),ctx=canvas.getContext('2d'),img=new Image();let start=null,box=null;
function load(){img.src='/frame?at='+Date.now()} img.onload=()=>{canvas.width=img.width;canvas.height=img.height;draw()};
function draw(){ctx.drawImage(img,0,0);if(box){ctx.strokeStyle='#e8b94f';ctx.lineWidth=4;ctx.strokeRect(box.x,box.y,box.w,box.h)}}
canvas.onpointerdown=e=>{const r=canvas.getBoundingClientRect();start={x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}};
canvas.onpointermove=e=>{if(!start)return;const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)*canvas.width/r.width,y=(e.clientY-r.top)*canvas.height/r.height;box={x:Math.min(start.x,x),y:Math.min(start.y,y),w:Math.abs(x-start.x),h:Math.abs(y-start.y)};draw()};
canvas.onpointerup=()=>start=null;document.querySelector('#refresh').onclick=load;
document.querySelector('#save').onclick=async()=>{if(!box)return;await fetch('/region',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:document.querySelector('#name').value,x:box.x/canvas.width,y:box.y/canvas.height,width:box.w/canvas.width,height:box.h/canvas.height})});box=null;draw()};load();
</script></body></html>"""


def create_calibration_app(layout_path: Path, capture_frame: Callable[[], np.ndarray]) -> FastAPI:
    app = FastAPI()
    store = CalibrationStore(layout_path)
    current: dict[str, np.ndarray] = {}

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return CALIBRATION_HTML

    @app.get("/frame")
    def frame() -> Response:
        image = capture_frame()
        current["frame"] = image
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise RuntimeError("Could not encode calibration frame")
        return Response(content=encoded.tobytes(), media_type="image/jpeg")

    @app.post("/region")
    def region(selection: RegionSelection) -> dict[str, object]:
        image = current.get("frame")
        if image is None:
            raise ValueError("Capture a frame before saving a region")
        selected = Region.model_validate(selection.model_dump(exclude={"name"}))
        store.save(selection.name, selected)
        return {"saved": selection.name, "missing": store.layout().missing()}

    return app


def _bounding_region(
    boxes: list[tuple[int, int, int, int]],
    width: int,
    height: int,
    pad: float = 0.01,
    top_bound: int = 0,
    bottom_bound: int | None = None,
    extend_to_bottom_bound: bool = False,
) -> Region:
    min_x = min(b[0] for b in boxes)
    min_y = min(b[1] for b in boxes)
    max_x = max(b[0] + b[2] for b in boxes)
    max_y = max(b[1] + b[3] for b in boxes)
    pad_x = int(width * pad)
    pad_y = int(height * pad)
    left = max(0, min_x - pad_x)
    top = max(top_bound, min_y - pad_y)
    right = min(width, max_x + pad_x)
    bottom_limit = bottom_bound if bottom_bound is not None else height
    bottom = bottom_limit if extend_to_bottom_bound else min(bottom_limit, max_y + pad_y)
    return Region(
        x=left / width,
        y=top / height,
        width=(right - left) / width,
        height=(bottom - top) / height,
    )


def autocalibrate_regions(
    frame: np.ndarray,
    ocr: OcrReader,
) -> dict[str, Region]:
    """Auto-detect overlay regions from its stable text anchors."""
    height, width = frame.shape[:2]
    detections = ocr.read_with_boxes(frame)

    queue_box: tuple[int, int, int, int] | None = None
    leaderboard_box: tuple[int, int, int, int] | None = None
    current_player_box: tuple[int, int, int, int] | None = None
    normalized_detections: list[tuple[str, tuple[int, int, int, int]]] = []
    for text, score, box in detections:
        if score < 0.5:
            continue
        normalized = re.sub(r"[^a-z]", "", text.casefold())
        normalized_detections.append((normalized, box))
        if normalized == "queue" and queue_box is None:
            queue_box = box
        elif normalized == "leaderboard" and leaderboard_box is None:
            leaderboard_box = box
        elif normalized == "currentplayer" and current_player_box is None:
            current_player_box = box

    if current_player_box is None:
        current_box = next(
            (box for normalized, box in normalized_detections if normalized == "current"), None
        )
        player_box = next(
            (box for normalized, box in normalized_detections if normalized == "player"), None
        )
        if current_box and player_box:
            current_center = current_box[1] + current_box[3] / 2
            player_center = player_box[1] + player_box[3] / 2
            if abs(current_center - player_center) <= max(current_box[3], player_box[3]):
                left = min(current_box[0], player_box[0])
                top = min(current_box[1], player_box[1])
                right = max(current_box[0] + current_box[2], player_box[0] + player_box[2])
                bottom = max(current_box[1] + current_box[3], player_box[1] + player_box[3])
                current_player_box = (left, top, right - left, bottom - top)

    if queue_box is None:
        raise RuntimeError("Could not find 'Queue:' header — ensure the roster panel is visible")
    if leaderboard_box is None:
        raise RuntimeError(
            "Could not find 'Leaderboard:' header — ensure the leaderboard panel is visible"
        )
    if current_player_box is None:
        raise RuntimeError(
            "Could not find 'Current player:' header — ensure the current-player panel is visible"
        )

    left_bound = max(0, min(queue_box[0], leaderboard_box[0]) - int(width * 0.02))

    queue_cy = queue_box[1] + queue_box[3] / 2
    roster_boxes = [
        box
        for _, score, box in detections
        if score >= 0.5 and (box[1] + box[3] / 2) > queue_cy and box[0] >= left_bound
    ]
    if not roster_boxes:
        raise RuntimeError("No text detected below 'Queue:' header")

    roster_boxes.sort(key=lambda b: b[1])
    roster_bottom = height
    gap_threshold = max(queue_box[3] * 2, int(height * 0.05))
    for i in range(1, len(roster_boxes)):
        previous_bottom = roster_boxes[i - 1][1] + roster_boxes[i - 1][3]
        if roster_boxes[i][1] - previous_bottom > gap_threshold:
            roster_bottom = roster_boxes[i][1]
            roster_boxes = roster_boxes[:i]
            break

    active_detections = [
        (text, box)
        for text, score, box in detections
        if score >= 0.5
        and (box[1] + box[3] / 2) > current_player_box[1] + current_player_box[3]
        and (box[1] + box[3] / 2) < queue_cy
        and box[0] >= left_bound
    ]
    wins_detection = next(
        (
            (text, box)
            for text, box in active_detections
            if re.fullmatch(r"wins\d+", re.sub(r"[^a-z0-9]", "", text.casefold()))
        ),
        None,
    )
    if wins_detection is None:
        raise RuntimeError("Could not find the current player's 'Wins:' value")
    _, wins_box = wins_detection
    name_boxes = [
        box
        for text, box in active_detections
        if box != wins_box
        and "wins" not in re.sub(r"[^a-z]", "", text.casefold())
        and re.search(r"[a-z]", text, re.IGNORECASE)
    ]
    if not name_boxes:
        raise RuntimeError("Could not find the current player name")
    active_box = min(name_boxes, key=lambda box: (box[1], box[0]))

    return {
        "overlay": Region(
            x=left_bound / width,
            y=max(0, leaderboard_box[1] - int(height * 0.02)) / height,
            width=(width - left_bound) / width,
            height=(
                min(height, int(height * 0.9)) - max(0, leaderboard_box[1] - int(height * 0.02))
            )
            / height,
        ),
        "queue_header": _bounding_region([queue_box], width, height, pad=0.005),
        "leaderboard_header": _bounding_region([leaderboard_box], width, height, pad=0.005),
        "roster": _bounding_region(
            roster_boxes,
            width,
            height,
            top_bound=queue_box[1] + queue_box[3],
            bottom_bound=roster_bottom,
            extend_to_bottom_bound=True,
        ),
        "active_name": _bounding_region(
            [active_box],
            width,
            height,
            pad=0.0075,
        ),
        "current_wins": _bounding_region(
            [active_box, wins_box],
            width,
            height,
            pad=0.0075,
        ),
    }
