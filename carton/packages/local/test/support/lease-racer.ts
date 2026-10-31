// One racer of lease.test.ts: try to take over from the holder whose nonce is argv[3].
import { Lease } from "../../src/lease.ts";
import { openTestStore } from "./sqlite-store.ts";

const [path, seen] = process.argv.slice(2);
const store = openTestStore(path);
const got = await new Lease(store).take(seen, { pid: process.pid, socketPath: `/x/${process.pid}.sock`, kind: "helper" });
process.stdout.write(got ? `won ${process.pid}\n` : `lost ${process.pid}\n`);
await store.close();
