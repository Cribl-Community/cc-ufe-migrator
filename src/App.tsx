import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import ProfileView from './pages/ProfileView';
import KvStorePanel from './components/KvStorePanel';
import { loadProfiles, createProfile, updateProfile, deleteProfile } from './lib/profiles';
import { kvGet } from './lib/kv';
import type { Profile } from './types';

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      // The Cribl platform may inject CRIBL_API_URL asynchronously after the
      // iframe loads. Poll up to 3 s before attempting any KV reads.
      for (let i = 0; i < 30 && !window.CRIBL_API_URL; i++) {
        await new Promise(r => setTimeout(r, 100));
      }

      // If the server served a deep link directly we're already on the profile route.
      if (location.pathname.startsWith('/profile/')) {
        const loadedProfiles = await loadProfiles();
        setProfiles(loadedProfiles);
        return;
      }

      // Load profiles and session in parallel, then restore last active profile.
      const [loadedProfiles, session] = await Promise.all([
        loadProfiles(),
        kvGet<{ id: string }>('ufe_migrator/session').catch(() => null),
      ]);

      setProfiles(loadedProfiles);
      if (session?.id && loadedProfiles.some(p => p.id === session.id)) {
        navigate(`/profile/${session.id}`, { replace: true });
      }
    }

    init()
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreate = useCallback(async (fields: { name: string; org?: string; notes?: string }) => {
    const profile = await createProfile(fields);
    setProfiles(prev => [...prev, profile]);
  }, []);

  const handleUpdate = useCallback(async (id: string, fields: { name: string; org?: string; notes?: string }) => {
    const updated = await updateProfile(id, fields);
    setProfiles(prev => prev.map(p => p.id === id ? updated : p));
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await deleteProfile(id);
    setProfiles(prev => prev.filter(p => p.id !== id));
  }, []);

  if (error) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a0f', fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,100,100,0.8)', fontSize: '12px', padding: '40px', textAlign: 'center' }}>
        <div>
          <div style={{ marginBottom: '8px', color: 'rgba(255,100,100,0.5)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>KV Store Error</div>
          {error}
        </div>
      </div>
    );
  }

  return (
    <>
    <KvStorePanel />
    <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            profiles={profiles}
            loading={loading}
            onSelect={(p, archiveFile, scFile) => navigate(`/profile/${p.id}`, { state: { archiveFile, serverclassFile: scFile } })}
            onCreate={handleCreate}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        }
      />
      <Route path="/profile/:id" element={<ProfileView onDelete={handleDelete} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}
