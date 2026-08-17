import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { loadProfiles } from '../lib/profiles';
import { extractInputs } from '../lib/parseArchive';
import { parseServerclassConf } from '../lib/parseServerclass';
import type { ServerclassMap } from '../lib/parseServerclass';
import { kvGet, kvPut, kvDelete } from '../lib/kv';
import type { Profile, InputsMap, AppInputs, Stanza } from '../types';
import InputsModal from '../components/InputsModal';

// ── KV keys ───────────────────────────────────────────────────────────────────

const inputsKey      = (id: string) => `profile/${id}/inputs`;
const serverclassKey = (id: string) => `profile/${id}/serverclass`;
const migratedKey    = (id: string) => `profile/${id}/migrated`;
const excludedKey    = (id: string) => `profile/${id}/excluded`;

// ── In-memory session cache ───────────────────────────────────────────────────
// Avoids redundant KV round-trips during SPA navigation. KV is the primary
// persistent store; this cache is populated on first load and kept in sync.

interface ProfileCache {
  serverclassMap: ServerclassMap;
  inputsMap: InputsMap;
  migratedStanzas: Map<string, string>;
  excludedStanzas: Map<string, string>;
}
const sessionCache = new Map<string, ProfileCache>();

// ── Stanza parser ─────────────────────────────────────────────────────────────

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

function getSetting(s: Stanza, key: string): string | null {
  const line = s.settings.find(l => l.split('=')[0].trim().toLowerCase() === key);
  return line ? line.slice(line.indexOf('=') + 1).trim().toLowerCase().replace(/^"|"$/g, '') : null;
}

function isActionable(s: Stanza): boolean {
  return /^\[(monitor:\/\/|batch:\/\/|WinEventLog:|script:)/i.test(s.header);
}

function isStanzaFiltered(s: Stanza): boolean {
  const disabled = getSetting(s, 'disabled');
  const interval = getSetting(s, 'interval');
  const index = getSetting(s, 'index') ?? '';
  return (
    disabled === '1' || disabled === 'true' ||
    interval === '-1' ||
    index.startsWith('_') ||
    /udp|tcp/i.test(s.header) ||
    /\/cribl\/(log|state)\//.test(s.header) ||
    s.commentedOut
  );
}

// ── Stat calculators ──────────────────────────────────────────────────────────

function countEnabledStanzas(apps: string[], inputsMap: InputsMap): number {
  let count = 0;
  for (const app of apps) {
    if (!inputsMap[app]) continue;
    const text = (inputsMap[app].default ?? '') + '\n' + (inputsMap[app].local ?? '');
    for (const s of parseStanzas(text)) {
      if (isActionable(s) && !isStanzaFiltered(s)) count++;
    }
  }
  return count;
}

interface MonitorStats {
  totalMonitorStanzas: number;
  linuxMonitorStanzas: number;
  windowsMonitorStanzas: number;
  totalScriptStanzas: number;
  allMonitorPaths: Set<string>;
}

function computeMonitorStats(inputsMap: InputsMap): MonitorStats {
  const linux = new Set<string>();
  const windows = new Set<string>();
  const scripts = new Set<string>();

  for (const appData of Object.values(inputsMap)) {
    for (const content of [appData.default, appData.local]) {
      if (!content) continue;
      let curPath: string | null = null;
      let curType: 'monitor' | 'script' | null = null;
      let curDisabled = false;
      let curIndex: string | null = null;
      let curInterval: string | null = null;

      const flush = () => {
        if (!curPath || !curType) return;
        const isInternal = curIndex?.startsWith('_') ?? false;
        const isStream = /udp|tcp/i.test(curPath);
        const isCriblLog = /\/cribl\/(log|state)\//.test(curPath);
        if (!curDisabled && !isInternal && !isStream && !isCriblLog && curInterval !== '-1') {
          if (curType === 'monitor') {
            if (curPath.startsWith('/')) linux.add(curPath); else windows.add(curPath);
          } else {
            scripts.add(curPath);
          }
        }
      };

      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const monM = line.match(/^\[(monitor|batch):\/\/(.+)\]$|^\[WinEventLog:(.+)\]$/i);
        const scriptM = line.match(/^\[script:\/\/(.+)\]$|^\[script:(.+)\]$/i);
        if (monM) {
          flush();
          curPath = (monM[2] ?? monM[3] ?? '').trim();
          curType = 'monitor'; curDisabled = false; curIndex = null; curInterval = null;
        } else if (scriptM) {
          flush();
          curPath = (scriptM[1] ?? scriptM[2] ?? '').trim();
          curType = 'script'; curDisabled = false; curIndex = null; curInterval = null;
        } else if (line.startsWith('[')) {
          flush();
          curPath = null; curType = null; curDisabled = false; curIndex = null; curInterval = null;
        } else if (curPath && line.includes('=')) {
          const k = line.slice(0, line.indexOf('=')).trim().toLowerCase();
          const v = line.slice(line.indexOf('=') + 1).trim().toLowerCase().replace(/^"|"$/g, '');
          if (k === 'disabled' && (v === '1' || v === 'true')) curDisabled = true;
          if (k === 'index') curIndex = v;
          if (k === 'interval') curInterval = v;
        }
      }
      flush();
    }
  }

  const allMonitorPaths = new Set<string>([...linux, ...windows]);
  return {
    totalMonitorStanzas: allMonitorPaths.size,
    linuxMonitorStanzas: linux.size,
    windowsMonitorStanzas: windows.size,
    totalScriptStanzas: scripts.size,
    allMonitorPaths,
  };
}

// ── Monitor Path List dropdown ────────────────────────────────────────────────

function MonitorPathList({ allMonitorPaths, migratedStanzas, inputsMap }: {
  allMonitorPaths: Set<string>;
  migratedStanzas: Map<string, string>;
  inputsMap: InputsMap;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  const pathToApps = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const [appName, appData] of Object.entries(inputsMap)) {
      for (const content of [appData.default, appData.local]) {
        if (!content) continue;
        let curPath: string | null = null;
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          const m = line.match(/^\[(monitor|batch):\/\/(.+)\]$|^\[WinEventLog:(.+)\]$/i);
          if (m) { curPath = (m[2] ?? m[3] ?? '').trim(); }
          else if (line.startsWith('[')) { curPath = null; }
          if (curPath && allMonitorPaths.has(curPath)) {
            if (!map[curPath]) map[curPath] = new Set();
            map[curPath].add(appName);
          }
        }
      }
    }
    return map;
  }, [inputsMap, allMonitorPaths]);

  const paths = useMemo(() => {
    const arr = [...allMonitorPaths].sort();
    if (!filter) return arr;
    return arr.filter(p => p.toLowerCase().includes(filter.toLowerCase()));
  }, [allMonitorPaths, filter]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '6px 12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s' }}
      >
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'none', fontSize: '9px' }}>▶</span>
        View All Paths ({allMonitorPaths.size})
      </button>

      {open && (
        <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 50, width: '640px', background: '#0f0f18', border: '1px solid rgba(251,146,60,0.2)', borderRadius: '10px', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Unique Monitor Paths · {paths.length}{filter ? ` of ${allMonitorPaths.size}` : ''}
            </span>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter paths..."
              onClick={e => e.stopPropagation()}
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', padding: '4px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none', width: '160px' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr 180px 70px', gap: '10px', padding: '5px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span />
            <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Path</span>
            <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>App</span>
            <span />
          </div>
          <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
            {paths.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)' }}>No paths match "{filter}"</div>
            ) : paths.map((path, i) => {
              const migratedLabel =
                migratedStanzas.get(`[monitor://${path}]`) ??
                migratedStanzas.get(`[batch://${path}]`) ??
                migratedStanzas.get(`[WinEventLog:${path}]`) ?? null;
              const isMigrated = !!migratedLabel;
              const isLinux = path.startsWith('/');
              const apps = pathToApps[path] ? [...pathToApps[path]] : [];
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '16px 1fr 180px auto', gap: '10px', alignItems: 'center', padding: '7px 14px', borderBottom: '1px solid rgba(255,255,255,0.03)', background: isMigrated ? 'rgba(74,222,128,0.04)' : 'transparent' }}>
                  <span style={{ fontSize: '9px', color: isLinux ? '#facc15' : '#60a5fa' }}>●</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: isMigrated ? '#4ade80' : '#c8d3f5', wordBreak: 'break-all' }}>{path}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: 'rgba(167,139,250,0.8)', wordBreak: 'break-all' }}>{apps.join(', ') || '—'}</span>
                  {isMigrated
                    ? <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>✓ {migratedLabel}</span>
                    : <span />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sticky Header ─────────────────────────────────────────────────────────────

function Header({
  profile, totalServerclasses, totalApps, totalTaApps, totalCustomApps,
  totalMonitorStanzas, linuxMonitorStanzas, windowsMonitorStanzas, totalScriptStanzas,
  migratedStanzas, excludedStanzas, allMonitorPaths, inputsMap, onBack,
}: {
  profile: Profile | null;
  totalServerclasses: number;
  totalApps: number;
  totalTaApps: number;
  totalCustomApps: number;
  totalMonitorStanzas: number;
  linuxMonitorStanzas: number;
  windowsMonitorStanzas: number;
  totalScriptStanzas: number;
  migratedStanzas: Map<string, string>;
  excludedStanzas: Map<string, string>;
  allMonitorPaths: Set<string>;
  inputsMap: InputsMap;
  onBack: () => void;
}) {
  // Paths explicitly marked Do Not Migrate should be removed from the denominator
  const excludedPathCount = useMemo(() => {
    let count = 0;
    for (const path of allMonitorPaths) {
      if (
        excludedStanzas.has(`[monitor://${path}]`) ||
        excludedStanzas.has(`[batch://${path}]`) ||
        excludedStanzas.has(`[WinEventLog:${path}]`)
      ) count++;
    }
    return count;
  }, [allMonitorPaths, excludedStanzas]);

  const effectiveTotal = totalMonitorStanzas - excludedPathCount;
  // Only count migrated stanzas that haven't also been excluded
  const migratedCount = useMemo(
    () => [...migratedStanzas.keys()].filter(h => !excludedStanzas.has(h)).length,
    [migratedStanzas, excludedStanzas],
  );
  const migrationPct = effectiveTotal > 0 ? Math.round((migratedCount / effectiveTotal) * 100) : 0;

  const stats = [
    { label: 'Serverclasses',    value: totalServerclasses,    color: '#22d3ee',  border: null },
    { label: 'Enabled Apps',     value: totalApps,             color: '#22d3ee',  border: null },
    { label: 'TA / Splunk_TA Apps', value: totalTaApps,        color: '#a78bfa',  border: 'rgba(167,139,250,0.2)' },
    { label: 'Custom Apps',      value: totalCustomApps,       color: '#a78bfa',  border: 'rgba(167,139,250,0.2)' },
    { label: 'Monitor Stanzas',  value: totalMonitorStanzas,   color: '#fb923c',  border: 'rgba(251,146,60,0.2)' },
    { label: 'Script Stanzas',   value: totalScriptStanzas,    color: '#fb923c',  border: 'rgba(251,146,60,0.2)' },
    { label: 'Linux Monitors',   value: linuxMonitorStanzas,   color: '#60a5fa',  border: 'rgba(96,165,250,0.2)' },
    { label: 'Windows Monitors', value: windowsMonitorStanzas, color: '#60a5fa',  border: 'rgba(96,165,250,0.2)' },
  ];

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'sticky', top: 0, background: 'rgba(10,10,15,0.95)', backdropFilter: 'blur(12px)', zIndex: 10 }}>

      {/* Row 1 — title left, stats right */}
      <div style={{ padding: '28px 40px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px' }}>

        {/* Left: back + labels + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
          <button
            onClick={onBack}
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '7px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'color 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.color = '#e8e8ff'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; }}
          >
            ← Back
          </button>
          <div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 10px #22d3ee', flexShrink: 0 }} />
                <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Cribl</span>
              </div>
              {profile && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#a78bfa', boxShadow: '0 0 10px #a78bfa', flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#a78bfa', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                    {profile.name}{profile.org ? ` · ${profile.org}` : ''}
                  </span>
                </div>
              )}
            </div>
            <h1 style={{ fontSize: '22px', fontWeight: '800', letterSpacing: '-0.02em', margin: 0, color: '#e8e8ff' }}>UF to Edge Migrator</h1>
          </div>
        </div>

        {/* Right: stat numbers */}
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {stats.map(({ label, value, color, border }) => (
            <div key={label} style={{ textAlign: 'right', ...(border ? { paddingLeft: '24px', borderLeft: `1px solid ${border}` } : {}) }}>
              <div style={{ fontSize: '22px', fontWeight: '800', color, lineHeight: 1 }}>{value}</div>
              <div style={{ fontSize: '10px', color: color + '99', fontFamily: "'JetBrains Mono', monospace", marginTop: '3px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Row 2 — Migration progress */}
      {totalMonitorStanzas > 0 && effectiveTotal >= 0 && (
        <div style={{ padding: '10px 40px 14px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '28px', flexWrap: 'wrap' }}>

            {/* Migrated count */}
            <div style={{ textAlign: 'left' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '20px', fontWeight: '800', color: '#fb923c', lineHeight: 1 }}>{migratedCount}</span>
                <span style={{ fontSize: '12px', color: 'rgba(251,146,60,0.5)', fontFamily: "'JetBrains Mono', monospace" }}>/ {effectiveTotal}</span>
              </div>
              <div style={{ fontSize: '10px', color: 'rgba(251,146,60,0.6)', fontFamily: "'JetBrains Mono', monospace", marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Monitors Migrated</div>
            </div>

            {/* Progress bar */}
            <div style={{ width: '220px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Migration Progress</span>
                <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: migrationPct === 100 ? '#22d3ee' : '#fb923c' }}>{migrationPct}%</span>
              </div>
              <div style={{ height: '5px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${migrationPct}%`, borderRadius: '99px', background: migrationPct === 100 ? '#22d3ee' : 'linear-gradient(90deg, #fb923c, #fbbf24)', transition: 'width 0.4s ease', boxShadow: migrationPct > 0 ? '0 0 8px rgba(251,146,60,0.5)' : 'none' }} />
              </div>
            </div>

            {/* View All Paths dropdown */}
            <MonitorPathList allMonitorPaths={allMonitorPaths} migratedStanzas={migratedStanzas} inputsMap={inputsMap} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── isAppDone ─────────────────────────────────────────────────────────────────

function isAppDone(appName: string, inputsMap: InputsMap, migratedStanzas: Map<string, string>, excludedStanzas: Map<string, string>): boolean {
  if (!inputsMap[appName]) return false;
  const stanzas = parseStanzas((inputsMap[appName].default ?? '') + '\n' + (inputsMap[appName].local ?? ''));
  const actionable = stanzas.filter(s =>
    /^\[(monitor:\/\/|batch:\/\/|WinEventLog:|script:)/i.test(s.header) ||
    /udp|tcp/i.test(s.header) ||
    /\/cribl\/(log|state)\//.test(s.header)
  );
  if (actionable.length === 0) return false;
  return actionable.every(s => {
    const disabled = getSetting(s, 'disabled');
    const interval = getSetting(s, 'interval');
    const index = getSetting(s, 'index') ?? '';
    const isDisabled = disabled === '1' || disabled === 'true' || interval === '-1';
    const isInternal = index.startsWith('_');
    const isStream = /udp|tcp/i.test(s.header);
    const isCriblLog = /\/cribl\/(log|state)\//.test(s.header);
    return isDisabled || isInternal || isStream || isCriblLog || s.commentedOut || excludedStanzas.has(s.header) || migratedStanzas.has(s.header);
  });
}

// ── AppTag ────────────────────────────────────────────────────────────────────

function AppTag({ name, hasInputs, done, onClick }: { name: string; hasInputs: boolean; done: boolean; onClick?: () => void }) {
  const [hovered, setHovered] = useState(false);
  const clickable = hasInputs && !!onClick;

  const color     = done ? '#4ade80' : hasInputs ? '#22d3ee' : 'rgba(255,255,255,0.35)';
  const bgBase    = done ? 'rgba(74,222,128,0.07)'  : hasInputs ? 'rgba(34,211,238,0.07)'  : 'rgba(255,255,255,0.03)';
  const bgHover   = done ? 'rgba(74,222,128,0.15)'  : hasInputs ? 'rgba(34,211,238,0.14)'  : 'rgba(255,255,255,0.07)';
  const bdrBase   = done ? 'rgba(74,222,128,0.35)'  : hasInputs ? 'rgba(34,211,238,0.22)'  : 'rgba(255,255,255,0.1)';
  const bdrHover  = done ? 'rgba(74,222,128,0.6)'   : hasInputs ? 'rgba(34,211,238,0.45)'  : 'rgba(255,255,255,0.18)';

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={clickable ? onClick : undefined}
      title={done ? 'All monitors migrated or excluded' : hasInputs ? 'Click to view inputs.conf' : 'No inputs.conf found'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: hovered ? bgHover : bgBase, border: `1px solid ${hovered ? bdrHover : bdrBase}`, borderRadius: '4px', padding: '3px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color, letterSpacing: '0.02em', whiteSpace: 'nowrap', cursor: clickable ? 'pointer' : 'default', transition: 'all 0.15s' }}
    >
      <span style={{ fontSize: '9px', opacity: 0.5 }}>▸</span>
      {name}
      {done && <span style={{ fontSize: '8px', color: '#4ade80', marginLeft: '2px' }}>✓</span>}
    </span>
  );
}

// ── ServerClassCard ───────────────────────────────────────────────────────────

function ServerClassCard({ name, apps, index, inputsMap, migratedStanzas, excludedStanzas, onAppClick }: { name: string; apps: string[]; index: number; inputsMap: InputsMap; migratedStanzas: Map<string, string>; excludedStanzas: Map<string, string>; onAppClick: (appName: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const visibleApps = expanded ? apps : apps.slice(0, 4);
  const hasMore = apps.length > 4;
  const enabledStanzas = countEnabledStanzas(apps, inputsMap);

  return (
    <div
      className="sc-card"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '16px 20px', animationDelay: `${index * 25}ms`, animationFillMode: 'both' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', fontWeight: '700', color: '#e8e8ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px', fontFamily: "'JetBrains Mono', monospace" }}>{apps.length} app{apps.length !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '20px', padding: '2px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>
          {enabledStanzas} stanza{enabledStanzas !== 1 ? 's' : ''} enabled
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {visibleApps.map(app => (
          <AppTag
            key={app}
            name={app}
            hasInputs={!!inputsMap[app]}
            done={isAppDone(app, inputsMap, migratedStanzas, excludedStanzas)}
            onClick={inputsMap[app] ? () => onAppClick(app) : undefined}
          />
        ))}
        {!expanded && hasMore && (
          <span onClick={() => setExpanded(true)} style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '4px', padding: '3px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>
            +{apps.length - 4} more
          </span>
        )}
        {expanded && hasMore && (
          <span onClick={() => setExpanded(false)} style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '4px', padding: '3px 10px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>
            show less
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

type Phase = 'loading' | 'processing' | 'ready' | 'error';

export default function ProfileView({ onDelete }: { onDelete?: (id: string) => Promise<void> }) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [serverclassMap, setServerclassMap] = useState<ServerclassMap>({});
  const [inputsMap, setInputsMap] = useState<InputsMap>({});
  const [migratedStanzas, setMigratedStanzas] = useState<Map<string, string>>(new Map());
  const [excludedStanzas, setExcludedStanzas] = useState<Map<string, string>>(new Map());
  const [modal, setModal] = useState<{ appName: string; inputsData: AppInputs } | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'apps' | 'stanzas'>('name');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

  const processAndSave = useCallback(async (profileId: string) => {
    const state = location.state as { archiveFile?: File; serverclassFile?: File } | null;
    const archiveFile: File | null = state?.archiveFile ?? null;
    const serverclassFile: File | null = state?.serverclassFile ?? null;
    const cached = sessionCache.get(profileId);

    // Record this as the active profile so a browser refresh restores it.
    kvPut('ufe_migrator/session', { id: profileId }).catch(() => {});

    // Load profile metadata
    const profiles = await loadProfiles();
    setProfile(profiles.find(p => p.id === profileId) ?? null);

    // ── Resolve serverclassMap ───────────────────────────────────────────────
    let sc: ServerclassMap;
    if (serverclassFile) {
      sc = parseServerclassConf(await serverclassFile.text());
      await kvPut<ServerclassMap>(serverclassKey(profileId), sc);
    } else {
      sc = cached?.serverclassMap ?? await kvGet<ServerclassMap>(serverclassKey(profileId)).catch(() => null) ?? {};
    }

    // ── Resolve migratedStanzas ───────────────────────────────────────────────
    let migrated: Map<string, string>;
    if (cached?.migratedStanzas) {
      migrated = cached.migratedStanzas;
    } else {
      const raw = await kvGet<Record<string, string>>(migratedKey(profileId)).catch(() => null);
      migrated = raw ? new Map(Object.entries(raw)) : new Map();
    }

    // ── Resolve excludedStanzas ───────────────────────────────────────────────
    let excluded: Map<string, string>;
    if (cached?.excludedStanzas) {
      excluded = cached.excludedStanzas;
    } else {
      const raw = await kvGet<Record<string, string>>(excludedKey(profileId)).catch(() => null);
      excluded = raw ? new Map(Object.entries(raw)) : new Map();
    }

    // ── Resolve inputsMap ────────────────────────────────────────────────────
    let inputs: InputsMap;
    if (archiveFile) {
      setPhase('processing');
      inputs = await extractInputs(archiveFile);
      await kvPut<InputsMap>(inputsKey(profileId), inputs);
    } else {
      inputs = cached?.inputsMap ?? await kvGet<InputsMap>(inputsKey(profileId)).catch(() => null) ?? {};
    }

    // ── Commit to cache and React state ──────────────────────────────────────
    sessionCache.set(profileId, { serverclassMap: sc, inputsMap: inputs, migratedStanzas: migrated, excludedStanzas: excluded });
    setServerclassMap(sc);
    setInputsMap(inputs);
    setMigratedStanzas(migrated);
    setExcludedStanzas(excluded);
    setPhase('ready');
  }, [location.state]);

  useEffect(() => {
    if (!id) { setError('No profile ID in URL'); setPhase('error'); return; }
    processAndSave(id).catch(e => {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    });
  }, [id, processAndSave]);

  // ── Derived stats ────────────────────────────────────────────────────────────

  const allApps = useMemo(() => new Set(Object.values(serverclassMap).flat()), [serverclassMap]);
  const appsWithInputs = useMemo(() => new Set([...allApps].filter(a => !!inputsMap[a])), [allApps, inputsMap]);
  const totalApps = appsWithInputs.size;
  const totalTaApps = useMemo(() => [...appsWithInputs].filter(a => a.startsWith('Splunk_TA') || a.startsWith('TA-') || a.startsWith('TA_')).length, [appsWithInputs]);
  const totalCustomApps = totalApps - totalTaApps;
  const monitorStats = useMemo(() => computeMonitorStats(inputsMap), [inputsMap]);

  const filteredEntries = useMemo(() => {
    let entries = Object.entries(serverclassMap)
      .map(([sc, apps]) => [sc, apps.filter(a => !!inputsMap[a])] as [string, string[]])
      .filter(([, apps]) => apps.length > 0);

    if (search) {
      let matcher: (s: string) => boolean;
      try {
        const re = new RegExp(search, 'i');
        matcher = s => re.test(s);
      } catch {
        const q = search.toLowerCase();
        matcher = s => s.toLowerCase().includes(q);
      }
      entries = entries.filter(([sc, apps]) => matcher(sc) || apps.some(a => matcher(a)));
    }

    if (sortBy === 'name') entries.sort((a, b) => a[0].localeCompare(b[0]));
    if (sortBy === 'apps') entries.sort((a, b) => b[1].length - a[1].length);
    if (sortBy === 'stanzas') entries.sort((a, b) =>
      countEnabledStanzas(b[1], inputsMap) - countEnabledStanzas(a[1], inputsMap)
    );

    return entries;
  }, [serverclassMap, inputsMap, search, sortBy]);

  const totalServerclasses = filteredEntries.length;

  // ── Modal handlers ───────────────────────────────────────────────────────────

  const handleAppClick = useCallback((appName: string) => {
    const inputsData = inputsMap[appName];
    if (inputsData) setModal({ appName, inputsData });
  }, [inputsMap]);

  const handleMarkMigrated = useCallback((header: string, label: string) => {
    if (!id) return;
    setMigratedStanzas(prev => {
      const next = new Map(prev);
      next.set(header, label);
      const obj = Object.fromEntries(next);
      kvPut<Record<string, string>>(migratedKey(id), obj).catch(() => {});
      const c = sessionCache.get(id);
      if (c) sessionCache.set(id, { ...c, migratedStanzas: next });
      return next;
    });
  }, [id]);

  const handleUnmarkMigrated = useCallback((header: string) => {
    if (!id) return;
    setMigratedStanzas(prev => {
      const next = new Map(prev);
      next.delete(header);
      const obj = Object.fromEntries(next);
      kvPut<Record<string, string>>(migratedKey(id), obj).catch(() => {});
      const c = sessionCache.get(id);
      if (c) sessionCache.set(id, { ...c, migratedStanzas: next });
      return next;
    });
  }, [id]);

  const handleMarkExcluded = useCallback((header: string, reason: string) => {
    if (!id) return;
    setExcludedStanzas(prev => {
      const next = new Map(prev);
      next.set(header, reason);
      const obj = Object.fromEntries(next);
      kvPut<Record<string, string>>(excludedKey(id), obj).catch(() => {});
      const c = sessionCache.get(id);
      if (c) sessionCache.set(id, { ...c, excludedStanzas: next });
      return next;
    });
  }, [id]);

  const handleDeleteProfile = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    const profileName = profile?.name ?? id;
    try {
      sessionCache.delete(id);
      if (onDelete) {
        await onDelete(id);
      }
      kvDelete('ufe_migrator/session').catch(() => {});
      setDeleteSuccess(profileName);
      setConfirmDelete(false);
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  }, [id, profile, onDelete]);

  const handleUnmarkExcluded = useCallback((header: string) => {
    if (!id) return;
    setExcludedStanzas(prev => {
      const next = new Map(prev);
      next.delete(header);
      const obj = Object.fromEntries(next);
      kvPut<Record<string, string>>(excludedKey(id), obj).catch(() => {});
      const c = sessionCache.get(id);
      if (c) sessionCache.set(id, { ...c, excludedStanzas: next });
      return next;
    });
  }, [id]);

  // ── Loading / error screens ──────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.8)', fontSize: '12px', padding: '40px', textAlign: 'center' }}>
        <div>
          <div style={{ marginBottom: '8px', color: 'rgba(255,100,100,0.5)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Error</div>
          {error}
          <div style={{ marginTop: '20px' }}>
            <button onClick={() => navigate('/')} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '8px 18px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>← Back</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'loading' || phase === 'processing') {
    const label = phase === 'processing' ? 'Extracting inputs.conf…' : 'Loading…';
    return (
      <div style={{ minHeight: '100svh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', gap: '16px' }}>
        <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
        <div style={{ width: '240px', height: '4px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: '99px', background: 'linear-gradient(90deg, transparent, #22d3ee, #67e8f9, #22d3ee, transparent)', backgroundSize: '300% 100%', animation: 'shimmer 1.2s linear infinite' }} />
        </div>
        <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      </div>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100svh', background: '#0a0a0f', fontFamily: "'Inter', sans-serif", color: '#e8e8ff', padding: '0 0 80px' }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .sc-card { animation: fadeUp 0.4s ease both; transition: border-color 0.2s, background 0.2s; }
        .sc-card:hover { border-color: rgba(34,211,238,0.15) !important; background: rgba(255,255,255,0.05) !important; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        input::placeholder { color: rgba(255,255,255,0.25); }
        button { outline: none; font-family: inherit; }
      `}</style>

      <Header
        profile={profile}
        totalServerclasses={totalServerclasses}
        totalApps={totalApps}
        totalTaApps={totalTaApps}
        totalCustomApps={totalCustomApps}
        totalMonitorStanzas={monitorStats.totalMonitorStanzas}
        linuxMonitorStanzas={monitorStats.linuxMonitorStanzas}
        windowsMonitorStanzas={monitorStats.windowsMonitorStanzas}
        totalScriptStanzas={monitorStats.totalScriptStanzas}
        migratedStanzas={migratedStanzas}
        excludedStanzas={excludedStanzas}
        allMonitorPaths={monitorStats.allMonitorPaths}
        inputsMap={inputsMap}
        onBack={() => navigate('/')}
      />

      {/* Controls */}
      <div style={{ padding: '20px 40px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search serverclasses or apps…"
          style={{ flex: 1, minWidth: '220px', maxWidth: '360px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '8px 14px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: '#e8e8ff', outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['name', 'apps', 'stanzas'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              style={{ background: sortBy === s ? 'rgba(34,211,238,0.12)' : 'rgba(255,255,255,0.04)', border: `1px solid ${sortBy === s ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.1)'}`, borderRadius: '6px', padding: '6px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: sortBy === s ? '#22d3ee' : 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'all 0.15s' }}
            >
              {s === 'name' ? 'Sort: A-Z' : s === 'apps' ? 'Sort: App Count' : 'Sort: Stanza Count'}
            </button>
          ))}
        </div>
        {filteredEntries.length > 0 && (
          <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)' }}>
            {filteredEntries.length} serverclass{filteredEntries.length !== 1 ? 'es' : ''}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          {deleteSuccess ? (
            /* ── Success state ── */
            <>
              <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.9)' }}>
                ✓ <strong>{deleteSuccess}</strong> deleted — all KV store data removed.
              </span>
              <button
                onClick={() => navigate('/')}
                style={{ background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.35)', borderRadius: '7px', padding: '6px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }}
              >
                ← Go Back
              </button>
            </>
          ) : confirmDelete ? (
            /* ── Confirm state ── */
            <>
              <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(248,113,113,0.8)' }}>Delete profile?</span>
              <button
                onClick={handleDeleteProfile}
                disabled={deleting}
                style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.5)', borderRadius: '7px', padding: '6px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#f87171', cursor: deleting ? 'default' : 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s' }}
              >
                {deleting ? 'Deleting…' : 'Yes, Delete'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '6px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }}
              >
                Cancel
              </button>
            </>
          ) : (
            /* ── Default state ── */
            <>
              <button
                onClick={() => setConfirmDelete(true)}
                style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '7px', padding: '6px 14px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(248,113,113,0.6)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.14)'; e.currentTarget.style.color = '#f87171'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.4)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.06)'; e.currentTarget.style.color = 'rgba(248,113,113,0.6)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.2)'; }}
              >
                Delete Current Migration
              </button>
              <button
                onClick={() => {
                  if (id) {
                    const migratedObj = Object.fromEntries(migratedStanzas);
                    const excludedObj = Object.fromEntries(excludedStanzas);
                    kvPut<Record<string, string>>(migratedKey(id), migratedObj).catch(() => {});
                    kvPut<Record<string, string>>(excludedKey(id), excludedObj).catch(() => {});
                  }
                  kvDelete('ufe_migrator/session').catch(() => {});
                  navigate('/');
                }}
                style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '8px', padding: '6px 16px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'inline-flex', alignItems: 'center', gap: '6px', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.16)'; e.currentTarget.style.borderColor = 'rgba(34,211,238,0.45)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.08)'; e.currentTarget.style.borderColor = 'rgba(34,211,238,0.25)'; }}
              >
                ✓ Exit
              </button>
            </>
          )}
        </div>
      </div>

      {/* Empty state */}
      {filteredEntries.length === 0 && (
        <div style={{ padding: '60px 40px', textAlign: 'center', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)' }}>
          {Object.keys(serverclassMap).length === 0
            ? 'No serverclass.conf loaded — go back and upload files to begin'
            : 'No matching serverclasses'}
        </div>
      )}

      {/* Grid */}
      {filteredEntries.length > 0 && (
        <div style={{ padding: '0 40px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px' }}>
          {filteredEntries.map(([sc, apps], i) => (
            <ServerClassCard key={sc} name={sc} apps={apps} index={i} inputsMap={inputsMap} migratedStanzas={migratedStanzas} excludedStanzas={excludedStanzas} onAppClick={handleAppClick} />
          ))}
        </div>
      )}

      {/* Inputs Modal */}
      {modal && (
        <InputsModal
          appName={modal.appName}
          inputsData={modal.inputsData}
          migratedStanzas={migratedStanzas}
          excludedStanzas={excludedStanzas}
          onClose={() => setModal(null)}
          onMarkMigrated={handleMarkMigrated}
          onUnmarkMigrated={handleUnmarkMigrated}
          onMarkExcluded={handleMarkExcluded}
          onUnmarkExcluded={handleUnmarkExcluded}
        />
      )}
    </div>
  );
}
