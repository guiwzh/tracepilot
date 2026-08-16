import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Zustand 保存纯前端偏好；服务端数据仍交给 React Query，避免两套缓存互相覆盖。 */
interface PreferencesState {
  range: '24h' | '7d' | '30d';
  compactRows: boolean;
  setRange(range: PreferencesState['range']): void;
  setCompactRows(compactRows: boolean): void;
}

export const usePreferences = create<PreferencesState>()(
  // persist 中间件会把状态序列化到 localStorage，刷新后仍保留紧凑行设置。
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
