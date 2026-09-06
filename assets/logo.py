"""
The BACKSTOP mark.

The picture is the product: a running product of e-values climbing toward a threshold that was
fixed before any round ran, and a solid bar underneath that catches it. Evidence above the line,
capital below it.

Renders the square mark, a wide graphic for the submission, and a favicon.

    python assets/logo.py
"""

from math import exp
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BG = (7, 9, 12)
PANEL = (16, 22, 31)
GRID = (28, 37, 49)
GREEN = (74, 222, 128)
GREEN_DIM = (22, 101, 52)
RED = (248, 113, 113)
AMBER = (251, 191, 36)
TEXT = (230, 237, 245)
DIM = (139, 152, 169)

# The trace: six clean rounds decaying, then a departure that crosses.
TRACE = [0.03, -0.39, -0.38, -0.43, -0.81, -1.10, 0.06, 1.46, 2.62, 3.85]
CONTROL = [-0.2, -0.5, -0.8, -1.0, -1.4, -1.7, -2.0, -2.3, -2.6, -2.84]
BOUNDARY = 2.9957


def font(size, bold=False):
    for name in (
        "C:/Windows/Fonts/consolab.ttf" if bold else "C:/Windows/Fonts/consola.ttf",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_chart(d, x0, y0, w, h, *, lw=6, dot=7, show_control=True):
    """The trace, the boundary and the backstop bar, inside the given box."""
    lo, hi = -3.4, 4.6
    n = len(TRACE) - 1

    def px(i):
        return x0 + i * w / n

    def py(v):
        return y0 + (1 - (v - lo) / (hi - lo)) * h

    # the region above the boundary, where a claim exists
    d.rectangle([x0, y0, x0 + w, py(BOUNDARY)], fill=(30, 16, 20))

    # grid
    for v in (-3, -2, -1, 0, 1, 2, 3, 4):
        d.line([(x0, py(v)), (x0 + w, py(v))], fill=GRID, width=1)

    # the boundary, fixed before any round ran
    step = 26
    x = x0
    while x < x0 + w:
        d.line([(x, py(BOUNDARY)), (min(x + 15, x0 + w), py(BOUNDARY))], fill=RED, width=max(2, lw // 2))
        x += step

    if show_control:
        pts = [(px(i), py(v)) for i, v in enumerate(CONTROL)]
        d.line(pts, fill=GREEN_DIM, width=max(2, lw - 3), joint="curve")

    pts = [(px(i), py(v)) for i, v in enumerate(TRACE)]
    # the clean segment and the departure, in two colours
    d.line(pts[:6], fill=GREEN, width=lw, joint="curve")
    d.line(pts[5:], fill=RED, width=lw, joint="curve")
    for i, (cx, cy) in enumerate(pts):
        c = GREEN if i < 6 else RED
        d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=c)

    # the backstop: a solid bar under the whole trace
    bar_y = y0 + h + max(10, h // 12)
    bar_h = max(8, h // 16)
    d.rounded_rectangle(
        [x0, bar_y, x0 + w, bar_y + bar_h], radius=bar_h // 2, fill=GREEN
    )
    return bar_y + bar_h


def square(size=1024, path="assets/logo.png"):
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)

    pad = int(size * 0.11)
    d.rounded_rectangle([pad // 2, pad // 2, size - pad // 2, size - pad // 2], radius=int(size * 0.08), fill=PANEL)

    cw = size - 2 * pad
    ch = int(size * 0.44)
    cx = pad
    cy = int(size * 0.20)
    bottom = draw_chart(d, cx, cy, cw, ch, lw=int(size * 0.010), dot=int(size * 0.011))

    f = font(int(size * 0.098), bold=True)
    label = "BACKSTOP"
    bbox = d.textbbox((0, 0), label, font=f)
    tw = bbox[2] - bbox[0]
    d.text(((size - tw) / 2, bottom + int(size * 0.055)), label, font=f, fill=TEXT)

    fs = font(int(size * 0.036))
    sub = "verified inference"
    bbox = d.textbbox((0, 0), sub, font=fs)
    sw = bbox[2] - bbox[0]
    d.text(((size - sw) / 2, bottom + int(size * 0.175)), sub, font=fs, fill=DIM)

    im.save(path, "PNG", optimize=True)
    print(f"wrote {path}  {im.size}")


def wide(w=1600, h=900, path="assets/cover.png"):
    im = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(im)

    # a soft accent wash, the same one the app uses
    glow = Image.new("RGB", (w, h), BG)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-300, -420, 900, 420], fill=(14, 32, 24))
    gd.ellipse([w - 700, -360, w + 300, 300], fill=(11, 28, 38))
    im = Image.blend(im, glow.filter(ImageFilter.GaussianBlur(160)), 0.85)
    d = ImageDraw.Draw(im)

    fx = font(74, bold=True)
    d.text((90, 118), "BACKSTOP", font=fx, fill=TEXT)

    fl = font(31)
    d.text((92, 224), "Capital-backed verification for hosted AI inference", font=fl, fill=DIM)

    fs = font(23)
    lines = [
        "The threshold is fixed on chain before any round runs.",
        "The evidence is proven, not asserted.",
        "A crossing pays without anyone filing.",
    ]
    for i, line in enumerate(lines):
        d.text((92, 300 + i * 40), line, font=fs, fill=(120, 133, 150))

    bottom = draw_chart(d, 92, 470, w - 184, 280, lw=6, dot=7)

    fk = font(21)
    d.text((92, bottom + 34), "0 of 1,600 benign          200 of 200 substitutions          4.87x envelope separation", font=fk, fill=DIM)

    im.save(path, "PNG", optimize=True)
    print(f"wrote {path}  {im.size}")


def favicon(path="apps/web/public/favicon.png"):
    size = 256
    im = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([6, 6, size - 6, size - 6], radius=44, fill=PANEL)
    draw_chart(d, 34, 44, size - 68, 116, lw=7, dot=6, show_control=False)
    im.save(path, "PNG", optimize=True)
    print(f"wrote {path}  {im.size}")


if __name__ == "__main__":
    square()
    wide()
    favicon()
