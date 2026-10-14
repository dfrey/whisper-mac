import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  Notification,
} from "electron";
import { join } from "path";
import { TranscriptionPluginManager } from "../plugins/TranscriptionPluginManager";
import { NotificationService } from "./NotificationService";
import { SettingsManager } from "../config/SettingsManager";
import { appStore, SetupStatus } from "../core/AppStore";
import { ModelManager } from "./ModelManager";

export { SetupStatus };

export class TrayService {
  private tray: Tray | null = null;
  private trayMenu: Menu | null = null;
  private onOpenRecordingNotes: (() => void) | null = null;
  private menuRevision = 0;
  private lastWhisperModelMenuDiagnostic = "";

  private get currentStatus(): SetupStatus {
    return appStore.select((s) => s.app.status);
  }

  constructor(
    private readonly trayIconIdleRelPath: string,
    private readonly trayIconRecordingRelPath: string,
    private readonly dockIconRelPath: string,
    private readonly getStatusMessage: (s: SetupStatus) => string,
    private readonly onLeftClick: () => void,
    private readonly onShowSettings: () => void,
    private readonly pluginManager: TranscriptionPluginManager,
    private readonly notificationService: NotificationService,
    private readonly settingsManager: SettingsManager,
    private readonly modelManager: ModelManager,
    private readonly isDownloading: () => boolean,
    private readonly onManageModels: () => void,
  ) {}

  setRecordingNotesCallback(cb: () => void): void {
    this.onOpenRecordingNotes = cb;
  }

  createTray() {
    const initialIconPath = join(__dirname, this.trayIconIdleRelPath);
    this.tray = new Tray(initialIconPath);
    this.setTrayIcon(this.trayIconIdleRelPath);
    // Dock icon is now handled by the .icns file in electron-builder config
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.on("click", (event) => {
      if (event.ctrlKey || this.currentStatus !== "idle") {
        void this.openContextMenu();
        return;
      }
      this.onLeftClick();
    });
    this.tray.on("right-click", () => {
      void this.openContextMenu();
    });
  }

  private async openContextMenu(): Promise<void> {
    try {
      await this.refreshTrayMenu();
      if (this.trayMenu) this.tray?.popUpContextMenu(this.trayMenu);
    } catch (error) {
      console.error("Could not open tray menu:", error);
    }
  }

  private canSwitchWhisperModel(): boolean {
    return this.getWhisperModelSwitchBlockers().length === 0;
  }

  private getWhisperModelSwitchBlockers(): string[] {
    const plugin = this.pluginManager.getPlugin("whisper-cpp");
    const state = appStore.select((s) => ({
      dictation: s.dictation.state,
      app: s.app.status,
    }));
    const blockers: string[] = [];

    if (this.pluginManager.getActivePluginName() !== "whisper-cpp") {
      blockers.push(`active plugin is ${this.pluginManager.getActivePluginName() ?? "none"}`);
    }
    if (state.dictation !== "idle") blockers.push(`dictation state is ${state.dictation}`);
    if (state.app !== "idle") blockers.push(`app status is ${state.app}`);
    if (this.isDownloading()) blockers.push("a model download is in progress");
    if (plugin?.getState().isLoading) blockers.push("Whisper plugin is loading");
    if (plugin?.isWarmingUp()) blockers.push("Whisper warm-up is in progress");

    return blockers;
  }

  private logWhisperModelMenuDiagnostic(blockers: string[], notDownloaded: string[]): void {
    const diagnostic = JSON.stringify({ blockers, notDownloaded });
    if (!blockers.length && !notDownloaded.length) {
      this.lastWhisperModelMenuDiagnostic = "";
      return;
    }
    if (diagnostic === this.lastWhisperModelMenuDiagnostic) return;

    console.info(`[Tray] Whisper model choices disabled: ${diagnostic}`);
    this.lastWhisperModelMenuDiagnostic = diagnostic;
  }

  private generateWhisperModelSubmenu(): Electron.MenuItemConstructorOptions | null {
    if (this.pluginManager.getActivePluginName() !== "whisper-cpp") return null;
    const plugin = this.pluginManager.getPlugin("whisper-cpp")!;
    const schema = plugin.getSchema().find((item) => item.key === "model");
    if (!schema) return null;
    const current = plugin.getOptions().model || schema.default;
    const models = schema.options || [];
    const downloaded = new Set(this.modelManager.listDownloadedModels()
      .filter((model) => model.sizeBytes > 0).map((model) => model.repoId));
    const visibleModels = models
      .filter((model) => downloaded.has(model.value) || model.value === current);
    const blockers = this.getWhisperModelSwitchBlockers();
    const notDownloaded = visibleModels
      .filter((model) => !downloaded.has(model.value))
      .map((model) => model.value);
    this.logWhisperModelMenuDiagnostic(blockers, notDownloaded);
    const enabled = blockers.length === 0;
    const submenu: Electron.MenuItemConstructorOptions[] = visibleModels
      .map((model) => ({
        label: `${model.label}${downloaded.has(model.value) ? "" : " (not downloaded)"}`,
        type: "radio",
        checked: model.value === current,
        enabled: enabled && downloaded.has(model.value),
        click: () => this.selectWhisperModel(model.value),
      }));
    if (!models.some((model) => model.value === current)) {
      submenu.unshift({ label: `${current} (unavailable)`, enabled: false });
    }
    submenu.push({ type: "separator" }, { label: "Manage Models…", click: this.onManageModels });
    return {
      label: `Whisper Model: ${models.find((model) => model.value === current)?.label || current}`,
      submenu,
    };
  }

  private async selectWhisperModel(modelName: string): Promise<void> {
    try {
      if (!this.canSwitchWhisperModel()) throw new Error("Wait until Whisper is idle before switching models.");
      this.pluginManager.setSessionWhisperModel(modelName);
    } catch (error) {
      await this.notificationService.sendErrorNotification(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await this.refreshTrayMenu();
    }
  }

  /**
   * Generate plugin selection submenu with available plugins
   */
  private async generatePluginSubmenu(): Promise<
    Electron.MenuItemConstructorOptions[]
  > {
    try {
      const allPlugins = this.pluginManager.getPlugins();
      const availablePlugins = await this.pluginManager.getAvailablePlugins();
      const activePluginName = this.pluginManager.getActivePluginName();

      // If no plugins available, show disabled message
      if (availablePlugins.length === 0) {
        return [
          {
            label: "No plugins available",
            enabled: false,
          },
        ];
      }

      // Create menu items for available plugins
      const pluginItems: Electron.MenuItemConstructorOptions[] =
        availablePlugins.map((plugin) => ({
          label: `${plugin.displayName}${
            activePluginName === plugin.name ? " ✓" : ""
          }`,
          type: "normal",
          enabled: activePluginName !== plugin.name, // Disable current active plugin
          click: () => this.activatePlugin(plugin.name),
        }));

      return pluginItems;
    } catch (error) {
      console.error("Error generating plugin submenu:", error);
      return [
        {
          label: "Error loading plugins",
          enabled: false,
        },
      ];
    }
  }

  /**
   * Activate a plugin using the fallback system
   */
  private async activatePlugin(pluginName: string): Promise<void> {
    try {
      console.log(`Attempting to activate plugin: ${pluginName}`);
      const result =
        await this.pluginManager.activatePluginWithFallback(pluginName);

      if (result.success) {
        console.log(`Successfully activated plugin: ${result.activePlugin}`);

        // Show notification about plugin switch
        const targetPlugin = this.pluginManager.getPlugin(result.activePlugin!);
        if (targetPlugin) {
          if (result.pluginChanged) {
            if (result.activePlugin === pluginName) {
              // Successfully switched to requested plugin
              await this.showPluginSwitchNotification(
                targetPlugin.displayName,
                false,
              );
            } else {
              // Fallback occurred - show notification with settings button
              const requestedPlugin = this.pluginManager.getPlugin(pluginName);
              const requestedDisplayName =
                requestedPlugin?.displayName || pluginName;
              await this.showPluginSwitchNotification(
                targetPlugin.displayName,
                true,
                requestedDisplayName,
              );
            }
          }
        }

        // Update tray menu to reflect the change
        this.updateTrayMenu(this.currentStatus);
      } else {
        console.error(
          `Failed to activate plugin ${pluginName}:`,
          result.errors,
        );
        // Show error notification
        await this.notificationService.sendErrorNotification(
          `Failed to activate ${pluginName}. Please check plugin availability in Settings.`,
        );
      }
    } catch (error) {
      console.error(`Error activating plugin ${pluginName}:`, error);
      await this.notificationService.sendErrorNotification(
        `Error switching to ${pluginName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async updateTrayMenu(status: SetupStatus) {
    const revision = ++this.menuRevision;
    if (!this.tray) return;
    const isSetupInProgress = status !== "idle";
    if (isSetupInProgress) {
      const statusMenu = Menu.buildFromTemplate([
        { label: this.getStatusMessage(status), enabled: false },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]);
      this.trayMenu = statusMenu;
      this.tray.setToolTip(this.getStatusMessage(status));
    } else {
      // Generate plugin submenu asynchronously
      const pluginSubmenu = await this.generatePluginSubmenu();
      if (revision !== this.menuRevision || !this.tray) return;

      // Get configured hotkey for start/stop dictation
      const hotkeySettings =
        (this.settingsManager.get("hotkeys") as Record<string, string>) || {};
      const startStopHotkey = hotkeySettings.startStopDictation || "Control+D";

      const menuItems: Electron.MenuItemConstructorOptions[] = [
        {
          label: "Start Dictation",
          click: () => this.onLeftClick(),
          accelerator: startStopHotkey,
        },
        { type: "separator" },
        { label: "Settings", click: () => this.onShowSettings() },
      ];

      if (this.onOpenRecordingNotes) {
        const cb = this.onOpenRecordingNotes;
        menuItems.push({
          label: "Recording Notes",
          click: () => cb(),
        });
      }

      const modelMenu = this.generateWhisperModelSubmenu();
      if (modelMenu) menuItems.push(modelMenu);

      menuItems.push(
        {
          label: "Select Plugin",
          submenu: pluginSubmenu,
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      );

      const contextMenu = Menu.buildFromTemplate(menuItems);
      this.trayMenu = contextMenu;
      this.tray.setToolTip("WhisperMac - AI Dictation");
    }
  }

  /**
   * Refresh the tray menu without changing the status
   */
  async refreshTrayMenu() {
    await this.updateTrayMenu(this.currentStatus);
  }

  updateTrayIcon(state: "idle" | "recording") {
    const iconPath =
      state === "recording"
        ? this.trayIconRecordingRelPath
        : this.trayIconIdleRelPath;
    this.setTrayIcon(iconPath);
  }

  cleanup() {
    console.log("Cleaning up TrayService...");
    this.tray?.destroy();
    this.tray = null;
    this.trayMenu = null;
  }

  showDock(show: boolean) {
    try {
      if (show) app.dock?.show();
      else app.dock?.hide();
    } catch {}
  }

  handleDockClick(
    getOnboardingVisible: () => boolean,
    showOnboarding: () => void,
    showDictationWindow: () => void,
  ) {
    try {
      if (getOnboardingVisible()) {
        showOnboarding();
        return;
      }
      const visibleWindows = BrowserWindow.getAllWindows().filter(
        (w) => !w.isDestroyed() && w.isVisible(),
      );
      if (visibleWindows.length > 0) {
        visibleWindows.forEach((w) => {
          try {
            w.show();
            w.focus();
          } catch {}
        });
        return;
      }
    } catch {}
  }

  private setTrayIcon(assetRelPath: string) {
    const fullPath = join(__dirname, assetRelPath);
    try {
      const image = nativeImage.createFromPath(fullPath);
      image.setTemplateImage(true);
      this.tray?.setImage(image);
    } catch {}
  }

  /**
   * Show notification when switching plugins
   */
  private async showPluginSwitchNotification(
    activePluginName: string,
    isFallback: boolean = false,
    requestedPluginName?: string,
  ): Promise<void> {
    try {
      if (isFallback && requestedPluginName) {
        // For fallback scenarios, show notification with settings button
        const message = `Switched to ${activePluginName} (couldn't switch to ${requestedPluginName})`;

        // Use native notification with action if supported
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: "WhisperMac",
            body: message,
            actions: [
              {
                type: "button",
                text: "Open Settings",
              },
            ],
          });

          notification.on("action", (event, index) => {
            if (index === 0) {
              // Open settings when button is clicked
              this.onShowSettings();
            }
          });

          notification.on("click", () => {
            // Also open settings when notification itself is clicked
            this.onShowSettings();
          });

          notification.show();
        } else {
          // Fallback to basic notification
          await this.notificationService.sendNotification({
            message: `${message}. Click here to open Settings.`,
            sound: "default",
          });
        }
      } else {
        // Regular successful switch notification
        await this.notificationService.sendSuccessNotification(
          `Switched to ${activePluginName}`,
        );
      }
    } catch (error) {
      console.error("Error showing plugin switch notification:", error);
      // Fallback to console log
      console.log(
        `PLUGIN SWITCH: ${
          isFallback ? "Fallback to" : "Switched to"
        } ${activePluginName}`,
      );
    }
  }

  // Dock icon is now handled by the .icns file in electron-builder config
  // No need to manually set it anymore
}
