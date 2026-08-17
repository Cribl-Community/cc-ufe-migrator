/**
 * Cribl platform API wrappers.
 * All calls go to window.CRIBL_API_URL — the platform proxy injects auth automatically.
 *
 * Endpoint reference (from AGENTS.md + LocalMigrator backend):
 *   Fleets (Edge):       GET  /master/groups?product=edge
 *   Fleet sources:       GET  /m/{fleetId}/system/inputs       (filter type==="file")
 *   Fleet destinations:  GET  /m/{fleetId}/system/outputs
 *   POST source:         POST /m/{fleetId}/system/inputs
 *   Worker groups:       GET  /master/groups?product=stream
 *   WG Cribl inputs:     GET  /m/{wgId}/system/inputs          (filter cribl_tcp|cribl_http)
 *   WG pipelines:        GET  /m/{wgId}/pipelines
 *   WG routes:           GET  /m/{wgId}/routes
 *   POST route:          GET routes → insert → PATCH /m/{wgId}/routes/default
 *   POST pipeline:       POST /m/{wgId}/pipelines
 *   Commit:              POST /version/commit
 */

export interface Fleet        { id: string; name: string; }
export interface Destination  { id: string; type: string; description: string; }
export interface FileSource   { id: string; type: string; path: string; description: string; }
export interface WorkerGroup  { id: string; name: string; }
export interface CriblSource  { id: string; type: string; description: string; }
export interface CriblPipeline { id: string; description: string; }
export interface CriblRoute   { id: string; name?: string; filter?: string; pipeline?: string; output?: string; disabled?: boolean; }

function base(): string {
  const url = window.CRIBL_API_URL;
  if (!url) throw new Error('CRIBL_API_URL is not defined — app must run inside Cribl.');
  return url;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cribl API ${method} ${path} → ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
  }
  return res.json() as T;
}

// ── Edge Fleets ───────────────────────────────────────────────────────────────

export async function listFleets(): Promise<Fleet[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', '/master/groups?product=edge');
  return (d.items ?? []).map(g => ({ id: String(g.id), name: String(g.displayName ?? g.name ?? g.id) }));
}

export async function listFleetSources(fleetId: string): Promise<FileSource[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', `/m/${fleetId}/system/inputs`);
  return (d.items ?? [])
    .filter(s => s.type === 'file')
    .map(s => ({ id: String(s.id), type: String(s.type ?? ''), path: String(s.path ?? ''), description: String(s.description ?? '') }));
}

export async function listFleetDestinations(fleetId: string): Promise<Destination[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', `/m/${fleetId}/system/outputs`);
  return (d.items ?? []).map(s => ({ id: String(s.id), type: String(s.type ?? ''), description: String(s.description ?? '') }));
}

export async function postFleetSource(fleetId: string, source: unknown): Promise<void> {
  await request('POST', `/m/${fleetId}/system/inputs`, source);
}

// ── Stream Worker Groups ──────────────────────────────────────────────────────

export async function listWorkerGroups(): Promise<WorkerGroup[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', '/master/groups?product=stream');
  return (d.items ?? []).map(g => ({ id: String(g.id), name: String(g.displayName ?? g.name ?? g.id) }));
}

export async function listWgCriblSources(wgId: string): Promise<CriblSource[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', `/m/${wgId}/system/inputs`);
  return (d.items ?? [])
    .filter(s => !s.disabled && ['cribl_tcp', 'cribl_http'].includes(String(s.type ?? '').toLowerCase()))
    .map(s => ({ id: String(s.id), type: String(s.type ?? ''), description: String(s.description ?? '') }));
}

export async function listWgPipelines(wgId: string): Promise<CriblPipeline[]> {
  const d = await request<{ items?: Record<string, unknown>[] }>('GET', `/m/${wgId}/pipelines`);
  return (d.items ?? []).map(p => ({ id: String(p.id), description: String(p.description ?? '') }));
}

export async function listWgRoutes(wgId: string): Promise<CriblRoute[]> {
  const d = await request<{ items?: { routes?: CriblRoute[] }[] }>('GET', `/m/${wgId}/routes`);
  return d.items?.[0]?.routes ?? [];
}

export async function postWgRoute(
  wgId: string,
  routeId: string,
  filter: string,
  pipeline: string,
  output: string,
): Promise<void> {
  // GET current routes
  const d = await request<{ items?: { routes?: CriblRoute[] }[] }>('GET', `/m/${wgId}/routes`);
  const routes: CriblRoute[] = [...(d.items?.[0]?.routes ?? [])];

  // Generate 6-char random ID
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const shortId = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');

  const newRoute: CriblRoute & Record<string, unknown> = {
    id: shortId,
    name: routeId,
    filter: filter || 'true',
    pipeline: pipeline || 'passthru',
    output: output || 'devnull',
    final: true,
    disabled: false,
    description: '',
    enableOutputExpression: false,
  };

  // Insert above the default catch-all
  const defaultIdx = routes.findIndex(r => r.id === 'default');
  routes.splice(defaultIdx !== -1 ? defaultIdx : routes.length, 0, newRoute);

  // PATCH the full routes table
  await request('PATCH', `/m/${wgId}/routes/default`, { id: 'default', routes });

  // Best-effort commit
  await request('POST', '/version/commit', { message: `Add route ${routeId}`, group: wgId }).catch(() => {});
}

export async function postWgPipeline(wgId: string, pipelineId: string): Promise<void> {
  await request('POST', `/m/${wgId}/pipelines`, {
    id: pipelineId,
    description: '',
    conf: { asyncFuncTimeout: 1000, functions: [], groups: {}, output: 'default', streamtags: [] },
  });
}
