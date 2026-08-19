# wakekit

[![pub package](https://img.shields.io/pub/v/wakekit.svg)](https://pub.dev/packages/wakekit)
[![GitHub](https://img.shields.io/badge/GitHub-9zax%2Fwakekit-181717?logo=github)](https://github.com/9zax/wakekit)

**Train a wake word for any language with TTS, run it on-device in Flutter.**
No cloud, no network call — the same two frozen ONNX models as the
[wakekit npm package](https://www.npmjs.com/package/wakekit), plus one ~0.4 MB
trained head per word.

Live demo (browser): [wakekit.vercel.app](https://wakekit.vercel.app)

pub.dev `wakekit` versions are **independent** of npm `wakekit` versions. The
packages share models and behaviour, not a version number.

> A detection means "the wake word was spoken" — nothing more. Whether your
> assistant should respond, and to what, is an app-level decision.

Audio never leaves the device. Models are bundled in the package; inference is
local. There is no network call anywhere in this library.

## Install

```yaml
dependencies:
  wakekit: ^0.1.0
```

## Use

```dart
import 'package:wakekit/wakekit.dart';

final models = await loadManifest();
final kit = await WakeKit.load(WakeKitOptions(
  model: models.firstWhere((m) => m.id == 'lada'),
  onHit: (score) => print('wake word heard! $score'),
));

final mic = await listenMic(kit); // mic → detector, all local
// later: await mic.stop(); await kit.dispose();
```

No mic helper needed? Feed audio from any source:
`kit.push(float32Samples, sampleRate)` — resampling to 16 kHz is handled.
`kit.configure(threshold: …)` retunes live, no reload.

`listenMic` returns a `MicSession`. `WakeKit.dispose()` does **not** stop the
mic — the session owns it. Forgetting `stop()` leaves the microphone open.

A second `listenMic` on a kit that is already listening throws `StateError`.

## Platforms

| | iOS | Android | Windows | Linux | macOS | Web |
|---|---|---|---|---|---|---|
| Inference | yes | yes | yes | yes | no | no |
| Mic (`listenMic`) | yes | yes | build-verified, untested | build-verified, untested | — | — |

Flutter Web is out of scope (the npm package is the wasm runtime). macOS is
not a supported target — the native [WakeKit menu-bar app](https://github.com/9zax/wakekit#macos-app)
covers macOS; the repo's example keeps a macOS runner only as the local test
harness. On Windows and Linux, `push()` is the supported audio path until a
mic smoke test exists.

**Consumer floors**, imposed by the native ONNX Runtime / mic plugins:

- **iOS** ≥ 16.0, `NSMicrophoneUsageDescription`, and
  `use_frameworks! :linkage => :static` in the Podfile
- **Android** minSdk 23, `RECORD_AUDIO`, and ProGuard
  `-keep class ai.onnxruntime.** { *; }`
- **Windows / Linux** first build downloads ONNX Runtime via CMake FetchContent
  (offline CI must pre-seed or set `ONNXRUNTIME_VERSION`)
- **Linux** mic additionally needs system `pulseaudio-utils` and `ffmpeg`

Hot restart (dev): Dart state dies; native ONNX sessions and an open recorder
survive until a full restart. The mic indicator can stay lit. Full restart
clears it. No runtime mitigation in 0.1.0.

## Wake words

The bundled `models/manifest.json` is the single source of truth — ids,
thresholds, labels. Never hardcode a threshold; it belongs to its model.

`WakeKit.load` on a `pending: true` entry throws `ArgumentError` (there is no
`.onnx` to load). Pending entries still appear in `loadManifest()` so a picker
can render them disabled.

## Resampling

`resampleLinear` is a port of the npm helper. Each `push` resamples its chunk
independently — no inter-chunk phase carry — so a non-integral ratio has a small
discontinuity per chunk. Fine for these speech features; not for playback.

## License

Apache-2.0. The two frozen ONNX models come from
[openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0); see
`NOTICE`. Trained heads were built with synthetic voices (TTS).
