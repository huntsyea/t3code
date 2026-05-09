import { create } from "zustand";

interface GraphViewStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
}

export const useGraphViewStore = create<GraphViewStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
}));
