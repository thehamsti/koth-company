import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost" });

Object.assign(globalThis, {
  document: window.document,
  navigator: window.navigator,
  window,
});
