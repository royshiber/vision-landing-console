#!/bin/bash
# Build nv_ov9281.ko and the CAM0 overlay on the Jetson.
# Uses the running kernel's headers plus NVIDIA's nvidia-public Module.symvers.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DTSO="tegra234-p3767-camera-p3768-ov9281-A.dts"
DTBO="tegra234-p3767-camera-p3768-ov9281-A.dtbo"
KO="nv_ov9281.ko"

build_dtbo() {
  local pre="${ROOT}/${DTSO}.preprocessed"
  if ! command -v cpp >/dev/null 2>&1; then
    echo "cpp is required (build-essential)" >&2
    exit 1
  fi
  if ! command -v dtc >/dev/null 2>&1; then
    echo "dtc is required (device-tree-compiler)" >&2
    exit 1
  fi
  cpp -nostdinc -undef -D__DTS__ -x assembler-with-cpp \
    -I "${ROOT}/include" \
    -o "${pre}" \
    "${ROOT}/${DTSO}"
  dtc -@ -I dts -O dtb -Wno-unit_address_vs_reg -Wno-graph_child_address \
    -o "${ROOT}/${DTBO}" "${pre}"
  rm -f "${pre}"
  if [[ ! -s "${ROOT}/${DTBO}" ]]; then
    echo "dtc produced an empty overlay" >&2
    exit 1
  fi
  echo "built ${ROOT}/${DTBO}"
}

build_module() {
  local krel kdir sym inc
  krel=$(uname -r)
  kdir="/lib/modules/${krel}/build"
  sym="/usr/src/nvidia/nvidia-public/Module.symvers"
  inc="/usr/src/nvidia/nvidia-public/include"
  if [[ ! -f "${kdir}/Makefile" ]]; then
    echo "kernel headers missing: ${kdir}" >&2
    exit 1
  fi
  if [[ ! -f "${sym}" ]]; then
    echo "NVIDIA Module.symvers missing: ${sym}" >&2
    exit 1
  fi
  if [[ ! -f "${inc}/media/tegracam_core.h" ]]; then
    echo "NVIDIA tegracam headers missing: ${inc}/media/tegracam_core.h" >&2
    exit 1
  fi
  make -C "${kdir}" M="${ROOT}" modules \
    NVIDIA_INCLUDE="${inc}" \
    -j"$(nproc)"
  if [[ ! -s "${ROOT}/${KO}" ]]; then
    echo "module build did not produce ${KO}" >&2
    exit 1
  fi
  echo "built ${ROOT}/${KO}"
}

case "${1:-}" in
  --dtbo-only)
    build_dtbo
    ;;
  --module-only)
    build_module
    ;;
  "")
    build_module
    build_dtbo
    ;;
  *)
    echo "usage: build.sh [--dtbo-only|--module-only]" >&2
    exit 2
    ;;
esac
