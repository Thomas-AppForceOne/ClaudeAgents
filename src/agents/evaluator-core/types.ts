

export interface AuditCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
}

export interface DocLintCmd {
  command: string;
  absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  absenceMessage?: string;
  severity: 'blocker' | 'warning' | 'advisory';
  baseline?: 'delta' | 'absolute';
}

export interface SecuritySurface {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

export interface DocumentationSurface {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

export interface EvaluatorCoreSnapshot {

  activeStacks: Array<{
    name: string;
    scope: string[];
    secretsGlob?: string[];
    auditCmd?: AuditCmd;
    docLintCmd?: DocLintCmd;
    buildCmd?: string;
    testCmd?: string;
    lintCmd?: string;
    securitySurfaces?: SecuritySurface[];
    documentationSurfaces?: DocumentationSurface[];
  }>;

  mergedSplicePoints: {
    'evaluator.additionalChecks'?: Array<{
      command: string;
      on_failure: string;
      tier: string;
    }>;
  };
}

export interface SprintPlan {

  affectedFiles: string[];

  criteria: Array<{ id: string; description: string }>;
}

export interface WorktreeState {

  files: string[];

  fileContents?: Record<string, string>;
}

export interface EvaluatorPlan {
  activeStacks: Array<{ name: string; scope: string[] }>;
  secretsScans: Array<{ stack: string; extension: string; files: string[] }>;
  auditCommands: Array<{
    stack: string;
    command: string;
    absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  }>;

  docLintInvocations: Array<{
    stack: string;
    command: string;
    scope: string[];
    severity: 'blocker' | 'warning' | 'advisory';
    baseline: 'delta' | 'absolute';
    absenceSignal: 'silent' | 'warning' | 'blockingConcern';
  }>;
  buildTestLint: { buildCmd?: string; testCmd?: string; lintCmd?: string };
  securitySurfacesInstantiated: Array<{
    stack: string;
    id: string;
    templateText: string;
    triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };
    appliesToFiles: string[];
  }>;

  documentationSurfacesInstantiated: Array<{
    stack: string;
    id: string;
    templateText: string;
    triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };
    appliesToFiles: string[];
  }>;
  evaluatorAdditionalChecks: Array<{
    command: string;
    on_failure: string;
    tier: string;
  }>;
}
