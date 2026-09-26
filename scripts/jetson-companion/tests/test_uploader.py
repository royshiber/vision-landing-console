# -*- coding: utf-8 -*-
"""Upload queue against a fake signer target. No live bucket."""

from __future__ import print_function

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from log_uploader import LogUploader, credentials_present, load_upload_config  # noqa: E402


def _cfg(**over):
    cfg = {
        "enabled_flag": True,
        "endpoint": "http://127.0.0.1:9",
        "region": "us-west-004",
        "bucket": "airvix-test",
        "key_id": "KEYID",
        "app_key": "not-a-real-secret",
        "prefix": "v1",
        "cellular": "all",
        "cell_daily_mb": 500,
        "while_armed": "control_only",
        "bw_kbps": 0,
        "bw_inflight_kbps": 0,
        "part_bytes": 8 * 1024 * 1024,
        "env_file": "",
        "network_override": "wifi",
    }
    cfg.update(over)
    return cfg


class Clock(object):
    def __init__(self):
        self.t = 1_700_000_000.0

    def __call__(self):
        return self.t


class UploaderTests(unittest.TestCase):
    def test_missing_credentials_are_a_noop(self):
        cfg = _cfg(endpoint="", app_key="", enabled_flag=True)
        self.assertFalse(credentials_present(cfg))
        with tempfile.TemporaryDirectory() as tmp:
            up = LogUploader(tmp, cfg=cfg, sleep_fn=lambda _s: None, now_fn=Clock())
            path = Path(tmp) / "a.bin"
            path.write_bytes(b"hello")
            up.enqueue_file("f1", "a.bin", str(path), "v1/veh/a.bin", "tlog", 30)
            self.assertFalse(up.step())
            status = up.status()
            self.assertFalse(status["enabled"])
            self.assertEqual(status["credential"], "absent")
            self.assertEqual(status["reason"], "no_credential")
            self.assertTrue(path.is_file())
            up.close()

    def test_single_put_and_chunked_parts(self):
        clock = Clock()
        store = {}

        def opener(url, body, headers):
            self.assertIn("Content-MD5", headers)
            self.assertIn("x-amz-meta-sha256", headers)
            self.assertNotIn("x-goog-if-generation-match", headers)
            self.assertNotIn("uploadId", url)
            store[url] = body
            return 200, '"' + hashlib.md5(body).hexdigest() + '"', None

        with tempfile.TemporaryDirectory() as tmp:
            small = Path(tmp) / "summary.json"
            small.write_bytes(b"{}")
            big = Path(tmp) / "telemetry.tlog.gz"
            big.write_bytes(b"abcdefghij" * 3)
            up = LogUploader(
                tmp,
                cfg=_cfg(part_bytes=8),
                sleep_fn=lambda _s: None,
                now_fn=clock,
                rand_fn=lambda: 0,
                opener=opener,
            )
            up.enqueue_file("f1", "summary.json", str(small), "v1/v/summary.json", "summary", 20)
            up.enqueue_file("f1", "telemetry.tlog.gz", str(big), "v1/v/telemetry.tlog.gz", "tlog", 30)
            self.assertTrue((big.parent / "telemetry.tlog.gz.parts.json").is_file() or Path(str(big) + ".parts.json").is_file())
            did = up.run_ready(20)
            self.assertGreaterEqual(did, 2)
            self.assertTrue(any(url.endswith("summary.json") for url in store))
            self.assertTrue(any(".part" in url for url in store))
            self.assertTrue(any(url.endswith(".parts.json") for url in store))
            man = json.loads(Path(str(big) + ".parts.json").read_text(encoding="utf-8"))
            self.assertEqual(man["sha256"], hashlib.sha256(big.read_bytes()).hexdigest())
            up.close()

    def test_resume_after_dropped_put(self):
        clock = Clock()
        calls = {"n": 0}
        saved = {}

        def opener(url, body, headers):
            calls["n"] += 1
            saved["body"] = body
            if calls["n"] == 1:
                raise ConnectionResetError("dropped")
            return 200, hashlib.md5(body).hexdigest(), None

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "m.json"
            path.write_bytes(b"payload-bytes")
            up = LogUploader(tmp, cfg=_cfg(), sleep_fn=lambda _s: None, now_fn=clock, rand_fn=lambda: 0, opener=opener)
            up.enqueue_file("f1", "m.json", str(path), "v1/v/m.json", "manifest", 10)
            up.step()
            clock.t += 1000
            up2 = LogUploader(tmp, cfg=_cfg(), sleep_fn=lambda _s: None, now_fn=clock, rand_fn=lambda: 0, opener=opener)
            up2.step()
            self.assertEqual(saved["body"], b"payload-bytes")
            self.assertEqual(hashlib.sha256(saved["body"]).hexdigest(), hashlib.sha256(path.read_bytes()).hexdigest())
            row = up2._conn.execute("SELECT state FROM jobs").fetchone()
            self.assertEqual(row["state"], "done")
            up.close()
            up2.close()

    def test_retry_after_and_auth_and_policies(self):
        clock = Clock()
        mode = {"code": 503, "retry": "7"}

        def opener(url, body, headers):
            return mode["code"], "nope", mode["retry"]

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "e.json"
            path.write_bytes(b"{}")
            index = Path(tmp) / "index.json"
            index.write_bytes(b'{"schema":"airvix.flight.index/1"}')
            up = LogUploader(tmp, cfg=_cfg(), sleep_fn=lambda _s: None, now_fn=clock, rand_fn=lambda: 0, opener=opener)
            up.enqueue_file("f1", "e.json", str(path), "v1/v/e.json", "events", 20)
            up.step()
            self.assertEqual(up.last_error, "http_503")
            row = up._conn.execute("SELECT next_attempt_utc FROM jobs WHERE name='e.json'").fetchone()
            self.assertGreaterEqual(row["next_attempt_utc"], clock.t + 6)

            mode["code"] = 403
            mode["retry"] = None
            clock.t += 100
            for _ in range(3):
                up.step()
                clock.t += 10000
            self.assertTrue(up.status()["auth_failed"])
            self.assertEqual(up.disable_reason(), "auth_failed")
            self.assertFalse(up.step())
            up.close()

        clock = Clock()
        stored = {}

        def ok(url, body, headers):
            stored[url] = body
            return 200, hashlib.md5(body).hexdigest(), None

        with tempfile.TemporaryDirectory() as tmp:
            big = Path(tmp) / "telemetry.tlog.gz"
            big.write_bytes(b"x" * 1000)
            index = Path(tmp) / "index.json"
            index.write_bytes(b'{"ok":1}')
            up = LogUploader(tmp, cfg=_cfg(network_override="wifi"), sleep_fn=lambda _s: None, now_fn=clock, rand_fn=lambda: 0, opener=ok)
            up.armed = True
            up.enqueue_file("f1", "telemetry.tlog.gz", str(big), "v1/v/telemetry.tlog.gz", "tlog", 30)
            up.enqueue_file("f1", "index.json", str(index), "v1/v/index.json", "index", 10)
            up.run_ready(10)
            self.assertTrue(any(url.endswith("index.json") for url in stored))
            self.assertFalse(any("telemetry" in url for url in stored))
            up.close()

        clock = Clock()
        stored = {}
        with tempfile.TemporaryDirectory() as tmp:
            blob = Path(tmp) / "series.json.gz"
            blob.write_bytes(b"y" * 5000)
            up = LogUploader(
                tmp,
                cfg=_cfg(network_override="cellular", cell_daily_mb=0.0001),
                sleep_fn=lambda _s: None,
                now_fn=clock,
                rand_fn=lambda: 0,
                opener=ok,
            )
            up.enqueue_file("f1", "series.json.gz", str(blob), "v1/v/series.json.gz", "series", 20)
            up.step()
            self.assertEqual(stored, {})
            self.assertEqual(up._conn.execute("SELECT last_error FROM jobs").fetchone()["last_error"], "policy_hold")
            up.close()

    def test_secret_env_prefers_secret_and_accepts_app_key_alias(self):
        names = ("AIRVIX_S3_SECRET", "AIRVIX_UPLOAD_SECRET", "AIRVIX_UPLOAD_APP_KEY", "AIRVIX_UPLOAD_ENABLED")
        previous = {name: os.environ.get(name) for name in names}
        try:
            os.environ.pop("AIRVIX_S3_SECRET", None)
            os.environ["AIRVIX_UPLOAD_SECRET"] = "hmac-secret"
            os.environ["AIRVIX_UPLOAD_APP_KEY"] = "alias-secret"
            self.assertEqual(load_upload_config()["app_key"], "hmac-secret")
            del os.environ["AIRVIX_UPLOAD_SECRET"]
            self.assertEqual(load_upload_config()["app_key"], "alias-secret")
            os.environ["AIRVIX_UPLOAD_APP_KEY"] = ""
            self.assertEqual(load_upload_config()["app_key"], "")
            self.assertFalse(credentials_present(load_upload_config()))
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_s3_env_wires_gcs_and_keeps_upload_aliases(self):
        names = (
            "AIRVIX_S3_ENDPOINT",
            "AIRVIX_S3_REGION",
            "AIRVIX_S3_BUCKET",
            "AIRVIX_S3_KEY_ID",
            "AIRVIX_S3_SECRET",
            "AIRVIX_UPLOAD_ENABLED",
            "AIRVIX_UPLOAD_ENDPOINT",
            "AIRVIX_UPLOAD_REGION",
            "AIRVIX_UPLOAD_BUCKET",
            "AIRVIX_UPLOAD_KEY_ID",
            "AIRVIX_UPLOAD_SECRET",
            "AIRVIX_UPLOAD_APP_KEY",
        )
        previous = {name: os.environ.get(name) for name in names}
        try:
            for name in names:
                os.environ.pop(name, None)
            os.environ["AIRVIX_S3_ENDPOINT"] = "https://storage.googleapis.com"
            os.environ["AIRVIX_S3_REGION"] = "auto"
            os.environ["AIRVIX_S3_BUCKET"] = "airvix-flight-logs-489409"
            os.environ["AIRVIX_S3_KEY_ID"] = "GOOG1EXAMPLE"
            os.environ["AIRVIX_S3_SECRET"] = "not-a-real-hmac-secret"
            os.environ["AIRVIX_UPLOAD_ENDPOINT"] = "https://example.invalid"
            cfg = load_upload_config()
            self.assertTrue(cfg["enabled_flag"])
            self.assertEqual(cfg["endpoint"], "https://storage.googleapis.com")
            self.assertEqual(cfg["region"], "auto")
            self.assertEqual(cfg["bucket"], "airvix-flight-logs-489409")
            self.assertEqual(cfg["key_id"], "GOOG1EXAMPLE")
            self.assertEqual(cfg["app_key"], "not-a-real-hmac-secret")
            os.environ["AIRVIX_UPLOAD_ENABLED"] = "0"
            self.assertFalse(load_upload_config()["enabled_flag"])
            for name in (
                "AIRVIX_S3_ENDPOINT",
                "AIRVIX_S3_REGION",
                "AIRVIX_S3_BUCKET",
                "AIRVIX_S3_KEY_ID",
                "AIRVIX_S3_SECRET",
                "AIRVIX_UPLOAD_ENABLED",
            ):
                os.environ.pop(name, None)
            os.environ["AIRVIX_UPLOAD_ENDPOINT"] = "https://s3.example"
            os.environ["AIRVIX_UPLOAD_REGION"] = "us-west-004"
            os.environ["AIRVIX_UPLOAD_BUCKET"] = "alias-bucket"
            os.environ["AIRVIX_UPLOAD_KEY_ID"] = "ALIASKEY"
            os.environ["AIRVIX_UPLOAD_APP_KEY"] = "alias-secret"
            alias = load_upload_config()
            self.assertEqual(alias["endpoint"], "https://s3.example")
            self.assertEqual(alias["region"], "us-west-004")
            self.assertEqual(alias["bucket"], "alias-bucket")
            self.assertEqual(alias["app_key"], "alias-secret")
            self.assertTrue(alias["enabled_flag"])
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_gcs_interop_put_accepts_goog_hash(self):
        clock = Clock()
        seen = {}

        def opener(url, body, headers):
            seen["url"] = url
            seen["headers"] = headers
            seen["authorization"] = headers["Authorization"]
            seen["generation"] = headers.get("x-goog-if-generation-match")
            seen["body"] = body
            self.assertNotIn("uploadId", url)
            for name in headers:
                self.assertFalse(str(name).lower().startswith("x-amz-"), name)
            import base64

            md5_b64 = base64.b64encode(hashlib.md5(body).digest()).decode("ascii")
            return 200, '"not-an-md5-etag"', None, {"x-goog-hash": "crc32c=AAAAAA==,md5=%s" % md5_b64}

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.json"
            path.write_bytes(b'{"ok":1}')
            up = LogUploader(
                tmp,
                cfg=_cfg(
                    endpoint="https://storage.googleapis.com",
                    region="auto",
                    bucket="airvix-flights",
                    key_id="GOOG1EXAMPLE",
                    app_key="not-a-real-hmac-secret",
                ),
                sleep_fn=lambda _s: None,
                now_fn=clock,
                rand_fn=lambda: 0,
                opener=opener,
            )
            up.enqueue_file("f1", "summary.json", str(path), "v1/plane/summary.json", "summary", 20)
            self.assertTrue(up.step())
            self.assertTrue(seen["url"].startswith("https://storage.googleapis.com/airvix-flights/v1/plane/summary.json"))
            self.assertIn("/auto/storage/goog4_request", seen["authorization"])
            self.assertNotIn("x-amz-", seen["authorization"])
            self.assertIn("Credential=GOOG1EXAMPLE/", seen["authorization"])
            self.assertTrue(seen["authorization"].startswith("GOOG4-HMAC-SHA256 "))
            self.assertEqual(seen["generation"], "0")
            self.assertEqual(seen["headers"].get("x-goog-meta-sha256"), hashlib.sha256(b'{"ok":1}').hexdigest())
            self.assertIn("x-goog-date", seen["headers"])
            self.assertIn("x-goog-content-sha256", seen["headers"])
            self.assertIn("x-goog-if-generation-match", seen["authorization"])
            self.assertEqual(up._conn.execute("SELECT state FROM jobs").fetchone()["state"], "done")
            up.close()

        clock = Clock()
        seen = {}

        def opener_region(url, body, headers):
            seen["authorization"] = headers["Authorization"]
            for name in headers:
                self.assertFalse(str(name).lower().startswith("x-amz-"), name)
            return 200, hashlib.md5(body).hexdigest(), None

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.json"
            path.write_bytes(b"{}")
            up = LogUploader(
                tmp,
                cfg=_cfg(endpoint="https://storage.googleapis.com", region="me-west1", bucket="airvix-flights"),
                sleep_fn=lambda _s: None,
                now_fn=clock,
                rand_fn=lambda: 0,
                opener=opener_region,
            )
            up.enqueue_file("f1", "summary.json", str(path), "v1/plane/summary.json", "summary", 20)
            self.assertTrue(up.step())
            self.assertIn("/auto/storage/goog4_request", seen["authorization"])
            self.assertNotIn("/me-west1/", seen["authorization"])
            up.close()

    def test_gcs_existing_object_is_success_without_get(self):
        clock = Clock()
        calls = {"n": 0}

        def opener(url, body, headers):
            calls["n"] += 1
            self.assertEqual(headers.get("x-goog-if-generation-match"), "0")
            for name in headers:
                self.assertFalse(str(name).lower().startswith("x-amz-"), name)
            self.assertNotIn("uploadId", url)
            self.assertFalse(url.endswith("?acl"))
            return 412, None, None

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "summary.json"
            path.write_bytes(b"{}")
            up = LogUploader(
                tmp,
                cfg=_cfg(endpoint="https://storage.googleapis.com", region="auto", bucket="airvix-flight-logs-489409"),
                sleep_fn=lambda _s: None,
                now_fn=clock,
                rand_fn=lambda: 0,
                opener=opener,
            )
            up.enqueue_file("f1", "summary.json", str(path), "v1/plane/flights/f1/summary.json", "summary", 20)
            self.assertTrue(up.step())
            self.assertEqual(calls["n"], 1)
            self.assertEqual(up._conn.execute("SELECT state FROM jobs").fetchone()["state"], "done")
            self.assertFalse(up.status()["auth_failed"])
            up.close()

    def test_index_keys_stay_unique_per_variant(self):
        from flightlog_common import index_key

        final = index_key("v1", "plane", "FID")
        inflight = index_key("v1", "plane", "FID", "in_flight")
        processing = index_key("v1", "plane", "FID", "processing")
        self.assertEqual(final, "v1/plane/index/FID.json")
        self.assertEqual(inflight, "v1/plane/index/FID--in_flight.json")
        self.assertEqual(processing, "v1/plane/index/FID--processing.json")
        self.assertEqual(len({final, inflight, processing}), 3)

    def test_storage_env_file_fills_unset_s3_vars(self):
        names = (
            "HOME",
            "AIRVIX_S3_ENDPOINT",
            "AIRVIX_S3_REGION",
            "AIRVIX_S3_BUCKET",
            "AIRVIX_S3_KEY_ID",
            "AIRVIX_S3_SECRET",
            "AIRVIX_UPLOAD_ENDPOINT",
            "AIRVIX_UPLOAD_REGION",
            "AIRVIX_UPLOAD_BUCKET",
            "AIRVIX_UPLOAD_KEY_ID",
            "AIRVIX_UPLOAD_SECRET",
            "AIRVIX_UPLOAD_APP_KEY",
            "AIRVIX_UPLOAD_ENABLED",
        )
        previous = {name: os.environ.get(name) for name in names}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                os.environ["HOME"] = tmp
                for name in names:
                    if name != "HOME":
                        os.environ.pop(name, None)
                folder = Path(tmp) / "vlc-companion"
                folder.mkdir()
                (folder / "flightlog-storage.env").write_text(
                    "\n".join(
                        [
                            "# mode 600 on the Jetson; values here are fixtures",
                            "AIRVIX_S3_ENDPOINT=https://storage.googleapis.com",
                            "AIRVIX_S3_REGION=auto",
                            "AIRVIX_S3_BUCKET=airvix-flight-logs-489409",
                            "AIRVIX_S3_KEY_ID=GOOG1EXAMPLE",
                            'AIRVIX_S3_SECRET="not-a-real-hmac-secret"',
                            "AIRVIX_S3_SECRET_BLANK=",
                            "export AIRVIX_UPLOAD_ENABLED=0",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                os.environ["AIRVIX_S3_REGION"] = "already-set"
                cfg = load_upload_config()
                self.assertEqual(cfg["region"], "already-set")
                self.assertEqual(cfg["endpoint"], "https://storage.googleapis.com")
                self.assertEqual(cfg["bucket"], "airvix-flight-logs-489409")
                self.assertEqual(cfg["key_id"], "GOOG1EXAMPLE")
                self.assertEqual(cfg["app_key"], "not-a-real-hmac-secret")
                self.assertFalse(cfg["enabled_flag"])
                self.assertNotIn("AIRVIX_S3_SECRET_BLANK", os.environ)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_etag_mismatch(self):
        clock = Clock()

        def opener(url, body, headers):
            return 200, '"deadbeef"', None

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.json"
            path.write_bytes(b"abc")
            up = LogUploader(tmp, cfg=_cfg(), sleep_fn=lambda _s: None, now_fn=clock, rand_fn=lambda: 0, opener=opener)
            up.enqueue_file("f1", "a.json", str(path), "v1/v/a.json", "summary", 20)
            up.step()
            self.assertEqual(up.last_error, "etag_mismatch")
            self.assertEqual(up._conn.execute("SELECT state FROM jobs").fetchone()["state"], "pending")
            up.close()


if __name__ == "__main__":
    unittest.main()
