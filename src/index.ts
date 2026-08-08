// wakekit — wake word detection in the browser, openWakeWord-compatible.
//
//   const models = await loadManifest('/');
//   const kit = await WakeKit.load({
//     model: models.find((m) => m.id === 'lada')!,
//     onHit: (score) => console.log('wake!', score),
//   });
//   const stop = await listenMic(kit);
//
// The heavy lifting happens in src/worker.ts (three chained ONNX models on a worker thread); this
// file is the main-thread surface: model manifest, worker lifecycle, resampling, mic capture.

export type WakeModel = {
  /** Stable id — what an app stores as "the chosen wake word". */
  id: string;
  /** Human label for pickers, in the word's own script ("ละดา", "jarvis"). */
  label: string;
  /** BCP-47-ish language tag of the phrase ("th", "en"). */
  lang: string;
  /** Persona gender of the assistant this name addresses — apps pick response voices by it. */
  gender?: 'male' | 'female';
  /** Head filename, relative to `base` — the one per-phrase file. */
  file: string;
  /**
   * The bar THIS head ships at. A threshold belongs to the model, not the app: each head puts its
   * positives and negatives in a different place, so one shared number is wrong the moment a
   * second head exists. Measure it with scripts/eval.mjs before changing it.
   */
  threshold: number;
  /** One line: what the head was trained on and what it measured. */
  note?: string;
  /** Announced but not trained yet — pickers show it disabled, nothing tries to load it. */
  pending?: boolean;
  /** Held-out measurement (unseen speakers) behind `threshold` — see scripts/eval.mjs. */
  eval?: {
    /** Held-out voices never trained on. */
    voices: number;
    posClips: number;
    negClips: number;
    /** Share of pos clips that fired at `threshold`, 0–1. */
    recall: number;
    /** False fires per minute over the negative clips at `threshold`. */
    falseFiresPerMin: number;
  };
};

export type WakeKitOptions = {
  /** Which wake word to load — a manifest entry, or any {file, threshold} pair. */
  model: Pick<WakeModel, 'file' | 'threshold'>;
  /** URL prefix where the .onnx files live. Default '/'. */
  base?: string;
  /** URL prefix for ort-wasm-simd-threaded.{mjs,wasm}. Defaults to `base`. */
  wasmBase?: string;
  /** Also emit every 80 ms score via onScore — for meters/benches, not production. */
  verbose?: boolean;
  /** The wake word was heard (score ≥ threshold, 1.5 s refractory). */
  onHit?: (score: number) => void;
  /** Every step's score, only when verbose. atMs is audio-consumed time. */
  onScore?: (score: number, atMs: number) => void;
  /** The worker died mid-stream (it does not auto-recover — recreate the kit). */
  onError?: (message: string) => void;
};

/** Fetch `${base}manifest.json` — the model registry the demo picker is built from. */
export async function loadManifest(base = '/'): Promise<WakeModel[]> {
  const res = await fetch(base + 'manifest.json');
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  return res.json();
}

/** Linear-interpolation resample. Fine for speech features; not for playback. */
export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const idx = pos | 0;
    const frac = pos - idx;
    out[i] = (input[idx] ?? 0) + frac * ((input[idx + 1] ?? 0) - (input[idx] ?? 0));
  }
  return out;
}

export class WakeKit {
  private constructor(private worker: Worker) {}

  /** Resolves once all three models are live; rejects if any fails to load. */
  static load(opts: WakeKitOptions): Promise<WakeKit> {
    const base = opts.base ?? '/';
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const kit = new WakeKit(w);
    return new Promise((resolve, reject) => {
      w.onmessage = ({ data }: MessageEvent) => {
        const m = data as { type: string; score?: number; atMs?: number; message?: string };
        if (m.type === 'loaded') resolve(kit);
        else if (m.type === 'hit') opts.onHit?.(m.score ?? 0);
        else if (m.type === 'score') opts.onScore?.(m.score ?? 0, m.atMs ?? 0);
        else if (m.type === 'error') {
          opts.onError?.(m.message ?? 'unknown');
          reject(new Error(m.message)); // no-op if already resolved: then onError carries it
        }
      };
      w.onerror = (e) => { opts.onError?.(e.message); reject(new Error(e.message)); };
      w.postMessage({
        type: 'load',
        wasmBase: opts.wasmBase ?? base,
        melUrl: base + 'melspectrogram.onnx',
        embUrl: base + 'embedding_model.onnx',
        headUrl: base + opts.model.file,
        threshold: opts.model.threshold,
        verbose: opts.verbose === true,
      });
    });
  }

  /** Feed audio at any sample rate; resampled to the 16 kHz the models expect. */
  push(f32: Float32Array, sampleRate: number): void {
    this.worker.postMessage({ type: 'push', f32: resampleLinear(f32, sampleRate, 16_000) });
  }

  /** Retune without reloading the models. */
  configure(opts: { threshold?: number; verbose?: boolean }): void {
    this.worker.postMessage({ type: 'config', ...opts });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/**
 * Open the microphone and stream it into `kit`. Returns a stop function that releases everything.
 * ponytail: ScriptProcessorNode — deprecated but universal, and one node with no worklet file to
 * host. Swap for an AudioWorklet if the ~4096-sample latency or the deprecation ever bites.
 */
export async function listenMic(kit: WakeKit): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    // slice(): the buffer is reused by the audio thread; postMessage needs its own copy.
    kit.push(e.inputBuffer.getChannelData(0).slice(), ctx.sampleRate);
  };
  src.connect(proc);
  proc.connect(ctx.destination); // ScriptProcessor only fires while connected to a destination
  return () => {
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
