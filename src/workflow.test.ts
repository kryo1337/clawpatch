import { describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  fixCommand,
  cleanLocksCommand,
  initCommand,
  makeContext,
  mapCommand,
  reportCommand,
  reviewCommand,
  statusCommand,
} from "./app.js";
import { parseArgs } from "./cli.js";
import { loadConfig } from "./config.js";
import { runCommand } from "./exec.js";
import {
  readFeatures,
  readFindings,
  readProject,
  readPatchAttempts,
  readRuns,
  statePaths,
  writeFeature,
  writeFinding,
} from "./state.js";
import { buildReviewPrompt } from "./prompt.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";

describe("workflow", () => {
  it("rejects unknown long flags", () => {
    expect(() => parseArgs(["fix", "--finding", "f", "--dryrun"])).toThrow("unknown arg");
  });

  it("rejects nonexistent explicit roots before init", async () => {
    const root = join(await fixtureRoot("clawpatch-missing-root-parent-"), "missing");

    await expect(makeContext(testOptions(root))).rejects.toMatchObject({ exitCode: 2 });
  });

  it("initializes, maps, reviews, and reports findings", async () => {
    const root = await fixtureRoot("clawpatch-flow-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "buggy-cli",
          bin: { buggy: "src/index.ts" },
          scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const mapped = await mapCommand(context);
    const reviewed = await reviewCommand(context, { limit: "1" });
    const status = await statusCommand(context);
    const report = await reportCommand(context, {});

    expect(mapped).toMatchObject({ new: expect.any(Number) });
    expect(reviewed).toMatchObject({ findings: 1 });
    expect(status).toMatchObject({ openFindings: 1 });
    expect(report).toMatchObject({ findings: 1 });
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("does not consume features on dry-run review", async () => {
    const root = await fixtureRoot("clawpatch-dry-run-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "dry-run-cli", bin: { dry: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { dryRun: true });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features[0]?.status).toBe("pending");
  });

  it("does not mutate features on dry-run map", async () => {
    const root = await fixtureRoot("clawpatch-map-dry-run-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "map-dry-run-cli", bin: { dry: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(root, "package.json", JSON.stringify({ name: "map-dry-run-cli" }));
    const preview = await mapCommand(context, { dryRun: true });
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(preview).toMatchObject({ dryRun: true, stale: 1 });
    expect(features.some((feature) => feature.status === "skipped")).toBe(false);
  });

  it("does not recurse through symlinked mapper directories", async () => {
    const root = await fixtureRoot("clawpatch-map-symlink-root-");
    const external = await fixtureRoot("clawpatch-map-symlink-external-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "map-symlink" }));
    await writeFixture(external, "page.tsx", "export default function Page() { return null; }\n");
    await symlink(external, join(root, "app"), "dir");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features.some((feature) => feature.source === "next-app-route")).toBe(false);
  });

  it("seeds config commands from detected package scripts and package manager", async () => {
    const root = await fixtureRoot("clawpatch-config-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "npm-cli",
        scripts: { typecheck: "tsc --noEmit", test: "node --test" },
      }),
    );
    await writeFixture(root, "package-lock.json", "{}");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const config = JSON.parse(await readFile(join(root, ".clawpatch/config.json"), "utf8")) as {
      commands: { typecheck: string; test: string };
    };

    expect(config.commands.typecheck).toBe("npm run typecheck");
    expect(config.commands.test).toBe("npm run test");
  });

  it("honors CLAWPATCH_STATE_DIR during init", async () => {
    const root = await fixtureRoot("clawpatch-env-state-root-");
    const stateDir = await fixtureRoot("clawpatch-env-state-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "env-state" }));
    process.env["CLAWPATCH_STATE_DIR"] = stateDir;
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(stateDir));

    expect(project?.name).toBe("env-state");
    await expect(access(join(root, ".clawpatch"))).rejects.toThrow();
    delete process.env["CLAWPATCH_STATE_DIR"];
  });

  it("allows fix dry-run when only the default state dir is dirty", async () => {
    const root = await fixtureRoot("clawpatch-state-dirty-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding, dryRun: true });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ dryRun: true });
    expect(patches).toEqual([]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("retires stale features when seeds disappear", async () => {
    const root = await fixtureRoot("clawpatch-stale-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-cli", bin: { stale: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await unlink(join(root, "src/index.ts"));
    await writeFixture(root, "package.json", JSON.stringify({ name: "stale-cli" }));
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features.some((feature) => feature.status === "skipped")).toBe(true);
  });

  it("counts stale features by missing ids", async () => {
    const root = await fixtureRoot("clawpatch-stale-count-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-count", bin: { old: "src/old.ts" } }),
    );
    await writeFixture(root, "src/old.ts", "export const oldValue = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "stale-count", bin: { next: "src/next.ts" } }),
    );
    await writeFixture(root, "src/next.ts", "export const nextValue = 1;\n");
    const mapped = await mapCommand(context);

    expect(mapped).toMatchObject({ stale: 1 });
  });

  it("requeues restored skipped features", async () => {
    const root = await fixtureRoot("clawpatch-restore-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "restore-cli", bin: { restore: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await unlink(join(root, "src/index.ts"));
    await writeFixture(root, "package.json", JSON.stringify({ name: "restore-cli" }));
    await mapCommand(context);
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "restore-cli", bin: { restore: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const restored = features.find((feature) => feature.title === "CLI command restore");

    expect(restored?.status).toBe("pending");
  });

  it("releases feature locks on provider review failure", async () => {
    const root = await fixtureRoot("clawpatch-lock-fail-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "lock-cli", bin: { lock: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await expect(reviewCommand(context, { provider: "mock-fail" })).rejects.toThrow(
      "mock review failure",
    );
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));

    expect(features[0]?.status).toBe("error");
    expect(features[0]?.lock).toBeNull();
    await rm(join(root, ".clawpatch"), { recursive: true, force: true });
  });

  it("does not create state directories for status before init", async () => {
    const root = await fixtureRoot("clawpatch-readonly-");
    const context = await makeContext(testOptions(root));

    await expect(statusCommand(context)).rejects.toThrow("not initialized");
    await expect(access(join(root, ".clawpatch"))).rejects.toThrow();
  });

  it("loads config from custom state directories", async () => {
    const root = await fixtureRoot("clawpatch-custom-state-root-");
    const stateDir = await fixtureRoot("clawpatch-custom-state-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "custom-state",
        scripts: { test: "node --test" },
      }),
    );
    await writeFixture(root, "package-lock.json", "{}");
    const options = { ...testOptions(root), stateDir };
    const context = await makeContext(options);

    await initCommand(context, {});
    const config = await loadConfig(root, options);

    expect(config.commands.test).toBe("npm run test");
  });

  it("clean-locks requeues claimed features", async () => {
    const root = await fixtureRoot("clawpatch-clean-locks-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "clean-locks", bin: { clean: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await writeFeature(paths, {
      ...feature!,
      status: "claimed",
      lock: {
        lockedByRunId: "run",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      },
    });
    await cleanLocksCommand(context);
    const cleaned = (await readFeatures(paths))[0];

    expect(cleaned?.status).toBe("pending");
    expect(cleaned?.lock).toBeNull();
  });

  it("filters state files from successful fix results", async () => {
    const root = await fixtureRoot("clawpatch-filter-state-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    const fixed = await fixCommand(context, { finding });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(fixed).toMatchObject({ status: "applied", filesChanged: 0 });
    expect(patches[0]?.filesChanged).toEqual([]);
    await expect(access(join(root, "SHOULD_NOT_RUN_PROVIDER_COMMANDS"))).rejects.toThrow();
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("blocks fix when git cleanliness cannot be verified", async () => {
    const root = await fixtureRoot("clawpatch-non-git-fix-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({
      code: "dirty-worktree",
    });

    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("fails fix when configured validation fails", async () => {
    const root = await fixtureRoot("clawpatch-validation-fail-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({
        name: "buggy",
        bin: { buggy: "src/index.ts" },
        scripts: { test: "exit 1" },
      }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding })).rejects.toMatchObject({ exitCode: 6 });
    const patches = await readPatchAttempts(statePaths(join(root, ".clawpatch")));

    expect(patches[0]?.status).toBe("failed");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("marks review runs failed on lock conflicts", async () => {
    const root = await fixtureRoot("clawpatch-lock-conflict-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "lock-conflict", bin: { lock: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 1;\n");
    const context = await makeContext(testOptions(root));
    const paths = statePaths(join(root, ".clawpatch"));

    await initCommand(context, {});
    await mapCommand(context);
    const feature = (await readFeatures(paths))[0];
    expect(feature).toBeDefined();
    await writeFeature(paths, {
      ...feature!,
      lock: {
        lockedByRunId: "existing",
        lockedAt: new Date().toISOString(),
        hostname: "test",
        pid: 1,
      },
    });

    await expect(reviewCommand(context, { feature: feature!.featureId })).rejects.toThrow(
      "feature locked",
    );
    const runs = await readRuns(paths);

    expect(runs[0]?.status).toBe("failed");
  });

  it("requeues changed reviewed features after remapping", async () => {
    const root = await fixtureRoot("clawpatch-requeue-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "requeue", scripts: { test: "echo old" } }),
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "2" });
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "requeue", scripts: { test: "echo new" } }),
    );
    await mapCommand(context);
    const features = await readFeatures(statePaths(join(root, ".clawpatch")));
    const testFeature = features.find((feature) => feature.title === "Package script test");

    expect(testFeature?.summary).toContain("echo new");
    expect(testFeature?.status).toBe("pending");
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("preserves finding status and patch links on repeated review", async () => {
    const root = await fixtureRoot("clawpatch-merge-finding-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "merge-finding", bin: { merge: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    await reviewCommand(context, { limit: "1" });
    const paths = statePaths(join(root, ".clawpatch"));
    const finding = (await readFindings(paths))[0];
    expect(finding).toBeDefined();
    await writeFinding(paths, {
      ...finding!,
      status: "fixed",
      linkedPatchAttemptIds: ["pat_existing"],
    });
    await reviewCommand(context, { feature: finding!.featureId });
    const reviewedAgain = (await readFindings(paths))[0];

    expect(reviewedAgain?.status).toBe("fixed");
    expect(reviewedAgain?.linkedPatchAttemptIds).toEqual(["pat_existing"]);
    delete process.env["CLAWPATCH_PROVIDER"];
  });

  it("does not include escaped feature paths in prompts", async () => {
    const root = await fixtureRoot("clawpatch-path-escape-");
    const siblingSecret = join(root, "..", "secret.txt");
    await writeFixture(root, "package.json", JSON.stringify({ name: "path-escape" }));
    await writeFixture(root, "../secret.txt", "do-not-read\n");
    await mkdir(join(root, "src"), { recursive: true });
    await symlink(siblingSecret, join(root, "src/index.ts"));
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    const project = await readProject(statePaths(join(root, ".clawpatch")));
    expect(project).toBeDefined();
    const prompt = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_escape",
        title: "escape",
        summary: siblingSecret,
        kind: "config",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "../secret.txt", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "../secret.txt", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
    );

    expect(prompt).toContain("[skipped: path escapes repository root]");
    expect(prompt).not.toContain("do-not-read");

    const symlinkPrompt = await buildReviewPrompt(
      root,
      project!,
      {
        schemaVersion: 1,
        featureId: "feat_symlink",
        title: "symlink",
        summary: "symlink",
        kind: "config",
        source: "test",
        confidence: "high",
        entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
        ownedFiles: [{ path: "src/index.ts", reason: "test" }],
        contextFiles: [],
        tests: [],
        tags: [],
        trustBoundaries: [],
        status: "pending",
        lock: null,
        findingIds: [],
        patchAttemptIds: [],
        analysisHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      await loadConfig(root, testOptions(root)),
    );

    expect(symlinkPrompt).toContain("[skipped: path escapes repository root]");
    expect(symlinkPrompt).not.toContain("do-not-read");
  });

  it("persists failed patch attempts when provider fix throws", async () => {
    const root = await fixtureRoot("clawpatch-fix-fail-");
    await runCommand(
      "git init -q && git config user.email test@example.com && git config user.name Test",
      root,
    );
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "buggy", bin: { buggy: "src/index.ts" } }),
    );
    await writeFixture(root, "src/index.ts", "export const value = 'TODO_BUG';\n");
    await runCommand(
      "git add package.json src/index.ts && git -c commit.gpgsign=false commit -q -m init",
      root,
    );
    process.env["CLAWPATCH_PROVIDER"] = "mock";
    const context = await makeContext(testOptions(root));

    await initCommand(context, {});
    await mapCommand(context);
    const reviewed = (await reviewCommand(context, { limit: "1" })) as { next: string };
    const finding = reviewed.next.split(" ").at(-1) ?? "";
    await expect(fixCommand(context, { finding, provider: "mock-fail" })).rejects.toThrow(
      "mock fix failure",
    );
    const paths = statePaths(join(root, ".clawpatch"));
    const patches = await readPatchAttempts(paths);
    const findings = await readFindings(paths);

    expect(patches[0]?.status).toBe("failed");
    expect(findings[0]?.linkedPatchAttemptIds).toContain(patches[0]?.patchAttemptId);
    delete process.env["CLAWPATCH_PROVIDER"];
  });
});
