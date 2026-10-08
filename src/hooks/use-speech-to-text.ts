"use client";

// Tap-to-dictate, ported from deskapp's useSpeechToText. The browser's Web
// Speech API (`SpeechRecognition`, `webkitSpeechRecognition` on Chrome and iOS
// Safari) transcribes while the person speaks; when the app runs inside a native
// shell that injects the `sashaDictation` message handler, recognition goes
// through the shell instead. Continuous: it keeps transcribing through pauses
// until `stop()` (the caller's Finish or Cancel). Sasha keeps no audio and
// uploads none; the browser or the OS does the recognition.
//
// The recognition logic lives in `DictationSession` (no React), so it can be
// tested with a fake SpeechRecognition; the hook wraps it in React state.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// The Web Speech API isn't in TypeScript's lib.dom, so the minimal shapes are declared here.
type SpeechResult = { isFinal: boolean; readonly [0]: { transcript: string } };
type SpeechResultList = ArrayLike<SpeechResult>;
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Native dictation bridge: the JS⇄native contract for a host WKWebView.
 *
 *   JS → native (post to `webkit.messageHandlers.sashaDictation`):
 *     { action: "start", lang: string }  begin recognition
 *     { action: "stop" }                 end recognition
 *   native → JS (the shell calls the globals installed on `window.__sashaDictation`):
 *     onResult(transcript, isFinal)  interim updates send isFinal=false, finalized segments isFinal=true
 *     onError(code)                  Web Speech error strings; "not-allowed", "service-not-allowed"
 *                                    and "audio-capture" are unrecoverable
 *     onEnd()                        recognition stopped
 */
type NativeDictation = { postMessage: (msg: unknown) => void };
function getNativeBridge(): NativeDictation | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { webkit?: { messageHandlers?: { sashaDictation?: NativeDictation } } };
  return w.webkit?.messageHandlers?.sashaDictation ?? null;
}

type NativeCallbacks = { onResult(transcript: string, isFinal: boolean): void; onError(code: string): void; onEnd(): void };

declare global {
  interface Window {
    __sashaDictation?: NativeCallbacks;
  }
}

/** Errors that restarting won't fix: stop instead of spinning (which freezes iOS Safari). */
const PERMANENT_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
/** Errors that are part of normal operation (a stop, a silence). */
const IGNORED_ERRORS = new Set(["aborted", "no-speech"]);
const RESTART_DELAY_MS = 350;
const SHORT_RUN_MS = 600;
const MAX_SHORT_RUNS = 3;

export function dictationSupported(): boolean {
  return getRecognitionCtor() !== null || getNativeBridge() !== null;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

export type DictationListener = {
  onListening(listening: boolean): void;
  onTranscript(transcript: string): void;
  onError(error: string | null): void;
};

/**
 * One dictation controller. `start()` begins a fresh transcript; recognition
 * restarts by itself when the engine ends on a pause, accumulating the
 * finalized text across restarts, until `stop()`.
 */
export class DictationSession {
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  /** Dictation is running through the native bridge rather than Web Speech. */
  private native = false;
  /** Finalized text from recognitions that already ended. */
  private committed = "";
  /** Finalized text from the current recognition. */
  private currentFinal = "";
  /** The latest full transcript, finals and interim, as last reported. */
  private latest = "";
  private startedAt = 0;
  private shortRuns = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly listener: DictationListener) {}

  private report(text: string) {
    this.latest = tidy(text);
    this.listener.onTranscript(this.latest);
  }

  private fail(code: string) {
    if (PERMANENT_ERRORS.has(code)) {
      this.active = false;
      this.listener.onError(code);
    } else if (!IGNORED_ERRORS.has(code)) {
      this.listener.onError(code);
    }
  }

  private clearRestart() {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private startRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onstart = () => {
      this.startedAt = Date.now();
      this.listener.onListening(true);
    };
    rec.onresult = (e) => {
      let final = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      this.currentFinal = final;
      this.report(this.committed + final + interim);
    };
    rec.onerror = (e) => this.fail(e.error);
    rec.onend = () => {
      if (this.rec !== rec) return; // a superseded instance winding down
      // Keep going through pauses until the caller stops (iOS Safari ends on
      // silence). Roll the current finals into the committed total first.
      if (this.active) {
        this.committed += this.currentFinal;
        this.currentFinal = "";
        // iOS Safari ignores `continuous`, ends almost immediately and blocks
        // gesture-less restarts, which turns auto-restart into a tight loop.
        // Bail out when sessions keep ending fast, and always restart on a timer.
        this.shortRuns = Date.now() - this.startedAt < SHORT_RUN_MS ? this.shortRuns + 1 : 0;
        if (this.shortRuns >= MAX_SHORT_RUNS) {
          this.active = false;
          this.rec = null;
          this.listener.onListening(false);
          return;
        }
        // This instance has ended and ignores stop() from here on, so let go of
        // it: a stop() during the gap then reports "not listening" itself.
        this.rec = null;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.active) this.startRecognition();
        }, RESTART_DELAY_MS);
        return;
      }
      this.rec = null;
      this.listener.onListening(false);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      // start() throws if a prior instance is still winding down. This instance
      // will fire no events, so give up rather than look like it is listening.
      if (this.rec === rec) {
        this.active = false;
        this.rec = null;
        this.listener.onListening(false);
      }
    }
  }

  start() {
    this.clearRestart();
    const old = this.rec;
    this.rec = null;
    old?.abort();
    this.committed = "";
    this.currentFinal = "";
    this.latest = "";
    this.shortRuns = 0;
    this.listener.onTranscript("");
    this.listener.onError(null);
    this.active = true;

    // Prefer the native bridge when the host injected it. This runs in a user
    // gesture, so installing globals and posting messages is allowed.
    const bridge = getNativeBridge();
    if (bridge) {
      this.native = true;
      window.__sashaDictation = {
        onResult: (text, isFinal) => {
          if (isFinal) {
            this.committed += text + " ";
            this.report(this.committed);
          } else {
            this.report(this.committed + text);
          }
        },
        onError: (code) => this.fail(code),
        onEnd: () => {
          this.native = false;
          this.active = false;
          delete window.__sashaDictation;
          this.listener.onListening(false);
        },
      };
      this.listener.onListening(true);
      bridge.postMessage({ action: "start", lang: navigator.language || "en-US" });
      return;
    }
    this.native = false;
    this.startRecognition();
  }

  /** Stop listening. Returns the full transcript so far, so a Finish never drops words still in flight to React state. */
  stop(): string {
    this.active = false;
    this.clearRestart();
    if (this.native) getNativeBridge()?.postMessage({ action: "stop" });
    else if (this.rec) this.rec.stop();
    else this.listener.onListening(false);
    return this.latest;
  }

  /** Tear down (the component unmounted). */
  dispose() {
    this.active = false;
    this.clearRestart();
    if (this.native) {
      getNativeBridge()?.postMessage({ action: "stop" });
      delete window.__sashaDictation;
      this.native = false;
    }
    const rec = this.rec;
    this.rec = null;
    rec?.abort();
  }
}

export function useSpeechToText() {
  // Client-only capability flag, read through an external store so it never
  // causes a hydration mismatch.
  const supported = useSyncExternalStore(
    () => () => {},
    dictationSupported,
    () => false,
  );
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);

  const session = useCallback(() => {
    sessionRef.current ??= new DictationSession({ onListening: setListening, onTranscript: setTranscript, onError: setError });
    return sessionRef.current;
  }, []);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  const start = useCallback(() => session().start(), [session]);
  const stop = useCallback(() => session().stop(), [session]);

  return { supported, listening, transcript, error, start, stop };
}
