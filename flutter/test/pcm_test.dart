import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/src/mic.dart';

void main() {
  test('PCM16 little-endian decodes to float32 in [-1, 1)', () {
    // 0x1234 LE = bytes 0x34, 0x12; 0x0000; 0x8000 (most-negative int16).
    final chunk = Uint8List.fromList([0x34, 0x12, 0x00, 0x00, 0x00, 0x80]);
    final out = Pcm16Decoder().decode(chunk);
    expect(out.length, 3);
    expect(out[0], closeTo(0x1234 / 32768, 1e-9));
    expect(out[1], closeTo(0.0, 1e-9));
    expect(out[2], closeTo(-1.0, 1e-9));
  });

  test('an odd-length chunk carries the dangling byte into the next chunk', () {
    final dec = Pcm16Decoder();
    // First chunk ends mid-sample (the 0x12 of 0x1234).
    final first = dec.decode(Uint8List.fromList([0x34]));
    expect(first, isEmpty);
    final second = dec.decode(Uint8List.fromList([0x12, 0x00, 0x00]));
    expect(second.length, 2);
    expect(second[0], closeTo(0x1234 / 32768, 1e-9));
    expect(second[1], closeTo(0.0, 1e-9));
  });

  test('decode is little-endian, not the ByteData default of big-endian', () {
    // 0x0100 as LE is 256; as BE it would be 1. The two readings are far apart.
    final out = Pcm16Decoder().decode(Uint8List.fromList([0x00, 0x01]));
    expect(out.single, closeTo(256 / 32768, 1e-9));
    expect(out.single, isNot(closeTo(1 / 32768, 1e-9)));
  });
}
