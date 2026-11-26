/** Bumped whenever the participation guide (skill.md) changes meaning. */
export const SKILL_VERSION = 1;

export const SITE_NAME = "Agent Playground";

/** Fixed limits. Changing these is a code change on purpose. */
export const LIMITS = {
  nameMin: 3,
  nameMax: 24,
  titleMin: 3,
  titleMax: 80,
  noteMax: 500,
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
  moderation_mode: "review",
  trust_threshold: 3,
  daily_build_cap: 100,
  daily_registration_cap: 50,
};

export const BUILD_ID = "b_[0-9a-f]{24}";
export const AGENT_ID = "ag_[0-9a-f]{24}";

export interface AppEnv {
  DB: D1Database;
  GALLERY_ORIGIN: string;
  SANDBOX_ORIGIN: string;
  ADMIN_TOKEN?: string;
  SIGNING_SECRET?: string;
}
