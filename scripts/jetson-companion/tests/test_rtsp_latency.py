"""Cam3 RTSP pipeline and newest-frame shelf. No live gimbal, no UDP send."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from camera_ingest import (  # noqa: E402
    NewestFrameShelf,
    SlotSupervisor,
    jpeg_timing_headers,
    rtsp_gstreamer_pipeline,
    rtsp_jpeg_size,
    rtsp_open_plan,
    rtsp_transport,
)
from measure_camera_latency import summarize_samples  # noqa: E402

URL = "rtsp://192.168.144.25:8554/main.264"


class FakeRtspSource:
    """In-memory appsink. pull() is one access unit, oldest first."""

    def __init__(self, frames):
        self.frames = list(frames)

    def pull(self):
        if not self.frames:
            return None
        return self.frames.pop(0)


class RtspPipelineTests(unittest.TestCase):
    def test_default_pipeline_matches_fixed_camera_latency_shape(self):
        pipe = rtsp_gstreamer_pipeline(URL, "h264")
        self.assertIn("protocols=udp", pipe)
        self.assertIn("latency=0", pipe)
        self.assertIn("drop-on-latency=true", pipe)
        self.assertIn("do-retransmission=false", pipe)
        self.assertIn("nvv4l2decoder enable-max-performance=1 disable-dpb=true", pipe)
        self.assertIn("width=640,height=360", pipe)
        self.assertIn("appsink drop=true max-buffers=1 sync=false", pipe)
        self.assertNotIn("max-buffers=2", pipe)
        self.assertNotIn("protocols=tcp", pipe)

        tcp = rtsp_gstreamer_pipeline(URL, "h265", transport="tcp", mode="jpeg", quality=55)
        self.assertIn("protocols=tcp", tcp)
        self.assertIn("rtph265depay ! h265parse", tcp)
        self.assertIn("nvjpegenc quality=55", tcp)
        self.assertIn("appsink name=jpeg drop=true max-buffers=1 sync=false", tcp)

        self.assertEqual(rtsp_transport({}), "udp")
        self.assertEqual(rtsp_transport({"VLC_CAM3_RTSP_TRANSPORT": "tcp"}), "tcp")
        width, height, quality = rtsp_jpeg_size({})
        self.assertEqual((width, height, quality), (640, 360, 55))

    def test_open_plan_tries_udp_hardware_before_tcp(self):
        plan = rtsp_open_plan(URL, "h264", "udp", 640, 360)
        self.assertEqual(plan[0]["backend"], "opencv")
        self.assertEqual(plan[0]["transport"], "udp")
        self.assertEqual(plan[1]["transport"], "tcp")
        self.assertEqual(plan[0]["decoder"], "nvv4l2decoder")
        self.assertIn("disable-dpb=true", plan[0]["pipeline"])
        self.assertEqual(plan[2]["backend"], "gst-jpeg")
        self.assertTrue(any(item["transport"] == "tcp" for item in plan))
        tcp_plan = rtsp_open_plan(URL, "h264", "tcp", 640, 360)
        self.assertTrue(tcp_plan)
        self.assertTrue(all(item["transport"] == "tcp" for item in tcp_plan))

    def test_fake_rtsp_source_keeps_the_newest_frame_only(self):
        source = FakeRtspSource([
            {"jpeg": b"frame-a", "utc": 1_700_000_000_000_000_000, "mono": 1},
            {"jpeg": b"frame-b", "utc": 1_700_000_000_100_000_000, "mono": 2},
            {"jpeg": b"frame-c", "utc": 1_700_000_000_200_000_000, "mono": 3},
        ])
        shelf = NewestFrameShelf()
        while True:
            item = source.pull()
            if item is None:
                break
            shelf.note_decoded(item["jpeg"], item["utc"], item["mono"], 0.4)
        taken = shelf.take_decoded()
        self.assertIsNotNone(taken)
        self.assertEqual(taken[1], b"frame-c")
        self.assertIsNone(shelf.take_decoded())
        shelf.note_jpeg(1, b"stale-jpeg", 8.0, 1, 1, 0.4, 1920, 1080)
        shelf.note_jpeg(taken[0], taken[1], 1.25, taken[2], taken[3], taken[4], 640, 360)
        latest = shelf.latest()
        self.assertEqual(latest["jpeg"], b"frame-c")
        self.assertEqual(latest["width"], 640)
        shelf.note_jpeg(taken[0] - 1, b"older", 3.0, 2, 2, 0.4, 640, 360)
        self.assertEqual(shelf.latest()["jpeg"], b"frame-c")
        headers = dict(jpeg_timing_headers(latest))
        self.assertEqual(headers["X-Airvix-Capture-At"], "1700000000200")
        self.assertEqual(headers["X-Encode-Ms"], "1.25")
        self.assertEqual(headers["X-Airvix-Decode-Ms"], "0.4")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_stuck_opening_fails_fast_and_drops_the_old_jpeg(self):
        def open_fn(_spec, _plan):
            time.sleep(5)
            return None

        sup = SlotSupervisor(
            "cam3",
            role="gimbal",
            enabled=True,
            resolve_fn=lambda: {
                "node_present": True,
                "kind": "rtsp",
                "resolved": URL,
                "requested": URL,
                "spec": {"kind": "rtsp", "url": URL},
            },
            open_fn=open_fn,
            geometry={"width": 640, "height": 360, "fps": 10},
            now_fn=lambda: 5.0,
            open_timeout_s=0.2,
        )
        sup.frame_jpeg = b"stale"
        sup.camera_ok = True
        sup.frame_count = 1187821
        started = time.monotonic()
        state = sup.step()
        elapsed = time.monotonic() - started
        self.assertEqual(state, "read_failed")
        self.assertLess(elapsed, 1.0)
        self.assertIsNone(sup.latest_jpeg())
        snap = sup.snapshot(5.0)
        self.assertFalse(snap["has_frame"])
        self.assertIsNone(snap["frame_count"])
        self.assertNotEqual(snap["state"], "opening")

    def test_pending_rtsp_does_not_drop_a_live_frame(self):
        class Cap:
            keeps_open_on_empty = True
            failed = False
            transport = "udp"
            decoder = "nvv4l2decoder"
            backend = "opencv"

            def __init__(self):
                self.n = 0

            def read_frame(self):
                self.n += 1
                if self.n == 1:
                    return {
                        "jpeg": b"newest",
                        "captured_utc_ns": 1_700_000_000_200_000_000,
                        "encode_ms": 2.0,
                        "decode_ms": 0.5,
                        "width": 640,
                        "height": 360,
                        "transport": "udp",
                        "decoder": "nvv4l2decoder",
                        "backend": "opencv",
                    }
                return {"pending": True}

            def release(self):
                return None

        sup = SlotSupervisor(
            "cam3",
            role="gimbal",
            enabled=True,
            resolve_fn=lambda: {
                "node_present": True,
                "kind": "rtsp",
                "resolved": URL,
                "requested": URL,
                "spec": {"kind": "rtsp", "url": URL},
            },
            open_fn=lambda _spec, _plan: Cap(),
            geometry={"width": 640, "height": 360, "fps": 10},
            now_fn=lambda: 8.0,
            open_timeout_s=1.0,
        )
        self.assertEqual(sup.step(), "streaming")
        self.assertEqual(sup.latest_jpeg(), b"newest")
        self.assertEqual(sup.step(), "streaming")
        self.assertEqual(sup.latest_packet()["jpeg"], b"newest")
        self.assertEqual(sup.snapshot(8.0)["stages_ms"]["jpeg"], 2.0)
        self.assertEqual(sup.snapshot(8.0)["transport"], "udp")

    def test_summary_marks_a_silent_camera_not_measured(self):
        quiet = summarize_samples([{"ok": False, "bytes": 0}], 5.0, "cam3")
        self.assertFalse(quiet["measured"])
        self.assertEqual(quiet["reason"], "not_measured")
        loud = summarize_samples([
            {"ok": True, "bytes": 100, "e2e_ms": 40, "decode_ms": 1, "encode_ms": 3},
            {"ok": True, "bytes": 110, "e2e_ms": 60, "decode_ms": 2, "encode_ms": 5},
        ], 1.0, "cam0")
        self.assertTrue(loud["measured"])
        self.assertEqual(loud["frames"], 2)
        self.assertEqual(loud["fps"], 2.0)
        self.assertEqual(loud["e2e_delay_ms"]["median"], 50.0)
        self.assertEqual(loud["encode_ms"]["min"], 3.0)


if __name__ == "__main__":
    unittest.main()
