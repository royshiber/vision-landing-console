"""Cam3 RTSP pipeline and newest-frame shelf. No live gimbal, no UDP send."""

from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from camera_ingest import (  # noqa: E402
    CaptureError,
    NewestFrameShelf,
    SlotSupervisor,
    cam3_codec_order,
    grab_newest,
    gst_dist_paths,
    jpeg_timing_headers,
    own_pixels,
    rtsp_gstreamer_pipeline,
    rtsp_jpeg_size,
    rtsp_open_plan,
    rtsp_transport,
    sanitize_bus_packet,
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
        self.assertIn("appsink name=sink drop=true max-buffers=1 sync=false", pipe)
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
        self.assertEqual(headers["X-Airvix-Frame-Seq"], str(latest["seq"]))

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

    def test_a_reused_capture_buffer_is_copied_before_another_thread_sees_it(self):
        import numpy as np
        live = np.zeros((6, 8, 3), dtype=np.uint8)
        live[:, :] = (3, 9, 12)
        owned = own_pixels(live)
        live[:, :] = 0
        self.assertIsNot(owned, live)
        self.assertTrue((owned[:, :, 0] == 3).all())
        self.assertTrue(owned.flags.writeable)
        packet = sanitize_bus_packet({"jpeg": bytearray(b"\xff\xd8\xff\xd9"), "bgr": live, "seq": 4})
        self.assertIs(packet["bgr_owned"], True)
        self.assertIsInstance(packet["jpeg"], bytes)
        self.assertIsNot(packet["bgr"], live)
        again = sanitize_bus_packet({"jpeg": b"\xff\xd8\xff\xd9", "bgr": owned, "bgr_owned": True, "seq": 5})
        self.assertIs(again["bgr"], owned)
        shelf = NewestFrameShelf()
        shelf.note_decoded(own_pixels(live), 10, 11, 0.2)
        live[:, :] = 7
        _seq, payload, _utc, _mono, _decode = shelf.take_decoded()
        self.assertFalse((payload == 7).all())

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

    def test_auto_codec_is_hardware_h265_with_one_buffer(self):
        self.assertEqual(cam3_codec_order("auto"), ["h265", "h264"])
        self.assertEqual(cam3_codec_order("h265"), ["h265"])
        self.assertEqual(cam3_codec_order("h264"), ["h264"])
        pipe = rtsp_gstreamer_pipeline(URL, "h265")
        self.assertIn("rtph265depay ! h265parse", pipe)
        self.assertIn("nvv4l2decoder enable-max-performance=1 disable-dpb=true", pipe)
        self.assertIn("appsink name=sink drop=true max-buffers=1 sync=false", pipe)
        self.assertNotIn("max-buffers=2", pipe)

    def test_grab_newest_drops_the_queued_frames(self):
        queued = {"left": 8}

        def grab():
            if queued["left"] <= 0:
                return False
            queued["left"] -= 1
            return True

        self.assertEqual(grab_newest(grab, limit=12), 8)
        self.assertEqual(grab_newest(grab, limit=12), 0)

    def test_auto_open_tries_h265_hardware_then_logs_ffmpeg(self):
        import camera_ingest

        calls = []

        def fake_hw(url, codec, transport, width, height, quality, gst=None, decoder="hardware"):
            calls.append(("hardware", codec, decoder))
            raise CaptureError("gstreamer_missing", "test")

        def fake_gst():
            return object()

        def fake_open(cv2, target, api):
            calls.append(("ffmpeg", target))
            return None

        original = (
            camera_ingest.open_hardware_rtsp,
            camera_ingest._try_gst,
            camera_ingest._open_capture,
        )
        camera_ingest.open_hardware_rtsp = fake_hw
        camera_ingest._try_gst = fake_gst
        camera_ingest._open_capture = fake_open
        try:
            with self.assertRaises(CaptureError):
                camera_ingest._open_rtsp(object(), URL, "auto", env={})
        finally:
            (
                camera_ingest.open_hardware_rtsp,
                camera_ingest._try_gst,
                camera_ingest._open_capture,
            ) = original
        self.assertEqual(calls[0], ("hardware", "h265", "hardware"))
        self.assertEqual(calls[1], ("hardware", "h265", "hardware-dpb"))
        self.assertEqual(calls[2][0], "ffmpeg")
        self.assertTrue(all(item[1] == "h265" for item in calls if item[0] == "hardware"))

    def test_gst_dist_paths_finds_system_gi(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / "python3.10" / "dist-packages" / "gi"
            pkg.mkdir(parents=True)
            (pkg / "__init__.py").write_text("", encoding="utf-8")
            found = gst_dist_paths(tmp)
        self.assertEqual(found, [str(Path(tmp) / "python3.10" / "dist-packages")])

    def test_gst_dist_paths_finds_unversioned_python3(self):
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / "python3" / "dist-packages" / "gi"
            pkg.mkdir(parents=True)
            (pkg / "__init__.py").write_text("", encoding="utf-8")
            versioned = Path(tmp) / "python3.12" / "dist-packages"
            versioned.mkdir(parents=True)
            found = gst_dist_paths(tmp)
        self.assertEqual(found, [str(Path(tmp) / "python3" / "dist-packages")])

    def test_active_decoder_is_named_in_the_log(self):
        import camera_ingest
        import io
        from contextlib import redirect_stdout

        class Opened:
            pass

        def fake_hw(url, codec, transport, width, height, quality, gst=None, decoder="hardware"):
            return Opened()

        original = camera_ingest.open_hardware_rtsp
        camera_ingest.open_hardware_rtsp = fake_hw
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                opened = camera_ingest._open_rtsp(object(), URL, "auto", env={})
        finally:
            camera_ingest.open_hardware_rtsp = original
        self.assertIsInstance(opened, Opened)
        self.assertIn("decoder=nvv4l2decoder", buf.getvalue())
        self.assertIn("codec=h265", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
