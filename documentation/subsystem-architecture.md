# GAN — Subsystem Architecture

High-level technical documentation showing how the GAN framework subsystems cooperate.

---

## 1 — Component architecture

Left-to-right layout following the natural flow: entry points → agent layer → config server → storage.
Related components are grouped: entry points together, trace below the agents that feed it,
schemas and docker adjacent to the config server they serve.

```mermaid
flowchart LR
    subgraph ENTRY["Entry points"]
        direction TB
        SKILL["/gan skill\nskills/gan/"]
        CLI["gan CLI\nsrc/cli/"]
    end

    HOOK["Confinement hook\nPreToolUse"]

    subgraph AL["Agent layer · agents/"]
        direction TB
        PL["planner"] --> CP["contract-proposer"] --> CR["contract-reviewer"] --> GN["generator"] --> EV["evaluator\n+ evaluator-core"]
    end

    subgraph CS["Config Server · src/config-server/ · MCP"]
        direction TB
        MT["Tool surface\nreads · writes · validate"]
        TG["Trust gate"]
        RP["Resolution pipeline\ndetection → cascade → invariants"]
        ST["Storage"]
        MT --> TG --> RP --> ST
    end

    SCH["schemas/"]
    DK["docker module\nsrc/modules/docker/"]

    subgraph TR["Trace · src/trace/"]
        direction LR
        EM["Emitter"]
        RC["Reconciler"]
    end

    subgraph ZN["Storage zones"]
        direction TB
        Z1["zone 1 · config\n.claude/gan/"]
        Z2R["zone 2 · runs\n~/.gan-runs-data/"]
        Z2M["zone 2 · module state\n~/.gan-module-state/"]
        Z3["zone 3 · cache\n.gan-state/"]
    end

    SKILL      -->|"orchestrates"| AL
    CLI        -->|"stdio MCP"| MT
    HOOK      -.->|"gates all tool calls"| AL
    AL         -->|"MCP tool calls"| MT
    DK         -->|"registered with"| MT
    RP         -->|"validates against"| SCH
    ST         --> Z1 & Z2R & Z2M & Z3
    SKILL      -->|"emit events"| EM
    AL         -->|"emit events"| EM
    EM         --> Z2R
    RC         -->|"reads"| Z2R
    DK         --> Z2M
```

---

## 2 — /gan run sequence

```mermaid
sequenceDiagram
    participant U as User
    participant SK as /gan skill
    participant CS as Config Server
    participant TR as Trace
    participant PL as planner
    participant CP as contract-proposer
    participant CR as contract-reviewer
    participant GN as generator
    participant EV as evaluator

    U->>SK: /gan <prompt>
    SK->>CS: acquireRunLock
    SK->>CS: getActiveStacks + getResolvedConfig
    CS-->>SK: resolved config + active stack list
    SK->>TR: emit runStart

    SK->>+PL: spawn with prompt + config snapshot
    PL->>CS: getResolvedConfig, getMergedSplicePoints
    PL-->>-SK: spec.md written to zone 3

    SK->>+CP: spawn with spec.md
    CP->>CS: getResolvedConfig (security + doc surfaces)
    CP-->>-SK: contract.md written to zone 3

    SK->>+CR: spawn with contract.md
    CR-->>-SK: verdict (approved / rejected)

    loop for each feature in contract
        SK->>+GN: spawn with feature + contract
        GN->>CS: getResolvedConfig (build cmds, tool restrictions)
        GN-->>-SK: feature implemented + committed
    end

    SK->>+EV: spawn with contract + implementation
    EV->>CS: getResolvedConfig (eval cmds, security surfaces)
    Note over EV: evaluator-core: build · test · lint · audit · secrets scan
    EV->>CS: write evidence bundle
    EV-->>-SK: done
    CS-->>SK: passed / blocked

    SK->>TR: emit runComplete
    SK->>CS: releaseRunLock
    SK-->>U: run summary
```

---

## 3 — Config server resolution pipeline

Called on every `getResolvedConfig` tool invocation.

```mermaid
flowchart TD
    IN["MCP tool call\ngetResolvedConfig"]

    subgraph TG["Trust gate · trust/"]
        HC["Content-hash all overlay + stack files"]
        TP["Compare against approved hashes\nPrompt user if new or changed"]
        HC --> TP
    end

    subgraph RP["Resolution pipeline · resolution/"]
        DT["Detection\nScan project for stack indicators"]
        SL["Stack loader\nBuilt-in → tier-3 → tier-2 → tier-1"]
        OL["Overlay loader\nUser → project tiers"]
        CM["Cascade merge\nOverlays applied on top of stacks"]
        SV["Schema validation\nstack-v1.json · overlay-v1.json"]
        IV["Invariants\n8 cross-field constraint checks"]
        DT --> SL --> OL --> CM --> SV --> IV
    end

    CA["Resolution cache\nWithin a single run"]
    OUT["Resolved config returned"]

    IN --> TG --> RP --> CA --> OUT
    CA -.->|"cache hit — skip pipeline"| OUT
```

---

## 4 — Storage topology

What lives where, and what owns each zone.

```mermaid
flowchart LR
    subgraph Z1["Zone 1 — config"]
        direction TB
        OVP[".claude/gan/project.md\nproject overlay"]
        OVU["~/.claude/gan/user.md\nuser overlay"]
        CST[".claude/gan/stacks/\nstack customizations"]
        CMC[".claude/gan/modules/\nmodule configs e.g. docker.yaml"]
    end

    subgraph Z2R["Zone 2a — runs\n~/.gan-runs-data/repo-key/"]
        direction TB
        RT["run-trace-*.ndjson\nstructured event log"]
        RI["run-index.json"]
        RA["recovery-anchor.json"]
        RL["run-lock"]
    end

    subgraph Z2M["Zone 2b — module state\n~/.gan-module-state/repo-key/"]
        direction TB
        PR["docker/port-registry.json\ncross-worktree port allocation"]
    end

    subgraph Z3["Zone 3 — cache (ephemeral)\n.gan-state/"]
        direction TB
        SP["spec.md"]
        CO["contract.md"]
        EB["evidence-bundle.json"]
        SC["per-run scratch"]
    end

    CS["Config Server"]
    TR["Trace emitter"]
    DK["docker module"]
    AG["Agents"]

    CS -->|"reads / writes overlays + stacks"| Z1
    CS -->|"run lock · run progress"| Z2R
    TR -->|"appends NDJSON events"| Z2R
    DK -->|"reads / writes"| Z2M
    AG -->|"reads / writes"| Z3
    CS -->|"reads evidence bundle"| Z3
```

---

## 5 — Evaluator-core internals

`src/agents/evaluator-core/` is a pure TypeScript library loaded by the evaluator agent.
`buildEvaluatorPlan` is its single entry point — a deterministic, no-I/O function that
produces a byte-stable `EvaluatorPlan` for the same inputs regardless of call order or process.

```mermaid
flowchart LR
    subgraph IN["Inputs — assembled by the evaluator agent"]
        direction TB
        SNP["EvaluatorCoreSnapshot\nactiveStacks[]\n  · name · scope · secretsGlob\n  · auditCmd\n  · buildCmd · testCmd · lintCmd\n  · securitySurfaces[]\nmergedSplicePoints\n  · evaluator.additionalChecks"]
        SPL["SprintPlan\naffectedFiles[]\ncriteria[]"]
        WTS["WorktreeState\nfiles[]\nfileContents?"]
    end

    PB["buildEvaluatorPlan\nplan-builder.ts\nPure function · no I/O · deterministic\nOrchestrates all five builders"]

    subgraph BL["Builders · one per EvaluatorPlan section"]
        direction TB
        BAS["buildActiveStacks\nSort active stacks by name"]
        BSS["buildSecretsScans\nuses: activeStacks · worktree.files\n1 · Filter worktree files to stack scope\n2 · Per extension: match **/*.ext\n3 · Sort by (stack · extension)"]
        BAC["buildAuditCommands\nuses: activeStacks\nPer stack with auditCmd:\n  emit command + absenceSignal\nSort by stack name"]
        BBT["buildBuildTestLint\nuses: activeStacks\nSort stacks by name\nFirst-stack-wins per phase\n  buildCmd · testCmd · lintCmd"]
        BSI["buildSecuritySurfacesInstantiated\nuses: activeStacks · affectedFiles · fileContents\n1 · affectedFiles ∩ stack.scope\n2 · If trigger.scope → ∩ trigger.scope\n3 · If trigger.keywords → scan fileContents\n4 · No triggers → instantiate if touched non-empty\n5 · Record scopeMatched + keywordsHit\nSort by (stack · id)"]
        BAD["buildEvaluatorAdditionalChecks\nuses: mergedSplicePoints\nPass-through evaluator.additionalChecks verbatim"]
    end

    subgraph OUT["EvaluatorPlan"]
        direction TB
        OAS["activeStacks[]\nname · scope"]
        OSS["secretsScans[]\nstack · extension · files[]"]
        OAC["auditCommands[]\nstack · command · absenceSignal"]
        OBT["buildTestLint\nbuildCmd? · testCmd? · lintCmd?"]
        OSI["securitySurfacesInstantiated[]\nstack · id · templateText\ntriggerEvidence { scopeMatched · keywordsHit }\nappliesToFiles[]"]
        OAD["evaluatorAdditionalChecks[]\ncommand · on_failure · tier"]
    end

    SNP --> PB
    SPL --> PB
    WTS --> PB

    PB --> BAS & BSS & BAC & BBT & BSI & BAD

    BAS --> OAS
    BSS --> OSS
    BAC --> OAC
    BBT --> OBT
    BSI --> OSI
    BAD --> OAD
```

---

## Key structural principles

- **Config Server is the sole gateway to zone 1 and zone 2.** Agents and the skill never read config files or run-state directly — they call MCP tools.
- **Zone 3 is the only shared scratch space agents write to directly.** It is ephemeral; nothing in zone 3 survives worktree removal.
- **The trace emitter is the only writer to the zone-2 run log.** The reconciler is the only reader outside the normal flow.
- **Trust gate runs before every resolution.** No resolved config is served from an unapproved file hash.
