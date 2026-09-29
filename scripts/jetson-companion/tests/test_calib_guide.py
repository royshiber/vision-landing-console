"""Guided calibration against recorded checkerboard frames."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cam0.board_pdf import write_board_pdf  # noqa: E402
from cam0.calib_guide import (  # noqa: E402
    BOARD_COLS,
    BOARD_ROWS,
    SQUARE_MM,
    TARGET_VIEWS,
    CalibSession,
    verdict_he,
)
from cam0.calibration import find_checkerboard, load_latest, render_checkerboard  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "calib"


def _write_pgm(path, img):
    img = np.asarray(img, dtype=np.uint8)
    h, w = img.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"P5\n" + f"{w} {h}\n255\n".encode("ascii") + img.tobytes())


def _read_pgm(path):
    raw = Path(path).read_bytes()
    header, _, rest = raw.partition(b"\n")
    size, _, rest = rest.partition(b"\n")
    _max, _, pixels = rest.partition(b"\n")
    w, h = size.split()
    img = np.frombuffer(pixels, dtype=np.uint8)
    return img.reshape((int(h), int(w)))


def _ensure_fixtures():
    """Four recorded poses: center, left, right, high. Regenerated if missing."""
    spec = {
        "center.pgm": None,
        "left.pgm": (8, 40),
        "right.pgm": (132, 40),
        "low.pgm": (60, 96),
    }
    width, height, square = 280, 200, 14
    for name, origin in spec.items():
        dest = FIXTURES / name
        if dest.is_file():
            continue
        img, _corners = render_checkerboard(width, height, BOARD_COLS, BOARD_ROWS, square, origin)
        _write_pgm(dest, img)


class RecordedFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _ensure_fixtures()

    def test_recorded_frames_are_a_real_board(self):
        img = _read_pgm(FIXTURES / "center.pgm")
        corners = find_checkerboard(img, BOARD_COLS, BOARD_ROWS)
        self.assertIsNotNone(corners)
        self.assertEqual(len(corners), BOARD_COLS * BOARD_ROWS)

    def test_session_keeps_diverse_poses_and_saves_per_camera(self):
        session = CalibSession(camera="cam1", target=4)
        self.assertEqual(TARGET_VIEWS, 20)
        self.assertEqual(BOARD_COLS, 9)
        self.assertEqual(BOARD_ROWS, 6)
        self.assertEqual(SQUARE_MM, 25)
        started = session.start(9, 6, 25)
        self.assertEqual(started["phase"], "running")
        self.assertEqual(started["progress"], "0/4")
        names = ["center.pgm", "center.pgm", "left.pgm", "right.pgm", "low.pgm"]
        hints = []
        for name in names:
            img = _read_pgm(FIXTURES / name)
            body = session.observe(img, img.shape[1], img.shape[0])
            hints.append(body["hint_key"])
        self.assertEqual(session.status()["captured"], 4)
        self.assertIn("corners", hints)
        self.assertEqual(body["phase"], "review")
        self.assertIsNotNone(body["rms_px"])
        self.assertEqual(body["verdict"], verdict_he(body["rms_px"]))
        self.assertIn(body["verdict"], {"מצוין", "טוב", "סביר", "חלש"})
        self.assertLess(body["rms_px"], 1.0)
        with tempfile.TemporaryDirectory() as tmp:
            saved = session.save(tmp)
            self.assertTrue(saved["saved"])
            doc = load_latest(tmp)
        self.assertEqual(doc["camera"], "cam1")
        self.assertEqual(doc["board"]["inner_cols"], 9)
        self.assertEqual(doc["board"]["inner_rows"], 6)
        self.assertEqual(doc["board"]["square_mm"], 25)
        self.assertIn("k1", doc["distortion"])
        again = session.retry()
        self.assertEqual(again["phase"], "idle")
        self.assertEqual(again["captured"], 0)

    def test_a_tiny_board_asks_to_move_closer(self):
        img, _corners = render_checkerboard(280, 200, BOARD_COLS, BOARD_ROWS, 4)
        session = CalibSession(camera="cam0", target=4)
        session.start()
        body = session.observe(img, 280, 200)
        self.assertEqual(body["hint"], "קרב את הלוח")
        self.assertEqual(body["captured"], 0)

    def test_printable_board_is_a_landscape_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_board_pdf(Path(tmp) / "board.pdf")
            raw = path.read_bytes()
        self.assertTrue(raw.startswith(b"%PDF-1.4"))
        self.assertIn(b"9x6 inner corners", raw)
        self.assertIn(b"25 mm", raw)
        self.assertGreater(raw.count(b" re f"), 20)


if __name__ == "__main__":
    unittest.main()
