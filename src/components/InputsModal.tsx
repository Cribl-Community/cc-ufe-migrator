import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { gzipSync } from 'fflate';
import type { AppInputs, Stanza } from '../types';
import ExportModal from './ExportModal';

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).catch(() => execCopy(text));
  }
  return execCopy(text);
}
function execCopy(text: string): Promise<void> {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

// ── Stanza parser (local copy — keeps this component self-contained) ──────────

function parseStanzas(text: string): Stanza[] {
  if (!text) return [];
  const stanzas: Stanza[] = [];
  let current: Stanza | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const commentedHeader = line.match(/^#(\[.+\])$/);
    if (commentedHeader) {
      if (current) stanzas.push(current);
      current = { header: commentedHeader[1], settings: [], commentedOut: true };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (current) stanzas.push(current);
      current = { header: line, settings: [], commentedOut: false };
    } else if (current) {
      current.settings.push(line);
    }
  }
  if (current) stanzas.push(current);
  const seen = new Map<string, Stanza>();
  for (const s of stanzas) seen.set(s.header, s);
  return [...seen.values()];
}

function getStanzaSetting(s: Stanza, key: string): string | null {
  const line = s.settings.find(l => l.split('=')[0].trim().toLowerCase() === key);
  return line ? line.slice(line.indexOf('=') + 1).trim().toLowerCase().replace(/^"|"$/g, '') : null;
}

// ── Cribl File Source JSON generator ─────────────────────────────────────────

function buildFileSourceJson(stanza: Stanza, appName: string): string {
  const get = (k: string) => {
    const line = stanza.settings.find(l => l.split('=')[0].trim().toLowerCase() === k);
    return line ? line.slice(line.indexOf('=') + 1).trim() : null;
  };
  const index      = get('index')      ?? 'main';
  const sourcetype = get('sourcetype') ?? 'unknown';
  const ignoreOlderThan = get('ignoreolderthan') ?? get('ignoreolderthan');

  const monitorMatch = stanza.header.match(/^\[(monitor|batch):\/\/(.+)\]$/i);
  const fullPath = monitorMatch ? (monitorMatch[2] ?? '').trim() : (get('path') ?? 'PATH');
  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  const wildcardMatch = fullPath.match(/^(.*?)([*]|\.\.\.)/);
  const wildcardBeforeSlash = wildcardMatch && wildcardMatch[1].length < lastSlash;
  const filePath = wildcardBeforeSlash
    ? fullPath.slice(0, (wildcardMatch as RegExpMatchArray)[1].length)
    : lastSlash !== -1 ? fullPath.slice(0, lastSlash + 1) : fullPath;
  const fileName = wildcardBeforeSlash
    ? fullPath.replace(/\.\.\./, '*')
    : lastSlash !== -1 ? fullPath.slice(lastSlash + 1) : '';

  const whitelist = get('whitelist');
  const whitelistEntries = whitelist ? whitelist.split(',').map(w => w.trim()).filter(Boolean) : [];
  const filenames = fileName
    ? [...new Set([fileName, ...whitelistEntries])]
    : whitelistEntries.length ? whitelistEntries : ['*/log/*', '*log'];

  const id = stanza.header.replace(/^\[|\]$/g, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');

  const source = {
    disabled: false,
    sendToRoutes: false,
    pqEnabled: false,
    streamtags: [],
    mode: 'manual',
    interval: 10,
    filenames,
    filterArchivedFiles: false,
    tailOnly: true,
    idleTimeout: 300,
    checkFileModTime: false,
    forceText: false,
    hashLen: 256,
    staleChannelFlushMs: 10000,
    suppressMissingPathErrors: true,
    deleteFiles: false,
    saltHash: false,
    includeUnidentifiableBinary: false,
    id,
    type: 'file',
    ...(ignoreOlderThan ? { maxAgeDur: ignoreOlderThan } : {}),
    description: `${appName} - ${stanza.header}`,
    path: filePath,
    connections: [{ pipeline: 'passthru', output: 'devnull' }],
    metadata: [
      { name: 'index',      value: `"${index}"` },
      { name: 'sourcetype', value: `"${sourcetype}"` },
    ],
  };
  return JSON.stringify(source, null, 2);
}

// ── Pack builder (client-side .crbl) ─────────────────────────────────────────

function buildPackTemplateSource(params: {
  id: string; path: string; filenames: string[];
  index: string; sourcetype: string; ignoreOlderThan: string | null;
  description: string; output: string;
}): string {
  const { id, path, filenames, index, sourcetype, ignoreOlderThan, description, output } = params;
  const filenamesList = filenames.map(f => `      - "${f}"`).join('\n');
  const maxAgeDurLine = ignoreOlderThan ? `\n    maxAgeDur: ${ignoreOlderThan}` : '';
  return `inputs:
  ${id}:
    disabled: false
    sendToRoutes: false
    pqEnabled: false
    streamtags: []
    mode: manual
    interval: 10
    filenames:
${filenamesList}
    filterArchivedFiles: false
    tailOnly: true
    idleTimeout: 300
    checkFileModTime: false
    forceText: false
    hashLen: 256
    staleChannelFlushMs: 10000
    suppressMissingPathErrors: true
    deleteFiles: false
    saltHash: false
    includeUnidentifiableBinary: false
    type: file${maxAgeDurLine}
    description: ${description || 'Defined at <<<FLEET>>> Fleet'}
    path: '${path}'
    connections:
      - pipeline: passthru
        output: ${output || 'devnull'}
    metadata:
      - name: index
        value: '"${index}"'
      - name: sourcetype
        value: '"${sourcetype}"'`;
}

async function buildPackDataUrl(
  selectedHeaders: Set<string>,
  stanzas: Stanza[],
  displayName: string,
  description: string,
  output: string,
): Promise<{ dataUrl: string; filename: string; tgzBytes: Uint8Array }> {
  const packName = displayName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-') || 'my-pack';

  const entries = [...selectedHeaders].map(header => {
    const stanza = stanzas.find(s => s.header === header);
    const get = (k: string) => {
      if (!stanza) return null;
      const line = stanza.settings.find(l => l.split('=')[0].trim().toLowerCase() === k);
      return line ? line.slice(line.indexOf('=') + 1).trim() : null;
    };
    const index = get('index') ?? 'main';
    const sourcetype = get('sourcetype') ?? 'unknown';
    const ignoreOlderThan = get('ignoreolderthan');
    const monitorMatch = header.match(/^\[(monitor|batch):\/\/(.+)\]$/i);
    const fullPath = monitorMatch ? (monitorMatch[2] ?? '').trim() : (get('path') ?? 'PATH');
    const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    const wildcardMatch = fullPath.match(/^(.*?)([*]|\.\.\.)/);
    const wildcardBeforeSlash = wildcardMatch && wildcardMatch[1].length < lastSlash;
    const filePath = wildcardBeforeSlash
      ? fullPath.slice(0, (wildcardMatch as RegExpMatchArray)[1].length)
      : lastSlash !== -1 ? fullPath.slice(0, lastSlash + 1) : fullPath;
    const fileName = wildcardBeforeSlash
      ? fullPath.replace(/\.\.\./, '*')
      : lastSlash !== -1 ? fullPath.slice(lastSlash + 1) : '';
    const whitelist = get('whitelist');
    const whitelistEntries = whitelist ? whitelist.split(',').map(w => w.trim()).filter(Boolean) : [];
    const filenames = fileName
      ? [...new Set([fileName, ...whitelistEntries])]
      : whitelistEntries.length ? whitelistEntries : ['*/log/*', '*log'];
    const id = fullPath.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

    return buildPackTemplateSource({ id, path: filePath, filenames, index: index ?? 'main', sourcetype: sourcetype ?? 'unknown', ignoreOlderThan, description, output });
  });

  const merged = 'inputs:\n' + entries.map(e => e.replace(/^inputs:\n/, '')).join('\n');
  const pkg = JSON.stringify({
    version: '0.0.1', tags: { streamtags: [] }, exports: [],
    displayName: displayName || 'My Pack', name: packName, minLogStreamVersion: '4.12.0',
  });

  // Build tar archive then gzip it — Cribl packs are .tgz renamed .crbl
  const enc = new TextEncoder();
  const tgz = gzipSync(buildTar([
    { name: 'package.json', data: enc.encode(pkg) },
    { name: 'default/inputs.yml', data: enc.encode(merged) },
  ]));

  // Base64-encode the tgz bytes
  let binary = '';
  for (let i = 0; i < tgz.length; i++) binary += String.fromCharCode(tgz[i]);
  const b64 = btoa(binary);

  // HTML page: script converts base64 → Blob URL so the `download` attribute is honoured
  const html = '<!DOCTYPE html><html><head><title>Download ' + packName + '.crbl</title>'
    + '<style>body{background:#0f0f18;color:#e8e8ff;font-family:monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px}'
    + 'a{display:inline-block;background:rgba(34,211,238,0.12);border:2px solid rgba(34,211,238,0.5);border-radius:10px;padding:16px 36px;color:#22d3ee;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:.06em}'
    + 'a:hover{background:rgba(34,211,238,0.22)}p{color:rgba(255,255,255,.4);font-size:12px;margin:0}</style>'
    + '</head><body>'
    + '<a id="dl">Download ' + packName + '.crbl</a>'
    + '<p>Click the button above to download your Cribl pack.</p>'
    + '<script>'
    + 'var b="' + b64 + '";'
    + 'var bytes=atob(b),arr=new Uint8Array(bytes.length);'
    + 'for(var i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);'
    + 'var blob=new Blob([arr],{type:"application/gzip"});'
    + 'var a=document.getElementById("dl");'
    + 'a.href=URL.createObjectURL(blob);'
    + 'a.download="' + packName + '.crbl";'
    + '</scr' + 'ipt>'
    + '</body></html>';

  const b64html = btoa(encodeURIComponent(html).replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return { dataUrl: `data:text/html;base64,${b64html}`, filename: `${packName}.crbl`, tgzBytes: tgz };
}

function makeTarHeader(name: string, size: number, isDir: boolean): Uint8Array {
  const header = new Uint8Array(512);
  const wr = (off: number, len: number, s: string) => {
    for (let i = 0; i < s.length && i < len; i++) header[off + i] = s.charCodeAt(i);
  };
  const wo = (off: number, len: number, n: number) => {
    const s = n.toString(8).padStart(len - 1, '0');
    wr(off, len - 1, s); header[off + len - 1] = 0;
  };
  wr(0, 100, name);
  wo(100, 8, isDir ? 0o755 : 0o644);
  wo(108, 8, 0); wo(116, 8, 0);
  wo(124, 12, size);
  wo(136, 12, Math.floor(Date.now() / 1000));
  for (let i = 148; i < 156; i++) header[i] = 32;
  header[156] = isDir ? 53 : 48; // '5'=dir, '0'=file
  wr(257, 6, 'ustar'); wr(263, 2, '00');
  let sum = 0; for (let i = 0; i < 512; i++) sum += header[i];
  const cs = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) header[148 + i] = cs.charCodeAt(i);
  header[154] = 0; header[155] = 32;
  return header;
}

function buildTar(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const now = Math.floor(Date.now() / 1000);
  void now; // used inside makeTarHeader via closure

  // Collect unique parent directories, sorted shallow→deep
  const dirs = new Set<string>();
  for (const { name } of files) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add('./' + parts.slice(0, i).join('/') + '/');
    }
  }

  // Root dir entry first, then subdirs
  blocks.push(makeTarHeader('./', 0, true));
  for (const dir of [...dirs].sort()) {
    blocks.push(makeTarHeader(dir, 0, true));
  }

  // File entries with ./ prefix
  for (const { name, data } of files) {
    blocks.push(makeTarHeader('./' + name, data.length, false));
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }

  blocks.push(new Uint8Array(1024)); // end-of-archive
  let len = 0; for (const b of blocks) len += b.length;
  const out = new Uint8Array(len);
  let off = 0; for (const b of blocks) { out.set(b, off); off += b.length; }
  return out;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  appName: string;
  inputsData: AppInputs | null;
  migratedStanzas: Map<string, string>;
  excludedStanzas: Map<string, string>;
  onClose: () => void;
  onMarkMigrated: (header: string, label: string) => void;
  onUnmarkMigrated: (header: string) => void;
  onMarkExcluded: (header: string, reason: string) => void;
  onUnmarkExcluded: (header: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InputsModal({
  appName, inputsData, migratedStanzas, excludedStanzas,
  onClose, onMarkMigrated, onUnmarkMigrated, onMarkExcluded, onUnmarkExcluded,
}: Props) {
  const hasDefault = !!inputsData?.default;
  const hasLocal   = !!inputsData?.local;
  const hasAny     = hasDefault || hasLocal;

  const [activeTab, setActiveTab] = useState<'default' | 'local'>(hasLocal ? 'local' : 'default');
  const [selectedStanza, setSelectedStanza] = useState<Stanza | null>(null);
  const [selectedHeaders, setSelectedHeaders] = useState<Set<string>>(new Set());
  const selectedHeadersRef = useRef<Set<string>>(new Set());

  const updateSelected = useCallback((updater: (prev: Set<string>) => Set<string>) => {
    setSelectedHeaders(prev => {
      const next = updater(prev);
      selectedHeadersRef.current = next;
      return next;
    });
  }, []);

  // Single-stanza actions
  const [showMigrateInput, setShowMigrateInput] = useState(false);
  const [migrateLabel, setMigrateLabel] = useState('Migrated');
  const [showExcludeInput, setShowExcludeInput] = useState(false);
  const [excludeInput, setExcludeInput] = useState('');

  // Bulk-exclude
  const [showBulkExclude, setShowBulkExclude] = useState(false);
  const [bulkExcludeInput, setBulkExcludeInput] = useState('');

  // Copy button (JSON preview)
  const [copied, setCopied] = useState(false);

  // Export modal
  const [exportOpen, setExportOpen] = useState(false);

  // Pack modal
  const [packModalOpen, setPackModalOpen] = useState(false);
  const [packDisplayName, setPackDisplayName] = useState('');
  const [packDescription, setPackDescription] = useState('');
  const [packOutput, setPackOutput] = useState('devnull');
  const [packError, setPackError] = useState('');
  const [packReady, setPackReady] = useState<{ dataUrl: string; filename: string } | null>(null);
  const [packCopied, setPackCopied] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'blocked' | 'error'>('idle');
  const [downloadErrorMsg, setDownloadErrorMsg] = useState('');

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Reset selection when tab changes
  useEffect(() => {
    setSelectedStanza(null);
    updateSelected(() => new Set());
    setShowExcludeInput(false);
    setShowMigrateInput(false);
  }, [activeTab, updateSelected]);

  // Close export modal when stanza changes
  useEffect(() => {
    if (selectedStanza) setExportOpen(false);
  }, [selectedStanza]);

  const activeContent = activeTab === 'default' ? inputsData?.default : inputsData?.local;
  const stanzas = useMemo(() => parseStanzas(activeContent ?? ''), [activeContent]);

  const exportJson = useMemo(
    () => selectedStanza ? buildFileSourceJson(selectedStanza, appName) : null,
    [selectedStanza, appName]
  );

const isMultiSelect = selectedHeaders.size > 1;

  // ── Stanza status helpers ─────────────────────────────────────────────────

  function stanzaStatus(s: Stanza) {
    const isMigrated    = migratedStanzas.has(s.header);
    const isExcluded    = excludedStanzas.has(s.header);
    const disabled      = getStanzaSetting(s, 'disabled');
    const interval      = getStanzaSetting(s, 'interval');
    const index         = getStanzaSetting(s, 'index') ?? '';
    const isDisabled    = disabled === '1' || disabled === 'true';
    const isIntervalNeg = interval === '-1';
    const isInternal    = index.startsWith('_');
    const isStream      = /udp|tcp/i.test(s.header);
    const isCriblLog    = /\/cribl\/(log|state)\//.test(s.header);
    const isCommented   = s.commentedOut;
    const isDefault     = s.header.trim().toLowerCase() === '[default]';
    const yellowState   = !isMigrated && (isDisabled || isIntervalNeg || isInternal || isStream || isCriblLog || isCommented || isDefault || isExcluded);

    let badge: string | null = null;
    if (isMigrated) {
      badge = `${migratedStanzas.get(s.header) ?? 'Migrated'} ✓`;
    } else if (isExcluded) {
      badge = `⚠ Do not migrate — ${excludedStanzas.get(s.header)}`;
    } else if (isDefault)     badge = '⚠ Do not migrate — Global Settings';
    else if (isCommented)     badge = '⚠ Do not migrate — Commented Out';
    else if (isCriblLog)      badge = '⚠ Do not migrate — Cribl Logs';
    else if (isStream)        badge = '⚠ Do not migrate — Cribl Stream Config';
    else if (isInternal)      badge = '⚠ Do not migrate — Splunk UF Internal';
    else if (isIntervalNeg)   badge = '⚠ Do not migrate — interval=-1';
    else if (isDisabled)      badge = '⚠ Do not migrate — disabled';

    return { isMigrated, yellowState, badge };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const panelOpen = selectedStanza !== null && !isMultiSelect;
  const bulkPanelOpen = isMultiSelect;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#0f0f18', border: '1px solid rgba(34,211,238,0.2)', borderRadius: '12px', width: '100%', maxWidth: panelOpen || bulkPanelOpen ? '1100px' : '780px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 0 60px rgba(34,211,238,0.08), 0 24px 60px rgba(0,0,0,0.6)', animation: 'modalIn 0.2s ease', transition: 'max-width 0.25s ease' }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginBottom: '16px', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>inputs.conf</div>
              <div style={{ fontSize: '16px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff' }}>{appName}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
              <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.35)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                Click a stanza to inspect its config and mark it as <span style={{ color: 'rgba(74,222,128,0.7)' }}>Migrated</span> or <span style={{ color: 'rgba(250,204,21,0.7)' }}>Do Not Migrate</span>
              </span>
              <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.2)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                Ctrl/⌘+Click to multi-select · then use <span style={{ color: 'rgba(250,204,21,0.6)' }}>Bulk Action</span> to mark as Do Not Migrate or <span style={{ color: 'rgba(34,211,238,0.6)' }}>Migrate to Pack</span> to export
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' }}>
              {(selectedStanza || selectedHeaders.size > 0) && (
                <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.35)' }}>
                  {isMultiSelect
                    ? <>{selectedHeaders.size} selected · <span style={{ color: '#22d3ee', cursor: 'pointer' }} onClick={() => { setSelectedStanza(null); updateSelected(() => new Set()); }}>deselect all</span></>
                    : <>click another stanza to switch · <span style={{ color: '#22d3ee', cursor: 'pointer' }} onClick={() => { setSelectedStanza(null); updateSelected(() => new Set()); }}>deselect</span></>}
                </span>
              )}
              <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: '14px', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
            </div>
          </div>

          {/* Tabs */}
          {hasAny && (
            <div style={{ display: 'flex', gap: '4px' }}>
              {(['default', 'local'] as const).map(tab => {
                const exists = tab === 'default' ? hasDefault : hasLocal;
                if (!exists) return null;
                const active = activeTab === tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    style={{ padding: '7px 16px', borderRadius: '6px 6px 0 0', border: '1px solid', borderBottom: active ? '1px solid #0f0f18' : '1px solid rgba(255,255,255,0.08)', borderColor: active ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.08)', background: active ? 'rgba(34,211,238,0.08)' : 'transparent', color: active ? '#22d3ee' : 'rgba(255,255,255,0.4)', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '-1px', position: 'relative', zIndex: 1 }}
                  >
                    /{tab}/inputs.conf
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Stanza list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
            {!hasAny ? (
              <div style={{ textAlign: 'center', padding: '48px 0', color: 'rgba(255,255,255,0.25)', fontFamily: "'JetBrains Mono', monospace", fontSize: '13px' }}>
                <div style={{ fontSize: '28px', marginBottom: '12px', opacity: 0.3 }}>∅</div>
                No inputs.conf found for <span style={{ color: 'rgba(255,255,255,0.5)' }}>{appName}</span>
              </div>
            ) : stanzas.length === 0 ? (
              <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', lineHeight: '1.7', color: '#c8d3f5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{activeContent}</pre>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {!selectedStanza && selectedHeaders.size === 0 && (
                  <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Click a stanza to inspect · Ctrl/⌘+Click to multi-select
                  </div>
                )}
                {stanzas.map((stanza, i) => {
                  const { isMigrated, yellowState, badge } = stanzaStatus(stanza);
                  const isSelected = selectedStanza === stanza || selectedHeaders.has(stanza.header);

                  const borderColor = isMigrated ? 'rgba(74,222,128,0.4)'  : yellowState ? 'rgba(250,204,21,0.35)' : isSelected ? 'rgba(34,211,238,0.4)' : 'rgba(255,255,255,0.07)';
                  const bgColor     = isMigrated ? 'rgba(74,222,128,0.05)' : yellowState ? 'rgba(250,204,21,0.04)' : isSelected ? 'rgba(34,211,238,0.06)' : 'rgba(255,255,255,0.02)';
                  const headerBg    = isMigrated ? 'rgba(74,222,128,0.08)' : yellowState ? 'rgba(250,204,21,0.07)' : isSelected ? 'rgba(34,211,238,0.08)' : 'rgba(255,255,255,0.03)';
                  const headerBorder= isMigrated ? 'rgba(74,222,128,0.2)'  : yellowState ? 'rgba(250,204,21,0.15)' : isSelected ? 'rgba(34,211,238,0.2)'  : 'rgba(255,255,255,0.05)';
                  const titleColor  = isMigrated ? '#4ade80' : yellowState ? '#facc15' : isSelected ? '#22d3ee' : '#e8e8ff';
                  const badgeColor  = isMigrated ? '#4ade80' : '#facc15';

                  return (
                    <div
                      key={i}
                      onClick={e => {
                        if (e.metaKey || e.ctrlKey) {
                          e.preventDefault();
                          updateSelected(prev => {
                            const next = new Set(prev);
                            if (next.has(stanza.header)) {
                              next.delete(stanza.header);
                              if (selectedStanza === stanza) setSelectedStanza(null);
                            } else {
                              next.add(stanza.header);
                              setSelectedStanza(stanza);
                            }
                            return next;
                          });
                        } else {
                          updateSelected(() => new Set());
                          setSelectedStanza(isSelected && selectedHeaders.size === 0 ? null : stanza);
                          setShowMigrateInput(false);
                          setShowExcludeInput(false);
                        }
                      }}
                      style={{ borderRadius: '6px', border: `1px solid ${borderColor}`, background: bgColor, cursor: 'pointer', overflow: 'hidden', transition: 'all 0.15s', userSelect: 'none' }}
                    >
                      {/* Stanza header row */}
                      <div style={{ padding: '8px 14px', background: headerBg, borderBottom: `1px solid ${headerBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '12px', fontWeight: '700', color: titleColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stanza.header}</span>
                        {badge && (
                          <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: badgeColor, textTransform: 'uppercase', letterSpacing: '0.08em', whiteSpace: 'nowrap', flexShrink: 0 }}>{badge}</span>
                        )}
                        {!badge && isSelected && (
                          <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>selected ✓</span>
                        )}
                      </div>
                      {/* Settings rows */}
                      {stanza.settings.length > 0 && (
                        <div style={{ padding: '8px 14px' }}>
                          {stanza.settings.map((line, j) => {
                            const eqIdx = line.indexOf('=');
                            const key = eqIdx !== -1 ? line.slice(0, eqIdx).trim() : line;
                            const val = eqIdx !== -1 ? line.slice(eqIdx + 1).trim() : '';
                            return (
                              <div key={j} style={{ display: 'flex', gap: '8px', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', lineHeight: '1.8' }}>
                                <span style={{ color: 'rgba(167,139,250,0.8)', minWidth: '160px', flexShrink: 0 }}>{key}</span>
                                {eqIdx !== -1 && <span style={{ color: 'rgba(255,255,255,0.2)' }}>=</span>}
                                <span style={{ color: '#c8d3f5' }}>{val}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Single-select right panel */}
          {panelOpen && selectedStanza && (
            <div style={{ width: '340px', borderLeft: '1px solid rgba(34,211,238,0.15)', display: 'flex', flexDirection: 'column', flexShrink: 0, animation: 'slideIn 0.2s ease' }}>
              <div style={{ padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Cribl Export</div>
                  <div style={{ fontSize: '12px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', marginTop: '2px' }}>File Source Config</div>
                </div>

                {/* Mark as Migrated */}
                {migratedStanzas.has(selectedStanza.header) ? (
                  <div style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '7px', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '2px' }}>Migrated</div>
                      <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{migratedStanzas.get(selectedStanza.header)}</div>
                    </div>
                    <button onClick={() => onUnmarkMigrated(selectedStanza.header)} style={{ background: 'none', border: 'none', color: 'rgba(74,222,128,0.5)', cursor: 'pointer', fontSize: '13px', flexShrink: 0 }}>✕</button>
                  </div>
                ) : showMigrateInput ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <input
                      autoFocus
                      value={migrateLabel}
                      onChange={e => setMigrateLabel(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && migrateLabel.trim()) {
                          onMarkMigrated(selectedStanza.header, migrateLabel.trim());
                          setShowMigrateInput(false);
                        }
                        if (e.key === 'Escape') setShowMigrateInput(false);
                      }}
                      placeholder="Migration label..."
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(74,222,128,0.35)', borderRadius: '7px', padding: '7px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none' }}
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => { if (migrateLabel.trim()) { onMarkMigrated(selectedStanza.header, migrateLabel.trim()); setShowMigrateInput(false); } }} style={{ flex: 1, background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '6px', padding: '6px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', cursor: 'pointer' }}>✓ Confirm</button>
                      <button onClick={() => setShowMigrateInput(false)} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowMigrateInput(true); setShowExcludeInput(false); }}
                    style={{ width: '100%', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.2)', borderRadius: '7px', padding: '7px 12px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.7)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left', transition: 'background 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(74,222,128,0.12)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(74,222,128,0.06)'; }}
                  >
                    ✓ Mark as Migrated
                  </button>
                )}

                {/* Mark as Do Not Migrate */}
                {excludedStanzas.has(selectedStanza.header) ? (
                  <div style={{ background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.25)', borderRadius: '7px', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(250,204,21,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '2px' }}>Do Not Migrate</div>
                      <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#facc15', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{excludedStanzas.get(selectedStanza.header)}</div>
                    </div>
                    <button onClick={() => onUnmarkExcluded(selectedStanza.header)} style={{ background: 'none', border: 'none', color: 'rgba(250,204,21,0.5)', cursor: 'pointer', fontSize: '13px', flexShrink: 0 }}>✕</button>
                  </div>
                ) : showExcludeInput ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <input
                      autoFocus
                      value={excludeInput}
                      onChange={e => setExcludeInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && excludeInput.trim()) {
                          onMarkExcluded(selectedStanza.header, excludeInput.trim());
                          setExcludeInput(''); setShowExcludeInput(false);
                        }
                        if (e.key === 'Escape') { setShowExcludeInput(false); setExcludeInput(''); }
                      }}
                      placeholder="Reason for skipping..."
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(250,204,21,0.35)', borderRadius: '7px', padding: '7px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none' }}
                    />
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => { if (excludeInput.trim()) { onMarkExcluded(selectedStanza.header, excludeInput.trim()); setExcludeInput(''); setShowExcludeInput(false); } }} style={{ flex: 1, background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.3)', borderRadius: '6px', padding: '6px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#facc15', cursor: 'pointer' }}>✓ Confirm</button>
                      <button onClick={() => { setShowExcludeInput(false); setExcludeInput(''); }} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowExcludeInput(true); setShowMigrateInput(false); }}
                    style={{ width: '100%', background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: '7px', padding: '7px 12px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(250,204,21,0.7)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left', transition: 'background 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(250,204,21,0.1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(250,204,21,0.06)'; }}
                  >
                    ⚠ Mark as Do Not Migrate
                  </button>
                )}

              {/* Export to Cribl button */}
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  onClick={() => setExportOpen(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '7px', padding: '7px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s', width: '100%' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.15)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.08)'; }}
                >
                  <span style={{ fontSize: '13px' }}>⬡</span>
                  Export to Cribl
                </button>
              </div>
              </div>

              {/* JSON preview */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Cribl File Source JSON</span>
                  <button
                    onClick={() => { if (exportJson) { copyToClipboard(exportJson).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } }}
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', padding: '3px 10px', fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: copied ? '#4ade80' : 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'color 0.2s' }}
                  >
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <pre style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', lineHeight: '1.7', color: '#c8d3f5', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                  {exportJson}
                </pre>
              </div>
            </div>
          )}

          {/* Multi-select panel */}
          {bulkPanelOpen && (
            <div style={{ width: '300px', borderLeft: '1px solid rgba(250,204,21,0.2)', display: 'flex', flexDirection: 'column', flexShrink: 0, animation: 'slideIn 0.2s ease', padding: '16px 18px', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(250,204,21,0.7)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Bulk Action</div>
                <div style={{ fontSize: '12px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', marginTop: '2px' }}>{selectedHeaders.size} Stanzas Selected</div>
                <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.3)', marginTop: '4px' }}>Ctrl/⌘+Click to add or remove</div>
              </div>

              {showBulkExclude ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    autoFocus
                    value={bulkExcludeInput}
                    onChange={e => setBulkExcludeInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && bulkExcludeInput.trim()) {
                        selectedHeadersRef.current.forEach(h => onMarkExcluded(h, bulkExcludeInput.trim()));
                        setBulkExcludeInput(''); setShowBulkExclude(false);
                        updateSelected(() => new Set()); setSelectedStanza(null);
                      }
                      if (e.key === 'Escape') { setShowBulkExclude(false); setBulkExcludeInput(''); }
                    }}
                    placeholder="Reason for all selected..."
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(250,204,21,0.35)', borderRadius: '7px', padding: '7px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none' }}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => { if (bulkExcludeInput.trim()) { selectedHeadersRef.current.forEach(h => onMarkExcluded(h, bulkExcludeInput.trim())); setBulkExcludeInput(''); setShowBulkExclude(false); updateSelected(() => new Set()); setSelectedStanza(null); } }} style={{ flex: 1, background: 'rgba(250,204,21,0.1)', border: '1px solid rgba(250,204,21,0.3)', borderRadius: '6px', padding: '6px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#facc15', cursor: 'pointer' }}>✓ Confirm</button>
                    <button onClick={() => { setShowBulkExclude(false); setBulkExcludeInput(''); }} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowBulkExclude(true)}
                  style={{ width: '100%', background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.2)', borderRadius: '7px', padding: '8px 12px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(250,204,21,0.7)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(250,204,21,0.1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(250,204,21,0.06)'; }}
                >
                  ⚠ Mark All as Do Not Migrate
                </button>
              )}

              <button
                onClick={() => { setPackDisplayName(''); setPackDescription(''); setPackOutput('devnull'); setPackError(''); setPackReady(null); setPackModalOpen(true); }}
                style={{ width: '100%', background: 'rgba(34,211,238,0.06)', border: '1px solid rgba(34,211,238,0.2)', borderRadius: '7px', padding: '8px 12px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.12)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.06)'; }}
              >
                ✦ Migrate to Pack
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Migrate to Pack modal */}
      {packModalOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPackModalOpen(false)}
        >
          <div
            style={{ background: '#0f0f18', border: '1px solid rgba(34,211,238,0.3)', borderRadius: '12px', width: '560px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.6)', overflow: 'hidden', animation: 'modalIn 0.18s ease' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ padding: '22px 28px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '4px' }}>inputs.yml</div>
                <div style={{ fontSize: '17px', fontWeight: '800', color: '#e8e8ff', letterSpacing: '-0.01em' }}>Export to Pack</div>
              </div>
              <button onClick={() => setPackModalOpen(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>✕</button>
            </div>

            {/* Fields */}
            <div style={{ padding: '22px 28px', display: 'flex', flexDirection: 'column', gap: '16px', flexShrink: 0 }}>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>
                  Display Name <span style={{ color: 'rgba(255,255,255,0.25)', textTransform: 'none', letterSpacing: 0, fontSize: '9px' }}>— package.json displayName</span>
                </label>
                <input
                  value={packDisplayName}
                  onChange={e => setPackDisplayName(e.target.value)}
                  placeholder="e.g. My Pack"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 12px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>
                  Name <span style={{ color: 'rgba(255,255,255,0.25)', textTransform: 'none', letterSpacing: 0, fontSize: '9px' }}>— package.json name (auto-generated)</span>
                </label>
                <input
                  value={packDisplayName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')}
                  readOnly
                  placeholder="auto-generated from display name"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '7px', padding: '9px 12px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', outline: 'none', boxSizing: 'border-box', cursor: 'default' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>Description</label>
                <input
                  value={packDescription}
                  onChange={e => setPackDescription(e.target.value)}
                  placeholder="Defined at <<<FLEET>>> Fleet"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 12px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '7px' }}>Output</label>
                <input
                  value={packOutput}
                  onChange={e => setPackOutput(e.target.value)}
                  placeholder="devnull"
                  style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 12px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none', boxSizing: 'border-box' }}
                  onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                />
              </div>
              <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.3)' }}>
                {selectedHeaders.size} stanza{selectedHeaders.size !== 1 ? 's' : ''} will be included in inputs.yml
              </div>
            </div>

            {/* Error */}
            {packError && (
              <div style={{ padding: '0 28px 12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#f87171' }}>
                ✕ {packError}
              </div>
            )}

            {/* Download-ready panel */}
            {packReady && (
              <div style={{ margin: '0 28px 16px', background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '8px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>✓ Pack ready — {packReady.filename}</div>

                {/* Direct download status */}
                {downloadStatus === 'blocked' && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: '6px', padding: '10px 12px' }}>
                    <span style={{ color: '#fb923c', fontSize: '12px', flexShrink: 0 }}>⚠</span>
                    <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(251,146,60,0.9)', lineHeight: '1.6' }}>{downloadErrorMsg}</span>
                  </div>
                )}
                {downloadStatus === 'error' && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: '6px', padding: '10px 12px' }}>
                    <span style={{ color: '#f87171', fontSize: '12px', flexShrink: 0 }}>✕</span>
                    <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(248,113,113,0.9)', lineHeight: '1.6' }}>{downloadErrorMsg}</span>
                  </div>
                )}

                <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', lineHeight: '1.6' }}>
                  Copy the URL below and paste it into your browser address bar to download.
                </div>
                <button
                  onClick={() => { copyToClipboard(packReady.dataUrl).then(() => { setPackCopied(true); setTimeout(() => setPackCopied(false), 2000); }); }}
                  style={{ background: packCopied ? 'rgba(74,222,128,0.1)' : 'rgba(34,211,238,0.08)', border: `1px solid ${packCopied ? 'rgba(74,222,128,0.35)' : 'rgba(34,211,238,0.3)'}`, borderRadius: '6px', padding: '9px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: packCopied ? '#4ade80' : '#22d3ee', cursor: 'pointer', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.2s' }}
                >
                  {packCopied ? '✓ Copied — paste in address bar to download' : '⎘ Copy Download URL'}
                </button>
              </div>
            )}

            {/* Footer */}
            <div style={{ padding: packReady ? '0 28px 22px' : '16px 28px 22px', display: 'flex', gap: '10px', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button
                onClick={() => setPackModalOpen(false)}
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 18px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
              >
                {packReady ? 'Done' : 'Cancel'}
              </button>
              {!packReady && (
                <button
                  onClick={async () => {
                    setPackError('');
                    try {
                      const result = await buildPackDataUrl(selectedHeaders, stanzas, packDisplayName, packDescription, packOutput);
                      setPackReady(result);
                      // Attempt direct download via blob URL
                      setDownloadStatus('idle');
                      setDownloadErrorMsg('');
                      try {
                        const blob = new Blob([result.tgzBytes.buffer.slice(0) as ArrayBuffer], { type: 'application/gzip' });
                        const blobUrl = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = blobUrl;
                        a.download = result.filename;
                        document.body.appendChild(a);
                        // Use window blur as a proxy for "download dialog opened"
                        let dialogOpened = false;
                        const onBlur = () => { dialogOpened = true; };
                        window.addEventListener('blur', onBlur);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => {
                          window.removeEventListener('blur', onBlur);
                          URL.revokeObjectURL(blobUrl);
                          if (!dialogOpened) {
                            setDownloadStatus('blocked');
                            setDownloadErrorMsg('Download was blocked — the app is running inside a sandboxed iframe that does not permit file downloads. Use "Copy Download URL" below instead.');
                          }
                        }, 800);
                      } catch (dlErr) {
                        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
                        setDownloadStatus('error');
                        setDownloadErrorMsg(`Download failed: ${msg}`);
                      }
                      [...selectedHeaders].forEach(h => onMarkMigrated(h, 'Migrated to Pack'));
                      updateSelected(() => new Set());
                      setSelectedStanza(null);
                    } catch (err) {
                      setPackError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  style={{ background: 'linear-gradient(135deg, rgba(34,211,238,0.15), rgba(34,211,238,0.08))', border: '1px solid rgba(34,211,238,0.45)', borderRadius: '7px', padding: '9px 22px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', cursor: 'pointer', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.08em' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(34,211,238,0.25), rgba(34,211,238,0.15))'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(34,211,238,0.15), rgba(34,211,238,0.08))'; }}
                >
                  ↓ Export .cribl Pack
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Export to Cribl modal */}
      {exportOpen && selectedStanza && (
        <ExportModal
          stanza={selectedStanza}
          appName={appName}
          onClose={() => setExportOpen(false)}
          onMarkMigrated={onMarkMigrated}
        />
      )}
    </div>
  );
}
