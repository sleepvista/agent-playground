import { LIMITS } from "./config";
import { HttpError } from "./http";

/**
 * Everything an agent writes here is later read by other agents and by people.
 * These checks keep that text short, visible and link-free, which removes the
 * usual carriers for instructions smuggled to other agents: invisible
 * characters, lookalike formatting, and "go fetch this URL".
 *
 * They do not try to detect manipulative wording. No filter can do that
 * reliably, so the design never depends on it: free text is tiny, is always
 * labelled untrusted in the API, and is reviewed before it is published.
 */

// Control, format (zero-width, bidi overrides, tag characters), private use,
// unassigned, lone surrogates, line/paragraph separators, variation selectors.
const HIDDEN_OR_UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
const STACKED_MARKS = /\p{M}{4,}/u;

const LINK_LIKE: RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\b(?:data|javascript|file|mailto|tel):\S/i,
  /\bwww\./i,
  /\S@\S+\.\S/,
  /\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|app|xyz|co|me|sh|gg|ly|to|info|biz|ru|cn|tk|top|site|online|link|click|page|zip|mov|cc|tv|us|uk|ca)\b/i,
];

function invalid(field: string, message: string): HttpError {
  return new HttpError(400, "invalid_" + field, message, { field });
}

export function checkPlainText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw invalid(field, `"${field}" must be a string.`);
  const value = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...value].length;
  if (length < min) throw invalid(field, `"${field}" must be at least ${min} characters.`);
  if (length > max) throw invalid(field, `"${field}" must be at most ${max} characters.`);
  if (HIDDEN_OR_UNSAFE.test(value)) {
    throw invalid(field, `"${field}" contains invisible or control characters. Use plain visible text.`);
  }
  if (STACKED_MARKS.test(value)) throw invalid(field, `"${field}" contains stacked combining marks.`);
  if (LINK_LIKE.some((pattern) => pattern.test(value))) {
    throw invalid(field, `"${field}" must not contain links, web addresses or email addresses.`);
  }
  return value;
}

// Names that could pass for the site itself speaking.
const RESERVED_NAME_PREFIXES = [
  "system",
  "admin",
  "moderator",
  "official",
  "staff",
  "support",
  "security",
  "operator",
  "playground",
];

export function checkAgentName(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("name", '"name" must be a string.');
  const name = raw.trim();
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{${LIMITS.nameMin - 2},${LIMITS.nameMax - 2}}[A-Za-z0-9]$`);
  if (!pattern.test(name)) {
    throw invalid(
      "name",
      `"name" must be ${LIMITS.nameMin}-${LIMITS.nameMax} characters: letters, digits, "-" or "_", starting and ending with a letter or digit.`,
    );
  }
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (RESERVED_NAME_PREFIXES.some((word) => compact.startsWith(word))) {
    throw invalid("name", "That name is reserved. Pick a different one.");
  }
  return name;
}

/**
 * The model an agent says it runs on: optional, and only ever a short handle
 * such as "some-model-4.5". No spaces, so it cannot carry a sentence.
 */
export function checkModelName(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw invalid("model", '"model" must be a string.');
  const model = raw.trim();
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${LIMITS.modelMax - 2}}[A-Za-z0-9]$`);
  if (!pattern.test(model)) {
    throw invalid(
      "model",
      `"model" must be 2-${LIMITS.modelMax} characters: letters, digits, ".", "-" or "_", with no spaces. Leave it out if unsure.`,
    );
  }
  return model;
}

export interface CheckedCode {
  code: string;
  bytes: number;
  warnings: string[];
}

/**
 * Structural checks only. What a build may do is enforced by where it runs
 * (a worker with a canvas and no network), not by scanning its source.
 */
export function checkBuildCode(raw: unknown): CheckedCode {
  if (typeof raw !== "string") throw invalid("code", '"code" must be a string of JavaScript.');
  if (!raw.isWellFormed() || raw.includes("\u0000")) {
    throw invalid("code", '"code" contains invalid characters.');
  }
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes < LIMITS.codeMinBytes) throw invalid("code", '"code" is too short to be a build.');
  if (bytes > LIMITS.codeMaxBytes) {
    throw new HttpError(413, "code_too_large", `"code" is ${bytes} bytes; the limit is ${LIMITS.codeMaxBytes}.`, {
      field: "code",
    });
  }

  const warnings: string[] = [];
  if (/^\s*<(?:!doctype|html|script|canvas)\b/i.test(raw)) {
    warnings.push("This looks like HTML. A build is plain JavaScript that draws on the provided canvas; HTML will not run.");
  }
  if (/\b(?:document|window|localStorage|sessionStorage|alert)\s*[.(\[]/.test(raw)) {
    warnings.push("The build runs in a worker: there is no document, window, storage or dialogs. Draw on the provided canvas.");
  }
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|importScripts)\b/.test(raw)) {
    warnings.push("The build appears to make network calls. They are blocked.");
  }
  if (/\b(?:eval|Function)\s*\(|\bWebAssembly\b|\bnew\s+(?:Shared)?Worker\b/.test(raw)) {
    warnings.push("eval, new Function, WebAssembly and nested workers are blocked.");
  }
  if (!/\bgetContext\s*\(/.test(raw)) {
    warnings.push('The build never calls canvas.getContext(...), so it will probably draw nothing.');
  }
  return { code: raw, bytes, warnings };
}
