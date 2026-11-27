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

  // Runs inside the worker, in the same scope as the build. It only sets up
  // the small drawing interface. Nothing the worker sends back is trusted.
  function workerSide() {
    const listeners = new Map();
    const emit = (type, value) => {
      for (const listener of listeners.get(type) || []) listener(value);
    };
    const applySize = (size) => {
      self.view.width = size.width;
      self.view.height = size.height;
      self.view.pixelRatio = size.pixelRatio;
      self.canvas.width = Math.max(1, Math.round(size.width * size.pixelRatio));
      self.canvas.height = Math.max(1, Math.round(size.height * size.pixelRatio));
    };

    self.view = { width: 0, height: 0, pixelRatio: 1 };
    self.pointer = { x: 0, y: 0, down: false, inside: false };
    self.keys = new Set();
    self.on = (type, listener) => {
      if (typeof listener !== "function") throw new TypeError("on(type, listener) needs a function");
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    };

    self.onmessage = (event) => {
      const message = event.data;
      if (message.type === "init") {
        self.canvas = message.canvas;
        applySize(message.size);
        if (message.pieces.length > 0) {
          // Each engine piece runs once and hands over its functions through define().
          const engine = {};
          for (const piece of message.pieces) {
            self.define = (functions) => {
              engine[piece.id] = Object.freeze(functions);
            };
            const source = ['(function () {\n"use strict";\n', piece.code, "\n})();"];
            importScripts(URL.createObjectURL(new Blob(source, { type: "text/javascript" })));
          }
          delete self.define;
          self.engine = Object.freeze(engine);
        }
        importScripts(URL.createObjectURL(new Blob([message.code], { type: "text/javascript" })));
        postMessage({ type: "ready" });
      } else if (message.type === "frame") {
        try {
          emit("frame", message.time);
        } finally {
          postMessage({ type: "ack" });
        }
      } else if (message.type === "resize") {
        applySize(message.size);
        emit("resize", self.view);
      } else if (message.type === "pointer") {
        Object.assign(self.pointer, message.state);
        emit(message.event, self.pointer);
      } else if (message.type === "key") {
        if (message.event === "keydown") self.keys.add(message.key);
        else self.keys.delete(message.key);
        emit(message.event, message.key);
      }
    };
  }

  const measure = () => ({
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });

  const worker = new Worker(URL.createObjectURL(new Blob([`(${workerSide})();`], { type: "text/javascript" })));
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

  worker.onmessage = (event) => {
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
