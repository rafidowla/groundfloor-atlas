/**
 * useFolderPicker.ts — Tauri-aware folder picker hook.
 *
 * When running inside Tauri (desktop), invokes the native OS folder picker
 * via @tauri-apps/plugin-dialog. When running in a plain browser (dev server,
 * tests), falls back to a browser prompt() dialog so the folder path can still
 * be entered manually.
 *
 * Returns:
 *   pickFolder() — async, resolves to the chosen path string or null if cancelled
 *   isTauri      — true when the native dialog is available
 */

export interface UseFolderPickerResult {
  pickFolder: () => Promise<string | null>;
  isTauri: boolean;
}

/** Duck-type check for Tauri internals. */
function detectTauri(): boolean {
  return typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window;
}

export function useFolderPicker(): UseFolderPickerResult {
  const isTauri = detectTauri();

  const pickFolder = async (): Promise<string | null> => {
    if (isTauri) {
      try {
        // Dynamic import so bundlers don't error in non-Tauri builds
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select Project Folder',
        });
        if (selected === null || selected === undefined) return null;
        // plugin returns string | string[] | null
        return Array.isArray(selected) ? (selected[0] ?? null) : selected;
      } catch (err) {
        console.warn('Tauri folder dialog failed:', err);
        return null;
      }
    }

    // Browser fallback
    const result = window.prompt('Enter absolute folder path:');
    return result && result.trim().length > 0 ? result.trim() : null;
  };

  return { pickFolder, isTauri };
}
