import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

const maxOwnedFiles = 12;
const maxTests = 8;

type DotnetProject = {
  path: string;
  root: string;
  name: string;
  sdk: string | null;
  packages: string[];
  projectRefs: string[];
  isTest: boolean;
  isWeb: boolean;
  isBlazor: boolean;
};

type DotnetSolution = {
  path: string;
  root: string;
  projects: string[];
};

type AspnetRouteModule = {
  path: string;
  title: string;
  source: string;
  route: string;
  tags: string[];
};

export async function dotnetSeeds(root: string): Promise<FeatureSeed[]> {
  const [solutionFiles, projectFiles] = await Promise.all([
    discoverDotnetFiles(root, (file) => file.endsWith(".sln") || file.endsWith(".slnx")),
    discoverDotnetFiles(root, (file) => file.endsWith(".csproj")),
  ]);
  if (solutionFiles.length === 0 && projectFiles.length === 0) {
    return [];
  }

  const solutions = await Promise.all(solutionFiles.map((file) => dotnetSolution(root, file)));
  const projects = await Promise.all(projectFiles.map((file) => dotnetProject(root, file)));
  const testFiles = await dotnetTestFiles(root, projects);
  const testCommand = dotnetTestCommand(solutionFiles, projectFiles);
  const routeModules = await aspnetRouteModules(root, projects);
  const routeOwnedFiles = new Set(routeModules.map((module) => module.path));
  const blazorRouteFeatures = await blazorRouteSeeds(root, projects, testFiles, testCommand);
  for (const seed of blazorRouteFeatures) {
    for (const file of seed.ownedFiles ?? []) {
      routeOwnedFiles.add(file.path);
    }
  }

  const seeds: FeatureSeed[] = [];
  for (const solution of solutions) {
    seeds.push(solutionSeed(solution));
  }
  for (const project of projects) {
    seeds.push(await projectSeed(project, root));
  }
  seeds.push(...blazorRouteFeatures);
  for (const module of routeModules) {
    seeds.push(aspnetRouteSeed(module, root, testFiles, testCommand));
  }
  for (const project of projects) {
    seeds.push(
      ...(await dotnetSourceGroupSeeds(root, project, testFiles, routeOwnedFiles, testCommand)),
    );
  }
  return seeds;
}

async function discoverDotnetFiles(
  root: string,
  predicate: (file: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  await discoverDotnetFilesInto(root, ".", 7, predicate, files);
  return files.toSorted();
}

async function discoverDotnetFilesInto(
  root: string,
  dir: string,
  remainingDepth: number,
  predicate: (file: string) => boolean,
  files: string[],
): Promise<void> {
  if (remainingDepth < 0 || (dir !== "." && shouldSkipDotnetPath(dir))) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  if (!(await pathExists(full))) {
    return;
  }
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkipDotnetPath(child)) {
      continue;
    }
    const childFull = join(full, entry);
    const childInfo = await lstat(childFull);
    if (childInfo.isSymbolicLink()) {
      continue;
    }
    if (childInfo.isFile() && predicate(entry)) {
      files.push(child);
    } else if (childInfo.isDirectory()) {
      await discoverDotnetFilesInto(root, child, remainingDepth - 1, predicate, files);
    }
  }
}

function shouldSkipDotnetPath(path: string): boolean {
  return (
    shouldSkip(path) ||
    isSampleProjectPath(path) ||
    /(^|\/)(bin|obj|\.vs|TestResults)(\/|$)/u.test(path)
  );
}

async function dotnetSolution(root: string, path: string): Promise<DotnetSolution> {
  const source = await readFile(join(root, path), "utf8");
  const solutionRoot = dirnameOrDot(path);
  const projects = path.endsWith(".slnx")
    ? slnxProjectPaths(source, solutionRoot)
    : slnProjectPaths(source, solutionRoot);
  return {
    path,
    root: solutionRoot,
    projects,
  };
}

function slnProjectPaths(source: string, solutionRoot: string): string[] {
  const projects = new Set<string>();
  for (const match of source.matchAll(
    /^Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/gmu,
  )) {
    const candidate = resolvedRelativePath(solutionRoot, match[1] ?? "");
    if (candidate !== null) {
      projects.add(candidate);
    }
  }
  return [...projects].toSorted();
}

function slnxProjectPaths(source: string, solutionRoot: string): string[] {
  const projects = new Set<string>();
  for (const match of source.matchAll(/\bPath\s*=\s*"([^"]+\.csproj)"/gu)) {
    const candidate = resolvedRelativePath(solutionRoot, match[1] ?? "");
    if (candidate !== null) {
      projects.add(candidate);
    }
  }
  return [...projects].toSorted();
}

async function dotnetProject(root: string, path: string): Promise<DotnetProject> {
  const source = await readFile(join(root, path), "utf8");
  const sdk = xmlAttribute(source, "Project", "Sdk");
  const packages = xmlAttributes(source, "PackageReference", "Include");
  const projectRefs = xmlAttributes(source, "ProjectReference", "Include")
    .map((ref) => resolvedRelativePath(dirname(path), ref))
    .filter((ref): ref is string => ref !== null);
  const lowerPackages = packages.map((pkg) => pkg.toLowerCase());
  const projectName = basename(path, ".csproj");
  const sdkLower = sdk?.toLowerCase() ?? "";
  const hasRazorFiles = await dotnetProjectHasFile(root, dirnameOrDot(path), ".razor");
  const isTest =
    /(?:^|[._-])tests?$/iu.test(projectName) ||
    xmlElementValues(source, "IsTestProject").some((value) => value.toLowerCase() === "true") ||
    lowerPackages.some((pkg) =>
      ["microsoft.net.test.sdk", "xunit", "nunit", "mstest.testframework"].includes(pkg),
    );
  const isBlazor =
    sdkLower.includes("blazor") ||
    (sdkLower.includes(".sdk.web") && hasRazorFiles) ||
    lowerPackages.some((pkg) => pkg.includes("blazor") || pkg.includes("components.webassembly"));
  const isWeb = sdkLower.includes(".sdk.web") || isBlazor || lowerPackages.some(isAspnetPackage);
  return {
    path,
    root: dirnameOrDot(path),
    name: projectName,
    sdk,
    packages,
    projectRefs,
    isTest,
    isWeb,
    isBlazor,
  };
}

function xmlAttribute(source: string, element: string, attribute: string): string | null {
  const match = new RegExp(`<${element}\\b[^>]*\\b${attribute}\\s*=\\s*"([^"]+)"`, "iu").exec(
    source,
  );
  return match?.[1] ?? null;
}

function xmlAttributes(source: string, element: string, attribute: string): string[] {
  return [
    ...source.matchAll(new RegExp(`<${element}\\b[^>]*\\b${attribute}\\s*=\\s*"([^"]+)"`, "giu")),
  ]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function xmlElementValues(source: string, element: string): string[] {
  return [...source.matchAll(new RegExp(`<${element}>\\s*([^<]+?)\\s*</${element}>`, "giu"))]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function isAspnetPackage(name: string): boolean {
  return name.startsWith("microsoft.aspnetcore") || name === "swashbuckle.aspnetcore";
}

function solutionSeed(solution: DotnetSolution): FeatureSeed {
  return {
    title: `Dotnet solution ${basename(solution.path)}`,
    summary: `.NET solution ${solution.path} with ${solution.projects.length} C# project(s).`,
    kind: "config",
    source: solution.path.endsWith(".slnx") ? "dotnet-slnx" : "dotnet-sln",
    confidence: "medium",
    entryPath: solution.path,
    symbol: basename(solution.path),
    route: null,
    command: null,
    ownedFiles: [{ path: solution.path, reason: "solution file" }],
    contextFiles: solution.projects.map((path) => ({ path, reason: "solution project" })),
    tags: ["dotnet", "csharp", "solution"],
    trustBoundaries: ["filesystem", "process-exec"],
    skipNearbyTests: true,
  };
}

async function projectSeed(project: DotnetProject, root: string): Promise<FeatureSeed> {
  return {
    title: `Dotnet project ${project.name}`,
    summary: `.NET project ${project.path}${project.sdk === null ? "." : ` using ${project.sdk}.`}`,
    kind: projectKind(project),
    source: "dotnet-project",
    confidence: "medium",
    entryPath: project.path,
    symbol: project.name,
    route: null,
    command: null,
    ownedFiles: [{ path: project.path, reason: "project file" }],
    contextFiles: await dotnetProjectContextFiles(project, root),
    tags: projectTags(project),
    trustBoundaries: projectTrustBoundaries(project),
    skipNearbyTests: true,
  };
}

async function dotnetProjectContextFiles(
  project: DotnetProject,
  root: string,
): Promise<Array<{ path: string; reason: string }>> {
  const refs = project.projectRefs.map((path) => ({ path, reason: "project reference" }));
  for (const file of ["appsettings.json", "wwwroot/appsettings.json", "_Imports.razor"]) {
    const candidate = project.root === "." ? file : `${project.root}/${file}`;
    if (await pathExists(join(root, candidate))) {
      refs.push({ path: candidate, reason: "project context" });
    }
  }
  return refs;
}

function projectKind(project: DotnetProject): FeatureSeed["kind"] {
  if (project.isTest) {
    return "test-suite";
  }
  if (project.isBlazor) {
    return "ui-flow";
  }
  if (project.isWeb || project.packages.some((pkg) => /windowsservices/iu.test(pkg))) {
    return "service";
  }
  return "library";
}

function projectTags(project: DotnetProject): string[] {
  const tags = ["dotnet", "csharp"];
  if (project.isWeb) {
    tags.push("aspnetcore");
  }
  if (project.isBlazor) {
    tags.push("blazor");
  }
  if (project.isTest) {
    tags.push("test");
  }
  return tags;
}

function projectTrustBoundaries(project: DotnetProject): FeatureSeed["trustBoundaries"] {
  if (project.isTest) {
    return [];
  }
  const boundaries: FeatureSeed["trustBoundaries"] = ["filesystem"];
  if (project.isWeb || project.isBlazor) {
    boundaries.push("network", "user-input", "serialization");
  }
  if (project.packages.some((pkg) => /entityframework|sqlclient|npgsql/iu.test(pkg))) {
    boundaries.push("database");
  }
  if (project.packages.some((pkg) => /authentication|identitymodel|jwt/iu.test(pkg))) {
    boundaries.push("auth", "secrets");
  }
  return [...new Set(boundaries)];
}

async function dotnetTestFiles(root: string, projects: DotnetProject[]): Promise<string[]> {
  const projectTestRoots = projects
    .filter((project) => project.isTest)
    .map((project) => project.root);
  const prefixes = projectTestRoots.length > 0 ? projectTestRoots : ["test", "tests", "Tests"];
  const files = await walk(root, prefixes);
  return files
    .filter(isDotnetTestFile)
    .filter((file) => !isGeneratedDotnetFile(file))
    .toSorted();
}

async function blazorRouteSeeds(
  root: string,
  projects: DotnetProject[],
  testFiles: string[],
  testCommand: string,
): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  for (const project of projects.filter((candidate) => candidate.isBlazor || candidate.isWeb)) {
    const files = await dotnetProjectFiles(root, project);
    for (const file of files.filter((candidate) => candidate.endsWith(".razor"))) {
      const source = await readFile(join(root, file), "utf8").catch(() => "");
      const routes = blazorRoutes(source);
      for (const route of routes) {
        const owned = blazorCompanionFiles(file, files).map((path) => ({
          path,
          reason: "blazor route file",
        }));
        const tests = associatedDotnetTests([file], testFiles, testCommand);
        seeds.push({
          title: `Blazor route ${route}`,
          summary: `Blazor route ${route} implemented by ${file}.`,
          kind: "route",
          source: "dotnet-blazor-route",
          confidence: "high",
          entryPath: file,
          symbol: basename(file, ".razor"),
          route,
          command: null,
          ownedFiles: owned,
          contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
          tests,
          tags: ["dotnet", "csharp", "blazor", "web"],
          trustBoundaries: ["user-input", "network", "serialization"],
          skipNearbyTests: true,
        });
      }
    }
  }
  return seeds;
}

function blazorRoutes(source: string): string[] {
  return [...source.matchAll(/^\s*@page\s+"([^"]+)"/gmu)]
    .map((match) => match[1])
    .filter((route): route is string => route !== undefined)
    .map(normalizeRoute);
}

function blazorCompanionFiles(file: string, files: string[]): string[] {
  const companions = new Set<string>([file]);
  for (const suffix of [".cs", ".css"]) {
    const candidate = `${file}${suffix}`;
    if (files.includes(candidate)) {
      companions.add(candidate);
    }
  }
  return [...companions].toSorted();
}

async function aspnetRouteModules(
  root: string,
  projects: DotnetProject[],
): Promise<AspnetRouteModule[]> {
  const modules: AspnetRouteModule[] = [];
  const programPrefixes = await aspnetProgramPrefixes(root, projects);
  for (const project of projects.filter((candidate) => candidate.isWeb)) {
    const files = await dotnetProjectFiles(root, project);
    for (const file of files.filter((candidate) => candidate.endsWith(".cs"))) {
      const source = await readFile(join(root, file), "utf8").catch(() => "");
      const controller = controllerRouteModule(file, source);
      if (controller !== null) {
        modules.push(controller);
        continue;
      }
      const minimal = minimalRouteModule(file, source, programPrefixes);
      if (minimal !== null) {
        modules.push(minimal);
      }
    }
  }
  return dedupeRouteModules(modules);
}

async function aspnetProgramPrefixes(
  root: string,
  projects: DotnetProject[],
): Promise<Map<string, string[]>> {
  const prefixes = new Map<string, string[]>();
  for (const project of projects.filter((candidate) => candidate.isWeb)) {
    const program = project.root === "." ? "Program.cs" : `${project.root}/Program.cs`;
    if (!(await pathExists(join(root, program)))) {
      continue;
    }
    const source = await readFile(join(root, program), "utf8");
    const variables = new Map<string, string>();
    for (const match of source.matchAll(
      /\b(?:var|IEndpointRouteBuilder)\s+(\w+)\s*=\s*\w+\.MapGroup\(\s*"([^"]*)"\s*\)/gu,
    )) {
      const name = match[1];
      const route = match[2];
      if (name !== undefined && route !== undefined) {
        variables.set(name, normalizeRoute(route));
      }
    }
    for (const match of source.matchAll(/\b(\w+)\.(Map\w+Endpoints)\s*\(/gu)) {
      const variable = match[1];
      const method = match[2];
      if (variable === undefined || method === undefined) {
        continue;
      }
      const route = variables.get(variable);
      if (route === undefined) {
        continue;
      }
      const existing = prefixes.get(method) ?? [];
      prefixes.set(method, [...existing, route]);
    }
  }
  return prefixes;
}

function controllerRouteModule(path: string, source: string): AspnetRouteModule | null {
  if (!/\bControllerBase\b|\bController\b/u.test(source) || !/\[ApiController\]/u.test(source)) {
    return null;
  }
  const controller = /class\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(source)?.[1];
  if (controller === undefined) {
    return null;
  }
  const classHead = source.slice(0, source.indexOf(`class ${controller}`));
  const route = attributeRoute(classHead, "Route") ?? `api/${controller}`;
  const controllerName = controller.replace(/Controller$/u, "");
  return {
    path,
    title: `ASP.NET controller ${controllerName}`,
    source: "dotnet-aspnet-controller",
    route: normalizeRoute(route.replace(/\[controller\]/giu, controllerName)),
    tags: ["dotnet", "csharp", "aspnetcore", "controller"],
  };
}

function minimalRouteModule(
  path: string,
  source: string,
  programPrefixes: Map<string, string[]>,
): AspnetRouteModule | null {
  if (!/\bMap(?:Get|Post|Put|Delete|Patch|Group)\s*\(/u.test(source)) {
    return null;
  }
  const methodName = /public\s+static\s+IEndpointRouteBuilder\s+(Map\w+Endpoints)\s*\(/u.exec(
    source,
  )?.[1];
  const localGroup =
    /\b(?:var|RouteGroupBuilder|IEndpointRouteBuilder)\s+\w+\s*=\s*\w+\.MapGroup\(\s*"([^"]*)"\s*\)/u.exec(
      source,
    )?.[1] ?? "";
  const localRoutes = literalMapRoutes(source).filter((route) => route.length > 0);
  const prefixes = methodName === undefined ? [] : (programPrefixes.get(methodName) ?? []);
  const route = normalizeRoute(
    joinRouteParts(prefixes[0] ?? "", localGroup || localRoutes[0] || ""),
  );
  const name = basename(path, ".cs").replace(/Endpoints$/u, "");
  return {
    path,
    title: `ASP.NET endpoints ${name}`,
    source: "dotnet-aspnet-endpoints",
    route: route.length === 0 ? "/" : route,
    tags: ["dotnet", "csharp", "aspnetcore", "minimal-api"],
  };
}

function literalMapRoutes(source: string): string[] {
  return [...source.matchAll(/\bMap(?:Get|Post|Put|Delete|Patch|Group)\s*\(\s*"([^"]*)"/gu)]
    .map((match) => match[1])
    .filter((route): route is string => route !== undefined)
    .map(normalizeRoute);
}

function attributeRoute(source: string, attribute: string): string | null {
  const match = new RegExp(`\\[${attribute}\\s*\\(\\s*"([^"]*)"`, "iu").exec(source);
  return match?.[1] ?? null;
}

function aspnetRouteSeed(
  module: AspnetRouteModule,
  root: string,
  testFiles: string[],
  testCommand: string,
): FeatureSeed {
  const tests = associatedDotnetTests([module.path], testFiles, testCommand);
  return {
    title: module.title,
    summary: `ASP.NET route module ${module.route} implemented by ${module.path}.`,
    kind: "route",
    source: module.source,
    confidence: "medium",
    entryPath: module.path,
    symbol: basename(module.path, ".cs"),
    route: module.route,
    command: null,
    ownedFiles: [{ path: module.path, reason: "aspnet route module" }],
    contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
    tests,
    tags: module.tags,
    trustBoundaries: ["user-input", "network", "serialization", "auth"],
    skipNearbyTests: true,
  };
}

async function dotnetSourceGroupSeeds(
  root: string,
  project: DotnetProject,
  testFiles: string[],
  routeOwnedFiles: Set<string>,
  testCommand: string,
): Promise<FeatureSeed[]> {
  const files = (await dotnetProjectFiles(root, project))
    .filter((file) => !routeOwnedFiles.has(file))
    .filter((file) => !isGeneratedDotnetFile(file));
  const sourceFiles = files.filter((file) =>
    project.isTest ? isDotnetTestFile(file) : isReviewableDotnetSourceFile(file),
  );
  if (sourceFiles.length === 0) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  for (const group of partitionDotnetFileGroups(project, sourceFiles)) {
    const tests = project.isTest ? [] : associatedDotnetTests(group.files, testFiles, testCommand);
    seeds.push({
      title: project.isTest ? `Dotnet test suite ${group.label}` : `Dotnet source ${group.label}`,
      summary: project.isTest
        ? `.NET test group ${group.label} with ${group.files.length} file(s).`
        : `.NET source group ${group.label} with ${group.files.length} file(s).`,
      kind: project.isTest ? "test-suite" : project.isBlazor ? "ui-flow" : "library",
      source: project.isTest ? "dotnet-test-group" : "dotnet-source-group",
      confidence: "medium",
      entryPath: project.path,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({
        path,
        reason: project.isTest
          ? `dotnet test group ${group.label}`
          : `dotnet source group ${group.label}`,
      })),
      contextFiles: [
        { path: project.path, reason: "project file" },
        ...tests.map((test) => ({ path: test.path, reason: "associated dotnet test" })),
      ],
      tests,
      tags: project.isTest ? ["dotnet", "csharp", "test"] : projectTags(project),
      trustBoundaries: project.isTest ? [] : projectTrustBoundaries(project),
      skipNearbyTests: true,
    });
  }
  return seeds;
}

async function dotnetProjectFiles(root: string, project: DotnetProject): Promise<string[]> {
  const files = await walk(root, [project.root]);
  return files
    .filter((file) => !shouldSkipDotnetPath(file))
    .filter((file) => project.root === "." || pathMatchesPrefix(file, project.root))
    .filter((file) => file !== project.path)
    .filter(
      (file) =>
        file.endsWith(".cs") ||
        file.endsWith(".razor") ||
        file.endsWith(".razor.cs") ||
        file.endsWith(".razor.css") ||
        file.endsWith(".cshtml"),
    )
    .toSorted();
}

function associatedDotnetTests(
  files: string[],
  testFiles: string[],
  command: string | null,
): SeedTestRef[] {
  const stems = new Set(files.flatMap(dotnetTestAssociationStems));
  const dirs = new Set(files.map((file) => dirname(file)));
  return testFiles
    .filter((test) => {
      const testStem = basename(test)
        .replace(/\.[^.]+$/u, "")
        .replace(/Tests?$/u, "");
      return (
        stems.has(testStem) ||
        [...stems].some((stem) => isDotnetPartialTestStem(stem) && testStem.includes(stem)) ||
        [...dirs].some((dir) => pathMatchesPrefix(test, dir))
      );
    })
    .slice(0, maxTests)
    .map((path) => ({ path, command }));
}

function dotnetTestAssociationStems(file: string): string[] {
  const stem = basename(file).replace(/\.[^.]+$/u, "");
  const suffixless = stem.replace(
    /(Endpoints|Controller|Controllers|Page|Component|Service|Services|Handler|Validator|Validation|Auth)$/u,
    "",
  );
  return suffixless === "" || suffixless === stem ? [stem] : [stem, suffixless];
}

function isDotnetPartialTestStem(stem: string): boolean {
  return stem.length >= 6 && /[a-z][A-Z]/u.test(stem);
}

function partitionDotnetFileGroups(
  project: DotnetProject,
  files: string[],
): Array<{ label: string; files: string[] }> {
  if (project.root !== ".") {
    return partitionFileGroups(project.root, files, maxOwnedFiles);
  }
  if (files.length <= maxOwnedFiles) {
    return [{ label: project.name, files }];
  }
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const segment = file.split("/").at(0) ?? project.name;
    const bucket = buckets.get(segment) ?? [];
    bucket.push(file);
    buckets.set(segment, bucket);
  }
  const groups: Array<{ label: string; files: string[] }> = [];
  for (const [segment, bucket] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    groups.push(...partitionFileGroups(segment, bucket.toSorted(), maxOwnedFiles));
  }
  return groups;
}

function isReviewableDotnetSourceFile(path: string): boolean {
  return (
    /\.(cs|razor|cshtml)$/u.test(path) &&
    !isDotnetTestFile(path) &&
    !isGeneratedDotnetFile(path) &&
    !/(^|\/)Migrations\/.+\.Designer\.cs$/u.test(path)
  );
}

function isDotnetTestFile(path: string): boolean {
  return /(^|\/)(tests?|[^/]*Tests)(\/|$)/iu.test(path) || path.endsWith("Tests.cs");
}

function isGeneratedDotnetFile(path: string): boolean {
  return (
    /(^|\/)(bin|obj|\.vs|TestResults)(\/|$)/u.test(path) ||
    /(^|\/)AssemblyInfo\.cs$/u.test(path) ||
    /\.(g|g\.i|Designer)\.cs$/u.test(path) ||
    /(^|\/)(Generated|generated)(\/|$)/u.test(path)
  );
}

function dedupeRouteModules(modules: AspnetRouteModule[]): AspnetRouteModule[] {
  const seen = new Set<string>();
  const output: AspnetRouteModule[] = [];
  for (const module of modules) {
    const key = `${module.source}:${module.path}:${module.route}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(module);
  }
  return output.toSorted((left, right) => left.path.localeCompare(right.path));
}

function joinRouteParts(left: string, right: string): string {
  const parts = [left, right].map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  return parts
    .map((part) => part.replace(/^\/+|\/+$/gu, ""))
    .filter((part) => part.length > 0)
    .join("/");
}

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  return `/${trimmed.replace(/^\/+|\/+$/gu, "")}`;
}

function dirnameOrDot(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "." : normalize(dir);
}

function dotnetPath(path: string): string {
  return normalize(path).replace(/\\/gu, "/");
}

function resolvedRelativePath(base: string, path: string): string | null {
  const normalized = dotnetPath(path);
  if (!safeRelativePath(normalized, true)) {
    return null;
  }
  const resolved = posix.normalize(base === "." ? normalized : `${base}/${normalized}`);
  return safeRelativePath(resolved, false) ? resolved : null;
}

function safeRelativePath(path: string, allowParent: boolean): boolean {
  if (path.length === 0 || path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    return false;
  }
  const parts = path.split("/");
  return allowParent ? !parts.includes("") : !parts.includes("..") && !parts.includes("");
}

async function dotnetProjectHasFile(
  root: string,
  projectRoot: string,
  extension: string,
): Promise<boolean> {
  const files = await walk(root, [projectRoot]);
  return files
    .filter((file) => projectRoot === "." || pathMatchesPrefix(file, projectRoot))
    .some((file) => !shouldSkipDotnetPath(file) && file.endsWith(extension));
}

function dotnetTestCommand(solutionFiles: string[], projectFiles: string[]): string {
  const target = dotnetCommandTarget(solutionFiles, projectFiles);
  return target === null ? "dotnet test" : `dotnet test ${target}`;
}

function dotnetCommandTarget(solutionFiles: string[], projectFiles: string[]): string | null {
  if (solutionFiles.length === 1) {
    return solutionFiles[0] ?? null;
  }
  if (solutionFiles.length > 1) {
    return solutionFiles.find((file) => !file.includes("/")) ?? null;
  }
  return projectFiles.length === 1 ? (projectFiles[0] ?? null) : null;
}
