/**
 * Typed wrappers for the Cribl KV Store.
 *
 * All keys map to URL paths under CRIBL_API_URL/kvstore/<key>.
 * Use forward slashes in keys to mirror URL path segments.
 *
 * Docs: AGENTS.md — Key-Value Store
 */

function base(): string {
  const url = window.CRIBL_API_URL;
  if (!url) throw new Error('CRIBL_API_URL is not defined — this app must run inside a Cribl instance.');
  return url;
}

/** Fetch a value by key. Returns null if the key does not exist (404) or body is empty. */
export async function kvGet<T>(key: string): Promise<T | null> {
  const res = await fetch(`${base()}/kvstore/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KV get(${key}) failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const text = await res.text();
  if (!text || !text.trim() || text === 'null') return null;
  if (text === '[object Object]') {
    // Old single-encoded data — proxy corrupted the body.  Treat as missing.
    console.warn(`[kv] get(${key}) received "[object Object]" — stale pre-encoding data, ignoring.`);
    return null;
  }
  return JSON.parse(text) as T;
}

export type KvDiagResult =
  | { status: 'ok' }
  | { status: 'proxy_bug' }
  | { status: 'error'; detail: string }
  | { status: 'no_api_url' };

/**
 * Writes a test value and reads it back to verify KV round-trips work.
 * Returns a diagnostic result the UI can display.
 */
export async function kvDiagnostic(): Promise<KvDiagResult> {
  if (!window.CRIBL_API_URL) return { status: 'no_api_url' };

  const testKey = 'ufe_migrator/diag';
  const testVal = { ts: Date.now(), ok: true };

  try {
    await kvPut(testKey, testVal);
  } catch (e) {
    return { status: 'error', detail: `Write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const result = await kvGet<typeof testVal>(testKey);
    if (result?.ok === true) return { status: 'ok' };
    // kvGet returned null — "[object Object]" was detected, patch didn't take effect
    return { status: 'proxy_bug' };
  } catch (e) {
    return { status: 'error', detail: `Read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Fetch the raw response text for a key — used by the KV debug panel to show
 * exactly what the proxy is returning before any parsing.
 */
export async function kvGetRaw(key: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base()}/kvstore/${key}`);
  const text = await res.text().catch(() => '(failed to read body)');
  return { status: res.status, text };
}

/** Write a value to a key. Creates or overwrites. */
export async function kvPut<T>(key: string, value: T): Promise<void> {
  // Wrap value in a single-element array to survive the Cribl fetch proxy.
  // Proxy flow on GET: text() → JSON.parse → single-element array →
  //   String(["<json>"]) === "<json>" → new Response("<json>") preserves body ✓
  // Storing a plain object causes JSON.parse → object →
  //   String({...}) === "[object Object]" → body corrupted ✗
  const res = await fetch(`${base()}/kvstore/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([JSON.stringify(value)]),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KV put(${key}) failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
}

/** Delete a key. Silently ignores 404. */
export async function kvDelete(key: string): Promise<void> {
  const res = await fetch(`${base()}/kvstore/${key}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`KV delete(${key}) failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
}

/**
 * Check whether a key exists without reading its value.
 * Uses HTTP status only — immune to the proxy body bug.
 */
export async function kvExists(key: string): Promise<boolean> {
  const res = await fetch(`${base()}/kvstore/${key}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`KV exists(${key}) failed: ${res.status}`);
  return true;
}

/**
 * List all keys with a given prefix.
 * Uses POST /kvstore/keys with { prefix } per the platform API.
 */
export async function kvListKeys(prefix: string): Promise<string[]> {
  const res = await fetch(`${base()}/kvstore/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`KV listKeys(${prefix}) failed: ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const text = await res.text();
  if (!text || !text.trim() || text === 'null') return [];
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  if (Array.isArray(data)) return data as string[];
  if (data && typeof data === 'object' && 'keys' in data && Array.isArray((data as Record<string, unknown>).keys)) {
    return (data as { keys: string[] }).keys;
  }
  return [];
}
