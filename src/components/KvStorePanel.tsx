import { useState, useCallback } from 'react';
import { kvListKeys, kvGetRaw, kvDelete } from '../lib/kv';

type Row = {
  key: string;
  status: number | null;
  raw: string | null;
  parsed: unknown;
  loading: boolean;
  error: string | null;
};

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function truncate(s: string, max = 140): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export default function KvStorePanel() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    setRows([]);
    setExpanded(null);
    try {
      const keys = await kvListKeys('');
      if (keys.length === 0) {
        setListError('kvListKeys returned 0 keys — the list endpoint may be affected by the proxy bug, or the store is empty.');
        return;
      }
      setRows(keys.map(k => ({ key: k, status: null, raw: null, parsed: undefined, loading: true, error: null })));
      await Promise.all(keys.map(async (key) => {
        try {
          const { status, text } = await kvGetRaw(key);
          const parsed = tryParse(text);
          setRows(prev => prev.map(r => r.key === key
            ? { ...r, status, raw: text, parsed, loading: false }
            : r));
        } catch (e) {
          setRows(prev => prev.map(r => r.key === key
            ? { ...r, loading: false, error: String(e) }
            : r));
        }
      }));
    } catch (e) {
      setListError(String(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  const handleDelete = useCallback(async (key: string) => {
    try {
      await kvDelete(key);
      setRows(prev => prev.filter(r => r.key !== key));
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }, []);

  const statusColor = (s: number | null) => {
    if (s === null) return 'rgba(255,255,255,0.25)';
    if (s === 200) return '#4ade80';
    if (s === 404) return '#fb923c';
    return '#f87171';
  };

  return (
    <>
      {/* KV debug button — set display to 'block' to re-enable for troubleshooting */}
      <button
        onClick={() => { setOpen(v => !v); if (!open) load(); }}
        style={{
          display: 'none',
          position: 'fixed', bottom: '20px', left: '20px', zIndex: 9998,
          background: 'rgba(15,15,25,0.92)', border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '7px', padding: '6px 14px', fontSize: '10px',
          fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.45)',
          cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em',
          backdropFilter: 'blur(6px)',
        }}
      >
        kvstore
      </button>

      {open && (
        <div style={{
          position: 'fixed', bottom: '60px', left: '20px', zIndex: 9999,
          width: '820px', maxHeight: '72vh',
          background: '#0c0c18', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '12px', boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
          }}>
            <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              KV Store · {rows.length} key{rows.length !== 1 ? 's' : ''}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={load} disabled={listLoading} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', padding: '4px 12px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {listLoading ? 'Loading…' : '↺ Refresh'}
              </button>
              <button onClick={() => setOpen(false)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', padding: '4px 10px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}>
                ✕
              </button>
            </div>
          </div>

          {/* Body */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {listError && (
              <div style={{ padding: '16px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(248,113,113,0.85)', lineHeight: '1.6' }}>
                {listError}
              </div>
            )}
            {!listError && rows.length === 0 && !listLoading && (
              <div style={{ padding: '24px', textAlign: 'center', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.25)' }}>No keys</div>
            )}
            {rows.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                    <th style={{ padding: '7px 14px', textAlign: 'left', color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.08em', width: '36px' }}>St</th>
                    <th style={{ padding: '7px 14px', textAlign: 'left', color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.08em', width: '220px' }}>Key</th>
                    <th style={{ padding: '7px 14px', textAlign: 'left', color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Raw response body</th>
                    <th style={{ padding: '7px 14px', width: '54px' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <>
                      <tr
                        key={row.key}
                        onClick={() => setExpanded(expanded === row.key ? null : row.key)}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', background: expanded === row.key ? 'rgba(34,211,238,0.04)' : 'transparent' }}
                      >
                        {/* Status */}
                        <td style={{ padding: '8px 14px', verticalAlign: 'top', color: statusColor(row.status), fontWeight: 600, fontSize: '10px' }}>
                          {row.loading ? '…' : row.status ?? '—'}
                        </td>
                        {/* Key */}
                        <td style={{ padding: '8px 14px', color: '#22d3ee', wordBreak: 'break-all', verticalAlign: 'top' }}>
                          {row.key}
                        </td>
                        {/* Raw body */}
                        <td style={{ padding: '8px 14px', color: row.error ? '#f87171' : 'rgba(200,211,245,0.75)', verticalAlign: 'top', wordBreak: 'break-all' }}>
                          {row.loading
                            ? <span style={{ color: 'rgba(255,255,255,0.2)' }}>loading…</span>
                            : row.error
                              ? row.error
                              : truncate(row.raw ?? '')}
                        </td>
                        {/* Delete */}
                        <td style={{ padding: '8px 14px', textAlign: 'right', verticalAlign: 'top' }}>
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(row.key); }}
                            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '4px', padding: '2px 8px', fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(248,113,113,0.7)', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }}
                          >
                            del
                          </button>
                        </td>
                      </tr>
                      {expanded === row.key && !row.loading && !row.error && (
                        <tr key={`${row.key}-exp`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: 'rgba(34,211,238,0.03)' }}>
                          <td colSpan={4} style={{ padding: '0 14px 12px 14px' }}>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                              {row.parsed !== undefined ? 'parsed JSON' : 'raw (not valid JSON)'}
                            </div>
                            <pre style={{ margin: 0, fontSize: '10px', color: 'rgba(200,211,245,0.85)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '1.6', maxHeight: '260px', overflowY: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', padding: '10px 12px' }}>
                              {row.parsed !== undefined
                                ? JSON.stringify(row.parsed, null, 2)
                                : row.raw}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
