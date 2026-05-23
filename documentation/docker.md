# GAN — Docker Module

An optional GAN module that manages Docker container names and host-port allocation across git worktrees, activated passively by manifest discovery at Config Server startup.

---

## 1 — Module activation

```mermaid
flowchart LR
    subgraph Startup ["Config Server startup"]
        A[Scan module directories\nfor manifest.json] --> B{manifest.json\nfound?}
        B -- No --> C[Skip module]
        B -- Yes --> D[Read configKey,\nexports, prerequisites,\nstateKeys]
        D --> E{Prerequisite\ncheck passes?\ndocker --version}
        E -- Fails --> F[Throw\nModulePrerequisiteFailed\nwith errorHint]
        E -- Passes --> G[Register module\nunder configKey docker]
    end

    subgraph Surface ["Agent access surface"]
        G --> H[getModuleState\nsetModuleState MCP tools]
        G --> I[TypeScript exports:\nPortRegistry · PortDiscovery\nContainerHealth · PortValidator\nContainerNaming]
    end
```

---

## 2 — Type model

```mermaid
classDiagram
    class PortRegistry {
        <<class>>
        -projectRoot string
        -worktreeExists WorktreeExistsProbe
        +register(worktreePath, port, containerName) void
        +lookup(worktreePath) object | null
        +getAll() PortRegistryEntry[]
        +release(worktreePath) void
    }

    class PortRegistryEntry {
        <<interface>>
        +worktreePath string
        +port number
        +containerName string
    }

    class PortRegistryFile {
        <<interface>>
        +version 1
        +entries Record~string, object~
    }

    class PortDiscovery {
        <<namespace>>
        +discoverPort(options) Promise~number~
    }

    class DiscoverPortOptions {
        <<interface>>
        +envVar? string
        +worktreePath? string
        +registry? PortRegistry
        +containerPattern? string
        +fallbackPort? number
        +dockerPsRunner? DockerPsRunner
        +env? ProcessEnv
        +logger? Logger
    }

    class ContainerHealth {
        <<namespace>>
        +waitForHealthy(port, options) Promise~true~
    }

    class WaitForHealthyOptions {
        <<interface>>
        +path string
        +expectStatus number
        +timeoutSeconds number
        +fetchImpl? fetch
        +host? string
    }

    class PortValidator {
        <<namespace>>
        +isPortFree(port, options) Promise~boolean~
    }

    class IsPortFreeOptions {
        <<interface>>
        +platform? Platform
        +runner? PortProbeRunner
    }

    class ContainerNaming {
        <<namespace>>
        +nameForWorktree(worktreePath, options?) string
    }

    PortRegistry ..> PortRegistryEntry : returns
    PortRegistry ..> PortRegistryFile : persists
    PortDiscovery ..> DiscoverPortOptions : accepts
    PortDiscovery ..> PortRegistry : layer 2 lookup
    ContainerHealth ..> WaitForHealthyOptions : accepts
    PortValidator ..> IsPortFreeOptions : accepts
```

---

## 3 — Port allocation flow

```mermaid
flowchart TD
    A([Agent requests port\nfor worktree]) --> B[ContainerNaming.nameForWorktree\nDerive deterministic\ncontainer name from\nworktree path + sha256 suffix]
    B --> C[PortValidator.isPortFree\nCheck candidate port\non macOS via lsof\non Linux via ss]
    C -- Port bound --> D[Try next candidate port]
    D --> C
    C -- Port free --> E[PortRegistry.load\nRead shared registry via\ngetModuleState\nPrune absent worktrees]
    E --> F{Port already\nallocated to\nanother worktree?}
    F -- Yes: PortInUse error --> G[Try next candidate port]
    G --> C
    F -- No --> H[PortRegistry.register\nWrite worktreePath → port +\ncontainerName via setModuleState]
    H --> I([Return port +\ncontainerName to agent])
```

---

## 4 — Container lifecycle sequence

```mermaid
sequenceDiagram
    participant Agent
    participant PortDiscovery
    participant PortValidator
    participant PortRegistry
    participant ContainerHealth

    Agent->>PortDiscovery: discoverPort(options)
    PortDiscovery->>PortDiscovery: Layer 1 — check env var
    PortDiscovery->>PortRegistry: Layer 2 — lookup(worktreePath)
    PortRegistry-->>PortDiscovery: null (no prior allocation)
    PortDiscovery->>PortDiscovery: Layer 3 — docker ps probe
    PortDiscovery-->>Agent: fallbackPort (layer 4)

    Agent->>PortValidator: isPortFree(port)
    PortValidator-->>Agent: true

    Agent->>PortRegistry: register(worktreePath, port, containerName)
    PortRegistry->>PortRegistry: load + prune stale entries
    PortRegistry->>PortRegistry: check for PortInUse conflict
    PortRegistry-->>Agent: ok (port registered)

    Agent->>Agent: docker run --name <containerName>\n-p <port>:80 ...

    Agent->>ContainerHealth: waitForHealthy(port, {path, expectStatus, timeoutSeconds})
    loop Poll every 200ms (max 2s per fetch)
        ContainerHealth->>ContainerHealth: fetch http://localhost:<port><path>
        ContainerHealth-->>ContainerHealth: status != expectStatus
    end
    ContainerHealth-->>Agent: true (service healthy)

    Agent->>Agent: Use container on port

    Note over Agent,PortRegistry: Worktree removed / cleanup
    Agent->>PortRegistry: release(worktreePath)
    PortRegistry->>PortRegistry: deleteEntry + persist via setModuleState
    PortRegistry-->>Agent: ok (port freed)
```
