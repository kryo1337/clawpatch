import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensureDir, pathExists, readJson, writeJson } from "./fs.js";
import {
  FeatureRecord,
  FindingRecord,
  PatchAttempt,
  ProjectRecord,
  RunRecord,
  featureRecordSchema,
  findingRecordSchema,
  patchAttemptSchema,
  projectRecordSchema,
  runRecordSchema,
} from "./types.js";

export type StatePaths = {
  stateDir: string;
  config: string;
  project: string;
  features: string;
  findings: string;
  runs: string;
  patches: string;
  reports: string;
  locks: string;
};

export function statePaths(stateDir: string): StatePaths {
  return {
    stateDir,
    config: join(stateDir, "config.json"),
    project: join(stateDir, "project.json"),
    features: join(stateDir, "features"),
    findings: join(stateDir, "findings"),
    runs: join(stateDir, "runs"),
    patches: join(stateDir, "patches"),
    reports: join(stateDir, "reports"),
    locks: join(stateDir, "locks"),
  };
}

export async function ensureStateDirs(paths: StatePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.stateDir),
    ensureDir(paths.features),
    ensureDir(paths.findings),
    ensureDir(paths.runs),
    ensureDir(paths.patches),
    ensureDir(paths.reports),
    ensureDir(paths.locks),
  ]);
}

export async function readProject(paths: StatePaths): Promise<ProjectRecord | null> {
  if (!(await pathExists(paths.project))) {
    return null;
  }
  return readJson(paths.project, projectRecordSchema);
}

export async function writeProject(paths: StatePaths, project: ProjectRecord): Promise<void> {
  await writeJson(paths.project, project);
}

export async function readFeatures(paths: StatePaths): Promise<FeatureRecord[]> {
  return readRecords(paths.features, featureRecordSchema);
}

export async function writeFeature(paths: StatePaths, feature: FeatureRecord): Promise<void> {
  await writeJson(join(paths.features, `${feature.featureId}.json`), feature);
}

export async function readFindings(paths: StatePaths): Promise<FindingRecord[]> {
  return readRecords(paths.findings, findingRecordSchema);
}

export async function readFinding(paths: StatePaths, id: string): Promise<FindingRecord | null> {
  const path = join(paths.findings, `${id}.json`);
  if (!(await pathExists(path))) {
    return null;
  }
  return readJson(path, findingRecordSchema);
}

export async function writeFinding(paths: StatePaths, finding: FindingRecord): Promise<void> {
  await writeJson(join(paths.findings, `${finding.findingId}.json`), finding);
}

export async function writeRun(paths: StatePaths, run: RunRecord): Promise<void> {
  await writeJson(join(paths.runs, `${run.runId}.json`), run);
}

export async function readRuns(paths: StatePaths): Promise<RunRecord[]> {
  return readRecords(paths.runs, runRecordSchema);
}

export async function writePatchAttempt(paths: StatePaths, patch: PatchAttempt): Promise<void> {
  await writeJson(join(paths.patches, `${patch.patchAttemptId}.json`), patch);
}

export async function readPatchAttempts(paths: StatePaths): Promise<PatchAttempt[]> {
  return readRecords(paths.patches, patchAttemptSchema);
}

async function readRecords<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const names = await readdir(dir);
  const records: T[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    records.push(await readJson(join(dir, name), schema));
  }
  return records;
}
