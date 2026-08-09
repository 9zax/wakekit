// stt-th — one-utterance Thai speech-to-text sidecar for the wakekit Tauri demo.
// Protocol: one JSON object per stdout line: {"type":"interim"|"final"|"error"|"end","text":"..."}
// Always emits "end" last and exits 0 — the JS side treats process death and "end" identically.
// Session shape mirrors the browser's SpeechRecognition continuous=false: partials stream,
// 2s of silence (or a 15s hard cap) ends the utterance, one final, done.

import AVFoundation
import CoreAudio
import Speech

// argv[1] (optional) = input device NAME picked in the tray — resolved against CoreAudio here
// because WebKit's getUserMedia device ids mean nothing outside the webview.
func inputDevice(named want: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
    for id in ids {
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var nameSize = UInt32(MemoryLayout<CFString?>.size)
        var cfName: CFString?
        let err = withUnsafeMutablePointer(to: &cfName) {
            AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, $0)
        }
        if err == noErr, let n = cfName as String?, n == want { return id }
    }
    return nil
}

let out = FileHandle.standardOutput // unbuffered — print() buffers when piped
let nl = "\n".data(using: .utf8)!

func emit(_ type: String, _ text: String = "") {
    let obj = ["type": type, "text": text]
    let data = try! JSONSerialization.data(withJSONObject: obj) // handles Thai/quote escaping
    out.write(data)
    out.write(nl)
}

var ended = false
func finish(_ error: String? = nil) {
    if ended { return }
    ended = true
    if let e = error { emit("error", e) }
    emit("end")
    exit(0)
}

// -- auth (blocking; TCC attributes the prompt to the parent app) --
let speechSem = DispatchSemaphore(value: 0)
var speechAuth = SFSpeechRecognizerAuthorizationStatus.notDetermined
SFSpeechRecognizer.requestAuthorization { s in speechAuth = s; speechSem.signal() }
speechSem.wait()
if speechAuth != .authorized { finish("not-allowed") }

let micSem = DispatchSemaphore(value: 0)
var micOK = false
AVCaptureDevice.requestAccess(for: .audio) { ok in micOK = ok; micSem.signal() }
micSem.wait()
if !micOK { finish("not-allowed") }

// -- recognizer --
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "th-TH")), rec.isAvailable else {
    finish("no-service") // Thai has no on-device model; unavailable usually means offline
    fatalError()
}

let req = SFSpeechAudioBufferRecognitionRequest()
req.shouldReportPartialResults = true

let engine = AVAudioEngine()
let input = engine.inputNode
// "log" lines are ignored by the app but make manual runs debuggable
if CommandLine.arguments.count > 1 {
    let want = CommandLine.arguments[1]
    if var dev = inputDevice(named: want), let au = input.audioUnit {
        let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                      &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        emit("log", "mic '\(want)' -> device \(dev), status \(st)")
    } else {
        emit("log", "mic '\(want)' not found — using system default input")
    }
}
// read the format AFTER the device switch — the old device's format can be a different
// sample rate / channel count, and a mismatched tap captures silence
let fmt = input.inputFormat(forBus: 0)
emit("log", "input format \(fmt.sampleRate)Hz ch\(fmt.channelCount)")
input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in
    req.append(buf)
}

// -- silence timer: 2s since last partial ends the utterance; 15s hard cap from start --
var silenceWork: DispatchWorkItem?
func armSilence(_ seconds: Double) {
    silenceWork?.cancel()
    let w = DispatchWorkItem { req.endAudio() }
    silenceWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { req.endAudio() }

var lastText = ""
rec.recognitionTask(with: req) { result, err in
    if let r = result {
        lastText = r.bestTranscription.formattedString
        if r.isFinal {
            emit("final", lastText)
            finish()
        } else {
            emit("interim", lastText)
            armSilence(2.0)
        }
    }
    if err != nil {
        // endAudio() with speech already captured yields a final via result above; a bare
        // error here means the service gave up — salvage the last partial as the final.
        if !lastText.isEmpty { emit("final", lastText) }
        finish(lastText.isEmpty ? "no-speech" : nil)
    }
}

do {
    engine.prepare()
    try engine.start()
    armSilence(6.0) // nothing said at all → give the user a bit longer than mid-speech silence
} catch {
    finish("audio-capture")
}

// -- abort path: parent closes stdin (or writes anything) → wrap up --
DispatchQueue.global().async {
    _ = readLine() // blocks until a line or EOF
    req.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { finish() }
}

dispatchMain()
