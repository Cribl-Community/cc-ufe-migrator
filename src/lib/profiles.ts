import { kvGet, kvPut, kvDelete } from './kv';
import type { Profile } from '../types';

const PROFILES_KEY = 'profiles';

/** Key prefix for all data belonging to a profile. */
export function profilePrefix(id: string): string {
  return `profile/${id}/`;
}

// ── Profile index ─────────────────────────────────────────────────────────────

export async function loadProfiles(): Promise<Profile[]> {
  const profiles = await kvGet<Profile[]>(PROFILES_KEY);
  return profiles ?? [];
}

async function saveProfiles(profiles: Profile[]): Promise<void> {
  await kvPut(PROFILES_KEY, profiles);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createProfile(fields: { name: string; org?: string; notes?: string }): Promise<Profile> {
  const profiles = await loadProfiles();
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: fields.name.trim(),
    org: fields.org?.trim() || undefined,
    notes: fields.notes?.trim() || undefined,
    createdAt: Date.now(),
  };
  await saveProfiles([...profiles, profile]);
  return profile;
}

export async function updateProfile(id: string, fields: { name: string; org?: string; notes?: string }): Promise<Profile> {
  const profiles = await loadProfiles();
  const existing = profiles.find(p => p.id === id);
  if (!existing) throw new Error(`Profile ${id} not found`);
  const updated: Profile = {
    ...existing,
    name: fields.name.trim(),
    org: fields.org?.trim() || undefined,
    notes: fields.notes?.trim() || undefined,
  };
  await saveProfiles(profiles.map(p => p.id === id ? updated : p));
  return updated;
}

/** All KV keys scoped to a profile. Must stay in sync with ProfileView.tsx key functions. */
const profileKeys = (id: string) => [
  `profile/${id}/inputs`,
  `profile/${id}/serverclass`,
  `profile/${id}/migrated`,
  `profile/${id}/excluded`,
];

/**
 * Deletes a profile and all its scoped KV keys.
 *
 * Only the index update (saveProfiles) is awaited — it is the only operation
 * that must complete before the caller returns.  The session key and
 * profile-scoped keys are deleted fire-and-forget: some DELETE fetches may
 * hang indefinitely inside the Cribl proxy, so awaiting them would block the
 * UI permanently even though the profile is already logically gone.
 */
export async function deleteProfile(id: string): Promise<void> {
  const profiles = await loadProfiles();
  await saveProfiles(profiles.filter(p => p.id !== id));

  // Fire-and-forget cleanup — do not await.
  kvDelete('ufe_migrator/session').catch(() => {});
  profileKeys(id).forEach(k => kvDelete(k).catch(() => {}));
}
