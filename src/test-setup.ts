import { Window } from "happy-dom";

const window = new Window();

Object.assign(globalThis, {
  document: window.document,
  navigator: window.navigator,
  window,
});
