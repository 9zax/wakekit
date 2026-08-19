/// Reads exactly one number out of an .onnx file: the second dimension of the first graph
/// input's shape (a trained head is `[1, embWin, 96]` — this is `embWin`). Needed because
/// `flutter_onnxruntime`'s `getInputInfo()` returns no shape on iOS/macOS — its README input/output
/// info matrix marks both platforms unsupported. A ~40-line varint walk over the ModelProto is
/// simpler and more portable than a full protobuf runtime dependency for one integer.
///
/// Field path (protobuf wire format, verified against a real trained head):
/// ModelProto.graph(7) -> GraphProto.input(11)[0] -> ValueInfoProto.type(2) ->
/// TypeProto.tensor_type(1) -> Tensor.shape(2) -> TensorShapeProto.dim(1)[1].dim_value(1)
library;

import 'dart:typed_data';

class _Reader {
  _Reader(this.bytes) : offset = 0;
  final Uint8List bytes;
  int offset;

  bool get atEnd => offset >= bytes.length;

  int readVarint() {
    int result = 0, shift = 0;
    while (true) {
      final b = bytes[offset++];
      result |= (b & 0x7f) << shift;
      if (b & 0x80 == 0) break;
      shift += 7;
    }
    return result;
  }

  Uint8List readLengthDelimited() {
    final len = readVarint();
    final out = Uint8List.sublistView(bytes, offset, offset + len);
    offset += len;
    return out;
  }

  void skip(int wireType) {
    switch (wireType) {
      case 0:
        readVarint();
      case 1:
        offset += 8;
      case 2:
        offset += readVarint();
      case 5:
        offset += 4;
      default:
        throw FormatException('unknown protobuf wire type $wireType');
    }
  }
}

/// Every top-level field in [bytes], keyed by field number. Length-delimited (wire type 2) fields
/// keep their raw bytes; varint (wire type 0) fields keep their int value. Only the FIRST
/// occurrence of a repeated field is kept — callers that need a specific repeated entry (like
/// GraphProto.input, which can repeat) walk the bytes themselves instead of calling this.
Map<int, Object> _firstFields(Uint8List bytes) {
  final r = _Reader(bytes);
  final found = <int, Object>{};
  while (!r.atEnd) {
    final tag = r.readVarint();
    final field = tag >> 3;
    final wireType = tag & 0x7;
    if (wireType == 2) {
      found.putIfAbsent(field, r.readLengthDelimited);
    } else if (wireType == 0) {
      found.putIfAbsent(field, r.readVarint);
    } else {
      r.skip(wireType);
    }
  }
  return found;
}

/// All length-delimited occurrences of [field] in [bytes], in order — for repeated fields where
/// the entry at a specific index is needed (GraphProto.input, TensorShapeProto.dim).
List<Uint8List> _repeated(Uint8List bytes, int field) {
  final r = _Reader(bytes);
  final out = <Uint8List>[];
  while (!r.atEnd) {
    final tag = r.readVarint();
    final f = tag >> 3;
    final wireType = tag & 0x7;
    if (f == field && wireType == 2) {
      out.add(r.readLengthDelimited());
    } else {
      r.skip(wireType);
    }
  }
  return out;
}

/// Reads `graph.input[0]`'s shape `dim[1]` (`dim_value`) from an .onnx model's raw bytes. Falls
/// back to [fallback] (16, matching `src/worker.ts`'s own default) on a symbolic dimension there
/// or any parse surprise — a fallback that still works, never a crash on a model we didn't expect.
int readHeadInputWindow(Uint8List onnxBytes, {int fallback = 16}) {
  try {
    final model = _firstFields(onnxBytes);
    final graphBytes = model[7] as Uint8List?; // ModelProto.graph
    if (graphBytes == null) return fallback;

    final inputs = _repeated(graphBytes, 11); // GraphProto.input (repeated)
    if (inputs.isEmpty) return fallback;

    final valueInfo = _firstFields(inputs.first); // ValueInfoProto
    final typeBytes = valueInfo[2] as Uint8List?; // .type
    if (typeBytes == null) return fallback;

    final type = _firstFields(typeBytes); // TypeProto
    final tensorBytes = type[1] as Uint8List?; // .tensor_type
    if (tensorBytes == null) return fallback;

    final tensor = _firstFields(tensorBytes); // TypeProto.Tensor
    final shapeBytes = tensor[2] as Uint8List?; // .shape
    if (shapeBytes == null) return fallback;

    final dims = _repeated(shapeBytes, 1); // TensorShapeProto.dim (repeated)
    if (dims.length < 2) return fallback;

    final dim = _firstFields(
      dims[1],
    ); // Dimension: dim_value=1 (varint) | dim_param=2 (string)
    final dimValue = dim[1];
    return (dimValue is int && dimValue > 0) ? dimValue : fallback;
  } catch (_) {
    return fallback;
  }
}
