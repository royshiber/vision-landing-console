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
v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=0
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
echo "verify finished. Inspect mean/stddev above and ${OUT}/frame0.png"

bars="${OUT}/bars.raw"
rm -f "${bars}"
echo "test pattern: color bars (test_pattern=1, 0x5e00=0x80)"
v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=1
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
    echo "test pattern capture was short" >&2
    exit 1
  fi
else
  echo "test pattern capture failed" >&2
  exit 1
fi
v4l2-ctl -d "${DEV}" --set-ctrl=test_pattern=0
dump_diag
