// The Worker's own media API as an editor of one project: the production part route (host-http streams a part's body
// to the store as it arrives, with no test route buffering it in between), and a part sent slowly over HTTP, or cut
// off mid-body, the way a slow or killed uploader sends it.
import { request } from "node:http";
import type { HmacAuth } from "@carton/server";

export interface ApiAnswer {
  status: number;
  body: Record<string, unknown> | null;
}

export async function mediaApi(origin: string, auth: HmacAuth, project: string) {
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "editor", projectId: project, ttlMs: 600_000 });
  const headers = { authorization: `Bearer ${token}` };
  const call = async (path: string, init: RequestInit = {}): Promise<ApiAnswer> => {
    const r = await fetch(`${origin}/api/projects/${project}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const q = (key: string) => `key=${encodeURIComponent(key)}`;
  return {
    token,
    call,
    create: (key: string, size: number) => call("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, size }) }),
    part: (key: string, id: string, n: number, data: Uint8Array) => call(`/uploads/${encodeURIComponent(id)}/${n}?${q(key)}`, { method: "PUT", body: data as Uint8Array<ArrayBuffer> }),
    complete: (key: string, id: string, parts: unknown[]) => call(`/uploads/${encodeURIComponent(id)}/complete?${q(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }) }),
    /**
     * PUT a part with its length declared and its bytes sent `pieces` at a time, `everyMs` apart. `cutAfter`: the
     * connection is destroyed after that many pieces (an uploader killed mid-part), and the answer is "cut".
     */
    slowPart: (key: string, id: string, n: number, data: Uint8Array, o: { pieces: number; everyMs: number; cutAfter?: number }) =>
      new Promise<ApiAnswer | "cut">((resolve, reject) => {
        const u = new URL(`${origin}/api/projects/${project}/uploads/${encodeURIComponent(id)}/${n}?${q(key)}`);
        const req = request(u, { method: "PUT", headers: { ...headers, "content-length": String(data.byteLength) } }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => {
            let body: Record<string, unknown> | null = null;
            try {
              body = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode ?? 0, body });
          });
        });
        req.on("error", (e) => (o.cutAfter !== undefined ? resolve("cut") : reject(e)));
        const size = Math.ceil(data.byteLength / o.pieces);
        let i = 0;
        const next = () => {
          if (o.cutAfter !== undefined && i === o.cutAfter) return void (req.destroy(), resolve("cut"));
          if (i * size >= data.byteLength) return void req.end();
          req.write(data.subarray(i * size, (i + 1) * size));
          i++;
          setTimeout(next, o.everyMs);
        };
        next();
      }),
  };
}
