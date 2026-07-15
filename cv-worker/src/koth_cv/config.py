from __future__ import annotations

from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator


class Region(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def contained_in_frame(self) -> "Region":
        if self.x + self.width > 1 or self.y + self.height > 1:
            raise ValueError("region must be contained within the frame")
        return self

    def pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        return (
            round(self.x * width),
            round(self.y * height),
            round(self.width * width),
            round(self.height * height),
        )


class Layout(BaseModel):
    width: int = 1920
    height: int = 1080
    regions: dict[str, Region] = Field(default_factory=dict)
    templates: dict[str, str] = Field(default_factory=dict)

    def missing(self) -> list[str]:
        required_regions = {"overlay", "start", "result"}
        missing_regions = [f"region:{name}" for name in required_regions - self.regions.keys()]
        return sorted(missing_regions)


def load_layout(path: Path) -> Layout:
    return Layout.model_validate(yaml.safe_load(path.read_text()))


def save_layout(layout: Layout, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(layout.model_dump(), sort_keys=True))


def missing_template_files(layout: Layout, layout_dir: Path) -> list[str]:
    return sorted(
        f"template-file:{name}"
        for name, template in layout.templates.items()
        if not (layout_dir / template).is_file()
    )
