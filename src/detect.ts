import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";
import { projectNameFromRoot, discoverGit } from "./git.js";
import { stableId } from "./id.js";
import { ProjectRecord, ProjectCommands } from "./types.js";

type PackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
};

export async function detectProject(root: string): Promise<ProjectRecord> {
  const git = await discoverGit(root);
  const pkg = await readPackageJson(root);
  const packageManagers = await detectPackageManagers(root);
  const frameworks = detectFrameworks(pkg);
  const languages = await detectLanguages(root);
  const commands = detectCommands(pkg, languages, packageManagers);
  const name = typeof pkg?.name === "string" ? pkg.name : projectNameFromRoot(root, git.remoteUrl);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId: stableId("prj", [git.remoteUrl ?? root, name]),
    name,
    rootPath: root,
    git: {
      remoteUrl: git.remoteUrl,
      defaultBranch: git.defaultBranch,
      currentBranch: git.currentBranch,
      headSha: git.headSha,
    },
    detected: {
      languages,
      frameworks,
      packageManagers,
      commands,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function readPackageJson(root: string): Promise<PackageJson | null> {
  const path = join(root, "package.json");
  if (!(await pathExists(path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
}

export function packageScripts(pkg: PackageJson | null): Record<string, string> {
  if (typeof pkg?.scripts !== "object" || pkg.scripts === null) {
    return {};
  }
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") {
      scripts[key] = value;
    }
  }
  return scripts;
}

export function packageBins(pkg: PackageJson | null): Record<string, string> {
  const bin = pkg?.bin;
  if (typeof bin === "string") {
    const name = typeof pkg?.name === "string" ? pkg.name : "bin";
    return { [name]: bin };
  }
  if (typeof bin !== "object" || bin === null) {
    return {};
  }
  const bins: Record<string, string> = {};
  for (const [key, value] of Object.entries(bin)) {
    if (typeof value === "string") {
      bins[key] = value;
    }
  }
  return bins;
}

function detectCommands(
  pkg: PackageJson | null,
  languages: string[],
  packageManagers: string[],
): ProjectCommands {
  const scripts = packageScripts(pkg);
  if (languages.includes("go") && Object.keys(scripts).length === 0) {
    return {
      typecheck: "go test ./...",
      lint: null,
      format: null,
      test: "go test ./...",
    };
  }
  const packageManager = packageManagers[0] ?? "npm";
  return {
    typecheck:
      scripts["typecheck"] !== undefined ? packageRunCommand(packageManager, "typecheck") : null,
    lint: scripts["lint"] !== undefined ? packageRunCommand(packageManager, "lint") : null,
    format: scripts["format"] !== undefined ? packageRunCommand(packageManager, "format") : null,
    test: scripts["test"] !== undefined ? packageRunCommand(packageManager, "test") : null,
  };
}

function packageRunCommand(packageManager: string, script: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  if (packageManager === "bun") {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

async function detectPackageManagers(root: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lockb"],
  ];
  const found: string[] = [];
  for (const [name, file] of checks) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  if (found.length === 0 && (await pathExists(join(root, "package.json")))) {
    found.push("node");
  }
  return found;
}

function detectFrameworks(pkg: PackageJson | null): string[] {
  const deps = dependencyNames(pkg);
  const frameworks: string[] = [];
  for (const name of ["next", "express", "fastify", "hono", "vitest"]) {
    if (deps.has(name)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

function dependencyNames(pkg: PackageJson | null): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg?.dependencies, pkg?.devDependencies]) {
    if (typeof field !== "object" || field === null) {
      continue;
    }
    for (const name of Object.keys(field)) {
      names.add(name);
    }
  }
  return names;
}

async function detectLanguages(root: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ["typescript", "tsconfig.json"],
    ["javascript", "package.json"],
    ["go", "go.mod"],
    ["rust", "Cargo.toml"],
    ["python", "pyproject.toml"],
  ];
  const languages: string[] = [];
  for (const [language, file] of checks) {
    if (await pathExists(join(root, file))) {
      languages.push(language);
    }
  }
  return languages;
}
