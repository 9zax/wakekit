// The score-parity harness (spec FR-13). Verifies the Dart pipeline against
// docs/other-languages.md's standard — "compare the per-clip scores" — not just fire/no-fire.
//
// Two env vars, passed via --dart-define (see scripts/flutter-parity.sh):
//   WAKEKIT_EVAL_DIR   path to eval/clips/ (unset -> clip tier skips; configured-but-unreadable
//                      -> failure, never a silent skip, so a regression can't hide as "fresh clone")
//   WAKEKIT_PEAKS_DIR  path to a directory of <id>.json files (eval.mjs --json output) to compare
//                      per-clip peak scores against, tolerance 0.02
//
// Run from flutter/example/:
//   flutter test -d macos integration_test/score_clips_test.dart \
//     --dart-define=WAKEKIT_EVAL_DIR=/abs/path/to/eval/clips \
//     --dart-define=WAKEKIT_PEAKS_DIR=/abs/path/to/peaks
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:wakekit/wakekit.dart';

const _evalDir = String.fromEnvironment('WAKEKIT_EVAL_DIR');
const _peaksDir = String.fromEnvironment('WAKEKIT_PEAKS_DIR');
// Debug/dev only: restrict the clip tier to one head id for a fast iteration loop. Unset in
// scripts/flutter-parity.sh, which always runs every head.
const _onlyId = String.fromEnvironment('WAKEKIT_ONLY_ID');
const _scoreTolerance = 0.02;

/// Port of src/selfcheck.ts's wav16(): walks RIFF chunks to `data`, including the odd-size pad
/// byte — these clips carry a LIST chunk before `data`, so a fixed 44-byte offset reads metadata
/// as PCM.
Float32List _wav16(File f) {
  final b = f.readAsBytesSync();
  var o = 12;
  while (o < b.length - 8) {
    final id = ascii.decode(b.sublist(o, o + 4));
    final size = ByteData.sublistView(
      b,
      o + 4,
      o + 8,
    ).getUint32(0, Endian.little);
    if (id == 'data') {
      final n = size >> 1;
      final view = ByteData.sublistView(b, o + 8, o + 8 + n * 2);
      final out = Float32List(n);
      for (var i = 0; i < n; i++) {
        out[i] = view.getInt16(i * 2, Endian.little) / 32768;
      }
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw StateError('no data chunk in ${f.path}');
}

/// Pads a clip with 1.5 s of silence at both ends, as src/selfcheck.ts:104-106 does: the head
/// needs ~1.3 s of context before it can score at all, and an unpadded short clip produces zero
/// scores — indistinguishable from a confident no. A live stream always has that lead-in; a file
/// does not.
Float32List _padded(Float32List clip) {
  final pad = Float32List(16000 * 3 ~/ 2);
  return Float32List(pad.length * 2 + clip.length)
    ..setAll(0, pad)
    ..setAll(pad.length, clip)
    ..setAll(pad.length + clip.length, pad);
}

/// Stream [audio] in STEP-sized chunks, waiting for the pump to drain so we never hit
/// [Pipeline.backlogCap]. `Duration.zero` is not enough: `runMel` is a platform-channel
/// future, so a tight yield-loop can enqueue a whole padded clip (>2 s) before the first
/// inference returns, the cap drops the start, and peaks diverge from eval.mjs.
Future<void> _pushInSteps(WakeKit kit, Float32List audio) async {
  const step = 1280;
  const pad = 480;
  for (var i = 0; i < audio.length; i += step) {
    final deadline = DateTime.now().add(const Duration(seconds: 30));
    while (kit.debugRawLength >= step + pad &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }
    final end = i + step > audio.length ? audio.length : i + step;
    kit.push(Float32List.sublistView(audio, i, end), 16000);
  }
}

/// Waits until [progress] (e.g. a running count of `onScore` calls) stops changing for [quiet],
/// or [timeout] elapses. A fixed delay is wrong here: the fake runners in test/pipeline_test.dart
/// resolve instantly, but real ONNX inference on a multi-second padded clip can take well over a
/// second on a debug build, and `push()` fires-and-forgets its drain — there is no future to await.
Future<void> _waitUntilQuiet(
  int Function() progress, {
  Duration quiet = const Duration(milliseconds: 300),
  Duration timeout = const Duration(seconds: 60),
}) async {
  final deadline = DateTime.now().add(timeout);
  var last = progress();
  var lastChange = DateTime.now();
  // The mel/embedding buffers take several steps to fill before the FIRST onScore call — that
  // warm-up gap can itself exceed `quiet`, which would otherwise read as "already settled at
  // zero" and return before inference even started. Only arm the quiet check once real progress
  // has been observed; the timeout is still the backstop if a clip never produces one.
  var sawProgress = last > 0;
  while (DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    final now = progress();
    if (now != last) {
      last = now;
      lastChange = DateTime.now();
      if (now > 0) sawProgress = true;
    } else if (sawProgress && DateTime.now().difference(lastChange) >= quiet) {
      return;
    }
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  test(
    'every non-pending head loads and 3 s of silence produces no hit',
    timeout: const Timeout(Duration(minutes: 5)),
    () async {
      final models = await loadManifest();
      final targets = models.where(
        (m) => !m.pending && (_onlyId.isEmpty || m.id == _onlyId),
      );
      for (final model in targets) {
        var hit = false;
        var scoreCalls = 0;
        Object? err;
        final kit = await WakeKit.load(
          WakeKitOptions(
            model: model,
            verbose: true,
            onHit: (_) => hit = true,
            onScore: (_, __) => scoreCalls++,
            onError: (e) => err = e,
          ),
        );
        await _pushInSteps(kit, Float32List(16000 * 3)); // 3 s of silence
        await _waitUntilQuiet(() => scoreCalls);
        expect(err, isNull, reason: '${model.id}: pipeline errored: $err');
        expect(
          scoreCalls,
          greaterThan(0),
          reason:
              '${model.id}: silence produced no scores (pipeline never filled)',
        );
        expect(hit, isFalse, reason: '${model.id}: fired on silence');
        await kit.dispose();
      }
    },
  );

  test(
    'clip-tier: pos_/neg_ firing and per-clip score parity against eval.mjs --json',
    timeout: const Timeout(Duration(minutes: 90)),
    () async {
      if (_evalDir.isEmpty) {
        // Fresh clone (eval/clips/ is gitignored) — this is a skip, not a failure. A *configured*
        // but unreadable dir below is NOT this path: that must fail, or a sandbox regression could
        // hide behind "looks like a fresh clone" forever.
        return;
      }
      final evalRoot = Directory(_evalDir);
      expect(
        evalRoot.existsSync(),
        isTrue,
        reason:
            'WAKEKIT_EVAL_DIR=$_evalDir is set but not readable — this must fail, not skip',
      );

      final models = await loadManifest();
      var checked = 0;

      final targets = models.where(
        (m) => !m.pending && (_onlyId.isEmpty || m.id == _onlyId),
      );
      for (final model in targets) {
        final clipDir = Directory('${evalRoot.path}/${model.id}');
        if (!clipDir.existsSync()) continue;
        final clips =
            clipDir
                .listSync()
                .whereType<File>()
                .where((f) => f.path.endsWith('.wav'))
                .toList()
              ..sort((a, b) => a.path.compareTo(b.path));
        if (clips.isEmpty) continue;

        Map<String, dynamic>? refPeaks;
        if (_peaksDir.isNotEmpty) {
          final peaksFile = File('$_peaksDir/${model.id}.json');
          if (peaksFile.existsSync()) {
            refPeaks =
                jsonDecode(peaksFile.readAsStringSync())
                    as Map<String, dynamic>;
          }
        }

        // Load ONCE per head and reuse across its clips — matching src/selfcheck.ts's feed(),
        // which never reloads between clips of the same head. This isn't just an optimization
        // (reloading 3 ONNX sessions per clip would make hundreds of clips glacially slow): each
        // clip's leading 1.5 s silence pad is what "washes out" the streaming buffers between
        // clips, same as it does for a real live stream between utterances, so a fresh WakeKit
        // per clip isn't a more faithful test, just a slower one.
        double? peak;
        var hit = false;
        var scoreCalls = 0;
        Object? err;
        final kit = await WakeKit.load(
          WakeKitOptions(
            model: model,
            verbose: true,
            onHit: (_) => hit = true,
            onError: (e) => err = e,
            onScore: (score, _) {
              scoreCalls++;
              peak = (peak == null || score > peak!) ? score : peak;
            },
          ),
        );

        for (final clipFile in clips) {
          final name = clipFile.uri.pathSegments.last.replaceAll('.wav', '');
          peak = null;
          hit = false;
          scoreCalls = 0;
          // eval.mjs scores each clip from empty buffers. Reusing the ONNX
          // sessions is the point of one kit per head; leftover raw/mel/emb
          // would shift the 80 ms window grid and blow the 0.02 peak budget.
          kit.debugReset();
          await _pushInSteps(kit, _padded(_wav16(clipFile)));
          await _waitUntilQuiet(() => scoreCalls);
          expect(
            err,
            isNull,
            reason: '${model.id}/$name: pipeline errored: $err',
          );
          expect(
            scoreCalls,
            greaterThan(0),
            reason:
                '${model.id}/$name: produced no scores (pipeline never filled)',
          );

          checked++;
          if (name.startsWith('pos_')) {
            expect(
              hit,
              isTrue,
              reason:
                  '${model.id}/$name: the wake word was spoken and did not fire',
            );
          } else if (name.startsWith('neg_')) {
            expect(
              hit,
              isFalse,
              reason: '${model.id}/$name: false positive, peak=$peak',
            );
          }

          final refPeak = refPeaks?[name];
          if (refPeak is num) {
            expect(
              peak ?? 0.0,
              closeTo(refPeak.toDouble(), _scoreTolerance),
              reason:
                  '${model.id}/$name: Dart peak vs eval.mjs --json peak diverged beyond $_scoreTolerance',
            );
          }
        }

        await kit.dispose();
      }

      expect(
        checked,
        greaterThan(0),
        reason: 'WAKEKIT_EVAL_DIR was set but no clips were found under it',
      );
    },
  );
}
