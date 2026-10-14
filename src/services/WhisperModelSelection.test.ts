import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(file: string, dependencies: Record<string, any>, globals = {}) {
  const exports: Record<string, any> = {};
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(file, import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  );
  runInNewContext(outputText, {
    AbortController, exports, require: (name: string) => dependencies[name] || {},
    console: { log() {}, info() {}, error() {}, warn() {} }, ...globals,
  });
  return exports;
}

class PluginBase {
  options: Record<string, any> = {};
  getOptions() { return { ...this.options }; }
  setOptions(options: Record<string, any>) { this.options = { ...options }; }
  getState() { return { isLoading: false }; }
}

function whisperFixture(directory: string) {
  const { WhisperCppTranscriptionPlugin } = load("../plugins/WhisperCppTranscriptionPlugin.ts", {
    fs, path,
    "./TranscriptionPlugin": { BaseTranscriptionPlugin: PluginBase },
    "../helpers/getPrompt": { readPrompt: () => "" },
  });
  const plugin = Object.create(WhisperCppTranscriptionPlugin.prototype);
  Object.assign(plugin, {
    workController: new AbortController(), audioJobs: 0,
    config: { getModelsDir: () => directory },
    options: { model: "ggml-base.bin", language: "fr", threads: 6, prompt: "Keep me", useCoreML: false },
    modelPath: path.join(directory, "ggml-base.bin"),
    name: "whisper-cpp",
  });
  return plugin;
}

test("downloaded-only switching preserves options and leaves state unchanged on failure", () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "whisper-model-test-"));
  try {
    fs.writeFileSync(path.join(directory, "ggml-small.bin"), "test weights");
    const plugin = whisperFixture(directory);
    plugin.selectDownloadedModel("ggml-small.bin");
    expect(plugin.getOptions()).toEqual({ model: "ggml-small.bin", language: "fr", threads: 6, prompt: "Keep me", useCoreML: false });
    expect(plugin.modelPath).toBe(path.join(directory, "ggml-small.bin"));
    for (const missing of ["ggml-medium.bin", "../unknown.bin"]) {
      expect(() => plugin.selectDownloadedModel(missing)).toThrow();
      expect(plugin.options.model).toBe("ggml-small.bin");
      expect(plugin.modelPath).toBe(path.join(directory, "ggml-small.bin"));
    }
    fs.writeFileSync(path.join(directory, "ggml-base.bin"), "");
    expect(() => plugin.selectDownloadedModel("ggml-base.bin")).toThrow();
    plugin.isCurrentlyTranscribing = true;
    expect(() => plugin.selectDownloadedModel("ggml-small.bin")).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("session model survives plugin reactivation without changing saved settings", async () => {
  let busy = false;
  const { TranscriptionPluginManager } = load("../plugins/TranscriptionPluginManager.ts", {
    events: { EventEmitter },
    "../core/AppStore": { appStore: {
      select: (fn: any) => fn({ dictation: { state: busy ? "recording" : "idle" }, app: { status: "idle" } }),
      setActivePlugin() {}, getState: () => ({ plugins: {} }), setState() {},
    } },
  });
  const manager = Object.create(TranscriptionPluginManager.prototype);
  let options = { model: "ggml-base.bin", language: "it" };
  const saved = { "whisper-cpp": { ...options } };
  let runtimeConfig = structuredClone(saved);
  manager.config = {
    setPluginConfig: (value: any) => { runtimeConfig = { ...runtimeConfig, ...value }; },
    getPluginConfig: () => runtimeConfig,
  };
  const lifecycle = {
    isAvailable: async () => true,
    isWarmingUp: () => false,
    validateOptions: async () => ({ valid: true, errors: [] }),
    getState: () => ({ isLoading: false }),
    onActivated: async () => {}, onDeactivate: async () => {}, stopTranscription: async () => {},
  };
  manager.plugins = new Map([["whisper-cpp", {
    ...lifecycle, name: "whisper-cpp",
    selectDownloadedModel: (model: string) => { options = { ...options, model }; },
    getOptions: () => ({ ...options }),
    setOptions: (value: typeof options) => { options = { ...value }; },
    updateOptions: async (value: typeof options) => { options = { ...value }; },
  }]]);
  manager.plugins.set("yap", { ...lifecycle, name: "yap" });
  const changes: string[] = [];
  manager.on("whisper-model-changed", (model: string) => changes.push(model));
  manager.setSessionWhisperModel("ggml-small.bin");
  expect(manager.getSessionWhisperModel()).toBe("ggml-small.bin");
  expect(runtimeConfig["whisper-cpp"]).toEqual({ model: "ggml-small.bin", language: "it" });
  expect(saved["whisper-cpp"].model).toBe("ggml-base.bin");
  expect(changes).toEqual(["ggml-small.bin"]);
  await manager.setActivePlugin("yap");
  await manager.setActivePlugin("whisper-cpp");
  expect(options).toEqual({ model: "ggml-small.bin", language: "it" });
  busy = true;
  expect(() => manager.setSessionWhisperModel("ggml-medium.bin")).toThrow();
  expect(changes).toHaveLength(1);
});

test("failed Settings option update restores the prior model and reports failure", async () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "whisper-failed-model-test-"));
  try {
    const plugin = whisperFixture(directory);
    plugin.useCoreML = false;
    plugin.setLoadingState = () => {};
    plugin.setError = () => {};
    plugin.downloadModel = async () => { throw new Error("download failed"); };
    await expect(plugin.updateOptions({ ...plugin.getOptions(), model: "ggml-medium.bin" })).rejects.toThrow("Failed to switch model");
    expect(plugin.getOptions().model).toBe("ggml-base.bin");
    expect(plugin.modelPath).toBe(path.join(directory, "ggml-base.bin"));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("tray models come from schema, filter downloads, show missing selection, and respect busy state", () => {
  let busy = false;
  let active = "whisper-cpp";
  const { TrayService } = load("./TrayService.ts", {
    "../core/AppStore": { appStore: { select: (fn: any) => fn({ dictation: { state: busy ? "processing" : "idle" }, app: { status: "idle" } }) } },
  });
  const tray = Object.create(TrayService.prototype);
  Object.assign(tray, {
    pluginManager: {
      getActivePluginName: () => active,
      getPlugin: () => ({
        isWarmingUp: () => false,
        getState: () => ({ isLoading: false }),
        getOptions: () => ({ model: "missing.bin" }),
        getSchema: () => [{ key: "model", default: "downloaded.bin", options: [
          { value: "downloaded.bin", label: "Schema label" },
          { value: "missing.bin", label: "Missing" },
          { value: "not-downloaded.bin", label: "Hidden" },
        ] }],
      }),
    },
    modelManager: { listDownloadedModels: () => [{ repoId: "downloaded.bin", sizeBytes: 100 }] },
    isDownloading: () => false, onManageModels() {},
  });
  const menu = tray.generateWhisperModelSubmenu();
  expect(menu.label).toBe("Whisper Model: Missing");
  expect(menu.submenu[0].label).toBe("Schema label");
  expect(menu.submenu[0].enabled).toBe(true);
  expect(menu.submenu[1]).toMatchObject({ checked: true, enabled: false, label: "Missing (not downloaded)" });
  expect(menu.submenu.some((item: any) => item.label === "Hidden")).toBe(false);
  busy = true;
  expect(tray.generateWhisperModelSubmenu().submenu[0].enabled).toBe(false);
  active = "yap";
  expect(tray.generateWhisperModelSubmenu()).toBeNull();
});

test("Settings overlays the session model without changing its saved baseline or other drafts", async () => {
  let sessionModel = "ggml-small.bin";
  let modelListener: (model: string) => void = () => {};
  const api = {
    onPluginSwitchProgress() {}, onNavigateToSection() {}, onSettingsUpdated() {},
    onActivePluginUpdated: () => () => {},
    onWhisperModelUpdated: (fn: typeof modelListener) => { modelListener = fn; return () => {}; },
    getSessionWhisperModel: async () => sessionModel,
    setSessionWhisperModel: async (value: string) => { sessionModel = value; modelListener(value); },
  };
  const { default: component } = load("../renderer-app/src/scripts/settingsWindow.js", {
    "../utils/settings-store": { deepClone: (value: any) => structuredClone(value) },
    "../utils/plugins": { getActivePlugin: async () => "whisper-cpp" },
  }, { window: { electronAPI: api } });
  const saved = { transcriptionPlugin: "whisper-cpp", plugin: { "whisper-cpp": { model: "ggml-base.bin", language: "fr" } } };
  const state: any = {
    settings: structuredClone(saved), originalSettings: structuredClone(saved),
    whisperModelRevision: 0, showStatus() {}, fetchActivePluginAiCapabilities() {},
  };
  for (const [key, fn] of Object.entries(component.methods)) state[key] = (fn as Function).bind(state);
  state.showStatus = () => {};
  state.setupIpcListeners();
  await state.refreshSessionWhisperModel();
  expect(state.settings.plugin["whisper-cpp"].model).toBe("ggml-small.bin");
  expect(state.originalSettings.plugin["whisper-cpp"].model).toBe("ggml-base.bin");
  state.settings.plugin["whisper-cpp"].language = "it";
  modelListener("ggml-medium.bin");
  expect(state.settings.plugin["whisper-cpp"]).toEqual({ model: "ggml-medium.bin", language: "it" });
  const staleRefresh = state.refreshSessionWhisperModel();
  modelListener("ggml-large-v3.bin");
  await staleRefresh;
  expect(state.settings.plugin["whisper-cpp"].model).toBe("ggml-large-v3.bin");
  await state.cancelChanges();
  expect(sessionModel).toBe("ggml-base.bin");
  expect(state.settings).toEqual(saved);
});
