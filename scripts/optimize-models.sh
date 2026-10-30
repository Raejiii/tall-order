#!/usr/bin/env bash
# Shrinks the raw Vi3W GLB exports for the web: welds/simplifies geometry,
# compresses vertices with meshopt and converts textures to WebP.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in raw/*.glb; do
  name=$(basename "$f")
  npx gltf-transform optimize "$f" "public/models/$name" \
    --compress meshopt --texture-compress webp --texture-size 1024 --simplify-error 0.0005
  printf '%-12s %8s -> %8s\n' "$name" "$(du -h "$f" | cut -f1)" "$(du -h "public/models/$name" | cut -f1)"
done
