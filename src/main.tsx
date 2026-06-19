import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import { loadPreferences } from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { IS_LINUX, USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

type WindowSize = {
  width: number;
  height: number;
};

const MAIN_WINDOW_SIZE_KEY = "terax-ui-main-window-size";
const MAIN_WINDOW_MIN_WIDTH = 420;
const MAIN_WINDOW_MIN_HEIGHT = 280;
const MAIN_WINDOW_SAVE_DELAY_MS = 200;
const MAIN_WINDOW_RESIZE_READY_MS = 500;

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// Render-instrumentation overlay, opt-in: `VITE_REACT_SCAN=true pnpm dev`.
// Dev-only dynamic import so it never reaches the production bundle.
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

// Reap PTY sessions orphaned by a prior webview load before any tab spawns.
await invoke("pty_close_all").catch(() => {});

// Seed before first paint so default tab mounts at target cwd (no flicker).
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

function isUsableWindowSize(size: WindowSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width >= MAIN_WINDOW_MIN_WIDTH &&
    size.height >= MAIN_WINDOW_MIN_HEIGHT
  );
}

function readSavedMainWindowSize(): WindowSize | null {
  try {
    const raw = window.localStorage.getItem(MAIN_WINDOW_SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WindowSize>;
    const size = {
      width: Number(parsed.width),
      height: Number(parsed.height),
    };
    return isUsableWindowSize(size) ? size : null;
  } catch {
    return null;
  }
}

function writeSavedMainWindowSize(size: WindowSize): void {
  if (!isUsableWindowSize(size)) return;
  try {
    window.localStorage.setItem(MAIN_WINDOW_SIZE_KEY, JSON.stringify(size));
  } catch {
    /* ignore */
  }
}

async function saveLinuxMainWindowSize(
  appWindow: ReturnType<typeof getCurrentWindow>,
  size: WindowSize,
): Promise<void> {
  if (!isUsableWindowSize(size)) return;
  const [maximized, fullscreen] = await Promise.all([
    appWindow.isMaximized(),
    appWindow.isFullscreen(),
  ]);
  if (!maximized && !fullscreen) writeSavedMainWindowSize(size);
}

async function restoreLinuxMainWindowSize(
  appWindow: ReturnType<typeof getCurrentWindow>,
): Promise<void> {
  const [prefs, maximized, fullscreen] = await Promise.all([
    loadPreferences(),
    appWindow.isMaximized(),
    appWindow.isFullscreen(),
  ]);
  if (!prefs.restoreWindowState || maximized || fullscreen) return;

  const saved = readSavedMainWindowSize();
  if (saved) {
    await appWindow.setSize(new PhysicalSize(saved.width, saved.height));
    return;
  }

  const size = await appWindow.innerSize();
  writeSavedMainWindowSize(size);
}

function startLinuxMainWindowSizePersistence(
  appWindow: ReturnType<typeof getCurrentWindow>,
): void {
  let ready = false;
  let saveTimer: number | undefined;
  let lastSize: WindowSize | null = null;

  const scheduleSave = (size: WindowSize) => {
    lastSize = size;
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void saveLinuxMainWindowSize(appWindow, size).catch((e) =>
        console.error("window size save failed:", e),
      );
    }, MAIN_WINDOW_SAVE_DELAY_MS);
  };

  window.setTimeout(() => {
    ready = true;
  }, MAIN_WINDOW_RESIZE_READY_MS);

  void appWindow
    .onResized(({ payload }) => {
      if (ready) scheduleSave(payload);
    })
    .catch((e) => console.error("window resize listener failed:", e));

  void appWindow
    .onCloseRequested(() => {
      if (!lastSize) return;
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      void saveLinuxMainWindowSize(appWindow, lastSize).catch((e) =>
        console.error("window size save failed:", e),
      );
    })
    .catch((e) => console.error("window close listener failed:", e));
}

let windowShown = false;

// Window starts hidden (per tauri.conf.json) so users never see a transparent
// shadow-only frame before React paints. Use setTimeout — rAF is throttled
// while the window is hidden and would never fire.
const showWindow = () => {
  const appWindow = getCurrentWindow();
  appWindow
    .show()
    .then(async () => {
      if (windowShown) return;
      windowShown = true;
      if (!IS_LINUX) return;
      await restoreLinuxMainWindowSize(appWindow).catch((e) =>
        console.error("window size restore failed:", e),
      );
      startLinuxMainWindowSizePersistence(appWindow);
    })
    .catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
// Safety net: if the first show somehow fails to take effect, force again.
setTimeout(showWindow, 500);
