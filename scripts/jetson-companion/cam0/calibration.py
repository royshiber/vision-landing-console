"""Checkerboard capture and a one-view intrinsic solve.

OpenCV's calibrateCamera is used when it is importable. Otherwise a search
for fx/fy (principal point at the image center, distortion left at zero)
keeps the flow testable. camera_to_body is reserved and stays null until
an operator writes it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .marker import homography

SCHEMA = "airvix.cam0.calibration/1"


def render_checkerboard(width, height, inner_cols, inner_rows, square_px):
    """White-bounded checkerboard. Returns mono8 and the inner-corner pixels."""
    squares_x = int(inner_cols) + 1
    squares_y = int(inner_rows) + 1
    board_w = squares_x * int(square_px)
    board_h = squares_y * int(square_px)
    img = np.full((int(height), int(width)), 255, dtype=np.uint8)
    x0 = max(0, (int(width) - board_w) // 2)
    y0 = max(0, (int(height) - board_h) // 2)
    board = np.zeros((board_h, board_w), dtype=np.uint8)
    for r in range(squares_y):
        for c in range(squares_x):
            if (r + c) % 2 == 0:
                board[r * square_px:(r + 1) * square_px, c * square_px:(c + 1) * square_px] = 255
            else:
                board[r * square_px:(r + 1) * square_px, c * square_px:(c + 1) * square_px] = 0
    y1 = min(int(height), y0 + board_h)
    x1 = min(int(width), x0 + board_w)
    img[y0:y1, x0:x1] = board[:y1 - y0, :x1 - x0]
    corners = []
    for r in range(int(inner_rows)):
        for c in range(int(inner_cols)):
            corners.append([float(x0 + (c + 1) * square_px), float(y0 + (r + 1) * square_px)])
    return img, corners


def _autocorr_period(signal):
    sig = np.asarray(signal, dtype=np.float64)
    sig = sig - sig.mean()
    if sig.size < 8 or np.allclose(sig, 0):
        return None
    spec = np.fft.rfft(sig)
    ac = np.fft.irfft(spec * np.conj(spec), n=sig.size)
    ac[0] = 0
    lo = 4
    hi = max(lo + 1, sig.size // 3)
    if hi <= lo:
        return None
    period = int(np.argmax(ac[lo:hi]) + lo)
    return period if period >= 4 else None


def _pick_spaced(edges, count, length=None):
    """Most even run of `count` edges.

    Equal spacing is a tie when a page margin matches one square. The run
    farther from the image border is the inner grid.
    """
    edges = [int(e) for e in edges]
    if len(edges) < count:
        return None
    if len(edges) == count:
        return edges
    best = None
    best_var = 1e9
    best_inset = -1
    span = int(length) if length else (edges[-1] + 1)
    for i in range(0, len(edges) - count + 1):
        window = edges[i:i + count]
        gaps = np.diff(window)
        if np.min(gaps) < 2:
            continue
        var = float(np.var(gaps))
        inset = min(window[0], max(0, span - 1 - window[-1]))
        if var < best_var - 1e-9 or (abs(var - best_var) <= 1e-9 and inset > best_inset):
            best_var = var
            best_inset = inset
            best = window
    return best


def find_checkerboard(mono8, inner_cols, inner_rows):
    """Inner corners of a board drawn on a white page.

    The first square is white, so the page has no outer edge. Each strong
    jump is an inner corner line. Returns None when that grid is absent.
    """
    img = np.asarray(mono8, dtype=np.uint8)
    h, w = img.shape
    if h < 16 or w < 16:
        return None
    dx = np.abs(np.diff(img.astype(np.int16), axis=1))
    row_counts = (dx > 80).sum(axis=1)
    rows = np.where(row_counts >= int(inner_cols))[0]
    if rows.size == 0:
        return None
    mid = int(rows[rows.size // 2])
    xs = np.where(dx[mid] > 80)[0] + 1
    xsel = _pick_spaced(xs, int(inner_cols), w)
    if not xsel:
        return None
    dy = np.abs(np.diff(img.astype(np.int16), axis=0))
    # Sample between two vertical lines so the column is inside a square,
    # not on a corner where the outer page edge also jumps.
    col = int(round((xsel[0] + xsel[min(1, len(xsel) - 1)]) / 2.0))
    col = min(max(col, 0), w - 1)
    ys = np.where(dy[:, col] > 80)[0] + 1
    ysel = _pick_spaced(ys, int(inner_rows), h)
    if not ysel:
        return None
    corners = []
    for y in ysel:
        for x in xsel:
            corners.append([float(x), float(y)])
    return corners


def object_points(inner_cols, inner_rows, square_m):
    pts = []
    for r in range(int(inner_rows)):
        for c in range(int(inner_cols)):
            pts.append([c * float(square_m), r * float(square_m), 0.0])
    return np.asarray(pts, dtype=np.float64)


def _reprojection(corners, obj, k):
    # Use a plane homography implied by K and a fronto-parallel guess: fit H then compare.
    src = obj[:, :2]
    h = homography(src, corners)
    if h is None:
        return None
    pred = []
    for x, y in src:
        p = h @ np.array([x, y, 1.0])
        pred.append(p[:2] / p[2])
    pred = np.asarray(pred)
    err = np.linalg.norm(pred - np.asarray(corners, dtype=np.float64), axis=1)
    return float(err.mean()), h


def solve_intrinsics(views, width, height):
    """views: list of {corners, inner_cols, inner_rows, square_m}."""
    if not views:
        return None
    try:
        import cv2
        obj = []
        img = []
        for view in views:
            op = object_points(view["inner_cols"], view["inner_rows"], view["square_m"])[:, :3]
            ip = np.asarray(view["corners"], dtype=np.float64).reshape(-1, 1, 2)
            obj.append(op.astype(np.float32))
            img.append(ip.astype(np.float32))
        rms, camera, dist, _r, _t = cv2.calibrateCamera(obj, img, (int(width), int(height)), None, None)
        return {
            "fx": float(camera[0, 0]),
            "fy": float(camera[1, 1]),
            "cx": float(camera[0, 2]),
            "cy": float(camera[1, 2]),
            "distortion": {
                "model": "radtan",
                "k1": float(dist.ravel()[0]) if dist.size > 0 else 0.0,
                "k2": float(dist.ravel()[1]) if dist.size > 1 else 0.0,
                "p1": float(dist.ravel()[2]) if dist.size > 2 else 0.0,
                "p2": float(dist.ravel()[3]) if dist.size > 3 else 0.0,
                "k3": float(dist.ravel()[4]) if dist.size > 4 else 0.0,
            },
            "rms_px": float(rms),
            "solver": "opencv",
        }
    except Exception:
        pass
    view = views[-1]
    corners = np.asarray(view["corners"], dtype=np.float64)
    if corners.shape[0] < 4:
        return None
    cx = (float(width) - 1) / 2.0
    cy = (float(height) - 1) / 2.0
    # Span of the grid in pixels versus metres gives a focal length once the
    # board is treated as fronto-parallel at an unknown distance. The search
    # below only has to make the two homography columns consistent.
    span = float(np.linalg.norm(corners[min(len(corners) - 1, view["inner_cols"] - 1)] - corners[0]))
    world = max(1e-6, float(view["square_m"]) * max(1, int(view["inner_cols"]) - 1))
    # A board filling ~span px of a ~width image, a few metres away, is not
    # observable from one view without a size. We still recover the ratio
    # fx / Z. Store fx so that a 1 m board-distance would match the span,
    # then refine by orthogonality. Callers that know the range can scale.
    guess = max(50.0, (span / world) * 1.0)
    obj = object_points(view["inner_cols"], view["inner_rows"], view["square_m"])
    h = homography(obj[:, :2], corners)
    if h is None:
        return None

    def cost(f):
        k = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
        m = np.linalg.inv(k) @ h
        r1 = m[:, 0]
        r2 = m[:, 1]
        n1 = np.linalg.norm(r1)
        n2 = np.linalg.norm(r2)
        if n1 < 1e-9 or n2 < 1e-9:
            return 1e6
        return abs(float(np.dot(r1, r2)) / (n1 * n2)) + abs(n1 - n2) / max(n1, n2)

    best_f = guess
    best_c = cost(guess)
    for scale in np.linspace(0.25, 4.0, 40):
        f = guess * float(scale)
        c = cost(f)
        if c < best_c:
            best_c = c
            best_f = f
    rms, _h = _reprojection(corners, obj, None)
    return {
        "fx": float(best_f),
        "fy": float(best_f),
        "cx": cx,
        "cy": cy,
        "distortion": {"model": "radtan", "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0, "k3": 0.0},
        "rms_px": None if rms is None else float(rms),
        "solver": "homography",
        "orthogonality": float(best_c),
    }


def calibration_document(solved, width, height, version, notes=""):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "schema": SCHEMA,
        "version": int(version),
        "camera": "cam0",
        "created_utc": now,
        "image_width": int(width),
        "image_height": int(height),
        "intrinsics": {
            "fx": solved["fx"],
            "fy": solved["fy"],
            "cx": solved["cx"],
            "cy": solved["cy"],
        },
        "distortion": solved["distortion"],
        "rms_px": solved.get("rms_px"),
        "solver": solved.get("solver"),
        "camera_to_body": None,
        "notes": notes or "camera_to_body is reserved for a later extrinsic calibration",
    }


def save_calibration(directory, document):
    dest = Path(directory)
    dest.mkdir(parents=True, exist_ok=True)
    version = int(document["version"])
    path = dest / f"v{version}.json"
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    latest = dest / "latest.json"
    latest.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return path


def load_latest(directory):
    path = Path(directory) / "latest.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
