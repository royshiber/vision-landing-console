"""V4L2 capture for the OV9281 on tegra-video.

mmap is the CPU path. VIDIOC_EXPBUF is attempted so a consumer can take a
dmabuf; failure leaves mmap in place. The first buffers after STREAMON are
often short or empty on this driver, so they are dropped until one is the
expected size and not all zeros.

Before streaming, sensor_mode=0 and bypass_mode=0 are set (ioctl, then
v4l2-ctl if that ioctl does not stick). The pixelformat is tried as Y10
and then RG10. nv_ov9281 exposes the mono sensor as RG10 and rejects Y10.
Both layouts are 10-bit samples in 16-bit little-endian words. There is
no debayer step.
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

def fourcc(code):
    text = str(code)
    if len(text) < 4:
        text = text + (" " * (4 - len(text)))
    raw = text[:4].encode("ascii")
    return int.from_bytes(raw, "little")


Y10 = fourcc("Y10 ")  # V4L2_PIX_FMT_Y10, trailing space
RG10 = fourcc("RG10")  # V4L2_PIX_FMT_SRGGB10; mono samples on nv_ov9281
FORMAT_TRY = ("Y10", "RG10")
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
        # linux/videodev2.h: the fmt union includes v4l2_window, which holds
        # pointers, so the union is pointer-aligned. On 64-bit that puts 4
        # bytes of padding after type and makes sizeof(struct v4l2_format) 208.
        # A byte array alone is 1-byte aligned and yields 204, so VIDIOC_S_FMT
        # is ENOTTY (0xc0cc5605 instead of 0xc0d05605).
        _fields_ = [
            ("raw", ctypes.c_uint8 * 200),
            ("_align", ctypes.c_void_p),
        ]

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

_IOCTL_NAMES = {
    VIDIOC_S_FMT: "VIDIOC_S_FMT",
    VIDIOC_REQBUFS: "VIDIOC_REQBUFS",
    VIDIOC_QUERYBUF: "VIDIOC_QUERYBUF",
    VIDIOC_EXPBUF: "VIDIOC_EXPBUF",
    VIDIOC_QBUF: "VIDIOC_QBUF",
    VIDIOC_DQBUF: "VIDIOC_DQBUF",
    VIDIOC_STREAMON: "VIDIOC_STREAMON",
    VIDIOC_STREAMOFF: "VIDIOC_STREAMOFF",
    VIDIOC_S_CTRL: "VIDIOC_S_CTRL",
    VIDIOC_QUERYCTRL: "VIDIOC_QUERYCTRL",
}


def device_busy_message(exc):
    """EBUSY means another process already has the camera."""
    err = getattr(exc, "errno", None)
    text = str(exc).lower()
    if err == errno.EBUSY or "errno 16" in text or "device or resource busy" in text or "busy" in text:
        return (
            "device busy: stop the companion service (airvix-companion) so Cam0 releases "
            "/dev/video0, then retry"
        )
    return None


def exposure_control_unit(minimum, maximum, step=1):
    """queryctrl range to 'us' or 'lines'.

    A microsecond control can hold at least ~20 ms (maximum >= 20000).
    A line control tops out near one frame of lines, below that.
    """
    del minimum, step
    if int(maximum) >= 20000:
        return "us"
    return "lines"


def exposure_driver_value(exposure_us, unit, minimum, maximum, fps=60):
    exposure_us = int(exposure_us)
    if unit == "lines":
        frame_us = 1_000_000.0 / max(1, int(fps or 60))
        span = max(1, int(maximum))
        value = int(round(float(exposure_us) / frame_us * span))
    else:
        value = exposure_us
    return int(max(int(minimum), min(int(maximum), value)))


def gain_driver_value(gain, minimum, maximum):
    gain = int(gain)
    if int(maximum) >= 64:
        value = gain
    else:
        value = int(round(gain / 16.0))
    return int(max(int(minimum), min(int(maximum), value)))


def describe_capture_error(exc):
    """Errno and message. Callers must not store only the exception type name."""
    if isinstance(exc, OSError):
        err = exc.errno
        detail = exc.strerror or str(exc) or "OSError"
        if err is not None and f"[Errno {err}]" not in detail and f"Errno {err}" not in detail:
            text = f"OSError: [Errno {err}] {detail}"
        else:
            text = f"OSError: {exc}"
    else:
        text = f"{type(exc).__name__}: {exc}"
    return text[:240]


def choose_pixelformat(set_fmt, formats=FORMAT_TRY):
    """Try Y10, then RG10. set_fmt(name) raises OSError to reject that fourcc."""
    errors = []
    for name in formats:
        try:
            set_fmt(name)
        except OSError as exc:
            errors.append((name, exc))
            continue
        return name
    if not errors:
        raise OSError(errno.EINVAL, "VIDIOC_S_FMT failed; no pixelformat")
    last = errors[-1][1]
    parts = []
    for name, exc in errors:
        err = exc.errno
        detail = exc.strerror or str(exc) or "OSError"
        if err is not None:
            parts.append(f"{name}: [Errno {err}] {detail}")
        else:
            parts.append(f"{name}: {detail}")
    message = "VIDIOC_S_FMT failed; " + "; ".join(parts)
    err = last.errno if last.errno is not None else errno.EINVAL
    raise OSError(err, message)


def _ioctl(fd, request, arg):
    try:
        return fcntl.ioctl(fd, request, arg)
    except OSError as exc:
        name = _IOCTL_NAMES.get(int(request), "ioctl")
        detail = exc.strerror or "OSError"
        if exc.errno is None:
            raise OSError(f"{name}: {detail}") from exc
        raise OSError(exc.errno, f"{name}: {detail}") from exc


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
        self.gain = 16
        self.index = 0
        self.dropped = 0
        self.fd = None
        self._maps = []
        self._dmabufs = []
        self._ctrls = {}
        self.real = True
        self.source = "v4l2"
        self.temperature_c = None
        self.pixelformat = None
        self.exposure_unit = "us"
        self.exposure_driver = None
        self.gain_driver = None
        self._applied_exposure = None
        self._applied_gain = None
        self._temp_every = 30

    def set_exposure_gain(self, exposure_us, gain, fps=None):
        exposure_us = int(exposure_us)
        gain = int(gain)
        info = self._ctrl(self._ctrls.get("exposure"))
        ginfo = self._ctrl(self._ctrls.get("gain"))
        rate = int(fps or self.fps or 60)
        if info is None:
            unit = "us"
            driver_exp = exposure_us
        else:
            unit = info.get("unit") or exposure_control_unit(info["minimum"], info["maximum"], info.get("step", 1))
            driver_exp = exposure_driver_value(exposure_us, unit, info["minimum"], info["maximum"], fps=rate)
        if ginfo is None:
            driver_gain = gain
        else:
            driver_gain = gain_driver_value(gain, ginfo["minimum"], ginfo["maximum"])
        self.exposure_us = exposure_us
        self.gain = gain
        self.exposure_unit = unit
        if self.fd is None:
            return False
        if driver_exp == self._applied_exposure and driver_gain == self._applied_gain:
            return False
        self._set_named("exposure", driver_exp)
        self._set_named("gain", driver_gain)
        self._applied_exposure = driver_exp
        self.exposure_driver = driver_exp
        self._applied_gain = driver_gain
        self.gain_driver = driver_gain
        return True

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
        self._applied_exposure = None
        self._applied_gain = None

    def _ctrl(self, info):
        if isinstance(info, dict):
            return info
        return None

    def _set_named(self, name, value):
        info = self._ctrls.get(name)
        cid = info.get("id") if isinstance(info, dict) else info
        if cid is None or self.fd is None or value is None:
            return False
        ctrl = _v4l2_control(int(cid), int(value))
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
                info = {
                    "id": int(q.id),
                    "minimum": int(q.minimum),
                    "maximum": int(q.maximum),
                    "step": int(q.step),
                }
                if name.lower() == "exposure":
                    info["unit"] = exposure_control_unit(info["minimum"], info["maximum"], info["step"])
                found[name] = info
                found[name.lower()] = info
            cid = int(q.id) | V4L2_CTRL_FLAG_NEXT_CTRL
        self._ctrls = found
        return found

    def _prime_modes(self):
        stuck = self._set_named("sensor_mode", 0) and self._set_named("bypass_mode", 0)
        if stuck:
            self.mode_prime = "ioctl"
            return
        try:
            proc = subprocess.run(
                ["v4l2-ctl", "-d", self.device, "--set-ctrl=sensor_mode=0,bypass_mode=0"],
                check=False,
                timeout=3,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.mode_prime = "v4l2-ctl" if proc.returncode == 0 else "unset"
        except Exception:
            self.mode_prime = "unset"

    def open(self):
        self.close()
        self.fd = os.open(self.device, os.O_RDWR | os.O_NONBLOCK)
        self._enumerate_controls()
        self._prime_modes()
        fmt = _v4l2_format()
        fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE

        def set_fmt(name):
            code = Y10 if name == "Y10" else RG10
            pix = struct_pix(self.width, self.height, code)
            ctypes.memmove(ctypes.addressof(fmt.fmt), pix, len(pix))
            _ioctl(self.fd, VIDIOC_S_FMT, fmt)

        try:
            self.pixelformat = choose_pixelformat(set_fmt)
        except OSError as exc:
            modes = getattr(self, "mode_prime", "unset")
            detail = exc.strerror or str(exc)
            err = exc.errno if exc.errno is not None else errno.EINVAL
            raise OSError(err, f"{detail} (modes={modes})") from exc
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
            used = int(buf.bytesused)
            good = used >= self.width * self.height * 2 and any(mm[:min(used, 64)])
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
        t_dq = time.perf_counter()
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
        t_copy = time.perf_counter()
        mono = to_mono8(raw)
        t_conv = time.perf_counter()
        self.index += 1
        if self.index % self._temp_every == 0:
            self.temperature_c = read_temperature_c()
        return {
            "index": self.index,
            "t_monotonic_ns": time.monotonic_ns(),
            "t_utc_ns": time.time_ns(),
            "width": self.width,
            "height": self.height,
            "raw_u16": raw,
            "mono8": mono,
            "stages_ms": {
                "dqbuf": round((t_copy - t_dq) * 1000.0, 3),
                "convert": round((t_conv - t_copy) * 1000.0, 3),
            },
            "exposure_us": self.exposure_us,
            "gain": self.gain,
            "dropped": self.dropped,
            "source": "v4l2",
            "pixelformat": self.pixelformat,
            "real": True,
            "temperature_c": self.temperature_c,
            "dmabuf": self._dmabufs[buf.index] is not None,
            "sequence": int(buf.sequence),
        }


def struct_pix(width, height, pixelformat=RG10):
    # v4l2_pix_format prefix: width, height, pixelformat, field, bytesperline, sizeimage, colorspace.
    # 10-bit samples occupy 16-bit little-endian words, so the stride is width * 2.
    bpl = int(width) * 2
    size = bpl * int(height)
    return ctypes.create_string_buffer(
        int(width).to_bytes(4, "little")
        + int(height).to_bytes(4, "little")
        + int(pixelformat).to_bytes(4, "little")
        + int(V4L2_FIELD_NONE).to_bytes(4, "little")
        + int(bpl).to_bytes(4, "little")
        + int(size).to_bytes(4, "little")
        + (0).to_bytes(4, "little"),
        28,
    )
