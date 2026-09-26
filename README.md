# hermes-profile-manager

A fast, zero-system-dependency manager and CLI for Hermes AI agent profiles.

`hermes-profile-manager` automates merging configs, cron jobs, and SOUL prompts, as well as symlinking shared skills and plugins into runtime profiles and `~/.hermes`.

---

## Features

- ⚡ **Zero System Dependencies**: Pure Node.js & TypeScript. No `yq` or `jq` binaries required on your system.
- 🔄 **Safe Atomic Operations**: Atomic writes ensure configurations are never left corrupted in case of an interrupt.
- 🔗 **Portable Symlinks**: Automatically generates relative symlinks for intra-repo skills and plugins (`../../common/skills/*`), keeping profiles portable across different machines and paths.
- 🎯 **Smart Root Discovery**: Automatically discovers the repository root by locating `profiles/common` from your current working directory.
- 🛠 **Dual Interface**: Full-featured CLI (`hpm` / `hermes-profile-manager`) and an exportable programmatic TypeScript/ESM API.
- 🧪 **Fully Tested**: Comprehensive test suite ensuring 100% compatibility with Hermes profile layouts.

---

## Installation

### Global CLI

```bash
npm install -g hermes-profile-manager
# or
pnpm add -g hermes-profile-manager
```

### Local in Project

```bash
npm install --save-dev hermes-profile-manager
```

### One-off execution with npx

```bash
npx hermes-profile-manager sync
```

---

## Directory Structure

`hermes-profile-manager` expects the standard Hermes multi-profile directory layout:

```
profiles/
├── common/
│   ├── config.yaml          # Base configurations
│   ├── SOUL.md              # Shared system prompt / instructions
│   ├── skills/              # Shared skills
│   └── plugins/             # Shared plugins (also linked to ~/.hermes/plugins on default runs)
├── orchestrator/
│   ├── config.custom.yaml   # Profile-specific config overrides
│   ├── SOUL.custom.md       # Profile-specific prompt (prepended to common SOUL)
│   └── cron/
│       └── jobs.custom.json # Profile-specific cron jobs
└── [other-agents]/
```

---

## CLI Usage

The CLI is available as both `hpm` and `hermes-profile-manager`.

### Initialize a New Workspace

```bash
# Initialize a workspace in the current directory (default profile: "main")
hpm init

# Initialize in a specific directory with a custom agent profile name
hpm init ./my-project --profile orchestrator

# Overwrite existing configuration files
hpm init --force

# Initialize without running immediate sync
hpm init --no-sync
```

### Compound Commands

```bash
# Full sync: merges configs, jobs, and SOUL, and links skills and plugins
hpm sync

# Also symlink profiles directory to ~/.hermes/profiles
hpm sync --include-hermes-link

# Merge all resources (config, jobs, SOUL)
hpm merge

# Link all resources (skills, plugins)
hpm link
```

### Granular Commands

```bash
# Merge specific resources
hpm merge config    # Merges config.yaml with config.custom.yaml
hpm merge jobs      # Merges cron/jobs.json with cron/jobs.custom.json
hpm merge soul      # Prepends SOUL.custom.md to common/SOUL.md

# Link specific resources
hpm link skills     # Symlinks common skills into profile directories
hpm link plugins    # Symlinks common plugins into profile dirs (and, on default runs, ~/.hermes/plugins)
hpm link hermes     # Symlinks repo profiles/ directory to ~/.hermes/profiles
```

### Global Hermes Home Writes (`~/.hermes`)

The link steps write into the global Hermes home directory (default `~/.hermes`, or `--hermes-dir` / `$HERMES_HOME`):

- **Untargeted (default) runs** link common plugins into `~/.hermes/plugins`, and `hpm link hermes` / `hpm sync --include-hermes-link` link the repo `profiles/` directory to `~/.hermes/profiles`.
- **Explicitly scoped runs** (`-p <profiles...>`) scope the run to the named profiles only and do **not** write into the global Hermes home directory — including `~/.hermes/plugins` for `hpm link plugins`, `hpm link`, `hpm link all`, `hpm sync`, and `hpm merge-all`. `-p/--profiles` is a scope gate everywhere: when you name profiles, only those profiles are touched.


### Direct Make-compatible Aliases

For drop-in compatibility with legacy Makefiles:

```bash
hpm config-merge
hpm jobs-merge
hpm soul-merge
hpm skills-link
hpm plugins-link
hpm hermes-link
hpm merge-all
```

### CLI Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `-r, --root <path>` | Path to repository root | Auto-detected from cwd |
| `--hermes-dir <path>` | Path to Hermes home directory | `~/.hermes` or `$HERMES_HOME` |
| `-p, --profiles <names...>` | Target specific profile names only. Also skips all global Hermes home writes (e.g. `~/.hermes/plugins` linking) | All profiles (untargeted runs write to `~/.hermes/plugins`) |
| `-d, --dry-run` | Preview actions without modifying disk | `false` |
| `-q, --quiet` | Suppress normal logging | `false` |
| `-v, --version` | Display package version | |
| `-h, --help` | Display help text | |

---

## Programmatic API

You can import `hermes-profile-manager` directly into your Node / TypeScript scripts:

```typescript
import {
  syncAll,
  mergeConfig,
  mergeJobs,
  mergeSoul,
  linkSkills,
  linkPlugins,
  linkHermes
} from 'hermes-profile-manager';

// Run full synchronization
const result = syncAll({
  rootDir: '/path/to/project',
  hermesDir: '/home/user/.hermes',
  dryRun: false
});

console.log(result);
```

### Exported Functions

- `initWorkspace(options)`: Scaffolds a new profile workspace (`profiles/common/{config.yaml,SOUL.md,skills/,plugins/}` and `profiles/<profileName>/{config.custom.yaml,SOUL.custom.md,cron/jobs.custom.json}`) and optionally runs an initial sync. This is the programmatic counterpart of `hpm init`. Key options: `targetDir` (default `process.cwd()`), `profileName` (default `"main"`), `force` (overwrite existing files), `runSync` (default `true`; skipped automatically under `dryRun`), `dryRun` (no filesystem side effects), `logger`. Returns `{ targetDir, profileName, createdFiles, skippedFiles, syncResult? }`.
- `syncAll(options)`: Runs `mergeAll` and `linkAll`. Returns a result object you can inspect for failures: `config` / `jobs` / `soul` (per-profile merge results with `status: 'merged' | 'skipped' | 'error'`), `skills` / `plugins` (per-profile link results), `hermesLink?`, `linkErrors: string[]` (captured link-step failures — empty when all links succeeded), and `syncError?: string` (a top-level merge precondition failure, e.g. missing `profiles/common/config.yaml`). `syncAll` never throws; gate success on `syncError` and the per-profile error entries.
- `mergeAll(options)`: Runs `mergeConfig`, `mergeJobs`, and `mergeSoul`.
- `linkAll(options)`: Runs `linkSkills` and `linkPlugins` (and optionally `linkHermes`).
- `mergeConfig(options)`: Deep merges YAML configs using YAML object override logic.
- `mergeJobs(options)`: Merges JSON cron jobs by matching job ID and appending new ones.
- `mergeJobsDocuments(baseDoc, customDoc)`: Pure job-merge primitive (the core logic behind `mergeJobs`). Merges base and custom job documents: jobs with matching `id` are merged (custom properties override base), custom-only jobs are appended, and base job order is preserved. Idempotent for id-less jobs — they are deduplicated by deep content equality, so feeding a previous run's output back in as the base never grows the jobs list.
- `mergeSoul(options)`: Concatenates profile prompt before shared prompt.
- `linkSkills(options)`: Creates relative symlinks to common skills.
- `linkPlugins(options)`: Creates relative symlinks to common plugins; on default (untargeted) runs also links them to `~/.hermes/plugins`. With an explicit non-empty `profiles` list, only the named profiles are linked and the global `~/.hermes/plugins` write is skipped.
- `linkHermes(options)`: Symlinks workspace profiles to `~/.hermes/profiles`.
- `findProjectRoot(startDir)`: Locates the nearest directory containing `profiles/common`.
- `deepMerge(base, override)`: Pure utility for recursive object merging.

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build package
npm run build
```

---

## License

MIT

