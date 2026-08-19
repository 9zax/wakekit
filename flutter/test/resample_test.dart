import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/src/resample.dart';

void main() {
  test('same rate returns the input unchanged (identity, no copy)', () {
    final input = Float32List.fromList([0.1, 0.2, 0.3]);
    final out = resampleLinear(input, 16000, 16000);
    expect(identical(out, input), isTrue);
  });

  test('empty input resamples to empty output', () {
    final out = resampleLinear(Float32List(0), 44100, 16000);
    expect(out, isEmpty);
  });

  test('downsampling halves the length and linearly interpolates', () {
    // 4 samples at 2x the target rate -> length halves; values follow the a + frac*(b-a) formula.
    final input = Float32List.fromList([0.0, 1.0, 2.0, 3.0]);
    final out = resampleLinear(input, 32000, 16000);
    expect(out.length, 2);
    // ratio = 2.0; out[0] at pos 0 -> input[0]=0.0; out[1] at pos 2 -> input[2]=2.0
    expect(out[0], closeTo(0.0, 1e-9));
    expect(out[1], closeTo(2.0, 1e-9));
  });

  test('upsampling doubles the length and interpolates between samples', () {
    final input = Float32List.fromList([0.0, 1.0]);
    final out = resampleLinear(input, 8000, 16000);
    expect(out.length, 4);
    // ratio = 0.5; positions 0, 0.5, 1.0, 1.5. At idx=1 (the last real sample) the missing
    // idx+1 neighbor reads as 0 (out-of-range), which is why out[2]/out[3] taper toward 0
    // rather than holding at 1.0 — same formula as src/index.ts:72-83, including that taper.
    expect(out[0], closeTo(0.0, 1e-9));
    expect(out[1], closeTo(0.5, 1e-9));
    expect(out[2], closeTo(1.0, 1e-9));
    expect(out[3], closeTo(0.5, 1e-9));
  });

  test(
    'reading past the last sample treats the missing neighbor as 0, never throws',
    () {
      final input = Float32List.fromList([1.0]);
      final out = resampleLinear(input, 8000, 16000);
      expect(() => out, returnsNormally);
      expect(out[0], closeTo(1.0, 1e-9));
      expect(
        out[1],
        closeTo(0.5, 1e-9),
      ); // taper toward the missing (0) neighbor
    },
  );
}
