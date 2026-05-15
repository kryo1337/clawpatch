# clawpatch

Automated code review that lands fixes.

`clawpatch` maps a codebase into reviewable feature slices, reviews each slice for real bugs and quality gaps through Codex, revalidates findings, and turns confirmed issues into repair patches when explicitly asked.

Early commands:

```bash
clawpatch init
clawpatch map
clawpatch review --limit 3
clawpatch report
clawpatch fix --finding <id>
clawpatch revalidate --finding <id>
clawpatch status
```

Defaults are conservative:

- review/report only unless `fix` is requested
- no commit, push, PR, or land
- no destructive git commands
- fixes require a clean worktree by default
- state lives in `.clawpatch/`

See [docs/spec.md](docs/spec.md) for the full product and CLI spec.
