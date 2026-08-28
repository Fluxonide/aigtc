import * as path from "node:path";
import * as os from "node:os";

const isWindows = process.platform === "win32";

// ── Base Directories ────────────────────────────────────────────────
// macOS/Linux: $XDG_CONFIG_HOME/aigtc  (default ~/.config/aigtc)
//              $XDG_CACHE_HOME/aigtc   (default ~/.cache/aigtc)
//              $XDG_STATE_HOME/aigtc   (default ~/.local/state/aigtc)
// Windows:     %APPDATA%\aigtc         (fallback: ~/AppData/Roaming)
//              %LOCALAPPDATA%\aigtc    (fallback: ~/AppData/Local)

/**
 * Compute the config directory at call time (testable via env manipulation).
 */
export function resolveConfigDir(): string {
  if (isWindows) {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "aigtc");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "aigtc");
}

/**
 * Compute the cache directory at call time (testable via env manipulation).
 */
export function resolveCacheDir(): string {
  if (isWindows) {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "aigtc",
    );
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(xdgCache, "aigtc");
}

/**
 * Compute the state directory at call time (testable via env manipulation).
 * For persistent application state that isn't config or cache.
 */
export function resolveStateDir(): string {
  if (isWindows) {
    // Windows doesn't have XDG_STATE_HOME; use LOCALAPPDATA alongside cache
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "aigtc",
      "state",
    );
  }
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "aigtc");
}

/**
 * Resolve the application data directory.
 * - Linux/macOS: ~/.local/share/aigtc
 * - Windows: %LOCALAPPDATA%\aigtc\data
 */
export function resolveDataDir(): string {
  if (isWindows) {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "aigtc",
      "data",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "aigtc",
  );
}

export const CONFIG_DIR = resolveConfigDir();
export const CACHE_DIR = resolveCacheDir();
export const STATE_DIR = resolveStateDir();
export const DATA_DIR = resolveDataDir();

// ── State Files ─────────────────────────────────────────────────────

export const INSTALL_METHOD_FILE = path.join(STATE_DIR, "install-method");

// ── Config Files ────────────────────────────────────────────────────

export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// ── Cache Files ─────────────────────────────────────────────────────

export const UPDATE_CACHE_FILE = path.join(CACHE_DIR, "update-cache.json");

export function getModelCacheFile(provider: string): string {
  return path.join(CACHE_DIR, `models-${provider}.json`);
}

export function getModelsDevCacheFilePath(): string {
  const override = process.env.AIGTC_MODELS_DEV_CACHE_FILE;
  if (override) return override;
  return path.join(CACHE_DIR, "models-dev-catalog.json");
}

// ── Secrets ─────────────────────────────────────────────────────────

export const SECRETS_FILE = path.join(CONFIG_DIR, "secrets.enc");

// ── Temporary Files ─────────────────────────────────────────────────

export const TEMP_MSG_FILE = path.join(os.tmpdir(), "aigtc-msg.txt");
