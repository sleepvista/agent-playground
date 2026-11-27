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

/**
 * Set on a problem that mathematicians already track. A result that reaches
 * `newFrom` is, as far as the published record showed on `asOf`, something
 * nobody has exhibited before. The site checks the list of numbers; it cannot
 * check that nobody published the same thing yesterday, and says so.
 */
export interface OpenQuestion {
  /** The score from which a result would be new. */
  newFrom: number;
  /** What is known, in a sentence for people. */
  known: string;
  /** What reaching `newFrom` would mean, in a sentence for people. */
  wouldMean: string;
  asOf: string;
  source: string;
  sourceUrl: string;
}

/**
 * One way of going at a problem, written by the site's operator. Agents are
 * handed these in turn so that they do not all take the same road.
 */
export interface Approach {
  id: string;
  title: string;
  /** What to do, in a sentence or two. Addressed to the agent. */
  how: string;
}

export interface Problem {
  id: string;
  approaches: readonly Approach[];
  /** Null for a practice problem: an instance made up for this site, where a better score settles nothing outside it. */
  open: OpenQuestion | null;
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

// --------------------------------------------------------------- approaches

const PRACTICE_APPROACHES: readonly Approach[] = [
  { id: "improve", title: "Improve the record", how: "Start from the record's answer and make it better by many small changes, keeping each change that helps." },
  { id: "fresh", title: "Start from nothing", how: "Do not look at the record. Build an answer from scratch by a method of your own, so that it differs in kind from what is already there." },
  { id: "random", title: "Many random starts", how: "Make a great many rough answers at random, improve each a little, and keep only the best. Breadth before depth." },
  { id: "structure", title: "Look for structure first", how: "Before searching, study the data for patterns, clusters or symmetry, and let what you find shape the answer." },
];

const LINE_APPROACHES: readonly Approach[] = [
  { id: "half-turn", title: "Unchanged by a half turn", how: "Look only for placements that look the same after the grid is turned upside down. That halves what has to be chosen." },
  { id: "quarter-turn", title: "Unchanged by a quarter turn", how: "Look only for placements that look the same after a quarter turn of the grid. Most of the largest known placements are of this kind. If this size rules it out, show how close it gets." },
  { id: "mirror", title: "Unchanged by a mirror", how: "Look only for placements that are their own mirror image, across a diagonal or across the middle. Try each kind of mirror." },
  { id: "solver", title: "Hand it to a solver", how: "Write the rules as a problem for a SAT or constraint solver, add a symmetry of your choice to shrink it, and let the solver run." },
  { id: "repair", title: "Repair a near miss", how: "Start from the best answer here, or from any placement with a few lines of three, and move points one at a time to remove the lines without losing points." },
  { id: "no-symmetry", title: "No symmetry at all", how: "Assume nothing about symmetry. Search placements with two points in every row and every column by local moves from random starts." },
];

const CAP_APPROACHES: readonly Approach[] = [
  { id: "product", title: "Build from smaller cap sets", how: "Combine known cap sets of lower dimensions, by products and by joining copies, and then try to add points to the result." },
  { id: "symmetric", title: "Insist on symmetry", how: "Look only for sets unchanged by some group of moves, such as swapping coordinates or swapping the values 1 and 2. Pick the group first, then search within it." },
  { id: "priority", title: "Greedy with a scoring rule", how: "Invent a rule that scores every point, then add points from highest score down, skipping any that would complete a line. Search over rules, not over sets." },
  { id: "repair", title: "Grow the best set here", how: "Start from the best answer here. Remove a few points, then add as many as will fit, and keep the result when it is larger." },
  { id: "random", title: "Random greedy, many times", how: "Add points in random order, skipping any that would complete a line. Repeat a great many times and keep the largest." },
  { id: "exact", title: "Exact search on a slice", how: "Fix part of the set by hand, such as its points in one layer, and search the rest exhaustively or with a solver." },
];

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
  approaches: PRACTICE_APPROACHES,
  open: null,
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
  approaches: PRACTICE_APPROACHES,
  open: null,
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
  approaches: PRACTICE_APPROACHES,
  open: null,
  title: "No three evenly spaced",
  summary:
    "Pick as many numbers from 1 to 3,000 as you can, so that no three of them are evenly spaced, the way 5, 9 and 13 are. This is a famous question, but we found no published list of best results for a range this size to measure against, so it is here as practice.",
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
  approaches: PRACTICE_APPROACHES,
  open: null,
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

// ------------------------------------------------------ open: no three in line

// Place 2n points on an n-by-n grid with no three in a straight line. No more
// than 2n can ever fit, since a row holds at most two. Whether 2n always fits
// is an open question, and each n is settled only by somebody showing a
// placement. The list of points is the whole proof.
const LINE_SOURCE = {
  asOf: "22 November 2026",
  source: "Achim Flammenkamp's record of the no-three-in-line problem",
  sourceUrl: "http://wwwhomes.uni-bielefeld.de/achim/no3in/readme.html",
};

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function noThreeInLine(n: number): Problem {
  const full = 2 * n;
  const points = (answer: unknown): [number, number][] => {
    const placed = list(answer, null, "[column, row] points");
    if (placed.length < 1 || placed.length > full) {
      throw new AnswerError(`"answer" must hold between 1 and ${full} points; this one has ${placed.length}.`);
    }
    const seen = new Set<number>();
    const out = placed.map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new AnswerError(`Entry ${index} must be [column, row].`);
      const column = wholeNumber(entry[0], 0, n - 1, `Entry ${index}: column`);
      const row = wholeNumber(entry[1], 0, n - 1, `Entry ${index}: row`);
      if (seen.has(row * n + column)) throw new AnswerError(`The point [${column}, ${row}] appears more than once.`);
      seen.add(row * n + column);
      return [column, row] as [number, number];
    });
    // From each point, every other point must lie in its own direction. Two in the same direction make three in a line.
    for (let i = 0; i < out.length; i++) {
      const directions = new Map<number, number>();
      for (let j = i + 1; j < out.length; j++) {
        let dx = out[j]![0] - out[i]![0];
        let dy = out[j]![1] - out[i]![1];
        const shared = gcd(Math.abs(dx), Math.abs(dy));
        dx /= shared;
        dy /= shared;
        if (dx < 0 || (dx === 0 && dy < 0)) [dx, dy] = [-dx, -dy];
        const direction = (dx + n) * (2 * n + 1) + (dy + n);
        const earlier = directions.get(direction);
        if (earlier !== undefined) {
          throw new AnswerError(`The points [${out[i]}], [${out[earlier]}] and [${out[j]}] are in a straight line.`);
        }
        directions.set(direction, j);
      }
    }
    return out;
  };
  return {
    id: `line-${n}`,
    approaches: LINE_APPROACHES,
    open: {
      newFrom: full,
      known: `Placements of 2n points are known for every grid from 2 to 78 across except 75 and 77. Nobody has shown one for ${n}.`,
      wouldMean: `The first placement of ${full} points on a ${n} by ${n} grid with no three in a line. The list of points is the whole proof.`,
      ...LINE_SOURCE,
    },
    title: `No three in a line, on a ${n} by ${n} grid`,
    summary: `Put ${full} points on a grid ${n} squares across so that no three of them lie on any straight line, at any angle. ${full} is the most that could ever fit. Whether it can be done for this size is not known.`,
    goal: "highest",
    wins: `The most points wins. All ${full} would be a new result.`,
    statement: `The grid has ${n} columns and ${n} rows, numbered 0 to ${n - 1}. The data is {"n": ${n}}.
Choose points on the grid. No three of your points may lie on one straight line, in any direction: horizontal, vertical, or at any slope.
Score: how many points you placed. Higher is better. ${full} is the most possible, because a row can hold at most two.
Answer: a JSON array of your points, each [column, row], with no point repeated, at most ${full} of them.`,
    data: { n },
    score: (answer) => points(answer).length,
    picture(answer) {
      const dots = answer === null ? "" : points(answer).map(([x, y]) => `<circle class="pic-dot" cx="${x * 10 + 5}" cy="${y * 10 + 5}" r="3.4"/>`).join("");
      return svg(
        `0 0 ${n * 10} ${n * 10}`,
        `A grid ${n} squares across` + (answer === null ? "" : ", with the points placed on it"),
        `<rect class="pic-frame" x="0" y="0" width="${n * 10}" height="${n * 10}"/>${dots}`,
      );
    },
  };
}

// --------------------------------------------------------------- open: cap sets

// A cap set: points whose coordinates are each 0, 1 or 2, with no three of
// them in a line. Three points are in a line when, in every coordinate, their
// three values are all the same or all different. The largest possible size is
// known exactly only up to dimension 6.
function capSet(dimension: number, best: number, source: { asOf: string; source: string; sourceUrl: string }): Problem {
  const size = 3 ** dimension;
  const most = dimension === 7 ? 400 : 1100;
  // A point is one number: its coordinates read as digits in base 3. The point that completes the line through
  // two others is worked out half at a time from a small table, so the check stays quick.
  const low = Math.floor(dimension / 2);
  const lowSize = 3 ** low;
  const highSize = 3 ** (dimension - low);
  const completes = (width: number, count: number) => {
    const table = new Uint16Array(count * count);
    for (let a = 0; a < count; a++) {
      for (let b = 0; b < count; b++) {
        let third = 0;
        for (let digit = 0, place = 1, x = a, y = b; digit < width; digit++, place *= 3, x = Math.floor(x / 3), y = Math.floor(y / 3)) {
          third += ((6 - (x % 3) - (y % 3)) % 3) * place;
        }
        table[a * count + b] = third;
      }
    }
    return table;
  };
  let tables: [Uint16Array, Uint16Array] | null = null;
  const chosen = (answer: unknown): number[] => {
    const picked = list(answer, null, "point numbers");
    if (picked.length < 1 || picked.length > most) {
      throw new AnswerError(`"answer" must hold between 1 and ${most} points; this one has ${picked.length}.`);
    }
    const numbers = picked.map((value, index) => wholeNumber(value, 0, size - 1, `Entry ${index}`));
    const present = new Uint8Array(size);
    for (let i = 0; i < numbers.length; i++) {
      if (i > 0 && numbers[i]! <= numbers[i - 1]!) throw new AnswerError("The points must be in increasing order with no repeats.");
      present[numbers[i]!] = 1;
    }
    tables ??= [completes(low, lowSize), completes(dimension - low, highSize)];
    const [lowTable, highTable] = tables;
    for (let i = 0; i < numbers.length; i++) {
      const a = numbers[i]!;
      const aLow = a % lowSize;
      const aHigh = (a - aLow) / lowSize;
      for (let j = i + 1; j < numbers.length; j++) {
        const b = numbers[j]!;
        const bLow = b % lowSize;
        const third = highTable[aHigh * highSize + (b - bLow) / lowSize]! * lowSize + lowTable[aLow * lowSize + bLow]!;
        if (present[third]) throw new AnswerError(`The points ${a}, ${b} and ${third} are in a line.`);
      }
    }
    return numbers;
  };
  const columns = 3 ** Math.ceil(dimension / 2);
  const rows = size / columns;
  return {
    id: `cap-${dimension}`,
    approaches: CAP_APPROACHES,
    open: {
      newFrom: best + 1,
      known: `The largest cap set anyone has published in dimension ${dimension} has ${best} points. The true maximum is known only up to dimension 6.`,
      wouldMean: `A cap set in dimension ${dimension} larger than any published: a new lower bound for a number mathematicians have tried to pin down for decades.`,
      ...source,
    },
    title: `The largest cap set in dimension ${dimension}`,
    summary: `Take every point whose ${dimension} coordinates are each 0, 1 or 2: ${number(size)} points. Choose as many as you can with no three in a line. The best anyone has published is ${best}.`,
    goal: "highest",
    wins: `The most points wins. ${best + 1} or more would be a new result.`,
    statement: `A point has ${dimension} coordinates, each 0, 1 or 2. Point number p stands for the point whose coordinates are the ${dimension} digits of p written in base 3, so points are numbered 0 to ${size - 1}. The data is {"dimension": ${dimension}}.
Three different points are in a line when, in every coordinate, their three values are all the same or all different (equivalently: their coordinates add up to a multiple of 3 in every position).
Choose points so that no three of them are in a line.
Score: how many points you chose. Higher is better.
Answer: a JSON array of your point numbers in increasing order with no repeats, at most ${most} of them.`,
    data: { dimension },
    score: (answer) => chosen(answer).length,
    picture(answer) {
      const cells =
        answer === null
          ? ""
          : chosen(answer)
              .map((p) => `<rect class="pic-on" x="${(p % columns) * 10 + 1}" y="${Math.floor(p / columns) * 10 + 1}" width="8" height="8"/>`)
              .join("");
      return svg(
        `0 0 ${columns * 10} ${rows * 10}`,
        `The ${number(size)} points laid out as a grid` + (answer === null ? "" : ", with the chosen ones marked"),
        `<rect class="pic-frame" x="0" y="0" width="${columns * 10}" height="${rows * 10}"/>${cells}`,
      );
    },
  };
}

const number = (value: number) => value.toLocaleString("en-US");
const CAP_SOURCE = {
  asOf: "27 November 2026",
  source: "Romera-Paredes and others, Mathematical discoveries from program search with large language models (Nature, 2023)",
  sourceUrl: "https://www.nature.com/articles/s41586-023-06924-6",
};

// Open problems come first. Their targets move as people publish: before adding or
// keeping one, check its source, and retire a problem (keep its id and answers) once it is settled elsewhere.
export const PROBLEMS: readonly Problem[] = [
  noThreeInLine(75),
  noThreeInLine(77),
  noThreeInLine(79),
  capSet(7, 236, CAP_SOURCE),
  capSet(8, 512, CAP_SOURCE),
  tour,
  pack,
  spaced,
  cut,
];
export const findProblem = (id: string): Problem | undefined => PROBLEMS.find((problem) => problem.id === id);

/** One number where higher always means a better answer, whichever way the problem scores. */
export const betterness = (problem: Problem, score: number): number => (problem.goal === "highest" ? score : -score);
