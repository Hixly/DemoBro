#!/usr/bin/env python3
"""Generate DemoBro's favicon set from the canonical transparent play logo."""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "brand" / "demobro-logo.png"
PNG_OUTPUT = ROOT / "src" / "app" / "icon.png"
ICO_OUTPUT = ROOT / "src" / "app" / "favicon.ico"
CANVAS_SIZE = 512
PADDING = 40
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    logo = Image.open(SOURCE).convert("RGBA")
    visible_bounds = logo.getchannel("A").getbbox()
    if visible_bounds is None:
        raise ValueError(f"Logo has no visible pixels: {SOURCE}")

    mark = logo.crop(visible_bounds)
    available = CANVAS_SIZE - (PADDING * 2)
    mark.thumbnail((available, available), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    position = (
        (CANVAS_SIZE - mark.width) // 2,
        (CANVAS_SIZE - mark.height) // 2,
    )
    canvas.alpha_composite(mark, position)

    PNG_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(PNG_OUTPUT, optimize=True)
    canvas.save(ICO_OUTPUT, format="ICO", sizes=ICO_SIZES)

    print(f"Generated {PNG_OUTPUT.relative_to(ROOT)} ({CANVAS_SIZE}x{CANVAS_SIZE})")
    print(f"Generated {ICO_OUTPUT.relative_to(ROOT)} ({len(ICO_SIZES)} embedded sizes)")


if __name__ == "__main__":
    main()
