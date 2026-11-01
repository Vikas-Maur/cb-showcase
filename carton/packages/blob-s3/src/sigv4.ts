// AWS Signature Version 4 (header and query-string/presigned forms) on WebCrypto only, so the same code
// runs in Node, browsers and Cloudflare Workers. Canonicalization follows the S3 rules: every path segment
// is URI-encoded exactly once (other AWS services double-encode; we only sign S3-style requests).
// Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
//       https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Payload hash that tells S3 the body is not covered by the signature. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** Hex SHA-256 of the empty string, the payload hash of every bodiless request. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "AWS4-HMAC-SHA256";
const MAX_PRESIGN_SECONDS = 604800; // 7 days, the SigV4 ceiling

export interface SignRequestInput {
  method: string;
  /** Path must already be percent-encoded the way it goes on the wire (see `encodeS3Path`). */
  url: string | URL;
  /** Headers to sign. Every header given here is signed; `host` is taken from the URL when absent. */
  headers?: Record<string, string>;
  /** Body to hash. Ignored when `payloadHash` is given. */
  body?: Uint8Array | string;
  /** Precomputed hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash?: string;
  credentials: Credentials;
  region: string;
  service: string;
  /** Signing time; defaults to now. A `Date` or the SigV4 form `YYYYMMDDTHHMMSSZ`. */
  datetime?: Date | string;
  /**
   * Add the `x-amz-content-sha256` header. S3 requires it, other services do not send it (the AWS
   * test-suite vectors are for a generic service), so it defaults to `service === "s3"`.
   */
  contentSha256Header?: boolean;
}

export interface SignatureDetails {
  /** Headers the caller must add to the request (lowercase names). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export interface PresignUrlInput {
  method: string;
  url: string | URL;
  credentials: Credentials;
  region: string;
  service: string;
  expiresSeconds: number;
  datetime?: Date | string;
  /** Headers the user of the URL must send with exactly these values (e.g. `content-type`). */
  extraSignedHeaders?: Record<string, string>;
}

const encoder = new TextEncoder();

/**
 * Percent-encodes everything except the RFC 3986 unreserved set `A-Za-z0-9-_.~`, as SigV4 requires.
 * encodeURIComponent already leaves only that set plus `!'()*` alone, so we finish those five.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, percentEncodeChar);
}

function percentEncodeChar(c: string): string {
  return "%" + c.charCodeAt(0).toString(16).toUpperCase();
}

/** Encodes a decoded S3 path (e.g. `/bucket/a b/c`) segment by segment, keeping the `/` separators. */
export function encodeS3Path(path: string): string {
  return path.split("/").map(encodeRfc3986).join("/");
}

/** Formats a time as the SigV4 `YYYYMMDDTHHMMSSZ` stamp. */
export function toAmzDate(date: Date): string {
  // toISOString gives 2013-05-24T00:00:00.000Z; drop the separators and the milliseconds.
  const iso = date.toISOString();
  return (
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + "T" +
    iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z"
  );
}

function resolveAmzDate(datetime: Date | string | undefined): string {
  if (datetime === undefined) return toAmzDate(new Date());
  if (typeof datetime !== "string") return toAmzDate(datetime);
  if (!/^\d{8}T\d{6}Z$/.test(datetime)) throw new TypeError(`datetime must look like 20130524T000000Z, got ${datetime}`);
  return datetime;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return out;
}

/** Hex SHA-256 of bytes or of a string's UTF-8 encoding. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  // WebCrypto's types want an ArrayBuffer-backed view; a SharedArrayBuffer view is rejected at runtime anyway.
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

// The key type is taken from importKey rather than named: `CryptoKey`/`BufferSource` are global types in the DOM
// and WebWorker libs but not in @types/node, and this file is type-checked under all three.
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function importHmacKey(raw: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<HmacKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: HmacKey, data: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

// The signing key depends only on (secret, day, region, service), so derive it once a day per scope instead
// of running four HMAC rounds per request. Promises are cached so concurrent first requests share one
// derivation. The map stays tiny (one entry per scope per day); clearing it when it grows keeps a
// long-running process from accumulating old days.
const signingKeyCache = new Map<string, Promise<HmacKey>>();
const SIGNING_KEY_CACHE_LIMIT = 64;

function signingKey(secret: string, date: string, region: string, service: string): Promise<HmacKey> {
  const id = `${date}\n${region}\n${service}\n${secret}`;
  let key = signingKeyCache.get(id);
  if (key === undefined) {
    if (signingKeyCache.size >= SIGNING_KEY_CACHE_LIMIT) signingKeyCache.clear();
    key = deriveSigningKey(secret, date, region, service);
    signingKeyCache.set(id, key);
    key.catch(() => signingKeyCache.delete(id));
  }
  return key;
}

async function deriveSigningKey(secret: string, date: string, region: string, service: string): Promise<HmacKey> {
  let raw = await hmac(await importHmacKey(encoder.encode("AWS4" + secret)), date);
  raw = await hmac(await importHmacKey(raw), region);
  raw = await hmac(await importHmacKey(raw), service);
  raw = await hmac(await importHmacKey(raw), "aws4_request");
  return importHmacKey(raw);
}

function decodeComponent(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new TypeError(`malformed percent-encoding in URL ${what}: ${part}`);
  }
}

/**
 * Canonical URI: decode each segment and re-encode it with the strict set. AWS does the same on its side
 * (its own PUT example sends `test$file.text` and signs `/test%24file.text`), and for paths we build with
 * `encodeS3Path` the result is byte-for-byte the path on the wire, which other S3 servers rely on.
 */
function canonicalUri(pathname: string): string {
  if (pathname === "") return "/";
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeComponent(segment, "path")))
    .join("/");
}

/** Parses a raw query string (`a=1&b`) into decoded pairs. `+` is a literal plus, as in SigV4. */
function parseQuery(search: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw === "") return pairs;
  for (const piece of raw.split("&")) {
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    const name = eq < 0 ? piece : piece.slice(0, eq);
    const value = eq < 0 ? "" : piece.slice(eq + 1);
    pairs.push([decodeComponent(name, "query"), decodeComponent(value, "query")]);
  }
  return pairs;
}

/** Encoded `name=value` pairs sorted by encoded name, then encoded value. A bare `?lifecycle` becomes `lifecycle=`. */
function canonicalQuery(pairs: Array<[string, string]>): string {
  const encoded = pairs.map(([name, value]): [string, string] => [encodeRfc3986(name), encodeRfc3986(value)]);
  // Encoded strings are plain ASCII, so code-unit order is byte order.
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return encoded.map(([name, value]) => `${name}=${value}`).join("&");
}

interface CanonicalHeaders {
  canonical: string; // "name:value\n" lines
  signed: string; // "a;b;c"
}

function canonicalHeaders(headers: Record<string, string>, host: string): CanonicalHeaders {
  const byName = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    const value = headers[name].trim().replace(/\s+/g, " ");
    const previous = byName.get(lower);
    // Repeated header names are signed as one comma-joined value.
    byName.set(lower, previous === undefined ? value : `${previous},${value}`);
  }
  if (!byName.has("host")) byName.set("host", host);
  const names = [...byName.keys()].sort();
  let canonical = "";
  for (const name of names) canonical += `${name}:${byName.get(name)}\n`;
  return { canonical, signed: names.join(";") };
}

function credentialScope(date: string, region: string, service: string): string {
  return `${date}/${region}/${service}/aws4_request`;
}

async function signString(
  credentials: Credentials,
  amzDate: string,
  region: string,
  service: string,
  canonicalRequest: string,
): Promise<{ stringToSign: string; signature: string }> {
  const date = amzDate.slice(0, 8);
  const stringToSign = `${ALGORITHM}\n${amzDate}\n${credentialScope(date, region, service)}\n${await sha256Hex(canonicalRequest)}`;
  const key = await signingKey(credentials.secretAccessKey, date, region, service);
  return { stringToSign, signature: toHex(await hmac(key, stringToSign)) };
}

/** Like `signRequest`, but also returns the canonical request and string to sign (for tests and debugging). */
export async function explainSignRequest(input: SignRequestInput): Promise<SignatureDetails> {
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const amzDate = resolveAmzDate(input.datetime);
  const payloadHash =
    input.payloadHash ?? (input.body === undefined ? EMPTY_SHA256 : await sha256Hex(input.body));
  const addContentSha = input.contentSha256Header ?? input.service === "s3";

  const added: Record<string, string> = { "x-amz-date": amzDate };
  if (addContentSha) added["x-amz-content-sha256"] = payloadHash;
  if (input.credentials.sessionToken) added["x-amz-security-token"] = input.credentials.sessionToken;

  const headers = canonicalHeaders({ ...input.headers, ...added }, url.host);
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(parseQuery(url.search)),
    headers.canonical,
    headers.signed,
    payloadHash,
  ].join("\n");

  const { stringToSign, signature } = await signString(
    input.credentials, amzDate, input.region, input.service, canonicalRequest,
  );
  const scope = credentialScope(amzDate.slice(0, 8), input.region, input.service);
  added.authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${headers.signed}, Signature=${signature}`;
  return { headers: added, canonicalRequest, stringToSign, signature };
}

/**
 * Signs a request with the `Authorization` header. Returns the headers to add: `authorization`,
 * `x-amz-date`, `x-amz-content-sha256` (S3) and `x-amz-security-token` (temporary credentials).
 */
export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
  return (await explainSignRequest(input)).headers;
}

/**
 * Builds a presigned URL (query-string auth). The payload is always `UNSIGNED-PAYLOAD`, so a presigned PUT
 * accepts any body. The returned URL carries the canonical (strictly encoded) path and query.
 */
export async function presignUrl(input: PresignUrlInput): Promise<string> {
  const { expiresSeconds } = input;
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > MAX_PRESIGN_SECONDS) {
    throw new RangeError(`expiresSeconds must be an integer from 1 to ${MAX_PRESIGN_SECONDS}, got ${expiresSeconds}`);
  }
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const amzDate = resolveAmzDate(input.datetime);
  const scope = credentialScope(amzDate.slice(0, 8), input.region, input.service);
  const headers = canonicalHeaders(input.extraSignedHeaders ?? {}, url.host);

  const pairs = parseQuery(url.search);
  pairs.push(
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresSeconds)],
    ["X-Amz-SignedHeaders", headers.signed],
  );
  // S3 signs the session token as part of the query (some other services append it after signing).
  if (input.credentials.sessionToken) pairs.push(["X-Amz-Security-Token", input.credentials.sessionToken]);

  const path = canonicalUri(url.pathname);
  const query = canonicalQuery(pairs);
  const canonicalRequest = [
    input.method.toUpperCase(), path, query, headers.canonical, headers.signed, UNSIGNED_PAYLOAD,
  ].join("\n");
  const { signature } = await signString(input.credentials, amzDate, input.region, input.service, canonicalRequest);
  return `${url.origin}${path}?${query}&X-Amz-Signature=${signature}`;
}
