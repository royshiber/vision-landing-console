"""Baseline grayscale JPEG. Uses numpy for the DCT. No OpenCV required."""

from __future__ import annotations

import threading
import time

import numpy as np

_STD_LUMA_Q = np.array([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
], dtype=np.float64)

_ZIGZAG = np.array([
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
], dtype=np.int32)

_DC_BITS = (0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)
_DC_VALS = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)
_AC_BITS = (0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D)
_AC_VALS = (
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
)


def _dct_matrix():
    n = np.arange(8)
    k = n.reshape(8, 1)
    c = np.cos((2 * n + 1) * k * np.pi / 16.0)
    c[0] *= 1.0 / np.sqrt(2.0)
    return (0.5 * c).astype(np.float64)


_DCT = _dct_matrix()


def _huff_table(bits, vals):
    codes = {}
    code = 0
    idx = 0
    for length in range(1, 17):
        for _ in range(bits[length - 1]):
            codes[vals[idx]] = (code, length)
            idx += 1
            code += 1
        code <<= 1
    return codes


_DC_HUFF = _huff_table(_DC_BITS, _DC_VALS)
_AC_HUFF = _huff_table(_AC_BITS, _AC_VALS)


def _quant_table(quality):
    q = int(max(1, min(95, int(quality))))
    scale = 5000 // q if q < 50 else 200 - q * 2
    tab = np.floor((_STD_LUMA_Q * scale + 50) / 100.0)
    return np.clip(tab, 1, 255).astype(np.int32)


class _BitWriter:
    def __init__(self):
        self.buf = bytearray()
        self.acc = 0
        self.n = 0

    def write(self, code, length):
        self.acc = (self.acc << length) | (code & ((1 << length) - 1))
        self.n += length
        while self.n >= 8:
            self.n -= 8
            byte = (self.acc >> self.n) & 0xFF
            self.buf.append(byte)
            if byte == 0xFF:
                self.buf.append(0x00)

    def flush(self):
        if self.n:
            self.write((1 << (8 - self.n)) - 1, 8 - self.n)
            self.n = 0


def _category(value):
    if value == 0:
        return 0, 0
    v = int(value)
    a = abs(v)
    bits = int(a).bit_length()
    if v < 0:
        mag = (1 << bits) - 1 + v
    else:
        mag = v
    return bits, mag


def _downscale(gray, max_width):
    if not max_width or gray.shape[1] <= max_width:
        return gray
    step = int(np.ceil(gray.shape[1] / float(max_width)))
    return np.ascontiguousarray(gray[::step, ::step])


class JpegWorker:
    """Encodes the newest downscaled frame off the capture thread."""

    def __init__(self, encode=None):
        self._encode = encode or encode_gray_jpeg
        self._lock = threading.Lock()
        self._pending = None
        self._jpeg = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.stage_ms = None
        self._thread = threading.Thread(target=self._run, name="cam0-jpeg", daemon=True)

    def start(self):
        self._stop.clear()
        if self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="cam0-jpeg", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def submit(self, gray, quality=55, max_width=640):
        small = _downscale(np.asarray(gray, dtype=np.uint8), max_width)
        with self._lock:
            self._pending = (np.ascontiguousarray(small), int(quality))
        self._wake.set()

    def latest(self):
        with self._lock:
            return self._jpeg

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(0.25)
            self._wake.clear()
            with self._lock:
                job = self._pending
                self._pending = None
            if job is None:
                continue
            t0 = time.perf_counter()
            try:
                jpeg = self._encode(job[0], quality=job[1], max_width=None)
            except Exception:
                continue
            ms = (time.perf_counter() - t0) * 1000.0
            with self._lock:
                self._jpeg = jpeg
                self.stage_ms = round(ms, 3)


def encode_gray_jpeg(gray, quality=70, max_width=None):
    """Encode a 2D uint8 image as a baseline grayscale JPEG."""
    img = _downscale(np.asarray(gray, dtype=np.uint8), max_width)
    h, w = img.shape
    hp = (h + 7) & ~7
    wp = (w + 7) & ~7
    if hp != h or wp != w:
        padded = np.empty((hp, wp), dtype=np.uint8)
        padded[:h, :w] = img
        if wp != w:
            padded[:h, w:] = img[:, w - 1:w]
        if hp != h:
            padded[h:, :] = padded[h - 1:h, :]
        img = padded
    blocks = img.reshape(hp // 8, 8, wp // 8, 8).swapaxes(1, 2)
    shifted = blocks.astype(np.float64) - 128.0
    dct = _DCT @ shifted @ _DCT.T
    q = _quant_table(quality).reshape(8, 8)
    quant = np.round(dct / q).astype(np.int32)
    flat = quant.reshape(-1, 64)[:, _ZIGZAG]

    bits = _BitWriter()
    prev_dc = 0
    dc_huff = _DC_HUFF
    ac_huff = _AC_HUFF
    for row in flat:
        dc = int(row[0])
        diff = dc - prev_dc
        prev_dc = dc
        cat, mag = _category(diff)
        code, length = dc_huff[cat]
        bits.write(code, length)
        if cat:
            bits.write(mag, cat)
        zero = 0
        for k in range(1, 64):
            ac = int(row[k])
            if ac == 0:
                zero += 1
                continue
            while zero >= 16:
                code, length = ac_huff[0xF0]
                bits.write(code, length)
                zero -= 16
            cat, mag = _category(ac)
            code, length = ac_huff[(zero << 4) | cat]
            bits.write(code, length)
            bits.write(mag, cat)
            zero = 0
        if zero:
            code, length = ac_huff[0x00]
            bits.write(code, length)
    bits.flush()

    def chunk(marker, payload=b""):
        return bytes([0xFF, marker]) + payload

    qbytes = q.astype(np.uint8).tobytes()
    dqt = b"\x00" + bytes([int(qbytes.__len__() + 3 >> 8), (len(qbytes) + 3) & 0xFF]) if False else b""
    # length includes the two length bytes
    dqt = bytes([0x00, len(qbytes) + 3]) + b"\x00" + qbytes
    sof = bytes([
        0x00, 11,
        8,
        (h >> 8) & 0xFF, h & 0xFF,
        (w >> 8) & 0xFF, w & 0xFF,
        1, 1, 0x11, 0,
    ])
    def huff_payload(tc, bits, vals):
        body = bytes([tc]) + bytes(bits) + bytes(vals)
        return bytes([(len(body) + 2) >> 8, (len(body) + 2) & 0xFF]) + body
    dht = huff_payload(0x00, _DC_BITS, _DC_VALS) + bytes([0xFF, 0xC4]) + huff_payload(0x10, _AC_BITS, _AC_VALS)
    sos = bytes([0x00, 8, 1, 1, 0x00, 0, 63, 0])
    out = bytearray()
    out += b"\xFF\xD8"
    out += b"\xFF\xDB" + dqt
    out += b"\xFF\xC0" + sof
    out += b"\xFF\xC4" + dht
    out += b"\xFF\xDA" + sos
    out += bits.buf
    out += b"\xFF\xD9"
    return bytes(out)
