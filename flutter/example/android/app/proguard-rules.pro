# flutter_onnxruntime wraps the ONNX Runtime Android AAR via JNI — its native code resolves
# ai.onnxruntime classes by name, so a minified release build must keep them (NFR-2).
-keep class ai.onnxruntime.** { *; }
