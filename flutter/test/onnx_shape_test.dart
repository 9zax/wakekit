import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/src/onnx_shape.dart';

Uint8List _varint(int n) {
  final out = <int>[];
  var v = n;
  while (v > 0x7f) {
    out.add((v & 0x7f) | 0x80);
    v >>= 7;
  }
  out.add(v);
  return Uint8List.fromList(out);
}

Uint8List _ld(int field, List<int> payload) => Uint8List.fromList([
  (field << 3) | 2,
  ..._varint(payload.length),
  ...payload,
]);

Uint8List _vint(int field, int value) =>
    Uint8List.fromList([(field << 3) | 0, ..._varint(value)]);

/// Minimal ModelProto whose graph.input[0] shape is `[1, dim1, 96]`.
Uint8List _fakeHead({required int dim1, bool symbolicDim1 = false}) {
  final dim0 = _vint(1, 1);
  final dim1Bytes = symbolicDim1
      ? _ld(2, 'N'.codeUnits) // dim_param
      : _vint(1, dim1); // dim_value
  final dim2 = _vint(1, 96);
  final shape = [..._ld(1, dim0), ..._ld(1, dim1Bytes), ..._ld(1, dim2)];
  final tensor = _ld(2, shape); // TypeProto.Tensor.shape
  final tensorType = _ld(1, tensor); // TypeProto.tensor_type
  final type = _ld(2, tensorType); // ValueInfoProto.type
  final graph = _ld(11, type); // GraphProto.input[0]
  return _ld(7, graph); // ModelProto.graph
}

void main() {
  final assetsDir = 'assets/models';
  const shared = {
    'melspectrogram.onnx',
    'embedding_model.onnx',
    'manifest.json',
  };

  test(
    'reads embWin=16 off every real trained head, matching src/worker.ts default',
    () {
      final heads = Directory(assetsDir)
          .listSync()
          .whereType<File>()
          .where((f) => f.path.endsWith('.onnx'))
          .where((f) => !shared.contains(f.uri.pathSegments.last));
      expect(heads, isNotEmpty);
      for (final f in heads) {
        expect(
          readHeadInputWindow(f.readAsBytesSync()),
          16,
          reason: f.uri.pathSegments.last,
        );
      }
    },
  );

  test('reads a non-16 dim off a synthetic model', () {
    expect(readHeadInputWindow(_fakeHead(dim1: 8)), 8);
    expect(readHeadInputWindow(_fakeHead(dim1: 24)), 24);
  });

  test('falls back on a symbolic dim_param at index 1', () {
    expect(readHeadInputWindow(_fakeHead(dim1: 8, symbolicDim1: true)), 16);
    expect(
      readHeadInputWindow(_fakeHead(dim1: 8, symbolicDim1: true), fallback: 42),
      42,
    );
  });

  test(
    'falls back on a model with no graph input matching the expected shape',
    () {
      // Not a valid protobuf at all: the walk should fail closed to the fallback, never throw.
      final garbage = List<int>.generate(200, (i) => i % 251);
      expect(readHeadInputWindow(Uint8List.fromList(garbage)), 16);
      expect(
        readHeadInputWindow(Uint8List.fromList(garbage), fallback: 42),
        42,
      );
    },
  );

  test('falls back on empty bytes', () {
    expect(readHeadInputWindow(Uint8List(0)), 16);
  });
}
