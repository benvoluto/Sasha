import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationSession, dictationSupported, type SpeechRecognitionLike } from "./use-speech-to-text";

/** A scriptable stand-in for the browser's SpeechRecognition. */
class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onresult: SpeechRecognitionLike["onresult"] = null;
  static failStart = false;
  started = false;
  ended = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.failStart) throw new Error("InvalidStateError");
    this.started = true;
    this.onstart?.();
  }
  /** The engine ends this recognition (a pause, on iOS Safari). Like a browser, it ends once. */
  end() {
    if (!this.started || this.ended) return;
    this.ended = true;
    this.onend?.();
  }
  // As in browsers, stop() and abort() do nothing on a recognition that never started or already ended.
  stop() {
    this.end();
  }
  abort() {
    this.end();
  }
  /** Deliver results: [text, isFinal] pairs for this recognition's whole result list. */
  say(...results: Array<[string, boolean]>) {
    this.onresult?.({ resultIndex: 0, results: results.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t } })) });
  }
}

const latest = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

function session() {
  const state = { listening: false, transcript: "", error: null as string | null };
  const s = new DictationSession({
    onListening: (l) => (state.listening = l),
    onTranscript: (t) => (state.transcript = t),
    onError: (e) => (state.error = e),
  });
  return { s, state };
}

describe("DictationSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeRecognition.instances = [];
    FakeRecognition.failStart = false;
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports unsupported when the browser has no recognition", () => {
    vi.stubGlobal("window", {});
    expect(dictationSupported()).toBe(false);
    vi.stubGlobal("window", { webkitSpeechRecognition: FakeRecognition });
    expect(dictationSupported()).toBe(true);
  });

  it("accumulates the transcript across automatic restarts", () => {
    const { s, state } = session();
    s.start();
    expect(state.listening).toBe(true);
    vi.advanceTimersByTime(1000);
    latest().say(["hello there", true], [" gen", false]);
    expect(state.transcript).toBe("hello there gen");
    // The engine ends on a pause; the hook restarts it on a timer.
    latest().end();
    expect(FakeRecognition.instances).toHaveLength(1);
    vi.advanceTimersByTime(350);
    expect(FakeRecognition.instances).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    latest().say(["general kenobi", true]);
    expect(state.transcript).toBe("hello there general kenobi");
    expect(state.listening).toBe(true);
  });

  it("stops after three sessions in a row end almost at once", () => {
    const { s, state } = session();
    s.start();
    for (let i = 0; i < 2; i++) {
      latest().end();
      vi.advanceTimersByTime(350);
    }
    expect(FakeRecognition.instances).toHaveLength(3);
    latest().end();
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(3);
    expect(state.listening).toBe(false);
  });

  it("stops on a permanent error and ignores routine ones", () => {
    const { s, state } = session();
    s.start();
    latest().onerror?.({ error: "no-speech" });
    expect(state.error).toBeNull();
    latest().onerror?.({ error: "not-allowed" });
    expect(state.error).toBe("not-allowed");
    latest().end();
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(state.listening).toBe(false);
  });

  it("stop() returns the full transcript, including the last words", () => {
    const { s, state } = session();
    s.start();
    vi.advanceTimersByTime(1000);
    latest().say(["first part", true]);
    latest().end();
    vi.advanceTimersByTime(350);
    latest().say(["and the end", false]);
    expect(s.stop()).toBe("first part and the end");
    expect(state.listening).toBe(false);
    // No restart after a stop.
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("stop() during the restart gap ends listening", () => {
    const { s, state } = session();
    s.start();
    vi.advanceTimersByTime(1000);
    latest().say(["half a thought", true]);
    latest().end();
    expect(state.listening).toBe(true);
    expect(s.stop()).toBe("half a thought");
    expect(state.listening).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("stops listening when a restart fails to start", () => {
    const { s, state } = session();
    s.start();
    vi.advanceTimersByTime(1000);
    latest().end();
    FakeRecognition.failStart = true;
    vi.advanceTimersByTime(350);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(state.listening).toBe(false);
    s.stop();
    expect(state.listening).toBe(false);
  });

  it("uses the native bridge when the shell provides it, and cleans up on its end", () => {
    const posted: unknown[] = [];
    const w: Record<string, unknown> = { webkit: { messageHandlers: { sashaDictation: { postMessage: (m: unknown) => posted.push(m) } } } };
    vi.stubGlobal("window", w);
    const { s, state } = session();
    s.start();
    expect(posted[0]).toMatchObject({ action: "start" });
    const cb = w.__sashaDictation as { onResult(t: string, f: boolean): void; onEnd(): void };
    cb.onResult("one two", true);
    cb.onResult("three", false);
    expect(state.transcript).toBe("one two three");
    expect(s.stop()).toBe("one two three");
    expect(posted[1]).toEqual({ action: "stop" });
    cb.onEnd();
    expect(state.listening).toBe(false);
    expect(w.__sashaDictation).toBeUndefined();
  });
});
