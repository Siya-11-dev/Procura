import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTestDb } from "./helpers";
import { getDb } from "@/lib/db/client";
import { createRequest, type NewRequest } from "@/lib/db/repository";
import {
  listRequestDocuments,
  readableDocumentCorpus,
  getRequestSpec,
} from "@/lib/db/repository";
import { runSourcingPipeline } from "@/lib/pipeline";
import { appendAudit, verifyAuditChain } from "@/lib/db/audit";
import {
  MAX_DOCUMENTS_PER_REQUEST,
  extensionOf,
  extractText,
  safeLabel,
} from "@/lib/documents/extract";

// The store resolves its directory once at module load, so it has to be pointed
// at a temp directory before that module is imported by anything else.
const uploadDir = mkdtempSync(path.join(tmpdir(), "procura-uploads-"));
process.env.PROCURA_UPLOAD_DIR = uploadDir;

const { storeDocument } = await import("@/lib/documents/store");

setupTestDb();

afterAll(() => {
  rmSync(uploadDir, { recursive: true, force: true });
});

const REQUEST: NewRequest = {
  title: "Desk specification",
  // Deliberately vague: the whole point of an attachment is that the detail
  // arrives in the file rather than in the description.
  rawDescription:
    "Please source the desks described in the attached specification for the design studio.",
  requesterName: "Test User",
  requesterEmail: "test.user@procura.co.za",
  requesterDepartment: "Test Department",
  unit: "units",
  quantity: null,
  currency: "ZAR",
  budgetAmount: null,
  neededBy: null,
  urgency: "normal",
};

function file(name: string, body: string | Buffer, type = "text/plain"): File {
  // Buffer is not assignable to BlobPart under these lib types, so bytes are
  // copied into a plain Uint8Array.
  const part: BlobPart =
    typeof body === "string" ? body : new Uint8Array(body);
  return new File([part], name, { type });
}

describe("extension and label handling", () => {
  it("reads an extension case-insensitively", () => {
    expect(extensionOf("Spec.PDF")).toBe("pdf");
    expect(extensionOf("notes.tar.gz")).toBe("gz");
    expect(extensionOf("noextension")).toBeNull();
    expect(extensionOf(".hidden")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
  });

  it("strips any path a browser may have included from the label", () => {
    expect(safeLabel("../../etc/passwd")).toBe("passwd");
    expect(safeLabel("C:\\Users\\me\\quote.xlsx")).toBe("quote.xlsx");
    expect(safeLabel("....//....//x.txt")).toBe("x.txt");
    expect(safeLabel("")).toBe("document");
  });
});

describe("deterministic extraction", () => {
  it("reads plain text, markdown and csv", () => {
    expect(extractText(Buffer.from("40 desks"), "txt")).toMatchObject({
      status: "read",
      text: "40 desks",
    });
    expect(extractText(Buffer.from("# Heading\n\nBody"), "md")).toMatchObject({
      status: "read",
    });
    expect(extractText(Buffer.from("item,qty\ndesk,40"), "csv")).toMatchObject({
      status: "read",
      text: "item,qty\ndesk,40",
    });
  });

  it("refuses formats it cannot decode, with a reason", () => {
    const result = extractText(Buffer.from("%PDF-1.7"), "pdf");
    expect(result.status).toBe("not_read");
    expect(result.text).toBeNull();
    expect(result.reason).toMatch(/cannot read \.pdf/i);
  });

  it("refuses a binary even when the extension claims it is text", () => {
    const result = extractText(Buffer.from([0x41, 0x00, 0x42]), "txt");
    expect(result.status).toBe("not_read");
    expect(result.reason).toMatch(/binary/i);
  });

  it("refuses invalid utf-8 rather than mangling it into replacement characters", () => {
    const result = extractText(Buffer.from([0xc3, 0x28, 0xa0]), "txt");
    expect(result.status).toBe("not_read");
    expect(result.reason).toMatch(/not valid utf-8/i);
  });

  it("reports a file that decodes to nothing as unreadable", () => {
    expect(extractText(Buffer.from("   \n\n  "), "txt").status).toBe("not_read");
  });

  it("truncates at the cap and says so", () => {
    const result = extractText(Buffer.from("a".repeat(30_000)), "txt");
    expect(result.status).toBe("read");
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(20_000);
    expect(result.reason).toMatch(/first .* characters/i);
  });

  it("is deterministic: the same bytes always produce the same text", () => {
    const bytes = Buffer.from("Desk,40\r\nISO 9001\r\n\r\n\r\n");
    expect(extractText(bytes, "csv").text).toBe(extractText(bytes, "csv").text);
  });
});

describe("storing attachments", () => {
  beforeEach(() => {
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it("stores a readable file with its hash and extracted text", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      file("spec.csv", "item,qty\ndesk,40\nwarranty,5yr"),
      "test-actor",
      0,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.document.extractStatus).toBe("read");
    expect(outcome.document.charCount).toBeGreaterThan(0);
    expect(outcome.document.sha256).toMatch(/^[a-f0-9]{64}$/);

    const stored = listRequestDocuments(request.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].originalName).toBe("spec.csv");
  });

  it("writes the file under a server-generated name, never the uploaded one", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      file("../../escape.txt", "content"),
      "test-actor",
      0,
    );
    if (!outcome.ok) throw new Error("expected the upload to be stored");

    expect(outcome.document.originalName).toBe("escape.txt");
    expect(outcome.document.storedName).toMatch(/^doc_[a-f0-9]{12}\.txt$/);
    expect(outcome.document.storedName).not.toContain("..");

    const onDisk = readFileSync(
      path.join(uploadDir, request.id, outcome.document.storedName),
      "utf8",
    );
    expect(onDisk).toBe("content");
  });

  it("keeps an unreadable file as evidence instead of discarding it", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      file("spec.pdf", "%PDF-1.7 binary-ish", "application/pdf"),
      "test-actor",
      0,
    );

    if (!outcome.ok) throw new Error("expected the upload to be stored");
    expect(outcome.document.extractStatus).toBe("not_read");

    const { corpus, readCount, unreadCount } = readableDocumentCorpus(request.id);
    expect(corpus).toBe("");
    expect(readCount).toBe(0);
    expect(unreadCount).toBe(1);
    expect(listRequestDocuments(request.id)).toHaveLength(1);
  });

  it("accepts a bare Blob with no name, rather than dropping it silently", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      new Blob(["Quantity: 9 chairs."], { type: "text/plain" }),
      "test-actor",
      0,
    );

    if (!outcome.ok) throw new Error("expected the upload to be stored");
    // No usable extension without a name, so it is stored but not read.
    expect(outcome.document.originalName).toBe("document");
    expect(outcome.document.storedName).toMatch(/\.bin$/);
    expect(listRequestDocuments(request.id)).toHaveLength(1);
  });

  it("rejects empty, oversized and over-quota uploads without storing them", async () => {
    const request = createRequest(REQUEST);

    const empty = await storeDocument(request.id, file("blank.txt", ""), "a", 0);
    expect(empty.ok).toBe(false);

    const oversized = await storeDocument(
      request.id,
      file("big.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 0x41)),
      "a",
      0,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toMatch(/larger than/i);

    const overQuota = await storeDocument(
      request.id,
      file("extra.txt", "content"),
      "a",
      MAX_DOCUMENTS_PER_REQUEST,
    );
    expect(overQuota.ok).toBe(false);

    expect(listRequestDocuments(request.id)).toHaveLength(0);
  });

  it("refuses to write for an id that did not come from createRequest", async () => {
    await expect(
      storeDocument("../../etc", file("x.txt", "content"), "a", 0),
    ).rejects.toThrow(/unexpected request id/i);
  });
});

describe("documents inform the pipeline", () => {
  it("reads a figure out of an attachment the description never mentioned", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      file(
        "requirements.txt",
        "Quantity: 40 ergonomic sit-stand desks, 1600x800mm, black frame. Budget about R300,000. ISO 9001 and B-BBEE Level 2 required.",
      ),
      "test-actor",
      0,
    );
    if (!outcome.ok) throw new Error("expected the upload to be stored");

    await runSourcingPipeline(request.id);

    const spec = getRequestSpec(request.id);
    expect(spec).not.toBeNull();
    expect(spec?.quantity).toBe(40);
    // The certification and figure both came from the file, not the description.
    expect(spec?.requiredCertifications.join(" ")).toMatch(/9001|B-BBEE/i);
  });

  it("excludes an unreadable attachment from the reading but still records it", async () => {
    const request = createRequest(REQUEST);
    await storeDocument(
      request.id,
      file("drawing.pdf", "%PDF-1.7", "application/pdf"),
      "test-actor",
      0,
    );

    await runSourcingPipeline(request.id);

    const spec = getRequestSpec(request.id);
    expect(spec?.quantity).toBe(1);
    expect(listRequestDocuments(request.id)).toHaveLength(1);

    const run = verifyAuditChain();
    expect(run.valid).toBe(true);
  });

  it("re-reads the same attachments on a rerun", async () => {
    const request = createRequest(REQUEST);
    await storeDocument(
      request.id,
      file("requirements.txt", "Quantity: 17 standing desks. ISO 9001 required."),
      "test-actor",
      0,
    );

    await runSourcingPipeline(request.id);
    const first = getRequestSpec(request.id)?.quantity;

    await runSourcingPipeline(request.id);
    const second = getRequestSpec(request.id)?.quantity;

    expect(first).toBe(17);
    expect(second).toBe(17);
    expect(listRequestDocuments(request.id)).toHaveLength(1);
  });

  it("leaves no file on disk when the metadata row cannot be committed", async () => {
    const request = createRequest(REQUEST);

    // Dropping the table makes the insert fail after the bytes are already on
    // disk, which is the window the compensating delete exists for.
    const db = getDb();
    db.exec("DROP TABLE request_documents");

    await expect(
      storeDocument(request.id, file("orphan.txt", "content"), "test-actor", 0),
    ).rejects.toThrow();

    const dir = path.join(uploadDir, request.id);
    const left = existsSync(dir) ? readdirSync(dir) : [];
    expect(left).toHaveLength(0);
  });

  it("keeps attachments in the audit chain", async () => {
    const request = createRequest(REQUEST);
    const outcome = await storeDocument(
      request.id,
      file("requirements.txt", "Quantity: 5 monitors."),
      "test-actor",
      0,
    );
    if (!outcome.ok) throw new Error("expected the upload to be stored");

    appendAudit({
      requestId: request.id,
      actor: "test-actor",
      actorRole: "requester",
      action: "document.attached",
      entityType: "request_document",
      entityId: outcome.document.id,
      detail: {
        name: outcome.document.originalName,
        byteSize: outcome.document.byteSize,
        sha256: outcome.document.sha256,
        extractStatus: outcome.document.extractStatus,
      },
    });

    const result = verifyAuditChain();
    expect(result.valid).toBe(true);
  });
});
