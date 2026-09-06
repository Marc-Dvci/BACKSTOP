#!/usr/bin/env bash
# Fetch the open-weight model the envelope harness measures.
#
# One checkpoint at three quantisations: the attested precision, a declared element of the
# envelope, and the substitution the settlement tier is written against.
set -euo pipefail

cd "$(dirname "$0")/models" 2>/dev/null || { mkdir -p "$(dirname "$0")/models"; cd "$(dirname "$0")/models"; }
BASE="https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main"

fetch() {
  local src="$1" dst="$2"
  if [ -f "$dst" ]; then echo "  $dst already present"; return; fi
  echo "  fetching $dst"
  curl -sL --fail -o "$dst" "$BASE/$src"
}

fetch "Qwen3-1.7B-BF16.gguf"   "qwen3-1.7b-bf16.gguf"    # attested precision
fetch "Qwen3-1.7B-Q8_0.gguf"   "qwen3-1.7b-q8_0.gguf"    # declared envelope element
fetch "Qwen3-1.7B-Q4_K_M.gguf" "qwen3-1.7b-q4km.gguf"    # substitution

echo "done"
