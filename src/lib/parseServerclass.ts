/** serverclass → enabled app names */
export type ServerclassMap = Record<string, string[]>;

/**
 * Parses a serverclass.conf and returns a map of serverclass → apps[].
 * Only includes apps where stateOnClient = enabled.
 */
export function parseServerclassConf(text: string): ServerclassMap {
  const result: ServerclassMap = {};
  const pattern = /^\[serverClass:([^:]+):app:([^\]]+)\]$/;
  let currentSc: string | null = null;
  let currentApp: string | null = null;
  let stateEnabled = false;

  const flush = () => {
    if (currentSc && currentApp && stateEnabled) {
      if (!result[currentSc]) result[currentSc] = [];
      result[currentSc].push(currentApp);
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      flush();
      currentApp = null;
      stateEnabled = false;
      const m = pattern.exec(line);
      if (m) { currentSc = m[1]; currentApp = m[2]; }
      continue;
    }
    if (currentApp) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        if (line.slice(0, idx).trim() === 'stateOnClient' && line.slice(idx + 1).trim() === 'enabled') {
          stateEnabled = true;
        }
      }
    }
  }
  flush();
  return result;
}
