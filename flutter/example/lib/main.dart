import 'dart:async';

import 'package:flutter/material.dart';
import 'package:wakekit/wakekit.dart';

// Brand tokens — sampled from the project's own cover art (cover-flutter.png), not guessed.
const _bg = Color(0xFF0B0F0E);
const _panel = Color(0xFF101614);
const _panelBorder = Color(0xFF223029);
const _green = Color(0xFF34D894);
const _white = Color(0xFFF5F7F6);
const _dim = Color(0xFF9AA5A1);
const _red = Color(0xFFEF4444);
const _mono = 'monospace'; // generic family alias — no extra font dependency

void main() => runApp(const WakekitExampleApp());

class WakekitExampleApp extends StatelessWidget {
  const WakekitExampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'wakekit example',
    theme: ThemeData(
      useMaterial3: true,
      scaffoldBackgroundColor: _bg,
      colorScheme: const ColorScheme.dark(
        primary: _green,
        onPrimary: Colors.black,
        surface: _panel,
        onSurface: _white,
        error: _red,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: _bg,
        elevation: 0,
        surfaceTintColor: Colors.transparent,
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: _green,
        inactiveTrackColor: _panelBorder,
        thumbColor: _green,
        overlayColor: _green.withValues(alpha: 0.15),
        valueIndicatorColor: _panel,
        valueIndicatorTextStyle: const TextStyle(
          color: _white,
          fontFamily: _mono,
        ),
      ),
    ),
    home: const WakekitHomePage(),
  );
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
  double _lastScore = 0;
  DateTime? _lastScoreAt;
  double? _stepIntervalMs; // observed ms/step — should hover near 80 (FR-9)
  final List<_Hit> _hits = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    loadManifest().then((models) {
      setState(() {
        _models = models;
        _selected = models.firstWhere(
          (m) => !m.pending,
          orElse: () => models.first,
        );
      });
    });
  }

  bool get _listening => _kit != null;

  Future<void> _toggle() => _listening ? _stop() : _start();

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
      _lastScore = 0;
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
      appBar: AppBar(
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'wakekit',
              style: TextStyle(
                fontFamily: _mono,
                fontWeight: FontWeight.bold,
                color: _green,
                fontSize: 20,
              ),
            ),
            const SizedBox(width: 10),
            Text('example', style: TextStyle(color: _dim, fontSize: 13)),
          ],
        ),
      ),
      body: models == null
          ? const Center(child: CircularProgressIndicator(color: _green))
          : SafeArea(
              child: Column(
                children: [
                  if (_error != null)
                    _ErrorBanner(
                      message: _error!,
                      onDismiss: () => setState(() => _error = null),
                    ),
                  _ModelStrip(
                    models: models,
                    selected: _selected,
                    enabled: !_listening,
                    onSelect: (m) => setState(() => _selected = m),
                  ),
                  Expanded(
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _PulseButton(
                            listening: _listening,
                            score: _lastScore,
                            threshold: _threshold,
                            enabled:
                                _selected != null &&
                                !(_selected?.pending ?? true),
                            onTap: _toggle,
                          ),
                          const SizedBox(height: 20),
                          Text(
                            _listening
                                ? (_selected == null
                                      ? 'listening…'
                                      : 'listening for "${_selected!.label}"')
                                : 'tap to start listening',
                            style: TextStyle(color: _dim, fontSize: 15),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _listening
                                ? 'score ${_lastScore.toStringAsFixed(3)}'
                                : ' ',
                            style: TextStyle(
                              fontFamily: _mono,
                              color: _white,
                              fontSize: 15,
                            ),
                          ),
                          if (_stepIntervalMs != null)
                            Padding(
                              padding: const EdgeInsets.only(top: 4),
                              child: Text(
                                '${_stepIntervalMs!.toStringAsFixed(0)} ms/step · expect ~80',
                                style: TextStyle(
                                  fontFamily: _mono,
                                  color: _dim,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                  _ThresholdSlider(
                    value: _threshold,
                    onChanged: (v) {
                      setState(() => _threshold = v);
                      _kit?.configure(
                        threshold: v,
                      ); // live retune (FR-4/FR-5), no reload
                    },
                  ),
                  _HitPanel(hits: _hits),
                ],
              ),
            ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});
  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    decoration: BoxDecoration(
      color: _red.withValues(alpha: 0.12),
      border: Border.all(color: _red.withValues(alpha: 0.4)),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        const Icon(Icons.error_outline, color: _red, size: 18),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(color: _white, fontSize: 13),
          ),
        ),
        IconButton(
          icon: const Icon(Icons.close, color: _dim, size: 18),
          onPressed: onDismiss,
          tooltip: 'Dismiss error',
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
        ),
      ],
    ),
  );
}

/// Horizontally scrollable wake-word picker — a manifest-driven strip (FR-6/FR-12): pending
/// entries render disabled, nothing about the list is hardcoded.
class _ModelStrip extends StatelessWidget {
  const _ModelStrip({
    required this.models,
    required this.selected,
    required this.enabled,
    required this.onSelect,
  });
  final List<WakeModel> models;
  final WakeModel? selected;
  final bool enabled;
  final ValueChanged<WakeModel> onSelect;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 96,
    child: ListView.separated(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      scrollDirection: Axis.horizontal,
      itemCount: models.length,
      separatorBuilder: (_, __) => const SizedBox(width: 10),
      itemBuilder: (context, i) {
        final m = models[i];
        final isSelected = selected?.id == m.id;
        return _ModelChip(
          model: m,
          selected: isSelected,
          onTap: enabled && !m.pending ? () => onSelect(m) : null,
        );
      },
    ),
  );
}

class _ModelChip extends StatelessWidget {
  const _ModelChip({
    required this.model,
    required this.selected,
    required this.onTap,
  });
  final WakeModel model;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final disabled = onTap == null;
    return Semantics(
      button: true,
      selected: selected,
      label: model.pending
          ? '${model.label}, pending, not trained yet'
          : model.label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          constraints: const BoxConstraints(minWidth: 68),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: selected ? _green.withValues(alpha: 0.12) : _panel,
            border: Border.all(
              color: selected ? _green : _panelBorder,
              width: selected ? 1.5 : 1,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Opacity(
            opacity: disabled ? 0.45 : 1,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  model.label,
                  style: TextStyle(
                    color: selected ? _green : _white,
                    fontWeight: FontWeight.w600,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  // model.id is already the English/romanized name (lada, wayu, jarvis, ...) —
                  // real manifest data, not a fabricated translation.
                  model.pending ? 'pending' : model.id,
                  style: TextStyle(
                    fontFamily: _mono,
                    color: _dim,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The one primary control (start/stop are the same button — one CTA per screen). The rings
/// scale and glow with the live score, not a decorative loop: at rest they sit at a quiet
/// baseline, and visibly swell as a step's score approaches [threshold] — the same signal a
/// user would otherwise only see as a number.
class _PulseButton extends StatelessWidget {
  const _PulseButton({
    required this.listening,
    required this.score,
    required this.threshold,
    required this.enabled,
    required this.onTap,
  });

  final bool listening;
  final double score;
  final double threshold;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // Normalize score against the threshold so the swell is meaningful regardless of how
    // sensitive this particular head's bar is.
    final energy = listening ? (score / threshold).clamp(0.0, 1.0) : 0.0;
    return Semantics(
      button: true,
      label: listening ? 'Stop listening' : 'Start listening',
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        child: SizedBox(
          width: 220,
          height: 220,
          child: Stack(
            alignment: Alignment.center,
            children: [
              for (final ring in [0.55, 0.75, 1.0])
                AnimatedContainer(
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOut,
                  width: 140 + ring * 70 * (0.15 + energy * 0.85),
                  height: 140 + ring * 70 * (0.15 + energy * 0.85),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(
                      color: _green.withValues(
                        alpha: listening
                            ? (0.35 - ring * 0.12) * (0.4 + energy * 0.6)
                            : 0.12,
                      ),
                      width: 1.5,
                    ),
                  ),
                ),
              AnimatedContainer(
                duration: const Duration(milliseconds: 200),
                width: 128,
                height: 128,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: listening
                      ? _green.withValues(alpha: 0.14 + energy * 0.5)
                      : _panel,
                  border: Border.all(
                    color: enabled ? _green : _panelBorder,
                    width: 2,
                  ),
                  boxShadow: listening && energy > 0.5
                      ? [
                          BoxShadow(
                            color: _green.withValues(alpha: 0.35),
                            blurRadius: 24,
                            spreadRadius: 2,
                          ),
                        ]
                      : null,
                ),
                child: Icon(
                  listening ? Icons.mic : Icons.mic_none,
                  color: enabled ? (listening ? _white : _green) : _dim,
                  size: 44,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ThresholdSlider extends StatelessWidget {
  const _ThresholdSlider({required this.value, required this.onChanged});
  final double value;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('sensitivity', style: TextStyle(color: _dim, fontSize: 13)),
            Text(
              value.toStringAsFixed(2),
              style: TextStyle(fontFamily: _mono, color: _white, fontSize: 13),
            ),
          ],
        ),
        Slider(
          value: value,
          min: 0.5,
          max: 1.0,
          label: value.toStringAsFixed(2),
          onChanged: onChanged,
        ),
      ],
    ),
  );
}

/// The hit history — styled after the marketing cover's own code-panel "detected:" line, so the
/// example visually rhymes with the pub.dev listing a developer just came from.
class _HitPanel extends StatelessWidget {
  const _HitPanel({required this.hits});
  final List<_Hit> hits;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 8, 16, 16),
    height: 160,
    decoration: BoxDecoration(
      color: _panel,
      border: Border.all(color: _panelBorder),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Text(
            'hits',
            style: TextStyle(
              fontFamily: _mono,
              color: _dim,
              fontSize: 12,
              letterSpacing: 0.5,
            ),
          ),
        ),
        const Divider(height: 1, color: _panelBorder),
        Expanded(
          child: hits.isEmpty
              ? Center(
                  child: Text(
                    'say the wake word…',
                    style: TextStyle(color: _dim, fontSize: 13),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 6,
                  ),
                  itemCount: hits.length,
                  itemBuilder: (context, i) {
                    final h = hits[i];
                    final time = h.at.toIso8601String().substring(11, 19);
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          const Text(
                            '▲',
                            style: TextStyle(color: _green, fontSize: 12),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            time,
                            style: TextStyle(
                              fontFamily: _mono,
                              color: _dim,
                              fontSize: 13,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Text(
                            'score ${h.score.toStringAsFixed(3)}',
                            style: TextStyle(
                              fontFamily: _mono,
                              color: _white,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
        ),
      ],
    ),
  );
}
