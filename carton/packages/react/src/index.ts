// Headless hooks and unstyled components for Carton (PLAN §9, §10, §17): history, cuts, fold in, conflict cards,
// Compare and Watch the changes, presence and sync status. `react` is a peer dependency; everything must also run
// under `preact/compat` (the renderer mounts a Preact root). The stubs below fix the data shapes; the hooks land with
// the owner (who adds the react peer types). Owner: ui.
import type { Carton, CartonEvent, ConflictCard, CutRecord, ShotDiff, UndoEntry, Version, sync } from "@carton/core";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface HistoryView {
  versions: Version[];
  loading: boolean;
  more(): void;
}
export interface CutsView {
  cuts: CutRecord[];
  current: string;
  switchTo(id: string): Promise<void>;
  fork(name: string): Promise<CutRecord>;
}
export interface ConflictsView {
  cards: ConflictCard[];
  choose(index: number, choice: "ours" | "theirs" | "base" | { value: unknown }): void;
  apply(): Promise<void>;
}

export function useHistory(carton: Carton, opts?: { cut?: string; pageSize?: number }): HistoryView {
  return todo("useHistory");
}
export function useCuts(carton: Carton): CutsView {
  return todo("useCuts");
}
export function useConflicts(carton: Carton, cards: ConflictCard[]): ConflictsView {
  return todo("useConflicts");
}
export function useShotDiff(carton: Carton, a: string, b?: string): { diff: ShotDiff | null; loading: boolean } {
  return todo("useShotDiff");
}
export function useUndoStack(carton: Carton, group?: string): UndoEntry[] {
  return todo("useUndoStack");
}
export function useCartonEvents(carton: Carton, listener: (e: CartonEvent) => void): void {
  todo("useCartonEvents");
}
export type SyncStatus = sync.SyncStatus;
