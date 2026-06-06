# GAN — Config Server

The sole gateway to all GAN configuration: an MCP server that exposes reads, writes, and validation tools so agents and the /gan skill never read config files directly.

---

## 1 — Tool surface

```mermaid
flowchart LR
    subgraph READS["Reads (13)"]
        direction TB
        R1["getResolvedConfig"]
        R2["getActiveStacks"]
        R3["getMergedSplicePoints"]
        R4["getStack"]
        R5["getOverlay"]
        R6["getStackResolution"]
        R7["getTrustState"]
        R8["getTrustDiff"]
        R9["trustList"]
        R10["getModuleState"]
        R11["listModules"]
        R12["getApiVersion"]
        R13["getBoundedDirectoryListing"]
    end

    subgraph WRITES["Writes (14)"]
        direction TB
        subgraph OVW["Overlay writes"]
            W1["setOverlayField"]
            W2["appendToOverlayField"]
            W3["removeFromOverlayField"]
        end
        subgraph SKW["Stack writes"]
            W4["updateStackField"]
            W5["appendToStackField"]
            W6["removeFromStackField"]
        end
        subgraph TRW["Trust writes"]
            W7["trustApprove"]
            W8["trustRevoke"]
        end
        subgraph MOW["Module writes"]
            W9["setModuleState"]
            W10["appendToModuleState"]
            W11["removeFromModuleState"]
            W12["registerModule"]
        end
        subgraph TMW["Telemetry writes"]
            W13["writeTelemetryConfig"]
            W14["writeTelemetryOutcome"]
        end
    end

    subgraph VALIDATE["Validate (3)"]
        direction TB
        V1["validateAll"]
        V2["validateOverlay"]
        V3["validateStack"]
    end

    CALLER(["Caller\nagent / skill"]) --> READS
    CALLER --> WRITES
    CALLER --> VALIDATE
```

---

## 2 — Resolution pipeline

```mermaid
flowchart TD
    START(["getResolvedConfig\nprojectRoot"]) --> CANON["Canonicalise\nprojectRoot"]
    CANON --> CACHE_CHECK{"Cache hit?\nmtime guard"}
    CACHE_CHECK -->|"hit"| RETURN_CACHED(["Return cached\nResolvedConfig"])
    CACHE_CHECK -->|"miss"| DETECT

    subgraph PHASE1["Phase 1 — Discovery"]
        DETECT["Enumerate stack files\nall tiers"]
        DETECT --> OVERLAYS["Load overlay tiers\ndefault · user · project"]
        OVERLAYS --> MOD_DISC["Discover modules\nfrom package root"]
    end

    MOD_DISC --> SCHEMA_VAL

    subgraph PHASE2["Phase 2 — Schema validation"]
        SCHEMA_VAL["validateStackBodyAgainstSchema\nvalidateOverlayBodyAgainstSchema\n(ajv, schemaVersion exact-match)"]
    end

    SCHEMA_VAL --> INVARIANTS

    subgraph PHASE3["Phase 3 — Cross-file invariants"]
        INVARIANTS["runAllInvariants\n8 registered invariants"]
    end

    INVARIANTS --> TRUST_GATE

    subgraph PHASE4["Phase 4 — Trust gate (last validation phase)"]
        TRUST_GATE["projectDeclaresCommands?"]
        TRUST_GATE -->|"no commands"| TRUST_SKIP["skipped"]
        TRUST_GATE -->|"GAN_TRUST=unsafe-trust-all"| TRUST_BYPASS["bypassed"]
        TRUST_GATE -->|"commands present"| HASH["computeTrustHash\nSHA-256 · project.md +\nstacks/*.md + modules/*.yaml"]
        HASH --> CACHE_LOOKUP["Lookup in\ntrust-cache.json"]
        CACHE_LOOKUP -->|"approved"| TRUST_OK["approved"]
        CACHE_LOOKUP -->|"no match"| TRUST_ISSUE["UntrustedOverlay\nissue (folded into issues[];\nresolution still proceeds)"]
    end

    TRUST_SKIP --> CASCADE
    TRUST_BYPASS --> CASCADE
    TRUST_OK --> CASCADE
    TRUST_ISSUE --> CASCADE

    subgraph C4["C4 — Overlay cascade"]
        CASCADE["cascadeOverlays\ndefault < user < project"]
        CASCADE --> SPLICE["Per splice-point merge\nlist-union · scalar-override\ndeep-merge-cache-env · merge-role-map"]
        SPLICE --> DISCARD["Record discardInherited\npaths"]
    end

    DISCARD --> STACK_DETECT

    subgraph C2["C2 — Stack detection"]
        STACK_DETECT{"stack.override\nnon-empty?"}
        STACK_DETECT -->|"yes"| EXPLICIT["Use explicit list\nMissingFile on unknown names"]
        STACK_DETECT -->|"no"| AUTO["Auto-detect via\ndetection block globs"]
        AUTO --> FALLBACK["Generic fallback\nif nothing matched"]
    end

    EXPLICIT --> RESOLVE_STACKS
    FALLBACK --> RESOLVE_STACKS

    subgraph C5["C5 — Stack resolution"]
        RESOLVE_STACKS["resolveStackFile per active stack\nproject → user → builtin (pkg) → builtin (fixture)"]
    end

    RESOLVE_STACKS --> BUILD

    subgraph BUILD_SHAPE["Build ResolvedConfig"]
        BUILD["Assemble F2 shape\napiVersion · schemaVersions · runtimeMode\nstacks · overlay · discarded\nadditionalContext · issues · modules"]
        BUILD --> STABLE["Round-trip through\nstableStringify\n(canonical key order)"]
    end

    STABLE --> CACHE_WRITE["Cache.set\nwith backing-file mtime snapshot"]
    CACHE_WRITE --> RETURN(["Return\nResolvedConfig"])
```

---

## 3 — Type model

```mermaid
classDiagram
    class ResolvedConfig {
        <<interface>>
        +apiVersion: string
        +schemaVersions: object
        +runtimeMode: object
        +stacks: object
        +overlay: Record~string, unknown~
        +discarded: string[]
        +additionalContext: object
        +issues: Issue[]
        +modules: Record~string, ResolvedModuleEntry~
    }

    class ResolvedStackEntry {
        <<interface>>
        +tier: project | user | builtin
        +path: string
        +schemaVersion: number
    }

    class StackResolution {
        <<interface>>
        +path: string
        +tier: StackTier
    }

    class OverlayTier {
        <<interface>>
        default | user | project
    }

    class LoadedOverlay {
        <<interface>>
        +data: unknown
        +prose: YamlBlockProse
        +path: string
        +tier: OverlayTier
        +raw: string
    }

    class LoadedStack {
        <<interface>>
        +data: unknown
        +prose: YamlBlockProse
        +sourceTier: StackTier
        +sourcePath: string
        +raw: string
    }

    class Issue {
        <<interface>>
        +code: string
        +path?: string
        +field?: string
        +message: string
        +severity?: error | warning
    }

    class WriteResult {
        <<interface>>
        mutated: true, path: string
        mutated: false, issues: Issue[]
        mutated: false, reason: string
    }

    class ValidationSnapshot {
        <<interface>>
        +projectRoot: string
        +stackFiles: Map
        +overlays: object
        +modules: SnapshotModuleRow[]
        +issues: Issue[]
    }

    class ResolvedConfigCache {
        +get(canonicalRoot) ResolvedConfig
        +set(canonicalRoot, value, states) void
        +invalidate(canonicalRoot) void
        +clear() void
    }

    ResolvedConfig *-- ResolvedStackEntry : stacks.byName
    ResolvedConfig *-- Issue : issues[]
    ResolvedConfig o-- LoadedOverlay : overlay (cascaded)
    StackResolution o-- ResolvedStackEntry : resolved into
    LoadedOverlay o-- OverlayTier : tier
    ValidationSnapshot *-- Issue : issues[]
    WriteResult o-- Issue : on failure
    ResolvedConfigCache o-- ResolvedConfig : caches
```

---

## 4 — getResolvedConfig call sequence

```mermaid
sequenceDiagram
    participant Caller as Caller
    participant CS as Config Server
    participant Cache as ResolvedConfigCache
    participant Trust as Trust gate
    participant Pipeline as Resolution pipeline
    participant Storage as Storage layer

    Caller->>CS: getResolvedConfig(projectRoot)
    CS->>CS: canonicalizePath(projectRoot)
    CS->>Cache: get(canonicalRoot)

    alt Cache hit + backing files unchanged
        Cache-->>CS: ResolvedConfig
        CS-->>Caller: ResolvedConfig (cached)
    else Cache miss or mtime changed
        Cache-->>CS: undefined

        CS->>Pipeline: validateAll (phases 1–4)
        Pipeline->>Storage: enumerateTierStacks × all tiers
        Storage-->>Pipeline: stack file paths
        Pipeline->>Storage: loadOverlay × 3 tiers
        Storage-->>Pipeline: LoadedOverlay | null
        Pipeline->>Pipeline: phase 2 · ajv schema validation
        Pipeline->>Pipeline: phase 3 · runAllInvariants
        Pipeline->>Trust: phase 4 · runTrustCheck(snapshot)
        Trust->>Trust: projectDeclaresCommands?
        alt No commands declared
            Trust-->>Pipeline: status: skipped
        else Commands declared
            Trust->>Trust: computeTrustHash(project.md + stacks/*.md + modules/*.yaml)
            Trust->>Storage: readCache(homeDir)
            Storage-->>Trust: trust-cache.json
            alt Hash approved
                Trust-->>Pipeline: status: approved
            else Hash not approved
                Trust-->>Pipeline: UntrustedOverlay issue
            end
        end
        Pipeline-->>CS: issues[] (incl. any trust issue)

        CS->>Pipeline: cascadeOverlays(default, user, project)
        Pipeline-->>CS: CascadeResult (merged, discarded)

        CS->>Pipeline: detectActiveStacks(snapshot, overlay)
        Pipeline-->>CS: DetectionResult (active[])

        CS->>Storage: resolveStackFile × active stacks
        Storage-->>CS: StackResolution[]

        CS->>CS: Build ResolvedConfig shape
        CS->>CS: stableStringify (canonical key order)
        CS->>Cache: set(canonicalRoot, resolved, backingFileStates)
        CS-->>Caller: ResolvedConfig
    end
```

---

## 5 — Write operation flow

```mermaid
flowchart TD
    START(["Write tool call\ne.g. setOverlayField"]) --> RESOLVE_PATH["Resolve target file path\nfor tier / stack name"]
    RESOLVE_PATH --> PATH_OK{"Path\nresolvable?"}
    PATH_OK -->|"no"| MALFORMED_A(["Return\nmutated: false\nreason: malformed"])
    PATH_OK -->|"yes"| LOAD["Load current file from disk\n(compose-if-absent for overlays)"]
    LOAD --> LOAD_OK{"Parse\nsucceeded?"}
    LOAD_OK -->|"no"| ISSUE_A(["Return\nmutated: false\nissues: [ParseError]"])
    LOAD_OK -->|"yes"| CLONE["Deep-clone data\napply mutation in memory"]
    CLONE --> SCHEMA["validateBodyAgainstSchema\n(ajv + schemaVersion check)"]
    SCHEMA --> VALID{"Valid?"}
    VALID -->|"no"| ISSUE_B(["Return\nmutated: false\nissues: [SchemaMismatch...]"])
    VALID -->|"yes"| ATOMIC["atomicWriteFile\n(write to temp, rename)"]
    ATOMIC --> WRITE_OK{"Write\nsucceeded?"}
    WRITE_OK -->|"no"| ISSUE_C(["Return\nmutated: false\nissues: [IOError]"])
    WRITE_OK -->|"yes"| INVALIDATE["cache.invalidate(canonicalRoot)\n(before return)"]
    INVALIDATE --> SUCCESS(["Return\nmutated: true\npath: filePath"])

    subgraph TRUST_WRITES["Trust writes (trustApprove / trustRevoke)"]
        TA_START(["trustApprove / trustRevoke"]) --> HASH2["computeTrustHash\nSHA-256 · .claude/gan/\nproject.md + stacks/*.md + modules/*.yaml"]
        HASH2 --> UPSERT["upsertApproval / removeApprovals\nwriteCache(homeDir, newCache)"]
        UPSERT --> LOG["logTrustEvent\naudit log"]
        LOG --> TINVALIDATE["cache.invalidate(canonicalRoot)"]
        TINVALIDATE --> TSUCCESS(["Return\nmutated: true | false\nrecord / reason"])
    end
```
