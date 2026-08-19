/// Version-namespaced asset extraction (FR-7). `flutter_onnxruntime`'s own
/// `createSessionFromAsset` is NOT used: it keys its temp file on basename only and skips
/// extraction if that file already exists, so a package upgrade with changed model bytes would
/// silently keep running the old model, and two packages shipping a same-named file collide.
/// This does its own extraction into `<tmp>/wakekit/<wakekitVersion>/<file>` instead.
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:path_provider/path_provider.dart';

import 'version.dart';

const _assetPrefix = 'packages/wakekit/assets/models/';

/// One in-flight (or completed) extraction per destination path — guards against two concurrent
/// `WakeKit.load()` calls both seeing a missing file and writing it at once.
final Map<String, Future<String>> _inFlight = {};

/// Extracts `assets/models/<fileName>` to a real file path an ONNX session can open
/// (`createSession` needs a path; a bundled asset is only readable as bytes). Idempotent: a file
/// already at the right version-path with the right byte length is not rewritten.
Future<String> extractModelAsset(String fileName) {
  return _inFlight.putIfAbsent(fileName, () => _extract(fileName));
}

Future<String> _extract(String fileName) async {
  final tmp = await getTemporaryDirectory();
  final destDir = Directory('${tmp.path}/wakekit/$wakekitVersion');
  final dest = File('${destDir.path}/$fileName');

  final data = await rootBundle.load('$_assetPrefix$fileName');
  final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);

  if (await dest.exists() && await dest.length() == bytes.length) {
    unawaited(_pruneOldVersions(tmp, destDir));
    return dest.path; // already extracted this version, right size — trust it
  }

  await destDir.create(recursive: true);
  // Write to a random temp name then rename: rename is atomic on one filesystem, so a session
  // opening `dest` never sees a half-written file even if two isolates raced past the
  // `_inFlight` guard (e.g. two separate WakeKit.load() calls in different zones).
  final tmpFile = File(
    '${destDir.path}/.$fileName.${identityHashCode(bytes)}.tmp',
  );
  await tmpFile.writeAsBytes(bytes, flush: true);
  await tmpFile.rename(dest.path);
  // Older package versions leave their extracted models behind; drop them best-effort
  // (failure ignored, untested by design — FR-7).
  unawaited(_pruneOldVersions(tmp, destDir));
  return dest.path;
}

Future<void> _pruneOldVersions(Directory tmp, Directory keep) async {
  try {
    final root = Directory('${tmp.path}/wakekit');
    if (!await root.exists()) return;
    await for (final entity in root.list()) {
      if (entity is Directory && entity.path != keep.path) {
        await entity.delete(recursive: true);
      }
    }
  } catch (_) {}
}

/// Reads a model file's raw bytes without going through ONNX — used once per load to walk the
/// head's own input shape (`onnx_shape.dart`), which the ONNX plugin can't report on iOS/macOS.
Future<Uint8List> readModelAssetBytes(String fileName) async {
  final data = await rootBundle.load('$_assetPrefix$fileName');
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}
