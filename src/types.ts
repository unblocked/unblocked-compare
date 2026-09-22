export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
  thinkingTokens?: number;
  byModel?: Record<string, TokenUsage>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;
  nested?: boolean;
  isMcp: boolean;
  mcpServer?: string;
  model?: string;
}

export interface RunResult {
  durationMs: number;
  wallMs?: number;
  tokenUsage: TokenUsage;
  toolCalls: ToolCall[];
  assistantTurns: number;
  finalResponse: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  killedReason?: string;
  jsonlPath: string;
  worktreePath: string;
  totalCostUsd: number | null;
  costEstimated?: boolean;
}

export interface UnblockedCall {
  tool: string;
  query?: string;
}

export interface DiffStats {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  truncated?: boolean;
}

export type Condition = "baseline" | "unblocked";

export type TurnLabelKind = "work" | "verify" | "housekeeping";

export interface TurnLabel {
  turn: number;
  label: TurnLabelKind;
  repeatOf: number | null;
  reason: string;
}

export interface AttributionTotals {
  costUsd: number;
  inputTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  stallMs: number;
  turns: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface AttributedTurn extends TurnLabel {
  startMs: number;
  costUsd: number;
  durationMs: number;
  modelMs: number;
  toolMs: number;
  stallMs: number;
  outputTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
  summary: string;
}

export interface Attribution {
  analystModel: string;
  analystCostUsd: number;
  outputExact: boolean;
  raw: AttributionTotals;
  core: AttributionTotals;
  housekeeping: AttributionTotals;
  turns: AttributedTurn[];
}

export type Met = "met" | "partial" | "unmet";

export interface QualityRequirement {
  index?: number;
  requirement: string;
  baseline: { status: Met; evidence: string };
  unblocked: { status: Met; evidence: string };
}

export interface QualityCriterion {
  criterion: string;
  baseline: { score: number; rationale: string };
  unblocked: { score: number; rationale: string };
}

export interface DecisiveDiscovery {
  kind: "none" | "improved-outcome" | "invalidated-requirement";
  fact: string;
  effect: string;
  evidence: string;
  requirementIndex?: number;
}

export interface QualityAssessment {
  judgeModel: string;
  judgeCostUsd: number;
  discoveries?: { baseline: DecisiveDiscovery; unblocked: DecisiveDiscovery };
  armA?: Condition;
  requirements: QualityRequirement[];
  criteria: QualityCriterion[];
  findings: { arm: Condition; finding: string; evidence: string }[];
  verdict: { better: Condition | "tie"; rationale: string; blinded?: Condition | "tie"; tieBreaker?: { applied: boolean; reason: string } };
}

export interface EconomicsSide {
  costUsd: number; durationMs: number; modelMs: number; toolMs: number; messages: number;
  outputTokens: number; thinkingTokens: number; visibleTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number; contextPerMessage: number;
  research: { calls: number; payloadTokens: number; carriedTokens: number };
  toolWait: Record<string, number>;
}
export interface EconomicsBreakdown {
  basis: "core" | "raw";
  baseline: EconomicsSide;
  unblocked: EconomicsSide;
  cost: { deltaUsd: number; terms: { output: number; cacheRead: number; cacheWrite: number; input: number }; unexplainedUsd: number };
  cacheRead: { deltaTokens: number; researchCarriedTokens: number; contextPerMessageDelta: number; messagesDelta: number };
  output: { deltaTokens: number; thinkingDelta: number; visibleDelta: number };
  time: { deltaMs: number; modelDeltaMs: number; toolDeltaMs: number; toolWaitDelta: Record<string, number> };
}

export interface ContextImpact {
  model: string;
  costUsd: number;
  research: { turn: number; query: string; itemsReturned: number; itemsUsed: { item: string; use: string }[]; value: "decisive" | "useful" | "unused" | "misleading"; note: string }[];
  discoveryAttribution?: { contextLed: boolean; evidence: string };
  impact: {
    outcome: "better" | "worse" | "similar";
    contextEffect: "helped" | "hurt" | "mixed" | "none";
    outcomeDriver: "context" | "agent" | "both";
    summary: string;
    whatWouldChange: string;
  };
  loss?: {
    baselineFound: string;
    howFound: "systematic search" | "chance" | "n/a";
    unblockedFailure: "context misled" | "stopped searching early" | "context absent, never looked elsewhere" | "unrelated to context" | "n/a";
    explanation: string;
  };
  economics: { cost: string; time: string; tokens: string };
}

export interface ReviewComment { file: string; severity: "must-fix" | "should-fix" | "nit"; comment: string }

export interface ReviewRequirement { index?: number; requirement: string; status: "met" | "partial" | "unmet" | "waived"; note: string }

export interface ReviewAdjudication { index: number; waived: boolean; excludes?: string; reason: string; disputedBy: Condition; round: number }
export interface ReviewSpec { model: string; costUsd: number; requirements: string[]; adjudications: ReviewAdjudication[] }

export interface ReviewPass {
  round: number;
  reviewModel: string;
  reviewCostUsd: number;
  mergeable: boolean;
  summary: string;
  requirements: ReviewRequirement[];
  waiversInForce?: number[];
  comments?: ReviewComment[];
  before: DiffStats;
  fix: { costUsd: number; durationMs: number; messages: number; exitCode: number | null; timedOut: boolean; disputed: string } | null;
}

export interface ReviewRound {
  maxRounds: number;
  passes: ReviewPass[];
  checkFailed?: number;
  draft: { diffStats: DiffStats; costUsd: number; durationMs: number; messages: number };
  finalMergeable: boolean;
}

export interface ArmResult {
  condition: Condition;
  run: RunResult;
  diff: string;
  diffStats: DiffStats;
  unblockedCalls: UnblockedCall[];
  estimatedCost: number;
  attribution?: Attribution;
  review?: ReviewRound;
}

export interface ComparisonResult {
  repo: string;
  task: string;
  branch: string;
  model: string;
  baseline: ArmResult;
  unblocked: ArmResult;
  totalDurationMs: number;
  totalEstimatedCost: number;
  analysisCostUsd?: number;
  reviewSpec?: ReviewSpec;
  quality?: QualityAssessment;
  impact?: ContextImpact;
  economics?: EconomicsBreakdown;
}

export interface Config {
  repo: string;
  task: string;
  model: string;
  timeoutSeconds: number;
  branch: string;
  keepWorktrees: boolean;
  cliMode: boolean;
  analystModel: string | null;
  judgeModel: string;
  checkerModel: string;
  reviewRounds: number;
  repeat: number;
  concurrency: number;
}
