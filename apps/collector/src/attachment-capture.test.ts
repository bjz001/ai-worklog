import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCaptureBuilder } from "./agent-connector.js";
import {
  captureRequestedFile,
  extractLiteralFilePaths,
  stageCaptureAttachments
} from "./attachment-capture.js";
import { Outbox } from "./outbox.js";

const open: Outbox[] = [];
afterEach(() => {
  for (const outbox of open.splice(0)) outbox.close();
});

describe("attachment capture", () => {
  it("copies a regular file into an owner-only local CAS and queues its Blob", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-capture-"));
    const source = join(directory, "secret output.txt");
    const content = "FAKE_SECRET_CANARY=keep-entire-file\n\u5b8c\u6574\u9644\u4ef6";
    writeFileSync(source, content);
    const captured = await captureRequestedFile({
      requestedPath: source,
      cwd: directory,
      blobRoot: join(directory, "blobs")
    });

    expect(captured).toMatchObject({ status: "CAPTURED", byteLength: Buffer.byteLength(content) });
    if (captured.status !== "CAPTURED") throw new Error("capture failed");
    expect(readFileSync(captured.localPath, "utf8")).toBe(content);
    expect(statSync(captured.localPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "blobs")).mode & 0o777).toBe(0o700);
  });

  it("deduplicates an existing valid CAS object without overwriting it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-capture-"));
    const source = join(directory, "same.txt");
    writeFileSync(source, "same complete content");
    const options = {
      requestedPath: source,
      cwd: directory,
      blobRoot: join(directory, "blobs")
    };

    const first = await captureRequestedFile(options);
    const second = await captureRequestedFile(options);

    expect(first).toMatchObject({ status: "CAPTURED" });
    expect(second).toMatchObject({ status: "CAPTURED" });
    if (first.status !== "CAPTURED" || second.status !== "CAPTURED") {
      throw new Error("capture failed");
    }
    expect(second.localPath).toBe(first.localPath);
    expect(readFileSync(second.localPath, "utf8")).toBe("same complete content");
  });

  it("does not silently overwrite a corrupt object at a content-addressed path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-capture-"));
    const source = join(directory, "source.txt");
    writeFileSync(source, "expected bytes");
    const options = {
      requestedPath: source,
      cwd: directory,
      blobRoot: join(directory, "blobs")
    };
    const first = await captureRequestedFile(options);
    if (first.status !== "CAPTURED") throw new Error("capture failed");
    writeFileSync(first.localPath, "corrupt bytes!");

    await expect(captureRequestedFile(options)).resolves.toMatchObject({
      status: "READ_ERROR",
      failureReason: "Local Blob snapshot digest does not match its CAS path"
    });
    expect(readFileSync(first.localPath, "utf8")).toBe("corrupt bytes!");
  });

  it("records missing and non-regular paths without blocking event capture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-capture-"));
    await expect(captureRequestedFile({
      requestedPath: join(directory, "missing.txt"),
      cwd: directory,
      blobRoot: join(directory, "blobs")
    })).resolves.toMatchObject({ status: "MISSING" });
    await expect(captureRequestedFile({
      requestedPath: directory,
      cwd: directory,
      blobRoot: join(directory, "blobs")
    })).resolves.toMatchObject({ status: "NOT_REGULAR" });
  });

  it("extracts structured/static literals but rejects variables, globs and substitutions", () => {
    expect(extractLiteralFilePaths({
      transcript_path: "/tmp/session.jsonl",
      file_path: "README.md",
      output_path: "https://example.test/not-a-local-file.txt",
      tool_input: {
        command: "cp '/tmp/one file.txt' /tmp/two.txt && cat $HOME/secret && cat /tmp/*.log && cat $(pwd)/x"
      },
      cwd: "/tmp/should-not-be-treated-as-an-attachment"
    })).toEqual(expect.arrayContaining([
      "/tmp/session.jsonl",
      "README.md",
      "/tmp/one file.txt",
      "/tmp/two.txt"
    ]));
    expect(extractLiteralFilePaths({
      output_path: "https://example.test/not-a-local-file.txt"
    })).toEqual([]);
    const result = extractLiteralFilePaths({
      tool_input: { command: "cat $HOME/secret /tmp/*.log $(pwd)/x" }
    });
    expect(result.join(" ")).not.toMatch(/HOME|\*|\$\(/u);
  });

  it("adds pending Blob references while keeping failed files independent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "attachment-stage-"));
    const source = join(directory, "result.txt");
    writeFileSync(source, "full result");
    const outbox = new Outbox(join(directory, "collector.sqlite"));
    open.push(outbox);
    const builder = new AgentCaptureBuilder({
      accountId: "account-1",
      deviceId: "device-1",
      sourceType: "ZCODE",
      sourceInstanceId: "zcode-device-1",
      parserVersion: "zcode-hook-v1",
      sourceSessionId: "session-1",
      startedAt: "2026-08-21T10:00:00.000Z",
      sourceTimeZone: "UTC"
    });
    const event = builder.addEvent({
      sourceEventId: "tool-1",
      sequence: 1,
      kind: "TOOL_RESULT",
      occurredAt: "2026-08-21T10:00:01.000Z",
      toolResult: "result"
    });
    builder.addAttachment({
      eventId: event.eventId,
      purpose: "ATTACHMENT",
      requestedPath: source
    });
    builder.addAttachment({
      eventId: event.eventId,
      purpose: "ATTACHMENT",
      requestedPath: join(directory, "missing.txt")
    });

    const staged = await stageCaptureAttachments({
      capture: builder.finish(),
      outbox,
      blobRoot: join(directory, "blobs"),
      cwd: directory
    });
    const references = staged.records.filter((record) =>
      record.recordType === "BLOB_REFERENCE"
    );

    expect(references).toHaveLength(2);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "PENDING" }),
      expect.objectContaining({ status: "MISSING" })
    ]));
    expect(outbox.listPendingBlobs(10)).toHaveLength(1);
  });
});
