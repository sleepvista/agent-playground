// How a project piece is loaded inside a worker. This file is ours. It is used
// in two places, and must behave identically in both: where a piece is judged
// against its checks, and where the finished project runs on its pieces.
//
// A piece is meant to be plain calculation: values in, values out. Checks can
// show that it gives right answers. They cannot show what else its code does
// when it is loaded, or when one of its functions is called later, beside a
// canvas, in a program that visitors watch. So a piece is not trusted to be
// what it claims. It is loaded where it can name nothing but the language's
// own building blocks:
//
// 1. Every name the piece's code uses is looked up in a fixed list (Math,
//    JSON, Array and the like, plus define). Any other name is simply
//    undefined: no self, no globalThis, no postMessage, no timers, no canvas.
// 2. The building blocks themselves are frozen first, so a piece cannot alter
//    them to interfere with the program that later runs beside it.
// 3. Its code runs in strict mode, where a function cannot reach the global
//    object through `this`, and the page's policy forbids making code from
//    text, which closes the remaining way to it.
//
// The server checks that a piece's code is a well-formed function body before
// accepting it, so the code cannot close the wrapper below early and carry on
// outside it.
//
// The function is written out as text and placed at the start of a worker's
// script, then called there. It returns the loader.
function pieceWorkerSetup() {
  "use strict";

  const BUILT_IN = [
    "Object", "Function", "Array", "Number", "String", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Reflect", "Proxy",
    "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Promise", "RegExp", "Date", "Intl", "Atomics",
    "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  ];
  // What a piece may name. Deliberately without Function, Proxy, Promise, Date and anything to do with time or the outside.
  const OFFERED = [
    "Object", "Array", "Number", "String", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Reflect", "Map", "Set", "WeakMap",
    "WeakSet", "RegExp", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
    "ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
    "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    "parseInt", "parseFloat", "isNaN", "isFinite", "Infinity", "NaN",
  ];

  // Freezes an object and everything that can be reached from it through its
  // properties, their getters and setters, and its prototype.
  const frozen = new WeakSet();
  function freezeAll(root) {
    const waiting = [root];
    while (waiting.length > 0) {
      const item = waiting.pop();
      if ((typeof item !== "object" && typeof item !== "function") || item === null || frozen.has(item)) continue;
      frozen.add(item);
      Object.freeze(item);
      waiting.push(Object.getPrototypeOf(item));
      for (const key of Reflect.ownKeys(item)) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property) continue;
        if ("value" in property) waiting.push(property.value);
        else waiting.push(property.get, property.set);
      }
    }
  }
  const prototypeOf = Object.getPrototypeOf;
  for (const name of BUILT_IN) freezeAll(self[name]);
  // Building blocks that have no name of their own and are only met in passing.
  for (const hidden of [
    prototypeOf([][Symbol.iterator]()),
    prototypeOf(new Map()[Symbol.iterator]()),
    prototypeOf(new Set()[Symbol.iterator]()),
    prototypeOf(""[Symbol.iterator]()),
    prototypeOf(/x/[Symbol.matchAll]("")),
    prototypeOf(function* () {}),
    prototypeOf(async function () {}),
    prototypeOf(async function* () {}),
    prototypeOf(Int8Array),
  ]) {
    freezeAll(hidden);
  }

  // Loads one piece and returns the functions it handed to define(), or null if it handed over none.
  return function loadPiece(code) {
    let functions = null;
    const names = Object.create(null);
    for (const name of OFFERED) names[name] = self[name];
    names.undefined = undefined;
    names.define = (value) => {
      functions = value;
    };
    Object.freeze(names);
    // Every name the piece uses is answered from the list above, and nothing can be added to it.
    self.__pieceNames = new Proxy(names, {
      has: () => true,
      get: (target, key) => (typeof key === "string" ? target[key] : undefined),
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
    const address = URL.createObjectURL(
      new Blob(['with (__pieceNames) { (function () {\n"use strict";\n', code, "\n}).call(undefined); }"], { type: "text/javascript" }),
    );
    try {
      importScripts(address);
    } finally {
      delete self.__pieceNames;
      URL.revokeObjectURL(address);
    }
    return functions !== null && typeof functions === "object" ? Object.freeze(functions) : null;
  };
}
