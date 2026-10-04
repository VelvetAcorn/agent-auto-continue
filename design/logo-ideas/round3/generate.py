#!/usr/bin/env python3
"""Round 3 logo iterations for Agent Auto-Continue: the painted crescent from a real portrait.

The moon and its sky are the painting's own pixels: cropped, rotated so the lit limb sits on the
left and the crescent opens to the right (the arrangement of assets/icon.svg), upscaled with
Lanczos, then given canvas weave, paint grain and craquelure so the softness reads as paint.
The play marks, gilt rims and seals are drawn procedurally and composited over the raster.

Requirements: Pillow, numpy, scipy, scikit-image (install them in a throwaway virtualenv).
Usage, from anywhere:
    python generate.py                       # default source and moon position
    python generate.py --source big.jpg --cx 1484 --cy 812 --r 174 --limb 44
The moon position is in source pixels: (cx, cy) is the centre of the whole lunar disc, r its
radius, limb the direction the lit limb faces in degrees (0 = right, 90 = down, image axes).
Then render the contact sheet from the repository root:
    env -u ELECTRON_RUN_AS_NODE npx electron design/logo-ideas/round3/capture.cjs
"""
import argparse
import math
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.restoration import denoise_tv_chambolle

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SOURCE = os.path.expanduser(
    '~/.t3/userdata/attachments/0b270089-5b5d-4eb9-be57-831def5cbd45-77b19573-71aa-42ba-afb0-868c13334ceb.jpg')
S = 1024  # output size


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float) / 255


GILT_HI, GILT, GILT_MID, GILT_LO = map(hexrgb, ('#F3DFA0', '#D3AC5A', '#B08A3C', '#7D5D24'))
LEAD_WHITE = hexrgb('#F0E7D3')
UMBER = hexrgb('#171210')
RED_GROUND = hexrgb('#4A1A0E')
PRUSSIAN = hexrgb('#27405F')
VERMILION = hexrgb('#B72E12')

YY, XX = np.mgrid[0:S, 0:S].astype(float) + 0.5


# ----------------------------------------------------------------------------------------------
# small helpers

def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def cover(sdf, soft=1.0):
    """Antialiased coverage of the inside (sdf < 0) of a signed distance field."""
    return np.clip(0.5 - sdf / soft, 0, 1)


def over(dst_rgb, dst_a, src_rgb, src_a):
    """Porter-Duff source-over on straight-alpha float images."""
    src_a = src_a[..., None]
    da = dst_a[..., None]
    out_a = src_a + da * (1 - src_a)
    out = (src_rgb * src_a + dst_rgb * da * (1 - src_a)) / np.maximum(out_a, 1e-6)
    return out, out_a[..., 0]


def noise(shape, sigma, seed, octaves=1):
    """Smooth value noise in [-1, 1] made by blurring white noise."""
    rng = np.random.default_rng(seed)
    acc = np.zeros(shape)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = ndi.gaussian_filter(rng.standard_normal(shape), np.asarray(sigma, float) / (2 ** o), mode='wrap')
        n /= n.std() + 1e-9
        acc += amp * n
        tot += amp
        amp *= 0.5
    return np.clip(acc / tot / 2.2, -1, 1)


def ramp(t, stops):
    """Map t in [0, 1] through a list of (position, rgb) colour stops."""
    t = np.clip(t, 0, 1)
    pos = np.array([p for p, _ in stops])
    cols = np.array([c for _, c in stops])
    return np.stack([np.interp(t, pos, cols[:, k]) for k in range(3)], -1)


GILT_RAMP = [(0.0, hexrgb('#3A2810')), (0.22, GILT_LO), (0.45, GILT_MID), (0.68, GILT),
             (0.86, GILT_HI), (1.0, hexrgb('#FFF7DC'))]
WAX_RAMP = [(0.0, hexrgb('#2A0602')), (0.3, hexrgb('#5E1005')), (0.55, hexrgb('#8E1E0A')),
            (0.75, VERMILION), (0.92, hexrgb('#D9583A')), (1.0, hexrgb('#F08C6A'))]

LIGHT = np.array([-0.55, -0.7, 0.75])
LIGHT /= np.linalg.norm(LIGHT)


def shade(height, strength=1.0):
    """Lambert and Blinn terms for a height field lit from the upper left."""
    gy, gx = np.gradient(height)
    n = np.stack([-gx * strength, -gy * strength, np.ones_like(height)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    diff = np.clip((n * LIGHT).sum(-1), 0, 1)
    half = LIGHT + np.array([0, 0, 1.0])
    half /= np.linalg.norm(half)
    spec = np.clip((n * half).sum(-1), 0, 1)
    return diff, spec, n


def flat_diff():
    return LIGHT[2]  # Lambert term of an unbent surface


# ----------------------------------------------------------------------------------------------
# signed distance fields (pixels, negative inside)

def sd_circle(cx, cy, r):
    return np.hypot(XX - cx, YY - cy) - r


def sd_ellipse(cx, cy, rx, ry):
    # first-order distance to an ellipse: f / |grad f|
    u, v = (XX - cx) / rx, (YY - cy) / ry
    f = np.sqrt(u * u + v * v)
    g = np.sqrt((u / rx) ** 2 + (v / ry) ** 2) / np.maximum(f, 1e-9)
    return (f - 1) / np.maximum(g, 1e-9)


def sd_round_rect(cx, cy, half, rad):
    """macOS app icon tile: a rounded square (824 px on the 1024 grid, corner radius ~185)."""
    qx = np.abs(XX - cx) - (half - rad)
    qy = np.abs(YY - cy) - (half - rad)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rad


def sd_poly(verts, x=None, y=None):
    x = XX if x is None else x
    y = YY if y is None else y
    d = np.full(x.shape, np.inf)
    s = np.ones(x.shape)
    n = len(verts)
    for i in range(n):
        (xi, yi), (xj, yj) = verts[i], verts[i - 1]
        ex, ey = xj - xi, yj - yi
        wx, wy = x - xi, y - yi
        t = np.clip((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
        bx, by = wx - ex * t, wy - ey * t
        d = np.minimum(d, bx * bx + by * by)
        c1, c2, c3 = y >= yi, y < yj, ex * wy > ey * wx
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
    return s * np.sqrt(d)


# ----------------------------------------------------------------------------------------------
# the painted plate: the real moon and sky, rotated, upscaled and given paint texture

class Source:
    def __init__(self, path, cx, cy, r, limb):
        self.path, self.cx, self.cy, self.r, self.limb = path, cx, cy, r, limb
        img = Image.open(path).convert('RGB')
        # JPEG chroma blocks would be magnified ten times, so soften chroma only; luma stays.
        y, cb, cr = img.convert('YCbCr').split()
        cb = Image.fromarray(ndi.gaussian_filter(np.asarray(cb, float), 1.1).clip(0, 255).astype(np.uint8))
        cr = Image.fromarray(ndi.gaussian_filter(np.asarray(cr, float), 1.1).clip(0, 255).astype(np.uint8))
        self.img = Image.merge('YCbCr', (y, cb, cr)).convert('RGB')
        self._cache = {}

    def plate(self, center, radius, target_dir=180.0):
        """1024 px RGB float of the sky with the moon disc at `center`, `radius` px,
        rotated so the lit limb faces `target_dir` degrees (180 = left)."""
        key = (center, radius, target_dir)
        if key in self._cache:
            return self._cache[key]
        scale = radius / self.r
        rot = target_dir - self.limb  # degrees, image axes (clockwise on screen)
        # Crop generously around the moon (enough for any rotation of the output square).
        need = (S * math.sqrt(2)) / scale / 2 + 6
        far = math.hypot(center[0] - S / 2, center[1] - S / 2) / scale
        half = int(math.ceil(need + far))
        box = (int(self.cx) - half, int(self.cy) - half, int(self.cx) + half + 1, int(self.cy) + half + 1)
        # pad by edge replication so a moon near the border of a scan never pulls in black
        full = np.pad(np.asarray(self.img, float) / 255, ((half, half), (half, half), (0, 0)), mode='edge')
        crop = full[box[1] + half:box[3] + half, box[0] + half:box[2] + half]
        # Upscale in 2x steps (Lanczos), each followed by a light total-variation pass. One big
        # Lanczos jump shows the source pixel grid as ripples; this keeps edges clean and smooth.
        big, k = crop, 1
        while k * 2 <= scale * 1.05:
            big = resize_float(big, 2)
            big = denoise_tv_chambolle(big, weight=0.025, channel_axis=-1)
            k *= 2
        # Map output pixel -> big image pixel: q = M (p - center) + moon_in_big (cubic spline).
        mbx = (self.cx - box[0]) * k + (k - 1) / 2
        mby = (self.cy - box[1]) * k + (k - 1) / 2
        a = math.radians(rot)
        f = k / scale
        c, s = math.cos(a) * f, math.sin(a) * f
        px, py = XX - 0.5 - center[0], YY - 0.5 - center[1]
        qx = c * px + s * py + mbx
        qy = -s * px + c * py + mby
        rgb = np.stack([ndi.map_coordinates(big[..., ch], [qy, qx], order=3, mode='nearest')
                        for ch in range(3)], -1)
        rgb = self._sharpen(np.clip(rgb, 0, 1), scale)
        self._cache[key] = rgb
        return rgb

    @staticmethod
    def _sharpen(rgb, scale):
        # Recover a little edge definition lost to the upscale (luma only, wide radius, gentle).
        lum = rgb @ np.array([0.299, 0.587, 0.114])
        detail = lum - ndi.gaussian_filter(lum, scale * 0.7)
        return np.clip(rgb + 0.35 * detail[..., None], 0, 1)


def resize_float(arr, f):
    h, w = arr.shape[:2]
    return np.stack([np.asarray(Image.fromarray(arr[..., c].astype(np.float32), 'F')
                                .resize((w * f, h * f), Image.LANCZOS)) for c in range(arr.shape[2])], -1)


def craquelure(seed, cell=74, warp=10.0):
    """Returns (crack, lip): crack in [0, 1] where paint has split, lip a one-sided highlight."""
    rng = np.random.default_rng(seed)
    n = int(S / cell) + 3
    gy, gx = np.mgrid[-1:n - 1, -1:n - 1].astype(float)
    pts = np.c_[(gx.ravel() + rng.random(gx.size)) * cell, (gy.ravel() + rng.random(gy.size)) * cell]
    # anisotropic: real craquelure on canvas tends to run in one direction a little
    pts[:, 1] *= 0.86
    tree = cKDTree(pts)
    wx = XX + warp * noise((S, S), 22, seed + 1) + 3 * noise((S, S), 5, seed + 2)
    wy = (YY + warp * noise((S, S), 22, seed + 3) + 3 * noise((S, S), 5, seed + 4)) * 0.86
    d, _ = tree.query(np.c_[wx.ravel(), wy.ravel()], k=2)
    edge = ((d[:, 1] - d[:, 0]) / 2).reshape(S, S)
    width = 0.3 + 0.3 * (noise((S, S), 30, seed + 5) + 1)
    crack = 1 - smoothstep(0.0, width, edge)
    # some cracks fade out entirely, as they do on a real surface
    crack *= smoothstep(-0.55, 0.1, noise((S, S), 40, seed + 6))
    # a raised lip on the lit side of each crack catches light
    lip = np.clip(ndi.shift(crack, (1.4, 1.4), order=1) - crack, 0, 1)
    return crack, lip


def canvas_weave(seed, period=5.2):
    rng = np.random.default_rng(seed)
    jx = 1.6 * noise((S, S), 40, seed + 10)
    jy = 1.6 * noise((S, S), 40, seed + 11)
    tx = 2 * math.pi * (XX + jx) / period
    ty = 2 * math.pi * (YY + jy) / period
    thick_x = 1 + 0.35 * ndi.gaussian_filter1d(rng.standard_normal(S), 3)[None, :]
    thick_y = 1 + 0.35 * ndi.gaussian_filter1d(rng.standard_normal(S), 3)[:, None]
    h = np.sin(tx) * np.sin(ty) * 0.5 + 0.25 * thick_x * np.cos(tx) ** 2 + 0.25 * thick_y * np.cos(ty) ** 2
    return h


def lic(theta, seed, length=14, sigma=0.7):
    """Line integral convolution of white noise along the orientation field theta: brush streaks."""
    rng = np.random.default_rng(seed)
    wn = ndi.gaussian_filter(rng.standard_normal((S, S)), sigma)
    dx, dy = np.cos(theta), np.sin(theta)
    acc = wn.copy()
    for sgn in (1, -1):
        x, y = XX - 0.5, YY - 0.5
        for i in range(length):
            x = x + sgn * dx
            y = y + sgn * dy
            w = 1 - i / length
            acc += w * ndi.map_coordinates(wn, [y, x], order=1, mode='wrap')
    acc /= acc.std() + 1e-9
    return acc


class Texture:
    """Paint surface: canvas weave, brush streaks, fine grain, craquelure. Shared by all iterations."""

    def __init__(self, seed=7):
        self.seed = seed
        self.crack, self.lip = craquelure(seed, cell=96, warp=12)
        self.crack2, _ = craquelure(seed + 50, cell=38, warp=6)
        self.weave = canvas_weave(seed + 20)
        self.grain = noise((S, S), 0.8, seed + 30)
        wd, _, _ = shade(self.weave * 0.9)
        self.weave_light = wd / flat_diff()
        # sky strokes: blended, wandering directions
        self.sky_theta = math.pi * noise((S, S), 140, seed + 40) * 0.9 + 0.4
        self._lic_cache = {}

    def strokes(self, moon, lit):
        if moon in self._lic_cache:
            return self._lic_cache[moon]
        cx, cy, r = moon
        tangent = np.arctan2(YY - cy, XX - cx) + math.pi / 2
        # the lit crescent was painted with strokes following its curve; elsewhere blended strokes
        near = ndi.gaussian_filter(lit, r * 0.03)
        vx = (1 - near) * np.cos(2 * self.sky_theta) + near * np.cos(2 * tangent)
        vy = (1 - near) * np.sin(2 * self.sky_theta) + near * np.sin(2 * tangent)
        theta = np.arctan2(vy, vx) / 2
        st = lic(theta, self.seed + 41, length=int(6 + r / 50))
        self._lic_cache[moon] = st
        return st

    def apply(self, rgb, moon, amount=1.0):
        lum = (rgb @ np.array([0.299, 0.587, 0.114]))[..., None]
        lit = smoothstep(0.30, 0.50, lum[..., 0])
        st = self.strokes(moon, lit)[..., None]
        # brush streaks show more in the light paint, as they do in the painting's crescent
        out = rgb * (1 + st * (0.008 + 0.06 * lum) * amount)
        sd, _, _ = shade(ndi.gaussian_filter(st[..., 0], 1.0) * 0.6)
        out = out * (1 + (sd / flat_diff() - 1)[..., None] * 0.12 * lum * amount)
        out = out * (1 + (self.weave_light[..., None] - 1) * 0.07 * amount)
        out = out + self.grain[..., None] * 0.008 * amount
        # craquelure: hairline gaps that read on the light paint and barely on the dark sky
        c = np.maximum(self.crack, 0.5 * self.crack2)[..., None]
        depth = (0.05 + 0.42 * lum ** 1.3) * amount
        out = out * (1 - depth * c) + self.lip[..., None] * 0.035 * amount * lum
        return np.clip(out, 0, 1)


# ----------------------------------------------------------------------------------------------
# geometry shared by the marks: the play triangle sits where assets/icon.svg puts it

def play_triangle(cx, cy, r, size=1.0, dx=0.0):
    """Vertices of the play head in the hollow of a moon disc centred (cx, cy), radius r.
    assets/icon.svg: outer circle centre (130, 128) r 100, play head x 119.76..191.76, y 92..164."""
    left = cx + (-0.1024 + dx) * r
    w = 0.72 * r * size
    h = 0.72 * r * size
    left = left + (0.72 * r - w) * 0.4  # keep a resized head roughly centred on the same spot
    return [(left, cy - h / 2), (left + w, cy), (left, cy + h / 2)]


def gilt_surface(height, strength, mask_noise_seed=3, leaf=None, rub=None):
    """Gold shaded from a height field; `leaf` adds visible gold-leaf squares."""
    diff, spec, n = shade(height, strength)
    t = 0.18 + 0.62 * diff
    if leaf is not None:
        t = t + leaf
    t = t + 0.035 * noise((S, S), 1.2, mask_noise_seed)
    col = ramp(t, GILT_RAMP)
    col = col + (spec ** 40)[..., None] * np.array([1.0, 0.95, 0.8]) * 0.55
    if rub is not None:  # rubbed high points let the red bole underneath show through
        col = col * (1 - rub[..., None]) + hexrgb('#7A2E16')[None, None] * rub[..., None] * (0.6 + 0.4 * diff[..., None])
    return np.clip(col, 0, 1)


def gold_leaf(seed, size=82, angle=8):
    rng = np.random.default_rng(seed)
    a = math.radians(angle)
    u = XX * math.cos(a) + YY * math.sin(a)
    v = -XX * math.sin(a) + YY * math.cos(a)
    iu = np.floor(u / size)
    iv = np.floor(v / size + 0.37 * iu)  # leaves in staggered courses, like real laying
    h = (iu * 73856093 + iv * 19349663) % 1009
    tone = (rng.random(1009)[h.astype(int)] - 0.5) * 0.12
    fu = u / size - iu
    fv = v / size + 0.37 * iu - iv
    seam = np.minimum.reduce([fu, 1 - fu, fv, 1 - fv]) * size
    seam_line = (1 - smoothstep(0.5, 2.2, seam)) * 0.07
    streak = 0.05 * ndi.gaussian_filter(np.random.default_rng(seed + 1).standard_normal((S, S)), (0.6, 9))
    return tone + seam_line + streak


# ----------------------------------------------------------------------------------------------
# frames and outer shapes

def gilt_moulding(sd_outer, width, seed=1, beads=None):
    """A carved gilt rim between sd_outer = 0 and sd_outer = -width, returned as (rgb, alpha).
    Beads, if given as (count, position across the rim), are spaced round the canvas centre."""
    t = np.clip(-sd_outer / width, 0, 1)  # 0 at outside edge, 1 at sight edge
    # profile: outer fillet, wide cove, raised torus, inner sight bead
    prof = (0.25 * smoothstep(0.0, 0.08, t)
            + 0.55 * np.exp(-((t - 0.40) / 0.17) ** 2)
            - 0.10 * np.exp(-((t - 0.70) / 0.06) ** 2)
            + 0.35 * np.exp(-((t - 0.86) / 0.07) ** 2)
            - 0.25 * smoothstep(0.95, 1.0, t))
    height = prof * width * 0.55
    if beads is not None:
        count, at = beads
        ang = np.arctan2(YY - S / 2, XX - S / 2)
        ph = (ang / (2 * math.pi) * count) % 1.0
        bead = np.clip(1 - ((ph - 0.5) / 0.42) ** 2 - ((t - at) / 0.075) ** 2, 0, 1)
        height = height + np.sqrt(bead) * width * 0.16
    rub = np.clip((noise((S, S), 6, seed + 9) - 0.35) * 2.2, 0, 1) * smoothstep(0.55, 0.9, prof) * 0.55
    col = gilt_surface(height, 1.0, seed, rub=rub)
    alpha = cover(sd_outer) * (1 - cover(sd_outer + width))
    return col, alpha


def drop_shadow(alpha, blur=18, dy=14, opacity=0.45):
    sh = ndi.shift(ndi.gaussian_filter(alpha, blur), (dy, 0), order=1)
    return sh * opacity


# ----------------------------------------------------------------------------------------------
# play marks. Each returns (rgb, alpha) to composite over the plate.

def mark_gilt_leaf(tri, seed=11):
    """Gold leaf over a gesso cushion: flat face, softly rounded edge."""
    rounding = 12
    sd = sd_poly(shrink(tri, rounding)) - rounding
    inside = np.clip(-sd, 0, None)
    x = np.clip(inside / 22, 0, 1)
    height = 16 * np.sqrt(1 - (1 - x) ** 2)  # quarter-round edge, then flat
    height = ndi.gaussian_filter(height, 1.2)
    p = np.array(tri)
    c = p.mean(0)
    span = np.linalg.norm(p[1] - p[0])
    # burnished leaf mirrors its surroundings: a broad light sweep from upper left to lower right
    sweep = ((XX - c[0]) * -0.6 + (YY - c[1]) * -0.8) / span
    leaf = gold_leaf(seed) + 0.16 * np.tanh(sweep * 2.2) - 0.02
    col = gilt_surface(height, 1.0, seed, leaf=leaf)
    return col, cover(sd)


def shrink(tri, d):
    """Inset a triangle by d px along its edge normals (for rounded corners)."""
    p = np.array(tri, float)
    out = []
    for i in range(3):
        a, b, e = p[i], p[i - 1], p[(i + 1) % 3]
        u, v = (b - a) / np.linalg.norm(b - a), (e - a) / np.linalg.norm(e - a)
        half = math.acos(np.clip(np.dot(u, v), -1, 1)) / 2
        bis = (u + v) / np.linalg.norm(u + v)
        out.append(tuple(a + bis * d / math.sin(half)))
    return out


def brush_stroke(p0, p1, width, seed, dry=0.7):
    """One straight stroke of a loaded flat brush from p0 to p1.
    Returns (alpha, height, along) where along runs 0..1 from p0 to p1."""
    rng = np.random.default_rng(seed)
    p0, p1 = np.array(p0, float), np.array(p1, float)
    L = np.linalg.norm(p1 - p0)
    d = (p1 - p0) / L
    nrm = np.array([-d[1], d[0]])
    wx, wy = XX - p0[0], YY - p0[1]
    s = (wx * d[0] + wy * d[1]) / L                      # along, 0..1
    t = (wx * nrm[0] + wy * nrm[1]) / (width / 2)        # across, -1..1
    t = t + 0.06 * np.sin(s * 3.2 + rng.random() * 6) + 0.025 * noise((S, S), 24, seed)
    # bristles: a fixed comb of streaks across the brush, wobbling slightly along the stroke
    fine = ndi.gaussian_filter1d(rng.standard_normal(2048), 2.5)
    broad = ndi.gaussian_filter1d(rng.standard_normal(2048), 40)
    comb = fine / fine.std() * 0.6 + broad / broad.std() * 0.5
    comb = (comb - comb.min()) / (comb.max() - comb.min())
    idx = np.clip((t + 1.3) / 2.6 * 2047, 0, 2047).astype(int)
    bristle = comb[idx]
    # body: square-ish flat brush end at the start, ragged sides, dry-brush breakup at the end
    side = smoothstep(1.02, 0.80 - 0.25 * bristle, np.abs(t))
    start = smoothstep(-0.015, 0.035, s + 0.02 * (bristle - 0.5))
    end_reach = 1.0 + 0.05 * (bristle - 0.5)
    tail = smoothstep(end_reach, end_reach - 0.10, s)
    run_out = np.clip((s - dry) / (1.0 - dry), 0, 1)
    load = smoothstep(0.0, 0.25, bristle + 0.55 - 0.9 * run_out)
    alpha = np.clip(side * start * tail * load, 0, 1)
    # impasto: bristle ridges, a ridge of paint pushed to each side, a blob where the brush landed
    height = alpha * (1.3 * bristle
                      + 2.4 * smoothstep(0.55, 0.95, np.abs(t))
                      + 5.0 * np.exp(-((s - 0.02) / 0.05) ** 2))
    return alpha, height, s


def mark_strokes(tri, seed=21):
    """Lead white laid in as three visible brushstrokes: down the back, then into the tip twice."""
    p = np.array(tri, float)
    top, tip, bot = p
    sd = sd_poly(tri)
    # inradius sets a brush wide enough that three strokes along the edges cover the face
    a_, b_, c_ = (np.linalg.norm(p[i] - p[i - 1]) for i in range(3))
    u, v = tip - top, bot - top
    area = abs(u[0] * v[1] - u[1] * v[0]) / 2
    rin = 2 * area / (a_ + b_ + c_)
    w = rin * 1.55
    def inward(q0, q1, off):
        e = (q1 - q0) / np.linalg.norm(q1 - q0)
        n = np.array([-e[1], e[0]])
        cen = p.mean(0)
        if np.dot(cen - q0, n) < 0:
            n = -n
        return q0 + n * off, q1 + n * off
    strokes = [
        (*inward(top + np.array([0, -14]), bot + np.array([0, 10]), w * 0.42), 0.80),   # down the back
        (*inward(top + np.array([-12, -4]), tip + np.array([18, 0]), w * 0.40), 0.62),  # top edge into the tip
        (*inward(bot + np.array([-12, 4]), tip + np.array([18, 0]), w * 0.40), 0.58),   # bottom edge into the tip
    ]
    alpha = np.zeros((S, S))
    height = np.zeros((S, S))
    col = np.zeros((S, S, 3))
    tints = [np.array([-0.07, -0.07, -0.08]), np.array([0.02, 0.01, -0.03]), np.array([-0.035, -0.03, -0.03])]
    # the strokes may run a few px past the ideal outline where the brush landed or lifted
    rough = 3.0 * noise((S, S), 10, seed + 91) + 2.0 * noise((S, S), 2.5, seed + 92)
    clip = cover(sd - 5 + rough, 2.2)
    for k, (q0, q1, dry) in enumerate(strokes):
        ak, hk, _ = brush_stroke(q0, q1, w, seed + 7 * k, dry)
        ak = ak * clip
        ck = np.broadcast_to(np.clip(LEAD_WHITE + tints[k], 0, 1), (S, S, 3))
        col, alpha_new = over(col, alpha, ck, ak)
        # a later stroke drags over the earlier paint: heights replace where it is loaded
        height = height * (1 - ak) + (hk * clip + 1.5 * alpha) * ak
        alpha = alpha_new
    diff, spec, _ = shade(ndi.gaussian_filter(height, 0.7), 1.6)
    light = 0.97 + 0.42 * (diff / flat_diff() - 1)
    col = col * light[..., None] + (spec ** 24)[..., None] * 0.12
    return np.clip(col, 0, 1), np.clip(alpha, 0, 1)


def mark_bare_ground(tri, texture, seed=31):
    """The sky paint left off: the red-brown ground shows, with a gilt fillet along the edge."""
    sd = sd_poly(shrink(tri, 6)) - 6
    g = RED_GROUND[None, None] * (1 + 0.14 * noise((S, S), 14, seed) + 0.06 * noise((S, S), 2, seed + 1))[..., None]
    g = g * (1 + (texture.weave_light[..., None] - 1) * 0.9)
    # a few drags of the brush crossed into the reserve
    drag = np.clip(noise((S, S), (2, 30), seed + 2) - 0.45, 0, 1) * 0.6
    g = g * (1 - drag[..., None]) + np.array([0.10, 0.19, 0.18]) * drag[..., None]
    inside = np.clip(-sd, 0, None)
    g = g * (0.65 + 0.35 * smoothstep(6, 30, inside))[..., None]
    fillet = 17.0
    mid = sd + fillet / 2 - 1
    prof = np.clip(1 - np.abs(mid) / (fillet / 2), 0, 1)
    height = 10 * np.sqrt(prof)
    gilt = gilt_surface(height, 1.3, seed + 3)
    ga = cover(np.abs(mid) - fillet / 2)
    col = g * (1 - ga[..., None]) + gilt * ga[..., None]
    return np.clip(col, 0, 1), cover(sd - 1)


def mark_wax_seal(tri, seed=41):
    """A soft, rounded triangle of sealing wax with a play head stamped into it."""
    rnd = 44
    base = sd_poly(shrink(tri, rnd)) - rnd
    sd = base - 12 + 7 * noise((S, S), 34, seed) + 2 * noise((S, S), 14, seed + 1)
    inside = np.clip(-sd, 0, None)
    dome = 16 * np.sqrt(1 - (1 - np.clip(inside / 34, 0, 1)) ** 2) + 3 * smoothstep(30, 90, inside)
    # the stamp: a recessed play head, with the wax it displaced rising round it
    p = np.array(tri)
    c = p.mean(0) + np.array([4, 0])
    inner = [tuple(c + (q - c) * 0.52) for q in p]
    isd = sd_poly(shrink(inner, 9)) - 9
    isd = isd + 1.5 * noise((S, S), 20, seed + 4)
    recess = 9 * smoothstep(3, -6, isd)
    swell = 4 * np.exp(-((isd - 9) / 7) ** 2)
    height = ndi.gaussian_filter(dome - recess + swell, 1.2)
    diff, spec, _ = shade(height, 1.3)
    t = 0.68 + 0.95 * (diff / flat_diff() - 1) + 0.03 * noise((S, S), 2, seed + 3)
    t = t - 0.10 * smoothstep(2, -6, isd)  # the stamped face is a touch duller
    col = ramp(t, WAX_RAMP)
    col = col + (spec ** 90)[..., None] * 0.75 + (spec ** 16)[..., None] * 0.07
    return np.clip(col, 0, 1), cover(sd)


def mark_engraved(tri, seed=51):
    """A slender outline play head cut as an engraved gilt line, with a hairline inside."""
    sd = sd_poly(shrink(tri, 5)) - 5
    col_acc = np.zeros((S, S, 3))
    a_acc = np.zeros((S, S))
    for off, w in ((-1.0, 22.0), (-36.0, 5.0)):
        dd = sd - off + w / 2
        a = cover(np.abs(dd) - w / 2)
        prof = np.clip(1 - np.abs(dd) / (w / 2 + 0.5), 0, 1)
        height = np.sqrt(prof) * w * 0.45  # a raised, rounded gilt wire
        gilt = gilt_surface(height, 1.4, seed)
        col_acc, a_acc = over(col_acc, a_acc, gilt, a)
    return col_acc, a_acc


def star_sprites(src, centers):
    """Cut painted stars out of the source with a luminance key."""
    box = max(4, int(round(src.r * 9 / 43.5)))  # scales with the source's resolution
    arr = np.asarray(src.img, float) / 255
    L = arr @ np.array([0.299, 0.587, 0.114])
    sprites = []
    for (x, y) in centers:
        lp = L[y - box:y + box + 1, x - box:x + box + 1]
        ring = np.r_[lp[0], lp[-1], lp[:, 0], lp[:, -1]]
        bgv = np.median(ring)
        a = np.clip((lp - bgv) / (lp.max() - bgv), 0, 1)
        sprites.append(a)
    return sprites


def mark_constellation(tri, src, star_centers, seed=61):
    """Three of the painting's own stars at the corners of the play head, joined by gilt hairlines."""
    sprites = star_sprites(src, star_centers)
    col = np.zeros((S, S, 3))
    alpha = np.zeros((S, S))
    p = np.array(tri)
    lines = np.full((S, S), np.inf)
    gap = 40
    for i in range(3):
        a, b = p[i], p[i - 1]
        e = b - a
        n = np.linalg.norm(e)
        w = np.stack([XX - a[0], YY - a[1]], -1)
        t = np.clip((w @ e) / (e @ e), 0, 1)
        d = np.hypot(w[..., 0] - e[0] * t, w[..., 1] - e[1] * t)
        lines = np.minimum(lines, np.where((t * n > gap) & ((1 - t) * n > gap), d, np.inf))
    la = cover(lines - 3.2) * 0.9
    lc = np.broadcast_to(GILT, (S, S, 3))
    col, alpha = over(col, alpha, lc, la)
    for sa, (vx, vy), sz in zip(sprites, p, (96, 80, 88)):
        # upscale the painted star's shape; soften the JPEG speckle, then firm the core
        am = Image.fromarray((sa * 255).astype(np.uint8)).resize((sz, sz), Image.LANCZOS)
        a = ndi.gaussian_filter(np.asarray(am, float) / 255, sz / 40)
        a = smoothstep(0.12, 0.75, a)
        layer = np.zeros((S, S))
        x0, y0 = int(round(vx - sz / 2)), int(round(vy - sz / 2))
        layer[y0:y0 + sz, x0:x0 + sz] = a
        glow = ndi.gaussian_filter(layer, 14) * 0.6
        col, alpha = over(col, alpha, np.broadcast_to(hexrgb('#E9EFD8'), (S, S, 3)), glow)
        core = np.broadcast_to(hexrgb('#FBF6E6'), (S, S, 3))
        col, alpha = over(col, alpha, core, layer)
    return col, alpha


# ----------------------------------------------------------------------------------------------
# a free-standing crescent matte from the painted pixels

def crescent_matte(raw_plate, cx, cy, r):
    """Alpha for the lit crescent alone, keyed on the untextured plate's luminance."""
    lum = ndi.gaussian_filter(raw_plate @ np.array([0.299, 0.587, 0.114]), 2.0)
    sky = np.median(lum[sd_circle(cx, cy, r) < 0])
    lit = np.percentile(lum[sd_circle(cx, cy, r) < 0], 99)
    a = smoothstep(sky + 0.30 * (lit - sky), sky + 0.62 * (lit - sky), lum)
    return a * cover(sd_circle(cx, cy, r * 1.04), 4)


def fit_terminator(matte, cx, cy, r):
    """Least-squares circle through the inner (terminator) edge of the lit crescent."""
    m = matte > 0.5
    lab, n = ndi.label(m)
    if n > 1:
        m = lab == (1 + int(np.argmax(ndi.sum(np.ones_like(matte), lab, range(1, n + 1)))))
    pts = []
    for y in range(int(cy - 0.7 * r), int(cy + 0.8 * r), 6):
        row = np.where(m[y])[0]
        if len(row):
            pts.append((row.max() + 0.5, y + 0.5))
    pts = np.array(pts, float)
    A = np.c_[2 * pts[:, 0], 2 * pts[:, 1], np.ones(len(pts))]
    sol = np.linalg.lstsq(A, (pts ** 2).sum(1), rcond=None)[0]
    return sol[0], sol[1], math.sqrt(sol[2] + sol[0] ** 2 + sol[1] ** 2), m


def knife_cut(matte, cx, cy, r, reach=26):
    """Cut the painted crescent out with a clean knife: along the disc's limb and a circle fitted
    to the painted terminator. The painting decides where the horns end."""
    tx, ty, tr, lit = fit_terminator(matte, cx, cy, r)
    geo = cover(sd_circle(cx, cy, r * 0.968), 1.2) * (1 - cover(sd_circle(tx, ty, tr), 1.2))
    near = ndi.distance_transform_edt(~lit)
    horns = smoothstep(reach, reach * 0.35, near)
    return geo * horns


def compose(name, rgb, alpha, outdir):
    out = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)])
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), 'RGBA').save(os.path.join(outdir, name + '.png'))


def textured_plate(src, tex, cx, cy, r):
    p = src.plate((cx, cy), r)
    return tex.apply(p, (cx, cy, r))


def sight_shadow(sight_sd, depth=0.55, blur=10, off=7):
    """The frame lip shades the painting just inside the sight edge, more on the lit side."""
    outside = 1 - cover(sight_sd)
    sh = ndi.gaussian_filter(ndi.shift(outside, (off, off), order=1, mode='nearest'), blur)
    sh2 = ndi.gaussian_filter(outside, blur * 0.5)
    return np.clip(1 - depth * np.maximum(sh, sh2 * 0.6), 0, 1)


def put_mark(rgb, a, mark, shadow=(6, 6, 0.5)):
    mc, ma = mark
    if shadow:
        blur, dy, op = shadow
        sh = drop_shadow(ma, blur, dy, op)
        rgb = rgb * (1 - sh[..., None])
    return over(rgb, a, mc, ma)


def finish(rgb, a, shadow=(16, 12, 0.35)):
    """Bake a soft macOS-style drop shadow under the whole shape."""
    if shadow:
        blur, dy, op = shadow
        return over(np.zeros((S, S, 3)), drop_shadow(a, blur, dy, op), rgb, a)
    return rgb, a


def framed_plate(src, tex, shape_sd, rim, moon, rim_seed=1, beads=None):
    """Night sky filling a shape, with an optional gilt moulding `rim` px wide."""
    cx, cy, r = moon
    plate = textured_plate(src, tex, cx, cy, r)
    a = cover(shape_sd)
    rgb = plate
    if rim:
        rgb = rgb * sight_shadow(shape_sd + rim)[..., None]
        rc, ra = gilt_moulding(shape_sd, rim, seed=rim_seed, beads=beads)
        rgb, a = over(rgb, a, rc, ra)
    return rgb, a


def build(src, outdir):
    tex = Texture()
    meta = []

    # moon.png: the cut moon with its sky, geometry of assets/icon.svg (centre 130,128 r 100 of 256)
    MC, MR = (520.0, 512.0), 400.0
    moon = textured_plate(src, tex, *MC, MR)
    compose('moon', moon, np.ones((S, S)), outdir)

    squircle = sd_round_rect(512, 512, 412, 185)

    # A. Gilt leaf: rounded square of sky, gold-leaf play head with a soft bevel
    m = (512.0, 512.0, 330.0)
    rgb, a = framed_plate(src, tex, squircle, 22, m, rim_seed=2)
    rgb, a = put_mark(rgb, a, mark_gilt_leaf(play_triangle(*m)), (7, 9, 0.6))
    compose('a-gilt-leaf', *finish(rgb, a), outdir)
    meta.append(('a', 'gilt-leaf', 'Gilt leaf',
                 'Rounded square of night sky in a thin gilt rim; a gold-leaf play head with a soft bevel'))

    # B. Three strokes: round gilt miniature, lead white laid in as three brushstrokes
    ring = sd_circle(512, 512, 452)
    m = (512.0 + 0.10 * 268, 512.0, 268.0)
    rgb, a = framed_plate(src, tex, ring, 66, m, rim_seed=3, beads=(64, 0.86))
    rgb, a = put_mark(rgb, a, mark_strokes(play_triangle(*m)), (5, 5, 0.35))
    compose('b-three-strokes', *finish(rgb, a), outdir)
    meta.append(('b', 'three-strokes', 'Three strokes',
                 'Round gilt miniature with a pearl bead; the play head laid in with three strokes of lead white'))

    # C. Constellation: three of the painting's own stars joined into the play head
    m = (512.0, 512.0, 340.0)
    rgb, a = framed_plate(src, tex, squircle, 0, m)
    rgb = rgb * sight_shadow(squircle, depth=0.35, blur=26, off=0)[..., None]
    rgb, a = put_mark(rgb, a, mark_constellation(play_triangle(*m, size=1.06), src, src.stars), None)
    compose('c-constellation', *finish(rgb, a), outdir)
    meta.append(('c', 'constellation', 'Constellation',
                 "Full-bleed rounded square; three of the painting's own stars joined by gilt hairlines"))

    # D. Bare ground: oval miniature, the play head left as red-brown ground with a gilt edge
    oval = sd_ellipse(512, 512, 382, 470)
    m = (512.0 + 0.12 * 250, 512.0, 250.0)
    rgb, a = framed_plate(src, tex, oval, 58, m, rim_seed=4)
    rgb, a = put_mark(rgb, a, mark_bare_ground(play_triangle(*m), tex), None)
    compose('d-bare-ground', *finish(rgb, a), outdir)
    meta.append(('d', 'bare-ground', 'Bare ground',
                 'Oval gilt miniature; the play head is the red-brown ground left unpainted, edged in gilt'))

    # E. Wax seal: the free-standing crescent on transparency, sealed in vermilion wax
    m = (590.0, 512.0, 470.0)
    plate = textured_plate(src, tex, *m)
    ca = crescent_matte(src.plate(m[:2], m[2]), *m[:2], m[2])
    rgb, a = plate, knife_cut(ca, *m)
    rgb, a = put_mark(rgb, a, mark_wax_seal(play_triangle(*m, size=0.98, dx=-0.07)), (10, 12, 0.5))
    compose('e-wax-seal', *finish(rgb, a, (10, 8, 0.45)), outdir)
    meta.append(('e', 'wax-seal', 'Wax seal',
                 'The crescent alone on transparency; a soft vermilion wax seal stamped with the play head'))

    # F. Engraved roundel: the moon's own disc cut out with its faint dark side, engraved outline
    m = (512.0, 512.0, 430.0)
    plate = textured_plate(src, tex, *m)
    disc = sd_circle(*m[:2], m[2] * 1.02)
    rgb, a = plate, cover(disc)
    rgb = rgb * sight_shadow(disc, depth=0.3, blur=20, off=0)[..., None]
    rgb, a = put_mark(rgb, a, mark_engraved(play_triangle(*m)), (3, 3, 0.5))
    rc, ra = engraved_ring(disc)
    rgb, a = over(rgb, a, rc, ra)
    compose('f-engraved', *finish(rgb, a), outdir)
    meta.append(('f', 'engraved', 'Engraved',
                 "The moon's own disc on transparency, dark side and all; a slender engraved gilt outline"))

    # G. Stucco oculus: the painting seen through a gilt-rimmed opening in a plaster tile
    tile = sd_round_rect(512, 512, 412, 185)
    sight = sd_circle(512, 512, 318)
    pc, pa = plaster(tile, sight, 34)
    m = (512.0 + 0.12 * 222, 512.0, 222.0)
    plate = textured_plate(src, tex, *m) * sight_shadow(sight, depth=0.6, blur=12, off=8)[..., None]
    rgb, a = over(pc, pa, plate, cover(sight))
    ring = sd_circle(512, 512, 346)
    rc, ra = gilt_moulding(ring, 30, seed=6)
    rgb, a = over(rgb, a, rc, ra * pa)
    rgb, a = put_mark(rgb, a, mark_gilt_leaf(play_triangle(*m)), (6, 7, 0.6))
    compose('g-stucco-oculus', *finish(rgb, a, (16, 12, 0.28)), outdir)
    meta.append(('g', 'stucco-oculus', 'Stucco oculus',
                 'A light plaster tile with the painting seen through a gilt-rimmed oculus, as in a Tiepolo ceiling'))

    return meta


def plaster(tile_sd, hole_sd, collar):
    """Warm plaster tile with a raised collar moulding round a circular opening."""
    edge = np.clip(-tile_sd, 0, None)
    h = 10 * np.sqrt(1 - (1 - np.clip(edge / 26, 0, 1)) ** 2)
    out = np.clip(hole_sd, 0, None)
    h = h + 14 * np.exp(-((out - collar * 0.55) / (collar * 0.38)) ** 2) + 5 * np.exp(-((out - collar * 1.25) / 5) ** 2)
    h = h + 0.8 * noise((S, S), 2, 91) + 1.5 * noise((S, S), 18, 92)
    diff, spec, _ = shade(ndi.gaussian_filter(h, 1.0), 1.0)
    base = hexrgb('#EFE7D6')
    col = base[None, None] * (0.80 + 0.30 * (diff / flat_diff()))[..., None]
    col = col * (1 - 0.06 * smoothstep(0.0, 1.0, noise((S, S), 60, 93)))[..., None]
    col = col + np.array([0.0, -0.01, -0.03]) * smoothstep(0, 0.5, noise((S, S), 30, 94))[..., None]
    return np.clip(col, 0, 1), cover(tile_sd)


def engraved_ring(disc_sd, w=9):
    d = np.abs(disc_sd + w / 2) - w / 2
    prof = np.clip(1 - np.abs(disc_sd + w / 2) / (w / 2), 0, 1)
    col = gilt_surface(np.sqrt(prof) * w * 0.8, 1.3, 77)
    return col, cover(d)


def png_data_uri(img):
    import base64
    import io
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def downscale(img, size):
    """High-quality reduction (premultiplied Lanczos) like an icon export would do."""
    pm = img.convert('RGBa').resize((size, size), Image.LANCZOS, reducing_gap=3.0)
    return pm.convert('RGBA')


def write_contact_sheet_html(meta, outdir):
    """Self-contained sheet: every size is pre-reduced here, so the browser never resamples."""
    cards = []
    for letter, slug, name, idea in meta:
        img = Image.open(os.path.join(outdir, f'{letter}-{slug}.png')).convert('RGBA')
        u = {n: png_data_uri(downscale(img, n)) for n in (256, 64, 32, 16)}
        small = ''.join(f'<img src="{u[n]}" width="{n}" height="{n}">' for n in (64, 32, 16))
        cards.append(f'''
      <figure class="card">
        <div class="pair">
          <div class="tile dark"><img src="{u[256]}" width="256" height="256"></div>
          <div class="tile light"><img src="{u[256]}" width="256" height="256"></div>
        </div>
        <div class="pair small">
          <div class="tile dark">{small}</div>
          <div class="tile light">{small}</div>
        </div>
        <figcaption><b>{letter.upper()}. {name}</b><span>{idea}</span></figcaption>
      </figure>''')
    moon = Image.open(os.path.join(outdir, 'moon.png')).convert('RGBA')
    cards.append(f'''
      <figure class="card ref">
        <div class="pair">
          <div class="tile dark"><img src="{png_data_uri(downscale(moon, 256))}" width="256" height="256"></div>
          <div class="tile dark note">The cut moon (moon.png): the painting's own pixels, rotated so the lit limb
            is on the left, upscaled about 9x from a disc about 87 px across. Its geometry matches
            assets/icon.svg, so a play head sits in the hollow. Small sizes are reduced with Lanczos,
            as an icon export would be.</div>
        </div>
        <figcaption><b>Reference. moon.png</b><span>1024 px, full bleed, no mark</span></figcaption>
      </figure>''')
    html = f'''<!doctype html>
<html><head><meta charset="utf-8">
<title>Agent Auto-Continue - logo iterations, round 3</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&family=Cormorant+Garamond:ital,wght@0,600;1,600;1,700&display=swap">
<style>
  html,body{{margin:0;background:#2a221d;color:#F0E7D3}}
  body{{width:1800px;padding:44px 40px 40px;box-sizing:border-box;font-family:'Cormorant Garamond',Georgia,serif}}
  h1{{font-style:italic;font-weight:700;font-size:40px;margin:0 0 4px;letter-spacing:.2px}}
  .sub{{font-family:Cinzel,Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#D3AC5A;margin:0 0 30px}}
  .grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:34px 30px}}
  .card{{margin:0;background:#171210;border:1px solid #7D5D24;border-radius:6px;padding:16px;box-shadow:inset 0 0 0 3px #171210,inset 0 0 0 4px #4b3a1c}}
  .pair{{display:flex;gap:12px}}
  .tile{{width:256px;height:256px;display:flex;align-items:center;justify-content:center;border-radius:3px}}
  .tile.dark{{background:#1f1a17}}
  .tile.light{{background:#EFE7D6}}
  .pair.small{{margin-top:12px}}
  .pair.small .tile{{height:84px;gap:22px}}
  .note{{font-size:16px;line-height:1.3;padding:0 18px;box-sizing:border-box;text-align:left;color:#d9cfb9;background:#171210 !important}}
  figcaption{{margin-top:14px}}
  figcaption b{{display:block;font-family:Cinzel,Georgia,serif;font-weight:600;font-size:17px;letter-spacing:1.6px;color:#F3DFA0}}
  figcaption span{{display:block;font-size:18px;line-height:1.25;margin-top:4px;color:#d9cfb9}}
</style></head>
<body>
  <h1>Agent Auto-Continue - logo iterations, round 3</h1>
  <p class="sub">The painted crescent, cut from the portrait - 256 px on dark and light - then 64, 32 and 16 px</p>
  <div class="grid">{''.join(cards)}
  </div>
</body></html>
'''
    with open(os.path.join(outdir, 'contact-sheet.html'), 'w') as f:
        f.write(html)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--source', default=DEFAULT_SOURCE)
    ap.add_argument('--cx', type=float, default=371.0, help='moon disc centre x in source px')
    ap.add_argument('--cy', type=float, default=203.0, help='moon disc centre y in source px')
    ap.add_argument('--r', type=float, default=43.5, help='moon disc radius in source px')
    ap.add_argument('--limb', type=float, default=44.0, help='direction the lit limb faces, degrees, image axes')
    ap.add_argument('--stars', default='86,55;382,325;235,196', help='three painted stars x,y;x,y;x,y in source px')
    ap.add_argument('--out', default=HERE)
    args = ap.parse_args()
    src = Source(args.source, args.cx, args.cy, args.r, args.limb)
    src.stars = [tuple(int(v) for v in s.split(',')) for s in args.stars.split(';')]
    meta = build(src, args.out)
    write_contact_sheet_html(meta, args.out)
    print('wrote', len(meta), 'iterations and contact-sheet.html to', args.out)
    print('render the sheet: env -u ELECTRON_RUN_AS_NODE npx electron design/logo-ideas/round3/capture.cjs')


if __name__ == '__main__':
    main()
