import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit_example/main.dart';

void main() {
  testWidgets(
    'the manifest-driven picker renders while loadManifest() is pending',
    (tester) async {
      await tester.pumpWidget(const WakekitExampleApp());
      // loadManifest() is async, so the first frame is the loading state — proves the widget tree
      // builds without a real ONNX/mic plugin present (this runs on the `flutter test` VM, not a
      // real device), which is all a plain widget test can promise here.
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    },
  );
}
