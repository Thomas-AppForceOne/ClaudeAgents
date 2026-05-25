# GAN — Agent Layer

Five specialised LLM agents orchestrated by the `/gan` skill in a fixed pipeline: planner produces a spec, contract-proposer and contract-reviewer establish measurable acceptance criteria, generator implements one feature at a time, and evaluator scores the result against the contract.

---

## 1 — Agent pipeline
```mermaid
flowchart LR
    subgraph ORCH["Orchestrator · /gan skill"]
        direction TB
        SK["snapshot\n(frozen for run)"]
    end

    subgraph PIPELINE["Agent pipeline"]
        direction LR
        PL["planner"]
        CP["contract-proposer"]
        CR["contract-reviewer"]
        GN["generator"]
        EV["evaluator\n+ evaluator-core"]
    end

    PL -->|"spec.md"| CP
    CP -->|"sprint-N-contract-draft.json"| CR
    CR -->|"sprint-N-review.json\n(approved / revise)"| GN
    GN -->|"commits on branch"| EV
    EV -->|"sprint-N-feedback-A.json\n(evidence bundle)"| ORCH

    ORCH -->|"snapshot + prompt"| PL
    ORCH -.->|"snapshot passed to every agent"| PIPELINE
```

---

## 2 — Artefact type model
```mermaid
classDiagram
    class Spec {
        +productOverview: string
        +techStack: string
        +designLanguage: string
        +securityAndPrivacy: string
        +featureList: Feature[]
        +sprintPlan: Sprint[]
        +thresholdOverride?: number
    }

    class Sprint {
        +number: int
        +theme: string
        +features: string[]
    }

    class ContractDraft {
        +sprintNumber: int
        +features: string[]
        +criteria: Criterion[]
    }

    class Criterion {
        +name: string
        +description: string
        +threshold: int
        +rationale: string
        +referenceArtifacts?: ReferenceArtifact[]
    }

    class ReferenceArtifact {
        +path: string
        +kind: string
        +purpose: string
    }

    class Verdict {
        +sprintNumber: int
        +verdict: string
        +notes: string
    }

    class EvidenceBundle {
        +sprintNumber: int
        +attemptLetter: string
        +criteria: CriterionResult[]
        +verdictSummary: VerdictSummary
    }

    class CriterionResult {
        +name: string
        +verdict: string
        +evidence: Evidence
    }

    class Evidence {
        +traceEventRefs: string[]
        +reproductionCommand: string
        +deltaFromContract?: DeltaFromContract
    }

    class DeltaFromContract {
        +expected: string
        +observed: string
    }

    class VerdictSummary {
        +totalCriteria: int
        +passed: int
        +failed: int
        +blocked: int
        +skipped: int
    }

    class Objection {
        +sprintNumber: int
        +attempt: int
        +target: string
        +reason: string
        +proposedChange: string
    }

    Spec "1" --> "*" Sprint
    ContractDraft "1" --> "*" Criterion
    Criterion "0..1" --> "*" ReferenceArtifact
    EvidenceBundle "1" --> "*" CriterionResult
    CriterionResult "1" --> "1" Evidence
    Evidence "0..1" --> "1" DeltaFromContract
    EvidenceBundle "1" --> "1" VerdictSummary
```

---

## 3 — Sprint orchestration sequence
```mermaid
sequenceDiagram
    participant SK as /gan skill
    participant PL as planner
    participant CP as contract-proposer
    participant CR as contract-reviewer
    participant GN as generator
    participant EV as evaluator

    SK->>+PL: snapshot + user prompt
    PL-->>-SK: PLANNING COMPLETE: N sprints defined
    Note over SK,PL: spec.md written to run dir

    loop for each sprint N

        SK->>+CP: snapshot + spec + prior history
        CP-->>-SK: CONTRACT DRAFT written for sprint N
        Note over SK,CP: sprint-N-contract-draft.json written

        loop until approved (max revisions)
            SK->>+CR: snapshot + contract draft + spec
            CR-->>-SK: CONTRACT APPROVED / REVISION REQUESTED
            alt revise
                SK->>+CP: snapshot + revision notes
                CP-->>-SK: revised CONTRACT DRAFT
            end
        end

        Note over SK: locked contract becomes sprint-N-contract.json

        loop for each attempt A (max-attempts)
            alt first attempt
                SK->>+GN: snapshot + contract + sprint plan
            else retry
                SK->>+GN: snapshot + contract + sprint plan\n+ prior feedback sprint-N-feedback-(A-1).json
            end

            alt objection raised
                GN-->>-SK: OBJECTION RAISED for sprint N attempt A
                SK->>+CP: snapshot + objection payload
                CP-->>-SK: revised CONTRACT DRAFT
                Note over SK: re-enter reviewer loop
            else implementation complete
                GN-->>-SK: sprint summary + commits on branch
            end

            SK->>+EV: snapshot + contract + worktree
            EV-->>-SK: SPRINT N ATTEMPT A: PASSED or FAILED

            alt PASSED
                Note over SK: advance to next sprint
            else FAILED and attempts remain
                Note over SK: retry generator with feedback
            else FAILED and no attempts remain
                Note over SK: mark sprint failed, halt or continue
            end
        end

    end
```

---

## 4 — Generator feature loop
```mermaid
flowchart TD
    START(["generator spawned\nwith contract + snapshot"])
    CHECK_RETRY{"prior feedback\navailable?"}
    READ_FEEDBACK["read failed criteria\nfrom feedback bundle"]
    READ_CONTRACT["read sprint contract\nand spec"]
    CHECK_OBJECT{"criterion impossible\nor contradictory?"}
    EMIT_OBJECT["write objection JSON\nOBJECTION RAISED"]
    PICK_FEATURE["select next\nunimplemented feature"]
    IMPLEMENT["implement feature\nin worktree"]
    VERIFY["run buildCmd + testCmd\n+ lintCmd from snapshot\n(per active stack scope)"]
    VERIFY_OK{"verification\npassed?"}
    FIX["fix failures\n(same feature)"]
    COMMIT["git commit\n(descriptive message)"]
    MORE{"more features\nin contract?"}
    SELF_EVAL["self-evaluate against\nall contract criteria"]
    DONE(["print sprint summary\nSPRINT COMPLETE"])
    BLOCKED(["print OBJECTION RAISED\nexit without implementing"])

    START --> CHECK_RETRY
    CHECK_RETRY -->|"yes"| READ_FEEDBACK
    CHECK_RETRY -->|"no"| READ_CONTRACT
    READ_FEEDBACK --> READ_CONTRACT
    READ_CONTRACT --> CHECK_OBJECT
    CHECK_OBJECT -->|"yes, and no prior objection\nthis sprint"| EMIT_OBJECT
    EMIT_OBJECT --> BLOCKED
    CHECK_OBJECT -->|"no — proceed"| PICK_FEATURE
    PICK_FEATURE --> IMPLEMENT
    IMPLEMENT --> VERIFY
    VERIFY --> VERIFY_OK
    VERIFY_OK -->|"no"| FIX
    FIX --> VERIFY
    VERIFY_OK -->|"yes"| COMMIT
    COMMIT --> MORE
    MORE -->|"yes"| PICK_FEATURE
    MORE -->|"no"| SELF_EVAL
    SELF_EVAL --> DONE
```

---

## 5 — Evaluator scoring flow
```mermaid
flowchart TD
    START(["evaluator spawned\nwith contract + snapshot\n+ worktree path"])
    PLAN["consume evaluator-core plan\n(per-stack checks in order)"]
    RUN_CHECKS["execute plan checks:\nsecrets scan · dependency audit · doc-lint\nlint · test · build\nadditional overlay checks"]
    WARN{"plan-derived\nwarnings?"}
    SURFACE_WARN["surface warnings verbatim\n(tool absence, scope mismatch)"]
    SCORE["score each criterion\nagainst its own threshold\n(1–10 scale)"]
    CRITERION{"criterion\nsatisfiable?"}
    RECORD_BLOCKED["record verdict: blocked\nwith reason in evidence"]
    RECORD_VERDICT["record pass / fail\nwith traceEventRefs\n+ reproductionCommand\n+ deltaFromContract (if fail)"]
    ALL_DONE{"all contract\ncriteria scored?"}
    WRITE_BUNDLE["write evidence bundle\nsprint-N-feedback-A.json"]
    CHECK_RESULT{"all criteria\npassed?"}
    PASSED(["print SPRINT N ATTEMPT A: PASSED"])
    FAILED(["print SPRINT N ATTEMPT A:\nFAILED (X/total passed)"])

    START --> PLAN
    PLAN --> RUN_CHECKS
    RUN_CHECKS --> WARN
    WARN -->|"yes"| SURFACE_WARN
    SURFACE_WARN --> SCORE
    WARN -->|"no"| SCORE
    SCORE --> CRITERION
    CRITERION -->|"blocked\n(out-of-contract dependency\nor unsatisfiable precondition)"| RECORD_BLOCKED
    CRITERION -->|"scoreable"| RECORD_VERDICT
    RECORD_BLOCKED --> ALL_DONE
    RECORD_VERDICT --> ALL_DONE
    ALL_DONE -->|"no"| SCORE
    ALL_DONE -->|"yes"| WRITE_BUNDLE
    WRITE_BUNDLE --> CHECK_RESULT
    CHECK_RESULT -->|"yes"| PASSED
    CHECK_RESULT -->|"no"| FAILED
```
