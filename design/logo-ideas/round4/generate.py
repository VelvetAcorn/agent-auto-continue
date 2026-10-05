#!/usr/bin/env python3
"""Round 4 app icon for Agent Auto-Continue: option A ("Gilt leaf") on Altdorfer's crescent.

The owner chose round 3's option A. Round 3 cut its crescent from an auction house photograph
that cannot be shipped, so this round cuts it from Albrecht Altdorfer, "The Battle of Alexander
at Issus" (1529, Alte Pinakothek; public domain, Google Art Project scan via Wikimedia Commons).

The crescent sits at the very top left of the panel, so there is almost no sky above it and the
top rows are discoloured by the frame edge. Before the round 3 pipeline sees the image, the sky
is extended past those edges: the low-frequency colour is carried out by normalised convolution
of the good sky, and the fine paint grain is synthesised with the 2D amplitude spectrum of a
plain patch of Altdorfer's own night sky (random phase, so nothing repeats or mirrors). The two
are feathered into the real pixels. The moon itself is untouched painted pixels.

Everything else (rotation, upscale, paint texture, gilt rim, gold-leaf play head, macOS grid)
is round 3's code, imported from ../round3/generate.py so round 3 stays the record. Round 3's
paint texture is applied at 0.75 strength by default (--texture 1 for round 3's full strength):
at 3.4x the scan already carries real grain, and full strength reads as a filter on the crescent.

Requirements: Pillow, numpy, scipy, scikit-image (install them in a throwaway virtualenv).
Usage, from anywhere:
    python generate.py
Then render the preview from the repository root:
    env -u ELECTRON_RUN_AS_NODE npx electron design/logo-ideas/round4/capture.cjs
"""
import argparse
import importlib.util
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SOURCE = os.path.join(REPO, 'design', 'sources', 'alt-altdorfer-alexanderschlacht-sun-crescent.jpg')

_spec = importlib.util.spec_from_file_location('round3', os.path.join(HERE, '..', 'round3', 'generate.py'))
r3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(r3)
S = r3.S

# Measured on the 4592 x 6000 scan by keying the lit paint (luminance 0.26 to 0.34) and fitting
# circles: the outer limb is centred (226.0, 122.3), radius 97.2 (fractions 0.0492, 0.0204,
# 0.0212 of the width); the terminator circle (r ~99.7) sits ~41 px up and left of it, so the lit
# limb faces 67 degrees (down and a little right, image axes) and the crescent opens up-left.
MOON_CX, MOON_CY, MOON_R, MOON_LIMB = 226.0, 122.3, 97.2, 67.4
# Region of the scan used (the plate never reaches further), and where the reliable sky starts.
CROP = (0, 0, 900, 800)
GOOD_TOP, GOOD_LEFT = 24, 32       # rows above / columns left of these are frame-edge damage
PAD = 280                          # synthesised sky added above and to the left
GRAIN_PATCH = (340, 32, 532, 192)  # plain dark sky beside the moon, inside the vortex
BAND = 20                          # px: coarser than this is colour field, finer is paint grain


def smooth_fill(img, mask, sigma):
    """Normalised convolution: the colour field of the valid pixels, carried smoothly outward."""
    w = ndi.gaussian_filter(mask, sigma)
    num = np.stack([ndi.gaussian_filter(img[..., c] * mask, sigma) for c in range(3)], -1)
    return num / np.maximum(w, 1e-6)[..., None], w


def grain_like(patch, shape, seed):
    """Random-phase noise with the 2D amplitude spectrum and colour covariance of `patch`'s
    high-frequency detail: the same grain, brush direction and speckle, but no copied features."""
    rng = np.random.default_rng(seed)
    det = patch - np.stack([ndi.gaussian_filter(patch[..., c], BAND, mode='reflect') for c in range(3)], -1)
    flat = det.reshape(-1, 3)
    _, evecs = np.linalg.eigh(np.cov(flat.T))
    comps = (flat @ evecs).reshape(det.shape)  # decorrelated colour components
    h, w = shape
    win = np.outer(np.hanning(patch.shape[0]), np.hanning(patch.shape[1]))
    out = np.zeros((h, w, 3))
    for k in range(3):
        amp = np.abs(np.fft.fftshift(np.fft.fft2(comps[..., k] * win)))
        amp = ndi.gaussian_filter(amp, 1.0)
        amp = ndi.zoom(amp, (h / amp.shape[0], w / amp.shape[1]), order=1)[:h, :w]
        amp = np.pad(amp, ((0, h - amp.shape[0]), (0, w - amp.shape[1])), mode='edge')
        phase = np.exp(2j * np.pi * rng.random((h, w)))
        n = np.real(np.fft.ifft2(np.fft.ifftshift(amp * phase)))
        n *= comps[..., k].std() / (n.std() + 1e-12)
        out[..., k] = n
    return (out.reshape(-1, 3) @ evecs.T).reshape(h, w, 3)


def extended_sky(path):
    """The top-left corner of the panel with Altdorfer's sky carried past the top and left edges.
    Returns (rgb float image, offset to add to scan coordinates, mask of the real paint)."""
    full = Image.open(path).convert('RGB')
    arr = np.asarray(full.crop(CROP), float) / 255
    h, w = arr.shape[:2]
    H, W = h + PAD, w + PAD
    canvas = np.zeros((H, W, 3))
    canvas[PAD:, PAD:] = arr
    yy, xx = np.mgrid[0:H, 0:W]
    valid = ((yy >= PAD + GOOD_TOP) & (xx >= PAD + GOOD_LEFT)).astype(float)
    # keep the lit crescent out of the colour field so it does not glow into the new sky
    lum = ndi.gaussian_filter(canvas @ np.array([0.299, 0.587, 0.114]), 2)
    bright = ndi.binary_dilation(lum > 0.26, iterations=10)
    cmask = valid * (1 - bright)
    # low frequencies: a fine and a wide scale, the wide one only where the fine one runs out of
    # support, and the mean sky colour where even the wide one does (beyond what the icon uses)
    near, wn = smooth_fill(canvas, cmask, BAND)
    far, wf = smooth_fill(canvas, cmask, 60)
    mean = (canvas * cmask[..., None]).sum((0, 1)) / cmask.sum()
    far = far * r3.smoothstep(0.0, 0.05, wf)[..., None] + mean * (1 - r3.smoothstep(0.0, 0.05, wf))[..., None]
    t = r3.smoothstep(0.02, 0.25, wn)[..., None]
    low = near * t + far * (1 - t)
    x0, y0, x1, y1 = GRAIN_PATCH
    grain = grain_like(arr[y0:y1, x0:x1], (H, W), seed=1529)
    # feather: distance into the good sky, 0 at its edge, full real paint after 18 px
    a = r3.smoothstep(0, 18, ndi.distance_transform_edt(valid))[..., None]
    # low frequency blends linearly; the grain is renormalised so two independent grains
    # averaged across the join do not lose strength and leave a smooth band
    norm = 1 / np.sqrt(a ** 2 + (1 - a) ** 2)
    out = near * a + low * (1 - a) + ((canvas - near) * a + grain * (1 - a)) * norm
    out = np.where(a >= 1, canvas, out)
    return np.clip(out, 0, 1), (PAD - CROP[0], PAD - CROP[1]), valid


class ExtendedSource(r3.Source):
    """round 3's Source, fed the extended image instead of a file."""

    def __init__(self, path, cx, cy, r, limb):
        rgb, (ox, oy), self.valid = extended_sky(path)
        self.path, self.cx, self.cy, self.r, self.limb = path, cx + ox, cy + oy, r, limb
        img = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), 'RGB')
        self.raw_extended = img
        ycc = img.convert('YCbCr').split()
        soft = [Image.fromarray(ndi.gaussian_filter(np.asarray(c, float), 1.1).clip(0, 255).astype(np.uint8))
                for c in ycc[1:]]
        self.img = Image.merge('YCbCr', (ycc[0], *soft)).convert('RGB')
        self._cache = {}


def join_overlay(src, center, radius, target_dir=180.0):
    """Where the synthesised sky lands in an output plate (1 = synthesised), for the notes."""
    scale = radius / src.r
    a = math.radians(target_dir - src.limb)
    c, s = math.cos(a) / scale, math.sin(a) / scale
    px, py = r3.XX - 0.5 - center[0], r3.YY - 0.5 - center[1]
    qx = c * px + s * py + src.cx
    qy = -s * px + c * py + src.cy
    return 1 - ndi.map_coordinates(src.valid, [qy, qx], order=1, mode='constant', cval=0)


# Altdorfer's sky is Prussian blue. 'green' regrades the painted moon and sky to the deep green of the chosen
# round 3 design by mapping each pixel's lightness onto a green ramp, so the brushwork and grain are kept and only
# the hue moves. The gilt rim and play head are laid on afterwards and are not affected.
GREEN_RAMP = np.array([
    # lightness, then the colour it becomes
    [0.00, 0.020, 0.060, 0.050],
    [0.12, 0.050, 0.140, 0.118],
    [0.26, 0.105, 0.235, 0.195],
    [0.38, 0.430, 0.560, 0.450],
    [0.50, 0.760, 0.830, 0.690],
    [0.62, 0.880, 0.920, 0.800],
    [1.00, 0.960, 0.975, 0.900],
])


def green(rgb):
    luma = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    return np.stack([np.interp(luma, GREEN_RAMP[:, 0], GREEN_RAMP[:, i]) for i in (1, 2, 3)], axis=-1)


def build(src, outdir, texture_amount, tone=green):
    tex = r3.Texture()

    def plate(cx, cy, r):
        return tone(tex.apply(src.plate((cx, cy), r), (cx, cy, r), texture_amount))

    # moon.png: geometry of assets/icon.svg (outer circle centre 130,128 r 100 of 256), as round 3
    MC, MR = (520.0, 512.0), 400.0
    r3.compose('moon', plate(*MC, MR), np.ones((S, S)), outdir)

    # A. Gilt leaf: exactly round 3's composition
    squircle = r3.sd_round_rect(512, 512, 412, 185)
    m = (512.0, 512.0, 330.0)
    rgb = plate(*m)
    a = r3.cover(squircle)
    rgb = rgb * r3.sight_shadow(squircle + 22)[..., None]
    rc, ra = r3.gilt_moulding(squircle, 22, seed=2)
    rgb, a = r3.over(rgb, a, rc, ra)
    rgb, a = r3.put_mark(rgb, a, r3.mark_gilt_leaf(r3.play_triangle(*m)), (7, 9, 0.6))
    r3.compose('icon-1024', *r3.finish(rgb, a), outdir)

    # how much of the visible sky is synthesised (inside the rim's sight edge)
    syn = join_overlay(src, m[:2], m[2])
    sight = r3.cover(squircle + 22)
    frac = float((syn * sight).sum() / sight.sum())
    return frac, syn


PREVIEW_SIZES = (512, 256, 128, 64, 32, 16)


def write_preview_html(outdir, note):
    icon = Image.open(os.path.join(outdir, 'icon-1024.png')).convert('RGBA')
    old = Image.open(os.path.join(HERE, '..', 'round3', 'a-gilt-leaf.png')).convert('RGBA')
    u = {n: r3.png_data_uri(r3.downscale(icon, n)) for n in PREVIEW_SIZES}
    old256 = r3.png_data_uri(r3.downscale(old, 256))
    new256 = u[256]

    def row(cls):
        big = f'<img src="{u[512]}" width="512" height="512">'
        rest = ''.join(f'<img src="{u[n]}" width="{n}" height="{n}">' for n in PREVIEW_SIZES[1:])
        return f'<div class="tile {cls}"><div class="big">{big}</div><div class="rest">{rest}</div></div>'

    html = f'''<!doctype html>
<html><head><meta charset="utf-8">
<title>Agent Auto-Continue - app icon, round 4</title>
<style>
  html,body{{margin:0;background:#2a221d;color:#F0E7D3}}
  body{{width:1800px;padding:40px;box-sizing:border-box;font-family:'Cormorant Garamond',Georgia,serif}}
  h1{{font-style:italic;font-weight:700;font-size:38px;margin:0 0 4px}}
  .sub{{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#D3AC5A;margin:0 0 26px;font-family:Georgia,serif}}
  .tiles{{display:flex;gap:24px}}
  .tile{{flex:1;border-radius:6px;padding:28px 24px 34px;display:flex;flex-direction:column;align-items:center;gap:28px}}
  .tile.dark{{background:#1f1a17}}
  .tile.light{{background:#EFE7D6}}
  .rest{{display:flex;align-items:center;gap:26px}}
  .cmp{{display:flex;gap:24px;margin-top:24px}}
  .cmp figure{{margin:0;background:#171210;border:1px solid #7D5D24;border-radius:6px;padding:16px}}
  .cmp .pair{{display:flex;gap:12px}}
  .cmp .pair div{{width:256px;height:256px;display:flex;align-items:center;justify-content:center;border-radius:3px}}
  figcaption{{margin-top:10px;font-size:18px;color:#d9cfb9}}
  figcaption b{{color:#F3DFA0;font-family:Georgia,serif;letter-spacing:1px;font-size:15px;text-transform:uppercase;margin-right:8px}}
  .note{{flex:1;margin:0 0 0 8px;font-size:18px;line-height:1.35;color:#d9cfb9;align-self:center}}
</style></head>
<body>
  <h1>Agent Auto-Continue - app icon, round 4</h1>
  <p class="sub">Option A, gilt leaf, on Altdorfer's crescent - 512, 256, 128, 64, 32 and 16 px on dark and light</p>
  <div class="tiles">{row('dark')}{row('light')}</div>
  <div class="cmp">
    <figure><div class="pair"><div style="background:#1f1a17"><img src="{new256}" width="256" height="256"></div>
      <div style="background:#EFE7D6"><img src="{new256}" width="256" height="256"></div></div>
      <figcaption><b>Round 4</b>Altdorfer, Battle of Alexander at Issus, 1529</figcaption></figure>
    <figure><div class="pair"><div style="background:#1f1a17"><img src="{old256}" width="256" height="256"></div>
      <div style="background:#EFE7D6"><img src="{old256}" width="256" height="256"></div></div>
      <figcaption><b>Round 3 A</b>for comparison (auction photograph, not shippable)</figcaption></figure>
    <p class="note">{note}</p>
  </div>
</body></html>
'''
    with open(os.path.join(outdir, 'preview.html'), 'w') as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--source', default=SOURCE)
    ap.add_argument('--texture', type=float, default=0.75,
                    help='strength of round 3 paint texture (1 = round 3; the scan has real grain of its own)')
    ap.add_argument('--out', default=HERE)
    ap.add_argument('--tone', choices=('green', 'blue'), default='green',
                    help="'green' regrades the sky and moon (the shipped icon); 'blue' keeps Altdorfer's own colour")
    ap.add_argument('--debug', action='store_true', help='also write the extended sky and join map')
    args = ap.parse_args()
    src = ExtendedSource(args.source, MOON_CX, MOON_CY, MOON_R, MOON_LIMB)
    frac, syn = build(src, args.out, args.texture, tone=green if args.tone == 'green' else (lambda rgb: rgb))
    if args.debug:
        src.raw_extended.save(os.path.join(args.out, 'debug-extended-sky.png'))
        Image.fromarray((syn * 255).astype(np.uint8)).save(os.path.join(args.out, 'debug-join.png'))
    note = ("The moon is the painting's own pixels, rotated so the lit limb faces left and upscaled "
            f"about {330 / MOON_R:.1f}x from a disc {2 * MOON_R:.0f} px across. Altdorfer's sky "
            f"stops just above the moon, so {frac * 100:.0f}% of the visible sky (a band across "
            "the lower right corner) is synthesised from the painting's own sky colour and grain.")
    write_preview_html(args.out, note)
    print(f'synthesised share of visible sky: {frac:.3f}')
    print('wrote moon.png, icon-1024.png and preview.html to', args.out)


if __name__ == '__main__':
    main()
