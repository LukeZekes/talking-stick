import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { ProtocolError } from "./errors.js";

// Images attached to room messages. Every attachment is a copy in the data
// directory named by its content hash, so a pasted temp file or a moved
// original never breaks a message, and agents on this machine open it with
// their own image tools from the absolute path the message carries.

export interface MessageAttachment {
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** The original file name, when there was one. */
  name?: string;
}

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};

/** The image type of `data` by its magic bytes, or null when it is not one we accept. */
export function sniffImageMime(data: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && Buffer.from(data.subarray(8, 12)).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function attachmentsDir(dataDir: string): string {
  return path.join(dataDir, "attachments");
}

/** Stores image bytes once per content hash and describes the stored copy. */
export function storeAttachment(data: Uint8Array, options: { dataDir: string; name?: string }): MessageAttachment {
  const mime = sniffImageMime(data);
  if (!mime) throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.");
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Images larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cannot be attached.`);
  }
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const dir = attachmentsDir(options.dataDir);
  const file = path.join(dir, `${sha256}.${EXTENSIONS[mime]}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, Buffer.from(data));
  }
  return { path: file, mime, bytes: data.byteLength, sha256, ...(options.name ? { name: options.name } : {}) };
}

/** Copies an image file into the store. */
export function attachFile(file: string, options: { dataDir: string }): MessageAttachment {
  let data: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`${file} is not a file.`);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Images larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cannot be attached.`);
    }
    data = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No such file: ${file}`);
    throw error;
  }
  return storeAttachment(data, { dataDir: options.dataDir, name: path.basename(file) });
}

/**
 * Checks the shape of attachments arriving with a message. The service does
 * not read the files: it only refuses anything that is not a stored image's
 * description, so a message never points an agent at an arbitrary path.
 */
export function validateAttachments(value: unknown, dataDir: string): MessageAttachment[] {
  if (value === undefined || value === null) return [];
  const invalid = (message: string) => new ProtocolError("invalid_attachment", message);
  if (!Array.isArray(value)) throw invalid("attachments must be an array.");
  if (value.length > MAX_ATTACHMENTS) throw invalid(`At most ${MAX_ATTACHMENTS} attachments per message.`);
  const dir = attachmentsDir(dataDir);
  return value.map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const { path: file, mime, bytes, sha256, name } = item;
    if (typeof mime !== "string" || !EXTENSIONS[mime]) throw invalid("Attachments must be PNG, JPEG, GIF, or WebP images.");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw invalid("Attachment sha256 must be 64 hex characters.");
    if (typeof file !== "string" || file !== path.join(dir, `${sha256}.${EXTENSIONS[mime]}`)) {
      throw invalid("Attachments must be stored images (use `tt msg send --attach <file>`).");
    }
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES) {
      throw invalid("Attachment bytes must be a positive size within the limit.");
    }
    const label = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) : "";
    return { path: file, mime, bytes, sha256, ...(label ? { name: label } : {}) };
  });
}

/** The attachments of a message payload, ignoring anything malformed. */
export function payloadAttachments(payload: unknown): MessageAttachment[] {
  const list = (payload as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is MessageAttachment => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return typeof item.path === "string" && typeof item.mime === "string" && typeof item.bytes === "number";
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line per attachment, as the chat shows it; `index` is its place in the message. */
export function describeAttachment(attachment: MessageAttachment, index: number): string {
  return `[Image #${index + 1}: ${attachment.path} (${attachment.mime}, ${formatBytes(attachment.bytes)})]`;
}

/**
 * One line per attachment, as agents receive it. A bare path does not become
 * pixels in every harness (Grok's hooks carry text only), so the line asks
 * for the read that does.
 */
export function attachmentInstruction(attachment: MessageAttachment, index: number): string {
  return `Image #${index + 1} attached at ${attachment.path} (${attachment.mime}, ${formatBytes(attachment.bytes)}). Read that file to see it.`;
}
