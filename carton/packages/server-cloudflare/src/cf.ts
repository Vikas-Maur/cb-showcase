// The slice of the Workers runtime API this host uses, typed structurally. Declaring it here instead of depending
// on @cloudflare/workers-types keeps the package free of dependencies, lets it typecheck against the WebWorker lib
// like the rest of Carton, and lets the Node tests pass in fakes. Names and shapes follow the runtime's.

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2HTTPMetadata {
  contentType?: string;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ArrayBuffer | ArrayBufferView | ReadableStream | string): Promise<R2UploadedPart>;
  abort(): Promise<void>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
}

export interface R2PutOptions {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  sha256?: string;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string | null, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<R2Objects>;
  createMultipartUpload(key: string, options?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

export interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  readonly databaseSize: number;
}

// A server-side WebSocket in a Durable Object (Hibernation API).
export interface CfWebSocket {
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readonly readyState: number;
}

export interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectState {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

// Runtime globals that exist in workerd but not in the WebWorker lib.
export interface WebSocketPairCtor {
  new (): { 0: CfWebSocket & WebSocket; 1: CfWebSocket };
}
export interface WebSocketRequestResponsePairCtor {
  new (request: string, response: string): unknown;
}
