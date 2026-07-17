"""
Generate the app icon (assets/icon.ico) — a stylised Romdoul flower (5 cyan
petals, magenta centre) on a dark rounded tile, matching the app's cyan×magenta
theme. Run once (or via build.ps1); commits assets/icon.ico.

    python make_icon.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFilter

CYAN = (0, 229, 255, 255)
MAGENTA = (255, 47, 185, 255)
INK = (11, 18, 32, 255)
S = 256


def rounded(size, radius, fill):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=fill)
    return img


def build() -> Image.Image:
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Dark rounded tile with a soft cyan glow behind it.
    glow = rounded(S, 60, (0, 229, 255, 90)).filter(ImageFilter.GaussianBlur(10))
    base = Image.alpha_composite(base, glow)
    base = Image.alpha_composite(base, rounded(S, 56, INK))
    # thin neon ring
    ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle([3, 3, S - 4, S - 4], radius=53, outline=CYAN, width=3)
    base = Image.alpha_composite(base, ring)

    # Five petals radiating from the centre.
    cx = cy = S // 2
    flower = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for i in range(5):
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        # a petal pointing UP from the centre
        d.ellipse([cx - 34, 46, cx + 34, cy + 6], fill=CYAN)
        layer = layer.rotate(i * 72, center=(cx, cy), resample=Image.BICUBIC)
        flower = Image.alpha_composite(flower, layer)
    # magenta centre
    ImageDraw.Draw(flower).ellipse([cx - 24, cy - 24, cx + 24, cy + 24], fill=MAGENTA)
    ImageDraw.Draw(flower).ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(255, 255, 255, 230))

    return Image.alpha_composite(base, flower)


def main() -> None:
    os.makedirs("assets", exist_ok=True)
    icon = build()
    icon.save(os.path.join("assets", "icon.ico"),
              sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    icon.save(os.path.join("assets", "icon.png"))
    print("wrote assets/icon.ico and assets/icon.png")


if __name__ == "__main__":
    main()
