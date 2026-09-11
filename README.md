# hermes-profile-manager

A fast, zero-system-dependency manager and CLI for Hermes AI agent profiles.

`hermes-profile-manager` automates merging configs, cron jobs, and SOUL prompts, as well as symlinking shared skills and plugins into runtime profiles and `~/.hermes`.

---

## Features

- ⚡ **Zero System Dependencies**: Pure Node.js & TypeScript. No `yq` or `jq` binaries required on your system.
- 🔄 **Safe Atomic Operations**: Atomic writes ensure configurations are never left corrupted in case of an interrupt.
- 🔗 **Portable Symlinks**: Automatically generates relative symlinks for intra-repo skills and plugins (`../../common/skills/*`), keeping profiles portable across different machines and paths.
- 🎯 **Smart Root Discovery**: Automatically discovers the repository root by locating `profiles/common` from your current working directory.
- 🛠 **Dual Interface**: Full-featured CLI (`hpm` / `hermes-pm`) and an exportable programmatic TypeScript/ESM API.
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
│   └── plugins/             # Shared plugins (also linked to ~/.hermes/plugins)
├── orchestrator/
│   ├── config.custom.yaml   # Profile-specific config overrides
│   ├── SOUL.custom.md       # Profile-specific prompt (prepended to common SOUL)
│   └── cron/
│       └── jobs.custom.json # Profile-specific cron jobs
└── [other-agents]/
```

---

## CLI Usage

The CLI is available as both `hpm` and `hermes-pm`.

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
hpm link plugins    # Symlinks common plugins into profile dirs & ~/.hermes/plugins
hpm link hermes     # Symlinks repo profiles/ directory to ~/.hermes/profiles
```

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
| `-p, --profiles <names...>` | Target specific profile names only | All profiles |
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

- `syncAll(options)`: Runs `mergeAll` and `linkAll`.
- `mergeAll(options)`: Runs `mergeConfig`, `mergeJobs`, and `mergeSoul`.
- `linkAll(options)`: Runs `linkSkills` and `linkPlugins` (and optionally `linkHermes`).
- `mergeConfig(options)`: Deep merges YAML configs using YAML object override logic.
- `mergeJobs(options)`: Merges JSON cron jobs by matching job ID and appending new ones.
- `mergeSoul(options)`: Concatenates profile prompt before shared prompt.
- `linkSkills(options)`: Creates relative symlinks to common skills.
- `linkPlugins(options)`: Creates relative and absolute symlinks to common plugins.
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

