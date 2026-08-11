import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PreferencesState {
  range: '24h' | '7d' | '30d';
  compactRows: boolean;
  setRange(range: PreferencesState['range']): void;
  setCompactRows(compactRows: boolean): void;
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      range: '24h',
      compactRows: false,
      setRange: (range) => set({ range }),
      setCompactRows: (compactRows) => set({ compactRows }),
    }),
    { name: 'tracepilot-preferences' },
  ),
);
