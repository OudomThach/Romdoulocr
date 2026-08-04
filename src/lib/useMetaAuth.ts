import { useSyncExternalStore } from 'react';
import { metaSession, subscribeAuth, type MetaUser } from '@/lib/metaClient';

// Reactive auth state for the metadata service: token presence + current user.
// Backed by localStorage (shared with the /portal app) via metaClient.

export function useMetaAuth(): { signedIn: boolean; user: MetaUser | null } {
  const token = useSyncExternalStore(
    subscribeAuth,
    () => metaSession.token(),
    () => null,
  );
  const user = useSyncExternalStore(
    subscribeAuth,
    () => metaSession.user(),
    () => null,
  );
  return { signedIn: token !== null, user };
}
