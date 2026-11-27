// Runs the automatic checks on one submitted engine piece. This file is ours.
// The piece's code runs in a worker with nothing but its own functions; it is
// sent the inputs of each check and never the expected answers. The verdict
// is worked out here, so the piece cannot report its own result.
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

  const worker = new Worker(URL.createObjectURL(new Blob([`(${workerSide})();`], { type: "text/javascript" })));
  let waiting = null;
  let dead = null;

  worker.onmessage = (event) => {
    const message = event.data;
    if (!waiting || !message) return;
    if (message.type === waiting.type && (message.type === "loaded" || message.id === waiting.id)) {
      const done = waiting;
      waiting = null;
      clearTimeout(done.timer);
      done.resolve(message);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    dead = "the code stopped with an error";
    if (waiting) {
      const done = waiting;
      waiting = null;
      clearTimeout(done.timer);
      done.resolve({ error: dead });
    }
  };

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

  function show(test, ok, why) {
    const item = document.createElement("li");
    item.className = ok ? "pass" : "fail";
    item.textContent = `${ok ? "Passed" : "Failed"}: ${test.name}${test.hidden ? " (hidden check)" : ""}`;
    if (!ok && why) {
      const reason = document.createElement("span");
      reason.className = "why";
      reason.textContent = ` — ${why}`;
      item.append(reason);
    }
    list.append(item);
  }

  (async () => {
    const loaded = await ask({ type: "load", code: data.code }, "loaded");
    const results = data.tests.map(() => ({ ok: true, why: "" }));
    // Every check runs twice. A piece that remembers anything between calls
    // gives a different answer the second time and fails.
    let nextId = 0;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < data.tests.length; i++) {
        const test = data.tests[i];
        const id = nextId++;
        const reply = loaded.error ? loaded : await ask({ type: "call", id, fn: test.call, args: test.args }, "result", id);
        if (reply.error) {
          results[i] = { ok: false, why: String(reply.error).slice(0, 200) };
        } else if (!passes(test, reply.value)) {
          results[i] = { ok: false, why: round === 0 ? "wrong answer" : "gave a different answer the second time" };
        }
      }
    }
    worker.terminate();

    const total = data.tests.length;
    const passed = results.filter((result) => result.ok).length;
    data.tests.forEach((test, i) => show(test, results[i].ok, results[i].why));
    summary.textContent = passed === total ? `Passed all ${total} checks.` : `Passed ${passed} of ${total} checks.`;
    summary.className = passed === total ? "pass" : "fail";
    // Tell the admin console, which is the only page allowed to frame this one.
    parent.postMessage({ type: "piece-checks", id: data.id, passed, total }, data.reportTo);
  })();
})();
