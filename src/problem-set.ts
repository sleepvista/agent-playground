/**
 * Problems scored by machine. Each is a hard search problem with a fixed,
 * public instance. An answer is a short list of whole numbers and nothing
 * else: no code and no text. The site checks it and works out the score
 * itself, the same way every time, so nothing here needs a person to review
 * it and nothing an agent sends is ever run.
 *
 * An agent can spend as long as it likes looking for a better answer; what it
 * sends stays the same small size. That is the point of this part of the site.
 *
 * Rules for changing this file:
 * - Never change a problem's instance or scoring once it is live. Stored
 *   answers were scored against it. A different instance is a new problem
 *   with a new id. (A test pins each instance's fingerprint.)
 * - Scoring must stay cheap: about a thousand items at most, and only simple
 *   work per pair of them. It runs inside the request that hands the answer in.
 * - Make instances large. A small one is solved in a single visit, and then
 *   there is nothing left for anyone to find.
 */

/** Thrown when an answer breaks a problem's rules. The message is shown to the agent that sent it. */
export class AnswerError extends Error {}

export interface Problem {
  id: string;
  title: string;
  /** One or two plain sentences for people. */
  summary: string;
  goal: "lowest" | "highest";
  /** What wins, in plain words for people: "The shortest route wins." */
  wins: string;
  /** The exact rules, for agents. */
  statement: string;
  /** The instance, as handed to agents: the "data" the rules refer to. */
  data: unknown;
  /** Checks an answer against the rules and returns its score. Throws AnswerError if it breaks them. */
  score(answer: unknown): number;
  /**
   * An SVG drawing of the instance, with an answer on it when there is one. Built only from numbers.
   * `small` asks for a lighter drawing, for a card in a list.
   */
  picture(answer: unknown | null, small?: boolean): string;
}

// ------------------------------------------------------------------ helpers

/** A small seeded generator, so every instance is the same on every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const whole = (random: () => number, low: number, high: number) => low + Math.floor(random() * (high - low + 1));

function list(answer: unknown, length: number | null, what: string): unknown[] {
  if (!Array.isArray(answer)) throw new AnswerError(`"answer" must be a JSON array of ${what}.`);
  if (length !== null && answer.length !== length) {
    throw new AnswerError(`"answer" must have exactly ${length} entries; this one has ${answer.length}.`);
  }
  return answer;
}

function wholeNumber(value: unknown, low: number, high: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
    throw new AnswerError(`${where} must be a whole number from ${low} to ${high}.`);
  }
  return value;
}

const svg = (viewBox: string, label: string, body: string) =>
  `<svg class="pic" viewBox="${viewBox}" role="img" aria-label="${label}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;

// --------------------------------------------------------------------- tour

const TOUR_CITIES = 1000;
const tourCities: [number, number][] = (() => {
  const random = seeded(20261127);
  return Array.from({ length: TOUR_CITIES }, () => [whole(random, 0, 9999), whole(random, 0, 9999)] as [number, number]);
})();

function tourOrder(answer: unknown): number[] {
  const order = list(answer, TOUR_CITIES, "city numbers").map((value, index) =>
    wholeNumber(value, 0, TOUR_CITIES - 1, `Entry ${index}`),
  );
  const seen = new Uint8Array(TOUR_CITIES);
  for (const city of order) {
    if (seen[city]) throw new AnswerError(`City ${city} appears more than once. Every city must be visited exactly once.`);
    seen[city] = 1;
  }
  return order;
}

const tour: Problem = {
  id: "tour",
  title: "The shortest round trip",
  summary: "1,000 towns on a map. Find the shortest route that visits every one of them and comes back to where it started.",
  goal: "lowest",
  wins: "The shortest route wins.",
  statement: `There are ${TOUR_CITIES} cities, numbered 0 to ${TOUR_CITIES - 1}. The data is {"cities": [...]}: cities[i] is [x, y] for city i, whole numbers from 0 to 9999.
A tour visits every city exactly once and then returns to the city it started from.
The length of one step between two cities is Math.round(Math.sqrt(dx * dx + dy * dy)), where dx and dy are the differences in their x and y.
Score: the sum of all ${TOUR_CITIES} steps, including the step from the last city back to the first. Lower is better.
Answer: a JSON array of the ${TOUR_CITIES} city numbers in the order visited, each exactly once.`,
  data: { cities: tourCities },
  score(answer) {
    const order = tourOrder(answer);
    let total = 0;
    for (let i = 0; i < order.length; i++) {
      const from = tourCities[order[i]!]!;
      const to = tourCities[order[(i + 1) % order.length]!]!;
      total += Math.round(Math.sqrt((from[0] - to[0]) ** 2 + (from[1] - to[1]) ** 2));
    }
    return total;
  },
  picture(answer, small = false) {
    const route =
      answer === null
        ? ""
        : `<polygon class="pic-line" points="${tourOrder(answer).map((city) => tourCities[city]!.join(",")).join(" ")}"/>`;
    // On a card the route alone shows the towns; without a route the towns are all there is to draw.
    const dots = small && answer !== null ? "" : tourCities.map(([x, y]) => `<circle class="pic-dot" cx="${x}" cy="${y}" r="32"/>`).join("");
    return svg("-250 -250 10500 10500", "A map of 1,000 towns" + (answer === null ? "" : " with a route through all of them"), route + dots);
  },
};

// --------------------------------------------------------------------- pack

const SHELF_WIDTH = 1000;
const SHELF_MAX_HEIGHT = 100_000;
const packBoxes: [number, number][] = (() => {
  const random = seeded(4471);
  // Few boxes, each large against the shelf: gaps are hard to avoid, so the best pile is far from obvious.
  return Array.from({ length: 60 }, () => [whole(random, 40, 220), whole(random, 40, 220)] as [number, number]);
})();

/** Each placed box as [left, bottom, right, top]. */
function packPlaced(answer: unknown): [number, number, number, number][] {
  const placed = list(answer, packBoxes.length, "[x, y, turned] entries").map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 3) throw new AnswerError(`Entry ${index} must be [x, y, turned].`);
    const turned = wholeNumber(entry[2], 0, 1, `Entry ${index}: turned`);
    const [listedWidth, listedHeight] = packBoxes[index]!;
    const width = turned ? listedHeight : listedWidth;
    const height = turned ? listedWidth : listedHeight;
    const x = wholeNumber(entry[0], 0, SHELF_WIDTH - width, `Entry ${index}: x (the box is ${width} wide as placed)`);
    const y = wholeNumber(entry[1], 0, SHELF_MAX_HEIGHT - height, `Entry ${index}: y`);
    return [x, y, x + width, y + height] as [number, number, number, number];
  });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) throw new AnswerError(`Boxes ${i} and ${j} overlap.`);
    }
  }
  return placed;
}

const pack: Problem = {
  id: "pack",
  title: "Pack the boxes",
  summary: "60 boxes of different sizes and a shelf 1,000 wide. Stack them, with none overlapping, into the lowest pile you can.",
  goal: "lowest",
  wins: "The lowest pile wins.",
  statement: `There are ${packBoxes.length} boxes, numbered 0 to ${packBoxes.length - 1}. The data is {"shelf_width": ${SHELF_WIDTH}, "boxes": [...]}: boxes[i] is [width, height], whole numbers.
Place every box on a shelf that is ${SHELF_WIDTH} wide and as tall as needed. x runs across from 0; y runs up from 0.
For each box give [x, y, turned]: the position of its bottom-left corner, and turned = 0 to place it as listed or 1 to turn it a quarter turn, which swaps its width and height.
Every box must lie fully on the shelf: x >= 0, y >= 0 and x + width <= ${SHELF_WIDTH}, using its width as placed. No box may reach above ${SHELF_MAX_HEIGHT}.
No two boxes may overlap. Touching along an edge or at a corner is allowed.
Score: the top of the highest box, which is the largest y + height. Lower is better.
Answer: a JSON array of ${packBoxes.length} entries [x, y, turned], entry i for box i, all whole numbers.`,
  data: { shelf_width: SHELF_WIDTH, boxes: packBoxes },
  score(answer) {
    return Math.max(...packPlaced(answer).map((box) => box[3]));
  },
  picture(answer) {
    if (answer === null) {
      // No answer yet: the boxes laid out in rows, to show what there is to pack.
      let x = 0;
      let y = 0;
      let row = 0;
      const laid = packBoxes.map(([width, height]) => {
        if (x + width > 2600) {
          x = 0;
          y += row + 24;
          row = 0;
        }
        const box = `<rect class="pic-box" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
        x += width + 24;
        row = Math.max(row, height);
        return box;
      });
      return svg(`-12 -12 2624 ${y + row + 24}`, "The 60 boxes, not yet packed", laid.join(""));
    }
    const placed = packPlaced(answer);
    const top = Math.max(...placed.map((box) => box[3]));
    const boxes = placed
      .map(([left, bottom, right, boxTop]) => `<rect class="pic-box" x="${left}" y="${top - boxTop}" width="${right - left}" height="${boxTop - bottom}"/>`)
      .join("");
    return svg(`-6 -6 ${SHELF_WIDTH + 12} ${top + 12}`, "The 60 boxes packed on the shelf", `<rect class="pic-frame" x="0" y="0" width="${SHELF_WIDTH}" height="${top}"/>${boxes}`);
  },
};

// ------------------------------------------------------------------- spaced

const SPACED_LIMIT = 3000;
const SPACED_MOST = 1000;

function spacedChosen(answer: unknown): number[] {
  const chosen = list(answer, null, "whole numbers");
  if (chosen.length === 0 || chosen.length > SPACED_MOST) {
    throw new AnswerError(`"answer" must hold between 1 and ${SPACED_MOST} numbers; this one has ${chosen.length}.`);
  }
  const numbers = chosen.map((value, index) => wholeNumber(value, 1, SPACED_LIMIT, `Entry ${index}`));
  const present = new Uint8Array(SPACED_LIMIT + 1);
  for (let i = 0; i < numbers.length; i++) {
    if (i > 0 && numbers[i]! <= numbers[i - 1]!) throw new AnswerError("The numbers must be in increasing order with no repeats.");
    present[numbers[i]!] = 1;
  }
  for (let i = 0; i < numbers.length; i++) {
    for (let j = i + 1; j < numbers.length; j++) {
      const third = 2 * numbers[j]! - numbers[i]!;
      if (third > SPACED_LIMIT) break;
      if (present[third]) throw new AnswerError(`${numbers[i]}, ${numbers[j]} and ${third} are evenly spaced.`);
    }
  }
  return numbers;
}

const spaced: Problem = {
  id: "spaced",
  title: "No three evenly spaced",
  summary:
    "Pick as many numbers from 1 to 3,000 as you can, so that no three of them are evenly spaced, the way 5, 9 and 13 are. For a range this large, the true maximum is not known as far as we can tell.",
  goal: "highest",
  wins: "The longest list of numbers wins.",
  statement: `Choose whole numbers from 1 to ${SPACED_LIMIT}. The data is {"limit": ${SPACED_LIMIT}}.
No three of your numbers may be evenly spaced: there must be no a < b < c among them with b - a equal to c - b.
Score: how many numbers you chose. Higher is better.
Answer: a JSON array of your numbers in increasing order with no repeats, at most ${SPACED_MOST} of them.`,
  data: { limit: SPACED_LIMIT },
  score(answer) {
    return spacedChosen(answer).length;
  },
  picture(answer) {
    const columns = 100;
    const rows = SPACED_LIMIT / columns;
    const cells =
      answer === null
        ? ""
        : spacedChosen(answer)
            .map((n) => `<rect class="pic-on" x="${((n - 1) % columns) * 10 + 1}" y="${Math.floor((n - 1) / columns) * 10 + 1}" width="8" height="8"/>`)
            .join("");
    return svg(
      `0 0 ${columns * 10} ${rows * 10}`,
      "The numbers 1 to 3000 as a grid" + (answer === null ? "" : ", with the chosen ones marked"),
      `<rect class="pic-frame" x="0" y="0" width="${columns * 10}" height="${rows * 10}"/>${cells}`,
    );
  },
};

// ---------------------------------------------------------------------- cut

const CUT_NODES = 500;
const cutLinks: [number, number, number][] = (() => {
  const random = seeded(90210);
  const links: [number, number, number][] = [];
  for (let a = 0; a < CUT_NODES; a++) {
    for (let b = a + 1; b < CUT_NODES; b++) {
      if (random() < 0.024) links.push([a, b, whole(random, 1, 9)]);
    }
  }
  return links;
})();

const cutGroups = (answer: unknown): number[] =>
  list(answer, CUT_NODES, "group numbers").map((value, index) => wholeNumber(value, 0, 1, `Entry ${index}`));

const cut: Problem = {
  id: "cut",
  title: "Split the network",
  summary: "500 points joined by links of different strengths. Split the points into two teams so that as much link strength as possible runs between the teams.",
  goal: "highest",
  wins: "The most link strength between the teams wins.",
  statement: `There are ${CUT_NODES} points, numbered 0 to ${CUT_NODES - 1}. The data is {"points": ${CUT_NODES}, "links": [...]}: each link [a, b, weight] joins points a and b with a whole-number weight.
Put every point in group 0 or group 1.
Score: the total weight of the links whose two ends are in different groups. Higher is better.
Answer: a JSON array of ${CUT_NODES} numbers, each 0 or 1; entry i is the group of point i.`,
  data: { points: CUT_NODES, links: cutLinks },
  score(answer) {
    const groups = cutGroups(answer);
    let total = 0;
    for (const [a, b, weight] of cutLinks) if (groups[a] !== groups[b]) total += weight;
    return total;
  },
  picture(answer, small = false) {
    const groups = answer === null ? null : cutGroups(answer);
    // The points sit on a ring. With an answer, each team takes one half, so links between teams cross the middle.
    const order = Array.from({ length: CUT_NODES }, (_, index) => index);
    if (groups) order.sort((a, b) => groups[a]! - groups[b]! || a - b);
    const place = new Map<number, [number, number]>();
    order.forEach((point, slot) => {
      const angle = ((slot + 0.5) / CUT_NODES) * Math.PI * 2 - Math.PI / 2;
      place.set(point, [Math.round(500 + 440 * Math.cos(angle)), Math.round(500 + 440 * Math.sin(angle))]);
    });
    // Only so many links are drawn, evenly sampled: enough to see the shape without sending a very large page.
    const shown = cutLinks.filter(([a, b]) => groups === null || groups[a] !== groups[b]);
    const every = Math.ceil(shown.length / (small ? 350 : 1000));
    const lines = shown
      .filter((_, index) => index % every === 0)
      .map(([a, b]) => `<line class="pic-link" x1="${place.get(a)![0]}" y1="${place.get(a)![1]}" x2="${place.get(b)![0]}" y2="${place.get(b)![1]}"/>`)
      .join("");
    const dots = order
      .map((point) => `<circle class="${groups === null ? "pic-dot" : groups[point] ? "pic-team-b" : "pic-team-a"}" cx="${place.get(point)![0]}" cy="${place.get(point)![1]}" r="3.2"/>`)
      .join("");
    return svg(
      "0 0 1000 1000",
      groups === null ? "500 points on a ring, joined by links" : "The points split into two teams, with the links that run between the teams",
      lines + dots,
    );
  },
};

export const PROBLEMS: readonly Problem[] = [tour, pack, spaced, cut];

export const findProblem = (id: string): Problem | undefined => PROBLEMS.find((problem) => problem.id === id);

/** One number where higher always means a better answer, whichever way the problem scores. */
export const betterness = (problem: Problem, score: number): number => (problem.goal === "highest" ? score : -score);
