#!/usr/bin/env bash
# flutter-parity.sh — the score-parity harness from specs/2026-08-19-flutter-lib-pub-dev.md FR-13.
# Runs on macOS (integration tests need real plugin code, not the `flutter test` VM's fakes).
#
#   1. node scripts/eval.mjs --json for every non-pending head -> reference per-clip peak scores.
#   2. flutter test -d macos integration_test/score_clips_test.dart against the Dart pipeline,
#      asserting pos_/neg_ firing AND per-clip |peak_dart - peak_js| <= 0.02.
#
# Needs eval/clips/<id>/ (gitignored, built with scripts/corpus-name.sh — see docs/training.md).
# With no eval/clips/, the integration test's clip tier skips itself; this script still runs the
# tier-1 "every head loads, silence stays silent" check.
set -euo pipefail
cd "$(dirname "$0")/.."

PEAKS_DIR="$(mktemp -d)"
trap 'rm -rf "$PEAKS_DIR"' EXIT

node --input-type=module -e '
  const manifest = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile("models/manifest.json", "utf8")));
  for (const m of manifest.filter((m) => !m.pending)) console.log(`${m.id} ${m.threshold}`);
' | while read -r id threshold; do
  if [ ! -d "eval/clips/$id" ]; then
    echo "  $id: no eval/clips/$id — skipping reference peaks (clip tier will skip too)"
    continue
  fi
  echo "  eval.mjs --json: $id (threshold $threshold)"
  node scripts/eval.mjs "eval/clips/$id" "models/$id.onnx" "$threshold" --json > "$PEAKS_DIR/$id.json"
done

EVAL_DIR=""
if [ -d "eval/clips" ]; then
  EVAL_DIR="$(cd eval/clips && pwd)"
else
  echo "  no eval/clips/ at all — clip tier will skip, tier-1 (load + silence) still runs"
fi

cd flutter/example
flutter test -d macos integration_test/score_clips_test.dart \
  --dart-define="WAKEKIT_EVAL_DIR=$EVAL_DIR" \
  --dart-define="WAKEKIT_PEAKS_DIR=$PEAKS_DIR"
