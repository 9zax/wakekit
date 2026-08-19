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

      // every shipped entry today is trained (pending defaults to false, not a parse error)
      expect(models.every((m) => m.pending == false), isTrue);

      // eval is optional in the schema — parsing must not choke if a future entry omits it
      for (final m in models) {
        if (m.eval != null) {
          expect(m.eval!.recall, inInclusiveRange(0, 1));
        }
      }
    },
  );
}
