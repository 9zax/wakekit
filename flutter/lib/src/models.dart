/// Dart mirror of `WakeModel` / `WakeKitOptions` in `src/index.ts:13-62`.
library;

/// Held-out measurement (unseen speakers) behind a model's `threshold` — see `scripts/eval.mjs`.
class WakeModelEval {
  const WakeModelEval({
    required this.voices,
    required this.posClips,
    required this.negClips,
    required this.recall,
    required this.falseFiresPerMin,
  });

  factory WakeModelEval.fromJson(Map<String, dynamic> json) => WakeModelEval(
    voices: json['voices'] as int,
    posClips: json['posClips'] as int,
    negClips: json['negClips'] as int,
    recall: (json['recall'] as num).toDouble(),
    falseFiresPerMin: (json['falseFiresPerMin'] as num).toDouble(),
  );

  /// Held-out voices never trained on.
  final int voices;
  final int posClips;
  final int negClips;

  /// Share of pos clips that fired at `threshold`, 0-1.
  final double recall;

  /// False fires per minute over the negative clips at `threshold`.
  final double falseFiresPerMin;
}

/// One entry in `models/manifest.json` — the model registry the manifest-driven picker (FR-6,
/// FR-12) is built from. Never hand-construct thresholds or ids: read them from [loadManifest].
class WakeModel {
  const WakeModel({
    required this.id,
    required this.label,
    required this.lang,
    required this.file,
    required this.threshold,
    this.gender,
    this.note,
    this.pending = false,
    this.trainClips,
    this.eval,
    this.kind = 'wake',
  });

  factory WakeModel.fromJson(Map<String, dynamic> json) => WakeModel(
    id: json['id'] as String,
    label: json['label'] as String,
    lang: json['lang'] as String,
    file: json['file'] as String,
    threshold: (json['threshold'] as num).toDouble(),
    gender: json['gender'] as String?,
    note: json['note'] as String?,
    pending: json['pending'] as bool? ?? false,
    trainClips: json['trainClips'] as int?,
    eval: json['eval'] == null
        ? null
        : WakeModelEval.fromJson(json['eval'] as Map<String, dynamic>),
    kind: json['kind'] as String? ?? 'wake',
  );

  /// Stable id — what an app stores as "the chosen wake word".
  final String id;

  /// Human label for pickers, in the word's own script ("ละดา", "jarvis").
  final String label;

  /// BCP-47-ish language tag of the phrase ("th", "en").
  final String lang;

  /// Persona gender of the assistant this name addresses — apps pick response voices by it.
  final String? gender;

  /// Head filename inside `assets/models/` — the one per-phrase file.
  final String file;

  /// The bar THIS head ships at. A threshold belongs to the model, not the app: each head puts
  /// its positives and negatives in a different place, so one shared number is wrong the moment
  /// a second head exists. Never hardcode one — always read it from here.
  final double threshold;

  /// One line: what the head was trained on and what it measured.
  final String? note;

  /// Announced but not trained yet — pickers show it disabled; [WakeKit.load] throws on it.
  final bool pending;

  final int? trainClips;

  /// Held-out measurement behind [threshold] — see `scripts/eval.mjs`.
  final WakeModelEval? eval;

  /// 'confirm' heads are the second stage of a dual-stage wake (spec: 2026-08-23-dual-stage-wake-
  /// confirmation) — never a selectable wake word on their own. Defaults to 'wake', so every
  /// existing manifest entry is unaffected.
  final String kind;
}
