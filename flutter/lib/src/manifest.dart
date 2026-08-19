/// Dart mirror of `loadManifest` in `src/index.ts:65-69`, reading the bundled asset instead of
/// fetching a URL — models are shipped in the package, not hosted (see the spec's FR-10).
library;

import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;

import 'models.dart';

const _manifestAssetKey = 'packages/wakekit/assets/models/manifest.json';

/// Reads the bundled `models/manifest.json` — the same file the npm package and demo page ship,
/// synced byte-for-byte by `scripts/sync-flutter-assets.mjs`. Never hand-maintain a parallel list
/// of ids/thresholds/labels; this is the single source of truth (CLAUDE.md).
Future<List<WakeModel>> loadManifest() async {
  final raw = await rootBundle.loadString(_manifestAssetKey);
  final list = jsonDecode(raw) as List<dynamic>;
  return list
      .map((e) => WakeModel.fromJson(e as Map<String, dynamic>))
      .toList(growable: false);
}
