"""Parametric library of simple silhouettes that read well as thick glass.

Each shape is returned in a 1000 x 1000 canvas (SVG coordinates, y down) as a list
of closed contours: the first is the outline, any others are holes. Shapes are kept
deliberately simple — a glass prism only reads if its silhouette does.

    python3 make_shape.py <name> [out.svg]           write one parametric shape
    python3 make_shape.py --list                     names, one per line
    python3 make_shape.py --check                    validate every parametric shape
    python3 make_shape.py --check-file logo.svg      validate a file before using it
    python3 make_shape.py --import logo.svg out.svg  normalise a file into the library
    python3 make_shape.py --extract-icon lockup.svg out.svg
                                                     keep the mark, drop the wordmark

Adding a shape: write a builder returning [outline, *holes] and register it in
SHAPES. `--check` then verifies it is a simple polygon with a visibility kernel.
"""
from __future__ import annotations
import math
import pathlib
import sys

TAU = math.pi * 2
C = 500.0          # canvas centre
R = 380.0          # nominal outer radius: keeps every shape on the same visual weight


# ---------------------------------------------------------------- helpers
def norm(v):
    length = math.hypot(*v)
    return (v[0] / length, v[1] / length)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def ang_norm(a):
    while a > math.pi:
        a -= TAU
    while a < -math.pi:
        a += TAU
    return a


def fillet(corners, radii, step=4.0):
    """Round every corner of a polygon. radii may be one value or one per corner."""
    if not isinstance(radii, (list, tuple)):
        radii = [radii] * len(corners)
    corners = dedupe(corners)
    n, out = len(corners), []
    for i in range(n):
        p, a, b, r = corners[i], corners[i - 1], corners[(i + 1) % n], radii[i % len(radii)]
        if math.hypot(a[0] - p[0], a[1] - p[1]) < 1e-9 or math.hypot(b[0] - p[0], b[1] - p[1]) < 1e-9:
            out.append(p)
            continue
        ua = norm((a[0] - p[0], a[1] - p[1]))
        ub = norm((b[0] - p[0], b[1] - p[1]))
        theta = math.acos(max(-1.0, min(1.0, dot(ua, ub))))
        if theta < 1e-6 or abs(theta - math.pi) < 1e-6:
            out.append(p)
            continue
        # never eat more than half of either edge
        r = min(r, 0.5 * math.hypot(a[0] - p[0], a[1] - p[1]) * math.tan(theta / 2),
                0.5 * math.hypot(b[0] - p[0], b[1] - p[1]) * math.tan(theta / 2))
        d = r / math.tan(theta / 2)
        t1 = (p[0] + ua[0] * d, p[1] + ua[1] * d)
        t2 = (p[0] + ub[0] * d, p[1] + ub[1] * d)
        bis = norm((ua[0] + ub[0], ua[1] + ub[1]))
        c = (p[0] + bis[0] * r / math.sin(theta / 2), p[1] + bis[1] * r / math.sin(theta / 2))
        a1 = math.atan2(t1[1] - c[1], t1[0] - c[0])
        da = ang_norm(math.atan2(t2[1] - c[1], t2[0] - c[0]) - a1)
        steps = max(3, int(abs(da) * r / step))
        out += [(c[0] + r * math.cos(a1 + da * k / steps), c[1] + r * math.sin(a1 + da * k / steps))
                for k in range(steps + 1)]
    return out


def circle(cx, cy, r, n=96):
    return [(cx + r * math.cos(k / n * TAU), cy + r * math.sin(k / n * TAU)) for k in range(n)]


def soften(points, tip, width, samples=10):
    """Replace the run of points within `width` of `tip` by a quadratic through it.
    The curve stays inside the triangle of its anchors, so it cannot self-intersect."""
    n = len(points)
    idx = [k for k, p in enumerate(points) if math.hypot(p[0] - tip[0], p[1] - tip[1]) < width]
    if len(idx) < 2:
        return points
    if 0 in idx and n - 1 in idx:                       # run wraps the seam: rotate first
        shift = max(k for k in idx if k < n // 2) + 1
        return soften(points[shift:] + points[:shift], tip, width, samples)
    a, b = idx[0], idx[-1]
    p0, p2 = points[a], points[b]
    curve = [((1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * tip[0] + u * u * p2[0],
              (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * tip[1] + u * u * p2[1])
             for u in (k / samples for k in range(samples + 1))]
    return points[:a] + curve + points[b + 1:]


# ---------------------------------------------------------------- curve helpers
def smooth_closed(points, steps=22):
    """Closed Catmull-Rom spline through the given points. This is how the organic
    shapes get continuous curvature instead of visible straight segments."""
    n, out = len(points), []
    for i in range(n):
        p0, p1, p2, p3 = points[(i - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]
        for k in range(steps):
            t = k / steps
            t2, t3 = t * t, t * t * t
            out.append((
                0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t
                       + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t
                       + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)))
    return out


def polar(radius_at, steps=220):
    """Closed curve from a radius function of the angle. Smooth by construction."""
    return [(C + radius_at(k / steps * TAU) * math.cos(k / steps * TAU),
             C + radius_at(k / steps * TAU) * math.sin(k / steps * TAU)) for k in range(steps)]


def superellipse(rx, ry, n, steps=160):
    out = []
    for k in range(steps):
        t = k / steps * TAU
        co, si = math.cos(t), math.sin(t)
        out.append((C + math.copysign(abs(co) ** (2 / n), co) * rx,
                    C + math.copysign(abs(si) ** (2 / n), si) * ry))
    return out


def ribbon(centre_line, half_width, cap_steps=20):
    """Thicken a polyline into a closed band with round caps. The cap always sweeps
    away from the line, otherwise it cuts back into the band and leaves a notch."""
    def tangent(i):
        a = centre_line[max(0, i - 1)]
        b = centre_line[min(len(centre_line) - 1, i + 1)]
        return norm((b[0] - a[0], b[1] - a[1]))

    left, right = [], []
    for i, p in enumerate(centre_line):
        t = tangent(i)
        n = (-t[1], t[0])
        left.append((p[0] + n[0] * half_width, p[1] + n[1] * half_width))
        right.append((p[0] - n[0] * half_width, p[1] - n[1] * half_width))

    def cap(index, outward):
        p = centre_line[index]
        t = tangent(index)
        n = (-t[1], t[0])
        start = math.atan2(n[1], n[0])
        direction = 1 if ang_norm(math.atan2(outward[1], outward[0]) - start) > 0 else -1
        return [(p[0] + half_width * math.cos(start + direction * math.pi * k / cap_steps),
                 p[1] + half_width * math.sin(start + direction * math.pi * k / cap_steps))
                for k in range(1, cap_steps)]

    end_t = tangent(len(centre_line) - 1)
    start_t = tangent(0)
    return (left + cap(len(centre_line) - 1, end_t) + right[::-1]
            + cap(0, (-start_t[0], -start_t[1]))[::-1])


# ---------------------------------------------------------------- shapes
# Every silhouette here is built for thick glass: broad masses, continuous curvature,
# nothing thinner than a tenth of the width, and a profile that still reads when the
# camera swings round to a grazing angle.
def squircle():
    """Rounded square with continuous curvature: products, apps, a neutral mark."""
    return [superellipse(R * 0.94, R * 0.94, 4.6)]


def burst():
    """Eight-point burst: energy, launch, a confident all-purpose mark.
    Same geometry as the default brand mark in assets/brand/mark.svg."""
    raw = parse_path("M315.994 213.542L447.692 43.1698L528.776 124.254L358.308 256.024L572 228.665V343.335L358.394 315.986L528.775 447.69L447.691 528.774L315.986 358.392L343.335 572H228.665L256.021 358.329L124.311 528.719L43.2265 447.635L213.522 315.997L0 343.335V228.665L213.607 256.013L43.2258 124.31L124.31 43.2251L256.013 213.605L228.665 0H343.335L315.994 213.542Z")[0]
    s = R / 286.0
    return [fillet([(C + (x - 286.0) * s, C + (y - 286.0) * s) for x, y in raw], 16)]


def spark():
    """Four-point sparkle. Each side is a cubic whose handles aim at the centre, which
    confines it to its quadrant: arcs drawn through two tips would cross underneath."""
    tips = [(C, C - R), (C + R, C), (C, C + R), (C - R, C)]

    def side(i, t, n=64):
        a, b = tips[i], tips[(i + 1) % 4]
        p1 = (a[0] + t * (C - a[0]), a[1] + t * (C - a[1]))
        p2 = (b[0] + t * (C - b[0]), b[1] + t * (C - b[1]))
        out = []
        for k in range(n):
            u = k / n
            w = ((1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3)
            out.append((w[0] * a[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * b[0],
                        w[0] * a[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * b[1]))
        return out

    lo, hi = 0.0, 1.0                                   # bigger t pulls the waist in
    for _ in range(60):
        t = (lo + hi) / 2
        m = side(0, t, 2)[1]
        if math.hypot(m[0] - C, m[1] - C) / R > 0.40:
            lo = t
        else:
            hi = t
    pts = [p for i in range(4) for p in side(i, t)]
    for tip in tips:
        pts = soften(pts, tip, R * 0.10)
    return [pts]


def bolt():
    """Lightning: energy, speed, reaction time. Broad flanks, one crisp notch."""
    raw = [(0.26, 1.62), (-0.94, -0.06), (-0.14, -0.06), (-0.44, -1.62),
           (0.96, 0.26), (0.16, 0.26)]
    s = R / 1.62
    return [fillet([(C + x * s * 0.92, C - y * s) for x, y in raw], 20)]


def pebble():
    """Organic asymmetric mass: craft, wellbeing, anything that should feel handmade.
    The most forgiving shape in glass — every angle gives a different silhouette."""
    radii = [1.00, 0.88, 0.97, 0.82, 0.93, 0.86]
    angles = [0.0, 0.9, 1.9, 3.0, 4.0, 5.2]
    return [smooth_closed([(C + R * r * math.cos(a), C + R * r * math.sin(a))
                           for r, a in zip(radii, angles)])]


def ring():
    """Annulus: cycles, community, continuity. The hole is punched once the fragments
    merge, and it is where the glass does its best work."""
    return [circle(C, C, R * 0.98, 140), circle(C, C, R * 0.50, 120)]


def wave():
    """A thick ribbon through an S: motion, flow, signal."""
    line = [(C - R * 0.86 + k / 60 * R * 1.72,
             C + R * 0.42 * math.sin(k / 60 * math.pi * 1.6 - math.pi * 0.3))
            for k in range(61)]
    return [ribbon(line, R * 0.24)]


def prism():
    """Rounded triangle: direction, focus, a strong flat mass to refract through."""
    corners = [(C + R * math.cos(-math.pi / 2 + k * TAU / 3),
                C + R * math.sin(-math.pi / 2 + k * TAU / 3)) for k in range(3)]
    return [fillet(corners, R * 0.30)]


def bloom():
    """Five-petal rosette: care, nature, hospitality. Smooth lobes, no sharp notch."""
    return [polar(lambda a: R * (0.63 + 0.37 * abs(math.cos(2.5 * a)) ** 0.85))]


def arch():
    """Portal: architecture, property, openings. Flat base, half-round top."""
    width, base = R * 0.74, R * 0.86
    top = []
    for k in range(81):
        a = math.pi + k / 80 * math.pi
        top.append((C + width * math.cos(a), C - base + width * 0.98 * math.sin(a)))
    pts = [(C - width, C + base), (C - width, C - base)] + top + [(C + width, C + base)]
    return [fillet(pts, [R * 0.24, 6, *([2] * len(top)), R * 0.24])]


def cross():
    """Plus: health, care, addition. Generous fillets keep it from looking like an icon."""
    a, b = R * 0.36, R * 0.94
    corners = [(C - a, C - b), (C + a, C - b), (C + a, C - a), (C + b, C - a), (C + b, C + a),
               (C + a, C + a), (C + a, C + b), (C - a, C + b), (C - a, C + a), (C - b, C + a),
               (C - b, C - a), (C - a, C - a)]
    return [fillet(corners, 52)]


def hexagon():
    """Hexagon: structure, engineering, network."""
    corners = [(C + R * math.cos(-math.pi / 2 + k * TAU / 6),
                C + R * math.sin(-math.pi / 2 + k * TAU / 6)) for k in range(6)]
    return [fillet(corners, R * 0.22)]


def home():
    """House with a soft roof: property, home services."""
    corners = [(C - R * 0.80, C + R * 0.78), (C + R * 0.80, C + R * 0.78),
               (C + R * 0.80, C - R * 0.22), (C, C - R * 0.95), (C - R * 0.80, C - R * 0.22)]
    return [fillet(corners, [110, 110, 80, 62, 80])]


SHAPES = {
    'squircle': squircle, 'burst': burst, 'spark': spark, 'bolt': bolt, 'pebble': pebble,
    'ring': ring, 'wave': wave, 'prism': prism, 'bloom': bloom,
    'arch': arch, 'cross': cross, 'hexagon': hexagon, 'home': home,
}


# ---------------------------------------------------------------- svg path input
def parse_path(d, curve_steps=18):
    """Flatten an SVG path into closed polygons. Supports M L H V C S Q T A Z in both
    cases, which covers what design tools export. Used to read a real logo, and by
    --check-file to validate one before it goes into the site."""
    import re as _re
    tokens = _re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?', d)
    polys, cur = [], []
    i = 0
    x = y = 0.0
    start = (0.0, 0.0)
    cmd = None
    last_c = last_q = None

    def num():
        nonlocal i
        value = float(tokens[i]); i += 1
        return value

    def bez(p0, ctrl, p1, quad=False):
        out = []
        for k in range(1, curve_steps + 1):
            u = k / curve_steps
            if quad:
                w = ((1 - u) ** 2, 2 * (1 - u) * u, u ** 2)
                out.append((w[0] * p0[0] + w[1] * ctrl[0][0] + w[2] * p1[0],
                            w[0] * p0[1] + w[1] * ctrl[0][1] + w[2] * p1[1]))
            else:
                w = ((1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3)
                out.append((w[0] * p0[0] + w[1] * ctrl[0][0] + w[2] * ctrl[1][0] + w[3] * p1[0],
                            w[0] * p0[1] + w[1] * ctrl[0][1] + w[2] * ctrl[1][1] + w[3] * p1[1]))
        return out

    while i < len(tokens):
        token = tokens[i]
        if token.isalpha():
            cmd = token
            i += 1
            if cmd in 'Zz':
                if len(cur) > 2:
                    polys.append(cur)
                cur = []
                x, y = start
                continue
        rel = cmd.islower()
        upper = cmd.upper()
        if upper == 'M':
            x, y = (x + num(), y + num()) if rel else (num(), num())
            if len(cur) > 2:
                polys.append(cur)
            cur = [(x, y)]
            start = (x, y)
            cmd = 'l' if rel else 'L'
        elif upper == 'L':
            x, y = (x + num(), y + num()) if rel else (num(), num())
            cur.append((x, y))
        elif upper == 'H':
            x = x + num() if rel else num()
            cur.append((x, y))
        elif upper == 'V':
            y = y + num() if rel else num()
            cur.append((x, y))
        elif upper in ('C', 'S'):
            if upper == 'C':
                c1 = (x + num(), y + num()) if rel else (num(), num())
            else:
                c1 = (2 * x - last_c[0], 2 * y - last_c[1]) if last_c else (x, y)
            c2 = (x + num(), y + num()) if rel else (num(), num())
            p1 = (x + num(), y + num()) if rel else (num(), num())
            cur += bez((x, y), (c1, c2), p1)
            last_c, last_q = c2, None
            x, y = p1
        elif upper in ('Q', 'T'):
            if upper == 'Q':
                c1 = (x + num(), y + num()) if rel else (num(), num())
            else:
                c1 = (2 * x - last_q[0], 2 * y - last_q[1]) if last_q else (x, y)
            p1 = (x + num(), y + num()) if rel else (num(), num())
            cur += bez((x, y), (c1,), p1, quad=True)
            last_q, last_c = c1, None
            x, y = p1
        elif upper == 'A':
            rx, ry = abs(num()), abs(num())
            phi = math.radians(num())
            large, sweep = num(), num()
            p1 = (x + num(), y + num()) if rel else (num(), num())
            cur += arc_points((x, y), rx, ry, phi, large, sweep, p1, curve_steps)
            x, y = p1
        else:
            raise ValueError(f'unsupported path command {cmd!r}')
    if len(cur) > 2:
        polys.append(cur)
    return [dedupe(p) for p in polys if len(dedupe(p)) > 2]


def dedupe(points, epsilon=1e-6):
    """Drop repeated vertices, including a closing point equal to the first one."""
    out = []
    for p in points:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > epsilon:
            out.append(p)
    while len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) <= epsilon:
        out.pop()
    return out


def arc_points(p0, rx, ry, phi, large, sweep, p1, steps):
    """Elliptical arc, endpoint parametrisation (SVG spec F.6.5), flattened."""
    if rx < 1e-9 or ry < 1e-9 or (abs(p1[0] - p0[0]) < 1e-12 and abs(p1[1] - p0[1]) < 1e-12):
        return [p1]
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1, y1 = cos_p * dx + sin_p * dy, -sin_p * dx + cos_p * dy
    scale = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if scale > 1:                                        # radii too small: grow them
        rx, ry = rx * math.sqrt(scale), ry * math.sqrt(scale)
    numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    factor = math.sqrt(max(0.0, numerator) / max(1e-12, rx * rx * y1 * y1 + ry * ry * x1 * x1))
    if bool(large) == bool(sweep):
        factor = -factor
    cx1, cy1 = factor * rx * y1 / ry, -factor * ry * x1 / rx
    cx = cos_p * cx1 - sin_p * cy1 + (p0[0] + p1[0]) / 2
    cy = sin_p * cx1 + cos_p * cy1 + (p0[1] + p1[1]) / 2
    start = math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
    end = math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx)
    sweep_angle = end - start
    if not sweep and sweep_angle > 0:
        sweep_angle -= TAU
    elif sweep and sweep_angle < 0:
        sweep_angle += TAU
    count = max(2, int(steps * abs(sweep_angle) / math.pi))
    out = []
    for k in range(1, count + 1):
        a = start + sweep_angle * k / count
        ex, ey = rx * math.cos(a), ry * math.sin(a)
        out.append((cos_p * ex - sin_p * ey + cx, sin_p * ex + cos_p * ey + cy))
    return out


def read_svg(path):
    """Every closed contour of an SVG file, largest first, in file coordinates."""
    import re as _re
    text = pathlib.Path(path).read_text()
    polys = []
    for d in _re.findall(r'\sd="([^"]+)"', text):
        polys += parse_path(d)
    if not polys:
        raise ValueError('no <path d="..."> found — flatten strokes and shapes to paths first')
    unique, unique_keys = [], []
    for poly in sorted(polys, key=area, reverse=True):
        a = area(poly)
        centre = (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
        span = math.sqrt(max(a, 1.0))
        duplicate = any(abs(a - b) <= 0.01 * max(a, b)
                        and math.hypot(centre[0] - c[0], centre[1] - c[1]) <= 0.02 * span
                        for b, c in unique_keys)
        if duplicate:                                     # icon packs often ship a path twice
            continue
        unique_keys.append((a, centre))
        unique.append(poly)
    return unique


# ---------------------------------------------------------------- validation
def area(points):
    return abs(sum(points[i][0] * points[(i + 1) % len(points)][1]
                   - points[(i + 1) % len(points)][0] * points[i][1]
                   for i in range(len(points)))) / 2


def self_crossings(points):
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    n, count = len(points), 0
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            p, q, r, s = points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]
            o1, o2, o3, o4 = orient(p, q, r), orient(p, q, s), orient(r, s, p), orient(r, s, q)
            if (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0) and 0 not in (o1, o2, o3, o4):
                count += 1
    return count


def kernel_area(points):
    """Area of the visibility kernel: > 0 means the fold-free radial morph applies.
    Tried with both edge orientations, so the caller need not normalise winding."""
    def clip(sign):
        k = [(-4000.0, -4000.0), (4000.0, -4000.0), (4000.0, 4000.0), (-4000.0, 4000.0)]
        for i in range(len(points)):
            a = points[i]
            b = points[(i + 1) % len(points)]
            e = (b[0] - a[0], b[1] - a[1])
            clipped = []
            for j in range(len(k)):
                p, q = k[j], k[(j + 1) % len(k)]
                dp = sign * (e[0] * (p[1] - a[1]) - e[1] * (p[0] - a[0]))
                dq = sign * (e[0] * (q[1] - a[1]) - e[1] * (q[0] - a[0]))
                if dp >= -1e-9:
                    clipped.append(p)
                if (dp >= 0) != (dq >= 0):
                    t = dp / (dp - dq)
                    clipped.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
            k = clipped
            if not k:
                return 0.0
        return area(k)

    return max(clip(1), clip(-1))


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def cluster_contours(contours):
    """Group contours that sit side by side. In a logo lockup this separates the mark
    from the letters of the wordmark, which are many, similar in height and adjacent."""
    boxes = sorted(((bbox(c), c) for c in contours), key=lambda item: item[0][0])
    heights = sorted(box[3] - box[1] for box, _ in boxes)
    gap = 0.45 * heights[len(heights) // 2]
    groups, current, edge = [], [], None
    for box, contour in boxes:
        if current and box[0] - edge > gap:
            groups.append(current)
            current = []
        current.append((box, contour))
        edge = box[2] if edge is None else max(edge, box[2])
    if current:
        groups.append(current)
    return groups


def pick_mark(groups):
    """Of the clusters, keep the one that reads as a symbol rather than as text."""
    def looks_like_text(group):
        if len(group) < 3:
            return False
        heights = [box[3] - box[1] for box, _ in group]
        mean = sum(heights) / len(heights)
        spread = (sum((h - mean) ** 2 for h in heights) / len(heights)) ** 0.5
        return spread / max(mean, 1e-9) < 0.45          # letters share a cap height

    scored = [(sum(area(c) for _, c in group), group) for group in groups]
    symbols = [(a, g) for a, g in scored if not looks_like_text(g)]
    best = max(symbols or scored, key=lambda item: item[0])[1]
    dropped = sum(len(g) for g in groups) - len(best)
    return [contour for _, contour in best], dropped


def write_fitted(contours, out):
    """Centre and scale contours into the 1000 x 1000 library canvas."""
    xs = [p[0] for c in contours for p in c]
    ys = [p[1] for c in contours for p in c]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    scale = (2 * R) / span
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    fitted = [[(C + (x - cx) * scale, C + (y - cy) * scale) for x, y in c] for c in contours]
    svg = to_svg(fitted)
    if out:
        pathlib.Path(out).write_text(svg)
        print(f'{out}: {len(fitted)} contour(s), {len(svg)} bytes')
    else:
        sys.stdout.write(svg)
    return 0


def to_svg(contours):
    def path(points):
        return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in points) + ' Z'
    d = ' '.join(path(c) for c in contours)
    return ('<svg role="img" viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">'
            f'<path fill-rule="evenodd" d="{d}"/></svg>\n')


def main(argv):
    if not argv or argv[0] in ('--list', '-l'):
        for name, fn in SHAPES.items():
            print(f'{name:10s} {(fn.__doc__ or "").splitlines()[0]}')
        return 0
    if argv[0] == '--extract-icon':
        contours = read_svg(argv[1])
        groups = cluster_contours(contours)
        keep, dropped = pick_mark(groups)
        if dropped:
            print(f'dropped {dropped} contour(s) that look like a wordmark')
        return write_fitted(keep, argv[2] if len(argv) > 2 else None)
    if argv[0] == '--import':
        return write_fitted(read_svg(argv[1]), argv[2] if len(argv) > 2 else None)
    if argv[0] == '--check-file':
        contours = read_svg(argv[1])
        print(f'{len(contours)} contour(s)')
        for k, contour in enumerate(contours):
            role = 'outline' if k == 0 else 'hole or extra solid'
            x = self_crossings(contour)
            ker = kernel_area(contour) / max(1e-9, area(contour))
            print(f'  {k}: {len(contour):5d} points  area {area(contour):10.0f}  '
                  f'crossings {x}  kernel {ker:5.1%}  {role}')
        outline = contours[0]
        if self_crossings(outline):
            print('WARNING: the outline crosses itself — the extrusion will show filaments')
        return 0
    if argv[0] == '--check':
        bad = 0
        for name, fn in SHAPES.items():
            outline = fn()[0]
            x = self_crossings(outline)
            ker = kernel_area(outline) / area(outline)
            flag = 'ok ' if x == 0 else 'CROSSES'
            if x:
                bad += 1
            print(f'{name:10s} {flag} points {len(outline):4d} kernel {ker:5.1%}')
        return 1 if bad else 0
    name = argv[0]
    if name not in SHAPES:
        print(f'unknown shape {name!r}; --list to see them all', file=sys.stderr)
        return 2
    svg = to_svg(SHAPES[name]())
    if len(argv) > 1:
        with open(argv[1], 'w') as handle:
            handle.write(svg)
        print(f'{argv[1]}: {name}, {len(svg)} bytes')
    else:
        sys.stdout.write(svg)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
