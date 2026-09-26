# -*- coding: utf-8 -*-
"""Durable S3-compatible upload queue. No-op when credentials or the enable flag are missing.

Works with path-style S3. The provisioned store is Google Cloud Storage:
endpoint https://storage.googleapis.com, signed with GOOG4-HMAC-SHA256 and
only x-goog-* headers. Other endpoints stay AWS SigV4. The uploader key is
create-only, so every upload is one PUT of a unique object key. There is no
HEAD, GET, LIST, DELETE, or overwrite. A 412 means the object is already stored.
"""

from __future__ import print_function

import hashlib
import json
import os
import random
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from flightlog_common import (
    CONTROL_MAX_BYTES,
    PART_BYTES_DEFAULT,
    apply_storage_env,
    env_float,
    env_int,
    env_str,
    md5_b64,
    sha256_bytes,
    sha256_file,
    utc_iso,
)
from s3_sigv4 import normalize_host, path_style_url, sha256_hex, sign_request

CORE_KINDS = {"index", "manifest", "summary", "events", "series", "track"}
CONTROL_KINDS = {"index", "manifest"}


def credentials_present(cfg):
    return bool(cfg.get("endpoint") and cfg.get("region") and cfg.get("bucket") and cfg.get("key_id") and cfg.get("app_key"))


def first_env(*names):
    for name in names:
        value = env_str(name, "")
        if value:
            return value
    return ""


def upload_secret_from_env():
    """HMAC secret. AIRVIX_S3_SECRET wins. Older UPLOAD_SECRET / APP_KEY names are aliases."""
    return first_env("AIRVIX_S3_SECRET", "AIRVIX_UPLOAD_SECRET", "AIRVIX_UPLOAD_APP_KEY")


def upload_enabled_from_env(creds_present):
    """Unset follows credentials. Explicit 0 stays idle. Explicit 1 still needs credentials."""
    raw = os.environ.get("AIRVIX_UPLOAD_ENABLED")
    if raw is None or str(raw).strip() == "":
        return bool(creds_present)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def is_gcs_endpoint(endpoint):
    host = normalize_host(endpoint).split("/")[0].split(":")[0].lower()
    return host == "storage.googleapis.com" or host.endswith(".storage.googleapis.com")


def create_only_headers(endpoint):
    """GCS objectCreator: succeed only when the object does not exist. No prior HEAD."""
    if is_gcs_endpoint(endpoint):
        return {"x-goog-if-generation-match": "0"}
    return {}


def load_upload_config():
    apply_storage_env()
    endpoint = first_env("AIRVIX_S3_ENDPOINT", "AIRVIX_UPLOAD_ENDPOINT")
    region = first_env("AIRVIX_S3_REGION", "AIRVIX_UPLOAD_REGION")
    bucket = first_env("AIRVIX_S3_BUCKET", "AIRVIX_UPLOAD_BUCKET")
    key_id = first_env("AIRVIX_S3_KEY_ID", "AIRVIX_UPLOAD_KEY_ID")
    secret = upload_secret_from_env()
    creds = bool(endpoint and region and bucket and key_id and secret)
    return {
        "enabled_flag": upload_enabled_from_env(creds),
        "endpoint": endpoint,
        "region": region,
        "bucket": bucket,
        "key_id": key_id,
        "app_key": secret,
        "prefix": first_env("AIRVIX_S3_PREFIX", "AIRVIX_UPLOAD_PREFIX") or "v1",
        "cellular": env_str("AIRVIX_UPLOAD_CELLULAR", "all") or "all",
        "cell_daily_mb": env_float("AIRVIX_UPLOAD_CELL_DAILY_MB", 500),
        "while_armed": env_str("AIRVIX_UPLOAD_WHILE_ARMED", "control_only") or "control_only",
        "bw_kbps": env_float("AIRVIX_UPLOAD_BW_KBPS", 256),
        "bw_inflight_kbps": env_float("AIRVIX_UPLOAD_BW_INFLIGHT_KBPS", 16),
        "part_bytes": env_int("AIRVIX_UPLOAD_PART_BYTES", PART_BYTES_DEFAULT),
        "env_file": env_str("AIRVIX_FLIGHTLOG_ENV_FILE", "/etc/airvix/flightlog.env"),
        "network_override": env_str("AIRVIX_UPLOAD_NETWORK", ""),
    }


class LogUploader(object):
    def __init__(self, spool_dir, cfg=None, sleep_fn=None, now_fn=None, rand_fn=None, network_fn=None, opener=None):
        self.spool = Path(spool_dir)
        self.spool.mkdir(parents=True, exist_ok=True)
        self.cfg = cfg or load_upload_config()
        self.sleep_fn = sleep_fn or time.sleep
        self.now_fn = now_fn or time.time
        self.rand_fn = rand_fn or random.random
        self.network_fn = network_fn
        self.opener = opener
        self.db_path = self.spool / "uploads.sqlite"
        self.armed = False
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_db()
        self.auth_failed = self._meta("auth_failed") == "1"
        self._auth_until = float(self._meta("auth_until") or 0)
        self._seen_env_mtime = self._env_mtime()
        self._auth_streak = int(self._meta("auth_streak") or 0)
        self.last_success_unix = _float_or_none(self._meta("last_success"))
        self.last_error = self._meta("last_error") or None

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass

    @property
    def enabled(self):
        return bool(self.cfg.get("enabled_flag")) and credentials_present(self.cfg)

    def credential_state(self):
        return "present" if credentials_present(self.cfg) else "absent"

    def disable_reason(self):
        if not self.cfg.get("enabled_flag"):
            return "disabled"
        if not credentials_present(self.cfg):
            return "no_credential"
        if self.auth_failed and self.now_fn() < self._auth_until:
            return "auth_failed"
        return None

    def status(self):
        with self._lock:
            return self._status()

    def _status(self):
        jobs, nbytes = self._queue_stats()
        return {
            "enabled": self.enabled and self.disable_reason() is None,
            "credential": self.credential_state(),
            "reason": self.disable_reason(),
            "network": self.network(),
            "queue_jobs": jobs,
            "queue_bytes": nbytes,
            "last_success_utc": utc_iso(self.last_success_unix) if self.last_success_unix else None,
            "last_error": self.last_error,
            "auth_failed": bool(self.auth_failed and self.now_fn() < self._auth_until),
            "cell_used_today_mb": round(self.cell_bytes_today() / (1024.0 * 1024.0), 3),
        }

    def network(self):
        override = self.cfg.get("network_override") or ""
        if override in {"wifi", "cellular", "wired", "none"}:
            return override
        if self.network_fn is not None:
            try:
                kind = self.network_fn()
                if kind in {"wifi", "cellular", "wired", "none"}:
                    return kind
            except Exception:
                return "none"
        return classify_route(self.cfg.get("endpoint") or "")

    def enqueue_file(self, flight_id, name, local_path, key, kind, priority):
        with self._lock:
            return self._enqueue_file(flight_id, name, local_path, key, kind, priority)

    def _enqueue_file(self, flight_id, name, local_path, key, kind, priority):
        path = Path(local_path)
        if not path.is_file():
            return []
        data_len = path.stat().st_size
        digest = sha256_file(str(path))
        part = int(self.cfg.get("part_bytes") or PART_BYTES_DEFAULT)
        ids = []
        if data_len <= part:
            ids.append(self._insert(flight_id, name, str(path), key, data_len, digest, 0, 1, priority, kind))
            return ids
        parts = []
        total = 0
        with open(path, "rb") as handle:
            n = 1
            while True:
                blob = handle.read(part)
                if not blob:
                    break
                part_path = str(path) + ".part%04d" % n
                with open(part_path, "wb") as out:
                    out.write(blob)
                part_sha = sha256_bytes(blob)
                part_key = key + ".part%04d" % n
                parts.append({"n": n, "bytes": len(blob), "sha256": part_sha})
                ids.append(
                    self._insert(
                        flight_id,
                        name + ".part%04d" % n,
                        part_path,
                        part_key,
                        len(blob),
                        part_sha,
                        n,
                        0,
                        priority,
                        kind,
                    )
                )
                total += len(blob)
                n += 1
        manifest = {"parts": parts, "bytes": total, "sha256": digest}
        man_path = str(path) + ".parts.json"
        with open(man_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, sort_keys=True)
        man_bytes = os.path.getsize(man_path)
        ids.append(
            self._insert(
                flight_id,
                name + ".parts.json",
                man_path,
                key + ".parts.json",
                man_bytes,
                sha256_file(man_path),
                0,
                1,
                priority,
                kind,
            )
        )
        # chunk_total on the parts, now that we know it
        count = len(parts)
        self._conn.execute(
            "UPDATE jobs SET chunk_total=? WHERE flight_id=? AND kind=? AND chunk_n>0 AND state!='done'",
            (count, flight_id, kind),
        )
        self._conn.commit()
        return ids

    def step(self):
        """Upload at most one ready job. Returns True if a job was attempted."""
        with self._lock:
            return self._step()

    def _step(self):
        self._refresh_auth_lock()
        if not self.enabled or self.disable_reason() is not None:
            return False
        now = self.now_fn()
        row = self._next_row(now)
        if row is None:
            return False
        if not self._policy_allows(row):
            self._defer(row, now + 5.0, "policy_hold")
            return False
        self._put(row)
        return True

    def run_ready(self, limit=100):
        did = 0
        for _ in range(limit):
            if not self.step():
                # step returns False both when idle and when a policy defer happened.
                # Stop when nothing is due.
                if self._next_row(self.now_fn()) is None:
                    break
                if self.disable_reason() is not None or not self.enabled:
                    break
                continue
            did += 1
        return did

    def cell_bytes_today(self):
        day = time.strftime("%Y-%m-%d", time.gmtime(self.now_fn()))
        row = self._conn.execute("SELECT bytes FROM cell_usage WHERE day=?", (day,)).fetchone()
        return int(row["bytes"]) if row else 0

    def _policy_allows(self, row):
        kind = row["kind"]
        network = self.network()
        control = self._is_control(row)
        if self.armed:
            mode = self.cfg.get("while_armed") or "control_only"
            if mode == "none":
                return False
            if not control:
                return False
        if network == "none":
            return False
        if network == "cellular":
            policy = (self.cfg.get("cellular") or "all").lower()
            if kind == "clip":
                return False
            if policy == "never":
                return False
            if policy == "core" and kind not in CORE_KINDS:
                return False
            if not control:
                cap = float(self.cfg.get("cell_daily_mb") or 0) * 1024.0 * 1024.0
                if self.cell_bytes_today() + int(row["bytes"]) > cap:
                    return False
        return True

    def _is_control(self, row):
        return row["kind"] in CONTROL_KINDS and int(row["bytes"]) <= CONTROL_MAX_BYTES

    def _put(self, row):
        path = row["local_path"]
        try:
            body = Path(path).read_bytes()
        except Exception as exc:
            self._fail(row, "read_error", str(exc)[:120])
            return
        md5 = md5_b64(body)
        digest = sha256_hex(body)
        content_type, encoding = _content_headers(row["name"])
        endpoint = self.cfg.get("endpoint")
        gcs = is_gcs_endpoint(endpoint)
        meta_header = "x-goog-meta-sha256" if gcs else "x-amz-meta-sha256"
        headers = {
            "Content-Type": content_type,
            "Content-MD5": md5,
            meta_header: digest,
        }
        if encoding:
            headers["Content-Encoding"] = encoding
        headers.update(create_only_headers(endpoint))
        secure = str(endpoint or "").startswith("https://") or "://" not in str(endpoint or "")
        # Tests pass http://127.0.0.1:port
        if str(endpoint).startswith("http://"):
            secure = False
        url, host, uri = path_style_url(endpoint, self.cfg["bucket"], row["key"], secure=secure)
        amz = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(self.now_fn()))
        signed = sign_request(
            "PUT",
            host,
            uri,
            self.cfg["key_id"],
            self.cfg["app_key"],
            self.cfg["region"],
            amz,
            headers=headers,
            body=body,
        )
        if gcs:
            req_headers = {
                "Content-Type": content_type,
                "Content-MD5": md5,
                "x-goog-meta-sha256": digest,
                "x-goog-date": amz,
                "x-goog-content-sha256": signed["payload_hash"],
                "x-goog-if-generation-match": "0",
                "Authorization": signed["authorization"],
                "Host": host,
            }
        else:
            req_headers = {
                "Content-Type": content_type,
                "Content-MD5": md5,
                "x-amz-meta-sha256": digest,
                "x-amz-date": amz,
                "x-amz-content-sha256": signed["payload_hash"],
                "Authorization": signed["authorization"],
                "Host": host,
            }
        if encoding:
            req_headers["Content-Encoding"] = encoding
        if gcs:
            req_headers = {key: value for key, value in req_headers.items() if not str(key).lower().startswith("x-amz-")}
        self._throttle(len(body))
        try:
            status, etag, retry_after, extra = self._send(url, body, req_headers)
        except Exception as exc:
            self._fail(row, "network", type(exc).__name__)
            return
        if status in (401, 403):
            self._auth_fail(row, status)
            return
        # Create-only precondition: the object is already stored. Do not GET it.
        if status == 412:
            self._succeed(row)
            return
        if status == 503 or status == 429 or status >= 500:
            wait = _retry_after_seconds(retry_after)
            if wait is None:
                wait = self._backoff(int(row["attempts"]) + 1)
            self._fail(row, "http_%s" % status, None, delay=wait)
            return
        if status != 200:
            self._fail(row, "http_%s" % status, None)
            return
        if not upload_integrity_ok(etag, body, extra):
            self._fail(row, "etag_mismatch", None)
            return
        self._succeed(row)

    def _send(self, url, body, headers):
        if self.opener is not None:
            result = self.opener(url, body, headers)
            status, etag, retry_after = result[0], result[1], result[2]
            extra = result[3] if len(result) > 3 and result[3] else {}
            return status, etag, retry_after, extra
        req = urllib.request.Request(url, data=body, method="PUT")
        for key, value in headers.items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.headers.get("ETag"), resp.headers.get("Retry-After"), _hash_headers(resp.headers)
        except urllib.error.HTTPError as exc:
            hdrs = exc.headers
            return (
                exc.code,
                hdrs.get("ETag") if hdrs else None,
                hdrs.get("Retry-After") if hdrs else None,
                _hash_headers(hdrs),
            )

    def _throttle(self, nbytes):
        if self.armed and self._is_control_size(nbytes):
            kbps = float(self.cfg.get("bw_inflight_kbps") or 16)
        else:
            kbps = float(self.cfg.get("bw_kbps") or 256)
        if kbps <= 0:
            return
        delay = nbytes / (kbps * 1024.0)
        if delay > 0.001:
            self.sleep_fn(delay)

    def _is_control_size(self, nbytes):
        return nbytes <= CONTROL_MAX_BYTES

    def _backoff(self, attempts):
        base = min(600.0, 5.0 * (2 ** max(0, attempts - 1)))
        return base + (self.rand_fn() * base * 0.1)

    def _auth_fail(self, row, status):
        self._auth_streak += 1
        self._meta_set("auth_streak", str(self._auth_streak))
        self.last_error = "http_%s" % status
        self._meta_set("last_error", self.last_error)
        if self._auth_streak >= 3:
            self.auth_failed = True
            self._auth_until = self.now_fn() + 6 * 3600.0
            self._meta_set("auth_failed", "1")
            self._meta_set("auth_until", str(self._auth_until))
            self._seen_env_mtime = self._env_mtime()
            self._meta_set("env_mtime", "" if self._seen_env_mtime is None else str(self._seen_env_mtime))
        delay = self._backoff(int(row["attempts"]) + 1)
        self._fail(row, "http_%s" % status, None, delay=delay, count_auth=False)

    def _refresh_auth_lock(self):
        if not self.auth_failed:
            return
        mtime = self._env_mtime()
        prev = self._meta("env_mtime")
        if mtime is not None and (prev is None or str(mtime) != str(prev)):
            self._clear_auth()
            return
        if self.now_fn() >= self._auth_until:
            self._clear_auth()

    def _clear_auth(self):
        self.auth_failed = False
        self._auth_streak = 0
        self._auth_until = 0
        self._meta_set("auth_failed", "0")
        self._meta_set("auth_streak", "0")
        self._meta_set("auth_until", "0")
        self._seen_env_mtime = self._env_mtime()
        self._meta_set("env_mtime", "" if self._seen_env_mtime is None else str(self._seen_env_mtime))

    def _env_mtime(self):
        path = self.cfg.get("env_file")
        if not path:
            return None
        try:
            return os.stat(path).st_mtime
        except OSError:
            return None

    def _succeed(self, row):
        now = self.now_fn()
        self._conn.execute(
            "UPDATE jobs SET state='done', done_utc=?, last_error=NULL, attempts=attempts+1 WHERE id=?",
            (utc_iso(now), row["id"]),
        )
        if self.network() == "cellular":
            day = time.strftime("%Y-%m-%d", time.gmtime(now))
            self._conn.execute(
                "INSERT INTO cell_usage(day, bytes) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET bytes=bytes+excluded.bytes",
                (day, int(row["bytes"])),
            )
        self._conn.commit()
        self._auth_streak = 0
        self._meta_set("auth_streak", "0")
        self.last_success_unix = now
        self._meta_set("last_success", str(now))
        self.last_error = None
        self._meta_set("last_error", "")

    def _fail(self, row, code, _detail, delay=None, count_auth=True):
        if delay is None:
            delay = self._backoff(int(row["attempts"]) + 1)
        when = self.now_fn() + delay
        self.last_error = code
        self._meta_set("last_error", code)
        self._conn.execute(
            "UPDATE jobs SET state='pending', attempts=attempts+1, next_attempt_utc=?, last_error=? WHERE id=?",
            (when, code, row["id"]),
        )
        self._conn.commit()

    def _defer(self, row, when, code):
        self._conn.execute(
            "UPDATE jobs SET next_attempt_utc=?, last_error=? WHERE id=?",
            (when, code, row["id"]),
        )
        self._conn.commit()

    def _next_row(self, now):
        return self._conn.execute(
            "SELECT * FROM jobs WHERE state!='done' AND (next_attempt_utc IS NULL OR next_attempt_utc<=?) "
            "ORDER BY priority ASC, chunk_n ASC, id ASC LIMIT 1",
            (now,),
        ).fetchone()

    def _insert(self, flight_id, name, local_path, key, nbytes, digest, chunk_n, chunk_total, priority, kind):
        cur = self._conn.execute(
            "INSERT INTO jobs(flight_id, name, local_path, key, bytes, sha256, chunk_n, chunk_total, priority, kind, state, attempts, created_utc) "
            "VALUES(?,?,?,?,?,?,?,?,?,?, 'pending', 0, ?)",
            (flight_id, name, local_path, key, int(nbytes), digest, int(chunk_n), int(chunk_total), int(priority), kind, utc_iso(self.now_fn())),
        )
        self._conn.commit()
        return cur.lastrowid

    def _queue_stats(self):
        row = self._conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM jobs WHERE state!='done'"
        ).fetchone()
        return int(row["n"]), int(row["b"])

    def _init_db(self):
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
              id INTEGER PRIMARY KEY,
              flight_id TEXT,
              name TEXT,
              local_path TEXT,
              key TEXT,
              bytes INTEGER,
              sha256 TEXT,
              chunk_n INTEGER,
              chunk_total INTEGER,
              priority INTEGER,
              kind TEXT,
              state TEXT,
              attempts INTEGER,
              next_attempt_utc REAL,
              last_error TEXT,
              created_utc TEXT,
              done_utc TEXT
            );
            CREATE TABLE IF NOT EXISTS cell_usage (
              day TEXT PRIMARY KEY,
              bytes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
              k TEXT PRIMARY KEY,
              v TEXT
            );
            """
        )
        self._conn.commit()

    def _meta(self, key):
        row = self._conn.execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
        return None if row is None else row["v"]

    def _meta_set(self, key, value):
        self._conn.execute(
            "INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (key, value),
        )
        self._conn.commit()


def etag_token(etag):
    """Normalize an S3 or GCS ETag. Strips a weak prefix and one pair of quotes."""
    if not etag:
        return ""
    token = str(etag).strip()
    if len(token) >= 2 and token[:2].lower() == "w/":
        token = token[2:].strip()
    if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        token = token[1:-1]
    return token.lower()


def _etag_matches(etag, sha_hex):
    """Accept a sha256 echo used by the local fake server."""
    token = etag_token(etag)
    return bool(token) and token == str(sha_hex).lower()


def etag_matches_md5(etag, md5_hex):
    token = etag_token(etag)
    return bool(token) and token == str(md5_hex).lower()


def goog_hash_matches_body(header, body):
    """GCS XML responses include x-goog-hash: crc32c=<b64>,md5=<b64>."""
    if not header or body is None:
        return False
    import base64

    expect = base64.b64encode(hashlib.md5(body).digest()).decode("ascii")
    for part in str(header).split(","):
        piece = part.strip()
        if piece.lower().startswith("md5="):
            return piece.split("=", 1)[1].strip() == expect
    return False


def upload_integrity_ok(etag, body, extra=None):
    """Single-part PUT: S3/B2 ETag is MD5 hex. GCS also sends x-goog-hash md5."""
    md5_hex = hashlib.md5(body).hexdigest()
    if etag_matches_md5(etag, md5_hex) or _etag_matches(etag, sha256_hex(body)):
        return True
    header = ""
    if extra:
        header = extra.get("x-goog-hash") or extra.get("X-Goog-Hash") or ""
    return goog_hash_matches_body(header, body)


def _hash_headers(headers):
    if not headers:
        return {}
    try:
        goog = headers.get("x-goog-hash")
    except Exception:
        goog = None
    return {"x-goog-hash": goog} if goog else {}


def _content_headers(name):
    lower = name.lower()
    if lower.endswith(".json") or lower.endswith(".geojson"):
        return "application/json", None
    if lower.endswith(".jsonl.gz"):
        return "application/x-ndjson", "gzip"
    if lower.endswith(".geojson.gz"):
        return "application/geo+json", "gzip"
    if lower.endswith(".tlog.gz") or lower.endswith(".bin.gz"):
        return "application/octet-stream", "gzip"
    if lower.endswith(".gz"):
        return "application/gzip", "gzip"
    return "application/octet-stream", None


def _retry_after_seconds(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _float_or_none(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def classify_route(endpoint):
    """Best-effort iface class. Fail soft. Never raises."""
    import subprocess

    target = "1.1.1.1"
    try:
        proc = subprocess.run(
            ["ip", "route", "get", target],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1.0,
            check=False,
        )
        text = proc.stdout.decode("utf-8", "replace")
    except Exception:
        return "none"
    iface = None
    parts = text.split()
    if "dev" in parts:
        i = parts.index("dev")
        if i + 1 < len(parts):
            iface = parts[i + 1]
    if not iface:
        return "none"
    return classify_iface(iface)


def classify_iface(iface, modem_iface=None):
    name = iface or ""
    if name.startswith("wlan") or name.startswith("wl"):
        return "wifi"
    if modem_iface and name == modem_iface:
        return "cellular"
    if name.startswith("enx") or name.startswith("usb") or name.startswith("wwan"):
        return "cellular"
    if name == "lo":
        return "wired"
    return "wired"


def modem_iface_from_status(path=None):
    raw = path or os.environ.get("AIRVIX_E3372_STATUS_FILE", "/run/airvix/e3372.status")
    try:
        doc = json.loads(Path(raw).read_text(encoding="utf-8"))
    except Exception:
        return None
    iface = doc.get("iface") if isinstance(doc, dict) else None
    return iface if isinstance(iface, str) and iface else None
