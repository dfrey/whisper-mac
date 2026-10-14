import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function fixture() {
  const state = { dictation: { state: "recording", sessionId: "session" } };
  const appStore = { select: (fn: any) => fn(state), setDictationState: (value: string) => { state.dictation.state = value; } };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL("./DictationFlowManager.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports, require: (name: string) => name === "./AppStore" ? { appStore } : name === "./PromiseManager" ? { promiseManager: { start() {}, resolve() {} } } : {},
    console: { log() {}, error() {} }, Date, setTimeout, clearTimeout,
  });
  const flow = Object.create(exports.DictationFlowManager.prototype);
  const errors: any[] = [];
  let injected = false;
  Object.assign(flow, {
    processingGeneration: 0, activeProcessingTasks: 0, processingWaiters: [],
    audioCaptureService: { stopCapture: async () => {} },
    dictationWindowService: { stopRecording() {} },
    transcriptionPluginManager: {
      getActivePluginActivationCriteria: () => ({}), isBufferingEnabledForActivePlugin: () => false,
      hasBufferedAudio: () => false, getActivePluginName: () => "whisper-cpp",
    },
    segmentManager: { getAllSegments: () => [], hasInitialSelectedText: () => false,
      transformAndInjectAllSegmentsInternal() { injected = true; } },
    waitForAudioProcessingComplete: async () => {},
    cancelDictationFlow: async () => { state.dictation.state = "idle"; state.dictation.sessionId = ""; },
    errorManager: { showError: async (error: any) => { errors.push(error); } },
  });
  return { flow, state, errors, wasInjected: () => injected };
}

test("unfinished native work reports an error instead of injecting empty output", async () => {
  const { flow, errors, wasInjected } = fixture();
  flow.waitForPendingProcessingTasks = async () => false;
  await flow.finishCurrentDictation();
  expect(errors.length).toBe(1);
  expect(errors[0].description).toContain("timed out");
  expect(wasInjected()).toBe(false);
});

test("native transcription failures reach the user before empty-result cancellation", async () => {
  const { flow, errors, wasInjected } = fixture();
  flow.processingError = new Error("Native process failed");
  flow.waitForPendingProcessingTasks = async () => true;
  await flow.finishCurrentDictation();
  expect(errors.length).toBe(1);
  expect(errors[0].description).toContain("Native process failed");
  expect(wasInjected()).toBe(false);
});

test("late completion from a canceled session cannot settle a new session's tasks", async () => {
  const { flow } = fixture();
  let finishOld!: () => void;
  let finishNew!: () => void;
  const old = flow.runTrackedProcessing(() => new Promise<void>((resolve) => { finishOld = resolve; }));
  flow.resetProcessingTasks();
  const current = flow.runTrackedProcessing(() => new Promise<void>((resolve) => { finishNew = resolve; }));
  finishOld();
  await old;
  expect(flow.activeProcessingTasks).toBe(1);
  finishNew();
  await current;
  expect(flow.activeProcessingTasks).toBe(0);
});


test("dictation displays warm-up and waits before starting the microphone", async () => {
  const { flow, state } = fixture();
  state.dictation.state = "idle";
  // The fixture keeps this session id when changing state.
  const sessionId = `dictation-${Date.now()}`;
  const originalNow = Date.now;
  const now = Number(sessionId.slice("dictation-".length));
  Date.now = () => now;
  state.dictation.sessionId = sessionId;
  let finishWarmup!: () => void;
  let recording = false;
  let shown = false;
  const messages: boolean[] = [];
  Object.assign(flow, {
    clearState() {}, setupAccumulatingMode() {}, startTranscription: async () => {},
    startRecording: async () => { recording = true; },
    segmentManager: { captureInitialSelectedText: async () => {} },
    dictationWindowService: {
      setWarmupMessage(value: boolean) { messages.push(value); },
      showDictationWindow: async () => { shown = true; },
    },
  });
  flow.transcriptionPluginManager.willBufferNextSession = () => false;
  flow.transcriptionPluginManager.getActivePlugin = () => ({
    getOptions: () => ({ model: "ggml-large-v3.bin" }),
    getSchema: () => [{ key: "model", options: [{ value: "ggml-large-v3.bin", label: "Large v3" }] }],
    isWarmingUp: () => true,
    waitForWarmup: () => new Promise<void>((resolve) => { finishWarmup = resolve; }),
  });
  try {
    const start = flow.startDictation();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(shown).toBe(true);
    expect(messages).toEqual([true]);
    expect(recording).toBe(false);
    finishWarmup();
    await start;
    expect(recording).toBe(true);
    expect(messages).toEqual([true, false]);
  } finally { Date.now = originalNow; }
});
