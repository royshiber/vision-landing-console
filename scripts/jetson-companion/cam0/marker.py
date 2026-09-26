"""4x4 landing-marker codec and pose.

The embedded dictionary is what the synthetic source draws and what the
detector matches when OpenCV's aruco module is absent. When cv2.aruco is
importable, detections from DICT_4X4_50 are accepted as well.

This module only returns geometry. It does not import a MAVLink sender.
"""

from __future__ import annotations

import time

import numpy as np

from .jpegenc import cv2_module

# Full-frame detection is pure Python when OpenCV is absent. Cap it so the
# GIL is not held on every capture.
MARKER_HZ = 15.0

# Stable codes, minimum Hamming distance 5, seed 9281.
DICTIONARY = {
    0: 0x0F1E,
    1: 0x1248,
    2: 0x1B2D,
    3: 0x21B4,
    4: 0x2C63,
    5: 0x33C9,
    6: 0x38A7,
    7: 0x46E1,
    8: 0x4D5A,
    9: 0x52B6,
    10: 0x595C,
    11: 0x66A5,
    12: 0x6D0F,
    13: 0x70E2,
    14: 0x7B19,
    15: 0x85C3,
}
_BITS_TO_ID = {bits: mid for mid, bits in DICTIONARY.items()}
DICT_NAME = "airvix4x4"


def marker_bits(marker_id):
    if int(marker_id) not in DICTIONARY:
        raise KeyError(marker_id)
    return DICTIONARY[int(marker_id)]


def render_marker(marker_id, modules=8):
    """Return a uint8 image of the marker, black border included (6x6 cells)."""
    bits = marker_bits(marker_id)
    cells = 6
    img = np.zeros((cells * modules, cells * modules), dtype=np.uint8)
    for r in range(4):
        for c in range(4):
            bit = (bits >> (15 - (r * 4 + c))) & 1
            if bit:
                y0 = (r + 1) * modules
                x0 = (c + 1) * modules
                img[y0:y0 + modules, x0:x0 + modules] = 255
    return img


def _rot_bits(bits, turns):
    grid = [((bits >> (15 - i)) & 1) for i in range(16)]
    m = np.array(grid, dtype=np.uint8).reshape(4, 4)
    m = np.rot90(m, k=int(turns))
    out = 0
    flat = m.reshape(-1)
    for i, bit in enumerate(flat):
        out = (out << 1) | int(bit)
    return out


def match_bits(bits):
    for turns in range(4):
        mid = _BITS_TO_ID.get(_rot_bits(bits, turns))
        if mid is not None:
            return mid, turns
    return None, None


def _sample_bits(mono, corners):
    """corners: TL TR BR BL in pixel coordinates. Returns 16-bit code or None."""
    tl, tr, br, bl = [np.asarray(p, dtype=np.float64) for p in corners]
    bits = 0
    h, w = mono.shape
    for r in range(4):
        for c in range(4):
            ur = (r + 1.5) / 6.0
            uc = (c + 1.5) / 6.0
            top = tl + (tr - tl) * uc
            bot = bl + (br - bl) * uc
            p = top + (bot - top) * ur
            x = int(round(p[0]))
            y = int(round(p[1]))
            if x < 0 or y < 0 or x >= w or y >= h:
                return None
            bit = 1 if mono[y, x] >= 128 else 0
            bits = (bits << 1) | bit
    return bits


def _border_ok(mono, corners):
    tl, tr, br, bl = [np.asarray(p, dtype=np.float64) for p in corners]
    h, w = mono.shape
    dark = 0
    total = 0
    for i in range(24):
        t = i / 24.0
        for a, b in ((tl, tr), (tr, br), (br, bl), (bl, tl)):
            p = a + (b - a) * t
            x = int(round(p[0]))
            y = int(round(p[1]))
            if 0 <= x < w and 0 <= y < h:
                total += 1
                if mono[y, x] < 80:
                    dark += 1
    return total > 0 and dark / total > 0.65


def _components(mask):
    cv2 = cv2_module()
    if cv2 is not None and hasattr(cv2, "findContours"):
        try:
            return _components_cv2(mask, cv2)
        except Exception:
            pass
    return _components_python(mask)


def _components_cv2(mask, cv2):
    """Connected boxes via OpenCV. findContours releases the GIL."""
    img = np.zeros(mask.shape, dtype=np.uint8)
    img[mask] = 255
    found = cv2.findContours(img, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = found[0] if len(found) == 2 else found[1]
    boxes = []
    h, w = mask.shape
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        if bw < 6 or bh < 6:
            continue
        x1 = min(w, x + bw)
        y1 = min(h, y + bh)
        count = int(np.count_nonzero(mask[y:y1, x:x1]))
        if count < 16:
            continue
        boxes.append((int(x), int(y), int(x1 - 1), int(y1 - 1), count))
    return boxes


def _components_python(mask):
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=np.uint8)
    boxes = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if visited[y0, x0]:
            continue
        stack = [(y0, x0)]
        visited[y0, x0] = 1
        minx = maxx = x0
        miny = maxy = y0
        count = 0
        while stack:
            y, x = stack.pop()
            count += 1
            if x < minx:
                minx = x
            if x > maxx:
                maxx = x
            if y < miny:
                miny = y
            if y > maxy:
                maxy = y
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if ny < 0 or nx < 0 or ny >= h or nx >= w:
                    continue
                if visited[ny, nx] or not mask[ny, nx]:
                    continue
                visited[ny, nx] = 1
                stack.append((ny, nx))
        bw = maxx - minx + 1
        bh = maxy - miny + 1
        if count >= 16 and bw >= 6 and bh >= 6:
            boxes.append((minx, miny, maxx, maxy, count))
    return boxes


def detect_markers(mono8, max_side=320):
    """Find embedded-dictionary markers. Returns a list of corner quads."""
    img = np.asarray(mono8, dtype=np.uint8)
    h, w = img.shape
    scale = 1.0
    if max(h, w) > max_side:
        scale = max_side / float(max(h, w))
        ys = (np.arange(int(h * scale)) / scale).astype(np.int32)
        xs = (np.arange(int(w * scale)) / scale).astype(np.int32)
        small = img[ys][:, xs]
    else:
        small = img
    dark = small < 80
    found = []
    seen = set()
    for minx, miny, maxx, maxy, _count in _components(dark):
        bw = maxx - minx + 1
        bh = maxy - miny + 1
        if bw < 8 or bh < 8:
            continue
        if bw > small.shape[1] * 0.92 and bh > small.shape[0] * 0.92:
            continue
        ratio = bw / float(bh)
        if ratio < 0.6 or ratio > 1.6:
            continue
        corners_s = np.array([
            [minx, miny],
            [maxx, miny],
            [maxx, maxy],
            [minx, maxy],
        ], dtype=np.float64)
        corners = corners_s / scale
        if not _border_ok(img, corners):
            continue
        bits = _sample_bits(img, corners)
        if bits is None:
            continue
        mid, _turns = match_bits(bits)
        if mid is None:
            continue
        key = (mid, int(corners[0, 0] // 4), int(corners[0, 1] // 4))
        if key in seen:
            continue
        seen.add(key)
        found.append({
            "id": int(mid),
            "corners": [[float(p[0]), float(p[1])] for p in corners],
            "dictionary": DICT_NAME,
        })
    return found


def homography(src_xy, dst_xy):
    src = np.asarray(src_xy, dtype=np.float64)
    dst = np.asarray(dst_xy, dtype=np.float64)
    a = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        a.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.asarray(a, dtype=np.float64))
    h = vt[-1].reshape(3, 3)
    if abs(h[2, 2]) < 1e-12:
        return None
    return h / h[2, 2]


def pose_from_corners(corners, marker_size_m, intrinsics):
    """Planar pose of the marker in the camera frame. Returns None without K."""
    if not intrinsics or not marker_size_m:
        return None
    fx = intrinsics.get("fx")
    fy = intrinsics.get("fy")
    cx = intrinsics.get("cx")
    cy = intrinsics.get("cy")
    if None in (fx, fy, cx, cy) or fx == 0 or fy == 0:
        return None
    s = float(marker_size_m) / 2.0
    obj = np.array([[-s, -s], [s, -s], [s, s], [-s, s]], dtype=np.float64)
    img = np.asarray(corners, dtype=np.float64)
    h = homography(obj, img)
    if h is None:
        return None
    k = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)
    m = np.linalg.inv(k) @ h
    r1 = m[:, 0]
    r2 = m[:, 1]
    t = m[:, 2]
    n1 = np.linalg.norm(r1)
    if n1 < 1e-9:
        return None
    r1 = r1 / n1
    r2 = r2 / n1
    t = t / n1
    if t[2] < 0:
        r1 = -r1
        r2 = -r2
        t = -t
    r3 = np.cross(r1, r2)
    rot = np.column_stack([r1, r2, r3])
    u, _, vt = np.linalg.svd(rot)
    rot = u @ vt
    if np.linalg.det(rot) < 0:
        rot = u @ np.diag([1, 1, -1]) @ vt
    distance = float(np.linalg.norm(t))
    return {
        "r_cam": [[float(v) for v in row] for row in rot],
        "t_cam_m": [float(t[0]), float(t[1]), float(t[2])],
        "distance_m": distance,
    }


_aruco_detector = None
_aruco_failed = False


def try_opencv_detect(mono8):
    global _aruco_detector, _aruco_failed
    if _aruco_failed:
        return None
    cv2 = cv2_module()
    if cv2 is None or not hasattr(cv2, "aruco"):
        return None
    if _aruco_detector is None:
        try:
            dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
            params = cv2.aruco.DetectorParameters()
            _aruco_detector = cv2.aruco.ArucoDetector(dictionary, params)
        except Exception:
            _aruco_failed = True
            return None
    corners, ids, _ = _aruco_detector.detectMarkers(np.asarray(mono8))
    if ids is None:
        return []
    out = []
    for quad, mid in zip(corners, ids.flatten()):
        pts = quad.reshape(-1, 2)
        out.append({
            "id": int(mid),
            "corners": [[float(p[0]), float(p[1])] for p in pts],
            "dictionary": "DICT_4X4_50",
        })
    return out


def detect(mono8, intrinsics=None, marker_size_m=0.16):
    own = detect_markers(mono8)
    extra = try_opencv_detect(mono8) or []
    merged = list(own)
    for item in extra:
        if any(hit["id"] == item["id"] and hit["dictionary"] == item["dictionary"] for hit in merged):
            continue
        merged.append(item)
    for item in merged:
        pose = pose_from_corners(item["corners"], marker_size_m, intrinsics)
        if pose:
            item.update(pose)
        else:
            item["r_cam"] = None
            item["t_cam_m"] = None
            item["distance_m"] = None
    return merged


class MarkerModule:
    """Frame-bus module. Output only.

    Detection runs at MARKER_HZ. Skipped frames return None so the host keeps
    the previous result and this thread does not hold the GIL.
    """

    name = "marker"
    min_interval_s = 1.0 / MARKER_HZ

    def __init__(self, intrinsics=None, marker_size_m=0.16):
        self.intrinsics = intrinsics
        self.marker_size_m = float(marker_size_m)
        self._next = 0.0

    def on_frame(self, view):
        now = time.monotonic()
        if now < self._next:
            return None
        self._next = now + self.min_interval_s
        mono = None if view.mono8 is None else np.array(view.mono8, dtype=np.uint8, copy=True)
        detections = detect(mono, self.intrinsics, self.marker_size_m)
        return {
            "module": self.name,
            "frame_index": view.index,
            "detections": detections,
            "commands_sent": 0,
        }
