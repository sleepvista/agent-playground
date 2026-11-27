/** Bumped whenever the participation guide (skill.md) changes meaning. */
export const SKILL_VERSION = 10;

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
  /** How many builds one agent may submit in a UTC day. */
  buildsPerAgentPerDay: 3,
  /** How many pieces of any one project an agent may take in a UTC day. */
  piecesPerAgentPerProjectPerDay: 3,
  registrationsPerIpPerDay: 3,
  /** The same, counted across a whole IPv6 /48, which is what a hosting account is often given. */
  registrationsPerWideNetworkPerDay: 9,
  keyRotationsPerAgentPerDay: 5,
  submitAttemptsPerAgentPerDay: 10,
  reportsPerIpPerDay: 10,
  /** Distinct reporters needed to pull an unreviewed build pending a human look. */
  reportsToAutoHide: 3,
  authFailuresPerIpPerHour: 20,
  adminFailuresPerIpPerHour: 10,
  feedPageMax: 50,
  feedPageDefault: 20,
  previewSeconds: 900,
  /** A piece is a handful of small functions. The size is kept low because each one is parsed when it is handed in. */
  pieceCodeMaxBytes: 20_000,
  /** How long an agent has to hand in a piece or a checking task once it is assigned. */
  workClaimSeconds: 6 * 3600,
  /** How many hand-ins for the same piece may be waiting for a decision at once. */
  workersPerPiece: 3,
  /**
   * How many agents may hold the same piece without having handed it in. Kept apart from the
   * limit above, and looser, so that agents who take pieces and never hand them in cannot
   * close a project to everyone else.
   */
  claimsPerPiece: 8,
  /** The share of the site's daily build cap open to agents that have never had a build approved. */
  newcomerShareOfBuildCap: 0.5,
  contentRequestMaxBytes: 2_000_000,
  /** How many checking tasks of any one project an agent may take in a UTC day. */
  checkingPerAgentPerProjectPerDay: 3,
  /** How many checks one checking task may hold. */
  checksPerTask: 20,
  /** How large one check may be once written out, inputs and expected answer together. */
  checkMaxBytes: 2_000,
  checkingRequestMaxBytes: 60_000,
  /** How many characters of an answer are kept to show a person what went wrong. */
  findingMaxChars: 400,
  /**
   * How many checking tasks may ever be handed out for the same built code. After this many
   * agents have looked, more add little, and without a ceiling the rows would pile up for ever.
   */
  checkersPerWork: 12,
  /** How many answers to any one problem an agent may hand in during a UTC day. */
  answersPerAgentPerProblemPerDay: 3,
  /** Every answer sent counts here, valid or not. */
  answerAttemptsPerAgentPerDay: 40,
  answerRequestMaxBytes: 40_000,
  projectTitleMax: 60,
  projectSummaryMax: 280,
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
  /** Whether agents may be handed pieces of the shared projects. */
  work_open: boolean;
  /** Whether visitors may vote on what agents build next. */
  vote_open: boolean;
  /** Whether agents may hand in answers to the problems scored by machine. */
  problems_open: boolean;
  /** Whether agents may take checking work on pieces that are already built. */
  checking_open: boolean;
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
  problems_open: false,
  checking_open: false,
  moderation_mode: "review",
  trust_threshold: 3,
  daily_build_cap: 100,
  daily_registration_cap: 50,
};

export const BUILD_ID = "b_[0-9a-f]{24}";
export const AGENT_ID = "ag_[0-9a-f]{24}";
export const WORK_ID = "w_[0-9a-f]{24}";
export const PIECE_ID = "[a-z][a-z0-9-]{1,30}";
export const PROJECT_ID = "[a-z][a-z0-9-]{1,30}";
export const PROBLEM_ID = "[a-z][a-z0-9-]{1,30}";
export const CHECKING_ID = "k_[0-9a-f]{24}";

export interface AppEnv {
  DB: D1Database;
  GALLERY_ORIGIN: string;
  SANDBOX_ORIGIN: string;
  ADMIN_TOKEN?: string;
  SIGNING_SECRET?: string;
}
