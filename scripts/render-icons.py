"""Renders icons/icon{16,32,48,128}.png from icons/icon.svg.

16/32/48 are full-bleed (toolbar, extensions page). 128 follows the Chrome Web Store guideline:
96x96 artwork centred on a 128x128 transparent canvas (16 px padding).

Dev-only. Needs: pip install resvg-py pillow.  Run from the repo root:  python scripts/render-icons.py
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image

root = Path(__file__).resolve().parent.parent
svg = (root / "icons" / "icon.svg").read_text(encoding="utf-8")


def render(size):
    # Vector rendered straight at the target size, so 16 px stays sharp (no downscaling blur).
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)))).convert("RGBA")


for size in (16, 32, 48):
    render(size).save(root / "icons" / f"icon{size}.png", optimize=True)

store = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
store.paste(render(96), (16, 16))
store.save(root / "icons" / "icon128.png", optimize=True)

for size in (16, 32, 48, 128):
    p = root / "icons" / f"icon{size}.png"
    im = Image.open(p)
    assert im.size == (size, size), (p, im.size)
    print(f"{p.relative_to(root)}: {im.size[0]}x{im.size[1]}, {p.stat().st_size} bytes")
