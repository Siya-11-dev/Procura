import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId, nowIso } from "@/lib/util";
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_REQUEST,
  contentTypeFor,
  extensionOf,
  extractText,
  isReadableExtension,
  safeLabel,
} from "./extract";
import { insertRequestDocument } from "@/lib/db/repository";
import { withTransaction } from "@/lib/db/client";

/**
 * Attachments are runtime data, like the SQLite file beside them, and must never
 * become part of the traced deployment output. Resolved through a function so
 * the static default stays scoped under the project directory.
 */
function uploadRoot(): string {
  const override = process.env.PROCURA_UPLOAD_DIR;
  return override ? path.resolve(override) : DEFAULT_UPLOAD_DIR;
}

const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");

export interface StoredDocument {
  id: string;
  originalName: string;
  storedName: string;
  extension: string;
  byteSize: number;
  sha256: string;
  contentType: string | null;
  extractStatus: "read" | "not_read";
  extractReason: string | null;
  extractedText: string | null;
  charCount: number | null;
  uploadedBy: string;
  uploadedAt: string;
}

export type StoreOutcome =
  | { ok: true; document: StoredDocument }
  | { ok: false; name: string; reason: string };

/**
 * The parts of an uploaded file this module needs. A real File satisfies this
 * structurally, but a runtime that hands over a bare Blob does too, which is why
 * name and type are optional rather than required.
 */
export interface UploadFile {
  name?: string;
  type?: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Server-generated, extension allowlist-filtered name. The requester's own file
 * name never reaches the filesystem, so a name like "../../etc/cron.d/x" cannot
 * escape the upload directory even though it is stored verbatim as a label.
 */
function safeStoredName(id: string, extension: string | null): string {
  return extension && /^[a-z0-9]{1,12}$/.test(extension) ? `${id}.${extension}` : `${id}.bin`;
}

function assertSafeRequestId(requestId: string): void {
  if (!/^req_[a-f0-9]{12}$/.test(requestId)) {
    throw new Error(`Refusing to write attachments for unexpected request id ${requestId}`);
  }
}

/**
 * Persist one attachment and extract whatever text it yields.
 *
 * Never throws for a bad file: an unreadable attachment is still stored as
 * evidence and reported as 'not_read', because silently discarding a document
 * someone deliberately tendered is worse than storing one we cannot parse.
 */
export async function storeDocument(
  requestId: string,
  file: UploadFile,
  uploadedBy: string,
  existingCount: number,
): Promise<StoreOutcome> {
  const label = safeLabel(file.name ?? "document");

  if (existingCount >= MAX_DOCUMENTS_PER_REQUEST) {
    return {
      ok: false,
      name: label,
      reason: `A request can have at most ${MAX_DOCUMENTS_PER_REQUEST} attachments.`,
    };
  }

  if (file.size === 0) {
    return { ok: false, name: label, reason: "That file is empty." };
  }

  if (file.size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      name: label,
      reason: `That file is larger than ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB.`,
    };
  }

  const id = newId("doc");
  const extension = extensionOf(label);
  const storedName = safeStoredName(id, extension);
  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const extraction = extractText(buffer, extension);

  assertSafeRequestId(requestId);
  // turbopackIgnore: uploads are runtime data written after deployment, so
  // tracing this path into the build output would be wrong, not just wasteful.
  const dir = path.join(/* turbopackIgnore: true */ uploadRoot(), requestId);
  mkdirSync(dir, { recursive: true });
  // 'wx' fails rather than overwriting, so two documents can never collide.
  writeFileSync(
    path.join(/* turbopackIgnore: true */ dir, storedName),
    buffer,
    { flag: "wx" },
  );

  const document: StoredDocument = {
    id,
    originalName: label,
    storedName,
    extension: extension ?? "",
    byteSize: file.size,
    sha256,
    contentType: file.type || contentTypeFor(extension),
    extractStatus: extraction.status,
    extractReason: extraction.reason,
    extractedText: extraction.text,
    charCount: extraction.text === null ? null : extraction.text.length,
    uploadedBy,
    uploadedAt: nowIso(),
  };

  // The database transaction cannot cover the filesystem, so the file is the
  // half that needs compensating. If the row does not commit, the bytes on disk
  // are removed: an orphan upload is invisible to every query and to the audit
  // trail, but still occupies storage and still holds requester content.
  const target = path.join(/* turbopackIgnore: true */ dir, storedName);

  try {
    withTransaction(() => {
      insertRequestDocument(requestId, document);
    });
  } catch (error) {
    try {
      unlinkSync(target);
    } catch {
      // Best effort. A leftover file is a storage problem, not a data-integrity
      // one, and must not mask the original failure.
    }
    throw error;
  }

  return { ok: true, document };
}

/** Readable formats are the ones the intake parser can act on. */
export { isReadableExtension };
