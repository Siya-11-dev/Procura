/**
 * Deterministic text extraction for request attachments.
 *
 * Only formats that can be decoded with no dependency are readable. Anything
 * else is still stored as evidence of what was tendered, but is recorded as
 * 'not_read' rather than silently dropped or guessed at. The Request Agent
 * therefore never reads content this module could not decode.
 */

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/**
 * Five files of 5MB is 25MB, which is what serverActions.bodySizeLimit in
 * next.config.ts is sized to accept.
 */
export const MAX_DOCUMENTS_PER_REQUEST = 5;
/** Hard cap on the corpus handed to the parser, so one huge file cannot skew intake. */
export const MAX_EXTRACTED_CHARS = 20_000;

/** Extensions the intake parser is allowed to read. */
const READABLE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  log: "text/plain",
};

export type ExtractStatus = "read" | "not_read";

export interface ExtractionResult {
  status: ExtractStatus;
  /** Populated only when status is 'read'. */
  text: string | null;
  /** Why extraction failed, shown to the requester and stored on the row. */
  reason: string | null;
  /** True when the file was readable but longer than MAX_EXTRACTED_CHARS. */
  truncated: boolean;
}

/**
 * Lowercased extension without the dot, or null when the name has none.
 * Derived from the label only; it never influences where the file is written.
 */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 1 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function isReadableExtension(extension: string | null): boolean {
  return extension !== null && READABLE_EXTENSIONS.has(extension);
}

export function contentTypeFor(extension: string | null): string | null {
  return extension && MIME_BY_EXTENSION[extension] ? MIME_BY_EXTENSION[extension] : null;
}

/**
 * Collapse the whitespace runs that dominate PDFs, spreadsheets and minified
 * JSON so the quantity, budget and certification patterns in parsing.ts see
 * the same token shapes they see in typed prose.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * A NUL byte in the first kilobyte is the standard signal that a file is binary.
 * Checking before decoding stops a mislabelled binary from being mangled into
 * plausible-looking text.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  return sample.includes(0);
}

export function extractText(
  buffer: Buffer,
  extension: string | null,
): ExtractionResult {
  if (!isReadableExtension(extension)) {
    return {
      status: "not_read",
      text: null,
      reason: extension
        ? `Procura cannot read .${extension} files.`
        : "That file has no extension, so Procura cannot tell what it is.",
      truncated: false,
    };
  }

  if (looksBinary(buffer)) {
    return {
      status: "not_read",
      text: null,
      reason: `That .${extension} file looks like a binary rather than text.`,
      truncated: false,
    };
  }

  // Round-trip through the decoder so invalid UTF-8 is reported instead of
  // silently becoming U+FFFD throughout the file.
  const decoded = new TextDecoder("utf-8", { fatal: true });
  let raw: string;
  try {
    raw = decoded.decode(buffer);
  } catch {
    return {
      status: "not_read",
      text: null,
      reason: `That .${extension} file is not valid UTF-8 text.`,
      truncated: false,
    };
  }

  const normalised = normalise(raw);
  if (normalised.length === 0) {
    return {
      status: "not_read",
      text: null,
      reason: `That .${extension} file contains no readable text.`,
      truncated: false,
    };
  }

  const truncated = normalised.length > MAX_EXTRACTED_CHARS;
  return {
    status: "read",
    text: truncated ? normalised.slice(0, MAX_EXTRACTED_CHARS) : normalised,
    reason: truncated
      ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString("en-ZA")} characters of this file were read.`
      : null,
    truncated,
  };
}

/**
 * Label shown in the UI. Stripped of any path the browser may have included, so
 * a name like "../../etc/passwd" cannot render as a deceptive label.
 */
export function safeLabel(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "document";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "document";
}
