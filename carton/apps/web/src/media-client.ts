// Placeholder until the Service Worker media slice lands: media URLs only (no play-first verification yet).
export interface MediaClient {
  url(hash: string): string;
  ready: Promise<void>;
  refreshToken(): void;
  onBad(cb: (hash: string) => void): () => void;
}
export async function startMedia(_o: { baseUrl: string; projectId: string; token: () => Promise<string> }): Promise<MediaClient> {
  return { url: (hash) => `/media/${hash}`, ready: Promise.resolve(), refreshToken: () => {}, onBad: () => () => {} };
}
