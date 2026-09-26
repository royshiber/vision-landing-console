#!/bin/bash
# Host compile test: mainline 6.8 arm64 headers + stubbed tegracam symbols,
# plus the overlay, extlinux self-test, and a synthetic frame.
# Not a substitute for build.sh on the Jetson.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
KSRC="${OV9281_KSRC:-/tmp/linux-6.8.12}"
CROSS="${CROSS_COMPILE:-aarch64-linux-gnu-}"

python3 "${ROOT}/extlinux_overlay.py" --self-test

tmpdir=$(mktemp -d)
trap 'rm -rf "${tmpdir}"' EXIT
python3 - <<PY
import numpy as np
w, h = 1280, 800
frame = np.zeros(w * h, dtype="<u2")
frame[:] = 200
frame[::17] = 800
frame.tofile("${tmpdir}/raw.bin")
PY
python3 "${ROOT}/frame_stats.py" "${tmpdir}/raw.bin" \
  --width 1280 --height 800 --pixelformat Y10 \
  --png "${tmpdir}/frame.png" | tee "${tmpdir}/stats.txt"
grep -q '^mean ' "${tmpdir}/stats.txt"
grep -q '^stddev ' "${tmpdir}/stats.txt"
grep -q 'classification varied' "${tmpdir}/stats.txt"
python3 - <<PY
import numpy as np
np.zeros(1280 * 800, dtype=np.uint8).tofile("${tmpdir}/black.raw")
PY
python3 "${ROOT}/frame_stats.py" "${tmpdir}/black.raw" \
  --pixelformat GREY --png "${tmpdir}/black.png" | grep -q 'classification black'

"${ROOT}/build.sh" --dtbo-only
if ! command -v dtc >/dev/null 2>&1; then
  echo "dtc missing" >&2
  exit 1
fi
dtc -I dtb -O dts "${ROOT}/tegra234-p3767-camera-p3768-ov9281-A.dtbo" \
  | grep -q 'serial_b'
dtc -I dtb -O dts "${ROOT}/tegra234-p3767-camera-p3768-ov9281-A.dtbo" \
  | grep -q 'ovti,ov9281'

if [[ ! -f "${KSRC}/Makefile" ]]; then
  echo "kernel tree ${KSRC} is missing; overlay and script tests passed" >&2
  exit 1
fi
if [[ ! -f "${KSRC}/include/generated/autoconf.h" ]]; then
  make -C "${KSRC}" ARCH=arm64 CROSS_COMPILE="${CROSS}" defconfig
  make -C "${KSRC}" ARCH=arm64 CROSS_COMPILE="${CROSS}" modules_prepare -j"$(nproc)"
fi

make -C "${KSRC}" M="${ROOT}" clean >/dev/null || true
make -C "${KSRC}" M="${ROOT}" modules \
  ARCH=arm64 CROSS_COMPILE="${CROSS}" \
  NVIDIA_INCLUDE="${ROOT}/ci/stubs" \
  COMPILE_TEST_STUBS="${ROOT}/ci/stubs" \
  KBUILD_MODPOST_WARN=1 \
  -j"$(nproc)"
if [[ ! -s "${ROOT}/nv_ov9281.ko" ]]; then
  echo "compile test did not produce nv_ov9281.ko" >&2
  exit 1
fi
file "${ROOT}/nv_ov9281.ko"
echo "compile-test ok: ${ROOT}/nv_ov9281.ko"
# Drop the host-built module so a later Jetson build is obvious.
rm -f "${ROOT}/nv_ov9281.ko" "${ROOT}/nv_ov9281.o" "${ROOT}/nv_ov9281.mod" \
  "${ROOT}/nv_ov9281.mod.c" "${ROOT}/nv_ov9281.mod.o" \
  "${ROOT}/modules.order" "${ROOT}/Module.symvers" \
  "${ROOT}/.nv_ov9281.ko.cmd" "${ROOT}/.nv_ov9281.o.cmd" "${ROOT}/.nv_ov9281.mod.cmd" \
  "${ROOT}/.modules.order.cmd" "${ROOT}/.Module.symvers.cmd"
rm -rf "${ROOT}/.tmp_versions"
