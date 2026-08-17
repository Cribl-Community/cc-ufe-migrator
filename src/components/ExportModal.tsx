import { useState, useEffect, useMemo, useCallback } from 'react';
import type { Stanza } from '../types';
import {
  listFleets, listFleetSources, listFleetDestinations, postFleetSource,
  listWorkerGroups, listWgCriblSources, listWgPipelines, listWgRoutes, postWgRoute, postWgPipeline,
} from '../lib/cribl';
import type { Fleet, Destination, FileSource, WorkerGroup, CriblSource, CriblPipeline, CriblRoute } from '../lib/cribl';

// ── Form helpers ──────────────────────────────────────────────────────────────

interface FormFields {
  id: string;
  description: string;
  path: string;
  filenames: string;
  index: string;
  sourcetype: string;
}

function getInitialFormFields(stanza: Stanza): FormFields {
  const get = (k: string) => {
    const line = stanza.settings.find(l => l.split('=')[0].trim().toLowerCase() === k);
    return line ? line.slice(line.indexOf('=') + 1).trim() : null;
  };
  const index      = get('index')      ?? 'main';
  const sourcetype = get('sourcetype') ?? 'unknown';
  const monitorMatch = stanza.header.match(/^\[(monitor|batch):\/\/(.+)\]$/i);
  const fullPath = monitorMatch ? (monitorMatch[2] ?? '').trim() : (get('path') ?? 'PATH');
  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  const wildcardMatch = fullPath.match(/^(.*?)([*]|\.\.\.)/);
  const wbc = wildcardMatch && wildcardMatch[1].length < lastSlash;
  const filePath = wbc
    ? fullPath.slice(0, (wildcardMatch as RegExpMatchArray)[1].length)
    : lastSlash !== -1 ? fullPath.slice(0, lastSlash + 1) : fullPath;
  const fileName = wbc
    ? fullPath.replace(/\.\.\./, '*')
    : lastSlash !== -1 ? fullPath.slice(lastSlash + 1) : '';
  const whitelist = get('whitelist');
  const wEntries = whitelist ? whitelist.split(',').map(w => w.trim()).filter(Boolean) : [];
  const filenamesArr = fileName
    ? [...new Set([fileName, ...wEntries])]
    : wEntries.length ? wEntries : ['*/log/*', '*log'];
  const id = stanza.header.replace(/^\[|\]$/g, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  return { id, description: 'Defined at <<<FLEET>>> Fleet', path: filePath, filenames: filenamesArr.join(', '), index, sourcetype };
}

function buildJsonFromFields(fields: FormFields, output = 'devnull'): string {
  return JSON.stringify({
    disabled: false, sendToRoutes: false, pqEnabled: false, streamtags: [],
    mode: 'manual', interval: 10,
    filenames: fields.filenames.split(',').map(f => f.trim()).filter(Boolean),
    filterArchivedFiles: false, tailOnly: true, idleTimeout: 300,
    checkFileModTime: false, forceText: false, hashLen: 256,
    staleChannelFlushMs: 10000, suppressMissingPathErrors: true,
    deleteFiles: false, saltHash: false, includeUnidentifiableBinary: false,
    id: fields.id, type: 'file',
    description: fields.description,
    path: fields.path,
    connections: [{ pipeline: 'passthru', output }],
    metadata: [
      { name: 'index',      value: `"${fields.index}"` },
      { name: 'sourcetype', value: `"${fields.sourcetype}"` },
    ],
  }, null, 2);
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '7px', padding: '9px 12px', fontSize: '12px',
  fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none',
  transition: 'border-color 0.15s', boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(34,211,238,0.25)',
  borderRadius: '7px', padding: '9px 12px', fontSize: '12px',
  fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none', boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace",
  color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px',
};

const hintStyle: React.CSSProperties = {
  fontSize: '10px', fontFamily: "'JetBrains Mono', monospace",
  color: 'rgba(255,255,255,0.25)', marginTop: '4px',
};

const ghostBox = (text: string, color: string) => (
  <div style={{ padding: '9px 12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '7px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color }}>{text}</div>
);

const toggleSwitch = (on: boolean) => (
  <div style={{ width: '36px', height: '20px', borderRadius: '10px', background: on ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.08)', border: `1px solid ${on ? 'rgba(34,211,238,0.5)' : 'rgba(255,255,255,0.15)'}`, position: 'relative', transition: 'all 0.2s', flexShrink: 0 }}>
    <div style={{ position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '14px', height: '14px', borderRadius: '50%', background: on ? '#22d3ee' : 'rgba(255,255,255,0.3)', transition: 'left 0.2s', boxShadow: on ? '0 0 6px rgba(34,211,238,0.6)' : 'none' }} />
  </div>
);

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  stanza: Stanza;
  appName: string;
  onClose: () => void;
  onMarkMigrated: (header: string, label: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ExportModal({ stanza, appName, onClose, onMarkMigrated }: Props) {
  void appName;

  // Form fields (left panel)
  const [formFields, setFormFields] = useState<FormFields>(() => getInitialFormFields(stanza));

  // Fleet + destination
  const [fleets, setFleets]                     = useState<Fleet[]>([]);
  const [fleetsLoading, setFleetsLoading]       = useState(true);
  const [selectedFleet, setSelectedFleet]       = useState('');
  const [destinations, setDestinations]         = useState<Destination[]>([]);
  const [destsLoading, setDestsLoading]         = useState(false);
  const [selectedDest, setSelectedDest]         = useState('');
  const [existingSources, setExistingSources]   = useState<FileSource[]>([]);
  const [sourcesLoading, setSourcesLoading]     = useState(false);

  // Create Route
  const [createRoute, setCreateRoute]           = useState(false);
  const [workerGroups, setWorkerGroups]         = useState<WorkerGroup[]>([]);
  const [wgsLoading, setWgsLoading]             = useState(true);
  const [selectedWg, setSelectedWg]             = useState('');
  const [wgSources, setWgSources]               = useState<CriblSource[]>([]);
  const [wgSourcesLoading, setWgSourcesLoading] = useState(false);
  const [selectedInputId, setSelectedInputId]   = useState('');
  const [routeName, setRouteName]               = useState('');
  const [routeFilter, setRouteFilter]           = useState('');
  const [wgPipelines, setWgPipelines]           = useState<CriblPipeline[]>([]);
  const [wgPipelinesLoading, setWgPipelinesLoading] = useState(false);
  const [selectedPipeline, setSelectedPipeline] = useState('passthru');
  const [createPipeline, setCreatePipeline]     = useState(false);
  const [pipelineName, setPipelineName]         = useState('');
  const [existingRoutes, setExistingRoutes]     = useState<CriblRoute[]>([]);
  const [routesLoading, setRoutesLoading]       = useState(false);

  // POST status
  const [postStatus, setPostStatus]             = useState<'idle' | 'posting' | 'success' | 'error'>('idle');
  const [postError, setPostError]               = useState('');
  const [routePostStatus, setRoutePostStatus]   = useState<'idle' | 'posting' | 'success' | 'error'>('idle');
  const [routePostError, setRoutePostError]     = useState('');

  // Copy JSON footer button
  const [copiedJson, setCopiedJson]             = useState(false);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const formJson = useMemo(
    () => buildJsonFromFields(formFields, selectedDest || 'devnull'),
    [formFields, selectedDest],
  );

  // ── Initial load: fleets + worker groups ──────────────────────────────────

  useEffect(() => {
    setFleetsLoading(true);
    listFleets()
      .then(f => { setFleets(f); if (f.length) setSelectedFleet(f[0].id); })
      .catch(() => setFleets([]))
      .finally(() => setFleetsLoading(false));

    setWgsLoading(true);
    listWorkerGroups()
      .then(w => { setWorkerGroups(w); if (w.length) setSelectedWg(w[0].id); })
      .catch(() => setWorkerGroups([]))
      .finally(() => setWgsLoading(false));
  }, []);

  // ── Load destinations + existing sources when fleet changes ───────────────

  useEffect(() => {
    if (!selectedFleet) return;

    // Update description placeholder
    const fleet = fleets.find(f => f.id === selectedFleet);
    if (fleet) {
      setFormFields(prev => ({
        ...prev,
        description: prev.description.startsWith('Defined at')
          ? `Defined at ${fleet.name} Fleet`
          : prev.description,
      }));
    }

    setDestsLoading(true);
    listFleetDestinations(selectedFleet)
      .then(d => { setDestinations(d); setSelectedDest(''); })
      .catch(() => setDestinations([]))
      .finally(() => setDestsLoading(false));

    setSourcesLoading(true);
    listFleetSources(selectedFleet)
      .then(s => setExistingSources(s))
      .catch(() => setExistingSources([]))
      .finally(() => setSourcesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFleet]);

  // ── Load WG sources + pipelines when worker group changes ─────────────────

  const fetchExistingRoutes = useCallback(async (wg: string) => {
    setRoutesLoading(true);
    try { setExistingRoutes(await listWgRoutes(wg)); }
    catch { setExistingRoutes([]); }
    finally { setRoutesLoading(false); }
  }, []);

  useEffect(() => {
    if (!selectedWg) return;

    setWgSourcesLoading(true);
    listWgCriblSources(selectedWg)
      .then(s => { setWgSources(s); setSelectedInputId(''); })
      .catch(() => setWgSources([]))
      .finally(() => setWgSourcesLoading(false));

    setWgPipelinesLoading(true);
    listWgPipelines(selectedWg)
      .then(p => { setWgPipelines(p); setSelectedPipeline('passthru'); })
      .catch(() => setWgPipelines([]))
      .finally(() => setWgPipelinesLoading(false));

    if (createRoute) fetchExistingRoutes(selectedWg);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWg]);

  // ── Auto-build route name + pipeline name from sourcetype ─────────────────

  useEffect(() => {
    const safeSt = (formFields.sourcetype || '').replace(/:/g, '_');
    setRouteName(`rt_edge_${formFields.index || ''}_${safeSt}`);
    setPipelineName(`pl_${safeSt}`);
  }, [formFields.index, formFields.sourcetype]);

  // ── Auto-rebuild route filter ──────────────────────────────────────────────

  useEffect(() => {
    const src = wgSources.find(s => s.id === selectedInputId);
    const label = src ? (src.type ? `${src.type}:${selectedInputId}` : selectedInputId) : selectedInputId;
    const parts = [
      label ? `__inputId=='${label}'` : '',
      formFields.index ? `index=='${formFields.index}'` : '',
      formFields.sourcetype ? `sourcetype=='${formFields.sourcetype}'` : '',
    ].filter(Boolean);
    setRouteFilter(parts.join(' && '));
  }, [selectedInputId, wgSources, formFields.index, formFields.sourcetype]);

  // ── Escape to close ───────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const fleetPosting = postStatus === 'posting';
  const routePosting = routePostStatus === 'posting';
  const canPostFleet = selectedFleet && !fleetPosting && !fleetsLoading;
  const canPostRoute = selectedWg && routeName && selectedInputId && !routePosting;

  async function handlePostFleet() {
    if (!selectedFleet || !formJson) return;
    setPostStatus('posting');
    setPostError('');
    try {
      await postFleetSource(selectedFleet, JSON.parse(formJson));
      const fleetName = fleets.find(f => f.id === selectedFleet)?.name ?? selectedFleet;
      onMarkMigrated(stanza.header, `Migrated to Fleet ${fleetName}`);
      setPostStatus('success');
      // Refresh existing sources
      listFleetSources(selectedFleet).then(setExistingSources).catch(() => {});
      setTimeout(() => { setPostStatus('idle'); onClose(); }, 2000);
    } catch (e) {
      setPostStatus('error');
      setPostError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePostRoute() {
    if (!selectedWg || !routeName || !selectedInputId) return;
    setRoutePostStatus('posting');
    setRoutePostError('');
    try {
      if (createPipeline && pipelineName) {
        await postWgPipeline(selectedWg, pipelineName);
      }
      const pipeline = createPipeline && pipelineName ? pipelineName : selectedPipeline || 'passthru';
      await postWgRoute(selectedWg, routeName, routeFilter || 'true', pipeline, 'devnull');
      setRoutePostStatus('success');
      await fetchExistingRoutes(selectedWg);
      setTimeout(() => setRoutePostStatus('idle'), 3000);
    } catch (e) {
      setRoutePostStatus('error');
      setRoutePostError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleCopyJson() {
    if (!formJson) return;
    const after = () => {
      onMarkMigrated(stanza.header, 'Migrated via Copy JSON');
      setCopiedJson(true);
      setTimeout(() => { setCopiedJson(false); onClose(); }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(formJson).then(after).catch(() => {
        const ta = document.createElement('textarea'); ta.value = formJson;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta); after();
      });
    } else {
      const ta = document.createElement('textarea'); ta.value = formJson;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta); after();
    }
  }

  // ── Form field rows ───────────────────────────────────────────────────────

  const formRow = (label: string, key: keyof FormFields, hint: string) => (
    <div key={key} style={{ marginBottom: '18px' }}>
      <label style={labelStyle}>{label}</label>
      <input
        value={formFields[key]}
        onChange={e => setFormFields(prev => ({ ...prev, [key]: e.target.value }))}
        style={inputStyle}
        onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
        onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
      />
      <div style={hintStyle}>{hint}</div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0f0f18', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '14px', width: '860px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div style={{ padding: '20px 28px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '3px' }}>Cribl Edge · File Source</div>
            <div style={{ fontSize: '16px', fontWeight: '800', color: '#e8e8ff' }}>Export to Cribl</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>✕ Close</button>
        </div>

        {/* ── Body ── */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Left: form ── */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', borderRight: '1px solid rgba(255,255,255,0.07)' }}>

            {/* Fleet */}
            <div style={{ marginBottom: '18px' }}>
              <label style={labelStyle}>Fleet</label>
              {fleetsLoading
                ? ghostBox('Loading fleets…', 'rgba(34,211,238,0.5)')
                : fleets.length === 0
                  ? ghostBox('No Edge fleets found', 'rgba(255,100,100,0.7)')
                  : <select value={selectedFleet} onChange={e => setSelectedFleet(e.target.value)} style={selectStyle}>
                      {fleets.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
              }
            </div>

            {/* Destination */}
            <div style={{ marginBottom: '18px' }}>
              <label style={labelStyle}>
                Destination{' '}
                <span style={{ color: 'rgba(255,255,255,0.25)', textTransform: 'none', letterSpacing: 0, fontSize: '9px' }}>— defaults to devnull if none selected</span>
              </label>
              {!selectedFleet
                ? ghostBox('Select a fleet first', 'rgba(255,255,255,0.2)')
                : destsLoading
                  ? ghostBox('Loading destinations…', 'rgba(34,211,238,0.5)')
                  : <select value={selectedDest} onChange={e => setSelectedDest(e.target.value)} style={selectStyle}>
                      <option value="">— use devnull (default) —</option>
                      {destinations.map(d => (
                        <option key={d.id} value={d.id}>{d.id}{d.type ? ` (${d.type})` : ''}{d.description ? ` — ${d.description}` : ''}</option>
                      ))}
                    </select>
              }
            </div>

            {/* Core fields */}
            {formRow('ID',          'id',          'Unique source identifier')}
            {formRow('Description', 'description', 'e.g. App Monitor for historical')}
            {formRow('Path',        'path',        'Directory to monitor')}
            {formRow('Filenames',   'filenames',   'Comma-separated globs e.g. *.log, app*.txt')}
            {formRow('Index',       'index',       'Destination index')}
            {formRow('Sourcetype',  'sourcetype',  'Data sourcetype')}

            {/* Create Route toggle */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '18px', marginBottom: '14px' }}>
              <div
                onClick={() => {
                  const next = !createRoute;
                  setCreateRoute(next);
                  setRoutePostStatus('idle');
                  setRoutePostError('');
                  if (next && selectedWg) fetchExistingRoutes(selectedWg);
                }}
                style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', userSelect: 'none' }}
              >
                {toggleSwitch(createRoute)}
                <div>
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: createRoute ? '#22d3ee' : 'rgba(255,255,255,0.5)', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Create Route</div>
                  <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', marginTop: '2px' }}>POST a new route to a Stream Worker Group</div>
                </div>
              </div>
            </div>

            {createRoute && (<>
              {/* Worker Group */}
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Worker Group</label>
                {wgsLoading
                  ? ghostBox('Loading worker groups…', 'rgba(34,211,238,0.5)')
                  : workerGroups.length === 0
                    ? ghostBox('No Stream Worker Groups found', 'rgba(255,100,100,0.7)')
                    : <select value={selectedWg} onChange={e => setSelectedWg(e.target.value)} style={selectStyle}>
                        {workerGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                }
              </div>

              {/* Route Name */}
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Route Name</label>
                <input value={routeName} onChange={e => setRouteName(e.target.value)} style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
                <div style={hintStyle}>Auto-generated · editable · inserted above default route</div>
              </div>

              {/* Input ID */}
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Input ID</label>
                {wgSourcesLoading
                  ? ghostBox('Loading sources…', 'rgba(34,211,238,0.5)')
                  : !selectedWg
                    ? ghostBox('Select a worker group first', 'rgba(255,255,255,0.2)')
                    : <select value={selectedInputId} onChange={e => setSelectedInputId(e.target.value)} style={selectStyle}>
                        <option value="">— select an input ID —</option>
                        {wgSources.map(s => <option key={s.id} value={s.id}>{s.type ? `${s.type}:${s.id}` : s.id}</option>)}
                      </select>
                }
              </div>

              {/* Filter */}
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>Filter</label>
                <input
                  value={routeFilter} onChange={e => setRouteFilter(e.target.value)}
                  style={{ ...inputStyle, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
                  onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.3)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; }}
                />
                <div style={hintStyle}>Auto-built from InputID + Index + Sourcetype · editable</div>
              </div>

              {/* Pipeline */}
              <div style={{ marginBottom: '14px' }}>
                <label style={labelStyle}>
                  Pipeline{' '}
                  <span style={{ color: 'rgba(255,255,255,0.25)', textTransform: 'none', letterSpacing: 0, fontSize: '9px' }}>— overridden by Create Pipeline if enabled</span>
                </label>
                {wgPipelinesLoading
                  ? ghostBox('Loading pipelines…', 'rgba(34,211,238,0.5)')
                  : <select
                      value={createPipeline ? pipelineName : selectedPipeline}
                      disabled={createPipeline}
                      onChange={e => setSelectedPipeline(e.target.value)}
                      style={{ ...selectStyle, ...(createPipeline ? { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.3)', cursor: 'not-allowed' } : { cursor: 'pointer' }) }}
                    >
                      <option value="passthru">passthru (default)</option>
                      {wgPipelines.filter(p => p.id !== 'passthru').map(p => (
                        <option key={p.id} value={p.id}>{p.id}{p.description ? ` — ${p.description}` : ''}</option>
                      ))}
                    </select>
                }
              </div>

              {/* Create Pipeline toggle */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '14px', marginBottom: createPipeline ? '12px' : '14px' }}>
                <div onClick={() => setCreatePipeline(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', userSelect: 'none' }}>
                  {toggleSwitch(createPipeline)}
                  <div>
                    <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: createPipeline ? '#22d3ee' : 'rgba(255,255,255,0.5)', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Create Pipeline</div>
                    <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', marginTop: '2px' }}>Create a new pipeline for this route</div>
                  </div>
                </div>
              </div>

              {createPipeline && (
                <div style={{ marginBottom: '14px' }}>
                  <label style={labelStyle}>Pipeline Name</label>
                  <input value={pipelineName} onChange={e => setPipelineName(e.target.value)} style={inputStyle}
                    onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
                    onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }} />
                  <div style={hintStyle}>Auto-generated from sourcetype · editable</div>
                </div>
              )}

              {/* Route POST status */}
              {routePostStatus === 'success' && (
                <div style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '7px', padding: '8px 12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', marginBottom: '10px' }}>
                  ✓ {createPipeline && pipelineName ? `Pipeline "${pipelineName}" and route "${routeName}"` : `Route "${routeName}"`} created on {selectedWg}
                </div>
              )}
              {routePostStatus === 'error' && (
                <div style={{ background: 'rgba(255,100,100,0.08)', border: '1px solid rgba(255,100,100,0.25)', borderRadius: '7px', padding: '8px 12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.8)', marginBottom: '10px' }}>
                  ⚠ {routePostError}
                </div>
              )}

              {/* POST Route button */}
              <button
                disabled={!canPostRoute}
                onClick={handlePostRoute}
                style={{ width: '100%', background: !canPostRoute ? 'rgba(255,255,255,0.03)' : routePosting ? 'rgba(34,211,238,0.05)' : 'rgba(34,211,238,0.08)', border: `1px solid ${!canPostRoute ? 'rgba(255,255,255,0.08)' : 'rgba(34,211,238,0.25)'}`, borderRadius: '7px', padding: '9px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: !canPostRoute ? 'rgba(255,255,255,0.2)' : '#22d3ee', cursor: !canPostRoute || routePosting ? 'default' : 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '18px', transition: 'all 0.15s' }}
                onMouseEnter={e => { if (canPostRoute && !routePosting) e.currentTarget.style.background = 'rgba(34,211,238,0.15)'; }}
                onMouseLeave={e => { if (canPostRoute && !routePosting) e.currentTarget.style.background = 'rgba(34,211,238,0.08)'; }}
              >
                {routePosting ? 'Posting…' : createPipeline ? '⬡ POST Route and Pipeline to Worker Group' : '⬡ POST Route to Worker Group'}
              </button>
            </>)}
          </div>

          {/* ── Right: existing sources / routes ── */}
          <div style={{ width: '380px', flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '0 4px' }}>
              <div style={{ flex: 1, padding: '12px 8px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.08em', color: '#22d3ee', borderBottom: '2px solid #22d3ee' }}>
                {createRoute
                  ? `Existing Routes${existingRoutes.length ? ` (${existingRoutes.length})` : ''}`
                  : `Existing Sources${existingSources.length ? ` (${existingSources.length})` : ''}`}
              </div>
              <button
                onClick={async () => {
                  if (createRoute) {
                    if (!selectedWg) return;
                    await fetchExistingRoutes(selectedWg);
                  } else {
                    if (!selectedFleet) return;
                    setSourcesLoading(true);
                    try { setExistingSources(await listFleetSources(selectedFleet)); }
                    catch { setExistingSources([]); }
                    finally { setSourcesLoading(false); }
                  }
                }}
                disabled={createRoute ? !selectedWg : !selectedFleet}
                title="Refresh"
                style={{ background: 'rgba(34,211,238,0.06)', border: '1px solid rgba(34,211,238,0.2)', borderRadius: '5px', padding: '4px 8px', fontSize: '11px', color: (createRoute ? selectedWg : selectedFleet) ? '#22d3ee' : 'rgba(255,255,255,0.2)', cursor: (createRoute ? selectedWg : selectedFleet) ? 'pointer' : 'default', flexShrink: 0, transition: 'all 0.15s' }}
                onMouseEnter={e => { if (createRoute ? selectedWg : selectedFleet) e.currentTarget.style.background = 'rgba(34,211,238,0.14)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.06)'; }}
              >↻</button>
            </div>

            {createRoute ? (
              /* Existing Routes */
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
                {routesLoading ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.5)', padding: '12px 0' }}>Loading routes…</div>
                ) : !selectedWg ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', padding: '12px 0' }}>Select a worker group then click ↻ to load routes</div>
                ) : existingRoutes.length === 0 ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', padding: '12px 0' }}>No routes found — click ↻ to load</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {existingRoutes.map((r, i) => (
                      <div key={r.id || i} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '6px', padding: '7px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)' }}>#{i + 1}</span>
                          <span style={{ fontSize: '11px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.id || 'unnamed'}</span>
                          {r.disabled && <span style={{ fontSize: '8px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.6)', background: 'rgba(255,100,100,0.08)', border: '1px solid rgba(255,100,100,0.2)', borderRadius: '4px', padding: '1px 5px', flexShrink: 0 }}>disabled</span>}
                        </div>
                        {r.filter && <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.filter}</div>}
                        {r.pipeline && <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(167,139,250,0.6)', marginTop: '1px' }}>→ {r.pipeline}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* Existing Sources */
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
                {sourcesLoading ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.5)', padding: '12px 0' }}>Loading sources…</div>
                ) : !selectedFleet ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', padding: '12px 0' }}>Select a fleet first</div>
                ) : existingSources.length === 0 ? (
                  <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', padding: '12px 0' }}>No file sources found in this fleet</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {existingSources.map(s => {
                      const isDuplicate = s.id === formFields.id;
                      return (
                        <div key={s.id} style={{ background: isDuplicate ? 'rgba(251,146,60,0.06)' : 'rgba(255,255,255,0.02)', border: `1px solid ${isDuplicate ? 'rgba(251,146,60,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: '6px', padding: '8px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                            <span style={{ fontSize: '11px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: isDuplicate ? '#fb923c' : '#e8e8ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.id}</span>
                            {isDuplicate && <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#fb923c', background: 'rgba(251,146,60,0.1)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: '4px', padding: '1px 5px', flexShrink: 0 }}>ID CONFLICT</span>}
                          </div>
                          {s.path && <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.path}</div>}
                          {s.description && <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{ padding: '16px 28px', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '10px', flexShrink: 0 }}>
          {postStatus === 'success' && (
            <div style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '7px', padding: '10px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80' }}>
              ✓ Successfully posted to Cribl fleet — stanza marked as migrated
            </div>
          )}
          {postStatus === 'error' && (
            <div style={{ background: 'rgba(255,100,100,0.08)', border: '1px solid rgba(255,100,100,0.25)', borderRadius: '7px', padding: '10px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.8)' }}>
              ⚠ {postError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 18px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>Cancel</button>

            {/* Copy JSON */}
            <button
              onClick={handleCopyJson}
              style={{ background: copiedJson ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.05)', border: `1px solid ${copiedJson ? 'rgba(34,211,238,0.5)' : 'rgba(255,255,255,0.12)'}`, borderRadius: '7px', padding: '9px 18px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: copiedJson ? '#22d3ee' : 'rgba(255,255,255,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '7px', transition: 'all 0.15s' }}
            >
              {copiedJson
                ? <><svg width="13" height="13" viewBox="0 0 13 13" fill="none"><polyline points="1,7 5,11 12,2" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>Copied</>
                : <><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="currentColor"/></svg>Copy JSON</>}
            </button>

            {/* POST to Fleet */}
            <button
              disabled={!canPostFleet}
              onClick={handlePostFleet}
              style={{ background: !canPostFleet ? 'rgba(255,255,255,0.03)' : fleetPosting ? 'rgba(34,211,238,0.05)' : 'rgba(34,211,238,0.1)', border: `1px solid ${!canPostFleet ? 'rgba(255,255,255,0.08)' : 'rgba(34,211,238,0.35)'}`, borderRadius: '7px', padding: '9px 20px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: !canPostFleet ? 'rgba(255,255,255,0.2)' : '#22d3ee', cursor: !canPostFleet || fleetPosting ? 'default' : 'pointer', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '7px', transition: 'all 0.15s' }}
              onMouseEnter={e => { if (canPostFleet && !fleetPosting) e.currentTarget.style.background = 'rgba(34,211,238,0.18)'; }}
              onMouseLeave={e => { if (canPostFleet && !fleetPosting) e.currentTarget.style.background = 'rgba(34,211,238,0.1)'; }}
            >
              <span style={{ fontSize: '13px' }}>⬡</span>
              {fleetPosting ? 'Posting…' : 'POST to Fleet'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
