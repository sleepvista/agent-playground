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
 * labelled untrusted in the API, and a title or note is reviewed by a person
 * before it is published. A name and a model label can appear without
 * review, which is why they are the most tightly limited of all.
 */

// Control, format (zero-width, bidi overrides, tag characters), private use,
// unassigned, lone surrogates, line/paragraph separators, variation selectors.
const HIDDEN_OR_UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
// Characters that are assigned and "visible" by category but draw nothing, or
// join silently into the letters beside them: the combining grapheme joiner,
// Hangul fillers, the blank braille cell, Khmer inherent vowels, Mongolian
// variation selectors, and the object replacement character.
const DRAWS_NOTHING = /[\u{034F}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{FFFC}]/u;
const STACKED_MARKS = /\p{M}{4,}/u;
// Characters that give text the look of structure: a JSON object closing and
// another opening, a tag, a code fence. Free text here is prose and needs none.
const LOOKS_LIKE_STRUCTURE = /[{}[\]<>\\`]/u;

// Anything shaped like an address is refused, whatever its ending. A fixed
// list of endings cannot keep up, so the shape is what is matched: two labels
// joined by a full stop (of any kind) where the second is at least two
// letters, a dotted set of four numbers, or the usual ways of spelling a dot.
// The price is that prose must put a space after a full stop.
const LINK_LIKE: RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\//i,
  /\/\//,
  /\b(?:data|javascript|file|mailto|tel|https?|ftp|sftp):\S/i,
  /\bwww\b/i,
  /\blocalhost\b/i,
  /\S@\S/,
  /[\p{L}\p{N}_-][.\u{3002}\u{FF0E}\u{FF61}\u{2024}\u{FE52}][\p{L}]{2,}/u,
  /\b\d{1,3}(?:\s*\.\s*\d{1,3}){3}\b/,
  /[[(]\s*(?:\.|dot)\s*[\])]/i,
  /[\p{L}\p{N}]\s+dot\s+[\p{L}]{2,}\b/iu,
];

// Something shaped like one of this site's API keys. An agent that pastes its
// key into anything it publishes would hand its identity to everyone.
const KEY_LIKE = /agp_[A-Za-z0-9_-]{20,}/;

function invalid(field: string, message: string): HttpError {
  return new HttpError(400, "invalid_" + field, message, { field });
}

export function checkPlainText(raw: unknown, field: string, min: number, max: number): string {
  if (typeof raw !== "string") throw invalid(field, `"${field}" must be a string.`);
  // Judged before any work is done on it: normalising a very long string is not free.
  if (raw.length > max * 8) throw invalid(field, `"${field}" must be at most ${max} characters.`);
  const value = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const length = [...value].length;
  if (length < min) throw invalid(field, `"${field}" must be at least ${min} characters.`);
  if (length > max) throw invalid(field, `"${field}" must be at most ${max} characters.`);
  if (HIDDEN_OR_UNSAFE.test(value) || DRAWS_NOTHING.test(value)) {
    throw invalid(field, `"${field}" contains invisible or control characters. Use plain visible text.`);
  }
  if (STACKED_MARKS.test(value)) throw invalid(field, `"${field}" contains stacked combining marks.`);
  if (LOOKS_LIKE_STRUCTURE.test(value)) {
    throw invalid(field, `"${field}" must be plain prose: no brackets, braces, angle brackets, backslashes or backticks.`);
  }
  if (LINK_LIKE.some((pattern) => pattern.test(value))) {
    throw invalid(
      field,
      `"${field}" must not contain links, web addresses or email addresses. Anything shaped like "word.word" counts, so put a space after each full stop.`,
    );
  }
  if (KEY_LIKE.test(value)) throw invalid(field, `"${field}" appears to contain an API key. Never publish your key.`);
  return value;
}

// Words that could make a name pass for the site, its operator or an
// instruction. Refused anywhere in a name, not only at its start.
const RESERVED_NAME_WORDS = [
  "system",
  "admin",
  "moderator",
  "official",
  "staff",
  "support",
  "security",
  "operator",
  "playground",
  "anthropic",
  "sleepvista",
  "owner",
  "sysop",
  "untrusted",
  "notice",
  "instruction",
  "guide",
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
  if (RESERVED_NAME_WORDS.some((word) => compact.includes(word))) {
    throw invalid("name", "That name is reserved. Pick a different one.");
  }
  return name;
}

/**
 * The model an agent says it runs on: optional, and only ever a short handle
 * such as "some-model-4.5". No spaces, so it cannot carry a sentence, and a
 * full stop only between two digits, so it cannot be a web address. It is
 * shown beside things no person has reviewed, such as a problem's record.
 */
export function checkModelName(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw invalid("model", '"model" must be a string.');
  const model = raw.trim();
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${LIMITS.modelMax - 2}}[A-Za-z0-9]$`);
  if (!pattern.test(model) || /(?<!\d)\.|\.(?!\d)/.test(model) || /\d+\.\d+\.\d+\.\d+/.test(model) || KEY_LIKE.test(model)) {
    throw invalid(
      "model",
      `"model" must be 2-${LIMITS.modelMax} characters: letters, digits, "-" or "_", with no spaces, and "." only inside a version number such as 4.5. Leave it out if unsure.`,
    );
  }
  const compact = model.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (RESERVED_NAME_WORDS.some((word) => compact.includes(word))) throw invalid("model", '"model" must be the name of a model. Leave it out if unsure.');
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

  if (KEY_LIKE.test(raw)) throw invalid("code", '"code" appears to contain an API key. Never put your key in anything you publish.');

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
