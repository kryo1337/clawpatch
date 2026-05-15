import { lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pathExists, nowIso } from "./fs.js";
import { stableId } from "./id.js";
import { readPackageJson, packageBins, packageScripts } from "./detect.js";
import { FeatureRecord, ProjectRecord, TrustBoundary } from "./types.js";

export type MapResult = {
  features: FeatureRecord[];
  created: number;
  changed: number;
  stale: number;
};

type Seed = {
  title: string;
  summary: string;
  kind: FeatureRecord["kind"];
  source: string;
  confidence: FeatureRecord["confidence"];
  entryPath: string;
  symbol: string | null;
  route: string | null;
  command: string | null;
  tags: string[];
  trustBoundaries: TrustBoundary[];
};

export async function mapFeatures(
  root: string,
  project: ProjectRecord,
  existing: FeatureRecord[],
): Promise<MapResult> {
  const seeds = await collectSeeds(root);
  const existingById = new Map(existing.map((feature) => [feature.featureId, feature]));
  const features: FeatureRecord[] = [];
  let created = 0;
  let changed = 0;
  const now = nowIso();
  for (const seed of seeds) {
    const featureId = stableId("feat", [
      seed.kind,
      seed.source,
      seed.entryPath,
      seed.command ?? seed.route ?? seed.symbol ?? "",
    ]);
    const previous = existingById.get(featureId);
    const tests = await nearbyTests(root, seed.entryPath, project.detected.commands.test);
    const feature: FeatureRecord = {
      schemaVersion: 1,
      featureId,
      title: seed.title,
      summary: seed.summary,
      kind: seed.kind,
      source: seed.source,
      confidence: seed.confidence,
      entrypoints: [
        {
          path: seed.entryPath,
          symbol: seed.symbol,
          route: seed.route,
          command: seed.command,
        },
      ],
      ownedFiles: [{ path: seed.entryPath, reason: "entrypoint" }],
      contextFiles: tests.map((test) => ({ path: test.path, reason: "nearby test" })),
      tests,
      tags: seed.tags,
      trustBoundaries: seed.trustBoundaries,
      status: previous?.status ?? "pending",
      lock: previous?.lock ?? null,
      findingIds: previous?.findingIds ?? [],
      patchAttemptIds: previous?.patchAttemptIds ?? [],
      analysisHistory: previous?.analysisHistory ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const featureChanged =
      previous !== undefined &&
      JSON.stringify(stripVolatile(previous)) !== JSON.stringify(stripVolatile(feature));
    if (featureChanged) {
      feature.status = statusForChangedFeature(previous.status);
    } else if (previous?.status === "skipped") {
      feature.status = "pending";
    }
    if (previous === undefined) {
      created += 1;
    } else if (featureChanged || previous.status === "skipped") {
      changed += 1;
    }
    features.push(feature);
  }
  return {
    features,
    created,
    changed,
    stale: existing.filter(
      (feature) => !features.some((mapped) => mapped.featureId === feature.featureId),
    ).length,
  };
}

async function collectSeeds(root: string): Promise<Seed[]> {
  const pkg = await readPackageJson(root);
  const seeds: Seed[] = [];
  for (const [command, path] of Object.entries(packageBins(pkg))) {
    seeds.push({
      title: `CLI command ${command}`,
      summary: `Package bin '${command}' at ${path}.`,
      kind: "cli-command",
      source: "package-json-bin",
      confidence: "high",
      entryPath: normalize(path),
      symbol: null,
      route: null,
      command,
      tags: ["node", "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
    });
  }
  for (const [script, command] of Object.entries(packageScripts(pkg))) {
    if (!["start", "build", "test", "lint", "typecheck", "format"].includes(script)) {
      continue;
    }
    seeds.push({
      title: `Package script ${script}`,
      summary: `Package script '${script}': ${command}`,
      kind: script === "test" ? "test-suite" : "release",
      source: "package-json-script",
      confidence: "medium",
      entryPath: "package.json",
      symbol: script,
      route: null,
      command: script,
      tags: ["node", "package-script"],
      trustBoundaries: script === "test" ? [] : ["process-exec", "filesystem"],
    });
  }
  seeds.push(...(await nextRouteSeeds(root)));
  seeds.push(...(await goSeeds(root)));
  seeds.push(...(await configSeeds(root)));
  return dedupeSeeds(seeds);
}

async function nextRouteSeeds(root: string): Promise<Seed[]> {
  const files = await walk(root, ["app", "pages"]);
  const routeFiles = files.filter(
    (file) =>
      /(^|\/)(page|route)\.(tsx|ts|jsx|js)$/u.test(file) ||
      /^pages\/.+\.(tsx|ts|jsx|js)$/u.test(file),
  );
  return routeFiles.map((file) => ({
    title: `Route ${routeFromFile(file)}`,
    summary: `Web route implemented by ${file}.`,
    kind: "route",
    source: file.startsWith("app/") ? "next-app-route" : "next-pages-route",
    confidence: "high",
    entryPath: file,
    symbol: null,
    route: routeFromFile(file),
    command: null,
    tags: ["next", "web"],
    trustBoundaries: ["user-input", "network", "serialization"],
  }));
}

async function configSeeds(root: string): Promise<Seed[]> {
  const candidates = [
    "package.json",
    "tsconfig.json",
    "oxlint.json",
    "vitest.config.ts",
    "go.mod",
    "Makefile",
  ];
  const seeds: Seed[] = [];
  for (const file of candidates) {
    if (await pathExists(join(root, file))) {
      seeds.push({
        title: `Project config ${file}`,
        summary: `Build, release, or quality configuration in ${file}.`,
        kind: "config",
        source: "shared-infra-heuristic",
        confidence: "medium",
        entryPath: file,
        symbol: null,
        route: null,
        command: null,
        tags: ["config"],
        trustBoundaries: ["process-exec", "filesystem"],
      });
    }
  }
  return seeds;
}

async function goSeeds(root: string): Promise<Seed[]> {
  if (!(await pathExists(join(root, "go.mod")))) {
    return [];
  }
  const seeds: Seed[] = [];
  const cmdFiles = (await walk(root, ["cmd"])).filter((file) =>
    /^cmd\/[^/]+\/main\.go$/u.test(file),
  );
  for (const file of cmdFiles) {
    const command = file.split("/").at(1) ?? "go-command";
    seeds.push({
      title: `Go command ${command}`,
      summary: `Go executable command at ${file}.`,
      kind: "cli-command",
      source: "go-cmd",
      confidence: "high",
      entryPath: file,
      symbol: "main",
      route: null,
      command,
      tags: ["go", "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec", "network"],
    });
  }
  const internalFiles = (await walk(root, ["internal"])).filter(
    (file) => file.endsWith(".go") && !file.endsWith("_test.go"),
  );
  const packages = new Map<string, string[]>();
  for (const file of internalFiles) {
    const packageDir = file.split("/").slice(0, 2).join("/");
    const list = packages.get(packageDir) ?? [];
    list.push(file);
    packages.set(packageDir, list);
  }
  for (const [packageDir, files] of packages) {
    const name = packageDir.split("/").at(-1) ?? packageDir;
    seeds.push({
      title: `Go package ${name}`,
      summary: `Internal Go package ${packageDir}.`,
      kind: packageKind(name),
      source: "go-internal-package",
      confidence: "medium",
      entryPath: files[0] ?? packageDir,
      symbol: null,
      route: null,
      command: null,
      tags: ["go", "internal"],
      trustBoundaries: packageTrustBoundaries(name),
    });
  }
  return seeds;
}

async function nearbyTests(root: string, entryPath: string, testCommand: string | null) {
  const dir = dirname(entryPath);
  const base = entryPath.replace(/\.[^.]+$/u, "");
  const all = await walk(root, [dir === "." ? "" : dir, "test", "tests", "__tests__", "src"]);
  const tests = all
    .filter((path) => /\.(test|spec)\.(ts|tsx|js|jsx)$/u.test(path))
    .filter(
      (path) =>
        path.startsWith(base) ||
        path.includes(
          entryPath
            .split(sep)
            .at(-1)
            ?.replace(/\.[^.]+$/u, "") ?? "",
        ),
    )
    .slice(0, 5);
  return tests.map((path) => ({ path, command: testCommand }));
}

async function walk(root: string, prefixes: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const start = join(root, prefix);
    if (!(await pathExists(start))) {
      continue;
    }
    await walkDir(root, start, files, seen);
  }
  return files.sort();
}

async function walkDir(
  root: string,
  dir: string,
  files: string[],
  seen: Set<string>,
): Promise<void> {
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink()) {
    return;
  }
  const relDir = normalize(relative(root, dir));
  if (shouldSkip(relDir)) {
    return;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = normalize(relative(root, full));
    if (seen.has(rel) || shouldSkip(rel)) {
      continue;
    }
    seen.add(rel);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      await walkDir(root, full, files, seen);
    } else if (info.isFile()) {
      files.push(rel);
    }
  }
}

function shouldSkip(path: string): boolean {
  return path === ""
    ? false
    : /(^|\/)(node_modules|dist|build|coverage|\.git|\.clawpatch)(\/|$)/u.test(path);
}

function routeFromFile(file: string): string {
  let route = file
    .replace(/^app\//u, "/")
    .replace(/^pages\//u, "/")
    .replace(/\/(page|route)\.[^.]+$/u, "")
    .replace(/\.[^.]+$/u, "")
    .replace(/\/index$/u, "")
    .replace(/\[(.+?)\]/gu, ":$1");
  if (route === "") {
    route = "/";
  }
  return route;
}

function packageKind(name: string): Seed["kind"] {
  if (/config|store|db|github|openai|sync/iu.test(name)) {
    return "service";
  }
  if (/cli/iu.test(name)) {
    return "cli-command";
  }
  return "library";
}

function packageTrustBoundaries(name: string): TrustBoundary[] {
  const boundaries: TrustBoundary[] = [];
  if (/config|store|db/iu.test(name)) {
    boundaries.push("filesystem", "database");
  }
  if (/github|openai|sync/iu.test(name)) {
    boundaries.push("network", "external-api", "serialization");
  }
  if (/cli/iu.test(name)) {
    boundaries.push("user-input", "process-exec");
  }
  return boundaries;
}

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function dedupeSeeds(seeds: Seed[]): Seed[] {
  const seen = new Set<string>();
  const output: Seed[] = [];
  for (const seed of seeds) {
    const key = `${seed.kind}:${seed.source}:${seed.entryPath}:${seed.command ?? seed.route ?? seed.symbol ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(seed);
  }
  return output;
}

function stripVolatile(
  feature: FeatureRecord,
): Omit<FeatureRecord, "createdAt" | "updatedAt" | "lock" | "analysisHistory"> {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    lock: _lock,
    analysisHistory: _analysisHistory,
    ...stable
  } = feature;
  return stable;
}

function statusForChangedFeature(status: FeatureRecord["status"]): FeatureRecord["status"] {
  if (["reviewed", "revalidated", "fixed", "skipped"].includes(status)) {
    return "pending";
  }
  return status;
}
