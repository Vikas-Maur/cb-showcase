// Review of fix/core-deferred (GPT 6.1 Sol, high), finding 2, on the reviewer's repro: since R6-15 a refresh retries the
// people read after one failed, even when it loads no row. Such an older read finishing after a newer refresh had set
// newer people put the older snapshot back: a teammate's edit read as the generic person from then on, and no later
// refresh (no new rows) read people again. People reads now run one at a time and an older snapshot is never set over a
// newer one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, type Store } from '@carton/core';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set } from './fixture.ts';
import { until } from './world.ts';

test("an older people read finishing late never takes back the people a newer refresh set", async () => {
  const raw = createMemoryStore();
  let fail = false, hold = false, captured = false, retryDone = false;
  let resume!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const store: Store = { ...raw, range: async <T,>(table: string, opts?: Parameters<Store['range']>[1]) => {
    if (table === 'meta' && opts?.prefix?.[0] === 'person') {
      if (fail) { fail = false; throw new Error('people unavailable'); }
      const rows = await raw.range<T>(table, opts);
      if (hold) { hold = false; captured = true; await gate; }
      return rows;
    }
    return raw.range<T>(table, opts);
  } };
  const writer = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: { kind: 'human', id: 'person' } });
  const reader = await Carton.open({ adapter, store, actor: { kind: 'human', id: 'reader' } });
  try {
    await raw.write([{ table: 'meta', key: ['person', 'remoteA'], value: { id: 'alice', name: 'Alice' } }]);
    await writer.commit({ id: 'remoteA.1', ops: [set('a', 'name', 'Alice edit')] });
    fail = true;
    await assert.rejects(reader.head(), /people unavailable/);
    // the retry reads people (Alice's row is in History already) and is held with the snapshot it read
    hold = true;
    const retry = reader.head().finally(() => { retryDone = true; });
    await until(() => captured || retryDone);
    assert.ok(captured, 'the retry read people');
    await raw.write([{ table: 'meta', key: ['person', 'remoteB'], value: { id: 'bob', name: 'Bob' } }]);
    await writer.commit({ id: 'remoteB.1', ops: [set('b', 'name', 'Bob edit')] });
    // a newer refresh loads Bob's row and reads people: before, it set them at once (Bob) and the held retry, released
    // after it, set its older snapshot (no Bob) over them; now its read waits for the retry's and is set after it
    const newer = reader.head();
    await Promise.race([newer, new Promise((r) => setTimeout(r, 200))]);
    resume();
    await Promise.all([retry, newer]);
    assert.equal((await reader.credits(['items', 'b']))?.id, 'bob', 'Bob, once both refreshes are done');
    await reader.head();
    assert.equal((await reader.credits(['items', 'b']))?.id, 'bob', 'and on a later read');
    assert.equal((await reader.credits(['items', 'a']))?.id, 'alice');
  } finally { resume(); await reader.close(); await writer.close(); }
});
