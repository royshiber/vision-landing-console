"""V4L2 capture for the OV9281 on tegra-video.

mmap is the CPU path. VIDIOC_EXPBUF is attempted so a consumer can take a
dmabuf; failure leaves mmap in place. The first buffers after STREAMON are
often short or empty on this driver, so they are dropped until one is the
expected size and not all zeros.

Before streaming, sensor_mode=0 and bypass_mode=0 are set (ioctl, then
v4l2-ctl if the control names are not enumerated).
"""

from __future__ import annotations

import ctypes
import errno
import fcntl
import mmap
import os
import select
import subprocess
import time

import numpy as np

from .rawfmt import to_code10, to_mono8

RG10 = 0x30314752  # 'RG10'
V4L2_BUF_TYPE_VIDEO_CAPTURE = 1
V4L2_MEMORY_MMAP = 1
V4L2_MEMORY_DMABUF = 4
V4L2_FIELD_NONE = 1
V4L2_CTRL_FLAG_NEXT_CTRL = 0x80000000


def _ioc(direction, nr, size):
    return (direction << 30) | (size << 16) | (ord("V") << 8) | nr


_IOWR = 3
_IOW = 1


class _timeval(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]


class _timecode(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("frames", ctypes.c_uint8),
        ("seconds", ctypes.c_uint8),
        ("minutes", ctypes.c_uint8),
        ("hours", ctypes.c_uint8),
        ("userbits", ctypes.c_uint8 * 4),
    ]


class _v4l2_buffer(ctypes.Structure):
    class _m(ctypes.Union):
        _fields_ = [
            ("offset", ctypes.c_uint32),
            ("userptr", ctypes.c_ulong),
            ("planes", ctypes.c_void_p),
            ("fd", ctypes.c_int32),
        ]

    _fields_ = [
        ("index", ctypes.c_uint32),
        ("type", ctypes.c_uint32),
        ("bytesused", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("field", ctypes.c_uint32),
        ("timestamp", _timeval),
        ("timecode", _timecode),
        ("sequence", ctypes.c_uint32),
        ("memory", ctypes.c_uint32),
        ("m", _m),
        ("length", ctypes.c_uint32),
        ("reserved2", ctypes.c_uint32),
        ("request_fd", ctypes.c_int32),
    ]


class _v4l2_requestbuffers(ctypes.Structure):
    _fields_ = [
        ("count", ctypes.c_uint32),
        ("type", ctypes.c_uint32),
        ("memory", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint32),
        ("flags", ctypes.c_uint8),
        ("reserved", ctypes.c_uint8 * 3),
    ]


class _v4l2_format(ctypes.Structure):
    class _fmt(ctypes.Union):
        _fields_ = [("raw", ctypes.c_uint8 * 200)]

    _fields_ = [("type", ctypes.c_uint32), ("fmt", _fmt)]


class _v4l2_control(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("value", ctypes.c_int32)]


class _v4l2_queryctrl(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_uint32),
        ("type", ctypes.c_uint32),
        ("name", ctypes.c_char * 32),
        ("minimum", ctypes.c_int32),
        ("maximum", ctypes.c_int32),
        ("step", ctypes.c_int32),
        ("default_value", ctypes.c_int32),
        ("flags", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32 * 2),
    ]


class _v4l2_exportbuffer(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_uint32),
        ("index", ctypes.c_uint32),
        ("plane", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("fd", ctypes.c_int32),
        ("reserved", ctypes.c_uint32 * 11),
    ]


VIDIOC_S_FMT = _ioc(_IOWR, 5, ctypes.sizeof(_v4l2_format))
VIDIOC_REQBUFS = _ioc(_IOWR, 8, ctypes.sizeof(_v4l2_requestbuffers))
VIDIOC_QUERYBUF = _ioc(_IOWR, 9, ctypes.sizeof(_v4l2_buffer))
VIDIOC_EXPBUF = _ioc(_IOWR, 16, ctypes.sizeof(_v4l2_exportbuffer))
VIDIOC_QBUF = _ioc(_IOWR, 15, ctypes.sizeof(_v4l2_buffer))
VIDIOC_DQBUF = _ioc(_IOWR, 17, ctypes.sizeof(_v4l2_buffer))
VIDIOC_STREAMON = _ioc(_IOW, 18, ctypes.sizeof(ctypes.c_int))
VIDIOC_STREAMOFF = _ioc(_IOW, 19, ctypes.sizeof(ctypes.c_int))
VIDIOC_S_CTRL = _ioc(_IOWR, 28, ctypes.sizeof(_v4l2_control))
VIDIOC_QUERYCTRL = _ioc(_IOWR, 44, ctypes.sizeof(_v4l2_queryctrl))


def _ioctl(fd, request, arg):
    return fcntl.ioctl(fd, request, arg)


def read_temperature_c():
    root = "/sys/class/thermal"
    if not os.path.isdir(root):
        return None
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name, "temp")
        try:
            raw = int(open(path, "r", encoding="utf-8").read().strip())
        except Exception:
            continue
        if raw > 1000:
            return raw / 1000.0
        return float(raw)
    return None


class V4l2Source:
    def __init__(self, device="/dev/video0", width=1280, height=800, fps=60, buffers=4):
        self.device = device
        self.width = int(width)
        self.height = int(height)
        self.fps = int(fps)
        self.buffers = int(buffers)
        self.exposure_us = 2000
        self.gain = 32
        self.index = 0
        self.dropped = 0
        self.fd = None
        self._maps = []
        self._dmabufs = []
        self._ctrls = {}
        self.real = True
        self.source = "v4l2"
        self.temperature_c = None

    def set_exposure_gain(self, exposure_us, gain):
        self.exposure_us = int(exposure_us)
        self.gain = int(gain)
        self._set_named("exposure", self.exposure_us)
        self._set_named("gain", self.gain)

    def close(self):
        if self.fd is None:
            return
        try:
            kind = ctypes.c_int(V4L2_BUF_TYPE_VIDEO_CAPTURE)
            _ioctl(self.fd, VIDIOC_STREAMOFF, kind)
        except Exception:
            pass
        for mm in self._maps:
            try:
                mm.close()
            except Exception:
                pass
        for dm in self._dmabufs:
            if dm is not None:
                try:
                    os.close(dm)
                except Exception:
                    pass
        self._maps = []
        self._dmabufs = []
        try:
            os.close(self.fd)
        except Exception:
            pass
        self.fd = None

    def _set_named(self, name, value):
        cid = self._ctrls.get(name)
        if cid is None or self.fd is None or value is None:
            return False
        ctrl = _v4l2_control(cid, int(value))
        try:
            _ioctl(self.fd, VIDIOC_S_CTRL, ctrl)
            return True
        except Exception:
            return False

    def _enumerate_controls(self):
        cid = V4L2_CTRL_FLAG_NEXT_CTRL
        found = {}
        for _ in range(256):
            q = _v4l2_queryctrl(id=cid)
            try:
                _ioctl(self.fd, VIDIOC_QUERYCTRL, q)
            except Exception:
                break
            name = bytes(q.name).split(b"\x00", 1)[0].decode("ascii", "replace")
            if name:
                found[name] = int(q.id)
            cid = int(q.id) | V4L2_CTRL_FLAG_NEXT_CTRL
        self._ctrls = found
        return found

    def _prime_modes(self):
        self._set_named("sensor_mode", 0)
        self._set_named("bypass_mode", 0)
        missing = [n for n in ("sensor_mode", "bypass_mode") if n not in self._ctrls]
        if not missing:
            return
        try:
            subprocess.run(
                ["v4l2-ctl", "-d", self.device, "--set-ctrl=sensor_mode=0,bypass_mode=0"],
                check=False,
                timeout=3,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    def open(self):
        self.close()
        self.fd = os.open(self.device, os.O_RDWR | os.O_NONBLOCK)
        self._enumerate_controls()
        self._prime_modes()
        fmt = _v4l2_format()
        fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE
        # pix format sits at the start of the 200-byte union.
        pix = struct_pix(self.width, self.height)
        ctypes.memmove(ctypes.addressof(fmt.fmt), pix, len(pix))
        _ioctl(self.fd, VIDIOC_S_FMT, fmt)
        req = _v4l2_requestbuffers(count=self.buffers, type=V4L2_BUF_TYPE_VIDEO_CAPTURE, memory=V4L2_MEMORY_MMAP)
        _ioctl(self.fd, VIDIOC_REQBUFS, req)
        count = int(req.count) or self.buffers
        self._maps = []
        self._dmabufs = []
        for index in range(count):
            buf = _v4l2_buffer()
            buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = V4L2_MEMORY_MMAP
            buf.index = index
            _ioctl(self.fd, VIDIOC_QUERYBUF, buf)
            mm = mmap.mmap(self.fd, buf.length, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=buf.m.offset)
            self._maps.append(mm)
            dm = None
            exp = _v4l2_exportbuffer(type=V4L2_BUF_TYPE_VIDEO_CAPTURE, index=index, plane=0, flags=os.O_CLOEXEC, fd=0)
            try:
                _ioctl(self.fd, VIDIOC_EXPBUF, exp)
                dm = int(exp.fd)
            except Exception:
                dm = None
            self._dmabufs.append(dm)
            _ioctl(self.fd, VIDIOC_QBUF, buf)
        if "frame_rate" in self._ctrls and self.fps:
            # tegra frame_rate control is in 1e6 units (fps * 1e6).
            self._set_named("frame_rate", int(self.fps) * 1000000)
        self.set_exposure_gain(self.exposure_us, self.gain)
        kind = ctypes.c_int(V4L2_BUF_TYPE_VIDEO_CAPTURE)
        _ioctl(self.fd, VIDIOC_STREAMON, kind)
        self._drop_primer()
        return self

    def _drop_primer(self):
        for _ in range(8):
            ready, _, _ = select.select([self.fd], [], [], 0.4)
            if not ready:
                break
            buf = _v4l2_buffer()
            buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE
            buf.memory = V4L2_MEMORY_MMAP
            try:
                _ioctl(self.fd, VIDIOC_DQBUF, buf)
            except Exception:
                break
            mm = self._maps[buf.index]
            raw = bytes(mm[:buf.bytesused])
            good = buf.bytesused >= self.width * self.height * 2 and any(raw)
            _ioctl(self.fd, VIDIOC_QBUF, buf)
            self.dropped += 0 if good else 1
            if good:
                break

    def read(self):
        if self.fd is None:
            self.open()
        ready, _, _ = select.select([self.fd], [], [], 1.0)
        if not ready:
            raise TimeoutError("v4l2_timeout")
        buf = _v4l2_buffer()
        buf.type = V4L2_BUF_TYPE_VIDEO_CAPTURE
        buf.memory = V4L2_MEMORY_MMAP
        try:
            _ioctl(self.fd, VIDIOC_DQBUF, buf)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.ENODEV, errno.ENXIO):
                raise
            raise
        try:
            mm = self._maps[buf.index]
            need = self.width * self.height
            raw = np.frombuffer(mm[:need * 2], dtype="<u2").reshape(self.height, self.width).copy()
        finally:
            try:
                _ioctl(self.fd, VIDIOC_QBUF, buf)
            except Exception:
                pass
        self.index += 1
        self.temperature_c = read_temperature_c()
        return {
            "index": self.index,
            "t_monotonic_ns": time.monotonic_ns(),
            "t_utc_ns": time.time_ns(),
            "width": self.width,
            "height": self.height,
            "raw_u16": raw,
            "code10": to_code10(raw),
            "mono8": to_mono8(raw),
            "exposure_us": self.exposure_us,
            "gain": self.gain,
            "dropped": self.dropped,
            "source": "v4l2",
            "real": True,
            "temperature_c": self.temperature_c,
            "dmabuf": self._dmabufs[buf.index] is not None,
            "sequence": int(buf.sequence),
        }


def struct_pix(width, height):
    # v4l2_pix_format prefix: width, height, pixelformat, field, bytesperline, sizeimage, colorspace
    bpl = int(width) * 2
    size = bpl * int(height)
    return ctypes.create_string_buffer(
        int(width).to_bytes(4, "little")
        + int(height).to_bytes(4, "little")
        + int(RG10).to_bytes(4, "little")
        + int(V4L2_FIELD_NONE).to_bytes(4, "little")
        + int(bpl).to_bytes(4, "little")
        + int(size).to_bytes(4, "little")
        + (0).to_bytes(4, "little"),
        28,
    )
