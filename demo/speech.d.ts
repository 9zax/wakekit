// Minimal ambient types for the Web Speech API. This repo pins TypeScript ^5.6.3, whose
// lib.dom.d.ts already ships SpeechRecognitionResult/ResultList/Alternative — only these three
// are missing, so only these three are declared (never vendor @types/dom-speech-recognition,
// it redeclares what lib.dom already has).
// ponytail: delete this file once the pinned TS version ships these itself — a lib.dom.d.ts that
// declares the same three names would collide with these ambient globals.
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((e: Event) => void) | null;
  onstart: ((e: Event) => void) | null;
  onaudiostart: ((e: Event) => void) | null;
}
interface Window {
  SpeechRecognition?: { new (): SpeechRecognition };
  webkitSpeechRecognition?: { new (): SpeechRecognition };
}
