/// Dart mirror of `listenMic` in `src/index.ts:137-162`. Opens the microphone via `record` and
/// streams it into a [WakeKit]. wakekit's whole pitch is that audio never leaves the device — this
/// makes no network call, same as the browser library.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:record/record.dart';

import 'wake_kit.dart';

/// Tracks which [WakeKit]s currently have an active mic session, without adding claim/release
/// methods to WakeKit's public API for something only this file needs to enforce.
final _activeMic = Expando<bool>('wakekit active mic session');

/// A running microphone capture started by [listenMic]. The ecosystem idiom for "a thing you
/// stop" ([StreamSubscription.cancel], [Timer.cancel]) — an object handle, not a bare function.
/// `WakeKit.dispose()` does NOT stop this: the session owns the mic, so forgetting [stop] leaves
/// the microphone open until it's called (documented limitation, see the spec's edge table).
class MicSession {
  MicSession._(this._kit, this._recorder, this._sub);

  final WakeKit _kit;
  final AudioRecorder _recorder;
  final StreamSubscription<Uint8List> _sub;
  bool _stopped = false;

  Future<void> stop() async {
    if (_stopped) return;
    _stopped = true;
    _activeMic[_kit] = false;
    await _sub.cancel();
    await _recorder.dispose();
  }
}

/// One `record` `pcm16bits` chunk can end on an odd byte (chunk boundaries don't respect 16-bit
/// sample alignment) — this carries the dangling byte into the next chunk instead of dropping or
/// misreading a sample. `getInt16` defaults to big-endian; `record`'s PCM16 stream is little.
@visibleForTesting
class Pcm16Decoder {
  Uint8List? _carry;

  Float32List decode(Uint8List chunk) {
    final joined = _carry == null
        ? chunk
        : (Uint8List(_carry!.length + chunk.length)
            ..setAll(0, _carry!)
            ..setAll(_carry!.length, chunk));
    final sampleCount = joined.length ~/ 2;
    final hasOddByte = joined.length.isOdd;
    _carry = hasOddByte ? Uint8List.sublistView(joined, sampleCount * 2) : null;

    final view = ByteData.sublistView(joined, 0, sampleCount * 2);
    final out = Float32List(sampleCount);
    for (var i = 0; i < sampleCount; i++) {
      out[i] = view.getInt16(i * 2, Endian.little) / 32768;
    }
    return out;
  }
}

/// Requests mic permission, opens a 16 kHz mono PCM16 stream, and pushes it into [kit]. Throws
/// [StateError] if permission is denied or if [kit] already has an active mic session — two
/// recorders feeding one pipeline would corrupt its mel/embedding buffers silently, not loudly.
/// The requested rate is a request, not a fact (`record` reports no negotiated rate) — chunks
/// still route through `push(_, 16000)`, so a mis-rated device is a documented limitation, not a
/// crash.
Future<MicSession> listenMic(WakeKit kit) async {
  if (_activeMic[kit] == true) {
    throw StateError(
      'wakekit: listenMic() already has an active session on this WakeKit',
    );
  }

  final recorder = AudioRecorder();
  final granted = await recorder.hasPermission();
  if (!granted) {
    await recorder.dispose();
    throw StateError('wakekit: microphone permission denied');
  }
  _activeMic[kit] = true;

  final stream = await recorder.startStream(
    const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
    ),
  );
  final decoder = Pcm16Decoder();
  final sub = stream.listen(
    (chunk) => kit.push(decoder.decode(chunk), 16000),
    onError: (Object e) => kit.reportExternalError(e),
  );

  return MicSession._(kit, recorder, sub);
}
