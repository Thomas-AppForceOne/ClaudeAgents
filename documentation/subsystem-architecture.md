# GAN — Subsystem Architecture

High-level technical documentation showing how the GAN framework subsystems cooperate.

---

## 1 — Component architecture

```mermaid
flowchart TB
    CLI["gan CLI\nsrc/cli/"]
    SKILL["/gan skill\nskills/gan/"]

    subgraph AL["Agent layer  ·  agents/"]
        direction LR
        PL["planner"]
        CP["contract-proposer"]
        CR["contract-reviewer"]
        GN["generator"]
        EV["evaluator\n+ evaluator-core"]
    end

    HOOK["Confinement hook\nPreToolUse  ·  H1"]

    subgraph CS["Config Server  ·  src/config-server/  ·  MCP"]
        MT["Tool surface\nreads · writes · validate"]
        TG["Trust gate"]
        RP["Resolution pipeline\ndetection → cascade → invariants"]
        ST["Storage"]
        MT --> TG --> RP --> ST
    end

    subgraph TR["Trace  ·  src/trace/"]
        EM["Emitter"]
        RC["Reconciler  ·  O2"]
    end

    DK["docker module\nsrc/modules/docker/"]
    SCH["schemas/\nJSON Schemas  ·  F3"]

    subgraph ZN["Storage zones"]
        Z1[".claude/gan/\nzone 1 · config"]
        Z2R["~/.gan-runs-data/\nzone 2 · runs + traces"]
        Z2M["~/.gan-module-state/\nzone 2 · module state"]
        Z3[".gan-state/\nzone 3 · cache"]
    end

    CLI -->|"stdio MCP"| MT
    SKILL -->|"orchestrates"| AL
    AL -->|"MCP tool calls"| MT
    HOOK -.->|"gates all agent tool calls"| AL

    RP -->|"validates against"| SCH
    ST --> Z1 & Z2R & Z2M & Z3

    SKILL -->|"emit trace events"| EM
    AL -->|"emit trace events"| EM
    EM --> Z2R
    RC -->|"reads for recovery"| Z2R

    DK -->|"registered with"| MT
    DK -->|"state"| Z2M
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

    subgraph TG["Trust gate  ·  trust/  ·  F4 R5"]
        HC["Content-hash all overlay + stack files"]
        TP["Compare against approved hashes\nPrompt user if new or changed  ·  F6"]
        HC --> TP
    end

    subgraph RP["Resolution pipeline  ·  resolution/"]
        DT["Detection\nScan project for stack indicators  ·  C2"]
        SL["Stack loader\nBuilt-in → tier-3 → tier-2 → tier-1  ·  C5"]
        OL["Overlay loader\nUser → project tiers  ·  C3"]
        CM["Cascade merge\nOverlays applied on top of stacks  ·  C4"]
        SV["Schema validation\nstack-v1.json · overlay-v1.json  ·  F3"]
        IV["Invariants\n8 cross-field constraint checks  ·  F5"]
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
        CMC[".claude/gan/modules/\nmodule configs  e.g. docker.yaml"]
    end

    subgraph Z2R["Zone 2a — runs\n~/.gan-runs-data/repo-key/"]
        direction TB
        RT["run-trace-*.ndjson\nT1 structured event log"]
        RI["run-index.json"]
        RA["recovery-anchor.json  ·  O2"]
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

## Key structural principles

- **Config Server is the sole gateway to zone 1 and zone 2.** Agents and the skill never read config files or run-state directly — they call MCP tools.
- **Zone 3 is the only shared scratch space agents write to directly.** It is ephemeral; nothing in zone 3 survives worktree removal.
- **The trace emitter is the only writer to the zone-2 run log.** The reconciler (O2 recovery) is the only reader outside the normal flow.
- **Trust gate runs before every resolution.** No resolved config is served from an unapproved file hash.
