# -*- coding: utf-8 -*-
"""Cam0 pixelformat fallback. No camera and no /dev/video0."""

from __future__ import annotations

import ctypes
import errno
import fcntl
import mmap
import select
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cam0.rawfmt import to_code10  # noqa: E402
from cam0.v4l2cap import (  # noqa: E402
    RG10,
    VIDIOC_EXPBUF,
    VIDIOC_QBUF,
    VIDIOC_QUERYCTRL,
    VIDIOC_REQBUFS,
    VIDIOC_S_CTRL,
    VIDIOC_S_FMT,
    Y10,
    V4l2Source,
    _v4l2_buffer,
    _v4l2_control,
    _v4l2_exportbuffer,
    _v4l2_format,
    _v4l2_queryctrl,
    _v4l2_requestbuffers,
    choose_pixelformat,
    describe_capture_error,
    struct_pix,
)


class V4l2AbiTests(unittest.TestCase):
    def test_format_and_buffer_ioctls_match_64bit_kernel(self):
        if ctypes.sizeof(ctypes.c_void_p) != 8:
            self.skipTest("these ioctl numbers are the 64-bit videodev2 ABI")
        self.assertEqual(_v4l2_format.fmt.offset, 8)
        self.assertEqual(ctypes.sizeof(_v4l2_format), 208)
        self.assertEqual(VIDIOC_S_FMT, 0xC0D05605)
        self.assertEqual(ctypes.sizeof(_v4l2_buffer), 88)
        self.assertEqual(VIDIOC_QBUF, 0xC058560F)
        # linux/videodev2.h: no pointers, so these sizes are the same on 32-bit.
        self.assertEqual(ctypes.sizeof(_v4l2_requestbuffers), 20)
        self.assertEqual(VIDIOC_REQBUFS, 0xC0145608)
        self.assertEqual(ctypes.sizeof(_v4l2_exportbuffer), 64)
        self.assertEqual(VIDIOC_EXPBUF, 0xC0405610)
        self.assertEqual(ctypes.sizeof(_v4l2_control), 8)
        self.assertEqual(VIDIOC_S_CTRL, 0xC008561C)
        self.assertEqual(ctypes.sizeof(_v4l2_queryctrl), 68)
        self.assertEqual(VIDIOC_QUERYCTRL, 0xC044562C)


class PixelformatFallbackTests(unittest.TestCase):
    def test_y10_invalid_falls_back_to_rg10(self):
        seen = []

        def set_fmt(name):
            seen.append(name)
            if name == "Y10":
                raise OSError(errno.EINVAL, "Invalid argument")

        self.assertEqual(choose_pixelformat(set_fmt), "RG10")
        self.assertEqual(seen, ["Y10", "RG10"])
        raw = bytes(struct_pix(1280, 800, RG10).raw)
        self.assertEqual(raw[8:12], b"RG10")
        self.assertEqual(int.from_bytes(raw[8:12], "little"), RG10)
        self.assertNotEqual(Y10, RG10)

    def test_both_formats_keep_errno_and_message(self):
        def set_fmt(name):
            raise OSError(errno.EINVAL, "Invalid argument")

        with self.assertRaises(OSError) as caught:
            choose_pixelformat(set_fmt)
        exc = caught.exception
        self.assertEqual(exc.errno, errno.EINVAL)
        text = describe_capture_error(exc)
        self.assertIn("Y10", text)
        self.assertIn("RG10", text)
        self.assertIn("Invalid argument", text)
        self.assertIn("Errno 22", text)
        self.assertNotEqual(text, "OSError")
        self.assertFalse(text.endswith("OSError"))

    def test_rg10_words_stay_mono(self):
        import numpy as np

        code = np.array([[0, 1023], [1023, 0]], dtype=np.uint16)
        packed = (code << np.uint16(6)).astype(np.uint16)
        self.assertTrue(np.array_equal(to_code10(packed), code))

    def test_open_sends_y10_then_rg10(self):
        src = V4l2Source("/dev/null", width=4, height=2, fps=0, buffers=1)
        seen = []
        real_ioctl = fcntl.ioctl
        real_mmap = mmap.mmap
        real_select = select.select

        def fake_ioctl(fd, request, arg):
            from cam0 import v4l2cap as cap

            if request == cap.VIDIOC_S_FMT:
                four = bytes(arg.fmt.raw[8:12])
                seen.append(four)
                if four == b"Y10 ":
                    raise OSError(errno.EINVAL, "Invalid argument")
                if four != b"RG10":
                    raise OSError(errno.EINVAL, "unexpected fourcc %r" % (four,))
                return 0
            if request == cap.VIDIOC_REQBUFS:
                arg.count = 1
                return 0
            if request == cap.VIDIOC_QUERYBUF:
                arg.length = 16
                arg.m.offset = 0
                return 0
            if request == cap.VIDIOC_QUERYCTRL:
                raise OSError(errno.EINVAL, "end")
            if request == cap.VIDIOC_EXPBUF:
                raise OSError(errno.ENOTTY, "no expbuf")
            return 0

        class _Map:
            def close(self):
                return None

            def __getitem__(self, item):
                return b"\x00" * 16

        fcntl.ioctl = fake_ioctl
        mmap.mmap = lambda *args, **kwargs: _Map()
        select.select = lambda *args, **kwargs: ([], [], [])
        try:
            src.open()
        finally:
            fcntl.ioctl = real_ioctl
            mmap.mmap = real_mmap
            select.select = real_select
            src.close()
        self.assertEqual(seen, [b"Y10 ", b"RG10"])
        self.assertEqual(src.pixelformat, "RG10")


if __name__ == "__main__":
    unittest.main()
