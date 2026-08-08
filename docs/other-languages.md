# Running wakekit models in other languages

The three `.onnx` files in `models/` are plain ONNX — anything with an
[ONNX Runtime](https://onnxruntime.ai/) binding can run them. Get them from this repo, the
[npm package](https://www.npmjs.com/package/wakekit) (`npm i wakekit` →
`node_modules/wakekit/models/`), or the CDN mirror
`https://cdn.jsdelivr.net/npm/wakekit/models/`. Only the ~60 lines of glue in
[`src/worker.ts`](../src/worker.ts) are JavaScript, and every example below is a direct port of it.

## The pipeline (same in every language)

Audio is **16 kHz mono float32 in [-1, 1]** (int16 / 32768). Then, per 80 ms step:

| # | model | input | output | note |
|---|-------|-------|--------|------|
| 1 | `melspectrogram.onnx` | `[1, 1760]` — 1280 new samples + 480 kept from the last window | 8 mel frames × 32 bins | rescale every value: `v / 10 + 2` |
| 2 | `embedding_model.onnx` | `[1, 76, 32, 1]` — last 76 mel frames | 96-d embedding | run once the mel ring is full |
| 3 | `<word>.onnx` (e.g. `lada.onnx`) | `[1, 16, 96]` — last 16 embeddings | `P(word)` in [0, 1] | 16 = the head's input shape `[1]`; read it off the model if you retrain with a different window |

Constants used below: `STEP=1280`, `PAD=480`, `MEL_NEED=76*32`, `EMB_DIM=96`, `EMB_WIN=16`.

Each example scores a raw PCM file and prints threshold crossings. Make one with:

```bash
ffmpeg -i clip.wav -f s16le -ar 16000 -ac 1 clip.raw
```

Error handling is elided and ORT APIs drift between versions — treat these as faithful
pseudocode that is usually also compilable. The reference implementation with the streaming
details (backlog cap, refractory period, live re-tune) stays [`src/worker.ts`](../src/worker.ts).

## Python — `pip install onnxruntime numpy`

```python
import sys
import numpy as np
import onnxruntime as ort

STEP, PAD, MEL_NEED, EMB_DIM = 1280, 480, 76 * 32, 96

mel_s, emb_s, head_s = (ort.InferenceSession(f) for f in
    ("melspectrogram.onnx", "embedding_model.onnx", "lada.onnx"))
EMB_WIN = head_s.get_inputs()[0].shape[1]  # 16 for the shipped heads

def run(s, x, dims):
    return s.run(None, {s.get_inputs()[0].name: np.asarray(x, np.float32).reshape(dims)})[0].ravel()

pcm = np.fromfile(sys.argv[1], np.int16).astype(np.float32) / 32768  # 16 kHz mono s16le

mel = np.empty(0, np.float32)
emb = np.empty(0, np.float32)
for i in range(0, len(pcm) - STEP - PAD + 1, STEP):
    frames = run(mel_s, pcm[i:i + STEP + PAD], (1, -1)) / 10 + 2
    mel = np.append(mel, frames)[-MEL_NEED:]
    if len(mel) < MEL_NEED: continue
    emb = np.append(emb, run(emb_s, mel, (1, 76, 32, 1)))[-EMB_WIN * EMB_DIM:]
    if len(emb) < EMB_WIN * EMB_DIM: continue
    score = run(head_s, emb, (1, EMB_WIN, EMB_DIM))[0]
    if score >= 0.5:
        print(f"hit @ {i / 16000:.2f}s score={score:.3f}")
```

## Node.js — `npm install onnxruntime-node`

```js
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';

const STEP = 1280, PAD = 480, MEL_NEED = 76 * 32, EMB_DIM = 96, EMB_WIN = 16;

const [melS, embS, headS] = await Promise.all(
  ['melspectrogram.onnx', 'embedding_model.onnx', 'lada.onnx']
    .map(f => ort.InferenceSession.create(f)));

const run = async (s, data, dims) => {
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
  return out[s.outputNames[0]].data;
};

const b = readFileSync(process.argv[2]); // 16 kHz mono s16le
const pcm = Float32Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2) / 32768);

let mel = [], emb = [];
for (let i = 0; i + STEP + PAD <= pcm.length; i += STEP) {
  for (const f of await run(melS, pcm.subarray(i, i + STEP + PAD), [1, STEP + PAD]))
    mel.push(f / 10 + 2);
  mel = mel.slice(-MEL_NEED);
  if (mel.length < MEL_NEED) continue;
  emb.push(...await run(embS, Float32Array.from(mel), [1, 76, 32, 1]));
  emb = emb.slice(-EMB_WIN * EMB_DIM);
  if (emb.length < EMB_WIN * EMB_DIM) continue;
  const [score] = await run(headS, Float32Array.from(emb), [1, EMB_WIN, EMB_DIM]);
  if (score >= 0.5) console.log(`hit @ ${(i / 16000).toFixed(2)}s score=${score.toFixed(3)}`);
}
```

(In the browser, use `onnxruntime-web` — that's this repo; see `src/worker.ts`.)

## Rust — `cargo add ort`

```rust
use ort::{session::Session, value::Tensor};

const STEP: usize = 1280;
const PAD: usize = 480;
const MEL_NEED: usize = 76 * 32;
const EMB_DIM: usize = 96;
const EMB_WIN: usize = 16;

fn run(s: &mut Session, data: Vec<f32>, dims: Vec<i64>) -> ort::Result<Vec<f32>> {
    let out = s.run(ort::inputs![Tensor::from_array((dims, data))?])?;
    Ok(out[0].try_extract_tensor::<f32>()?.1.to_vec())
}

fn main() -> ort::Result<()> {
    let mut mel_s = Session::builder()?.commit_from_file("melspectrogram.onnx")?;
    let mut emb_s = Session::builder()?.commit_from_file("embedding_model.onnx")?;
    let mut head_s = Session::builder()?.commit_from_file("lada.onnx")?;

    let bytes = std::fs::read(std::env::args().nth(1).unwrap()).unwrap(); // 16 kHz mono s16le
    let pcm: Vec<f32> = bytes.chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();

    let (mut mel, mut emb) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i + STEP + PAD <= pcm.len() {
        let frames = run(&mut mel_s, pcm[i..i + STEP + PAD].to_vec(), vec![1, (STEP + PAD) as i64])?;
        mel.extend(frames.iter().map(|f| f / 10.0 + 2.0));
        if mel.len() > MEL_NEED { mel.drain(..mel.len() - MEL_NEED); }
        if mel.len() == MEL_NEED {
            emb.extend(run(&mut emb_s, mel.clone(), vec![1, 76, 32, 1])?);
            if emb.len() > EMB_WIN * EMB_DIM { emb.drain(..emb.len() - EMB_WIN * EMB_DIM); }
            if emb.len() == EMB_WIN * EMB_DIM {
                let score = run(&mut head_s, emb.clone(),
                    vec![1, EMB_WIN as i64, EMB_DIM as i64])?[0];
                if score >= 0.5 { println!("hit @ {:.2}s score={score:.3}", i as f32 / 16000.0); }
            }
        }
        i += STEP;
    }
    Ok(())
}
```

## Go — `go get github.com/yalue/onnxruntime_go`

```go
package main

import (
	"encoding/binary"
	"fmt"
	"os"

	ort "github.com/yalue/onnxruntime_go"
)

const step, pad, melNeed, embDim, embWin = 1280, 480, 76 * 32, 96, 16

func open(path string) *ort.DynamicAdvancedSession {
	in, out, _ := ort.GetInputOutputInfo(path)
	s, _ := ort.NewDynamicAdvancedSession(path,
		[]string{in[0].Name}, []string{out[0].Name}, nil)
	return s
}

func run(s *ort.DynamicAdvancedSession, data []float32, dims ...int64) []float32 {
	t, _ := ort.NewTensor(ort.NewShape(dims...), data)
	defer t.Destroy()
	outs := []ort.Value{nil}
	s.Run([]ort.Value{t}, outs)
	defer outs[0].Destroy()
	return append([]float32(nil), outs[0].(*ort.Tensor[float32]).GetData()...)
}

func main() {
	ort.InitializeEnvironment()
	defer ort.DestroyEnvironment()
	melS, embS, headS := open("melspectrogram.onnx"), open("embedding_model.onnx"), open("lada.onnx")

	bytes, _ := os.ReadFile(os.Args[1]) // 16 kHz mono s16le
	pcm := make([]float32, len(bytes)/2)
	for j := range pcm {
		pcm[j] = float32(int16(binary.LittleEndian.Uint16(bytes[j*2:]))) / 32768
	}

	var mel, emb []float32
	for i := 0; i+step+pad <= len(pcm); i += step {
		for _, f := range run(melS, pcm[i:i+step+pad], 1, step+pad) {
			mel = append(mel, f/10+2)
		}
		if len(mel) > melNeed {
			mel = mel[len(mel)-melNeed:]
		}
		if len(mel) < melNeed {
			continue
		}
		emb = append(emb, run(embS, mel, 1, 76, 32, 1)...)
		if len(emb) > embWin*embDim {
			emb = emb[len(emb)-embWin*embDim:]
		}
		if len(emb) < embWin*embDim {
			continue
		}
		if score := run(headS, emb, 1, embWin, embDim)[0]; score >= 0.5 {
			fmt.Printf("hit @ %.2fs score=%.3f\n", float64(i)/16000, score)
		}
	}
}
```

## C# — `dotnet add package Microsoft.ML.OnnxRuntime`

```csharp
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

const int Step = 1280, Pad = 480, MelNeed = 76 * 32, EmbDim = 96, EmbWin = 16;

var melS = new InferenceSession("melspectrogram.onnx");
var embS = new InferenceSession("embedding_model.onnx");
var headS = new InferenceSession("lada.onnx");

float[] Run(InferenceSession s, float[] data, int[] dims)
{
    var input = NamedOnnxValue.CreateFromTensor(s.InputMetadata.Keys.First(),
        new DenseTensor<float>(data, dims));
    using var res = s.Run(new[] { input });
    return res.First().AsEnumerable<float>().ToArray();
}

var bytes = File.ReadAllBytes(args[0]); // 16 kHz mono s16le
var pcm = new float[bytes.Length / 2];
for (int j = 0; j < pcm.Length; j++)
    pcm[j] = BitConverter.ToInt16(bytes, j * 2) / 32768f;

var mel = new List<float>();
var emb = new List<float>();
for (int i = 0; i + Step + Pad <= pcm.Length; i += Step)
{
    foreach (var f in Run(melS, pcm[i..(i + Step + Pad)], new[] { 1, Step + Pad }))
        mel.Add(f / 10 + 2);
    if (mel.Count > MelNeed) mel.RemoveRange(0, mel.Count - MelNeed);
    if (mel.Count < MelNeed) continue;
    emb.AddRange(Run(embS, mel.ToArray(), new[] { 1, 76, 32, 1 }));
    if (emb.Count > EmbWin * EmbDim) emb.RemoveRange(0, emb.Count - EmbWin * EmbDim);
    if (emb.Count < EmbWin * EmbDim) continue;
    var score = Run(headS, emb.ToArray(), new[] { 1, EmbWin, EmbDim })[0];
    if (score >= 0.5) Console.WriteLine($"hit @ {i / 16000.0:F2}s score={score:F3}");
}
```

## Java / Kotlin (JVM, Android) — `com.microsoft.onnxruntime:onnxruntime`

```java
import ai.onnxruntime.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;

public class Wake {
  static final int STEP = 1280, PAD = 480, MEL_NEED = 76 * 32, EMB_DIM = 96, EMB_WIN = 16;
  static final OrtEnvironment env = OrtEnvironment.getEnvironment();

  static float[] run(OrtSession s, float[] data, long[] dims) throws OrtException {
    try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), dims);
         OrtSession.Result r = s.run(Map.of(s.getInputNames().iterator().next(), t))) {
      FloatBuffer fb = ((OnnxTensor) r.get(0)).getFloatBuffer();
      float[] out = new float[fb.remaining()];
      fb.get(out);
      return out;
    }
  }

  static float[] toArr(List<Float> l) {
    float[] r = new float[l.size()];
    for (int i = 0; i < r.length; i++) r[i] = l.get(i);
    return r;
  }

  public static void main(String[] a) throws Exception {
    OrtSession melS = env.createSession("melspectrogram.onnx"),
               embS = env.createSession("embedding_model.onnx"),
               headS = env.createSession("lada.onnx");

    ByteBuffer b = ByteBuffer.wrap(Files.readAllBytes(Path.of(a[0])))
        .order(ByteOrder.LITTLE_ENDIAN); // 16 kHz mono s16le
    float[] pcm = new float[b.remaining() / 2];
    for (int j = 0; j < pcm.length; j++) pcm[j] = b.getShort(j * 2) / 32768f;

    List<Float> mel = new ArrayList<>(), emb = new ArrayList<>();
    for (int i = 0; i + STEP + PAD <= pcm.length; i += STEP) {
      float[] win = Arrays.copyOfRange(pcm, i, i + STEP + PAD);
      for (float f : run(melS, win, new long[]{1, STEP + PAD})) mel.add(f / 10 + 2);
      if (mel.size() > MEL_NEED) mel.subList(0, mel.size() - MEL_NEED).clear();
      if (mel.size() < MEL_NEED) continue;
      for (float v : run(embS, toArr(mel), new long[]{1, 76, 32, 1})) emb.add(v);
      if (emb.size() > EMB_WIN * EMB_DIM) emb.subList(0, emb.size() - EMB_WIN * EMB_DIM).clear();
      if (emb.size() < EMB_WIN * EMB_DIM) continue;
      float score = run(headS, toArr(emb), new long[]{1, EMB_WIN, EMB_DIM})[0];
      if (score >= 0.5) System.out.printf("hit @ %.2fs score=%.3f%n", i / 16000.0, score);
    }
  }
}
```

## C++ — ONNX Runtime C++ API

```cpp
#include <onnxruntime_cxx_api.h>
#include <cstdio>
#include <fstream>
#include <vector>

constexpr int STEP = 1280, PAD = 480, MEL_NEED = 76 * 32, EMB_DIM = 96, EMB_WIN = 16;

static std::vector<float> run(Ort::Session& s, std::vector<float> data,
                              std::vector<int64_t> dims) {
  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeCPU);
  Ort::Value in = Ort::Value::CreateTensor<float>(mem, data.data(), data.size(),
                                                  dims.data(), dims.size());
  Ort::AllocatorWithDefaultOptions alloc;
  auto inName = s.GetInputNameAllocated(0, alloc);
  auto outName = s.GetOutputNameAllocated(0, alloc);
  const char* ins[] = {inName.get()};
  const char* outs[] = {outName.get()};
  auto out = s.Run({}, ins, &in, 1, outs, 1);
  float* p = out[0].GetTensorMutableData<float>();
  return {p, p + out[0].GetTensorTypeAndShapeInfo().GetElementCount()};
}

int main(int argc, char** argv) {
  Ort::Env env;
  Ort::SessionOptions opt;
  Ort::Session melS{env, "melspectrogram.onnx", opt},
               embS{env, "embedding_model.onnx", opt},
               headS{env, "lada.onnx", opt};

  std::ifstream f(argv[1], std::ios::binary); // 16 kHz mono s16le
  std::vector<char> bytes((std::istreambuf_iterator<char>(f)), {});
  std::vector<float> pcm(bytes.size() / 2);
  auto* s16 = reinterpret_cast<int16_t*>(bytes.data());
  for (size_t j = 0; j < pcm.size(); j++) pcm[j] = s16[j] / 32768.f;

  std::vector<float> mel, emb;
  for (size_t i = 0; i + STEP + PAD <= pcm.size(); i += STEP) {
    for (float v : run(melS, {pcm.begin() + i, pcm.begin() + i + STEP + PAD}, {1, STEP + PAD}))
      mel.push_back(v / 10 + 2);
    if (mel.size() > MEL_NEED) mel.erase(mel.begin(), mel.end() - MEL_NEED);
    if (mel.size() < MEL_NEED) continue;
    auto e = run(embS, mel, {1, 76, 32, 1});
    emb.insert(emb.end(), e.begin(), e.end());
    if (emb.size() > EMB_WIN * EMB_DIM) emb.erase(emb.begin(), emb.end() - EMB_WIN * EMB_DIM);
    if (emb.size() < EMB_WIN * EMB_DIM) continue;
    float score = run(headS, emb, {1, EMB_WIN, EMB_DIM})[0];
    if (score >= 0.5) std::printf("hit @ %.2fs score=%.3f\n", i / 16000.0, score);
  }
}
```

(The plain C API is the same calls un-sugared — `OrtApi` function pointers instead of the
`Ort::` wrappers.)

## Swift (iOS / macOS) — `onnxruntime-objc` pod / SPM

```swift
import Foundation
import onnxruntime_objc

let STEP = 1280, PAD = 480, MEL_NEED = 76 * 32, EMB_DIM = 96, EMB_WIN = 16

let env = try ORTEnv(loggingLevel: .warning)
func open(_ p: String) throws -> ORTSession {
  try ORTSession(env: env, modelPath: p, sessionOptions: nil)
}
let melS = try open("melspectrogram.onnx")
let embS = try open("embedding_model.onnx")
let headS = try open("lada.onnx")

func run(_ s: ORTSession, _ data: [Float], _ dims: [NSNumber]) throws -> [Float] {
  let bytes = NSMutableData(bytes: data, length: data.count * 4)
  let t = try ORTValue(tensorData: bytes, elementType: .float, shape: dims)
  let inName = try s.inputNames()[0]
  let outName = try s.outputNames()[0]
  let out = try s.run(withInputs: [inName: t], outputNames: [outName], runOptions: nil)[outName]!
  return try (out.tensorData() as Data).withUnsafeBytes {
    Array($0.bindMemory(to: Float.self))
  }
}

let bytes = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])) // 16 kHz s16le
let pcm: [Float] = bytes.withUnsafeBytes {
  $0.bindMemory(to: Int16.self).map { Float($0) / 32768 }
}

var mel = [Float](), emb = [Float]()
var i = 0
while i + STEP + PAD <= pcm.count {
  for v in try run(melS, Array(pcm[i ..< i + STEP + PAD]), [1, NSNumber(value: STEP + PAD)]) {
    mel.append(v / 10 + 2)
  }
  if mel.count > MEL_NEED { mel.removeFirst(mel.count - MEL_NEED) }
  if mel.count == MEL_NEED {
    emb += try run(embS, mel, [1, 76, 32, 1])
    if emb.count > EMB_WIN * EMB_DIM { emb.removeFirst(emb.count - EMB_WIN * EMB_DIM) }
    if emb.count == EMB_WIN * EMB_DIM {
      let score = try run(headS, emb, [1, NSNumber(value: EMB_WIN), NSNumber(value: EMB_DIM)])[0]
      if score >= 0.5 {
        print(String(format: "hit @ %.2fs score=%.3f", Double(i) / 16000, score))
      }
    }
  }
  i += STEP
}
```

## Porting checklist

Getting a different language to agree with the browser runtime comes down to four details:

1. **Scale**: float32 in [-1, 1] (`int16 / 32768`) — not raw int16 values.
2. **Overlap**: the mel model wants 1760 samples but you advance by 1280 — keep the last 480.
3. **Rescale**: `v / 10 + 2` on every mel value. Skipping it silently halves accuracy.
4. **Windows**: exactly 76 mel frames in, exactly 16 embeddings in (read the head's input shape
   if you retrain with a different window).

To verify a port, run `node scripts/eval.mjs eval/clips models/lada.onnx 0.95` and compare the
per-clip scores against your implementation on the same files.
