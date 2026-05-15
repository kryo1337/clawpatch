import { describe, expect, it } from "vitest";
import { detectProject } from "./detect.js";
import { mapFeatures } from "./mapper.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";

describe("mapFeatures", () => {
  it("maps package bins, scripts, configs, and Next routes", async () => {
    const root = await fixtureRoot("clawpatch-map-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          bin: { fixture: "src/cli.ts" },
          scripts: { build: "tsc", test: "vitest run" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/cli.ts", "export function main() {}\n");
    await writeFixture(
      root,
      "app/users/[id]/page.tsx",
      "export default function Page() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(result.created).toBeGreaterThanOrEqual(4);
    expect(titles).toContain("CLI command fixture");
    expect(titles).toContain("Package script build");
    expect(titles).toContain("Package script test");
    expect(titles).toContain("Route /users/:id");
  });

  it("maps Go commands and internal packages", async () => {
    const root = await fixtureRoot("clawpatch-go-map-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(root, "cmd/tool/main.go", "package main\n\nfunc main() {}\n");
    await writeFixture(root, "internal/store/store.go", "package store\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("go");
    expect(project.detected.commands.test).toBe("go test ./...");
    expect(titles).toContain("Go command tool");
    expect(titles).toContain("Go package store");
  });
});
