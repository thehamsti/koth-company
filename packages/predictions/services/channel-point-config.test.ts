import { afterEach, describe, expect, test } from "bun:test";
import {
  getChannelPointRewardDenominations,
  getChannelPointsEventCap,
  getChannelPointsToCrownsRate,
} from "./channel-point-config";

const originalRate = process.env.CHANNEL_POINTS_TO_CROWNS_RATE;
const originalCap = process.env.CHANNEL_POINTS_MAX_PER_USER_PER_EVENT;

afterEach(() => {
  if (originalRate === undefined) delete process.env.CHANNEL_POINTS_TO_CROWNS_RATE;
  else process.env.CHANNEL_POINTS_TO_CROWNS_RATE = originalRate;
  if (originalCap === undefined) delete process.env.CHANNEL_POINTS_MAX_PER_USER_PER_EVENT;
  else process.env.CHANNEL_POINTS_MAX_PER_USER_PER_EVENT = originalCap;
});

describe("channel point configuration", () => {
  test("uses the configured conversion rate and point cap", () => {
    process.env.CHANNEL_POINTS_TO_CROWNS_RATE = "500";
    process.env.CHANNEL_POINTS_MAX_PER_USER_PER_EVENT = "5000";

    expect(getChannelPointsToCrownsRate()).toBe(500);
    expect(getChannelPointsEventCap()).toBe(5000);
    expect(getChannelPointRewardDenominations()).toEqual([
      { title: "1 Crown", cost: 500, crowns: "1" },
      { title: "10 Crowns", cost: 5000, crowns: "10" },
    ]);
  });

  test("rejects invalid values", () => {
    process.env.CHANNEL_POINTS_TO_CROWNS_RATE = "0";
    expect(() => getChannelPointsToCrownsRate()).toThrow("must be a positive integer");

    process.env.CHANNEL_POINTS_TO_CROWNS_RATE = "1000";
    process.env.CHANNEL_POINTS_MAX_PER_USER_PER_EVENT = "500";
    expect(() => getChannelPointRewardDenominations()).toThrow(
      "must be at least CHANNEL_POINTS_TO_CROWNS_RATE",
    );
  });
});
