# gitcrawl e2e verification

Date: 2026-05-15

Target:

- repo: `/Users/steipete/Projects/gitcrawl`
- branch: `main`
- base sha: `469d89bc1a7af89a09e0d485a3aaec468695cc28`
- state dir: `/tmp/clawpatch-gitcrawl-state.LS8z6l`
- provider: `codex`

Commands:

```bash
node dist/cli.js --root /Users/steipete/Projects/gitcrawl --state-dir /tmp/clawpatch-gitcrawl-state.LS8z6l init
node dist/cli.js --root /Users/steipete/Projects/gitcrawl --state-dir /tmp/clawpatch-gitcrawl-state.LS8z6l map
node dist/cli.js --root /Users/steipete/Projects/gitcrawl --state-dir /tmp/clawpatch-gitcrawl-state.LS8z6l review --feature feat_library_4e7327377d --provider codex
node dist/cli.js --root /Users/steipete/Projects/gitcrawl --state-dir /tmp/clawpatch-gitcrawl-state.LS8z6l fix --finding fnd_sig-feat-library-4e7327377d-d508_36498c6bfc --provider codex
node dist/cli.js --root /Users/steipete/Projects/gitcrawl --state-dir /tmp/clawpatch-gitcrawl-state.LS8z6l revalidate --finding fnd_sig-feat-library-4e7327377d-d508_36498c6bfc --provider codex
GOCACHE=/tmp/gitcrawl-go-cache GOWORK=off go test ./internal/vector
```

Results:

- `map`: 12 features found.
- `review`: 1 real finding in `internal/vector/exact.go`.
- finding: `Query can return NaN/Inf scores for non-finite vector values`
- reason: `score <= 0` does not filter `NaN`; JSON marshalling rejects `NaN`/`Inf` scores.
- `fix`: changed `internal/vector/exact.go` and `internal/vector/exact_test.go`.
- targeted validation: `go test ./internal/vector` passed.
- `revalidate`: outcome `fixed`.

Patch produced in gitcrawl:

```diff
-		if score <= 0 {
+		if math.IsNaN(score) || math.IsInf(score, 0) || score <= 0 {
```

Regression test added in gitcrawl:

```go
func TestQueryFiltersNonFiniteScores(t *testing.T)
```

Known validation note:

- clawpatch marked the patch attempt `failed` because Codex also ran broad `go test ./...`, which failed in unrelated `internal/cli` tests.
- Focused package validation passed and Codex revalidation marked the reviewed finding fixed.
