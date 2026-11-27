// Runs code written by agents against checks, inside the sealed frame. This
// file is ours. It has two jobs, chosen by the data the page carries:
//
// - Judging a piece an agent handed in: the piece is sent the inputs of each
//   check, never the expected answers.
// - Running checking work: extra checks an agent proposed are run against a
//   built piece and against the answer key, each in its own worker.
//
// Either way the code under test only ever receives inputs. The verdict is
// worked out here, so the code cannot report its own result.
(() => {
  "use strict";

  const data = JSON.parse(document.getElementById("check-data").textContent);
  const summary = document.getElementById("summary");
  const list = document.getElementById("results");
  const CALL_LIMIT_MS = 2000;

  function workerSide() {
    let functions = null;
    self.define = (value) => {
      functions = value;
    };
    self.onmessage = (event) => {
      const message = event.data;
      if (message.type === "load") {
        const source = ['(function () {\n"use strict";\n', message.code, "\n})();"];
        importScripts(URL.createObjectURL(new Blob(source, { type: "text/javascript" })));
        postMessage({ type: "loaded" });
      } else if (message.type === "call") {
        try {
          const fn = functions && functions[message.fn];
          if (typeof fn !== "function") throw new Error(`define() did not provide a function named ${message.fn}`);
          postMessage({ type: "result", id: message.id, value: fn(...message.args) });
        } catch (error) {
          postMessage({ type: "result", id: message.id, error: String((error && error.message) || error) });
        }
      }
    };
  }

  // Deep comparison. Numbers may differ by a hair; shapes must match exactly.
  function same(actual, expected, tol) {
    if (typeof expected === "number") {
      return typeof actual === "number" && Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
    }
    if (expected === null || typeof expected !== "object") return actual === expected;
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => same(actual[i], item, tol));
    }
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const keys = Object.keys(expected);
    return Object.keys(actual).length === keys.length && keys.every((key) => same(actual[key], expected[key], tol));
  }

  // A route across a grid has many right answers. This accepts any route that
  // is connected, avoids walls, and is as short as the shortest one.
  function validGridPath(test, path) {
    const [grid, start, goal] = test.args;
    if (test.judge.length === null) return path === null;
    if (!Array.isArray(path) || path.length !== test.judge.length + 1) return false;
    const at = (step) => step && Number.isInteger(step.col) && Number.isInteger(step.row);
    if (!path.every(at)) return false;
    const first = path[0];
    const last = path[path.length - 1];
    if (first.col !== start.col || first.row !== start.row || last.col !== goal.col || last.row !== goal.row) return false;
    return path.every((step, i) => {
      const inside = step.col >= 0 && step.row >= 0 && step.col < grid.width && step.row < grid.height;
      if (!inside || grid.cells[step.row * grid.width + step.col] === 1) return false; // 1 is a wall
      if (i === 0) return true;
      return Math.abs(step.col - path[i - 1].col) + Math.abs(step.row - path[i - 1].row) === 1;
    });
  }

  function passes(test, value) {
    if (test.judge && test.judge.type === "gridPath") return validGridPath(test, value);
    return same(value, test.expect, typeof test.tol === "number" ? test.tol : 1e-9);
  }

  /**
   * Code running in a worker of its own. `restarts` is how many times it may
   * be started afresh after it hangs or crashes. A piece being judged gets
   * none: once it has died, every later check fails.
   */
  function sealed(code, restarts) {
    let worker = null;
    let waiting = null;
    let dead = null;
    let loaded = null;

    function settle(reply) {
      const done = waiting;
      waiting = null;
      clearTimeout(done.timer);
      done.resolve(reply);
    }

    function ask(message, type, id) {
      if (dead) return Promise.resolve({ error: dead });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting = null;
          dead = "the code took too long and was stopped";
          worker.terminate();
          resolve({ error: dead });
        }, CALL_LIMIT_MS);
        waiting = { type, id, resolve, timer };
        worker.postMessage(message);
      });
    }

    function start() {
      dead = null;
      worker = new Worker(URL.createObjectURL(new Blob([`(${workerSide})();`], { type: "text/javascript" })));
      worker.onmessage = (event) => {
        const message = event.data;
        if (!waiting || !message) return;
        if (message.type === waiting.type && (message.type === "loaded" || message.id === waiting.id)) settle(message);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        dead = "the code stopped with an error";
        if (waiting) settle({ error: dead });
      };
      loaded = ask({ type: "load", code }, "loaded");
    }

    start();
    return {
      async call(id, fn, args) {
        if (dead && restarts > 0) {
          restarts--;
          start();
        }
        const ready = await loaded;
        return ready.error ? ready : ask({ type: "call", id, fn, args }, "result", id);
      },
      stop() {
        worker.terminate();
      },
    };
  }

  function show(test, ok, why) {
    line(ok ? "pass" : "fail", `${ok ? "Passed" : "Failed"}: ${test.name}${test.hidden ? " (hidden check)" : ""}`, ok ? "" : why);
  }

  function line(className, text, why) {
    const item = document.createElement("li");
    item.className = className;
    item.textContent = text;
    if (why) {
      const reason = document.createElement("span");
      reason.className = "why";
      reason.textContent = ` — ${why}`;
      item.append(reason);
    }
    list.append(item);
  }

  async function judgePiece() {
    const piece = sealed(data.code, 0);
    const results = data.tests.map(() => ({ ok: true, why: "" }));
    // Every check runs twice. A piece that remembers anything between calls
    // gives a different answer the second time and fails.
    let nextId = 0;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < data.tests.length; i++) {
        const test = data.tests[i];
        const reply = await piece.call(nextId++, test.call, test.args);
        if (reply.error) {
          results[i] = { ok: false, why: String(reply.error).slice(0, 200) };
        } else if (!passes(test, reply.value)) {
          results[i] = { ok: false, why: round === 0 ? "wrong answer" : "gave a different answer the second time" };
        }
      }
    }
    piece.stop();

    const total = data.tests.length;
    const passed = results.filter((result) => result.ok).length;
    data.tests.forEach((test, i) => show(test, results[i].ok, results[i].why));
    summary.textContent = passed === total ? `Passed all ${total} checks.` : `Passed ${passed} of ${total} checks.`;
    summary.className = passed === total ? "pass" : "fail";
    // Tell the admin console, which is the only page allowed to frame this one.
    parent.postMessage({ type: "piece-checks", id: data.id, passed, total }, data.reportTo);
  }

  const VERDICT_WORDS = {
    agreed: "Held: the built piece, the answer key and the checking agent all agree",
    not_expected: "Not counted: the checking agent expected something the answer key does not give",
    fault: "Fault: the answer key and the checking agent agree, and the built piece differs",
    key_question: "Question: the built piece and the checking agent agree, and the answer key differs",
    unclear: "Not counted: all three differ, or the answer key could not answer",
  };

  // Three views on each input: the built piece, the answer key, and what the
  // checking agent expected. The verdict is whatever two of them agree on.
  async function runChecking() {
    // A hang on one input must not spoil the rest, so both may start afresh a few times.
    const piece = sealed(data.code, 3);
    const key = sealed(data.key, 3);
    const results = [];
    let nextId = 0;
    for (const check of data.checks) {
      const tol = typeof data.tolerances[check.call] === "number" ? data.tolerances[check.call] : 1e-9;
      const keyed = await key.call(nextId++, check.call, check.args);
      // The piece answers twice: one that remembers between calls counts as having no answer.
      const first = await piece.call(nextId++, check.call, check.args);
      const second = first.error ? first : await piece.call(nextId++, check.call, check.args);
      const built = first.error || second.error ? { error: first.error || second.error } : same(second.value, first.value, tol) ? first : { error: "gave a different answer the second time" };

      let verdict = "unclear";
      if (!keyed.error) {
        const pieceRight = !built.error && same(built.value, keyed.value, tol);
        const agentRight = same(check.expect, keyed.value, tol);
        if (pieceRight) verdict = agentRight ? "agreed" : "not_expected";
        else if (agentRight) verdict = "fault";
        else if (!built.error && same(built.value, check.expect, tol)) verdict = "key_question";
      }
      const finding = verdict === "fault" || verdict === "key_question";
      results.push({
        verdict,
        // Sent only for findings, for a person to look at. The admin page's server cuts them down before keeping them.
        ...(finding ? { piece: built.error ? { stopped: true } : built.value, key: keyed.value } : {}),
      });
      line(finding ? "fail" : "pass", `${check.call}: ${VERDICT_WORDS[verdict]}`, built.error && finding ? String(built.error).slice(0, 200) : "");
    }
    piece.stop();
    key.stop();

    const held = results.filter((result) => result.verdict === "agreed").length;
    const found = results.filter((result) => result.verdict === "fault" || result.verdict === "key_question").length;
    summary.textContent = found > 0 ? `${found} of ${results.length} checks found something to look at.` : `Nothing found. ${held} of ${results.length} checks held.`;
    summary.className = found > 0 ? "fail" : "pass";
    parent.postMessage({ type: "checking-results", id: data.id, results }, data.reportTo);
  }

  (data.mode === "checking" ? runChecking : judgePiece)();
})();
