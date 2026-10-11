#!/usr/bin/env bash
# Download the official Ultralytics YOLOv8n COCO ONNX export and build a
# TensorRT FP16 engine with the system trtexec. No pip install.
set -euo pipefail

URL="${VLC_VISION_ONNX_URL:-https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx}"
SHA="${VLC_VISION_ONNX_SHA256:-b2bc52f40e8e1c532427d5bde3575a5d5b571b739fab2c6df443733ed1589cbd}"
OUT_DIR="${VLC_VISION_MODEL_DIR:-/home/royshiber/vlc-companion/models}"
ONNX="${OUT_DIR}/yolov8n.onnx"
ENGINE="${OUT_DIR}/yolov8n_fp16.engine"

if ! command -v trtexec >/dev/null 2>&1; then
  echo '{"ok":false,"error":"trtexec_missing"}' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo '{"ok":false,"error":"curl_missing"}' >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo '{"ok":false,"error":"sha256sum_missing"}' >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
tmp=""
cleanup() {
  if [[ -n "$tmp" && -f "$tmp" ]]; then
    rm -f "$tmp"
  fi
}
trap cleanup EXIT

need_download=1
if [[ -f "$ONNX" ]] && echo "${SHA}  ${ONNX}" | sha256sum -c - >/dev/null 2>&1; then
  need_download=0
fi
if [[ "$need_download" == "1" ]]; then
  tmp="$(mktemp "${OUT_DIR}/yolov8n.onnx.partial.XXXXXX")"
  curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$URL"
  echo "${SHA}  ${tmp}" | sha256sum -c -
  mv -f "$tmp" "$ONNX"
  tmp=""
fi

trtexec --onnx="$ONNX" --saveEngine="$ENGINE" --fp16
if [[ ! -s "$ENGINE" ]]; then
  echo '{"ok":false,"error":"engine_empty"}' >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]] && id royshiber >/dev/null 2>&1; then
  chown -R royshiber:royshiber "$OUT_DIR"
fi

echo "{\"ok\":true,\"onnx\":\"${ONNX}\",\"engine\":\"${ENGINE}\",\"sha256\":\"${SHA}\",\"url\":\"${URL}\",\"backend\":\"opencv\",\"gimbal_steer\":0,\"pip\":false}"
