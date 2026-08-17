import { useState, useEffect, useRef, useCallback } from 'react';
import ProfileModal from '../components/ProfileModal';
import { kvExists } from '../lib/kv';
import type { Profile } from '../types';

interface Props {
  profiles: Profile[];
  loading: boolean;
  onSelect: (profile: Profile, archiveFile: File | null, serverclassFile: File | null) => void;
  onCreate: (fields: { name: string; org?: string; notes?: string }) => Promise<void>;
  onUpdate: (id: string, fields: { name: string; org?: string; notes?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export default function LandingPage({ profiles, loading, onSelect, onCreate, onUpdate, onDelete }: Props) {
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [modalSaving, setModalSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteSuccessName, setDeleteSuccessName] = useState<string | null>(null);

  // KV persistence status for the selected profile
  const [kvDataStatus, setKvDataStatus] = useState<'idle' | 'checking' | 'exists' | 'none'>('idle');

  // KV read/write diagnostic — disabled; restore imports + this block to re-enable
  // const [kvDiag, setKvDiag] = useState<KvDiagResult | null>(null);
  // useEffect(() => {
  //   kvDiagnostic().then(setKvDiag).catch(() => setKvDiag({ status: 'error', detail: 'Diagnostic threw unexpectedly' }));
  // }, []);

  // Archive upload state
  const [pendingArchive, setPendingArchive] = useState<File | null>(null);
  const [archiveReadPct, setArchiveReadPct] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // serverclass.conf upload state
  const [serverclassFile, setServerclassFile] = useState<File | null>(null);
  const [serverclassReadPct, setServerclassReadPct] = useState(0);
  const [serverclassError, setServerclassError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const serverclassInputRef = useRef<HTMLInputElement>(null);

  // Keep activeProfile in sync if profiles list changes (e.g. after edit)
  useEffect(() => {
    if (activeProfile) {
      const updated = profiles.find(p => p.id === activeProfile.id);
      if (updated) setActiveProfile(updated);
      else setActiveProfile(null);
    }
  }, [profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset upload state and check KV when profile changes
  useEffect(() => {
    setPendingArchive(null);
    setArchiveReadPct(0);
    setUploadError(null);
    setServerclassFile(null);
    setServerclassReadPct(0);
    setServerclassError(null);

    if (!activeProfile) { setKvDataStatus('idle'); return; }

    setKvDataStatus('checking');
    kvExists(`profile/${activeProfile.id}/inputs`)
      .then(exists => setKvDataStatus(exists ? 'exists' : 'none'))
      .catch(() => setKvDataStatus('none'));
  }, [activeProfile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const readArchiveFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase();
    const valid = ext.endsWith('.zip') || ext.endsWith('.tar') || ext.endsWith('.tgz') || ext.endsWith('.tar.gz');
    if (!valid) {
      setUploadError('Unsupported file type — use .zip, .tar, or .tgz');
      return;
    }
    setUploadError(null);
    setArchiveReadPct(0);
    const reader = new FileReader();
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) setArchiveReadPct(Math.round((ev.loaded / ev.total) * 100));
    };
    reader.onload = () => {
      setArchiveReadPct(100);
      setPendingArchive(file);
    };
    reader.onerror = () => setUploadError('Failed to read file');
    reader.readAsArrayBuffer(file);
  }, []);

  const readServerclassFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.conf')) {
      setServerclassError('Expected a .conf file');
      return;
    }
    setServerclassError(null);
    setServerclassReadPct(0);
    const reader = new FileReader();
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) setServerclassReadPct(Math.round((ev.loaded / ev.total) * 100));
    };
    reader.onload = () => {
      setServerclassReadPct(100);
      setServerclassFile(file);
    };
    reader.onerror = () => setServerclassError('Failed to read file');
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = Array.from(e.dataTransfer.files).find(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.zip') || n.endsWith('.tar') || n.endsWith('.tgz') || n.endsWith('.tar.gz');
    });
    if (file) readArchiveFile(file);
    else setUploadError('No supported archive found — drop a .zip, .tar, or .tgz file');
  }, [readArchiveFile]);

  const handleModalSave = async (fields: { name: string; org?: string; notes?: string }) => {
    setModalSaving(true);
    try {
      if (modalMode === 'edit' && activeProfile) {
        await onUpdate(activeProfile.id, fields);
      } else {
        await onCreate(fields);
      }
      setModalMode(null);
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setModalSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const name = profiles.find(p => p.id === id)?.name ?? id;
    setDeleteSaving(true);
    try {
      await onDelete(id);
      if (activeProfile?.id === id) setActiveProfile(null);
      setDeleteSuccessName(name);
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleteSaving(false);
      setConfirmDeleteId(null);
    }
  };

  const confirmDeleteProfile = profiles.find(p => p.id === confirmDeleteId);
  const archiveReady = !!pendingArchive && archiveReadPct === 100;
  const serverclassReady = !!serverclassFile && serverclassReadPct === 100;
  // Can open if fresh uploads are ready OR KV data already exists for this profile
  const canOpen = (archiveReady && serverclassReady) || kvDataStatus === 'exists';

  return (
    <div style={{ minHeight: '100svh', background: '#0a0a0f', fontFamily: "'Inter', sans-serif", color: '#e8e8ff', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 20px' }}>
      <div style={{ width: '100%', maxWidth: '560px', display: 'flex', flexDirection: 'column', gap: '24px', animation: 'fadeUp 0.35s ease both' }}>

        {/* KV diagnostic banner — hidden; re-enable kvDiag state/effect to restore */}

        {/* Title */}
        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: '20px' }}>
          <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Cribl</div>
          <div style={{ fontSize: '22px', fontWeight: '800', color: '#e8e8ff', letterSpacing: '-0.02em' }}>UF to Edge Migrator</div>
        </div>

        {/* Profile selector card */}
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px 24px' }}>

          {/* Row: label + dropdown + new button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: activeProfile ? '16px' : '0' }}>
            <span style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', flexShrink: 0 }}>
              Customer Profile
            </span>

            {/* Dropdown */}
            <div ref={dropdownRef} style={{ flex: 1, position: 'relative' }}>
              <button
                onClick={() => { if (profiles.length > 0) setDropdownOpen(o => !o); }}
                disabled={profiles.length === 0}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '6px 12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: profiles.length === 0 ? 'rgba(255,255,255,0.25)' : '#e8e8ff', cursor: profiles.length === 0 ? 'default' : 'pointer', transition: 'all 0.15s' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeProfile ? activeProfile.name : profiles.length === 0 ? 'No profiles yet' : 'Select a customer...'}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: '6px', transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {dropdownOpen && profiles.length > 0 && (
                <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: '#0f0f18', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', zIndex: 50, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
                  {profiles.map(p => (
                    <div
                      key={p.id}
                      onClick={() => { setActiveProfile(p); setDropdownOpen(false); }}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px', cursor: 'pointer', background: activeProfile?.id === p.id ? 'rgba(34,211,238,0.08)' : 'transparent', borderBottom: '1px solid rgba(255,255,255,0.05)', transition: 'background 0.1s' }}
                      onMouseEnter={e => { e.currentTarget.style.background = activeProfile?.id === p.id ? 'rgba(34,211,238,0.12)' : 'rgba(255,255,255,0.05)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = activeProfile?.id === p.id ? 'rgba(34,211,238,0.08)' : 'transparent'; }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: activeProfile?.id === p.id ? '#22d3ee' : '#e8e8ff' }}>
                          {p.name}
                        </span>
                        {p.org && (
                          <span style={{ marginLeft: '8px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.3)' }}>
                            {p.org}
                          </span>
                        )}
                      </div>
                      {activeProfile?.id === p.id && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* New profile button */}
            <button
              onClick={() => setModalMode('create')}
              style={{ flexShrink: 0, background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '6px', padding: '4px 10px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', cursor: 'pointer', transition: 'background 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.16)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.08)'; }}
            >
              + New Profile
            </button>
          </div>

          {/* Active profile card */}
          {activeProfile && (
            <div style={{ background: 'rgba(34,211,238,0.07)', border: '1px solid rgba(34,211,238,0.35)', borderRadius: '8px', padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: '700', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee' }}>
                      {activeProfile.name}
                    </span>
                    <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee', background: 'rgba(34,211,238,0.12)', border: '1px solid rgba(34,211,238,0.3)', borderRadius: '10px', padding: '1px 7px' }}>
                      ACTIVE
                    </span>
                  </div>
                  {activeProfile.org && (
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', fontFamily: "'JetBrains Mono', monospace", marginTop: '2px' }}>
                      {activeProfile.org}
                    </div>
                  )}
                  {activeProfile.notes && (
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', fontFamily: "'JetBrains Mono', monospace", marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '280px' }}>
                      {activeProfile.notes}
                    </div>
                  )}
                  {!activeProfile.org && !activeProfile.notes && (
                    <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', fontFamily: "'JetBrains Mono', monospace", marginTop: '3px' }}>
                      Created {new Date(activeProfile.createdAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    onClick={() => setModalMode('edit')}
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '5px', padding: '3px 8px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'all 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#e8e8ff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(activeProfile.id)}
                    style={{ background: 'rgba(255,100,100,0.06)', border: '1px solid rgba(255,100,100,0.15)', borderRadius: '5px', padding: '3px 8px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.5)', cursor: 'pointer', transition: 'all 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,100,100,0.14)'; e.currentTarget.style.color = '#f87171'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,100,100,0.06)'; e.currentTarget.style.color = 'rgba(255,100,100,0.5)'; }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Enter button — shown when files are ready or KV data already exists */}
              {canOpen && (
                <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid rgba(74,222,128,0.15)' }}>
                  {kvDataStatus === 'exists' && !archiveReady && (
                    <div style={{ marginBottom: '8px', fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.6)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Data loaded from previous session
                    </div>
                  )}
                  <button
                    onClick={() => onSelect(activeProfile, pendingArchive ?? null, serverclassFile)}
                    style={{ width: '100%', background: 'linear-gradient(135deg, rgba(74,222,128,0.12), rgba(74,222,128,0.06))', border: '1px solid rgba(74,222,128,0.45)', borderRadius: '8px', padding: '11px 0', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: '#4ade80', cursor: 'pointer', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', transition: 'background 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(74,222,128,0.22), rgba(74,222,128,0.12))'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(74,222,128,0.12), rgba(74,222,128,0.06))'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                    Open {activeProfile.name}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* KV check shimmer */}
          {activeProfile && kvDataStatus === 'checking' && (
            <div style={{ marginTop: '12px', height: '3px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '100%', borderRadius: '99px', background: 'linear-gradient(90deg, transparent, #4ade80, #86efac, #4ade80, transparent)', backgroundSize: '300% 100%', animation: 'shimmer 1.2s linear infinite' }} />
            </div>
          )}

          {/* Loading shimmer */}
          {loading && (
            <div style={{ marginTop: '12px', height: '3px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '100%', borderRadius: '99px', background: 'linear-gradient(90deg, transparent, #22d3ee, #67e8f9, #22d3ee, transparent)', backgroundSize: '300% 100%', animation: 'shimmer 1.2s linear infinite' }} />
            </div>
          )}

          {/* Empty state */}
          {!loading && profiles.length === 0 && (
            <div style={{ marginTop: '12px', textAlign: 'center', padding: '24px 20px', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.3)' }}>
              No profiles yet — create one to track migration progress
            </div>
          )}
        </div>

        {/* Archive drop zone — shown when a profile is active and we know KV status */}
        {activeProfile && kvDataStatus !== 'checking' && (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            style={{ border: `2px dashed ${dragging ? '#22d3ee' : 'rgba(255,255,255,0.12)'}`, borderRadius: '16px', padding: '32px 40px', textAlign: 'center', transition: 'all 0.2s', background: dragging ? 'rgba(34,211,238,0.04)' : 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
          >
            {!pendingArchive && (
              <div style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: kvDataStatus === 'exists' ? 'rgba(74,222,128,0.5)' : 'rgba(167,139,250,0.6)', marginBottom: '16px' }}>
                {kvDataStatus === 'exists'
                  ? 'Files saved from previous session — re-upload below to replace'
                  : 'No archive uploaded yet — browse or drag and drop your deployment-apps archive below to begin'}
              </div>
            )}

            {/* Shimmer during read */}
            {archiveReadPct > 0 && archiveReadPct < 100 && (
              <div style={{ width: '100%', maxWidth: '380px', marginBottom: '6px' }}>
                <div style={{ height: '5px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: '100%', borderRadius: '99px', background: 'linear-gradient(90deg, transparent, #a78bfa, #c4b5fd, #a78bfa, transparent)', backgroundSize: '300% 100%', animation: 'shimmer 1.2s linear infinite' }} />
                </div>
              </div>
            )}

            {/* serverclass.conf upload */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%', maxWidth: '380px', marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  onClick={() => serverclassInputRef.current?.click()}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: serverclassFile ? 'rgba(34,211,238,0.06)' : 'rgba(34,211,238,0.03)', border: `1px solid ${serverclassFile ? 'rgba(34,211,238,0.4)' : 'rgba(34,211,238,0.15)'}`, borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(34,211,238,0.1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = serverclassFile ? 'rgba(34,211,238,0.06)' : 'rgba(34,211,238,0.03)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
                    </svg>
                    <span style={{ fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee' }}>
                      {serverclassFile ? serverclassFile.name : 'serverclass.conf'}
                    </span>
                  </div>
                  <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {serverclassFile ? 'change' : 'browse'}
                  </span>
                </button>

                {serverclassReady ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="9 12 11 14 15 10" />
                  </svg>
                ) : (
                  <div style={{ width: '18px', height: '18px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.12)', flexShrink: 0 }} />
                )}

                <input
                  ref={serverclassInputRef}
                  type="file"
                  accept=".conf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readServerclassFile(f);
                    e.target.value = '';
                  }}
                />
              </div>

              {serverclassReadPct > 0 && serverclassReadPct < 100 && (
                <div style={{ marginLeft: '2px', marginRight: '30px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                    <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Reading</span>
                    <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#22d3ee' }}>{serverclassReadPct}%</span>
                  </div>
                  <div style={{ height: '3px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${serverclassReadPct}%`, borderRadius: '99px', background: 'linear-gradient(90deg, #22d3ee, #67e8f9)', transition: 'width 0.1s ease' }} />
                  </div>
                </div>
              )}

              {serverclassError && (
                <div style={{ marginLeft: '2px', color: '#ff6b6b', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace" }}>
                  {serverclassError}
                </div>
              )}
            </div>

            {/* Archive button */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', width: '100%', maxWidth: '380px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  onClick={() => archiveInputRef.current?.click()}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: pendingArchive ? 'rgba(167,139,250,0.06)' : 'rgba(167,139,250,0.04)', border: `1px solid ${pendingArchive ? 'rgba(167,139,250,0.4)' : 'rgba(167,139,250,0.15)'}`, borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = pendingArchive ? 'rgba(167,139,250,0.06)' : 'rgba(167,139,250,0.04)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
                    </svg>
                    <span style={{ fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: '#a78bfa' }}>
                      {pendingArchive ? pendingArchive.name : 'deployment-apps.zip / .tar / .tgz'}
                    </span>
                  </div>
                  <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(167,139,250,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {pendingArchive ? 'change' : 'browse'}
                  </span>
                </button>

                {/* Check / empty circle */}
                {archiveReady ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="9 12 11 14 15 10" />
                  </svg>
                ) : (
                  <div style={{ width: '18px', height: '18px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.12)', flexShrink: 0 }} />
                )}

                <input
                  ref={archiveInputRef}
                  type="file"
                  accept=".zip,.tar,.tgz,.tar.gz"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) readArchiveFile(f);
                    e.target.value = '';
                  }}
                />
              </div>

              {/* Read progress bar */}
              {archiveReadPct > 0 && archiveReadPct < 100 && (
                <div style={{ marginLeft: '2px', marginRight: '30px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                    <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(167,139,250,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Reading</span>
                    <span style={{ fontSize: '9px', fontFamily: "'JetBrains Mono', monospace", color: '#a78bfa' }}>{archiveReadPct}%</span>
                  </div>
                  <div style={{ height: '3px', borderRadius: '99px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${archiveReadPct}%`, borderRadius: '99px', background: 'linear-gradient(90deg, #a78bfa, #c4b5fd)', transition: 'width 0.1s ease' }} />
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: '14px', fontSize: '10px', color: 'rgba(255,255,255,0.18)', fontFamily: "'JetBrains Mono', monospace" }}>
              or drag & drop anywhere in this box
            </div>

            {archiveReady && (
              <div style={{ marginTop: '12px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.7)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Archive ready — click Open {activeProfile.name} above to begin
              </div>
            )}

            {uploadError && (
              <div style={{ marginTop: '12px', color: '#ff6b6b', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace" }}>
                {uploadError}
              </div>
            )}
          </div>
        )}

        {/* Delete success */}
        {deleteSuccessName && (
          <div style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: '10px', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <span style={{ fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(74,222,128,0.9)' }}>
              ✓ <strong>{deleteSuccessName}</strong> deleted — all KV store data removed.
            </span>
            <button
              onClick={() => setDeleteSuccessName(null)}
              style={{ background: 'none', border: 'none', color: 'rgba(74,222,128,0.6)', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Confirm delete */}
        {confirmDeleteId && confirmDeleteProfile && (
          <div style={{ background: 'rgba(255,100,100,0.06)', border: '1px solid rgba(255,100,100,0.2)', borderRadius: '10px', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.8)' }}>
              Delete <strong style={{ color: '#f87171' }}>{confirmDeleteProfile.name}</strong>? This will remove all migration progress for this profile.
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={deleteSaving}
                style={{ flex: 1, background: 'rgba(255,100,100,0.12)', border: '1px solid rgba(255,100,100,0.35)', borderRadius: '6px', padding: '7px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: '#f87171', cursor: deleteSaving ? 'default' : 'pointer', fontWeight: '700' }}
              >
                {deleteSaving ? 'Deleting…' : 'Delete'}
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                disabled={deleteSaving}
                style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '7px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Profile modal */}
      {modalMode && (
        <ProfileModal
          editing={modalMode === 'edit' ? activeProfile : null}
          saving={modalSaving}
          onSave={handleModalSave}
          onClose={() => setModalMode(null)}
        />
      )}
    </div>
  );
}
