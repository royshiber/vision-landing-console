# -*- coding: utf-8 -*-
"""Cam0 pixelformat fallback. No camera and no /dev/video0."""

from __future__ import annotations

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
    Y10,
    V4l2Source,
    choose_pixelformat,
    describe_capture_error,
    struct_pix,
)


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
