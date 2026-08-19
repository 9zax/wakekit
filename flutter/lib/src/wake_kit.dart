/// Dart mirror of `WakeKit` / `WakeKitOptions` in `src/index.ts:47-130`. Owns the three ONNX
/// sessions (mel, embedding, head) and drives them through a [Pipeline].
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_onnxruntime/flutter_onnxruntime.dart';

import 'assets.dart';
import 'models.dart';
import 'onnx_shape.dart';
import 'pipeline.dart';
import 'resample.dart';

/// Options for [WakeKit.load]. Callback-based, mirroring `WakeKitOptions` in `src/index.ts:47-62`
/// — a Flutter-native pattern, and it keeps this README teachable side by side with the npm one.
class WakeKitOptions {
  const WakeKitOptions({
    required this.model,
    this.verbose = false,
    this.onHit,
    this.onScore,
    this.onError,
  });

  /// Which wake word to load — a manifest entry from [loadManifest]. Loading a `pending: true`
  /// entry throws [ArgumentError] before touching ONNX: there is no trained head to load.
  final WakeModel model;

  /// Also emit every 80 ms score via [onScore] — for meters/benches, not production.
  final bool verbose;

  /// The wake word was heard (score >= threshold, 1.5 s refractory).
  final void Function(double score)? onHit;

  /// Every step's score, only when [verbose] is true. `atMs` is audio-consumed time.
  final void Function(double score, double atMs)? onScore;

  /// The pipeline died mid-stream (a mid-stream inference error, or an external error reported
  /// through a [MicSession]). It does not auto-recover — recreate the kit.
  final void Function(Object error)? onError;
}

ModelRunner _sessionRunner(OrtSession session) {
  return (Float32List input, List<int> shape) async {
    final inputValue = await OrtValue.fromList(input, shape);
    final outputs = await session.run({session.inputNames.first: inputValue});
    await inputValue.dispose();
    final outValue = outputs[session.outputNames.first]!;
    final flat = await outValue.asFlattenedList();
    for (final v in outputs.values) {
      await v.dispose();
    }
    return flat.map((e) => (e as num).toDouble()).toList(growable: false);
  };
}

/// Loads the three ONNX models for one wake word and streams audio through them. One instance per
/// active wake word; `dispose()` when done, then create a new one to switch words.
class WakeKit {
  WakeKit._(
    this._pipeline,
    this._melSession,
    this._embSession,
    this._headSession,
  );

  final Pipeline _pipeline;
  final OrtSession _melSession;
  final OrtSession _embSession;
  final OrtSession _headSession;

  static final OnnxRuntime _runtime = OnnxRuntime();

  /// Resolves once all three models are live; rejects if any fails to load.
  static Future<WakeKit> load(WakeKitOptions opts) async {
    if (opts.model.pending) {
      throw ArgumentError(
        'WakeKit.load: "${opts.model.id}" is pending — announced but not trained yet, nothing to load',
      );
    }

    final melPath = await extractModelAsset('melspectrogram.onnx');
    final embPath = await extractModelAsset('embedding_model.onnx');
    final headPath = await extractModelAsset(opts.model.file);

    final melSession = await _runtime.createSession(melPath);
    final embSession = await _runtime.createSession(embPath);
    final headSession = await _runtime.createSession(headPath);

    // getInputInfo() reports no shape on iOS/macOS (flutter_onnxruntime's own support matrix) —
    // read the head's embWin straight out of its .onnx bytes instead, on every platform alike.
    final headBytes = await readModelAssetBytes(opts.model.file);
    final embWin = readHeadInputWindow(headBytes);

    late final WakeKit kit;
    final pipeline = Pipeline(
      runMel: _sessionRunner(melSession),
      runEmb: _sessionRunner(embSession),
      runHead: _sessionRunner(headSession),
      embWin: embWin,
      threshold: opts.model.threshold,
      verbose: opts.verbose,
      onHit: opts.onHit,
      onScore: opts.onScore,
      onError: (e) {
        unawaited(kit._closeSessions());
        opts.onError?.call(e);
      },
    );
    kit = WakeKit._(pipeline, melSession, embSession, headSession);
    return kit;
  }

  /// Undrained 16 kHz backlog — test-only, so the parity harness can wait for the pump
  /// to keep up instead of flooding past [Pipeline.backlogCap].
  @visibleForTesting
  int get debugRawLength => _pipeline.debugRawLength;

  /// Clear feature buffers between isolated file scores (eval.mjs starts each clip
  /// empty). Does not close sessions.
  @visibleForTesting
  void debugReset() => _pipeline.debugReset();

  /// Feed audio at any sample rate; resampled to the 16 kHz the models expect. No-op once the
  /// kit has died (a mid-stream error, or after [dispose]).
  void push(Float32List samples, int sampleRate) {
    if (_pipeline.disposed) return;
    _pipeline.push(resampleLinear(samples, sampleRate, 16000));
  }

  /// Retune without reloading the models.
  void configure({double? threshold, bool? verbose}) {
    if (_pipeline.disposed) return;
    _pipeline.configure(threshold: threshold, verbose: verbose);
  }

  /// Not part of the public contract — [MicSession] calls this to route a mic-stream error
  /// through this kit's `onError`. Delegates to the same closure the pipeline's own mid-stream
  /// errors use (set in [load]), which closes the sessions exactly once and forwards to the
  /// caller's `onError` — do not close sessions here too, or they'd close twice.
  void reportExternalError(Object error) {
    if (_pipeline.disposed) return;
    _pipeline.disposed = true;
    _pipeline.onError?.call(error);
  }

  Future<void> dispose() async {
    if (_pipeline.disposed) return;
    _pipeline.disposed = true;
    await _closeSessions();
  }

  Future<void> _closeSessions() async {
    await _melSession.close();
    await _embSession.close();
    await _headSession.close();
  }
}
