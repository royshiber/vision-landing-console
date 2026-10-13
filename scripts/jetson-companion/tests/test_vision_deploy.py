"""Deploy guard and the pinned YOLOv8n provision script. No Jetson, no pip."""

from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "install.sh"
PROVISION = ROOT / "provision_vision_model.sh"
PINNED_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx"
PINNED_SHA = "b2bc52f40e8e1c532427d5bde3575a5d5b571b739fab2c6df443733ed1589cbd"


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class VisionDeployTests(unittest.TestCase):
    def test_scripts_pin_the_guard_and_the_official_model(self):
        install = INSTALL.read_text(encoding="utf-8")
        provision = PROVISION.read_text(encoding="utf-8")
        self.assertIn("set -Eeuo pipefail", install)
        self.assertIn("X-Companion-Token", install)
        self.assertIn("verify_backup", install)
        self.assertIn("restore_tree", install)
        self.assertIn("royshiber", install)
        self.assertIn("set -euo pipefail", provision)
        self.assertIn(PINNED_URL, provision)
        self.assertIn(PINNED_SHA, provision)
        self.assertIn("--fp16", provision)
        self.assertIn("trtexec", provision)
        requirements = (ROOT / "requirements-vision.txt").read_text(encoding="utf-8")
        self.assertIn("Do not pip install", requirements)
        packages = [line.strip() for line in requirements.splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(packages, [])

    def _systemctl(self, directory: Path) -> Path:
        path = directory / "systemctl"
        _write(path, """#!/bin/sh
set -eu
dir="$AIRVIX_FAKE_SYSTEMD"
cmd="$1"
shift
if [ "$cmd" = "cat" ]; then
  if [ -f "$dir/unit.txt" ]; then
    cat "$dir/unit.txt"
  fi
  exit 0
fi
if [ "$cmd" = "restart" ]; then
  if [ -f "$dir/fail_restart" ]; then
    echo failed > "$dir/state"
    echo 0 > "$dir/pid"
    exit 1
  fi
  n=$(cat "$dir/restarts")
  echo $((n + 1)) > "$dir/restarts"
  echo active > "$dir/state"
  echo 5150 > "$dir/pid"
  exit 0
fi
if [ "$cmd" = "show" ]; then
  prop=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "-p" ]; then
      prop="$arg"
    fi
    prev="$arg"
  done
  case "$prop" in
    MainPID) cat "$dir/pid" ;;
    NRestarts) cat "$dir/restarts" ;;
    ActiveState) cat "$dir/state" ;;
    *) echo "bad prop" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "bad cmd $cmd" >&2
exit 1
""")
        return path

    def _curl(self, directory: Path, *, crash: bool) -> Path:
        path = directory / "curl"
        crash_flag = "1" if crash else "0"
        _write(path, f"""#!/bin/sh
set -eu
dir="$AIRVIX_FAKE_SYSTEMD"
printf '%s\\n' "$*" >> "$dir/curl_args"
n=0
if [ -f "$dir/health_n" ]; then
  n=$(cat "$dir/health_n")
fi
n=$((n + 1))
echo "$n" > "$dir/health_n"
if [ "{crash_flag}" = "1" ] && [ "$n" -ge 2 ]; then
  echo failed > "$dir/state"
  echo 0 > "$dir/pid"
  exit 1
fi
echo '{{"ok":true}}'
exit 0
""")
        return path

    def _seed(self, directory: Path):
        state = directory / "state"
        state.mkdir()
        (state / "restarts").write_text("0\n", encoding="utf-8")
        (state / "state").write_text("inactive\n", encoding="utf-8")
        (state / "pid").write_text("0\n", encoding="utf-8")
        (state / "curl_args").write_text("", encoding="utf-8")
        dest = directory / "vlc-companion"
        dest.mkdir()
        (dest / "companion_agent.py").write_text("OLD\n", encoding="utf-8")
        return state, dest

    def _run(self, directory: Path, dest: Path, state: Path, *, crash: bool):
        env = os.environ.copy()
        env.update({
            "PATH": f"{directory}:{env.get('PATH', '')}",
            "AIRVIX_FAKE_SYSTEMD": str(state),
            "AIRVIX_DEPLOY_SYSTEMCTL": str(directory / "systemctl"),
            "AIRVIX_DEPLOY_CURL": str(directory / "curl"),
            "VLC_DEPLOY_WATCH_S": "1",
            "VLC_COMPANION_TOKEN": "lab-token",
            "FORCE_LAB": "1",
        })
        self._systemctl(directory)
        self._curl(directory, crash=crash)
        return subprocess.run(
            ["bash", str(INSTALL), "--apply", "--force-lab", "--dest", str(dest)],
            cwd=str(ROOT),
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )

    def test_apply_verifies_a_writable_backup_and_stays_up(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            state, dest = self._seed(directory)
            result = self._run(directory, dest, state, crash=False)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertNotEqual((dest / "companion_agent.py").read_text(encoding="utf-8"), "OLD\n")
            backups = list((dest.parent / (dest.name + ".backups")).iterdir())
            self.assertEqual(len(backups), 1)
            backup = backups[0]
            self.assertEqual((backup / "companion_agent.py").read_text(encoding="utf-8"), "OLD\n")
            self.assertTrue(os.access(backup, os.W_OK))
            self.assertIn("X-Companion-Token: lab-token", (state / "curl_args").read_text(encoding="utf-8"))
            self.assertIn('"watched_s":1', result.stdout)

    def test_apply_rolls_back_when_health_dies_inside_the_watch(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            state, dest = self._seed(directory)
            result = self._run(directory, dest, state, crash=True)
            self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
            self.assertEqual((dest / "companion_agent.py").read_text(encoding="utf-8"), "OLD\n")
            self.assertIn('"rolled_back":true', result.stderr)
            self.assertIn("X-Companion-Token: lab-token", (state / "curl_args").read_text(encoding="utf-8"))

    def test_failed_restart_inside_a_function_rolls_back(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            state, dest = self._seed(directory)
            (state / "fail_restart").write_text("1\n", encoding="utf-8")
            result = self._run(directory, dest, state, crash=False)
            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual((dest / "companion_agent.py").read_text(encoding="utf-8"), "OLD\n")
            self.assertIn('"rolled_back":true', result.stderr)

    def test_first_install_restart_failure_reports_not_rolled_back(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            state = directory / "state"
            state.mkdir()
            (state / "restarts").write_text("0\n", encoding="utf-8")
            (state / "state").write_text("inactive\n", encoding="utf-8")
            (state / "pid").write_text("0\n", encoding="utf-8")
            (state / "curl_args").write_text("", encoding="utf-8")
            (state / "fail_restart").write_text("1\n", encoding="utf-8")
            dest = directory / "vlc-companion"
            result = self._run(directory, dest, state, crash=False)
            self.assertNotEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertTrue((dest / "companion_agent.py").is_file())
            self.assertNotEqual((dest / "companion_agent.py").read_text(encoding="utf-8"), "OLD\n")
            self.assertIn('"rolled_back":false', result.stderr)
            self.assertNotIn('"rolled_back":true', result.stderr)

    def test_health_reads_the_service_env_file_and_does_not_print_it(self):
        secret = "file-secret-token"
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            state, dest = self._seed(directory)
            env_file = directory / "companion.env"
            env_file.write_text(f'VLC_COMPANION_TOKEN="{secret}"\n', encoding="utf-8")
            (state / "unit.txt").write_text(
                "[Service]\nEnvironmentFile=-" + str(env_file) + "\n",
                encoding="utf-8",
            )
            env = os.environ.copy()
            env.pop("VLC_COMPANION_TOKEN", None)
            env.update({
                "PATH": f"{directory}:{env.get('PATH', '')}",
                "AIRVIX_FAKE_SYSTEMD": str(state),
                "AIRVIX_DEPLOY_SYSTEMCTL": str(directory / "systemctl"),
                "AIRVIX_DEPLOY_CURL": str(directory / "curl"),
                "VLC_DEPLOY_WATCH_S": "1",
                "FORCE_LAB": "1",
            })
            self._systemctl(directory)
            self._curl(directory, crash=False)
            result = subprocess.run(
                ["bash", str(INSTALL), "--apply", "--force-lab", "--dest", str(dest)],
                cwd=str(ROOT),
                env=env,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertIn(f"X-Companion-Token: {secret}", (state / "curl_args").read_text(encoding="utf-8"))
            self.assertNotIn(secret, result.stdout)
            self.assertNotIn(secret, result.stderr)

    def test_apply_installs_gi_and_points_a_venv_at_system_gi(self):
        install = INSTALL.read_text(encoding="utf-8")
        self.assertIn("python3-gi", install)
        self.assertIn("gir1.2-gstreamer-1.0", install)
        self.assertIn("gstreamer1.0-plugins-bad", install)
        self.assertIn("nvidia-l4t-gstreamer", install)
        self.assertIn("airvix-system-gi.pth", install)
        self.assertIn("nvv4l2decoder", install)
        self.assertIn("runuser -u royshiber --", install)
        self.assertIn("/usr/lib/python3/dist-packages", install)
        self.assertIn("import gi, os; print(os.path.dirname(gi.__file__))", install)
        self.assertNotIn('"$py" -c \'import sys', install)

    def test_gi_dist_dir_uses_unversioned_system_path(self):
        text = INSTALL.read_text(encoding="utf-8")
        start = text.index("gi_dist_dir() {")
        end = text.index("\nexpose_gi_to_service_venv()", start)
        function = text[start:end]
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            gi = root / "python3" / "dist-packages" / "gi"
            gi.mkdir(parents=True)
            (gi / "__init__.py").write_text("", encoding="utf-8")
            (root / "python3.12" / "dist-packages").mkdir(parents=True)
            probe = root / "syspython"
            probe.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            probe.chmod(probe.stat().st_mode | stat.S_IXUSR)
            env = os.environ.copy()
            env["AIRVIX_GI_LIB_ROOT"] = str(root)
            env["AIRVIX_SYSTEM_PYTHON"] = str(probe)
            result = subprocess.run(
                ["bash", "-c", function + "\ngi_dist_dir\n"],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(root / "python3" / "dist-packages"))


class ProvisionTests(unittest.TestCase):
    def test_sha_mismatch_does_not_build_an_engine(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            fixture = directory / "model.onnx"
            fixture.write_bytes(b"not-the-official-bytes\n")
            trt_log = directory / "trt.log"
            curl = directory / "curl"
            trtexec = directory / "trtexec"
            _write(curl, """#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  prev="$arg"
done
cp "$VLC_PROVISION_FIXTURE" "$out"
""")
            _write(trtexec, """#!/bin/sh
printf '%s\\n' "$*" > "$VLC_PROVISION_TRT_LOG"
exit 0
""")
            env = os.environ.copy()
            env.update({
                "PATH": f"{directory}:{env.get('PATH', '')}",
                "VLC_PROVISION_FIXTURE": str(fixture),
                "VLC_PROVISION_TRT_LOG": str(trt_log),
                "VLC_VISION_MODEL_DIR": str(directory / "models"),
                "VLC_VISION_ONNX_URL": "https://example.invalid/yolov8n.onnx",
                "VLC_VISION_ONNX_SHA256": "0" * 64,
            })
            result = subprocess.run(
                ["bash", str(PROVISION)],
                cwd=str(ROOT),
                env=env,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse(trt_log.exists())
            self.assertFalse((directory / "models" / "yolov8n_fp16.engine").exists())

    def test_pinned_download_builds_the_engine_with_trtexec(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            payload = b"official-yolov8n-stand-in\n"
            fixture = directory / "model.onnx"
            fixture.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            trt_log = directory / "trt.log"
            curl = directory / "curl"
            trtexec = directory / "trtexec"
            _write(curl, """#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  prev="$arg"
done
cp "$VLC_PROVISION_FIXTURE" "$out"
""")
            _write(trtexec, """#!/bin/sh
printf '%s\\n' "$*" > "$VLC_PROVISION_TRT_LOG"
engine=""
for arg in "$@"; do
  case "$arg" in
    --saveEngine=*) engine="${arg#--saveEngine=}" ;;
  esac
done
printf 'engine' > "$engine"
""")
            env = os.environ.copy()
            env.update({
                "PATH": f"{directory}:{env.get('PATH', '')}",
                "VLC_PROVISION_FIXTURE": str(fixture),
                "VLC_PROVISION_TRT_LOG": str(trt_log),
                "VLC_VISION_MODEL_DIR": str(directory / "models"),
                "VLC_VISION_ONNX_URL": "file:///unused",
                "VLC_VISION_ONNX_SHA256": digest,
            })
            result = subprocess.run(
                ["bash", str(PROVISION)],
                cwd=str(ROOT),
                env=env,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            log = trt_log.read_text(encoding="utf-8")
            self.assertIn("--fp16", log)
            self.assertIn("--onnx=", log)
            engine = directory / "models" / "yolov8n_fp16.engine"
            self.assertEqual(engine.read_bytes(), b"engine")
            self.assertIn('"pip":false', result.stdout)
            self.assertIn(digest, result.stdout)


if __name__ == "__main__":
    unittest.main()
