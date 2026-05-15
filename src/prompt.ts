import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchConfig, FeatureRecord, FindingRecord, ProjectRecord } from "./types.js";

export async function buildReviewPrompt(
  root: string,
  project: ProjectRecord,
  feature: FeatureRecord,
  config: ClawpatchConfig,
): Promise<string> {
  const owned = feature.ownedFiles.slice(0, config.review.maxOwnedFiles);
  const context = feature.contextFiles.slice(0, config.review.maxContextFiles);
  const fileBlocks: string[] = [];
  for (const ref of [...owned, ...context]) {
    fileBlocks.push(await fileBlock(root, ref.path));
  }
  return `You are reviewing one semantic feature for clawpatch.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: project.name, detected: project.detected }, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

Review categories:
- correctness bugs
- security issues
- race/concurrency bugs
- data loss/corruption
- resource leaks
- bad error handling
- permission/auth gaps
- API contract mismatches
- missing/weak tests
- release/build hazards
- maintainability risks with concrete impact

Avoid speculative low-evidence findings. Evidence must point at included files.

JSON shape:
{
  "findings": [
    {
      "title": "string",
      "category": "bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "evidence": [{"path":"string","startLine":1,"endLine":1,"symbol":null,"quote":null}],
      "reasoning": "string",
      "reproduction": null,
      "recommendation": "string"
    }
  ],
  "inspected": {"files":["string"],"symbols":["string"],"notes":["string"]}
}

Files:
${fileBlocks.join("\n\n")}`;
}

export async function buildRevalidatePrompt(root: string, findingJson: string): Promise<string> {
  return `Revalidate this clawpatch finding against the current repository at ${root}.

Return strict JSON only:
{"outcome":"fixed|open|false-positive|uncertain","reasoning":"string","commands":["string"]}

Finding:
${findingJson}`;
}

export async function buildFixPrompt(
  root: string,
  finding: FindingRecord,
  feature: FeatureRecord,
): Promise<string> {
  const fileBlocks: string[] = [];
  for (const ref of feature.ownedFiles) {
    fileBlocks.push(await fileBlock(root, ref.path));
  }
  return `You are clawpatch applying one small repair in the current repository.

Fix only the finding below. Keep the patch minimal. Add or update focused tests when feasible.
Do not commit, push, switch branches, or run destructive git commands.
After editing, return strict JSON only:
{
  "summary": "string",
  "findingIds": ["string"],
  "plannedFiles": ["string"],
  "risk": "low|medium|high",
  "steps": ["string"],
  "validationCommands": ["string"]
}

Finding:
${JSON.stringify(finding, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

Owned files:
${fileBlocks.join("\n\n")}`;
}

async function fileBlock(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  if (!isInside(root, full)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => full);
  if (!isInside(realRoot, realFull)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const contents = await readFile(full, "utf8").catch(() => "[unreadable]");
  const trimmed =
    contents.length > 24_000 ? `${contents.slice(0, 24_000)}\n...[truncated]` : contents;
  return `--- ${path}\n${trimmed}`;
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
