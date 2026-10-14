import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture() {
  const children: any[] = [];
  const timers = new Map<object, { callback: () => void; delay: number }>();
  const exports: any = {};
  const dependencies: any = {
    "./TranscriptionPlugin": { BaseTranscriptionPlugin: EventEmitter },
    child_process: { spawn: (binary: string, args: string[]) => {
      const child: any = new EventEmitter();
      Object.assign(child, { binary, args, stdout: new EventEmitter(), stderr: new EventEmitter(),
        pid: children.length + 1, exitCode: null, signalCode: null, signals: [],
        kill(signal: string) { this.signals.push(signal); },
        close(code = 0) { this.exitCode = code; this.emit("close", code); },
      });
      children.push(child);
      return child;
    } },
    fs: { readFileSync: () => "spoken text", unlinkSync() {} },
    uuid: { v4: () => "segment" },
  };
  runInNewContext(ts.transpileModule(readFileSync(new URL("./WhisperCppTranscriptionPlugin.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports, require: (name: string) => dependencies[name] || {}, AbortController,
    console: { log() {}, warn() {}, error() {} },
    clearInterval(id: object) { timers.delete(id); },
    setTimeout(callback: () => void, delay: number) { const id = {}; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: object) { timers.delete(id); },
  });
  const plugin = Object.create(exports.WhisperCppTranscriptionPlugin.prototype);
  Object.assign(plugin, { workController: new AbortController(), warmupController: null,
    whisperProcessQueue: Promise.resolve(), options: { language: "fr" }, modelPath: "base.bin",
    setRunning(value: boolean) { this.isRunning = value; },
    setActive(value: boolean) { this.active = value; },
    setTranscriptionCallback(value: any) { this.onTranscriptionCallback = value; },
    resolvedBinaryPath: "whisper", audioJobs: 0, sessionUid: "session", isRunning: true,
    saveAudioAsWav: async () => "audio.wav", postProcessTranscription: (text: string) => ({ text }),
  });
  return { plugin, children, timers };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("canceling old work kills a stuck process, skips its queue, and waits for close before starting the new model", async () => {
  const { plugin, children, timers } = fixture();
  const first = plugin.transcribeWithWhisperCpp("first.wav").catch(() => "canceled");
  const queued = plugin.transcribeWithWhisperCpp("queued.wav").catch(() => "canceled");
  await tick();
  expect(children.length).toBe(1);
  plugin.cancelPendingWork();
  plugin.modelPath = "turbo.bin";
  const next = plugin.transcribeWithWhisperCpp("next.wav");
  await tick();
  expect(children[0].signals).toEqual(["SIGTERM"]);
  expect(children.length).toBe(1);
  [...timers.values()].find((timer) => timer.delay === 5000)!.callback();
  expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  children[0].close(1);
  await tick();
  expect(await first).toBe("canceled");
  expect(await queued).toBe("canceled");
  expect(children.length).toBe(2);
  expect(children[1].args).toContain("turbo.bin");
  children[1].close();
  expect(await next).toBe("spoken text");
  expect(timers.size).toBe(0);
});

test("real audio interrupts warm-up and canceled sessions cannot publish a completed segment", async () => {
  const { plugin, children } = fixture();
  plugin.warmupController = new AbortController();
  const warmup = plugin.transcribeWithWhisperCpp("warm.wav", 600000, plugin.warmupController.signal).catch(() => {});
  await tick();
  const updates: any[] = [];
  plugin.onTranscriptionCallback = (update: any) => updates.push(update);
  const audio = plugin.processAudioSegment(new Float32Array(16000));
  await tick();
  expect(children[0].signals).toEqual(["SIGTERM"]);
  children[0].close(1);
  await warmup;
  await tick();
  expect(children.length).toBe(2);
  plugin.cancelPendingWork();
  plugin.sessionUid = "new-session";
  children[1].close();
  await audio;
  expect(updates.length).toBe(1);
  expect(updates[0].segments[0].type).toBe("inprogress");
  expect(plugin.audioJobs).toBe(0);
});

test("native failures reject instead of publishing failure text as a transcription", async () => {
  const { plugin, children } = fixture();
  const updates: any[] = [];
  plugin.onTranscriptionCallback = (update: any) => updates.push(update);
  const audio = plugin.processAudioSegment(new Float32Array(16000));
  const rejected = audio.catch((error: Error) => error.message);
  await tick();
  children[0].close(1);
  expect(await rejected).toContain("Whisper.cpp failed");
  expect(updates.length).toBe(1);
  expect(plugin.isCurrentlyTranscribing).toBe(false);
});


test("deactivation waits for native close and preserves forced termination until then", async () => {
  const { plugin, children, timers } = fixture();
  plugin.warmupController = new AbortController();
  const warmup = plugin.transcribeWithWhisperCpp("warm.wav", 600000, plugin.warmupController.signal).catch(() => {});
  await tick();
  let deactivated = false;
  const deactivation = plugin.onDeactivate().then(() => { deactivated = true; });
  await tick();
  expect(plugin.active).toBe(false);
  expect(plugin.isRunning).toBe(false);
  expect(deactivated).toBe(false);
  expect(children[0].signals).toEqual(["SIGTERM"]);
  [...timers.values()].find((timer) => timer.delay === 5000)!.callback();
  expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(deactivated).toBe(false);
  children[0].close(1);
  await Promise.all([warmup, deactivation]);
  expect(deactivated).toBe(true);
  expect(timers.size).toBe(0);
});

test("cleanup cannot finish while its Whisper child is still alive", async () => {
  const { plugin, children } = fixture();
  const work = plugin.transcribeWithWhisperCpp("audio.wav").catch(() => {});
  await tick();
  let cleaned = false;
  const cleanup = plugin.cleanup().then(() => { cleaned = true; });
  await tick();
  expect(cleaned).toBe(false);
  expect(plugin.active).toBe(false);
  children[0].close(1);
  await Promise.all([work, cleanup]);
  expect(cleaned).toBe(true);
});
