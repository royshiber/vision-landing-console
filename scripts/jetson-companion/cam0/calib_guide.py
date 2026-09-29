"""Guided checkerboard calibration for one camera.

A view is kept only when the board is found and its pose is not a repeat.
OpenCV findChessboardCorners is used when OpenCV imports. The grid finder
in calibration.py is the fallback, so the same frames still solve offline.
"""

from __future__ import annotations

import numpy as np

from .calibration import (
    calibration_document,
    find_checkerboard,
    save_calibration,
    solve_intrinsics,
)

TARGET_VIEWS = 20
BOARD_COLS = 9
BOARD_ROWS = 6
SQUARE_MM = 25

HINTS = {
    "search": "החזק לוח שחמט מול המצלמה",
    "closer": "קרב את הלוח",
    "farther": "הרחק את הלוח",
    "tilt": "הטה את הלוח",
    "corners": "הזז לפינה",
    "hold": "החזק",
    "done": "יש מספיק צילומים",
}


def verdict_he(rms):
    if rms is None:
        return "לא נמדד"
    if rms < 0.5:
        return "מצוין"
    if rms < 1.0:
        return "טוב"
    if rms < 2.0:
        return "סביר"
    return "חלש"


def find_corners(mono, inner_cols, inner_rows):
    """Inner corners. OpenCV first, then the offline grid finder."""
    img = np.asarray(mono)
    if img.ndim == 3:
        img = img[:, :, 0]
    img = np.ascontiguousarray(img, dtype=np.uint8)
    try:
        import cv2
        flags = cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
        ok, found = cv2.findChessboardCorners(img, (int(inner_cols), int(inner_rows)), flags)
        if ok and found is not None:
            return np.asarray(found, dtype=np.float64).reshape(-1, 2).tolist()
    except Exception:
        pass
    return find_checkerboard(img, inner_cols, inner_rows)


def _measure(corners, width, height, cols):
    pts = np.asarray(corners, dtype=np.float64)
    minx, miny = pts.min(axis=0)
    maxx, maxy = pts.max(axis=0)
    bw = max(1.0, float(maxx - minx))
    bh = max(1.0, float(maxy - miny))
    area = (bw * bh) / float(max(1, int(width)) * max(1, int(height)))
    cx = ((minx + maxx) / 2.0) / float(width)
    cy = ((miny + maxy) / 2.0) / float(height)
    top = pts[int(cols) - 1] - pts[0]
    side_i = max(0, len(pts) - int(cols))
    side = pts[side_i] - pts[0]
    n1 = float(np.linalg.norm(top)) or 1.0
    n2 = float(np.linalg.norm(side)) or 1.0
    tilt = abs(float(np.dot(top, side) / (n1 * n2)))
    return {"cx": float(cx), "cy": float(cy), "area": float(area), "tilt": float(tilt)}


def _close(sig, prev):
    return (
        abs(sig["cx"] - prev["cx"]) < 0.12
        and abs(sig["cy"] - prev["cy"]) < 0.12
        and abs(sig["area"] - prev["area"]) < 0.06
        and abs(sig["tilt"] - prev["tilt"]) < 0.12
    )


def _spread(accepted):
    if not accepted:
        return False
    return any(p["cx"] < 0.35 or p["cx"] > 0.65 or p["cy"] < 0.35 or p["cy"] > 0.65 for p in accepted)


def _tilted(accepted):
    return any(p["tilt"] >= 0.18 for p in accepted)


def decide_pose(sig, accepted):
    """Return (hint key, keep). Size and repeats never count as a new view."""
    if sig["area"] < 0.10:
        return "closer", False
    if sig["area"] > 0.65:
        return "farther", False
    if any(_close(sig, prev) for prev in accepted):
        if not _spread(accepted):
            return "corners", False
        if not _tilted(accepted):
            return "tilt", False
        return "farther" if sig["area"] >= 0.35 else "closer", False
    if accepted and not _spread(accepted) and 0.35 <= sig["cx"] <= 0.65 and 0.35 <= sig["cy"] <= 0.65:
        return "corners", False
    centered = 0.35 <= sig["cx"] <= 0.65 and 0.35 <= sig["cy"] <= 0.65
    if len(accepted) >= 3 and not _tilted(accepted) and sig["tilt"] < 0.15 and centered:
        return "tilt", False
    return "hold", True


def handle_session(session, body, frame_getter, directory):
    body = body or {}
    action = str(body.get("action") or "status")
    if action == "start":
        return session.start(body.get("inner_cols"), body.get("inner_rows"), body.get("square_mm"))
    if action == "retry":
        return session.retry()
    if action == "save":
        return session.save(directory)
    if action == "observe":
        mono, width, height = frame_getter()
        return session.observe(mono, width, height)
    return session.status()


class CalibSession:
    def __init__(self, camera="cam0", target=TARGET_VIEWS):
        self.camera = camera
        self.target = int(target)
        self.inner_cols = BOARD_COLS
        self.inner_rows = BOARD_ROWS
        self.square_mm = SQUARE_MM
        self.phase = "idle"
        self.views = []
        self.poses = []
        self.hint_key = "search"
        self.draft = None
        self.saved = False
        self.width = 0
        self.height = 0

    def start(self, inner_cols=None, inner_rows=None, square_mm=None):
        cols = int(inner_cols or BOARD_COLS)
        rows = int(inner_rows or BOARD_ROWS)
        square = float(square_mm or SQUARE_MM)
        if cols < 3 or rows < 3 or square <= 0:
            return self.status()
        self.inner_cols = cols
        self.inner_rows = rows
        self.square_mm = square
        self.phase = "running"
        self.views = []
        self.poses = []
        self.hint_key = "search"
        self.draft = None
        self.saved = False
        return self.status()

    def retry(self):
        self.phase = "idle"
        self.views = []
        self.poses = []
        self.hint_key = "search"
        self.draft = None
        self.saved = False
        return self.status()

    def observe(self, mono, width, height):
        if self.phase != "running":
            return self.status()
        self.width = int(width or 0)
        self.height = int(height or 0)
        if mono is None or self.width < 16 or self.height < 16:
            self.hint_key = "search"
            return self.status()
        corners = find_corners(mono, self.inner_cols, self.inner_rows)
        need = int(self.inner_cols) * int(self.inner_rows)
        if not corners or len(corners) != need:
            self.hint_key = "search"
            return self.status()
        sig = _measure(corners, self.width, self.height, self.inner_cols)
        key, keep = decide_pose(sig, self.poses)
        self.hint_key = key
        if keep:
            self.poses.append(sig)
            self.views.append({
                "corners": corners,
                "inner_cols": self.inner_cols,
                "inner_rows": self.inner_rows,
                "square_m": float(self.square_mm) / 1000.0,
            })
            self.hint_key = "hold"
        if len(self.views) >= self.target:
            self._solve()
        return self.status()

    def _solve(self):
        solved = solve_intrinsics(self.views, self.width, self.height)
        if not solved:
            self.phase = "review"
            self.hint_key = "done"
            self.draft = None
            return
        board = {
            "inner_cols": self.inner_cols,
            "inner_rows": self.inner_rows,
            "square_mm": self.square_mm,
        }
        self.draft = calibration_document(
            solved,
            self.width,
            self.height,
            1,
            camera=self.camera,
            board=board,
        )
        self.draft["verdict"] = verdict_he(solved.get("rms_px"))
        self.phase = "review"
        self.hint_key = "done"
        self.saved = False

    def save(self, directory):
        if self.draft is None or not directory:
            return self.status()
        save_calibration(directory, self.draft)
        self.saved = True
        return self.status()

    def status(self):
        rms = None if not self.draft else self.draft.get("rms_px")
        return {
            "ok": True,
            "camera": self.camera,
            "phase": self.phase,
            "captured": len(self.views),
            "target": self.target,
            "progress": f"{len(self.views)}/{self.target}",
            "hint_key": self.hint_key,
            "hint": HINTS.get(self.hint_key, HINTS["search"]),
            "board": {
                "inner_cols": self.inner_cols,
                "inner_rows": self.inner_rows,
                "square_mm": self.square_mm,
            },
            "rms_px": rms,
            "verdict": None if self.draft is None else self.draft.get("verdict"),
            "saved": self.saved,
            "flight_commands": False,
        }
