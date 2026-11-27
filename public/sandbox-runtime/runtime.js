// The fixed runtime for one build. This file is ours and is the only script
// that runs in the page. The build's own code runs in a worker, where it can
// draw on the canvas it is handed and do nothing else.
(() => {
  "use strict";

  const canvas = document.getElementById("stage");
  const notice = document.getElementById("notice");
  // Either a build's code on its own, or { code, pieces } for a program that runs on the engine.
  const data = JSON.parse(document.getElementById("build-code").textContent);
  const code = typeof data === "string" ? data : data.code;
  const pieces = typeof data === "string" ? [] : data.pieces;
  const HANG_LIMIT_MS = 4000;
  // A build answers each frame with one message. Far more than that is a flood, which can use up the tab's memory.
  const MESSAGES_PER_FRAME_LIMIT = 200;

  // Runs inside the worker. It sets up the small drawing interface. Nothing the worker sends back is trusted.
  //
  // A build has the worker to itself, and finds the canvas and the rest as
  // globals. A finished project is different: its pieces were written by other
  // agents and judged only on the answers they give. They are loaded first, in
  // a scope where they can name nothing but the language's building blocks
  // (see piece-scope.js), and the canvas is never made a global at all: the
  // project's own program receives it, and everything else, as arguments.
  function workerSide() {
    const listeners = new Map();
    const emit = (type, value) => {
      for (const listener of listeners.get(type) || []) listener(value);
    };
    let canvas = null;
    const view = { width: 0, height: 0, pixelRatio: 1 };
    const pointer = { x: 0, y: 0, down: false, inside: false };
    const keys = new Set();
    const on = (type, listener) => {
      if (typeof listener !== "function") throw new TypeError("on(type, listener) needs a function");
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    };
    const applySize = (size) => {
      view.width = size.width;
      view.height = size.height;
      view.pixelRatio = size.pixelRatio;
      canvas.width = Math.max(1, Math.round(size.width * size.pixelRatio));
      canvas.height = Math.max(1, Math.round(size.height * size.pixelRatio));
    };
    const run = (parts) => {
      const address = URL.createObjectURL(new Blob(parts, { type: "text/javascript" }));
      try {
        importScripts(address);
      } finally {
        URL.revokeObjectURL(address);
      }
    };

    self.onmessage = (event) => {
      const message = event.data;
      if (message.type === "init") {
        canvas = message.canvas;
        applySize(message.size);
        if (message.pieces.length > 0) {
          const loadPiece = pieceWorkerSetup();
          const engine = {};
          for (const piece of message.pieces) {
            const functions = loadPiece(piece.code);
            if (!functions) throw new Error("A piece handed over no functions.");
            engine[piece.id] = functions;
          }
          Object.freeze(engine);
          self.__start = (main) => {
            delete self.__start;
            main(canvas, view, pointer, keys, on, engine);
          };
          run(["__start(function (canvas, view, pointer, keys, on, engine) {\n", message.code, "\n});"]);
        } else {
          Object.assign(self, { canvas, view, pointer, keys, on });
          run([message.code]);
        }
        postMessage({ type: "ready" });
      } else if (message.type === "frame") {
        try {
          emit("frame", message.time);
        } finally {
          postMessage({ type: "ack" });
        }
      } else if (message.type === "resize") {
        applySize(message.size);
        emit("resize", view);
      } else if (message.type === "pointer") {
        Object.assign(pointer, message.state);
        emit(message.event, pointer);
      } else if (message.type === "key") {
        if (message.event === "keydown") keys.add(message.key);
        else keys.delete(message.key);
        emit(message.event, message.key);
      }
    };
  }

  const measure = () => ({
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });

  const worker = new Worker(URL.createObjectURL(new Blob([`${pieceWorkerSetup}\n(${workerSide})();`], { type: "text/javascript" })));
  let stopped = false;
  let ready = false;
  let waitingSince = performance.now(); // waiting for "ready", then for each frame's "ack"
  let waiting = true;

  function stop(message) {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    notice.textContent = message;
    notice.hidden = false;
  }

  let messagesSinceFrame = 0;
  worker.onmessage = (event) => {
    // The hang check below catches a build that goes silent. This catches one that never stops talking.
    if (++messagesSinceFrame > MESSAGES_PER_FRAME_LIMIT) {
      stop("This build sent far more messages than it should, so it was shut down.");
      return;
    }
    const type = event.data && event.data.type;
    if (type === "ready") ready = true;
    if (type === "ready" || type === "ack") waiting = false;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stop("This build stopped because of an error in its code.");
  };

  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({ type: "init", canvas: offscreen, size: measure(), code, pieces }, [offscreen]);

  // One frame at a time: the next is sent only after the last was handled.
  function tick(time) {
    if (stopped) return;
    if (ready && !waiting) {
      waiting = true;
      waitingSince = performance.now();
      messagesSinceFrame = 0;
      worker.postMessage({ type: "frame", time });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // A build that hangs is shut down instead of spinning forever.
  setInterval(() => {
    if (!stopped && waiting && !document.hidden && performance.now() - waitingSince > HANG_LIMIT_MS) {
      stop("This build stopped responding, so it was shut down.");
    }
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) waitingSince = performance.now();
  });

  new ResizeObserver(() => {
    if (!stopped) worker.postMessage({ type: "resize", size: measure() });
  }).observe(canvas);

  const pointerState = { x: 0, y: 0, down: false, inside: false };
  function sendPointer(eventName, event, changes) {
    if (stopped) return;
    const box = canvas.getBoundingClientRect();
    Object.assign(pointerState, { x: event.clientX - box.left, y: event.clientY - box.top }, changes);
    worker.postMessage({ type: "pointer", event: eventName, state: pointerState });
  }
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    sendPointer("pointerdown", event, { down: true, inside: true });
  });
  canvas.addEventListener("pointermove", (event) => sendPointer("pointermove", event, { inside: true }));
  canvas.addEventListener("pointerup", (event) => sendPointer("pointerup", event, { down: false }));
  canvas.addEventListener("pointercancel", (event) => sendPointer("pointerup", event, { down: false }));
  canvas.addEventListener("pointerleave", (event) => sendPointer("pointermove", event, { inside: false }));

  // Keys reach the build only while the person has clicked into it.
  function sendKey(eventName, event) {
    if (stopped || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === " " || event.key.startsWith("Arrow")) event.preventDefault();
    worker.postMessage({ type: "key", event: eventName, key: event.key });
  }
  canvas.addEventListener("keydown", (event) => sendKey("keydown", event));
  canvas.addEventListener("keyup", (event) => sendKey("keyup", event));
})();
