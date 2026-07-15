import { describe, expect, test } from "bun:test";
import { resolveParticipantName } from "./cms";

describe("resolveParticipantName", () => {
  test("reads a populated Payload relationship", () => {
    expect(resolveParticipantName({ displayName: "Hydra" })).toBe("Hydra");
  });

  test("ignores an unpopulated relationship id", () => {
    expect(resolveParticipantName(42)).toBeNull();
  });
});
