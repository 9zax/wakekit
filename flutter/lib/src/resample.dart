/// Dart port of `resampleLinear` in `src/index.ts:72-83`. Fine for speech features; not for
/// playback. Each call resamples independently — no inter-chunk phase carry, a small
/// discontinuity per chunk at non-integral ratios. Same inherited limitation as the web library;
/// fix only if it ever measures on real audio.
library;

import 'dart:typed_data';

Float32List resampleLinear(Float32List input, int inRate, int outRate) {
  if (inRate == outRate) return input;
  final ratio = inRate / outRate;
  final out = Float32List((input.length / ratio).round());
  for (var i = 0; i < out.length; i++) {
    final pos = i * ratio;
    final idx = pos.floor();
    final frac = pos - idx;
    final a = idx < input.length ? input[idx] : 0.0;
    final b = idx + 1 < input.length ? input[idx + 1] : 0.0;
    out[i] = a + frac * (b - a);
  }
  return out;
}
