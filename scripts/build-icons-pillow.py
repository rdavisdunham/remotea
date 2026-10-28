#!/usr/bin/env python3
"""Draw resources/icons/icon.svg's geometry with Pillow (for WSL, where Electron can't run).

Numbers mirror icon.svg exactly; if you change one, change the other. Writes
resources/icons/icon.png, resources/icon.png (512) and resources/icons/icon.ico.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 8  # supersample
PLATE, DIM, YELLOW = "#15151a", "#3a3a43", "#f5c518"

def rr(draw, box, r, fill):
    draw.rounded_rectangle([v * S for v in box], radius=r * S, fill=fill)

def render():
    img = Image.new("RGBA", (512 * S, 512 * S), (0, 0, 0, 0))
    rr(ImageDraw.Draw(img), (0, 0, 512, 512), 123.4, PLATE)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    rr(ImageDraw.Draw(glow), (262, 114, 414, 398), 32, YELLOW)
    glow.putalpha(glow.getchannel("A").point(lambda a: int(a * 0.55)))
    glow = glow.filter(ImageFilter.GaussianBlur(22 * S))
    img.alpha_composite(glow)
    d = ImageDraw.Draw(img)
    rr(d, (112, 128, 236, 384), 18, DIM)
    rr(d, (276, 128, 400, 384), 18, YELLOW)
    # keep the glow inside the plate's rounded corners
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 512 * S, 512 * S], radius=123.4 * S, fill=255)
    img.putalpha(Image.composite(img.getchannel("A"), mask, mask))
    return img

big = render()
png512 = big.resize((512, 512), Image.LANCZOS)
png512.save(ROOT / "resources/icons/icon.png")
png512.save(ROOT / "resources/icon.png")
sizes = [16, 20, 24, 32, 48, 64, 128, 256]
big.resize((256, 256), Image.LANCZOS).save(
    ROOT / "resources/icons/icon.ico", sizes=[(s, s) for s in sizes], bitmap_format="png"
)
print("wrote icon.png (512), resources/icon.png, icon.ico", sizes)
