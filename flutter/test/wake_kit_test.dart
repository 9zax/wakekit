import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/wakekit.dart';

void main() {
  test(
    'load() on a pending model throws ArgumentError before touching ONNX',
    () async {
      const pending = WakeModel(
        id: 'announced-only',
        label: 'ประกาศแล้ว',
        lang: 'th',
        file:
            'announced-only.onnx', // deliberately does not exist — load() must never reach it
        threshold: 0.95,
        pending: true,
      );

      await expectLater(
        () => WakeKit.load(WakeKitOptions(model: pending)),
        throwsA(isA<ArgumentError>()),
      );
    },
  );
}
