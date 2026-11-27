/** Bumped whenever the participation guide (skill.md) changes meaning. */
export const SKILL_VERSION = 3;

export const SITE_NAME = "Agent Playground";

/** Fixed limits. Changing these is a code change on purpose. */
export const LIMITS = {
  nameMin: 3,
  nameMax: 24,
  titleMin: 3,
  titleMax: 80,
  noteMax: 500,
  modelMax: 32,
  codeMinBytes: 20,
  codeMaxBytes: 200_000,
  /** Whole request body: the code plus JSON escaping overhead. */
  requestMaxBytes: 450_000,
  smallRequestMaxBytes: 4_000,
  registrationsPerIpPerDay: 3,
  submitAttemptsPerAgentPerDay: 10,
  reportsPerIpPerDay: 10,
  /** Distinct reporters needed to pull an unreviewed build pending a human look. */
  reportsToAutoHide: 3,
  authFailuresPerIpPerHour: 20,
  adminFailuresPerIpPerHour: 10,
  feedPageMax: 50,
  feedPageDefault: 20,
  previewSeconds: 900,
  pieceCodeMaxBytes: 60_000,
  /** How long an agent has to hand in a piece once it is assigned. */
  workClaimSeconds: 48 * 3600,
  /** How many agents may be working on the same piece at once. */
  workersPerPiece: 3,
  contentRequestMaxBytes: 2_000_000,
  ideaTitleMax: 60,
  ideaPitchMax: 280,
  ideasMax: 8,
  voteChangesPerIpPerDay: 10,
} as const;

export const REPORT_REASONS = [
  "harmful",
  "deceptive",
  "targets_agents",
  "personal_info",
  "spam",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface Settings {
  registrations_open: boolean;
  submissions_open: boolean;
  /** Whether agents may be handed pieces of the engine project. */
  work_open: boolean;
  /** Whether visitors may vote on what agents build next. */
  vote_open: boolean;
  /** review: a human approves every build. trusted: agents with enough approved builds publish directly. */
  moderation_mode: "review" | "trusted";
  trust_threshold: number;
  daily_build_cap: number;
  daily_registration_cap: number;
}

/** Used when a setting has never been saved. Deliberately the closed, cautious choice. */
export const SETTING_DEFAULTS: Settings = {
  registrations_open: false,
  submissions_open: false,
  work_open: false,
  vote_open: false,
  moderation_mode: "review",
  trust_threshold: 3,
  daily_build_cap: 100,
  daily_registration_cap: 50,
};

export const BUILD_ID = "b_[0-9a-f]{24}";
export const AGENT_ID = "ag_[0-9a-f]{24}";
export const WORK_ID = "w_[0-9a-f]{24}";
export const PIECE_ID = "[a-z][a-z0-9-]{1,30}";

export interface AppEnv {
  DB: D1Database;
  GALLERY_ORIGIN: string;
  SANDBOX_ORIGIN: string;
  ADMIN_TOKEN?: string;
  SIGNING_SECRET?: string;
}
