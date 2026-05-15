#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  cleanLocksCommand,
  doctorCommand,
  fixCommand,
  initCommand,
  makeContext,
  mapCommand,
  reportCommand,
  revalidateCommand,
  reviewCommand,
  statusCommand,
} from "./app.js";
import { ClawpatchError } from "./errors.js";
import { GlobalOptions } from "./config.js";

const version = "0.1.0";

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  const context = await makeContext(parsed.global);
  const result = await dispatch(context, parsed.command, parsed.flags);
  writeResult(result, parsed.global);
}

async function dispatch(
  context: Awaited<ReturnType<typeof makeContext>>,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<unknown> {
  switch (command) {
    case "init":
      return initCommand(context, flags);
    case "map":
      return mapCommand(context, flags);
    case "status":
      return statusCommand(context);
    case "review":
      return reviewCommand(context, flags);
    case "report":
      return reportCommand(context, flags);
    case "fix":
      return fixCommand(context, flags);
    case "revalidate":
      return revalidateCommand(context, flags);
    case "doctor":
      return doctorCommand(context);
    case "clean-locks":
      return cleanLocksCommand(context);
    default:
      throw new ClawpatchError(`unknown command: ${command}`, 2, "invalid-usage");
  }
}

type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean>;
  global: GlobalOptions;
  help: boolean;
  version: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const global: GlobalOptions = {
    json: false,
    plain: false,
    quiet: false,
    verbose: false,
    debug: false,
    noColor: false,
    noInput: false,
  };
  const flags: Record<string, string | boolean> = {};
  let command = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (command === "" && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    const globalValueName = arg.startsWith("--") ? camel(arg.replace(/^--/u, "")) : "";
    const target = isGlobalFlag(globalValueName) ? global : flags;
    if (arg === "-h" || arg === "--help") {
      return { command, flags, global, help: true, version: false };
    }
    if (arg === "--version") {
      return { command, flags, global, help: false, version: true };
    }
    const valueName = arg.replace(/^--/u, "");
    if (
      [
        "root",
        "state-dir",
        "config",
        "feature",
        "finding",
        "limit",
        "provider",
        "model",
        "output",
      ].includes(valueName)
    ) {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new ClawpatchError(`missing value for ${arg}`, 2, "invalid-usage");
      }
      index += 1;
      setFlag(target, camel(valueName), next);
      continue;
    }
    if (arg.startsWith("--") && isBooleanFlag(valueName)) {
      setFlag(target, camel(valueName), true);
      continue;
    }
    if (arg === "-q") {
      global.quiet = true;
      continue;
    }
    if (arg === "-v") {
      global.verbose = true;
      continue;
    }
    if (arg === "-o") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new ClawpatchError("missing value for -o", 2, "invalid-usage");
      }
      index += 1;
      flags["output"] = next;
      continue;
    }
    throw new ClawpatchError(`unknown arg: ${arg}`, 2, "invalid-usage");
  }
  if (command === "") {
    command = "status";
  }
  return { command, flags, global, help: false, version: false };
}

function isBooleanFlag(name: string): boolean {
  return [
    "json",
    "plain",
    "quiet",
    "verbose",
    "debug",
    "no-color",
    "no-input",
    "dry-run",
    "force",
  ].includes(name);
}

function setFlag(
  target: Record<string, string | boolean>,
  name: string,
  value: string | boolean,
): void {
  target[name] = value;
}

function isGlobalFlag(name: string): name is keyof GlobalOptions {
  return [
    "root",
    "stateDir",
    "config",
    "json",
    "plain",
    "quiet",
    "verbose",
    "debug",
    "noColor",
    "noInput",
  ].includes(name);
}

function camel(value: string): string {
  return value.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function writeResult(result: unknown, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "markdown" in result &&
    typeof result.markdown === "string" &&
    !options.plain
  ) {
    process.stdout.write(result.markdown);
    return;
  }
  if (typeof result === "object" && result !== null) {
    for (const [key, value] of Object.entries(result)) {
      if (key === "project" && typeof value === "object") {
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        process.stdout.write(`${key}: ${String(value)}\n`);
      }
    }
    return;
  }
  process.stdout.write(`${String(result)}\n`);
}

function printHelp(): void {
  process.stdout.write(`clawpatch: automated code review that lands fixes

Usage:
  clawpatch [global flags] <command> [flags]

Commands:
  init
  map
  status
  review
  report
  fix
  revalidate
  doctor
  clean-locks

Global flags:
  --root <path>
  --state-dir <path>
  --config <path>
  --json
  --plain
  -q, --quiet
  -v, --verbose
  --debug
  --no-color
  --no-input
  -h, --help
  --version
`);
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ClawpatchError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(realpathSync(entry)).href;
}
