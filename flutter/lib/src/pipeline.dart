/// Direct Dart port of `src/worker.ts`'s streaming loop — same constants, same order of
/// operations, same refractory/backlog/error-teardown semantics. The three ONNX model calls are
/// injected as [ModelRunner]s so this class is unit-testable without a real ONNX Runtime; see
/// `test/pipeline_test.dart`. [WakeKit] is the ONNX-session-owning wrapper around this.
library;

import 'dart:async';
import 'dart:typed_data';

/// Runs one ONNX session: [input] reshaped to [shape], returns the flattened output.
typedef ModelRunner =
    Future<List<double>> Function(Float32List input, List<int> shape);

class Pipeline {
  Pipeline({
    required this.runMel,
    required this.runEmb,
    required this.runHead,
    required this.embWin,
    required this.threshold,
    this.verbose = false,
    this.onHit,
    this.onScore,
    this.onError,
  });

  // openWakeWord's fixed feature geometry — properties of the two frozen models, not tunables.
  // STEP is the framework's native cadence: 1280 samples in -> exactly 8 mel frames -> exactly
  // 1 embedding out, so the buffers below advance in lockstep with no bookkeeping.
  static const step = 1280; // 80 ms @ 16 kHz
  static const pad = 480; // melspectrogram.onnx eats 3 hops at its window edge
  static const melWin = 76; // mel frames the embedding model consumes at once
  static const melBins = 32;
  static const embDim = 96;

  /// Re-scoring happens every 80 ms, so one spoken word crosses the bar many times in a row. Long
  /// enough to cover the utterance, short enough that a genuine second call still lands.
  static const refractoryMs = 1500;

  /// ~2 s. A stalled device can fall behind ORT long enough for the backlog to grow without
  /// bound; dropping the oldest audio costs at most a missed word.
  static const backlogCap = 32000;

  final ModelRunner runMel;
  final ModelRunner runEmb;
  final ModelRunner runHead;

  /// Embeddings the trained head expects — read off the head's own input shape (see
  /// `onnx_shape.dart`), not hardcoded, so a head trained with a different window drops in
  /// without a code change.
  final int embWin;

  double threshold;
  bool verbose;

  void Function(double score)? onHit;
  void Function(double score, double atMs)? onScore;
  void Function(Object error)? onError;

  // ponytail: plain growable lists, mirroring the TS worker's own number[]/Float32Array.slice()
  // buffers. A ring buffer would cut the removeRange() copies, but at 12.5 steps/s these are a
  // few thousand doubles each — add one only if profiling ever says otherwise.
  final List<double> _raw = [];
  final List<double> _mel = [];
  final List<double> _emb = [];
  bool _pumping = false;
  double _clockMs =
      0; // audio consumed — the pipeline's own timeline, immune to frame drops
  double _lastHitMs = double.negativeInfinity;

  /// True after a mid-stream inference error; further [push] calls are no-ops (no
  /// auto-recovery — recreate the [WakeKit]).
  bool disposed = false;

  /// The un-drained backlog length — test-only, proves the [backlogCap] actually holds under a
  /// stalled runner without reaching into a private field from outside this library.
  int get debugRawLength => _raw.length;

  /// Drop feature buffers and the clock so the next file scores like a fresh
  /// `eval.mjs` run. Sessions stay loaded — this is not [disposed].
  void debugReset() {
    _raw.clear();
    _mel.clear();
    _emb.clear();
    _clockMs = 0;
    _lastHitMs = double.negativeInfinity;
  }

  /// Feed 16 kHz mono float32 samples. Caps the *undrained* backlog at [backlogCap], then drains.
  /// A one-shot of more than ~2 s is truncated before the first drain — feed in STEP-sized
  /// chunks with a yield between them (as `src/selfcheck.ts` does) so `embWin` can fill.
  void push(Float32List samples) {
    if (disposed) return;
    _raw.addAll(samples);
    if (_raw.length > backlogCap) {
      _raw.removeRange(0, _raw.length - backlogCap);
    }
    unawaited(_pump());
  }

  /// Live retune — no reload.
  void configure({double? threshold, bool? verbose}) {
    if (threshold != null) this.threshold = threshold;
    if (verbose != null) this.verbose = verbose;
  }

  /// Drain `_raw` one STEP at a time. Serialized behind `_pumping` because model calls are async
  /// while chunks keep arriving: without this, two pumps would interleave and corrupt the mel/emb
  /// ring buffers.
  Future<void> _pump() async {
    if (_pumping || disposed) return;
    _pumping = true;
    try {
      while (_raw.length >= step + pad) {
        final window = Float32List.fromList(_raw.sublist(0, step + pad));
        _raw.removeRange(
          0,
          step,
        ); // keep `pad` samples as the next window's history
        _clockMs += (step / 16000) * 1000;

        final frames = await runMel(window, [1, window.length]);
        // openWakeWord's rescale (utils.py: spec = spec/10 + 2). The embedding model was trained
        // on it — skipping this silently halves accuracy.
        for (final f in frames) {
          _mel.add(f / 10 + 2);
        }
        const melNeed = melWin * melBins;
        if (_mel.length > melNeed) _mel.removeRange(0, _mel.length - melNeed);
        if (_mel.length < melNeed) continue; // still filling the first 760 ms

        final embOut = await runEmb(Float32List.fromList(_mel), [
          1,
          melWin,
          melBins,
          1,
        ]);
        _emb.addAll(embOut);
        final embNeed = embWin * embDim;
        if (_emb.length > embNeed) _emb.removeRange(0, _emb.length - embNeed);
        if (_emb.length < embNeed) continue;

        final headOut = await runHead(Float32List.fromList(_emb), [
          1,
          embWin,
          embDim,
        ]);
        final score = headOut[0];
        if (verbose) onScore?.call(score, _clockMs);
        if (score >= threshold && _clockMs - _lastHitMs > refractoryMs) {
          _lastHitMs = _clockMs;
          onHit?.call(score);
        }
      }
    } catch (e) {
      // A run that throws mid-stream would otherwise wedge `_pumping` and silently stop
      // detection — tear down instead, matching src/worker.ts's melS=embS=headS=null.
      disposed = true;
      onError?.call(e);
    } finally {
      _pumping = false;
    }
  }
}
