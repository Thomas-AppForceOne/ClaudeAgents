# GAN — Evaluator-core

Technical documentation for the evaluator-core deterministic subsystem.

---

## 1 — Internals overview
```mermaid
flowchart LR
    subgraph IN["Inputs — assembled by the evaluator agent"]
        direction TB
        SNP["EvaluatorCoreSnapshot\nactiveStacks[]\n  · name · scope · secretsGlob\n  · auditCmd\n  · buildCmd · testCmd · lintCmd\n  · securitySurfaces[]\nmergedSplicePoints\n  · evaluator.additionalChecks"]
        SPL["SprintPlan\naffectedFiles[]\ncriteria[]"]
        WTS["WorktreeState\nfiles[]\nfileContents?"]
    end

    PB["buildEvaluatorPlan\nPure function · no I/O · deterministic\nOrchestrates all five builders"]

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

## 2 — Type model
```mermaid
classDiagram
    class EvaluatorCoreSnapshot {
        <<interface>>
        +activeStacks StackEntry[]
        +mergedSplicePoints MergedSplicePoints
    }
    class StackEntry {
        +name string
        +scope string[]
        +secretsGlob string[]
        +auditCmd AuditCmd
        +buildCmd string
        +testCmd string
        +lintCmd string
        +securitySurfaces SecuritySurface[]
    }
    class AuditCmd {
        <<interface>>
        +command string
        +absenceSignal string
        +absenceMessage string
    }
    class SecuritySurface {
        <<interface>>
        +id string
        +template string
        +triggers Triggers
    }
    class Triggers {
        +keywords string[]
        +scope string[]
    }
    class MergedSplicePoints {
        +additionalChecks AdditionalCheck[]
    }
    class SprintPlan {
        <<interface>>
        +affectedFiles string[]
        +criteria Criterion[]
    }
    class Criterion {
        +id string
        +description string
    }
    class WorktreeState {
        <<interface>>
        +files string[]
        +fileContents Record~string,string~
    }
    class EvaluatorPlan {
        <<interface>>
        +activeStacks ActiveStack[]
        +secretsScans SecretsRow[]
        +auditCommands AuditRow[]
        +buildTestLint BuildTestLint
        +securitySurfacesInstantiated SecurityRow[]
        +evaluatorAdditionalChecks AdditionalCheck[]
    }
    class ActiveStack {
        +name string
        +scope string[]
    }
    class SecretsRow {
        +stack string
        +extension string
        +files string[]
    }
    class AuditRow {
        +stack string
        +command string
        +absenceSignal string
    }
    class BuildTestLint {
        +buildCmd string
        +testCmd string
        +lintCmd string
    }
    class SecurityRow {
        +stack string
        +id string
        +templateText string
        +triggerEvidence TriggerEvidence
        +appliesToFiles string[]
    }
    class TriggerEvidence {
        +scopeMatched string[]
        +keywordsHit string[]
    }
    class AdditionalCheck {
        +command string
        +on_failure string
        +tier string
    }

    EvaluatorCoreSnapshot "1" *-- "n" StackEntry : activeStacks
    EvaluatorCoreSnapshot *-- MergedSplicePoints
    StackEntry o-- AuditCmd
    StackEntry "1" *-- "n" SecuritySurface
    SecuritySurface o-- Triggers
    MergedSplicePoints "1" *-- "n" AdditionalCheck
    SprintPlan "1" *-- "n" Criterion
    EvaluatorPlan "1" *-- "n" ActiveStack
    EvaluatorPlan "1" *-- "n" SecretsRow
    EvaluatorPlan "1" *-- "n" AuditRow
    EvaluatorPlan *-- BuildTestLint
    EvaluatorPlan "1" *-- "n" SecurityRow
    EvaluatorPlan "1" *-- "n" AdditionalCheck
    SecurityRow *-- TriggerEvidence
```

---

## 3 — Execution flow
```mermaid
flowchart TD
    IN1["EvaluatorCoreSnapshot"]
    IN2["SprintPlan"]
    IN3["WorktreeState"]

    MAIN["buildEvaluatorPlan"]

    B1["buildActiveStacks\nsort by name"]
    B2["buildSecretsScans\nglob expansion · scope filter · sort by stack+ext"]
    B3["buildAuditCommands\nverbatim passthrough · sort by stack name"]
    B4["buildBuildTestLint\nfirst-stack-wins per phase"]
    B5["buildSecuritySurfacesInstantiated\nC1 template instantiation · sort by stack+id"]
    B6["buildEvaluatorAdditionalChecks\nsplice-point passthrough verbatim"]

    OUT["EvaluatorPlan\nbyte-stable"]

    IN1 & IN2 & IN3 --> MAIN
    MAIN --> B1 & B2 & B3 & B4 & B5 & B6
    B1 & B2 & B3 & B4 & B5 & B6 --> OUT
```

---

## 4 — Security surface instantiation algorithm
```mermaid
flowchart TD
    FOR_STACK(["for each active stack"])
    SCOPE_TOUCHED["stackScopedTouched =\naffectedFiles ∩ stack.scope"]
    FOR_SURFACE(["for each security surface"])

    HAS_TSCOPE{"trigger.scope\npresent?"}
    FILTER_TSCOPE["candidateFiles =\nstackScopedTouched ∩ trigger.scope"]
    CAND_EMPTY{"candidateFiles\nempty?"}
    USE_STACK["candidateFiles =\nstackScopedTouched"]

    NO_TRIGGERS{"no triggers\nat all?"}
    STACK_EMPTY{"stackScopedTouched\nempty?"}

    HAS_KW{"trigger.keywords\npresent?"}
    SCAN["scan candidateFiles\nfor each keyword"]
    NO_MATCH{"any\nmatches?"}
    COLLECT["scopeMatched = matched files\nkeywordsHit = matched keywords"]
    SORT_SCOPE["scopeMatched =\ncandidateFiles sorted"]

    SKIP(["skip · return null"])
    INSTANTIATE["instantiate surface\ntriggerEvidence = { scopeMatched, keywordsHit }"]
    SORT_OUT["sort rows by (stack, id)"]
    DONE(["return rows"])

    FOR_STACK --> SCOPE_TOUCHED --> FOR_SURFACE --> HAS_TSCOPE
    HAS_TSCOPE -->|yes| FILTER_TSCOPE --> CAND_EMPTY
    CAND_EMPTY -->|yes| SKIP
    CAND_EMPTY -->|no| HAS_KW
    HAS_TSCOPE -->|no| USE_STACK --> NO_TRIGGERS
    NO_TRIGGERS -->|yes| STACK_EMPTY
    STACK_EMPTY -->|yes| SKIP
    STACK_EMPTY -->|no| HAS_KW
    NO_TRIGGERS -->|no| HAS_KW
    HAS_KW -->|yes| SCAN --> NO_MATCH
    NO_MATCH -->|no| SKIP
    NO_MATCH -->|yes| COLLECT --> INSTANTIATE
    HAS_KW -->|no| SORT_SCOPE --> INSTANTIATE
    INSTANTIATE --> FOR_SURFACE
    SKIP --> FOR_SURFACE
    FOR_SURFACE -->|done| SORT_OUT --> DONE
```

---

## 5 — Call sequence
```mermaid
sequenceDiagram
    participant CA as Caller
    participant PB as buildEvaluatorPlan
    participant BAS as buildActiveStacks
    participant BSS as buildSecretsScans
    participant BAC as buildAuditCommands
    participant BBT as buildBuildTestLint
    participant BSI as buildSecuritySurfacesInstantiated
    participant BAD as buildEvaluatorAdditionalChecks

    CA->>PB: buildEvaluatorPlan(snapshot, sprintPlan, worktreeState)

    PB->>BAS: buildActiveStacks(snapshot)
    BAS-->>PB: activeStacks[] sorted by name

    PB->>BSS: buildSecretsScans(snapshot, worktreeState)
    loop for each stack with secretsGlob
        BSS->>BSS: filter worktree.files to stack.scope
        BSS->>BSS: per extension match **/*.ext
    end
    BSS-->>PB: secretsScans[] sorted by (stack, ext)

    PB->>BAC: buildAuditCommands(snapshot)
    BAC-->>PB: auditCommands[] sorted by stack name

    PB->>BBT: buildBuildTestLint(snapshot)
    Note over BBT: sort stacks by name · first-stack-wins per phase
    BBT-->>PB: buildTestLint {buildCmd, testCmd, lintCmd}

    PB->>BSI: buildSecuritySurfacesInstantiated(snapshot, sprintPlan, worktreeState)
    loop for each stack · surface
        BSI->>BSI: stackScopedTouched = affectedFiles ∩ stack.scope
        alt trigger.scope present
            BSI->>BSI: candidateFiles = stackScopedTouched ∩ trigger.scope
        else no trigger.scope
            BSI->>BSI: candidateFiles = stackScopedTouched
        end
        alt trigger.keywords present
            BSI->>BSI: scan fileContents for keywords
        end
    end
    BSI-->>PB: securitySurfacesInstantiated[] sorted by (stack, id)

    PB->>BAD: buildEvaluatorAdditionalChecks(snapshot)
    BAD-->>PB: evaluatorAdditionalChecks[] verbatim passthrough

    PB-->>CA: EvaluatorPlan (byte-stable)
```
