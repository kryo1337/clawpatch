import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

type PythonProjectInfo = {
  dependencies: Set<string>;
  tools: Set<string>;
  hasPytestConfig: boolean;
};

const dotnetDiscoveryDepth = 7;

export async function detectProject(root: string): Promise<ProjectRecord> {
  const git = await discoverGit(root);
  const pkg = await readPackageJson(root);
  const packageManagers = await detectPackageManagers(root);
  const languages = await detectLanguages(root);
  const frameworks = await detectFrameworks(root, pkg);
  const commands = await detectCommands(root, pkg, languages, packageManagers);
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

async function detectCommands(
  root: string,
  pkg: PackageJson | null,
  languages: string[],
  packageManagers: string[],
): Promise<ProjectCommands> {
  const scripts = packageScripts(pkg);
  const defaults = await languageDefaultCommands(root, languages);
  const packageManager = packageScriptManager(packageManagers);
  return {
    typecheck:
      scripts["typecheck"] !== undefined
        ? packageRunCommand(packageManager, "typecheck")
        : defaults.typecheck,
    lint: scripts["lint"] !== undefined ? packageRunCommand(packageManager, "lint") : defaults.lint,
    format:
      scripts["format"] !== undefined
        ? packageRunCommand(packageManager, "format")
        : defaults.format,
    test: scripts["test"] !== undefined ? packageRunCommand(packageManager, "test") : defaults.test,
  };
}

async function languageDefaultCommands(
  root: string,
  languages: string[],
): Promise<ProjectCommands> {
  if (languages.includes("go")) {
    return {
      typecheck: "go test ./...",
      lint: null,
      format: null,
      test: "go test ./...",
    };
  }
  if (languages.includes("rust")) {
    return {
      typecheck: "cargo check --workspace --all-targets",
      lint: null,
      format: "cargo fmt --all --check",
      test: "cargo test --workspace",
    };
  }
  if (languages.includes("swift") && (await pathExists(join(root, "Package.swift")))) {
    return {
      typecheck: "swift build",
      lint: null,
      format: null,
      test: (await hasSwiftTests(root)) ? "swift test" : null,
    };
  }
  if (languages.includes("python")) {
    return pythonDefaultCommands(root);
  }
  if (languages.includes("csharp")) {
    return dotnetDefaultCommands(root);
  }

  return {
    typecheck: null,
    lint: null,
    format: null,
    test: null,
  };
}

function packageScriptManager(packageManagers: string[]): string {
  return packageManagers.find((name) => nodePackageManagers.has(name)) ?? "npm";
}

const nodePackageManagers = new Set(["pnpm", "npm", "yarn", "bun", "node"]);

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
  const found: string[] = [];
  const nodeChecks: Array<[string, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lockb"],
  ];
  for (const [name, file] of nodeChecks) {
    if ((await pathExists(join(root, file))) && !found.includes(name)) {
      found.push(name);
    }
  }
  if ((await pathExists(join(root, "pnpm-workspace.yaml"))) && !found.includes("pnpm")) {
    found.push("pnpm");
  }
  if (
    !found.some((name) => nodePackageManagers.has(name)) &&
    (await pathExists(join(root, "package.json")))
  ) {
    found.push("node");
  }

  const nativeChecks: Array<[string, string]> = [
    ["cargo", "Cargo.toml"],
    ["swiftpm", "Package.swift"],
  ];
  for (const [name, file] of nativeChecks) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  if (!found.includes("swiftpm") && (await containsFileNamed(root, "Package.swift", 5))) {
    found.push("swiftpm");
  }
  if (
    !found.includes("gradle") &&
    ((await containsFileNamed(root, "settings.gradle", 5)) ||
      (await containsFileNamed(root, "settings.gradle.kts", 5)) ||
      (await containsFileNamed(root, "build.gradle", 5)) ||
      (await containsFileNamed(root, "build.gradle.kts", 5)))
  ) {
    found.push("gradle");
  }
  if (
    !found.includes("dotnet") &&
    ((await containsFileWithExtension(root, ".csproj", dotnetDiscoveryDepth)) ||
      (await containsFileWithExtension(root, ".sln", dotnetDiscoveryDepth)) ||
      (await containsFileWithExtension(root, ".slnx", dotnetDiscoveryDepth)))
  ) {
    found.push("dotnet");
  }
  const pythonManagers: Array<[string, string]> = [
    ["uv", "uv.lock"],
    ["poetry", "poetry.lock"],
    ["pdm", "pdm.lock"],
    ["hatch", "hatch.toml"],
  ];
  for (const [name, file] of pythonManagers) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  for (const tool of ["uv", "poetry", "pdm", "hatch"]) {
    if (!found.includes(tool) && (await pyprojectHasToolSection(root, tool))) {
      found.push(tool);
    }
  }
  if (!found.some((name) => pythonPackageManagers.has(name)) && (await isPythonProject(root))) {
    found.push((await pathExists(join(root, "requirements.txt"))) ? "pip" : "python");
  }
  return found;
}

const pythonPackageManagers = new Set(["uv", "poetry", "pdm", "hatch", "pip", "python"]);

async function pythonDefaultCommands(root: string): Promise<ProjectCommands> {
  const info = await pythonProjectInfo(root);
  const runner = await pythonRunner(root);
  const hasPytest =
    info.hasPytestConfig ||
    info.dependencies.has("pytest") ||
    (await containsPythonTestFile(root, 5));
  const hasRuff = info.tools.has("ruff") || info.dependencies.has("ruff");
  const hasPyright = info.tools.has("pyright") || info.dependencies.has("pyright");
  const hasMypy = info.tools.has("mypy") || info.dependencies.has("mypy");
  return {
    typecheck: hasPyright
      ? pythonRunCommand(runner, "pyright")
      : hasMypy
        ? pythonRunCommand(runner, "mypy .")
        : hasRuff
          ? pythonRunCommand(runner, "ruff check .")
          : null,
    lint: hasRuff ? pythonRunCommand(runner, "ruff check .") : null,
    format: hasRuff ? pythonRunCommand(runner, "ruff format --check .") : null,
    test: hasPytest ? pythonRunCommand(runner, "pytest") : null,
  };
}

async function dotnetDefaultCommands(root: string): Promise<ProjectCommands> {
  const target = await dotnetCommandTarget(root);
  if (target === null) {
    if (!(await hasDotnetCommandTarget(root))) {
      return {
        typecheck: null,
        lint: null,
        format: null,
        test: null,
      };
    }
    return {
      typecheck: "dotnet build",
      lint: null,
      format: null,
      test: (await containsDotnetTestSignal(root, dotnetDiscoveryDepth)) ? "dotnet test" : null,
    };
  }
  return {
    typecheck: `dotnet build ${target}`,
    lint: null,
    format: null,
    test: (await containsDotnetTestSignal(root, dotnetDiscoveryDepth))
      ? `dotnet test ${target}`
      : null,
  };
}

async function dotnetCommandTarget(root: string): Promise<string | null> {
  const solutions = await filesWithExtensions(root, [".sln", ".slnx"], dotnetDiscoveryDepth);
  if (solutions.length === 1) {
    return solutions[0] ?? null;
  }
  if (solutions.length > 1) {
    const rootSolution = solutions.find((file) => !file.includes("/"));
    if (rootSolution !== undefined) {
      return rootSolution;
    }
    return null;
  }
  const projects = await filesWithExtensions(root, [".csproj"], dotnetDiscoveryDepth);
  return projects.length === 1 ? (projects[0] ?? null) : null;
}

async function hasDotnetCommandTarget(root: string): Promise<boolean> {
  return (
    (await containsFileWithExtension(root, ".csproj", dotnetDiscoveryDepth)) ||
    (await containsFileWithExtension(root, ".sln", dotnetDiscoveryDepth)) ||
    (await containsFileWithExtension(root, ".slnx", dotnetDiscoveryDepth))
  );
}

async function containsDotnetTestSignal(root: string, maxDepth: number): Promise<boolean> {
  if (
    await containsFileMatching(root, maxDepth, (entry) =>
      ["xunit.runner.json", ".runsettings"].includes(entry),
    )
  ) {
    return true;
  }
  for (const file of await filesWithExtensions(root, [".cs"], maxDepth)) {
    if (/(^|\/)(tests?|[^/]+Tests)(\/|$)/iu.test(file) || file.endsWith("Tests.cs")) {
      return true;
    }
    const source = await readFile(join(root, file), "utf8").catch(() => "");
    if (/\[(Fact|Theory|Test|TestMethod)\b/u.test(source)) {
      return true;
    }
  }
  for (const project of await filesWithExtensions(root, [".csproj"], maxDepth)) {
    const source = await readFile(join(root, project), "utf8").catch(() => "");
    if (
      /<IsTestProject>\s*true\s*<\/IsTestProject>/iu.test(source) ||
      /PackageReference\b[^>]*Include="(?:Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest\.TestFramework)"/iu.test(
        source,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function pythonRunner(root: string): Promise<string | null> {
  if ((await pathExists(join(root, "uv.lock"))) || (await pyprojectHasToolSection(root, "uv"))) {
    return "uv";
  }
  if (
    (await pathExists(join(root, "poetry.lock"))) ||
    (await pyprojectHasToolSection(root, "poetry"))
  ) {
    return "poetry";
  }
  if ((await pathExists(join(root, "pdm.lock"))) || (await pyprojectHasToolSection(root, "pdm"))) {
    return "pdm";
  }
  if (
    (await pathExists(join(root, "hatch.toml"))) ||
    (await pyprojectHasToolSection(root, "hatch"))
  ) {
    return "hatch";
  }
  return null;
}

async function pyprojectHasToolSection(root: string, tool: string): Promise<boolean> {
  if (!(await pathExists(join(root, "pyproject.toml")))) {
    return false;
  }
  const source = await readFile(join(root, "pyproject.toml"), "utf8");
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*\\[\\[?tool\\.${escaped}(?:\\.|\\])`, "mu").test(source);
}

function pythonRunCommand(runner: string | null, command: string): string {
  if (runner === "uv") {
    return `uv run ${command}`;
  }
  if (runner === "poetry") {
    return `poetry run ${command}`;
  }
  if (runner === "pdm") {
    return `pdm run ${command}`;
  }
  if (runner === "hatch") {
    return `hatch run ${command}`;
  }
  return command;
}

async function pythonProjectInfo(root: string): Promise<PythonProjectInfo> {
  const info: PythonProjectInfo = {
    dependencies: new Set(),
    tools: new Set(),
    hasPytestConfig: false,
  };
  if (await pathExists(join(root, "pyproject.toml"))) {
    const pyproject = await readFile(join(root, "pyproject.toml"), "utf8");
    for (const dependency of pythonDependencyNames(pyproject)) {
      info.dependencies.add(dependency);
    }
    for (const tool of pythonToolSections(pyproject)) {
      info.tools.add(tool);
    }
    info.hasPytestConfig = info.tools.has("pytest") || info.tools.has("pytest.ini_options");
  }
  if (await pathExists(join(root, "requirements.txt"))) {
    const source = await readFile(join(root, "requirements.txt"), "utf8");
    for (const dependency of pythonRequirementNames(source)) {
      info.dependencies.add(dependency);
    }
  }
  if (await pathExists(join(root, "setup.cfg"))) {
    const source = await readFile(join(root, "setup.cfg"), "utf8");
    for (const dependency of pythonSetupCfgRequirementNames(source)) {
      info.dependencies.add(dependency);
    }
    if (/^\s*(?:\[tool:pytest\]|\[pytest\])\s*(?:#.*)?$/mu.test(source)) {
      info.hasPytestConfig = true;
    }
    for (const toolMatch of source.matchAll(/^\s*\[(mypy|pyright|ruff)\]/gmu)) {
      if (toolMatch[1] !== undefined) {
        info.tools.add(toolMatch[1]);
      }
    }
  }
  return info;
}

function pythonDependencyNames(source: string): string[] {
  const names = new Set<string>();
  for (const table of [
    pythonTomlTable(source, "project"),
    pythonTomlTable(source, "tool.uv"),
    pythonTomlTable(source, "tool.poetry"),
    pythonTomlTable(source, "tool.poetry.group.dev"),
    pythonTomlTable(source, "tool.pdm.dev-dependencies"),
    ...pythonTomlTablesMatching(source, /^tool\.hatch\.envs\.[^.]+$/u),
  ]) {
    for (const section of pythonTomlArraySections(table, ["dependencies", "dev-dependencies"])) {
      for (const value of pythonTomlArrayValues(section)) {
        const name = pythonRequirementName(value);
        if (name !== null) {
          names.add(name);
        }
      }
    }
  }
  for (const table of pythonTomlTables(source, [
    "tool.poetry.dependencies",
    "tool.poetry.dev-dependencies",
  ]).concat(pythonTomlTablesMatching(source, /^tool\.poetry\.group\.[^.]+\.dependencies$/u))) {
    for (const value of pythonTomlAssignedKeysAndValues(table)) {
      const name = pythonRequirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  for (const table of pythonTomlTables(source, [
    "project.optional-dependencies",
    "dependency-groups",
    "tool.pdm.dev-dependencies",
  ])) {
    for (const value of pythonTomlAssignedValues(table)) {
      const name = pythonRequirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function pythonTomlTable(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "mu").exec(source);
  if (match?.index === undefined) {
    return "";
  }
  const rest = source.slice(match.index + match[0].length);
  const next = pythonTomlHeaderPattern.exec(rest);
  return next?.index === undefined ? rest : rest.slice(0, next.index);
}

function pythonToolSections(source: string): string[] {
  const tools = new Set<string>();
  for (const match of source.matchAll(
    /^\s*\[\[?tool\.([A-Za-z0-9_.-]+)[^\]]*\]\]?\s*(?:#.*)?$/gmu,
  )) {
    const name = match[1]?.split(".")[0];
    if (name !== undefined) {
      tools.add(name);
    }
  }
  return [...tools];
}

function pythonTomlArraySections(source: string, keys: string[]): string[] {
  const sections: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*\\[`, "gmu"))) {
      sections.push(readTomlBracketValue(source, match.index + match[0].lastIndexOf("[")));
    }
  }
  return sections;
}

function pythonTomlTables(source: string, names: string[]): string[] {
  const tables: string[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "gmu");
    for (const match of source.matchAll(pattern)) {
      const start = match.index + match[0].length;
      const rest = source.slice(start);
      const next = pythonTomlHeaderPattern.exec(rest);
      tables.push(next?.index === undefined ? rest : rest.slice(0, next.index));
    }
  }
  return tables;
}

function pythonTomlTablesMatching(source: string, pattern: RegExp): string[] {
  const tables: string[] = [];
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu)) {
    const name = match[1];
    if (name === undefined || !pattern.test(name)) {
      continue;
    }
    const start = match.index + match[0].length;
    const rest = source.slice(start);
    const next = pythonTomlHeaderPattern.exec(rest);
    tables.push(next?.index === undefined ? rest : rest.slice(0, next.index));
  }
  return tables;
}

const pythonTomlHeaderPattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/mu;

function pythonTomlAssignedValues(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/^\s*["']?[^#"'=\s]+["']?\s*=\s*/gmu)) {
    if (match.index === undefined) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const lineEnd = source.indexOf("\n", valueStart);
    const rawValue = source.slice(valueStart, lineEnd === -1 ? source.length : lineEnd).trim();
    if (rawValue.startsWith("[")) {
      values.push(...pythonTomlArrayValues(readTomlBracketValue(source, valueStart)));
      continue;
    }
    values.push(...pythonTomlArrayValues(rawValue));
  }
  return values;
}

function pythonTomlAssignedKeysAndValues(source: string): string[] {
  const values = pythonTomlAssignedValues(source);
  for (const line of source.split("\n")) {
    const key = /^\s*["']?([^#"'=\s]+)["']?\s*=/u.exec(line)?.[1];
    if (key !== undefined) {
      values.push(key);
    }
  }
  return values;
}

function pythonTomlArrayValues(source: string): string[] {
  return pythonTomlStringValues(source);
}

function pythonTomlStringValues(source: string): string[] {
  const values: string[] = [];
  let quote: string | null = null;
  let value = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        values.push(value);
        quote = null;
        value = "";
      } else {
        value += char;
      }
      continue;
    }
    if (char === "#") {
      const nextNewline = source.indexOf("\n", index + 1);
      if (nextNewline === -1) {
        break;
      }
      index = nextNewline;
    } else if (char === '"' || char === "'") {
      quote = char;
      value = "";
    }
  }
  return values;
}

function readTomlBracketValue(source: string, bracketIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = bracketIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketIndex, index + 1);
      }
    }
  }
  return source.slice(bracketIndex);
}

function pythonRequirementNames(source: string): string[] {
  return source
    .split("\n")
    .map((line) => pythonRequirementName(line))
    .filter((name): name is string => name !== null);
}

function pythonSetupCfgRequirementNames(source: string): string[] {
  const names = new Set<string>();
  let section = "";
  let collecting = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (/^\s*(?:#|;|$)/u.test(line)) {
      continue;
    }
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].toLowerCase();
      collecting = false;
      continue;
    }
    if (section !== "options" && section !== "options.extras_require") {
      continue;
    }
    const assignment = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment !== null) {
      const key = assignment[1]?.toLowerCase().replace(/-/gu, "_") ?? "";
      collecting =
        section === "options"
          ? ["install_requires", "setup_requires", "tests_require"].includes(key)
          : true;
      if (collecting && assignment[2] !== undefined) {
        addPythonRequirementNames(names, assignment[2]);
      }
      continue;
    }
    if (collecting && /^\s+/u.test(line)) {
      addPythonRequirementNames(names, line);
    }
  }
  return [...names];
}

function addPythonRequirementNames(names: Set<string>, value: string): void {
  for (const part of value.split(",")) {
    const name = pythonRequirementName(part);
    if (name !== null) {
      names.add(name);
    }
  }
}

function pythonRequirementName(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/gu, "");
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
    return null;
  }
  const match = /^([A-Za-z0-9_.-]+)/u.exec(trimmed);
  return match?.[1]?.toLowerCase().replace(/_/gu, "-") ?? null;
}

async function containsPythonTestFile(root: string, maxDepth: number): Promise<boolean> {
  return containsFileMatching(
    root,
    maxDepth,
    (entry) => /^test_.+\.py$/u.test(entry) || entry.endsWith("_test.py"),
  );
}

async function hasSwiftTests(root: string): Promise<boolean> {
  if (!(await pathExists(join(root, "Package.swift")))) {
    return false;
  }
  const manifest = stripSwiftComments(await readFile(join(root, "Package.swift"), "utf8"));
  if (/\.testTarget\s*\(/u.test(manifest)) {
    return true;
  }
  return containsSwiftFile(join(root, "Tests"));
}

async function containsSwiftFile(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    return false;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && entry.endsWith(".swift")) {
      return true;
    }
    if (info.isDirectory() && (await containsSwiftFile(full))) {
      return true;
    }
  }
  return false;
}

async function detectFrameworks(root: string, pkg: PackageJson | null): Promise<string[]> {
  const deps = dependencyNames(pkg);
  const frameworks: string[] = [];
  for (const name of ["next", "express", "fastify", "hono", "vitest"]) {
    if (deps.has(name)) {
      frameworks.push(name);
    }
  }
  if (await containsDotnetFrameworkSignal(root, "aspnetcore")) {
    frameworks.push("aspnetcore");
  }
  if (await containsDotnetFrameworkSignal(root, "blazor")) {
    frameworks.push("blazor");
  }
  return frameworks;
}

async function containsDotnetFrameworkSignal(
  root: string,
  framework: "aspnetcore" | "blazor",
): Promise<boolean> {
  for (const project of await filesWithExtensions(root, [".csproj"], dotnetDiscoveryDepth)) {
    const source = await readFile(join(root, project), "utf8").catch(() => "");
    const lower = source.toLowerCase();
    if (
      framework === "aspnetcore" &&
      (lower.includes("microsoft.net.sdk.web") ||
        lower.includes("microsoft.aspnetcore") ||
        lower.includes("swashbuckle.aspnetcore"))
    ) {
      return true;
    }
    if (
      framework === "blazor" &&
      (lower.includes("microsoft.net.sdk.blazorwebassembly") ||
        lower.includes("microsoft.aspnetcore.components") ||
        (lower.includes("microsoft.net.sdk.web") &&
          (await dotnetProjectHasRazorFiles(root, project))))
    ) {
      return true;
    }
  }
  return false;
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
    ["swift", "Package.swift"],
    ["python", "pyproject.toml"],
    ["python", "setup.py"],
    ["python", "setup.cfg"],
    ["python", "requirements.txt"],
    ["csharp", "*.csproj"],
  ];
  const languages: string[] = [];
  for (const [language, file] of checks) {
    const exists = file.startsWith("*")
      ? await containsFileWithExtension(
          root,
          file.slice(1),
          language === "csharp" ? dotnetDiscoveryDepth : 5,
        )
      : await pathExists(join(root, file));
    if (exists && !languages.includes(language)) {
      languages.push(language);
    }
  }
  if (!languages.includes("python") && (await containsReviewablePythonFile(root))) {
    languages.push("python");
  }
  if (
    !languages.includes("swift") &&
    ((await containsFileNamed(root, "Package.swift", 5)) ||
      (await containsFileWithExtension(root, ".swift", 5)))
  ) {
    languages.push("swift");
  }
  if (
    !languages.includes("kotlin") &&
    ((await containsFileWithExtension(root, ".kt", 5)) ||
      (await containsFileWithExtension(root, ".kts", 5)))
  ) {
    languages.push("kotlin");
  }
  if (
    !languages.includes("csharp") &&
    ((await containsFileWithExtension(root, ".csproj", dotnetDiscoveryDepth)) ||
      (await containsFileWithExtension(root, ".cs", dotnetDiscoveryDepth)) ||
      (await containsFileWithExtension(root, ".razor", dotnetDiscoveryDepth)))
  ) {
    languages.push("csharp");
  }
  return languages;
}

async function isPythonProject(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "pyproject.toml"))) ||
    (await pathExists(join(root, "setup.py"))) ||
    (await pathExists(join(root, "setup.cfg"))) ||
    (await pathExists(join(root, "requirements.txt"))) ||
    (await containsReviewablePythonFile(root))
  );
}

async function containsReviewablePythonFile(root: string): Promise<boolean> {
  for (const prefix of ["src", "app", "apps", "lib", "scripts"]) {
    if (await containsFileWithExtension(join(root, prefix), ".py", 4)) {
      return true;
    }
  }
  return containsFileNamed(root, "__init__.py", 3);
}

async function containsFileNamed(root: string, name: string, maxDepth: number): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry === name);
}

async function containsFileWithExtension(
  root: string,
  extension: string,
  maxDepth: number,
): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry.endsWith(extension));
}

async function filesWithExtensions(
  root: string,
  extensions: string[],
  maxDepth: number,
): Promise<string[]> {
  const files: string[] = [];
  await collectFilesWithExtensions(root, "", maxDepth, extensions, files);
  return files.toSorted();
}

async function collectFilesWithExtensions(
  root: string,
  dir: string,
  remainingDepth: number,
  extensions: string[],
  files: string[],
): Promise<void> {
  if (remainingDepth < 0) {
    return;
  }
  const full = dir === "" ? root : join(root, dir);
  if (!(await pathExists(full))) {
    return;
  }
  const dirInfo = await lstat(full);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(full)) {
    if (ignoredDetectionEntry(entry)) {
      continue;
    }
    const relative = dir === "" ? entry : `${dir}/${entry}`;
    const path = join(full, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && extensions.some((extension) => entry.endsWith(extension))) {
      files.push(relative);
    } else if (info.isDirectory()) {
      await collectFilesWithExtensions(root, relative, remainingDepth - 1, extensions, files);
    }
  }
}

async function containsFileMatching(
  dir: string,
  remainingDepth: number,
  predicate: (entry: string) => boolean,
): Promise<boolean> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return false;
  }
  for (const entry of await readdir(dir)) {
    if (ignoredDetectionEntry(entry)) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && predicate(entry)) {
      return true;
    }
    if (info.isDirectory() && (await containsFileMatching(full, remainingDepth - 1, predicate))) {
      return true;
    }
  }
  return false;
}

function ignoredDetectionEntry(entry: string): boolean {
  return [
    "node_modules",
    "dist",
    "build",
    "target",
    ".build",
    ".swiftpm",
    ".git",
    ".clawpatch",
    ".worktrees",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    "fixtures",
    "__fixtures__",
    "testdata",
    "Pods",
    "Carthage",
    "SourcePackages",
    "DerivedData",
    "bin",
    "obj",
    ".vs",
    "TestResults",
  ].includes(entry);
}

async function dotnetProjectHasRazorFiles(root: string, project: string): Promise<boolean> {
  const projectRoot = dirname(project);
  const prefix = projectRoot === "." ? "" : `${projectRoot}/`;
  return (await filesWithExtensions(root, [".razor"], dotnetDiscoveryDepth)).some(
    (file) => prefix === "" || file.startsWith(prefix),
  );
}

function stripLineComments(source: string, marker: "//"): string {
  return source
    .split("\n")
    .map((line) => stripLineComment(line, marker))
    .join("\n");
}

function stripSwiftComments(source: string): string {
  return stripLineComments(stripBlockComments(source), "//");
}

function stripBlockComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      output += "  ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          output += "  ";
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          depth -= 1;
          index += 2;
          continue;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index -= 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLineComment(line: string, marker: "//"): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (line.startsWith(marker, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}
