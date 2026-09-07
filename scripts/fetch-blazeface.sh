#!/bin/bash
# Fetches the BlazeFace ONNX model into the extension's models/ directory.
#
# PRIMARY (what is actually shipped): PINTO_model_zoo 030_BlazeFace, whose directory
# carries its own Apache-2.0 LICENSE and whose url.txt attributes the weights to
# google/mediapipe. The archive is nested — the outer tarball contains per-precision
# archives, and the float32 ONNX lives inside `01_float32/resources_new.tar.gz`. An
# EARLIER VERSION OF THIS SCRIPT WROTE THE OUTER TARBALL STRAIGHT TO $OUT and only
# printed a note telling a human to extract it; that silently produced a gzip file with an
# `.onnx` name, the primary branch "succeeded", and the model that ended up committed came
# from the fallback instead. The extraction is now done here, and the result is verified to
# be an ONNX protobuf rather than an archive.
#
# FALLBACK: an end-to-end export with post-processing baked into the graph. It is
# reachable but carries NO redistribution licence (see NOTICE.txt), so it is a
# last-resort mirror for local development only, never for a shipped artifact.
#
# The two exports have DIFFERENT contracts — primary: NHWC [1,128,128,3] with four raw
# SSD heads; fallback: NCHW [1,3,128,128] with graph-baked threshold/NMS. Both are
# supported: `perception/visual/faceBlur.ts` dispatches on the loaded graph's own shapes.
set -e
OUT="$(dirname "$0")/../extension/src/perception/visual/models/blazeface.onnx"
mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# An ONNX file is a protobuf; a gzip archive starts with 0x1f8b. Rejecting the archive
# (and 404 bodies) is what stops a "successful" fetch from shipping a non-model.
is_onnx() {
  [ -s "$1" ] || return 1
  if head -c 2 "$1" | od -An -tx1 | grep -q "1f 8b"; then return 1; fi
  if head -c 4096 "$1" | grep -qa "Not Found\|<html"; then return 1; fi
}

fetch_primary() {
  curl -sL --max-time 300 \
    "https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/030_BlazeFace/resources.tar.gz" \
    -o "$WORK/outer.tar.gz" || return 1
  tar -xzf "$WORK/outer.tar.gz" -C "$WORK" 030_BlazeFace/01_float32/resources_new.tar.gz || return 1
  tar -xzf "$WORK/030_BlazeFace/01_float32/resources_new.tar.gz" -C "$WORK" \
    face_detection_front_128x128_float32.onnx || return 1
  is_onnx "$WORK/face_detection_front_128x128_float32.onnx" || return 1
  cp "$WORK/face_detection_front_128x128_float32.onnx" "$OUT"
}

fetch_fallback() {
  curl -sL --max-time 120 \
    "https://raw.githubusercontent.com/manthi4/End-to-end-BlazeFace-Onnx/main/T_mpipe_bface_boxes_ops16.onnx" \
    -o "$WORK/fallback.onnx" || return 1
  is_onnx "$WORK/fallback.onnx" || return 1
  cp "$WORK/fallback.onnx" "$OUT"
}

if fetch_primary; then
  echo "source: PINTO0309/PINTO_model_zoo 030_BlazeFace/01_float32 (Apache-2.0, weights from google/mediapipe)"
  echo "contract: NHWC [1,128,128,3], four raw SSD heads — decoded in faceBlur.ts"
elif fetch_fallback; then
  echo "source: manthi4/End-to-end-BlazeFace-Onnx (end-to-end export, NCHW input)"
  echo "WARNING: this mirror has NO redistribution licence — do not ship it. See NOTICE.txt." >&2
else
  echo "FAILED: no reachable model mirror. Face detection degrades gracefully to 0 faces." >&2
  exit 1
fi

echo "model: $OUT ($(stat -c%s "$OUT") bytes, sha256 $(sha256sum "$OUT" | cut -d' ' -f1))"
