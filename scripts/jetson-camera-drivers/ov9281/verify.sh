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

dmesg_text=$(dmesg 2>/dev/null || true)
if ! printf '%s\n' "${dmesg_text}" | grep -q 'chip id 0x9281'; then
  modprobe nv_ov9281 2>/dev/null || true
  sleep 1
  dmesg_text=$(dmesg 2>/dev/null || true)
fi
if ! printf '%s\n' "${dmesg_text}" | grep -q 'chip id 0x9281'; then
  echo "dmesg has no OV9281 chip id 0x9281. Probe failed." >&2
  printf '%s\n' "${dmesg_text}" | grep -i 'ov9281' >&2 || true
  exit 1
fi
echo "probe ok: chip id 0x9281"
printf '%s\n' "${dmesg_text}" | grep -E 'ov9281 chip id 0x9281|probing ov9281' | tail -n 5

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
if ! v4l2-ctl -d "${DEV}" --set-ctrl=bypass_mode=0 >/tmp/ov9281-bypass.err 2>&1; then
  if grep -qi 'unknown control' /tmp/ov9281-bypass.err; then
    echo "bypass_mode is not on this node; continuing"
  else
    cat /tmp/ov9281-bypass.err >&2
    exit 1
  fi
fi

pixelformat=""
raw="${OUT}/frame.raw"
rm -f "${raw}"
for fmt in RG10 RGGB; do
  if v4l2-ctl -d "${DEV}" \
      --set-fmt-video=width=${WIDTH},height=${HEIGHT},pixelformat=${fmt} \
      --stream-mmap --stream-count=10 --stream-to="${raw}"; then
    pixelformat="${fmt}"
    break
  fi
  rm -f "${raw}"
done

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
