import { create } from "zustand";

interface VersionHistoryStore {
  open: boolean;
  relativePath: string | null;
  openFor: (relativePath: string | null) => void;
  setRelativePath: (relativePath: string | null) => void;
  close: () => void;
}

export const useVersionHistoryStore = create<VersionHistoryStore>((set) => ({
  open: false,
  relativePath: null,
  openFor: (relativePath) => set({ open: true, relativePath }),
  setRelativePath: (relativePath) => set({ relativePath }),
  close: () => set({ open: false }),
}));
