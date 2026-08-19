/// wakekit — wake word detection on-device, openWakeWord-compatible.
///
///   final models = await loadManifest();
///   final kit = await WakeKit.load(WakeKitOptions(
///     model: models.firstWhere((m) => m.id == 'lada'),
///     onHit: (score) => print('wake! $score'),
///   ));
///   final mic = await listenMic(kit);
///   // later: await mic.stop(); await kit.dispose();
///
/// A detection means "the wake word was spoken" — nothing more. Whether your assistant should
/// respond, and to what, is an app-level decision (same contract as the npm package's README).
/// Audio never leaves the device: every model runs locally, no network call exists in this
/// package.
library;

export 'src/manifest.dart' show loadManifest;
export 'src/mic.dart' show MicSession, listenMic;
export 'src/models.dart' show WakeModel, WakeModelEval;
export 'src/resample.dart' show resampleLinear;
export 'src/wake_kit.dart' show WakeKit, WakeKitOptions;
