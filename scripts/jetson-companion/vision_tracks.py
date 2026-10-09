#!/usr/bin/env python3
"""Object detection and stable tracks for one companion camera.

Off unless enabled. A URL or a camera id alone does not start detection.
TensorRT is used when an engine file and the tensorrt module are both present.
ONNX is the next choice when a model file and onnxruntime are present.
The CPU path finds saturated color blobs and is only for the sample fixture
and an explicit sim backend. It is not selected automatically, so a live
camera without a model never grows invented boxes.

Lock stores a target id. Gimbal steering is a second switch, default off.
It may send a gimbal rate only when that switch is on, a track is locked,
and the gimbal status says it is present and control is enabled. It never
sends a flight-controller command.

Jetson frames per second were not measured here.
"""

from __future__ import annotations

import math
import os
import threading
from pathlib import Path

CAMERAS = ("cam0", "cam1", "cam2", "cam3")
REASON_OFF = "הזיהוי כבוי"
REASON_NO_STREAM = "אין נתון על זרם המצלמות"
REASON_NO_MODEL = "אין מודל זיהוי"
REASON_STEER_OFF = "היגוי הגימבל כבוי"
REASON_GIMBAL_ABSENT = "הגימבל לא עונה. היגוי לא נשלח."
REASON_GIMBAL_DISABLED = "שליטת גימבל כבויה. היגוי לא נשלח."
REASON_NO_LOCK = "אין נעילה. היגוי לא נשלח."
REASON_STEER_SENT = "היגוי נשלח לגימבל."

COCO_NAMES = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
    "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
    "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
)

CLASS_HE = {
    "person": "אדם",
    "bicycle": "אופניים",
    "car": "רכב",
    "motorcycle": "אופנוע",
    "airplane": "מטוס",
    "bus": "אוטובוס",
    "train": "רכבת",
    "truck": "משאית",
    "boat": "סירה",
    "bird": "ציפור",
    "cat": "חתול",
    "dog": "כלב",
    "horse": "סוס",
    "cow": "פרה",
    "bear": "דוב",
    "backpack": "תיק",
    "sports ball": "כדור",
    "chair": "כיסא",
    "bottle": "בקבוק",
    "cell phone": "טלפון",
}

SAMPLE_W = 96
SAMPLE_H = 64
_SERVICE = None
_SERVICE_LOCK = threading.Lock()


def class_label(name):
    key = str(name or "").strip().lower()
    return CLASS_HE.get(key) or ""


def _flag(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return None


def _env_flag(env, key, default="0"):
    return _flag(env.get(key, default)) is True


def iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    if aw <= 0 or ah <= 0 or bw <= 0 or bh <= 0:
        return 0.0
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    union = aw * ah + bw * bh - inter
    if union <= 0:
        return 0.0
    return inter / union


def _same_class(track, det):
    det_cls = str(det.get("class") or "")
    return not track.cls or not det_cls or track.cls == det_cls


def _pair_score(track, det):
    if not _same_class(track, det):
        return -1.0
    return max(iou(track.bbox, det["bbox"]), iou(track.last_bbox, det["bbox"]))


def _centers_close(track, det):
    """Re-associate a jumped box of the same class before minting a new id."""
    if not _same_class(track, det):
        return False
    box = det["bbox"]
    bx = box[0] + box[2] / 2.0
    by = box[1] + box[3] / 2.0
    for src in (track.bbox, track.last_bbox):
        ax = src[0] + src[2] / 2.0
        ay = src[1] + src[3] / 2.0
        reach = max(src[2], src[3], box[2], box[3], 1.0) * 2.0
        if math.hypot(ax - bx, ay - by) <= reach:
            return True
    return False


def _match(tracks, dets, score_min, score_fn):
    pairs = []
    for ti, track in enumerate(tracks):
        for di, det in enumerate(dets):
            score = score_fn(track, det)
            if score >= score_min:
                pairs.append((score, ti, di))
    pairs.sort(key=lambda item: item[0], reverse=True)
    used_t = set()
    used_d = set()
    matches = []
    for _score, ti, di in pairs:
        if ti in used_t or di in used_d:
            continue
        used_t.add(ti)
        used_d.add(di)
        matches.append((ti, di))
    return matches, used_t, used_d


class Track:
    def __init__(self, track_id, det):
        self.id = track_id
        self.cls = det["class"]
        self.confidence = float(det["confidence"])
        self.bbox = list(det["bbox"])
        self.last_bbox = list(det["bbox"])
        self.age = 1
        self.hits = 1
        self.misses = 0
        self.velocity = (0.0, 0.0)
        self.color_he = str(det.get("color_he") or "").strip()

    def predict(self):
        vx, vy = self.velocity
        x, y, w, h = self.bbox
        self.bbox = [x + vx, y + vy, w, h]
        self.age += 1
        self.misses += 1

    def update(self, det):
        new = list(det["bbox"])
        dx = new[0] - self.last_bbox[0]
        dy = new[1] - self.last_bbox[1]
        self.velocity = (self.velocity[0] * 0.6 + dx * 0.4, self.velocity[1] * 0.6 + dy * 0.4)
        self.bbox = new
        self.last_bbox = list(new)
        self.confidence = float(det["confidence"])
        if det.get("class"):
            self.cls = det["class"]
        if det.get("color_he"):
            self.color_he = str(det.get("color_he") or "").strip()
        else:
            self.color_he = ""
        self.hits += 1
        self.misses = 0

    def public(self):
        x, y, w, h = self.bbox
        row = {
            "id": self.id,
            "class": self.cls,
            "label_he": class_label(self.cls),
            "confidence": round(float(self.confidence), 4),
            "bbox": [round(x, 2), round(y, 2), round(w, 2), round(h, 2)],
            "age": int(self.age),
        }
        if self.color_he:
            row["color_he"] = self.color_he
        return row


class ByteTracker:
    """Two-threshold association. High scores may start a track. Low scores only extend one."""

    def __init__(self, high=0.5, low=0.1, match_iou=0.2, max_age=30, keep_misses=8):
        self.high = float(high)
        self.low = float(low)
        self.match_iou = float(match_iou)
        self.max_age = int(max_age)
        self.keep_misses = int(keep_misses)
        self.tracks = []
        self._next = 1

    def update(self, detections):
        dets = []
        for det in detections or []:
            bbox = det.get("bbox")
            if not bbox or len(bbox) < 4:
                continue
            conf = float(det.get("confidence") or 0)
            if conf < self.low:
                continue
            item = {
                "class": str(det.get("class") or "object"),
                "confidence": conf,
                "bbox": [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
            }
            color = str(det.get("color_he") or "").strip()
            if color:
                item["color_he"] = color
            dets.append(item)
        for track in self.tracks:
            track.predict()
        high = [det for det in dets if det["confidence"] >= self.high]
        low = [det for det in dets if det["confidence"] < self.high]
        matches, used_t, used_d = _match(self.tracks, high, self.match_iou, _pair_score)
        for ti, di in matches:
            self.tracks[ti].update(high[di])
        left_index = [i for i in range(len(self.tracks)) if i not in used_t]
        left_tracks = [self.tracks[i] for i in left_index]
        low_matches, _used_low_t, used_low_d = _match(left_tracks, low, self.match_iou, _pair_score)
        for local_i, di in low_matches:
            self.tracks[left_index[local_i]].update(low[di])
            used_t.add(left_index[local_i])
        for di, det in enumerate(high):
            if di in used_d:
                continue
            host = next((i for i, track in enumerate(self.tracks) if i not in used_t and _centers_close(track, det)), None)
            if host is None:
                self.tracks.append(Track(self._next, det))
                self._next += 1
                continue
            self.tracks[host].update(det)
            used_t.add(host)
        self.tracks = [track for track in self.tracks if track.misses <= self.max_age]
        return [track.public() for track in self.tracks if track.misses <= self.keep_misses]


def _rows_from_output(output):
    """Normalize YOLO-v8 style output to rows of cx, cy, w, h, class scores."""
    data = output
    while isinstance(data, (list, tuple)) and len(data) == 1 and isinstance(data[0], (list, tuple)):
        data = data[0]
    if not data or not isinstance(data, (list, tuple)):
        return []
    first = data[0]
    if isinstance(first, (int, float)):
        return []
    if isinstance(first, (list, tuple)) and first and isinstance(first[0], (list, tuple)):
        data = first
        first = data[0]
    if not isinstance(first, (list, tuple)):
        return []
    outer = len(data)
    inner = len(first)
    if outer in (84, 85) and inner > outer:
        return [[data[channel][col] for channel in range(outer)] for col in range(inner)]
    return [list(row) for row in data]


def decode_yolo_v8(output, src_w, src_h, input_size=640, ratio=1.0, pad_x=0.0, pad_y=0.0, conf=0.25, iou_thres=0.45):
    rows = _rows_from_output(output)
    dets = []
    ratio = ratio or 1.0
    for row in rows:
        if len(row) < 6:
            continue
        scores = [float(value) for value in row[4:]]
        best_i = max(range(len(scores)), key=lambda i: scores[i])
        score = scores[best_i]
        if score < conf:
            continue
        cx, cy, bw, bh = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
        x = (cx - bw / 2.0 - pad_x) / ratio
        y = (cy - bh / 2.0 - pad_y) / ratio
        w = bw / ratio
        h = bh / ratio
        x = max(0.0, min(float(src_w), x))
        y = max(0.0, min(float(src_h), y))
        w = max(0.0, min(float(src_w) - x, w))
        h = max(0.0, min(float(src_h) - y, h))
        if w < 1 or h < 1:
            continue
        name = COCO_NAMES[best_i] if best_i < len(COCO_NAMES) else "object"
        dets.append({
            "class": name,
            "confidence": score,
            "bbox": [x, y, w, h],
        })
    return nms(dets, iou_thres)


def nms(dets, iou_thres):
    ordered = sorted(dets, key=lambda det: det["confidence"], reverse=True)
    kept = []
    for det in ordered:
        if all(iou(det["bbox"], other["bbox"]) < iou_thres for other in kept):
            kept.append(det)
    return kept


def _fill(buf, width, height, box, color):
    x, y, w, h = [int(round(v)) for v in box]
    for yy in range(max(0, y), min(height, y + h)):
        for xx in range(max(0, x), min(width, x + w)):
            i = (yy * width + xx) * 3
            buf[i:i + 3] = bytes(color)


def sample_frame(index):
    """Known rectangles. Red is a person, green is a car, blue is a truck from frame 1."""
    buf = bytearray([16, 16, 16] * SAMPLE_W * SAMPLE_H)
    objects = [
        ("person", [8 + int(index) * 4, 10, 18, 30], (220, 30, 30)),
        ("car", [50, 28, 30, 16], (30, 200, 40)),
    ]
    if int(index) >= 1:
        objects.append(("truck", [60, 4, 22, 18], (30, 40, 220)))
    for name, box, color in objects:
        _fill(buf, SAMPLE_W, SAMPLE_H, box, color)
    truth = [{"class": name, "bbox": box} for name, box, _color in objects]
    return SAMPLE_W, SAMPLE_H, bytes(buf), truth


def write_ppm(path, width, height, rgb):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    header = f"P6\n{int(width)} {int(height)}\n255\n".encode("ascii")
    path.write_bytes(header + bytes(rgb))


def read_ppm(path):
    data = Path(path).read_bytes()
    if not data.startswith(b"P6"):
        raise ValueError("not_ppm")
    parts = data.split(b"\n", 3)
    width, height = parts[1].split()
    pixels = parts[3]
    return int(width), int(height), pixels


BLOB_COLOR_HE = {
    "person": "אדום",
    "car": "ירוק",
    "truck": "כחול",
}


class CpuBlobDetector:
    """Saturated blobs for the sample film and the explicit CPU backend."""

    name = "cpu"

    def detect(self, width, height, rgb):
        if not rgb or width < 2 or height < 2:
            return []
        raw = rgb if isinstance(rgb, (bytes, bytearray)) else bytes(rgb)
        if len(raw) < width * height * 3:
            return []
        seen = bytearray(width * height)
        dets = []
        for y in range(height):
            for x in range(width):
                idx = y * width + x
                if seen[idx]:
                    continue
                kind = _pixel_class(raw, idx * 3)
                if not kind:
                    seen[idx] = 1
                    continue
                stack = [(x, y)]
                seen[idx] = 1
                minx = maxx = x
                miny = maxy = y
                count = 0
                while stack:
                    cx, cy = stack.pop()
                    count += 1
                    minx = min(minx, cx)
                    maxx = max(maxx, cx)
                    miny = min(miny, cy)
                    maxy = max(maxy, cy)
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if nx < 0 or ny < 0 or nx >= width or ny >= height:
                            continue
                        nidx = ny * width + nx
                        if seen[nidx]:
                            continue
                        if _pixel_class(raw, nidx * 3) != kind:
                            seen[nidx] = 1
                            continue
                        seen[nidx] = 1
                        stack.append((nx, ny))
                if count < 20:
                    continue
                dets.append({
                    "class": kind,
                    "confidence": 0.9,
                    "bbox": [float(minx), float(miny), float(maxx - minx + 1), float(maxy - miny + 1)],
                    "color_he": BLOB_COLOR_HE[kind],
                })
        return dets


def _pixel_class(raw, i):
    r, g, b = raw[i], raw[i + 1], raw[i + 2]
    if r > 160 and r > g + 40 and r > b + 40:
        return "person"
    if g > 150 and g > r + 40 and g > b + 40:
        return "car"
    if b > 150 and b > r + 40 and b > g + 40:
        return "truck"
    return ""


class OnnxYolo:
    name = "onnx"

    def __init__(self, model_path):
        self.model_path = model_path
        self.session = None
        self.error = None

    def load(self):
        if not self.model_path or not os.path.isfile(self.model_path):
            self.error = "model_missing"
            return False
        try:
            import onnxruntime as ort
        except ImportError:
            self.error = "onnxruntime_missing"
            return False
        try:
            self.session = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
            return True
        except Exception:
            self.error = "model_invalid"
            return False

    def detect(self, width, height, rgb):
        if self.session is None and not self.load():
            return []
        try:
            blob, ratio, pad_x, pad_y = _letterbox_nchw(rgb, width, height, 640)
            name = self.session.get_inputs()[0].name
            output = self.session.run(None, {name: blob})[0]
            listed = _numpy_to_lists(output)
            return decode_yolo_v8(listed, width, height, ratio=ratio, pad_x=pad_x, pad_y=pad_y)
        except Exception as exc:
            self.error = type(exc).__name__
            return []


class TensorRtYolo:
    name = "tensorrt"

    def __init__(self, engine_path):
        self.engine_path = engine_path
        self.engine = None
        self.context = None
        self.error = None

    def load(self):
        if not self.engine_path or not os.path.isfile(self.engine_path):
            self.error = "engine_missing"
            return False
        try:
            import tensorrt as trt
        except ImportError:
            self.error = "tensorrt_missing"
            return False
        try:
            logger = trt.Logger(trt.Logger.ERROR)
            runtime = trt.Runtime(logger)
            with open(self.engine_path, "rb") as handle:
                engine = runtime.deserialize_cuda_engine(handle.read())
            if engine is None:
                self.error = "engine_invalid"
                return False
            self.engine = engine
            self.context = engine.create_execution_context()
            return True
        except Exception:
            self.error = "engine_invalid"
            return False

    def detect(self, width, height, rgb):
        if self.context is None and not self.load():
            return []
        try:
            blob, ratio, pad_x, pad_y = _letterbox_nchw(rgb, width, height, 640)
            output = self._infer(blob)
            return decode_yolo_v8(_numpy_to_lists(output), width, height, ratio=ratio, pad_x=pad_x, pad_y=pad_y)
        except Exception as exc:
            self.error = type(exc).__name__
            return []

    def _infer(self, blob):
        import numpy as np
        engine = self.engine
        context = self.context
        names = []
        if hasattr(engine, "num_io_tensors"):
            names = [engine.get_tensor_name(i) for i in range(engine.num_io_tensors)]
            for name in names:
                mode = engine.get_tensor_mode(name)
                if mode == engine.get_tensor_mode(names[0]) and name == names[0]:
                    context.set_input_shape(name, blob.shape)
            outputs = {}
            bindings = []
            for name in names:
                mode = str(engine.get_tensor_mode(name))
                if "INPUT" in mode:
                    context.set_tensor_address(name, blob.ctypes.data)
                    bindings.append(name)
                else:
                    shape = tuple(context.get_tensor_shape(name))
                    buf = np.empty(shape, dtype=np.float32)
                    outputs[name] = buf
                    context.set_tensor_address(name, buf.ctypes.data)
            if hasattr(context, "execute_async_v3"):
                context.execute_async_v3(0)
            else:
                context.execute_v2([blob.ctypes.data, *[buf.ctypes.data for buf in outputs.values()]])
            if not outputs:
                raise RuntimeError("no_output")
            return next(iter(outputs.values()))
        raise RuntimeError("tensorrt_api")


def _numpy_to_lists(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def _letterbox_nchw(rgb, width, height, size):
    import numpy as np
    arr = np.frombuffer(rgb, dtype=np.uint8)
    arr = arr.reshape((height, width, 3))
    scale = min(size / width, size / height)
    nw = max(1, int(round(width * scale)))
    nh = max(1, int(round(height * scale)))
    # Nearest-neighbor resize keeps the fallback free of an image library.
    ys = (np.arange(nh) * (height / nh)).astype(np.int32)
    xs = (np.arange(nw) * (width / nw)).astype(np.int32)
    resized = arr[ys][:, xs]
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    pad_x = (size - nw) // 2
    pad_y = (size - nh) // 2
    canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    blob = canvas.astype(np.float32) / 255.0
    blob = np.transpose(blob, (2, 0, 1))[None, ...]
    return blob, scale, float(pad_x), float(pad_y)


def probe_backend(name, model_path, engine_path):
    wanted = (name or "auto").strip().lower()
    if wanted == "cpu":
        return "cpu", CpuBlobDetector(), None
    if wanted in {"auto", "tensorrt"} and engine_path and os.path.isfile(engine_path):
        det = TensorRtYolo(engine_path)
        if det.load():
            return "tensorrt", det, None
        if wanted == "tensorrt":
            return "unavailable", None, det.error or "engine_invalid"
    if wanted in {"auto", "onnx"} and model_path and os.path.isfile(model_path):
        det = OnnxYolo(model_path)
        if det.load():
            return "onnx", det, None
        if wanted == "onnx":
            return "unavailable", None, det.error or "model_invalid"
    if wanted == "tensorrt":
        return "unavailable", None, "engine_missing"
    if wanted == "onnx":
        return "unavailable", None, "model_missing"
    return "unavailable", None, "no_model"


def decide_steer(lock, frame_w, frame_h, *, enabled, gimbal_present, control_enabled):
    """Pure gate. allow_send is true only when every steer condition holds."""
    base = {
        "enabled": enabled is True,
        "sent": False,
        "blocked": True,
        "allow_send": False,
        "reason": "steer_off",
        "reason_he": REASON_STEER_OFF,
        "rate": None,
        "flight_commands": False,
    }
    if enabled is not True:
        return base
    if not lock or lock.get("id") is None:
        base["reason"] = "no_lock"
        base["reason_he"] = REASON_NO_LOCK
        return base
    bbox = lock.get("bbox")
    if not bbox or len(bbox) < 4 or not frame_w or not frame_h:
        base["reason"] = "no_bbox"
        base["reason_he"] = REASON_NO_LOCK
        return base
    if gimbal_present is not True:
        base["reason"] = "gimbal_absent"
        base["reason_he"] = REASON_GIMBAL_ABSENT
        return base
    if control_enabled is not True:
        base["reason"] = "gimbal_control_disabled"
        base["reason_he"] = REASON_GIMBAL_DISABLED
        return base
    rate = bbox_rate(bbox, frame_w, frame_h)
    base.update({
        "blocked": False,
        "allow_send": True,
        "reason": "ready",
        "reason_he": REASON_STEER_SENT,
        "rate": rate,
    })
    return base


def bbox_rate(bbox, frame_w, frame_h, kp=25.0):
    x, y, w, h = bbox
    ex = ((x + w / 2.0) - frame_w / 2.0) / (frame_w / 2.0)
    ey = ((y + h / 2.0) - frame_h / 2.0) / (frame_h / 2.0)
    yaw = max(-30.0, min(30.0, ex * kp))
    pitch = max(-30.0, min(30.0, ey * kp))
    return {"yaw": round(yaw, 2), "pitch": round(pitch, 2)}


def sort_tracks(tracks, mode):
    rows = list(tracks or [])
    if mode == "confidence":
        rows.sort(key=lambda row: (-float(row.get("confidence") or 0), int(row.get("id") or 0)))
    else:
        rows.sort(key=lambda row: (str(row.get("label_he") or row.get("class") or ""), int(row.get("id") or 0)))
    return rows


def rgb_from_packet(packet):
    if not isinstance(packet, dict):
        return None
    if packet.get("rgb") is not None and packet.get("width") and packet.get("height"):
        return int(packet["width"]), int(packet["height"]), packet["rgb"]
    bgr = packet.get("bgr")
    if bgr is not None:
        try:
            import numpy as np
            arr = np.asarray(bgr)
            if arr.ndim == 3 and arr.shape[2] >= 3:
                rgb = np.ascontiguousarray(arr[:, :, :3][:, :, ::-1])
                height, width = rgb.shape[:2]
                return int(width), int(height), rgb.tobytes()
        except Exception:
            return None
    jpeg = packet.get("jpeg")
    if jpeg:
        return _decode_jpeg(jpeg)
    return None


def _decode_jpeg(jpeg):
    try:
        import numpy as np
        import cv2
        arr = np.frombuffer(jpeg, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            return None
        rgb = np.ascontiguousarray(bgr[:, :, ::-1])
        height, width = rgb.shape[:2]
        return int(width), int(height), rgb.tobytes()
    except Exception:
        pass
    try:
        from PIL import Image
        import io
        image = Image.open(io.BytesIO(jpeg)).convert("RGB")
        return image.size[0], image.size[1], image.tobytes()
    except Exception:
        return None


def live_frame(camera):
    packet = None
    try:
        from camera_ingest import get_frame_bus
        packet = get_frame_bus().latest(camera)
    except Exception:
        packet = None
    if camera == "cam0":
        try:
            from cam0.service import get_service
            svc = get_service()
            jpeg = svc.frame_jpeg() if svc is not None else None
            if jpeg:
                return {"jpeg": jpeg}
        except Exception:
            pass
    return packet


class VisionTracks:
    def __init__(self, *, enabled=False, camera="", backend="auto", model_path="", engine_path="", gimbal_steer=False, frame_source=None, gimbal_status=None, gimbal_command=None, thread=False):
        self.enabled = bool(enabled)
        self.camera = camera if camera in CAMERAS else ""
        self.backend_name = backend or "auto"
        self.model_path = model_path or ""
        self.engine_path = engine_path or ""
        self.gimbal_steer = bool(gimbal_steer)
        self.frame_source = frame_source
        self.gimbal_status = gimbal_status
        self.gimbal_command = gimbal_command
        self.thread_allowed = bool(thread)
        self._frames = {}
        self._lock = threading.Lock()
        self.tracker = ByteTracker()
        self.tracks = []
        self.lock_target = None
        self.stream = False
        self.frame_width = None
        self.frame_height = None
        self.backend = "off"
        self.backend_error = None
        self.detector = None
        self.last_steer = decide_steer(None, None, None, enabled=False, gimbal_present=False, control_enabled=False)
        self._stop = threading.Event()
        self._thread = None
        self._sent_commands = 0
        self._resolve_backend()

    @classmethod
    def from_env(cls, env=None):
        src = env if env is not None else os.environ
        return cls(
            enabled=_env_flag(src, "VLC_VISION_DETECT", "0"),
            camera=str(src.get("VLC_VISION_CAMERA") or "").strip(),
            backend=str(src.get("VLC_VISION_BACKEND") or "auto").strip() or "auto",
            model_path=str(src.get("VLC_VISION_MODEL") or "").strip(),
            engine_path=str(src.get("VLC_VISION_ENGINE") or "").strip(),
            gimbal_steer=_env_flag(src, "VLC_VISION_GIMBAL_STEER", "0"),
            thread=False,
        )

    def _resolve_backend(self):
        if not self.enabled:
            self.backend = "off"
            self.detector = None
            self.backend_error = None
            return
        backend, detector, error = probe_backend(self.backend_name, self.model_path, self.engine_path)
        self.backend = backend
        self.detector = detector
        self.backend_error = error

    def configure(self, body):
        body = body if isinstance(body, dict) else {}
        with self._lock:
            if "enabled" in body:
                flag = _flag(body.get("enabled"))
                if flag is None:
                    return 400, {"ok": False, "reason": "bad_enabled", "flight_commands": False}
                self.enabled = flag
            if "camera" in body and body.get("camera") not in (None, ""):
                camera = str(body.get("camera") or "").strip()
                if camera not in CAMERAS:
                    return 400, {"ok": False, "reason": "bad_camera", "flight_commands": False}
                self.camera = camera
            if "gimbal_steer" in body:
                flag = _flag(body.get("gimbal_steer"))
                if flag is None:
                    return 400, {"ok": False, "reason": "bad_steer", "flight_commands": False}
                self.gimbal_steer = flag
            if self.enabled and not self.camera:
                self.enabled = False
                return 400, {"ok": False, "reason": "camera_required", "reason_he": "בחרו מצלמה", "flight_commands": False}
            if not self.enabled:
                self.tracks = []
                self.stream = False
                self.tracker = ByteTracker()
            self._resolve_backend()
        self._sync_thread()
        return 200, self.snapshot(self.camera)

    def push_frame(self, camera, width, height, rgb):
        with self._lock:
            self._frames[str(camera)] = {"width": int(width), "height": int(height), "rgb": rgb}

    def _packet(self, camera):
        if self.frame_source is not None:
            try:
                packet = self.frame_source(camera)
            except Exception:
                packet = None
            if packet:
                return packet
        return self._frames.get(camera)

    def step(self):
        with self._lock:
            enabled = self.enabled
            camera = self.camera
            detector = self.detector
            backend = self.backend
        if not enabled or not camera:
            with self._lock:
                self.tracks = []
                self.stream = False
                self.frame_width = None
                self.frame_height = None
            return self.snapshot(camera)
        if backend == "unavailable" or detector is None:
            with self._lock:
                self.tracks = []
                self.stream = self._packet(camera) is not None
            return self.snapshot(camera)
        decoded = rgb_from_packet(self._packet(camera))
        if not decoded:
            with self._lock:
                self.tracks = []
                self.stream = False
                self.frame_width = None
                self.frame_height = None
                self._apply_steer_locked()
            return self.snapshot(camera)
        width, height, rgb = decoded
        try:
            dets = detector.detect(width, height, rgb) or []
        except Exception:
            dets = []
        with self._lock:
            self.stream = True
            self.frame_width = width
            self.frame_height = height
            fresh = self.tracker.update(dets)
            self.tracks = fresh
            if self.lock_target and self.lock_target.get("camera") == camera:
                match = next((row for row in fresh if row["id"] == self.lock_target.get("id")), None)
                if match:
                    self.lock_target = {**self.lock_target, **match, "camera": camera}
            self._apply_steer_locked()
        return self.snapshot(camera)

    def _apply_steer_locked(self):
        status = {}
        if self.gimbal_steer and self.gimbal_status is not None:
            try:
                status = self.gimbal_status() or {}
            except Exception:
                status = {}
        decision = decide_steer(
            self.lock_target if self.lock_target and self.lock_target.get("camera") == self.camera else None,
            self.frame_width,
            self.frame_height,
            enabled=self.gimbal_steer,
            gimbal_present=status.get("present") is True,
            control_enabled=status.get("control_enabled") is True,
        )
        if decision.get("allow_send") and self.gimbal_command is not None:
            try:
                _code, body = self.gimbal_command("rate", decision.get("rate") or {})
            except Exception:
                body = {"sent": False}
            sent = isinstance(body, dict) and body.get("sent") is True
            decision["sent"] = sent
            decision["blocked"] = not sent
            decision["allow_send"] = False
            decision["flight_commands"] = False
            if sent:
                self._sent_commands += 1
                decision["reason"] = "sent"
                decision["reason_he"] = REASON_STEER_SENT
            else:
                decision["reason"] = (body or {}).get("reason") or "gimbal_rejected"
                decision["reason_he"] = REASON_GIMBAL_ABSENT
        self.last_steer = decision

    def lock(self, body):
        body = body if isinstance(body, dict) else {}
        action = str(body.get("action") or "lock").strip().lower()
        camera = str(body.get("camera") or self.camera or "").strip()
        if camera not in CAMERAS:
            return 400, {"ok": False, "reason": "bad_camera", "flight_commands": False}
        sort = "confidence" if body.get("sort") == "confidence" else "class"
        with self._lock:
            rows = sort_tracks([dict(row) for row in self.tracks] if self.camera == camera else [], sort)
            if action == "unlock":
                self.lock_target = None
            elif action == "next":
                if not rows:
                    return 200, self._snapshot_locked(camera, sort)
                ids = [row["id"] for row in rows]
                current = self.lock_target.get("id") if self.lock_target and self.lock_target.get("camera") == camera else None
                if current in ids:
                    pick = ids[(ids.index(current) + 1) % len(ids)]
                else:
                    pick = ids[0]
                chosen = next(row for row in rows if row["id"] == pick)
                self.lock_target = {**chosen, "camera": camera}
            else:
                try:
                    track_id = int(body.get("id"))
                except (TypeError, ValueError):
                    return 400, {"ok": False, "reason": "bad_id", "flight_commands": False}
                chosen = next((row for row in rows if row["id"] == track_id), None)
                if chosen is None:
                    return 404, {"ok": False, "reason": "no_track", "reason_he": "אין עצם", "flight_commands": False}
                self.lock_target = {**chosen, "camera": camera}
            self._apply_steer_locked()
            payload = self._snapshot_locked(camera, sort)
        return 200, payload

    def snapshot(self, camera, sort="class"):
        with self._lock:
            return self._snapshot_locked(camera, sort)

    def _snapshot_locked(self, camera, sort):
        camera = str(camera or "")
        active = self.enabled and self.camera == camera and camera in CAMERAS
        rows = sort_tracks(self.tracks, sort) if active else []
        if not self.enabled:
            reason = REASON_OFF
        elif not active:
            reason = REASON_OFF
        elif self.backend == "unavailable":
            reason = REASON_NO_MODEL
            rows = []
        elif not self.stream:
            reason = REASON_NO_STREAM
            rows = []
        else:
            reason = ""
        lock = None
        if self.lock_target and self.lock_target.get("camera") == camera:
            lock = {
                "id": self.lock_target.get("id"),
                "class": self.lock_target.get("class"),
                "label_he": self.lock_target.get("label_he") or class_label(self.lock_target.get("class")),
                "camera": camera,
                "bbox": self.lock_target.get("bbox"),
                "confidence": self.lock_target.get("confidence"),
            }
        steer = dict(self.last_steer)
        steer.pop("allow_send", None)
        steer["flight_commands"] = False
        return {
            "ok": True,
            "enabled": self.enabled is True,
            "camera": camera,
            "selected_camera": self.camera or None,
            "backend": self.backend if self.enabled else "off",
            "backend_error": self.backend_error,
            "model": self.model_path or None,
            "engine": self.engine_path or None,
            "stream": self.stream is True and active,
            "frame_width": self.frame_width if active else None,
            "frame_height": self.frame_height if active else None,
            "tracks": rows,
            "lock": lock,
            "gimbal_steer": steer,
            "reason_he": reason,
            "flight_commands": False,
            "commands_sent": self._sent_commands,
            "performance": {"measured": False, "note": "not measured"},
        }

    def _sync_thread(self):
        if self.thread_allowed and self.enabled and (self._thread is None or not self._thread.is_alive()):
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="vision-tracks", daemon=True)
            self._thread.start()
        if not self.enabled:
            self._stop.set()

    def _loop(self):
        while not self._stop.wait(0.1):
            if self.enabled:
                try:
                    self.step()
                except Exception:
                    pass

    def close(self):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=0.5)


def service():
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is None:
            _SERVICE = VisionTracks.from_env()
        return _SERVICE


def set_service(instance):
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is not None and _SERVICE is not instance:
            _SERVICE.close()
        _SERVICE = instance
        return _SERVICE


def reset_service():
    global _SERVICE
    with _SERVICE_LOCK:
        if _SERVICE is not None:
            _SERVICE.close()
        _SERVICE = None


def attach_runtime():
    svc = service()
    svc.frame_source = live_frame
    try:
        from siyi_sdk import gimbal_command, gimbal_status
    except ImportError:
        gimbal_command = None
        gimbal_status = None
    if gimbal_status is not None:
        svc.gimbal_status = lambda: gimbal_status(start=False)
    if gimbal_command is not None:
        svc.gimbal_command = gimbal_command
    svc.thread_allowed = True
    svc._sync_thread()
    return svc


def _query_camera(handler):
    raw = getattr(handler, "path", "") or ""
    query = raw.split("?", 1)[1] if "?" in raw else ""
    camera = ""
    sort = "class"
    for part in query.split("&"):
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        if key == "camera":
            camera = value
        elif key == "sort" and value == "confidence":
            sort = "confidence"
    return camera, sort


def try_handle(handler, body=None):
    path = handler._path() if hasattr(handler, "_path") else str(getattr(handler, "path", "")).split("?", 1)[0]
    if path not in {"/api/v1/vision/tracks", "/api/v1/vision/config", "/api/v1/vision/lock"}:
        return False
    svc = service()
    command = getattr(handler, "command", "GET")
    if path == "/api/v1/vision/tracks" and command == "GET":
        camera, sort = _query_camera(handler)
        handler._json(200, svc.snapshot(camera, sort))
        return True
    if path == "/api/v1/vision/config" and command == "GET":
        handler._json(200, svc.snapshot(svc.camera or ""))
        return True
    if path == "/api/v1/vision/config" and command == "POST":
        code, payload = svc.configure(body if isinstance(body, dict) else {})
        handler._json(code, payload)
        return True
    if path == "/api/v1/vision/lock" and command == "POST":
        code, payload = svc.lock(body if isinstance(body, dict) else {})
        handler._json(code, payload)
        return True
    if command != "GET":
        handler._json(405, {"ok": False, "reason": "method_not_allowed", "flight_commands": False})
        return True
    handler._json(404, {"ok": False, "flight_commands": False})
    return True
