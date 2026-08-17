import { useState, useEffect, useRef } from 'react';
import type { Profile } from '../types';

interface Props {
  /** null = create mode, Profile = edit mode */
  editing: Profile | null;
  saving: boolean;
  onSave: (fields: { name: string; org?: string; notes?: string }) => Promise<void>;
  onClose: () => void;
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '7px',
  padding: '9px 12px',
  fontSize: '13px',
  fontFamily: "'JetBrains Mono', monospace",
  color: '#e8e8ff',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '10px',
  fontFamily: "'JetBrains Mono', monospace",
  color: 'rgba(34,211,238,0.7)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: '7px',
};

export default function ProfileModal({ editing, saving, onSave, onClose }: Props) {
  const [name, setName] = useState(editing?.name ?? '');
  const [org, setOrg] = useState(editing?.org ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    await onSave({ name, org, notes });
  };

  const canSave = name.trim().length > 0 && !saving;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#0f0f18', border: '1px solid rgba(34,211,238,0.25)', borderRadius: '14px', width: '440px', maxWidth: '95vw', boxShadow: '0 32px 80px rgba(0,0,0,0.7)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '22px 28px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '10px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(34,211,238,0.6)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '3px' }}>
              Customer Profile
            </div>
            <div style={{ fontSize: '16px', fontWeight: '800', color: '#e8e8ff' }}>
              {editing ? 'Edit Profile' : 'New Profile'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', padding: '6px 12px', fontSize: '12px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Fields */}
        <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: '18px' }}>

          {/* Customer Name */}
          <div>
            <label style={LABEL_STYLE}>Customer Name *</label>
            <input
              ref={nameRef}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              placeholder="e.g. Acme Corp"
              style={INPUT_STYLE}
              onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
              onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
            />
          </div>

          {/* Organization / Team */}
          <div>
            <label style={LABEL_STYLE}>Organization / Team</label>
            <input
              value={org}
              onChange={e => setOrg(e.target.value)}
              placeholder="e.g. IT Operations"
              style={INPUT_STYLE}
              onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
              onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
            />
          </div>

          {/* Notes */}
          <div>
            <label style={LABEL_STYLE}>Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Phase 1 migration — 200 UF agents, Windows-heavy environment"
              rows={3}
              style={{ ...INPUT_STYLE, fontSize: '12px', resize: 'vertical', lineHeight: '1.5' } as React.CSSProperties}
              onFocus={e => { e.target.style.borderColor = 'rgba(34,211,238,0.4)'; }}
              onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 28px', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px', padding: '9px 18px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.5)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{ background: canSave ? 'rgba(34,211,238,0.1)' : 'rgba(255,255,255,0.03)', border: `1px solid ${canSave ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '7px', padding: '9px 20px', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", color: canSave ? '#22d3ee' : 'rgba(255,255,255,0.2)', cursor: canSave ? 'pointer' : 'default', fontWeight: '700', transition: 'all 0.15s' }}
          >
            {saving ? '...' : editing ? 'Save Changes' : 'Create & Activate'}
          </button>
        </div>
      </div>
    </div>
  );
}
