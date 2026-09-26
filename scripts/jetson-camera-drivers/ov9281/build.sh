#!/bin/bash
# Build nv_ov9281.ko and the CAM0 overlay on the Jetson.
# Generates nvidia/conftest.h with NVIDIA's r39.2.1 conftest Makefile so the
# NV_* feature macros match this kernel, then links against nvidia-public
# Module.symvers. After the link, vermagic must equal uname -r and every
# undefined symbol must be in the kernel or nvidia-public Module.symvers.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")" && pwd)
DTSO="tegra234-p3767-camera-p3768-ov9281-A.dts"
DTBO="tegra234-p3767-camera-p3768-ov9281-A.dtbo"
KO="nv_ov9281.ko"
CONFTEST_SRC="${ROOT}/third_party/nvidia-oot-conftest"
CONFTEST_PARENT="${ROOT}/out/nvidia-conftest"
CONFTEST_DST="${CONFTEST_PARENT}/nvidia"

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

# Print symbol names from `nm -u` (the "U" records).
nm_undefined() {
  nm -u "$1" | awk '
    $1 == "U" && NF >= 2 { print $2; next }
    $2 == "U" && NF >= 3 { print $3; next }
  '
}

# Read symbol names on stdin. Print those missing from every Module.symvers
# argument. Exit 1 when any name is missing. Field 2 of a symvers line is
# the symbol (tab-separated: crc, symbol, module, export, namespace).
unresolved_from_symvers() {
  local sym missing=0
  if [[ "$#" -lt 1 ]]; then
    echo "no Module.symvers files" >&2
    return 1
  fi
  while IFS= read -r sym; do
    [[ -z "${sym}" ]] && continue
    if ! awk -F '\t' -v s="${sym}" '$2 == s { found = 1 } END { exit found ? 0 : 1 }' "$@"; then
      echo "unresolved symbol: ${sym}" >&2
      missing=1
    fi
  done
  [[ "${missing}" -eq 0 ]]
}

verify_ko() {
  local ko="$1"
  local krel vermagic
  local -a symfiles=()
  local f

  if ! command -v modinfo >/dev/null 2>&1; then
    echo "modinfo is required (kmod)" >&2
    exit 1
  fi
  if ! command -v nm >/dev/null 2>&1; then
    echo "nm is required (binutils)" >&2
    exit 1
  fi

  krel=$(uname -r)
  vermagic=$(modinfo -F vermagic "${ko}" | awk 'NR == 1 { print $1 }')
  if [[ "${vermagic}" != "${krel}" ]]; then
    echo "vermagic kernel release '${vermagic}' != uname -r '${krel}'" >&2
    modinfo -F vermagic "${ko}" >&2 || true
    exit 1
  fi
  echo "vermagic ok: ${vermagic}"

  for f in \
    "/lib/modules/${krel}/build/Module.symvers" \
    "/lib/modules/${krel}/Module.symvers" \
    "/usr/src/nvidia/nvidia-public/Module.symvers"
  do
    if [[ -f "${f}" ]]; then
      symfiles+=("${f}")
    fi
  done
  if [[ ! -f "/usr/src/nvidia/nvidia-public/Module.symvers" ]]; then
    echo "NVIDIA Module.symvers missing: /usr/src/nvidia/nvidia-public/Module.symvers" >&2
    exit 1
  fi
  if [[ ! -f "/lib/modules/${krel}/build/Module.symvers" && ! -f "/lib/modules/${krel}/Module.symvers" ]]; then
    echo "kernel Module.symvers missing under /lib/modules/${krel}" >&2
    exit 1
  fi

  if ! nm_undefined "${ko}" | unresolved_from_symvers "${symfiles[@]}"; then
    echo "undefined symbols are not in the kernel Module.symvers or nvidia-public Module.symvers" >&2
    exit 1
  fi
  echo "undefined symbols resolve against kernel and nvidia-public Module.symvers"
}

generate_conftest() {
  local krel kdir src out cc
  krel=$(uname -r)
  kdir="/lib/modules/${krel}/build"
  cc="${CC:-gcc}"

  if [[ ! -f "${CONFTEST_SRC}/Makefile" || ! -f "${CONFTEST_SRC}/conftest.sh" || ! -f "${CONFTEST_SRC}/conftest.h" ]]; then
    echo "vendored conftest sources missing in ${CONFTEST_SRC}" >&2
    exit 1
  fi
  if [[ ! -f "${kdir}/Makefile" ]]; then
    echo "kernel headers missing: ${kdir}" >&2
    exit 1
  fi
  if [[ ! -f "${kdir}/include/generated/autoconf.h" ]]; then
    echo "kernel autoconf.h missing: ${kdir}/include/generated/autoconf.h" >&2
    exit 1
  fi
  if [[ ! -d "${kdir}/arch/arm64/include" ]]; then
    echo "arm64 headers missing: ${kdir}/arch/arm64/include" >&2
    exit 1
  fi

  src="${kdir}"
  out="${kdir}"
  if [[ ! -f "${kdir}/Module.symvers" ]]; then
    if [[ ! -f "/lib/modules/${krel}/Module.symvers" ]]; then
      echo "Module.symvers missing in ${kdir} and /lib/modules/${krel}" >&2
      exit 1
    fi
    # conftest reads $NV_KERNEL_OUTPUT/Module.symvers. Do not write into /usr/src.
    out="${ROOT}/out/kernel-headers"
    rm -rf "${out}"
    mkdir -p "${out}"
    ln -s "${kdir}/include" "${out}/include"
    ln -s "${kdir}/arch" "${out}/arch"
    ln -s "/lib/modules/${krel}/Module.symvers" "${out}/Module.symvers"
  fi

  rm -rf "${CONFTEST_PARENT}"
  mkdir -p "${CONFTEST_DST}"
  cp -a "${CONFTEST_SRC}/Makefile" "${CONFTEST_SRC}/conftest.sh" "${CONFTEST_SRC}/conftest.h" "${CONFTEST_DST}/"

  echo "generating nvidia/conftest.h from vendored r39.2.1 conftest against ${src}"
  make -j"$(nproc)" ARCH=arm64 \
    src="${CONFTEST_DST}" obj="${CONFTEST_DST}" \
    CC="${cc}" LD="${LD:-ld}" \
    NV_KERNEL_SOURCES="${src}" \
    NV_KERNEL_OUTPUT="${out}" \
    -f "${CONFTEST_DST}/Makefile"

  if [[ ! -s "${CONFTEST_DST}/conftest.h" || ! -s "${CONFTEST_DST}/conftest/functions.h" ]]; then
    echo "conftest did not write ${CONFTEST_DST}/conftest.h" >&2
    exit 1
  fi
  if ! grep -Eq '^#define |^#undef ' "${CONFTEST_DST}/conftest/functions.h"; then
    echo "conftest functions.h has no feature macros" >&2
    exit 1
  fi
  echo "generated ${CONFTEST_DST}/conftest.h"
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

  generate_conftest

  make -C "${kdir}" M="${ROOT}" clean >/dev/null
  make -C "${kdir}" M="${ROOT}" modules \
    NVIDIA_INCLUDE="${inc}" \
    NVIDIA_CONFTEST="${CONFTEST_PARENT}" \
    -j"$(nproc)"
  if [[ ! -s "${ROOT}/${KO}" ]]; then
    echo "module build did not produce ${KO}" >&2
    exit 1
  fi
  echo "built ${ROOT}/${KO}"
  verify_ko "${ROOT}/${KO}"
}

self_test() {
  local tmp present missing
  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum is required" >&2
    exit 1
  fi
  (
    cd "${CONFTEST_SRC}"
    sha256sum --quiet -c checksums.txt
  )
  tmp=$(mktemp -d)
  printf 'crc\tpresent_sym\tkernel\tEXPORT_SYMBOL\t\n' > "${tmp}/kernel.symvers"
  printf 'crc\tnvidia_sym\tnvidia\tEXPORT_SYMBOL_GPL\t\n' > "${tmp}/nvidia.symvers"
  if printf 'present_sym\nnvidia_sym\n' | unresolved_from_symvers "${tmp}/kernel.symvers" "${tmp}/nvidia.symvers"; then
    :
  else
    echo "self-test: exported symbols were reported missing" >&2
    rm -rf "${tmp}"
    exit 1
  fi
  if printf 'present_sym\nnot_exported\n' | unresolved_from_symvers "${tmp}/kernel.symvers" "${tmp}/nvidia.symvers" >"${tmp}/err" 2>&1; then
    echo "self-test: missing symbol was accepted" >&2
    rm -rf "${tmp}"
    exit 1
  fi
  grep -q 'unresolved symbol: not_exported' "${tmp}/err"
  rm -rf "${tmp}"
  echo "build.sh self-test ok"
}

case "${1:-}" in
  --dtbo-only)
    build_dtbo
    ;;
  --module-only)
    build_module
    ;;
  --self-test)
    self_test
    ;;
  "")
    build_module
    build_dtbo
    ;;
  *)
    echo "usage: build.sh [--dtbo-only|--module-only|--self-test]" >&2
    exit 2
    ;;
esac
