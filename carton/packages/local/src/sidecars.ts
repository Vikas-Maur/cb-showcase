// A view save on a shared cut is `pending` in its `.status` sidecar until the server answers (R5-04, B10). The lease
// holder forwards that answer (confirmed, late cards, refused) to the view whose last save it is. Two orderings matter:
//   - the answer can arrive before the materializer has recorded the save as the view's `lastChange` (the server is
//     quick, the save still finishing): answers are kept for a while, and a later write of the views table that names
//     the change gets it then;
//   - one change gets several answers in a row (its confirmation, then its late-conflict notice): they are handled one
//     at a time in the order they came, and a weaker one never replaces a stronger one (a confirmation never overwrites
//     the late conflict's cards).
// On a local cut the save answered for itself: nothing to forward.
import type { Carton, CartonEvent } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import type { ViewPrinter } from "./writes.ts";

type Update = Parameters<NonNullable<ViewPrinter["onChangeUpdate"]>>[2];
const RANK: Record<Update["status"], number> = { confirmed: 0, conflicts: 1, rejected: 2 };
/** Answers kept for views that haven't named their change yet: the newest ones, for this long. */
const KEEP = 512;
const UNCLAIMED_MS = 60_000;

/** Forward the server's answers to the views' sidecars; returns the unsubscribe. */
export function forwardSettles(carton: Carton, store: Store, onChangeUpdate: NonNullable<ViewPrinter["onChangeUpdate"]>): () => void {
  const answers = new Map<string, { s: Update; at: number }>();
  /** What each view's sidecar was last told: `<change id> <status>`. */
  const told = new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (f: () => Promise<void>) => { chain = chain.then(f).catch(() => {}); };

  const deliver = async () => {
    const now = Date.now();
    for (const [id, a] of answers) if (now - a.at > UNCLAIMED_MS) answers.delete(id);
    if (!answers.size) return;
    for (const r of await store.range<{ lastChange?: string | null }>("views", { prefix: ["view"] })) {
      const id = r.value?.lastChange;
      const a = id ? answers.get(id) : undefined;
      if (!id || !a) continue;
      const view = String(r.key[1]);
      const mark = `${id} ${a.s.status}`;
      if (told.get(view) === mark) continue;
      told.set(view, mark);
      await onChangeUpdate(view, id, a.s);
    }
  };

  const settle = (cut: string | null, id: string, s: Update) =>
    enqueue(async () => {
      if (cut && (await carton.cuts()).find((c) => c.id === cut)?.sequencer.kind === "local") return;
      const prev = answers.get(id)?.s;
      const strong = !prev || RANK[s.status] >= RANK[prev.status] ? s : prev;
      answers.delete(id);
      answers.set(id, { s: { ...strong, seq: strong.seq ?? prev?.seq ?? s.seq }, at: Date.now() });
      if (answers.size > KEEP) answers.delete(answers.keys().next().value!);
      await deliver();
    });

  const off = carton.on((e: CartonEvent) => {
    // by id, whoever made it (a view save's id isn't this handle's): only a view's last change has a sidecar to settle
    if (e.type === "change" && e.change.id) settle(e.branchId, e.change.id, { status: "confirmed", seq: e.seq });
    else if (e.type === "absorbed") settle(e.branchId, e.id, e.cards.length ? { status: "conflicts", conflicts: e.cards } : { status: "confirmed" });
    else if (e.type === "notice" && e.notice.change && e.notice.kind === "late-conflict") settle(null, e.notice.change, { status: "conflicts", conflicts: e.notice.cards ?? [] });
    else if (e.type === "notice" && e.notice.change && e.notice.kind === "rejected") settle(null, e.notice.change, { status: "rejected", reason: e.notice.text });
  });
  // a save recorded as a view's last change after its answer came: it gets that answer now
  const unwatch = store.watch?.((tables) => { if (answers.size && tables.includes("views")) enqueue(deliver); });
  return () => { off(); unwatch?.(); };
}
