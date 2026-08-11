#!/usr/bin/env python3
"""
Knock out the DemoBro logo's off-white JPG plate into a clean transparent PNG.

Pipeline:
  1. Estimate coverage vs paper-white (max channel deficit) — works on textured
     off-white, not only pure #FFFFFF.
  2. Un-composite against white (color decontamination) so anti-aliased edges
     become real ink/blue over transparency instead of milky gray halos.
  3. Snap solid brand paint (blue fill + near-black outlines) back to full
     opacity so we don't "eat" the D or leave the fill semi-transparent.
  4. Soft-kill the near-white plate (and the play-triangle hole).

Requires: pip install pillow numpy
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

WHITE = np.array([255.0, 255.0, 255.0], dtype=np.float64)

# signal = max(255-R, 255-G, 255-B). Textured plate sits around 3–10.
# Below this → fully transparent (plate + play cutout).
TRANSPARENT_MAX = 12.0

# Coverage at/above this is treated as solid paint (full opacity, keep color).
SOLID_MIN = 140.0

# After decontamination, boost restored brand blue / ink even if coverage was mid.
BLUE_BOOST_MIN = 48.0  # signal floor before blue boost
INK_SOFT_KEEP = True  # keep soft alpha on thin anti-aliased ink (no fat black rim)


def remove_white_background(
    rgb: np.ndarray,
    *,
    transparent_max: float = TRANSPARENT_MAX,
    solid_min: float = SOLID_MIN,
    blue_boost_min: float = BLUE_BOOST_MIN,
) -> np.ndarray:
    """Return RGBA uint8 with soft alpha + white-matte decontamination."""
    px = rgb.astype(np.float64)
    # 0 on pure white → 255 on black. Blue accent scores high via the red channel.
    signal = (WHITE - px).max(axis=2)
    optical = np.clip(signal / 255.0, 0.0, 1.0)

    a = optical[..., None]
    safe = np.maximum(a, 1e-6)
    # pixel = fg * a + white * (1 - a)
    fg = np.clip((px - WHITE * (1.0 - a)) / safe, 0.0, 255.0)

    # Prefer original color once coverage is clearly solid (avoids oversaturated push).
    use_original = signal >= solid_min
    color = np.where(use_original[..., None], px, fg)

    alpha = optical.copy()

    # Solid interiors: full opacity.
    alpha = np.where(signal >= solid_min, 1.0, alpha)

    # Restored brand blue (play-D fill) — never leave it glassy.
    blue = (
        (color[:, :, 2] > color[:, :, 0] + 35.0)
        & (color[:, :, 2] > 110.0)
        & (color[:, :, 0] < 140.0)
        & (signal >= blue_boost_min)
    )
    alpha = np.where(blue, 1.0, alpha)
    color = np.where(blue[..., None], np.where(use_original[..., None], px, fg), color)

    # Near-black outline cores → opaque; leave low-coverage fringe soft (anti-alias).
    ink_core = (color.max(axis=2) < 55.0) & (signal >= 70.0)
    alpha = np.where(ink_core, 1.0, alpha)

    if not INK_SOFT_KEEP:
        ink = (color.max(axis=2) < 70.0) & (signal >= transparent_max)
        alpha = np.where(ink, 1.0, alpha)

    # Soft floor on the plate (textured ~248–252 → signal ~3–10).
    alpha = np.where(signal <= transparent_max, 0.0, alpha)

    # Smooth the kill band so we don't hard-clip anti-aliased dust:
    # between transparent_max and transparent_max+10, ease optical down.
    soft_kill = transparent_max + 10.0
    in_kill = (signal > transparent_max) & (signal < soft_kill) & ~blue & ~ink_core
    if np.any(in_kill):
        t = (signal - transparent_max) / (soft_kill - transparent_max)
        alpha = np.where(in_kill, np.minimum(alpha, t * optical), alpha)

    out = np.zeros((rgb.shape[0], rgb.shape[1], 4), dtype=np.float64)
    out[..., :3] = color
    out[..., 3] = alpha * 255.0
    out[alpha <= 0.001] = 0.0
    return np.rint(np.clip(out, 0.0, 255.0)).astype(np.uint8)


def convert(
    src: Path,
    dst: Path,
    *,
    transparent_max: float,
    solid_min: float,
) -> dict[str, float]:
    img = Image.open(src).convert("RGB")
    rgba = remove_white_background(
        np.asarray(img),
        transparent_max=transparent_max,
        solid_min=solid_min,
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(dst, format="PNG", optimize=True)

    alpha = rgba[..., 3].astype(np.float64)
    opaque = alpha == 255
    soft = (alpha > 0) & (alpha < 255)
    return {
        "width": float(rgba.shape[1]),
        "height": float(rgba.shape[0]),
        "fully_transparent": float((alpha == 0).mean()),
        "fully_opaque": float(opaque.mean()),
        "soft_edge": float(soft.mean()),
        "soft_chroma_mean": float(
            (rgba[soft][:, :3].max(axis=1) - rgba[soft][:, :3].min(axis=1)).mean()
        )
        if soft.any()
        else 0.0,
        "opaque_blue_mean_b": float(rgba[opaque & (rgba[:, :, 2] > 180)][:, 2].mean())
        if (opaque & (rgba[:, :, 2] > 180)).any()
        else 0.0,
    }


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--src",
        type=Path,
        default=root / "worker" / "assets" / "demobro-logo.jpg",
    )
    parser.add_argument(
        "--dst",
        type=Path,
        default=root / "public" / "brand" / "demobro-logo.png",
    )
    parser.add_argument("--transparent-max", type=float, default=TRANSPARENT_MAX)
    parser.add_argument("--solid-min", type=float, default=SOLID_MIN)
    args = parser.parse_args()

    stats = convert(
        args.src,
        args.dst,
        transparent_max=args.transparent_max,
        solid_min=args.solid_min,
    )
    print(f"Wrote {args.dst}")
    for key, value in stats.items():
        if key in {"width", "height"}:
            print(f"  {key}: {int(value)}")
        else:
            print(f"  {key}: {value:.4f}")


if __name__ == "__main__":
    main()
