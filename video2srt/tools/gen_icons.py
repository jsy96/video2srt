# Generate extension icons (mic glyph on indigo rounded square) -> icons/icon{16,48,128}.png
# Run from project root: uv run --no-project --with pillow tools/gen_icons.py
from PIL import Image, ImageDraw

BG = (91, 78, 224, 255)
FG = (255, 255, 255, 255)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=max(2, size // 5), fill=BG)

    w = max(2, round(size * 0.075))
    # mic capsule
    cw = size * 0.30
    ch = size * 0.32
    x0 = (size - cw) / 2
    y0 = size * 0.13
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch], radius=cw / 2, fill=FG)
    # arc
    ar = size * 0.27
    top = y0 + ch * 0.5
    d.arc([size / 2 - ar, top, size / 2 + ar, top + 2 * ar], start=20, end=160, fill=FG, width=w)
    # stem + base
    cx = size / 2
    y_arc_bottom = top + ar
    y_stem_end = min(size * 0.90, top + 2 * ar - ar * 0.1)
    d.line([cx, y_arc_bottom, cx, y_stem_end], fill=FG, width=w)
    base_y = min(size - w, y_stem_end + size * 0.02)
    half = size * 0.18
    d.line([cx - half, base_y, cx + half, base_y], fill=FG, width=w)
    return img


if __name__ == "__main__":
    for s in (16, 48, 128):
        make(s).save(f"icons/icon{s}.png")
    print("icons written: icons/icon16.png, icon48.png, icon128.png")
