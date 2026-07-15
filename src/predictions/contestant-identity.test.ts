import { describe, expect, test } from "bun:test";
import { contestantIdentityFingerprint } from "./contestant-identity";

describe("contestant identity fingerprint", () => {
  test.each([
    ["Kaptèn", "Kapten"],
    ["KAPTE\u0300N", "kapten"],
    ["  Kaptèn\tPlayer  ", "kapten player"],
    ["Ｋａｐｔｅｎ", "kapten"],
  ])("treats %s and %s as the same contestant", (left, right) => {
    expect(contestantIdentityFingerprint(left)).toBe(contestantIdentityFingerprint(right));
  });
});
