# ClaudeAgents Modules Architecture Specification

**Status:** Specification (Ready for Implementation)  
**Date:** 2026-04-21  
**Context:** Docker/worktree port management patterns, generalized for any tech stack

---

## Vision

ClaudeAgents is a **general-purpose framework for autonomous agents** that works with **any tech stack**. The framework includes **optional, pluggable modules** for stack-specific capabilities (Docker, web testing, Python, etc.) without requiring them to be present or installed.

This specification defines the **modules architecture** that enables ClaudeAgents to be extended with tech-stack-specific utilities while remaining lean and general-purpose at its core.

---

## Problem Statement

### Current State
- ClaudeAgents works well as a general agent framework
- When agents need to work with Docker (containers, ports, health checks), there's no standard tooling
- Each project (e.g., workshop-site) reimplements Docker utilities

### Desired State
- ClaudeAgents provides **optional Docker module** with reusable utilities
- Agents can import `claudeagents/modules/docker` when needed
- Pattern is clear for adding other modules (Python, web testing, Ruby, etc.)
- No module is required for core functionality
- Projects using ClaudeAgents aren't forced to adopt Docker tooling they don't need

---

## Architecture

### Directory Structure

```
ClaudeAgents/
├── src/
│   └── modules/                   # Optional tech-stack modules
│       ├── docker/
│       │   ├── PortRegistry.js
│       │   ├── PortDiscovery.js
│       │   ├── ContainerHealth.js
│       │   ├── PortValidator.js
│       │   ├── ContainerNaming.js
│       │   └── index.js           # Barrel export + prerequisite check
│       │
│       ├── web/                   # Placeholder for future web module
│       │   └── index.js
│       │
│       └── python/                # Placeholder for future Python module
│           └── index.js
│
├── docs/
│   ├── MODULES.md                 # Module system guide + installation
│   └── modules/
│       ├── DOCKER.md              # Docker module documentation
│       ├── WEB.md                 # Web module (future)
│       └── PYTHON.md              # Python module (future)
│
├── tests/
│   └── modules/
│       └── docker/                # node:test suites — no Docker required
│           ├── PortRegistry.test.js
│           ├── PortDiscovery.test.js
│           ├── ContainerHealth.test.js
│           ├── PortValidator.test.js
│           └── ContainerNaming.test.js
│
├── .github/
│   └── workflows/
│       ├── shared-setup.yml       # Reusable workflow: checkout + Node 18 + cache
│       ├── test-modules.yml       # Runs `node --test tests/modules/**`
│       └── test-capability.yml    # Runs scripts/capability-check (spec 06)
│
├── specifications/
│   └── MODULES_ARCHITECTURE.md    # This file
│
├── install.sh                     # Symlinks agents/skills + runs npm link
└── package.json                   # name: "claudeagents", exports map
```

---

## Module System

### Core Principle

**A module is a collection of related utilities for working with a specific tech stack or domain.**

Modules are:
- **Optional** — Agents import only what they need
- **Focused** — Each module serves one purpose (Docker, web, Python, etc.)
- **Self-contained** — No cross-module dependencies
- **Well-documented** — Clear API, examples, use cases
- **Runtime-checked** — Validates prerequisites (Docker installed, etc.) at import time

### Module Interface

Every module exports a **barrel export** (`index.js`) with:

```javascript
// modules/[stack]/index.js

// 1. Verify prerequisites (throw if not met)
const { execSync } = require('child_process');
try {
  execSync('docker --version');
} catch (e) {
  throw new Error(
    'Docker module requires Docker CLI to be installed and in PATH. ' +
    'Download from https://docker.com'
  );
}

// 2. Export utilities
module.exports = {
  PortRegistry: require('./PortRegistry'),
  PortDiscovery: require('./PortDiscovery'),
  ContainerHealth: require('./ContainerHealth'),
  PortValidator: require('./PortValidator'),
  ContainerNaming: require('./ContainerNaming'),
};
```

### Module Discovery

Agents discover modules by explicit import:

```javascript
// Agent code - explicitly imports what it needs
const Docker = require('claudeagents/modules/docker');
const { discoverPort } = Docker;

// If Docker module prerequisites aren't met, error is thrown at import time
// Agent can catch and handle gracefully
try {
  const Docker = require('claudeagents/modules/docker');
} catch (e) {
  console.error('Docker module unavailable:', e.message);
  // Fall back to non-Docker approach
}
```

### Installation

Modules are distributed via **`npm link`** — a global symlink from the Node.js package registry into the ClaudeAgents repo. Edits to the repo are reflected in all consuming projects immediately, matching the symlink philosophy of `install.sh` for agents and skills.

**`package.json` (repo root):**
```json
{
  "name": "claudeagents",
  "version": "0.1.0",
  "description": "Optional modules for the ClaudeAgents framework",
  "exports": {
    "./modules/docker":  "./src/modules/docker/index.js",
    "./modules/web":     "./src/modules/web/index.js",
    "./modules/python":  "./src/modules/python/index.js"
  }
}
```

**One-time setup per machine** (handled by `install.sh`):
```bash
cd /path/to/ClaudeAgents
npm link
```

**Usage in any project** — no per-project install step:
```javascript
const Docker = require('claudeagents/modules/docker');
```

> **Note:** `npm link` registers the package against the active Node version. If you use `nvm` and switch versions, re-run `npm link` from the ClaudeAgents repo.

---

## Docker Module Specification

### Purpose
Provide agents with reusable utilities for working with Docker containers and ports in git worktrees.

### Scope
- **In scope:** Port management, container health checks, naming conventions
- **Out of scope:** Docker image building, Dockerfile creation, project-specific orchestration

### Utilities

#### 1. PortRegistry
**Purpose:** Persist port assignments across shell sessions  
**File:** `modules/docker/PortRegistry.js`

```javascript
class PortRegistry {
  constructor(registryPath) { }
  register(worktreePath, port, containerName) { }
  lookup(worktreePath) { }
  getAll() { }
  stop(worktreePath) { }
}

module.exports = { PortRegistry };
```

**Usage:**
```javascript
const { PortRegistry } = require('claudeagents/modules/docker');
const registry = new PortRegistry('./.gan/port-registry.json');
registry.register('/path/to/worktree', 9000, 'grav-a1b2c3d4');
```

#### 2. PortDiscovery
**Purpose:** Find which port a container is using  
**File:** `modules/docker/PortDiscovery.js`

**Discovery layers (in order):**
1. Environment variable (caller-specified name via `options.envVar`)
2. Port registry file (`.gan/port-registry.json`)
3. Docker PS query
4. Fallback (configurable, default 8080)

```javascript
async function discoverPort(options) {
  // options: {
  //   envVar,            // e.g. 'APP_PORT', 'GRAV_PORT' — no default; omit to skip env lookup
  //   registryPath,      // path to port-registry.json
  //   containerPattern,  // glob pattern for docker ps (e.g. 'myapp-*')
  //   fallbackPort       // returned if all other layers miss
  // }
  // returns: port number
  // throws: Error if no port found and no fallback
}

module.exports = { discoverPort };
```

**Usage:**
```javascript
const { discoverPort } = require('claudeagents/modules/docker');
const port = await discoverPort({
  envVar: 'APP_PORT',                      // project-specific env var name
  registryPath: './.gan/port-registry.json',
  containerPattern: 'myapp-*',
  fallbackPort: 8080
});
```

#### 3. ContainerHealth
**Purpose:** Wait for container to be ready  
**File:** `modules/docker/ContainerHealth.js`

```javascript
async function waitForReady(options) {
  // options: {
  //   port,
  //   healthCheckUrl: '/admin' (optional),
  //   maxAttempts: 15,
  //   delay: 2000
  // }
  // returns: true if ready
  // throws: Error if timeout
}

module.exports = { waitForReady };
```

**Usage:**
```javascript
const { waitForReady } = require('claudeagents/modules/docker');
await waitForReady({
  port: 9000,
  healthCheckUrl: '/admin',
  maxAttempts: 15,
  delay: 2000
});
```

#### 4. PortValidator
**Purpose:** Check if port is available  
**File:** `modules/docker/PortValidator.js`

> **Platform support:** macOS is fully implemented. Linux and Windows stubs are present but not yet implemented — they throw a `PlatformNotSupported` error with a clear message. The interface is designed for future implementation without breaking existing callers.

**Implementation strategy:** Use `lsof -i :<port>` on macOS (reliable, no extra deps). Linux (`ss -tlnp`) and Windows (`netstat -ano`) are structured as named platform handlers so contributors can add them without touching the core logic.

```javascript
async function checkPortAvailable(port) {
  // returns: true if free
  // throws: Error if in use with explanation
  // throws: PlatformNotSupported if platform is not yet implemented
}

// Internal platform dispatch — open for extension:
// const PLATFORMS = {
//   darwin:  checkWithLsof,       // ✅ implemented
//   linux:   notYetImplemented,   // 🔲 stub — use ss -tlnp
//   win32:   notYetImplemented,   // 🔲 stub — use netstat -ano
// };

module.exports = { checkPortAvailable };
```

**Usage:**
```javascript
const { checkPortAvailable } = require('claudeagents/modules/docker');
try {
  await checkPortAvailable(9000);
} catch (e) {
  console.error('Port in use or platform unsupported:', e.message);
}
```

#### 5. ContainerNaming
**Purpose:** Generate unique, deterministic container names  
**File:** `modules/docker/ContainerNaming.js`

**Algorithm:** SHA256 hash of absolute path, first 8 chars

```javascript
function generateName(prefix, worktreePath) {
  // prefix: 'grav', 'myapp', etc.
  // worktreePath: absolute or relative path
  // returns: 'grav-a1b2c3d4' (deterministic, collision-free)
}

module.exports = { generateName };
```

**Usage:**
```javascript
const { ContainerNaming } = require('claudeagents/modules/docker');
const name = ContainerNaming.generateName('grav', '/Users/thomas/workspace/project');
// Returns: 'grav-a1b2c3d4' (same name every time for same path)
```

### Dependencies
- **Runtime:** None (uses Node.js built-ins only)
- **Prerequisite:** Docker CLI must be in PATH (checked at module import)
- **Optional Data:** Port registry JSON file (created/managed by user scripts)

### Error Handling

All utilities throw descriptive errors:

```javascript
// Example error from checkPortAvailable
throw new Error(
  'Port 9000 is already in use.\n' +
  'Solutions:\n' +
  '  1. Use a different port: gan-up.sh . 9001\n' +
  '  2. Stop the container: docker stop <container-id>\n' +
  '  3. Find what\'s using the port: lsof -i :9000'
);
```

---

## Integration with workshop-site

### Status
Optional. workshop-site demonstrates Docker module usage but remains independent.

### Example Usage
```javascript
// workshop-site/scripts/gan-up-wrapper.js (wrapper around docker-compose)
const Docker = require('claudeagents/modules/docker');
const { ContainerNaming, PortValidator, waitForReady } = Docker;

const containerName = ContainerNaming.generateName('grav', process.cwd());
await PortValidator.checkPortAvailable(9000);
// ... start docker-compose ...
await waitForReady({ port: 9000, healthCheckUrl: '/admin' });
```

---

## Future Modules

### Web Module (Planned)
**Purpose:** Website testing utilities (Playwright integration, page analysis, etc.)

```
modules/web/
├── BrowserSession.js      - Playwright wrapper
├── PageAnalyzer.js        - Content parsing
└── index.js
```

### Python Module (Planned)
**Purpose:** Python-specific helpers (venv, pip, dependency management)

```
modules/python/
├── VenvManager.js         - Virtual environment management
├── PipManager.js          - Package management
└── index.js
```

### Other Modules (Future)
- Ruby (gems, bundler)
- Go (build, testing)
- Rust (cargo)
- Database (connection pooling, migrations)
- Message Queues (RabbitMQ, Redis, etc.)

---

## Implementation Plan

### Phase 1: Establish Module Architecture
**Goal:** Set up directory structure, package, and CI

**Tasks:**
1. Create `/src/modules/` directory structure with placeholder `web/` and `python/` stubs
2. Create `package.json` with `name: "claudeagents"` and `exports` map
3. Extend `install.sh` to run `npm link` after symlinking agents/skills
4. Create the CI workflows per roadmap.md "CI workflow structure": `.github/workflows/shared-setup.yml` (reusable), `.github/workflows/test-modules.yml` (this spec's tests), and `.github/workflows/test-capability.yml` (spec 06's capability-check). All three must land together — `test-modules.yml` calls `shared-setup.yml`, and spec 06's later work extends `test-capability.yml`.
5. Create `/docs/MODULES.md` (module system guide + installation instructions)
6. Document module system in main `README.md`

**Duration:** 1-2 hours

### Phase 2: Implement Docker Module
**Goal:** Promote Docker utilities to ClaudeAgents

**Tasks:**
1. Create `modules/docker/` with 5 utilities
2. Implement PortRegistry with JSON persistence
3. Implement PortDiscovery with three-layer fallback
4. Implement ContainerHealth with robust checks
5. Implement PortValidator (macOS); add Linux/Windows stubs with `PlatformNotSupported` errors
6. Implement ContainerNaming with SHA256 hashing
7. Add comprehensive error messages

**Duration:** 4-6 hours

### Phase 3: Documentation & Examples
**Goal:** Make module system clear and usable

**Tasks:**
1. Create `/docs/modules/DOCKER.md` (API reference + examples)
2. Add `node:test` unit tests for all 5 utilities (no Docker required)
3. Create example script showing end-to-end usage

**Duration:** 2-3 hours

---

## Acceptance Criteria

### Module Architecture
- [ ] `/src/modules/` directory exists with clear structure
- [ ] `/docs/MODULES.md` explains how modules work and how to install
- [ ] Modules can be imported independently without breaking core
- [ ] Missing modules don't prevent ClaudeAgents from running

### Installation
- [ ] `package.json` exists with `name: "claudeagents"` and correct `exports` map
- [ ] `install.sh` runs `npm link` after symlinking agents/skills
- [ ] `require('claudeagents/modules/docker')` works after running `install.sh`

### CI
- [ ] `.github/workflows/shared-setup.yml` exists as a reusable workflow (`workflow_call`) performing checkout + Node 18 install + dependency cache
- [ ] `.github/workflows/test-modules.yml` calls `shared-setup.yml` and runs `node --test tests/modules/**` on every push and PR
- [ ] `.github/workflows/test-capability.yml` is present (owned by spec 06) and also uses `shared-setup.yml`
- [ ] All tests pass on the GitHub Actions macOS runner

### Docker Module
- [ ] All 5 utilities implemented and exported
- [ ] PortRegistry persists to JSON file
- [ ] PortDiscovery tries env → registry → docker ps → fallback
- [ ] ContainerHealth checks via HTTP request (not just port binding)
- [ ] PortValidator works on macOS via `lsof`; Linux/Windows stubs throw `PlatformNotSupported`
- [ ] ContainerNaming generates collision-free names via hashing
- [ ] Clear error messages for all failure scenarios
- [ ] No hard dependencies (Docker check at runtime)

### Testing
- [ ] `node:test` unit tests for all 5 utilities (no Docker required)
- [ ] Integration test showing `require('claudeagents/modules/docker')` and basic usage
- [ ] Error cases covered (port in use, Docker not installed, unsupported platform, etc.)
- [ ] macOS path handling validated; Linux/Windows path edge cases noted in docs

### Documentation
- [ ] `/docs/modules/DOCKER.md` with API reference
- [ ] Examples for each utility
- [ ] Clear error messages guide users to solutions

---

## Design Decisions

### 1. Why Modules Are Optional
**Decision:** Modules are loaded only when imported, not by default.

**Rationale:** ClaudeAgents should work for Python, Go, Ruby projects that don't need Docker. Forcing Docker tooling on them adds bloat and dependencies.

### 2. Why Runtime Prerequisite Checks
**Decision:** Docker module checks for Docker CLI at import time.

**Rationale:** Fail early with clear message rather than cryptic errors later. Agents can catch import errors and handle gracefully.

### 3. Why Three-Layer Port Discovery
**Decision:** Try env vars → registry → docker ps → fallback.

**Rationale:** 
- Env vars are fastest (used during active session)
- Registry survives shell/app restart
- docker ps is ultimate source of truth
- Fallback prevents silent failures

### 4. Why SHA256 for Container Names
**Decision:** Hash absolute path, use first 8 characters.

**Rationale:**
- Deterministic (same path always same hash)
- Collision-free (highly unlikely)
- Human-readable (8 chars visible)
- No dependency on path structure

### 5. Why `node:test` for Testing
**Decision:** Use Node.js built-in `node:test` module with `node --test`.

**Rationale:**
- Zero dependencies — no Jest, Mocha, or Chai in `package.json`
- Consistent with the module philosophy (no unnecessary deps)
- Ships with Node.js 18+; no install step in CI
- Built-in mocking (Node 22+) covers the main need: faking `docker ps` output
- Run: `node --test tests/modules/docker/*.test.js`

### 6. Why GitHub Actions for CI
**Decision:** CI runs on every push and PR targeting `main` via one workflow per test category, all reusing a shared setup workflow. Files: `shared-setup.yml`, `test-modules.yml`, `test-capability.yml`. See roadmap.md "CI workflow structure" for the authoritative layout.

**Rationale:**
- Native to GitHub where the repo lives — no external service
- macOS runner (`macos-latest`) matches the only fully-implemented platform (PortValidator)
- Workflow is a single `node --test` call — minimal surface area to maintain

### 7. Why `npm link` for Distribution
**Decision:** `install.sh` runs `npm link` to register the package globally.

**Rationale:**
- Matches the existing symlink philosophy for agents and skills
- One setup per machine; works across all projects without per-project configuration
- Edits to the repo are reflected immediately (symlink, not a copy)
- Clear migration path to `npm publish` later with no code changes in consuming projects

### 8. Why JSON for Port Registry
**Decision:** Use `.gan/port-registry.json` format.

**Rationale:**
- Human-readable and debuggable
- Cross-platform standard
- Easy to extend with metadata (timestamps, status)
- Can be parsed with jq for shell scripts

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Module becomes too large | Keep modules focused; split if needed |
| Modules couple together | Ban cross-module dependencies |
| Prerequisites silently fail | Check at import time, throw with clear message |
| Registry file gets out of sync | Include timestamps, document recovery |
| Port discovery gives wrong port | Three-layer fallback + validation |
| New team member doesn't know modules exist | Document prominently in README.md |

---

## Success Metrics

1. ✅ Agents can import Docker module and discover ports automatically
2. ✅ ClaudeAgents remains general-purpose (not Docker-specific)
3. ✅ New module (e.g., web) can be added without breaking Docker module
4. ✅ Documentation is clear enough that users don't need to ask for help

---

## References

- **Related:** workshop-site Docker worktree specification
- **Inspired by:** Node.js optional dependencies, npm peer dependencies
- **Similar patterns:** npm modules, Python setuptools extras, Ruby bundler groups
