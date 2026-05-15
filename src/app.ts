import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { loadConfig, resolveStateDir, GlobalOptions } from "./config.js";
import { detectProject } from "./detect.js";
import { ClawpatchError, assertDefined } from "./errors.js";
import { runCommand } from "./exec.js";
import { nowIso, writeJson } from "./fs.js";
import { discoverGit, findProjectRoot } from "./git.js";
import { stableId, runId } from "./id.js";
import { mapFeatures } from "./mapper.js";
import { providerByName } from "./provider.js";
import { buildFixPrompt, buildReviewPrompt, buildRevalidatePrompt } from "./prompt.js";
import {
  ensureStateDirs,
  readFeatures,
  readFinding,
  readFindings,
  readProject,
  readRuns,
  statePaths,
  writeFeature,
  writeFinding,
  writePatchAttempt,
  writeProject,
  writeRun,
} from "./state.js";
import {
  CommandResult,
  FeatureRecord,
  FixPlanOutput,
  FindingRecord,
  PatchAttempt,
  RunRecord,
  ReviewOutput,
} from "./types.js";

export type AppContext = {
  root: string;
  options: GlobalOptions;
};

export async function makeContext(options: GlobalOptions): Promise<AppContext> {
  return { root: await findProjectRoot(process.cwd(), options.root), options };
}

export async function initCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const config = await loadConfig(context.root, context.options);
  const stateDir = resolveStateDir(context.root, config);
  const paths = statePaths(stateDir);
  await ensureStateDirs(paths);
  const project = await detectProject(context.root);
  const detectedConfig = { ...config, commands: project.detected.commands };
  const previous = await readProject(paths);
  if (previous !== null && flags["force"] !== true) {
    throw new ClawpatchError("project already initialized; use --force", 2, "already-initialized");
  }
  await writeProject(paths, { ...project, createdAt: previous?.createdAt ?? project.createdAt });
  if (previous === null || flags["force"] === true) {
    await writeJson(paths.config, detectedConfig);
  }
  return {
    created: previous === null,
    project,
    paths: [paths.project, paths.config],
    next: "clawpatch map",
  };
}

export async function mapCommand(
  context: AppContext,
  flags: Record<string, string | boolean> = {},
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const existing = await readFeatures(loaded.paths);
  const result = await mapFeatures(loaded.root, loaded.project, existing);
  const activeFeatureIds = new Set(result.features.map((feature) => feature.featureId));
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      features: result.features.length,
      new: result.created,
      changed: result.changed,
      stale: result.stale,
    };
  }
  for (const feature of result.features) {
    await writeFeature(loaded.paths, feature);
  }
  for (const feature of existing) {
    if (!activeFeatureIds.has(feature.featureId)) {
      await writeFeature(loaded.paths, {
        ...feature,
        status: "skipped",
        lock: null,
        updatedAt: nowIso(),
      });
    }
  }
  return {
    features: result.features.length,
    new: result.created,
    changed: result.changed,
    stale: result.stale,
    next: "clawpatch review --limit 3",
  };
}

export async function statusCommand(context: AppContext): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const [features, findings, runs, git] = await Promise.all([
    readFeatures(loaded.paths),
    readFindings(loaded.paths),
    readRuns(loaded.paths),
    discoverGit(loaded.root),
  ]);
  return {
    project: loaded.project.name,
    branch: git.currentBranch,
    dirty: git.dirty,
    features: features.length,
    findings: findings.length,
    openFindings: findings.filter((finding) => finding.status === "open").length,
    activeLocks: features.filter((feature) => feature.lock !== null).length,
    lastRun: runs.at(-1)?.runId ?? null,
  };
}

export async function reviewCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const config = applyProviderFlags(loaded.config, flags);
  const provider = providerByName(config.provider.name);
  const features = selectFeatures(await readFeatures(loaded.paths), flags);
  if (flags["dryRun"] === true) {
    return {
      dryRun: true,
      wouldReview: features.length,
      featureIds: features.map((feature) => feature.featureId),
    };
  }
  const currentRunId = runId();
  const currentGit = await discoverGit(loaded.root);
  const run = newRun(currentRunId, "review", context, loaded.root, currentGit.headSha);
  run.claimedFeatureIds = features.map((feature) => feature.featureId);
  await writeRun(loaded.paths, run);
  const findingIds: string[] = [];
  for (const feature of features) {
    let locked: FeatureRecord | null = null;
    try {
      const lockedFeature = lockFeature(feature, currentRunId);
      locked = lockedFeature;
      await writeFeature(loaded.paths, lockedFeature);
      const prompt = await buildReviewPrompt(loaded.root, loaded.project, lockedFeature, config);
      const output = await provider.review(loaded.root, prompt, config.provider.model);
      const records = output.findings.map((finding) =>
        findingFromOutput(finding, lockedFeature.featureId, currentRunId),
      );
      for (const finding of records) {
        const existingFinding = await readFinding(loaded.paths, finding.findingId);
        const merged = mergeFinding(existingFinding, finding);
        await writeFinding(loaded.paths, merged);
        findingIds.push(merged.findingId);
      }
      const updated: FeatureRecord = {
        ...lockedFeature,
        status: records.length > 0 ? "needs-fix" : "reviewed",
        lock: null,
        findingIds: Array.from(
          new Set([...lockedFeature.findingIds, ...records.map((finding) => finding.findingId)]),
        ),
        analysisHistory: [
          ...lockedFeature.analysisHistory,
          {
            runId: currentRunId,
            kind: "review",
            summary: `${records.length} finding(s)`,
            provider: provider.name,
            model: config.provider.model,
            createdAt: nowIso(),
          },
        ],
        updatedAt: nowIso(),
      };
      await writeFeature(loaded.paths, updated);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (locked !== null) {
        await writeFeature(loaded.paths, {
          ...locked,
          status: "error",
          lock: null,
          analysisHistory: [
            ...locked.analysisHistory,
            {
              runId: currentRunId,
              kind: "review-error",
              summary: message,
              provider: provider.name,
              model: config.provider.model,
              createdAt: nowIso(),
            },
          ],
          updatedAt: nowIso(),
        });
      }
      await writeRun(loaded.paths, {
        ...run,
        status: "failed",
        finishedAt: nowIso(),
        findingIds,
        errors: [...run.errors, { message, code: null }],
      });
      throw error;
    }
  }
  const finished: RunRecord = {
    ...run,
    status: "completed",
    finishedAt: nowIso(),
    findingIds,
  };
  await writeRun(loaded.paths, finished);
  const reportPath = await writeMarkdownReport(
    loaded.paths.reports,
    currentRunId,
    await readFindings(loaded.paths),
  );
  return {
    run: currentRunId,
    reviewed: features.length,
    findings: findingIds.length,
    report: reportPath,
    next: findingIds.length > 0 ? `clawpatch fix --finding ${findingIds[0]}` : "clawpatch status",
  };
}

export async function reportCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findings = await readFindings(loaded.paths);
  const output = renderReport(findings);
  const outputPath = typeof flags["output"] === "string" ? resolve(flags["output"]) : null;
  if (outputPath !== null) {
    await writeFile(outputPath, output, "utf8");
  }
  return {
    markdown: output,
    output: outputPath,
    findings: findings.length,
  };
}

export async function revalidateCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const finding = assertDefined(
    await readFinding(loaded.paths, findingId),
    `finding not found: ${findingId}`,
  );
  const config = applyProviderFlags(loaded.config, flags);
  const provider = providerByName(config.provider.name);
  const prompt = await buildRevalidatePrompt(loaded.root, JSON.stringify(finding, null, 2));
  const output = await provider.revalidate(loaded.root, prompt, config.provider.model);
  const updated: FindingRecord = {
    ...finding,
    status: output.outcome,
    updatedAt: nowIso(),
  };
  await writeFinding(loaded.paths, updated);
  return { finding: findingId, outcome: output.outcome, reasoning: output.reasoning };
}

export async function fixCommand(
  context: AppContext,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const findingId = assertDefined(stringFlag(flags, "finding"), "missing --finding");
  const config = applyProviderFlags(loaded.config, flags);
  const git = await discoverGit(loaded.root);
  const dirty = await hasSourceDirtyWorktree(loaded.root, loaded.paths.stateDir);
  if (config.git.requireCleanWorktreeForFix && dirty && flags["dryRun"] !== true) {
    throw new ClawpatchError(
      "dirty worktree blocks fix; commit/stash first or use --dry-run",
      3,
      "dirty-worktree",
    );
  }
  const finding = assertDefined(
    await readFinding(loaded.paths, findingId),
    `finding not found: ${findingId}`,
  );
  const features = await readFeatures(loaded.paths);
  const feature = assertDefined(
    features.find((candidate) => candidate.featureId === finding.featureId),
    `feature not found: ${finding.featureId}`,
  );
  const patchAttemptId = stableId("pat", [finding.findingId, nowIso()]);
  const provider = providerByName(config.provider.name);
  const createdAt = nowIso();
  const initialPatch: PatchAttempt = {
    schemaVersion: 1,
    patchAttemptId,
    findingIds: [finding.findingId],
    featureIds: [feature.featureId],
    status: "planned",
    plan: `Fix ${finding.title}`,
    filesChanged: [],
    commandsRun: [],
    testResults: [],
    provider: null,
    git: {
      baseSha: git.headSha,
      commitSha: null,
      branchName: git.currentBranch,
      prUrl: null,
    },
    createdAt,
    updatedAt: createdAt,
  };
  const prompt = await buildFixPrompt(loaded.root, finding, feature);
  if (flags["dryRun"] === true) {
    return {
      finding: finding.findingId,
      dryRun: true,
      patchAttempt: patchAttemptId,
      plan: initialPatch.plan,
    };
  }
  await writePatchAttempt(loaded.paths, initialPatch);
  const startedAt = nowIso();
  const beforeChanged = (await sourceChangedPaths(loaded.root, loaded.paths.stateDir)) ?? new Set();
  let plan: FixPlanOutput;
  try {
    plan = await provider.fix(loaded.root, prompt, config.provider.model);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await writePatchAttempt(loaded.paths, {
      ...initialPatch,
      status: "failed",
      plan: `${initialPatch.plan}\n\nProvider failed: ${message}`,
      provider: {
        name: provider.name,
        model: config.provider.model,
        requestId: null,
        startedAt,
        finishedAt: nowIso(),
      },
      updatedAt: nowIso(),
    });
    await writeFinding(loaded.paths, {
      ...finding,
      linkedPatchAttemptIds: Array.from(
        new Set([...finding.linkedPatchAttemptIds, patchAttemptId]),
      ),
      updatedAt: nowIso(),
    });
    throw error;
  }
  const validationCommands = collectValidationCommands(config.commands);
  const commandsRun: CommandResult[] = [];
  for (const command of validationCommands) {
    commandsRun.push(await runCommand(command, loaded.root));
  }
  const afterChanged = (await sourceChangedPaths(loaded.root, loaded.paths.stateDir)) ?? new Set();
  const filesChanged = Array.from(afterChanged).filter((path) => !beforeChanged.has(path));
  const failed = commandsRun.some((result) => result.exitCode !== 0);
  const patch: PatchAttempt = {
    ...initialPatch,
    status: failed ? "failed" : "applied",
    plan: plan.summary,
    filesChanged,
    commandsRun,
    testResults: commandsRun,
    provider: {
      name: provider.name,
      model: config.provider.model,
      requestId: null,
      startedAt,
      finishedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
  await writePatchAttempt(loaded.paths, patch);
  const updatedFinding: FindingRecord = {
    ...finding,
    linkedPatchAttemptIds: Array.from(new Set([...finding.linkedPatchAttemptIds, patchAttemptId])),
    status: failed ? "open" : "uncertain",
    updatedAt: nowIso(),
  };
  await writeFinding(loaded.paths, updatedFinding);
  if (failed) {
    throw new ClawpatchError("validation failed after applying fix", 6, "validation-failed");
  }
  return {
    finding: finding.findingId,
    dryRun: false,
    patchAttempt: patchAttemptId,
    status: patch.status,
    filesChanged: filesChanged.length,
    commands: commandsRun.length,
    next: failed
      ? `inspect ${patchAttemptId}`
      : `clawpatch revalidate --finding ${finding.findingId}`,
  };
}

function mergeFinding(existing: FindingRecord | null, incoming: FindingRecord): FindingRecord {
  if (existing === null) {
    return incoming;
  }
  return {
    ...incoming,
    status: existing.status,
    linkedPatchAttemptIds: existing.linkedPatchAttemptIds,
    createdByRunId: existing.createdByRunId,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
}

export async function doctorCommand(context: AppContext): Promise<unknown> {
  const loaded = await loadProjectState(context).catch(() => null);
  const root = loaded?.root ?? context.root;
  const providerName = loaded?.config.provider.name ?? "codex";
  const provider = providerByName(providerName);
  const providerVersion = await provider.check(root);
  return {
    root,
    state: loaded === null ? "missing" : "ok",
    provider: providerName,
    providerVersion,
    secrets: "redacted",
  };
}

export async function cleanLocksCommand(context: AppContext): Promise<unknown> {
  const loaded = await loadProjectState(context);
  const features = await readFeatures(loaded.paths);
  let cleared = 0;
  for (const feature of features) {
    if (feature.lock === null) {
      continue;
    }
    await writeFeature(loaded.paths, {
      ...feature,
      status: feature.status === "claimed" ? "pending" : feature.status,
      lock: null,
      updatedAt: nowIso(),
    });
    cleared += 1;
  }
  return { cleared };
}

async function loadProjectState(context: AppContext) {
  const config = await loadConfig(context.root, context.options);
  const paths = statePaths(resolveStateDir(context.root, config));
  const project = await readProject(paths);
  if (project === null) {
    throw new ClawpatchError("not initialized; run clawpatch init", 2, "not-initialized");
  }
  await ensureStateDirs(paths);
  return { root: context.root, config, paths, project };
}

function applyProviderFlags(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: Record<string, string | boolean>,
) {
  const providerName = stringFlag(flags, "provider");
  const model = stringFlag(flags, "model");
  return {
    ...config,
    provider: {
      ...config.provider,
      name: providerName ?? config.provider.name,
      model: model ?? config.provider.model,
    },
  };
}

function collectValidationCommands(commands: {
  typecheck: string | null;
  lint: string | null;
  format: string | null;
  test: string | null;
}): string[] {
  const ordered = [commands.format, commands.typecheck, commands.lint, commands.test].filter(
    (command): command is string => command !== null && command.length > 0,
  );
  return Array.from(new Set(ordered));
}

async function hasSourceDirtyWorktree(root: string, stateDir: string): Promise<boolean> {
  const paths = await sourceChangedPaths(root, stateDir);
  return paths === null || paths.size > 0;
}

async function sourceChangedPaths(root: string, stateDir: string): Promise<Set<string> | null> {
  const result = await runCommand("git status --porcelain", root);
  if (result.exitCode !== 0) {
    return null;
  }
  const relativeStateDir = normalizePath(relative(root, stateDir));
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => normalizePath(line.slice(3).trim()))
      .filter((path) => path.length > 0 && !isStatePath(path, relativeStateDir)),
  );
}

function isStatePath(path: string, relativeStateDir: string): boolean {
  if (relativeStateDir === "" || relativeStateDir.startsWith("..")) {
    return false;
  }
  return path === relativeStateDir || path.startsWith(`${relativeStateDir}/`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/$/u, "");
}

function selectFeatures(
  features: FeatureRecord[],
  flags: Record<string, string | boolean>,
): FeatureRecord[] {
  const featureId = stringFlag(flags, "feature");
  const limit = Number(stringFlag(flags, "limit") ?? "1");
  const selected =
    featureId === undefined
      ? features.filter((feature) => ["pending", "error"].includes(feature.status))
      : features.filter((feature) => feature.featureId === featureId);
  return selected.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 1);
}

function lockFeature(feature: FeatureRecord, currentRunId: string): FeatureRecord {
  if (feature.lock !== null) {
    throw new ClawpatchError(`feature locked: ${feature.featureId}`, 7, "lock-conflict");
  }
  return {
    ...feature,
    status: "claimed",
    lock: {
      lockedByRunId: currentRunId,
      lockedAt: nowIso(),
      hostname: hostname(),
      pid: process.pid,
    },
    updatedAt: nowIso(),
  };
}

function findingFromOutput(
  finding: ReviewOutput["findings"][number],
  featureId: string,
  currentRunId: string,
): FindingRecord {
  const signature = stableId("sig", [
    featureId,
    finding.category,
    finding.title,
    JSON.stringify(finding.evidence),
  ]);
  const now = nowIso();
  return {
    schemaVersion: 1,
    findingId: stableId("fnd", [signature]),
    featureId,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    evidence: finding.evidence,
    reasoning: finding.reasoning,
    reproduction: finding.reproduction,
    recommendation: finding.recommendation,
    status: "open",
    signature,
    linkedPatchAttemptIds: [],
    createdByRunId: currentRunId,
    createdAt: now,
    updatedAt: now,
  };
}

function newRun(
  id: string,
  command: string,
  context: AppContext,
  root: string,
  headSha: string | null,
): RunRecord {
  return {
    schemaVersion: 1,
    runId: id,
    command,
    args: process.argv.slice(2),
    rootPath: root,
    headSha,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    claimedFeatureIds: [],
    findingIds: [],
    patchAttemptIds: [],
    errors: [],
  };
}

async function writeMarkdownReport(
  reportDir: string,
  id: string,
  findings: FindingRecord[],
): Promise<string> {
  const path = join(reportDir, `${id}.md`);
  await writeFile(path, renderReport(findings), "utf8");
  return path;
}

function renderReport(findings: FindingRecord[]): string {
  const lines = ["# clawpatch report", "", `findings: ${findings.length}`, ""];
  for (const finding of findings) {
    lines.push(`## ${finding.severity}: ${finding.title}`);
    lines.push("");
    lines.push(`category: ${finding.category}`);
    lines.push(`confidence: ${finding.confidence}`);
    lines.push(`status: ${finding.status}`);
    lines.push(`feature: ${finding.featureId}`);
    lines.push("");
    lines.push(finding.reasoning);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}
