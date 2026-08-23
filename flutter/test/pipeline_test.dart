// Streaming-behaviour tests (FR-3) via injectable fake runners — no real ONNX involved. The mel
// and embedding fakes return exactly the buffer sizes Pipeline expects on the FIRST call
// (melWin*melBins and embDim respectively, with embWin=1), so the head fires on every step from
// step 1 onward and `clockMs == (stepIndex + 1) * 80` exactly — makes the refractory-window math
// in each test easy to hand-verify.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/src/pipeline.dart';

const _melNeed = Pipeline.melWin * Pipeline.melBins; // 2432
const _stepBytes =
    Pipeline.step + Pipeline.pad; // one push covers exactly one step

Future<List<double>> _fakeMel(Float32List input, List<int> shape) async =>
    List.filled(_melNeed, 0.0);
Future<List<double>> _fakeEmb(Float32List input, List<int> shape) async =>
    List.filled(Pipeline.embDim, 0.0);

/// Feeds [n] steps as separate `push()` calls, each awaited-drained before the next — matching
/// real streaming, where `pump()` keeps up and the backlog never approaches [Pipeline.backlogCap].
/// (A single giant push of many steps would itself get truncated by the cap before draining even
/// starts, which is a different scenario — see the dedicated stalled-runner test below.)
Future<void> _pushSteps(Pipeline pipeline, int n) async {
  pipeline.push(
    Float32List(_stepBytes),
  ); // primes the buffer: first window needs step+pad
  await Future<void>.delayed(Duration.zero);
  for (var i = 1; i < n; i++) {
    pipeline.push(
      Float32List(Pipeline.step),
    ); // steady state: pad already sits in raw
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test(
    'two crossings 1 s apart merge into one hit (inside the 1500 ms refractory)',
    () async {
      final hits = <double>[];
      final scores = List<double>.filled(50, 0.1);
      scores[9] = 0.9; // step 10 (0-indexed 9) -> clockMs = 800
      scores[21] =
          0.9; // step 22 -> clockMs = 1760; delta from first hit = 960 ms < 1500

      var call = 0;
      final pipeline = Pipeline(
        runMel: _fakeMel,
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [scores[call++]],
        embWin: 1,
        threshold: 0.5,
        onHit: hits.add,
      );

      await _pushSteps(pipeline, 30);

      expect(hits, [closeTo(0.9, 1e-9)]); // only the first crossing fired
    },
  );

  test(
    'crossings 2 s apart both fire (outside the refractory window)',
    () async {
      final hits = <double>[];
      final scores = List<double>.filled(50, 0.1);
      scores[9] = 0.9; // clockMs = 800
      scores[34] = 0.9; // clockMs = 2800; delta = 2000 ms > 1500

      var call = 0;
      final pipeline = Pipeline(
        runMel: _fakeMel,
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [scores[call++]],
        embWin: 1,
        threshold: 0.5,
        onHit: hits.add,
      );

      await _pushSteps(pipeline, 40);

      expect(hits.length, 2);
    },
  );

  test(
    'backlog never exceeds backlogCap even against a stalled runner',
    () async {
      final stall =
          Completer<List<double>>(); // never completes -> _pump wedges mid-run
      final pipeline = Pipeline(
        runMel: (input, shape) => stall.future,
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [0.0],
        embWin: 1,
        threshold: 0.5,
      );

      // Push far more than backlogCap across several calls, matching real streaming (push arrives
      // in chunks, not one giant buffer).
      for (var i = 0; i < 40; i++) {
        pipeline.push(Float32List(Pipeline.step));
      }
      await Future<void>.delayed(Duration.zero);

      expect(pipeline.debugRawLength, lessThanOrEqualTo(Pipeline.backlogCap));
      expect(pipeline.disposed, isFalse); // stalled, not errored
    },
  );

  test(
    'embWin=16 fills after ~2 s of chunked audio (real mel/emb sizes, not the instant fakes)',
    () async {
      var scores = 0;
      final pipeline = Pipeline(
        // Real melspectrogram.onnx emits 8 frames × 32 bins per STEP, not a full window.
        runMel: (input, shape) async => List.filled(8 * Pipeline.melBins, 0.0),
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [0.1],
        embWin: 16,
        threshold: 0.5,
        verbose: true,
        onScore: (_, __) => scores++,
      );

      // 3 s of silence, STEP chunks + yield — same as src/selfcheck.ts. A one-shot of
      // this buffer hits backlogCap and never produces a score (that's the cap working).
      final audio = Float32List(16000 * 3);
      for (var i = 0; i < audio.length; i += Pipeline.step) {
        final end = i + Pipeline.step > audio.length
            ? audio.length
            : i + Pipeline.step;
        pipeline.push(Float32List.sublistView(audio, i, end));
        await Future<void>.delayed(Duration.zero);
      }
      await Future<void>.delayed(Duration.zero);

      expect(scores, greaterThan(0));
    },
  );

  test(
    'a throwing runner tears down after exactly one onError; push becomes a no-op',
    () async {
      var errorCount = 0;
      final pipeline = Pipeline(
        runMel: (input, shape) async => throw StateError('boom'),
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [0.0],
        embWin: 1,
        threshold: 0.5,
        onError: (_) => errorCount++,
      );

      await _pushSteps(pipeline, 1);
      expect(errorCount, 1);
      expect(pipeline.disposed, isTrue);

      // Further pushes are no-ops — no second error, no crash, no resumed draining.
      await _pushSteps(pipeline, 5);
      expect(errorCount, 1);
    },
  );

  // ---- Dual-stage wake gating (spec: 2026-08-23-dual-stage-wake-confirmation) ----
  // Mirrors src/selfcheck.ts's dual-stage assertions (T-4/T-5/T-6) against the Dart pipeline.

  test('confirm head never runs while the primary never crosses (FR-3)', () async {
    var confirmRunCount = 0;
    final pipeline = Pipeline(
      runMel: _fakeMel,
      runEmb: _fakeEmb,
      runHead: (input, shape) async => [0.1], // never crosses threshold
      runConfirm: (input, shape) async {
        confirmRunCount++;
        return [0.9];
      },
      embWin: 1,
      threshold: 0.5,
      confirmThreshold: 0.5,
    );

    await _pushSteps(pipeline, 20);

    expect(confirmRunCount, 0);
    expect(pipeline.confirmRuns, 0);
  });

  test(
    'primary crossing arms the confirm head; a confirm crossing fires onHit with the PRIMARY score (FR-2/FR-4)',
    () async {
      final armed = <double>[];
      final hits = <double>[];
      var headCall = 0;
      var confirmCall = 0;
      final pipeline = Pipeline(
        runMel: _fakeMel,
        runEmb: _fakeEmb,
        // First step crosses (arms); after that, stay low so no accidental re-arm.
        runHead: (input, shape) async => [headCall++ == 0 ? 0.9 : 0.1],
        // First confirm run (on the step right after arming) crosses immediately.
        runConfirm: (input, shape) async {
          confirmCall++;
          return [0.9];
        },
        embWin: 1,
        threshold: 0.5,
        confirmThreshold: 0.5,
        onArm: armed.add,
        onHit: hits.add,
      );

      await _pushSteps(pipeline, 5);

      expect(armed, [closeTo(0.9, 1e-9)]);
      expect(
        hits,
        [closeTo(0.9, 1e-9)],
      ); // the PRIMARY's armed score, not the confirm head's
      expect(confirmCall, 1); // disarmed immediately after the hit
    },
  );

  test(
    'confirm window expires with no confirmation -> onArmExpire, never onHit (FR-5)',
    () async {
      final armed = <double>[];
      final expired = <void>[];
      final hits = <double>[];
      var headCall = 0;
      var confirmRunCount = 0;
      final pipeline = Pipeline(
        runMel: _fakeMel,
        runEmb: _fakeEmb,
        runHead: (input, shape) async => [headCall++ == 0 ? 0.9 : 0.1],
        // Confirm phrase is never heard.
        runConfirm: (input, shape) async {
          confirmRunCount++;
          return [0.1];
        },
        embWin: 1,
        threshold: 0.5,
        confirmThreshold: 0.5,
        confirmWindowMs: 2500,
        onArm: armed.add,
        onArmExpire: () => expired.add(null),
        onHit: hits.add,
      );

      // 2500 ms window / 80 ms per step ≈ 32 steps; push well past it.
      await _pushSteps(pipeline, 40);

      expect(armed.length, 1);
      expect(expired.length, 1);
      expect(hits, isEmpty);
      expect(confirmRunCount, greaterThan(0)); // ran inside the window, per FR-3's other half
    },
  );
}
