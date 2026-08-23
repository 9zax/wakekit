import 'package:flutter_test/flutter_test.dart';
import 'package:wakekit/wakekit.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'loadManifest reads the bundled manifest.json, incl. pending and missing eval',
    () async {
      final models = await loadManifest();
      expect(models, isNotEmpty);

      final lada = models.firstWhere((m) => m.id == 'lada');
      expect(lada.lang, 'th');
      expect(lada.threshold, greaterThan(0));
      expect(lada.threshold, lessThanOrEqualTo(1));
      expect(lada.pending, isFalse);

      // every shipped WAKE entry today is trained (pending defaults to false, not a parse error).
      // A 'confirm' head (dual-stage wake, spec: 2026-08-23-dual-stage-wake-confirmation) may
      // legitimately ship pending — it stays disabled/unselectable until trained.
      expect(
        models.where((m) => m.kind != 'confirm').every((m) => m.pending == false),
        isTrue,
      );

      // 'confirm' heads parse and are never a selectable wake word alongside the real ones.
      final confirmHeads = models.where((m) => m.kind == 'confirm');
      expect(confirmHeads, isNotEmpty); // khrapkha, today
      for (final m in confirmHeads) {
        expect(m.lang, isNotEmpty);
      }

      // eval is optional in the schema — parsing must not choke if a future entry omits it
      for (final m in models) {
        if (m.eval != null) {
          expect(m.eval!.recall, inInclusiveRange(0, 1));
        }
      }
    },
  );
}
