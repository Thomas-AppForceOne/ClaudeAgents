# GAN — Trace

The Trace subsystem is the run-observation layer: `TraceEmitter` appends typed NDJSON events to an append-only per-run log, and the reconciler rebuilds a derivative index from those events for recovery and reporting.

---

## 1 — Event taxonomy

```mermaid
flowchart LR
    subgraph Envelope["Common envelope (every event)"]
        ENV["sequenceNumber\ntimestamp\nrunId\neventType"]
    end

    subgraph KnownClasses["Seven v1 event classes"]
        OM["orchestratorMilestone\n─────────────────\nmilestone\ndisposition?\nsummary?"]
        AA["agentAttempt\n─────────────────\nrole\nattemptNumber\ninputDigest\noutputArtifactPath\ndisposition"]
        LC["llmCall\n─────────────────\nmodel · role\npromptRef · responseRef\ntokensInput · tokensCached\ntokensOutput · latencyMs\ncacheHit"]
        TC["toolCall\n─────────────────\ntool · role\nargumentsRef · resultRef\ndisposition · latencyMs"]
        SH["safetyHalt\n─────────────────\nsafetyClass\nrole\npayload"]
        TE["trustEvent\n─────────────────\npromptVariant\nuserChoice\ncontentHash"]
        VA["validationAbort\n─────────────────\nvalidationStage\nerrorCode\nerrorPayload"]
    end

    ENV --> OM & AA & LC & TC & SH & TE & VA
```

---

## 2 — Emission flow

```mermaid
flowchart TD
    Caller["Caller\n(orchestrator / agent)"]
    Emitter["TraceEmitter\nallocateSequence()\nenvelope()"]
    Persist["persist(event)"]

    subgraph Payload["Payload storage (full mode only)"]
        PayRef["buildPayloadRef()\n→ <seq>/<role>.<class>.<ext>"]
        PayFile["writePayloadFile()\natomic temp+rename\nunder payloads/"]
    end

    AppendEvent["appendEventFile()\natomic temp+rename\nevents/<seq(10)>.json"]
    UpdateIdx["recordInIndex()\nO(1) fold into\nin-memory TraceIndex"]
    WriteIdx["writeIndex()\nstableStringify → index.json\n(written LAST — may lag)"]

    Caller -->|"emitLlmCall / emitToolCall\nemitAgentAttempt / …"| Emitter
    Emitter --> Persist
    Emitter -->|"redaction = full"| PayRef --> PayFile
    Persist --> AppendEvent
    Persist --> UpdateIdx
    Persist --> WriteIdx
```

---

## 3 — Index and reconciliation

```mermaid
flowchart TD
    EventsDir["events/ directory\n(one .json file per event)"]

    subgraph Scan["scanEvents()"]
        ReadFiles["List + read files\noldest-first by filename"]
        ParseJSON["Parse JSON\n(untrusted input)"]
        Guard["safeMergeParsedObject()\nprototype-pollution guard"]
        Classify["Classify each file\n• known class → TraceEvent[]\n• unknown envelope → UnknownClassEvent[]\n• malformed → malformedEnvelopeCount\n• no sequence → missingSequenceCount"]
    end

    BuildIdx["buildIndex()\ncount by class\nfirst/last timestamp\ndisposition from last\norchestratorMilestone"]
    ReconcileIdx["reconcileIndex()\nrebuild index from events\n(events win over stale index)"]
    WriteIdx["writeIndex()\nstableStringify\natomic write → index.json"]

    EventsDir --> ReadFiles --> ParseJSON --> Guard --> Classify
    Classify -->|"events + unknownClassEvents"| BuildIdx
    BuildIdx --> ReconcileIdx --> WriteIdx
    ReconcileIdx -->|"TraceIndex"| Caller2["Caller\n(emitter startup\nor recovery)"]
```

---

## 4 — Type model

```mermaid
classDiagram
    class TraceEnvelope {
        <<interface>>
        +sequenceNumber number
        +eventType string
        +timestamp string
        +runId string
    }

    class TraceEvent {
        <<union>>
        OrchestratorMilestoneEvent
        AgentAttemptEvent
        LlmCallEvent
        ToolCallEvent
        SafetyHaltEvent
        TrustEventEvent
        ValidationAbortEvent
    }

    class TraceEmitter {
        <<class>>
        -traceRoot string
        -runId string
        -redaction RedactionMode
        -nextSequence number
        -index TraceIndex
        +emitOrchestratorMilestone()
        +emitAgentAttempt()
        +emitLlmCall()
        +emitToolCall()
        +emitSafetyHalt()
        +emitTrustEvent()
        +emitValidationAbort()
        +reconcile() TraceIndex
        +peekNextSequence() number
        +getRedactionMode() RedactionMode
    }

    class TraceIndex {
        <<interface>>
        +runId string
        +totalEvents number
        +countByClass Record~string,number~
        +firstTimestamp string?
        +lastTimestamp string?
        +disposition string?
    }

    class RecoveryState {
        <<interface>>
        +nextSequence number
        +attemptStateByRole Record~string,RoleAttemptState~
    }

    class RoleAttemptState {
        <<interface>>
        +attemptCount number
        +highestAttemptNumber number
    }

    class SprintSummaryAggregate {
        <<interface>>
        +calls number
        +agents number
        +tokensInput number
        +tokensOutput number
        +tokensCached number
        +elapsedMs number
    }

    class EvidenceBundleVerifyResult {
        <<interface>>
        +ok boolean
        +schemaValid boolean
        +schemaErrors unknown[]
        +failures EvidenceBundleFailure[]
    }

    class EvidenceBundleFailure {
        <<interface>>
        +check EvidenceBundleCheck
        +detail string
        +criterionName string?
        +unresolvedRef string?
    }

    TraceEnvelope <|-- TraceEvent
    TraceEmitter --> TraceIndex : maintains in-memory
    TraceEmitter --> TraceEvent : emits
    RecoveryState --> RoleAttemptState : per role
    EvidenceBundleVerifyResult --> EvidenceBundleFailure : contains
```

---

## 5 — Run lifecycle sequence

```mermaid
sequenceDiagram
    participant GAN as /gan skill
    participant TE as TraceEmitter
    participant Store as events/ + payloads/
    participant Idx as index.json
    participant Rec as reconcileIndex

    GAN->>TE: new TraceEmitter(traceRoot, runId)
    TE->>Store: scanEvents() — read existing events (recovery)
    TE->>Idx: buildIndex() — seed in-memory index

    GAN->>TE: emitOrchestratorMilestone("runStart")
    TE->>Store: appendEventFile(0000000000.json)
    TE->>Idx: writeIndex()

    loop Per agent invocation
        GAN->>TE: emitAgentAttempt(role, attemptNumber, …)
        TE->>Store: appendEventFile(N.json)
        TE->>Idx: writeIndex()

        loop Per LLM call
            GAN->>TE: emitLlmCall(request, payloads, metrics)
            TE->>Store: writePayloadFile(prompt) [full mode]
            TE->>Store: writePayloadFile(response) [full mode]
            TE->>Store: appendEventFile(N.json)
            TE->>Idx: writeIndex()
        end

        loop Per tool call
            GAN->>TE: emitToolCall(tool, payloads, …)
            TE->>Store: writePayloadFile(arguments) [full mode]
            TE->>Store: writePayloadFile(result) [full mode]
            TE->>Store: appendEventFile(N.json)
            TE->>Idx: writeIndex()
        end
    end

    GAN->>TE: emitOrchestratorMilestone("runComplete", disposition)
    TE->>Store: appendEventFile(N.json)
    TE->>Idx: writeIndex()

    Note over GAN,Rec: On next startup or --recover
    GAN->>Rec: reconcileIndex(traceRoot, runId)
    Rec->>Store: scanEvents() — re-read all events
    Rec->>Idx: buildIndex() → writeIndex()
    Rec-->>GAN: TraceIndex (authoritative)
```
