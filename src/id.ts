import { createHash, randomBytes } from "node:crypto";

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);
}

export function stableId(prefix: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);
  const readable = slug(parts.find((part) => part.length > 0) ?? prefix).slice(0, 32);
  return `${prefix}_${readable}_${hash}`;
}

export function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..+$/u, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
