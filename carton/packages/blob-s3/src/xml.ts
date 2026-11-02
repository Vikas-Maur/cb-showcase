// A tiny XML reader for the flat documents S3 returns, and a writer for the CompleteMultipartUpload body.
// It is deliberately not a general parser: no DTDs (a DOCTYPE is refused, so there is no entity expansion),
// no attributes kept (S3 only puts xmlns on the root), namespace prefixes dropped. It handles the predefined
// entities, numeric character references, CDATA, comments and processing instructions.

export interface XmlElement {
  name: string;
  children: XmlElement[];
  /** Concatenated, entity-decoded character data directly inside this element (not trimmed). */
  text: string;
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

function decodeEntity(_match: string, body: string): string {
  if (body.charCodeAt(0) !== 35 /* # */) return PREDEFINED[body];
  const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  // Out-of-range references cannot name a character; keep the reader total rather than throwing on them.
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
}

/** Decodes the five predefined entities and numeric character references. Unknown entities are left as is. */
export function decodeXmlEntities(text: string): string {
  return text.indexOf("&") < 0 ? text : text.replace(ENTITY, decodeEntity);
}

/** Escapes text for element content or attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&${c === "&" ? "amp" : c === "<" ? "lt" : c === ">" ? "gt" : c === '"' ? "quot" : "apos"};`);
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

/** Finds the `>` that closes a start tag, skipping any `>` inside quoted attribute values. */
function endOfTag(xml: string, from: number): number {
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62 /* > */) {
      return i;
    }
  }
  return -1;
}

function malformed(why: string): Error {
  return new SyntaxError(`malformed XML: ${why}`);
}

/** Parses a document and returns its root element. */
export function parseXml(xml: string): XmlElement {
  const sentinel: XmlElement = { name: "", children: [], text: "" };
  const stack: XmlElement[] = [sentinel];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0 || lt > i) {
      const end = lt < 0 ? xml.length : lt;
      // Text outside the root (whitespace S3 streams before a slow CompleteMultipartUpload result) is dropped.
      if (top !== sentinel) top.text += decodeXmlEntities(xml.slice(i, end));
      if (lt < 0) break;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw malformed("unterminated processing instruction");
      i = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw malformed("unterminated comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw malformed("unterminated CDATA section");
      if (top !== sentinel) top.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      // DOCTYPE and its internal subset are how entity-expansion attacks get in; S3 never sends one.
      throw malformed("DTDs are not accepted");
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) throw malformed("unterminated end tag");
      const name = localName(xml.slice(lt + 2, end).trim());
      if (top === sentinel || top.name !== name) throw malformed(`unexpected </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      const end = endOfTag(xml, lt + 1);
      if (end < 0) throw malformed("unterminated start tag");
      const selfClosing = xml.charCodeAt(end - 1) === 47; /* / */
      const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
      const nameEnd = inner.search(/[\s/]|$/);
      const name = localName(inner.slice(0, nameEnd));
      if (name === "") throw malformed("empty tag name");
      if (top === sentinel && sentinel.children.length > 0) throw malformed("more than one root element");
      const element: XmlElement = { name, children: [], text: "" };
      top.children.push(element);
      if (!selfClosing) stack.push(element);
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw malformed(`<${stack[stack.length - 1].name}> is not closed`);
  const root = sentinel.children[0];
  if (root === undefined) throw malformed("no root element");
  return root;
}

export function childElement(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((c) => c.name === name);
}

export function childElements(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter((c) => c.name === name);
}

export function childText(parent: XmlElement, name: string): string | undefined {
  return childElement(parent, name)?.text;
}

function expectRoot(root: XmlElement, name: string): void {
  if (root.name !== name) throw malformed(`expected <${name}>, got <${root.name}>`);
}

function requiredText(parent: XmlElement, name: string): string {
  const text = childText(parent, name);
  if (text === undefined) throw malformed(`<${parent.name}> has no <${name}>`);
  return text;
}

function integer(parent: XmlElement, name: string): number {
  const text = requiredText(parent, name).trim();
  const value = Number(text);
  if (text === "" || !Number.isSafeInteger(value)) throw malformed(`<${name}> is not an integer: ${text}`);
  return value;
}

function bool(parent: XmlElement, name: string): boolean {
  return childText(parent, name)?.trim().toLowerCase() === "true";
}

/** Optional token-like values: absent and empty mean the same thing. */
function optionalText(parent: XmlElement, name: string): string | undefined {
  const text = childText(parent, name)?.trim();
  return text ? text : undefined;
}

export interface S3ErrorBody {
  code: string;
  message: string;
  requestId?: string;
  resource?: string;
}

/** Parses an `<Error>` document; returns null if the document is something else (or not XML at all). */
export function parseErrorXml(xml: string): S3ErrorBody | null {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  if (root.name !== "Error") return null;
  return {
    code: childText(root, "Code")?.trim() ?? "",
    message: childText(root, "Message") ?? "",
    requestId: optionalText(root, "RequestId"),
    resource: optionalText(root, "Resource"),
  };
}

export function parseInitiateMultipartUpload(xml: string): { uploadId: string } {
  const root = parseXml(xml);
  expectRoot(root, "InitiateMultipartUploadResult");
  const uploadId = requiredText(root, "UploadId").trim();
  if (uploadId === "") throw malformed("empty <UploadId>");
  return { uploadId };
}

export interface ListedPart {
  partNumber: number;
  /** Raw ETag text as the server wrote it (the client normalises quoting). */
  etag: string;
  size: number;
}

export interface ListPartsPage {
  parts: ListedPart[];
  isTruncated: boolean;
  nextPartNumberMarker?: string;
}

export function parseListParts(xml: string): ListPartsPage {
  const root = parseXml(xml);
  expectRoot(root, "ListPartsResult");
  return {
    parts: childElements(root, "Part").map((p) => ({
      partNumber: integer(p, "PartNumber"),
      etag: requiredText(p, "ETag").trim(),
      size: integer(p, "Size"),
    })),
    isTruncated: bool(root, "IsTruncated"),
    nextPartNumberMarker: optionalText(root, "NextPartNumberMarker"),
  };
}

export interface CompleteMultipartUploadResult {
  etag: string;
  location?: string;
  bucket?: string;
  key?: string;
}

/**
 * Parses the CompleteMultipartUpload response. S3 can answer 200 and still fail (the status is sent before
 * the work finishes), with an `<Error>` document as the body, so the caller must check for that first.
 */
export function parseCompleteMultipartUpload(xml: string): CompleteMultipartUploadResult {
  const root = parseXml(xml);
  expectRoot(root, "CompleteMultipartUploadResult");
  return {
    etag: requiredText(root, "ETag").trim(),
    location: optionalText(root, "Location"),
    bucket: optionalText(root, "Bucket"),
    key: childText(root, "Key"),
  };
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
}

export interface ListObjectsPage {
  objects: ListedObject[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

/** Parses a ListObjectsV2 (`list-type=2`) result. Keys keep their exact text, whitespace included. */
export function parseListObjectsV2(xml: string): ListObjectsPage {
  const root = parseXml(xml);
  expectRoot(root, "ListBucketResult");
  return {
    objects: childElements(root, "Contents").map((c) => ({
      key: requiredText(c, "Key"),
      size: integer(c, "Size"),
      etag: (childText(c, "ETag") ?? "").trim(),
    })),
    isTruncated: bool(root, "IsTruncated"),
    nextContinuationToken: optionalText(root, "NextContinuationToken"),
  };
}

/** Builds the CompleteMultipartUpload request body. Parts must already be in ascending part-number order. */
export function buildCompleteMultipartUpload(parts: ReadonlyArray<{ partNumber: number; etag: string }>): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
  for (const part of parts) {
    xml += `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`;
  }
  return xml + "</CompleteMultipartUpload>";
}
