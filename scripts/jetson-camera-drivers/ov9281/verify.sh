#!/bin/bash
# After reboot: confirm the OV9281 probed, list /dev/video0, capture 10 frames,
# and print mean/stddev of frame 0. Run on the Jetson.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DEV="${OV9281_VIDEO:-/dev/video0}"
OUT="${OV9281_OUT:-/tmp/ov9281-verify}"
WIDTH=1280
HEIGHT=800

mkdir -p "${OUT}"

if ! command -v v4l2-ctl >/dev/null 2>&1; then
  echo "v4l2-ctl is missing. Install v4l-utils." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is missing" >&2
  exit 1
fi
python3 -c "import numpy" >/dev/null 2>&1 || {
  echo "python3 numpy is missing" >&2
  exit 1
}

# grep -q on a pipe is wrong here. dmesg is large once VI has logged
# thousands of corr_err lines, grep -q exits at the early chip-id line,
# and pipefail turns the resulting SIGPIPE into "not found".
refresh_dmesg() {
  if ! dmesg > "${OUT}/dmesg.txt" 2>"${OUT}/dmesg.err"; then
    echo "dmesg failed. Run verify.sh as root." >&2
    cat "${OUT}/dmesg.err" >&2 || true
    exit 1
  fi
}
refresh_dmesg
if ! grep -F -q 'chip id 0x9281' "${OUT}/dmesg.txt"; then
  modprobe nv_ov9281 2>/dev/null || true
  sleep 1
  refresh_dmesg
fi
if ! grep -F -q 'chip id 0x9281' "${OUT}/dmesg.txt"; then
  echo "dmesg has no OV9281 chip id 0x9281. Probe failed." >&2
  grep -i 'ov9281' "${OUT}/dmesg.txt" >&2 || true
  exit 1
fi
echo "probe ok: chip id 0x9281"
grep -E 'ov9281 chip id 0x9281|probing ov9281' "${OUT}/dmesg.txt" | tail -n 5

if [[ ! -e "${DEV}" ]]; then
  echo "missing ${DEV}" >&2
  exit 1
fi

echo "formats on ${DEV}:"
v4l2-ctl -d "${DEV}" --list-formats-ext

# sensor_mode 0 is 1280x800 RAW10 declared as bayer rggb.
# The fourcc is RG10: 10-bit samples in 16-bit little-endian words.
# Treat those words as mono luminance. RGGB is the 8-bit alias and is
# not a mode this tegra-camera.ko will register. bypass_mode=0 keeps
# the frame in V4L2.
v4l2-ctl -d "${DEV}" --set-ctrl=sensor_mode=0
v4l2-ctl -d "${DEV}" --set-ctrl=gain=64
v4l2-ctl -d "${DEV}" --set-ctrl=exposure=10000
if ! v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=0 >/tmp/ov9281-tp0.err 2>&1; then
  echo "test_pattern is not on ${DEV}; scene capture continues"
  cat /tmp/ov9281-tp0.err >&2 || true
fi
if ! v4l2-ctl -d "${DEV}" --set-ctrl=bypass_mode=0 >/tmp/ov9281-bypass.err 2>&1; then
  if grep -qi 'unknown control' /tmp/ov9281-bypass.err; then
    echo "bypass_mode is not on this node; continuing"
  else
    cat /tmp/ov9281-bypass.err >&2
    exit 1
  fi
fi

dump_diag() {
  refresh_dmesg
  echo "sensor timing:"
  grep -F 'ov9281 timing' "${OUT}/dmesg.txt" | tail -n 4 || true
  local node
  for node in /sys/bus/i2c/devices/*-0060/ov9281_timing; do
    if [[ -r "${node}" ]]; then
      echo "sysfs ${node}:"
      cat "${node}" || true
    fi
  done
  echo "recent VI errors:"
  grep -E 'corr_err|uncorr_err' "${OUT}/dmesg.txt" | tail -n 8 || true
  if grep -F -q 'err_data 131072' "${OUT}/dmesg.txt"; then
    echo "err_data 131072 is 0x20000, bit 17, CAPTURE_CHANNEL_ERROR_FORCE_FE."
    echo "VI forced frame end on that frame. Compare the timing line with 1280x800 RAW10, clock=continuous, hts_px=1456."
  fi
}

pixelformat=""
raw="${OUT}/frame.raw"
rm -f "${raw}"
frame_bytes=$((WIDTH * HEIGHT * 2))
for fmt in RG10 RGGB; do
  # A bad CSI frame makes v4l2-ctl wait forever. Bound it, then print
  # the timing readback the driver logged at stream start.
  if timeout 20 v4l2-ctl -d "${DEV}" \
      --set-fmt-video=width=${WIDTH},height=${HEIGHT},pixelformat=${fmt} \
      --stream-mmap --stream-count=10 --stream-to="${raw}"; then
    if [[ -s "${raw}" && $(stat -c%s "${raw}") -ge ${frame_bytes} ]]; then
      pixelformat="${fmt}"
      break
    fi
  fi
  rm -f "${raw}"
done

dump_diag

if [[ -z "${pixelformat}" || ! -s "${raw}" ]]; then
  echo "capture failed for RG10 and RGGB" >&2
  exit 1
fi

echo "captured 10 frames as ${pixelformat} -> ${raw}"
python3 "${ROOT}/frame_stats.py" "${raw}" \
  --width "${WIDTH}" --height "${HEIGHT}" \
  --pixelformat "${pixelformat}" \
  --png "${OUT}/frame0.png"

# exposure=10 and exposure=16000 must not produce the same frame.
# gain stays 64. A matching pair means the new value never latched.
capture_exposure() {
  local us="$1"
  local dest="$2"
  local stats="$3"
  v4l2-ctl -d "${DEV}" --set-ctrl=gain=64
  v4l2-ctl -d "${DEV}" --set-ctrl=exposure="${us}"
  rm -f "${dest}"
  if ! timeout 20 v4l2-ctl -d "${DEV}" \
      --set-fmt-video=width=${WIDTH},height=${HEIGHT},pixelformat=${pixelformat} \
      --stream-mmap --stream-count=5 --stream-to="${dest}"; then
    echo "exposure=${us} capture failed" >&2
    return 1
  fi
  if [[ ! -s "${dest}" || $(stat -c%s "${dest}") -lt ${frame_bytes} ]]; then
    echo "exposure=${us} capture was short" >&2
    return 1
  fi
  python3 "${ROOT}/frame_stats.py" "${dest}" \
    --width "${WIDTH}" --height "${HEIGHT}" \
    --pixelformat "${pixelformat}" \
    --png "${dest%.raw}.png" | tee "${stats}"
}

echo "exposure A/B: gain=64, exposure=10 then exposure=16000"
capture_exposure 10 "${OUT}/exp10.raw" "${OUT}/exp10.stats"
capture_exposure 16000 "${OUT}/exp16000.raw" "${OUT}/exp16000.stats"
mean10=$(awk '/^mean / { print $2 }' "${OUT}/exp10.stats")
mean16000=$(awk '/^mean / { print $2 }' "${OUT}/exp16000.stats")
echo "exposure means: 10us=${mean10} 16000us=${mean16000}"
python3 - "${mean10}" "${mean16000}" <<'PY'
import sys
a = float(sys.argv[1])
b = float(sys.argv[2])
hi = max(abs(a), abs(b), 1.0)
if abs(a - b) / hi < 0.05:
    print("FAIL: exposure=10 and exposure=16000 produced the same frame")
    sys.exit(1)
print("PASS: exposure changed the frame")
PY
dump_diag

bars="${OUT}/bars.raw"
rm -f "${bars}"
echo "optional test pattern: color bars (test_pattern=1, 0x5e00=0x80)"
if ! v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=1 >/tmp/ov9281-tp.err 2>&1; then
  echo "test_pattern control is not on ${DEV}; skipping color bars"
  cat /tmp/ov9281-tp.err >&2 || true
else
  if timeout 20 v4l2-ctl -d "${DEV}" \
      --set-fmt-video=width=${WIDTH},height=${HEIGHT},pixelformat=${pixelformat} \
      --stream-mmap --stream-count=5 --stream-to="${bars}"; then
    if [[ -s "${bars}" && $(stat -c%s "${bars}") -ge ${frame_bytes} ]]; then
      python3 "${ROOT}/frame_stats.py" "${bars}" \
        --width "${WIDTH}" --height "${HEIGHT}" \
        --pixelformat "${pixelformat}" \
        --png "${OUT}/bars.png"
      echo "color bars: ${bars} and ${OUT}/bars.png"
    else
      echo "test pattern capture was short; continuing" >&2
    fi
  else
    echo "test pattern capture failed; continuing" >&2
  fi
  v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=0 || true
  dump_diag
fi
echo "verify finished. Inspect ${OUT}/frame0.png and the exposure means above."
