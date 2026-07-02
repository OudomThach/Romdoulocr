import { useCallback } from 'react';
import { useSettingsStore } from '@/hooks/useSettingsStore';
import type { StoredRun } from '@/lib/storage';

/**
 * "Re-use settings" on a history row currently does one thing: switch the
 * active tab to the one that produced the run. We deliberately don't
 * re-apply the saved settings into the active tab's local state because
 * that would require each tab to read from the settings store instead of
 * its own useState. That refactor is deferred — for now, switching tabs
 * puts the user back in the same workflow, and the saved settings are
 * visible in the run details.
 */
export interface SettingsReuser {
  apply: (run: StoredRun) => void;
}

export function useReuseSettings(): SettingsReuser {
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  return {
    apply: useCallback(
      (run: StoredRun) => {
        setActiveTab(run.tab);
      },
      [setActiveTab],
    ),
  };
}
