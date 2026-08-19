import 'dart:async';

import 'package:flutter/material.dart';
import 'package:wakekit/wakekit.dart';

void main() => runApp(const WakekitExampleApp());

class WakekitExampleApp extends StatelessWidget {
  const WakekitExampleApp({super.key});

  @override
  Widget build(BuildContext context) =>
      MaterialApp(title: 'wakekit example', home: const WakekitHomePage());
}

class WakekitHomePage extends StatefulWidget {
  const WakekitHomePage({super.key});

  @override
  State<WakekitHomePage> createState() => _WakekitHomePageState();
}

class _Hit {
  _Hit(this.at, this.score);
  final DateTime at;
  final double score;
}

class _WakekitHomePageState extends State<WakekitHomePage> {
  List<WakeModel>? _models;
  WakeModel? _selected;
  WakeKit? _kit;
  MicSession? _mic;

  double _threshold = 0.95;
  double? _lastScore;
  DateTime? _lastScoreAt;
  double?
  _stepIntervalMs; // observed time between onScore calls — should hover near 80 ms (FR-9)
  final List<_Hit> _hits = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    loadManifest().then((models) {
      setState(() => _models = models);
    });
  }

  bool get _listening => _kit != null;

  Future<void> _start() async {
    final model = _selected;
    if (model == null || model.pending) return;
    setState(() => _error = null);
    try {
      final kit = await WakeKit.load(
        WakeKitOptions(
          model: model,
          verbose: true,
          onHit: (score) =>
              setState(() => _hits.insert(0, _Hit(DateTime.now(), score))),
          onScore: (score, atMs) {
            final now = DateTime.now();
            setState(() {
              _lastScore = score;
              _stepIntervalMs = _lastScoreAt == null
                  ? null
                  : now.difference(_lastScoreAt!).inMicroseconds / 1000;
              _lastScoreAt = now;
            });
          },
          onError: (e) => setState(() {
            _error = '$e';
            _kit = null;
            _mic = null;
          }),
        ),
      );
      kit.configure(threshold: _threshold);
      final mic = await listenMic(kit);
      setState(() {
        _kit = kit;
        _mic = mic;
      });
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<void> _stop() async {
    await _mic?.stop();
    await _kit?.dispose();
    setState(() {
      _mic = null;
      _kit = null;
      _lastScore = null;
      _stepIntervalMs = null;
    });
  }

  @override
  void dispose() {
    unawaited(_mic?.stop());
    unawaited(_kit?.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final models = _models;
    return Scaffold(
      appBar: AppBar(title: const Text('wakekit')),
      body: models == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                for (final m in models)
                  ListTile(
                    enabled: !_listening && !m.pending,
                    onTap: () => setState(() => _selected = m),
                    leading: Icon(
                      _selected?.id == m.id
                          ? Icons.radio_button_checked
                          : Icons.radio_button_unchecked,
                    ),
                    title: Text(m.label),
                    subtitle: Text(
                      m.pending
                          ? 'pending — announced, not trained yet'
                          : '${m.lang} · threshold ${m.threshold}',
                    ),
                  ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: ElevatedButton(
                        onPressed: _listening || _selected == null
                            ? null
                            : _start,
                        child: const Text('Start'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ElevatedButton(
                        onPressed: _listening ? _stop : null,
                        child: const Text('Stop'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text('Threshold: ${_threshold.toStringAsFixed(2)}'),
                Slider(
                  value: _threshold,
                  min: 0.5,
                  max: 1.0,
                  onChanged: (v) {
                    setState(() => _threshold = v);
                    _kit?.configure(
                      threshold: v,
                    ); // live retune (FR-4/FR-5), no reload
                  },
                ),
                if (_error != null)
                  Text(
                    'error: $_error',
                    style: const TextStyle(color: Colors.red),
                  ),
                if (_lastScore != null)
                  Text('score: ${_lastScore!.toStringAsFixed(3)}'),
                if (_stepIntervalMs != null)
                  // Expect ~80 ms/step at a true 16 kHz feed (FR-1's STEP=1280 samples). A device
                  // whose mic negotiated a different real rate shows up here, not as a crash — see
                  // FR-9: `record` reports no negotiated rate, so this readout is the only signal.
                  Text(
                    'observed: ${_stepIntervalMs!.toStringAsFixed(0)} ms/step (expect ~80 ms)',
                  ),
                const Divider(height: 32),
                const Text(
                  'Hits',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                for (final h in _hits.take(20))
                  Text(
                    '${h.at.toIso8601String().substring(11, 19)}  score=${h.score.toStringAsFixed(3)}',
                  ),
              ],
            ),
    );
  }
}
