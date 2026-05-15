import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GlobalOptions } from "./config.js";

export async function fixtureRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFixture(root: string, path: string, contents: string): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents, "utf8");
}

export function testOptions(root: string): GlobalOptions {
  return {
    root,
    json: false,
    plain: false,
    quiet: false,
    verbose: false,
    debug: false,
    noColor: true,
    noInput: true,
  };
}
