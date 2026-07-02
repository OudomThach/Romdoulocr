"""
Surya-specific image preprocessing.

surya-ocr-2 (served via vLLM) reads clean, adequately-sized document images
well, but on LOW-RES / blurry / skewed / faded scans — think old historical
documents, or a 2.9KB synthetic line — it degrades badly: it can enter a
token-repetition loop, run for tens of seconds, and return nothing usable.

The Cloud (Modal) backend uses a different model and isn't affected, so this
pipeline runs ONLY on the vLLM path (this adapter is that path). It gives the
model the "bare minimum" it needs:

  1. deskew      — straighten a tilted scan (projection-profile angle estimate),
                   so text lines are horizontal for recognition.
  2. upscale     — bump a small image up to a minimum long edge so glyphs have
                   enough pixels (the core fix for the low-res failure).
  3. grayscale   — drop the paper color cast.
  4. deblur      — a mild unsharp mask to crisp up soft/blurry strokes.

The steps here were each A/B-tested against the live model on clean images to
confirm they DON'T degrade good input: upscale (LANCZOS), grayscale and a mild
unsharp are quality-neutral on clean scans while helping low-res/blurry ones.
Two steps were tried and REMOVED because they corrupted clean text — autocontrast
(turned "Hello Surya OCR" into "Hollo Sunya @CR") and a median denoise. If a
"faded historical ink" stretch is ever wanted, gate it on a genuine low-dynamic-
range check, not unconditionally.

Everything is best-effort: any failure falls back to the original bytes so OCR
never breaks because preprocessing hiccuped.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageFilter, ImageOps

# Tunables. MIN_EDGE is the "bare minimum" long edge we guarantee; small images
# are upscaled up to it. MAX_EDGE bounds the upload so a huge scan isn't blown up.
MIN_EDGE = 1600
MAX_EDGE = 3000
DETECT_EDGE = 1000  # skew is estimated on a downscaled copy (fast, accurate)
MAX_SKEW_DEG = 10


def preprocess_for_surya(
    data: bytes,
    *,
    min_edge: int = MIN_EDGE,
    max_edge: int = MAX_EDGE,
    do_deskew: bool = True,
) -> bytes:
    """Return PNG bytes of the preprocessed image. Best-effort: re-raises only
    if the input can't be decoded at all (caller falls back to raw)."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)  # honor camera rotation metadata
    img = img.convert("RGB")

    if do_deskew:
        angle = _detect_skew(_gray_small(img))
        if angle != 0.0:
            img = img.rotate(-angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))

    # Resize to the readable band: upscale tiny images, cap giant ones.
    w, h = img.size
    long_edge = max(w, h)
    target = None
    if long_edge < min_edge:
        target = min_edge
    elif long_edge > max_edge:
        target = max_edge
    if target is not None and long_edge > 0:
        scale = target / long_edge
        resample = Image.LANCZOS  # high quality for both up- and down-scaling
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), resample)

    # Grayscale + a MILD unsharp to crisp soft strokes. (autocontrast + median
    # were removed — they corrupted clean text; see module docstring.)
    img = ImageOps.grayscale(img)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=3))
    img = img.convert("RGB")

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


# --------------------------------------------------------------------------- #
# Skew detection — projection-profile variance (ported from the SPA's deskew.ts,
# which was numerically validated). Estimate the angle that, when the ink is
# counter-rotated, makes text rows alternate sharply between line and gap (max
# row-sum variance).
# --------------------------------------------------------------------------- #
def _gray_small(img: Image.Image, edge: int = DETECT_EDGE) -> np.ndarray:
    w, h = img.size
    scale = min(1.0, edge / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)
    return np.asarray(img.convert("L"), dtype=np.float32)


def _otsu(gray: np.ndarray) -> float:
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size
    sum_all = float(np.dot(np.arange(256), hist))
    sum_b = 0.0
    w_b = 0.0
    best = 0.0
    thr = 127.0
    for i in range(256):
        w_b += hist[i]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += i * hist[i]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best = between
            thr = float(i)
    return thr


def _profile_variance(xs: np.ndarray, ys: np.ndarray, w: int, h: int, rad: float) -> float:
    cos = np.cos(rad)
    sin = np.sin(rad)
    cx = w / 2.0
    cy = h / 2.0
    ry = (xs - cx) * sin + (ys - cy) * cos + cy
    yi = ry.astype(np.int32)
    valid = (yi >= 0) & (yi < h)
    rows = np.bincount(yi[valid], minlength=h).astype(np.float64)
    return float(rows.var())


def _detect_skew(gray: np.ndarray, max_deg: int = MAX_SKEW_DEG) -> float:
    thr = _otsu(gray)
    # Inclusive (<=): a perfectly bimodal histogram leaves Otsu on the low plateau
    # edge, so ink can equal the threshold; `< thr` would drop every ink pixel.
    ink = gray <= thr
    frac = float(ink.mean())
    if frac < 0.005 or frac > 0.9:
        return 0.0
    ys, xs = np.nonzero(ink)
    xs = xs.astype(np.float64)
    ys = ys.astype(np.float64)
    h, w = gray.shape

    def sweep(lo: float, hi: float, step: float) -> float:
        best_a = 0.0
        best_s = -1.0
        a = lo
        while a <= hi + 1e-9:
            s = _profile_variance(xs, ys, w, h, np.radians(a))
            if s > best_s:
                best_s = s
                best_a = a
            a += step
        return best_a

    coarse = sweep(-max_deg, max_deg, 1.0)
    fine = sweep(max(-max_deg, coarse - 1), min(max_deg, coarse + 1), 0.1)
    return 0.0 if abs(fine) < 0.15 else round(fine, 2)
