import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { getPrices, quoteBuy, quoteSell, settlementValues } from "./lmsr";

describe("LMSR market engine", () => {
  test("starts equally and prices always sum to one", () => {
    const prices = getPrices(["0", "0", "0"], "1000");

    expect(prices.map((price) => price.toFixed(6))).toEqual(["0.333333", "0.333333", "0.333333"]);
    expect(Decimal.sum(...prices).toFixed(8)).toBe("1.00000000");
  });

  test("buying raises the selected outcome price", () => {
    const quote = quoteBuy(["0", "0"], 0, "100", "1000");
    const prices = getPrices(quote.quantities, "1000");

    expect(quote.shares.gt(100)).toBe(true);
    expect(prices[0]?.gt("0.5")).toBe(true);
  });

  test("selling returns crowns and lowers the selected price", () => {
    const bought = quoteBuy(["0", "0"], 0, "100", "1000");
    const sold = quoteSell(bought.quantities, 0, bought.shares, "1000");

    expect(sold.crowns.toFixed(6)).toBe("100.000000");
    expect(getPrices(sold.quantities, "1000")[0]?.toFixed(6)).toBe("0.500000");
  });

  test("splits event-winner value across tied contestants", () => {
    expect(settlementValues(4, [1, 3]).map((value) => value.toString())).toEqual([
      "0",
      "0.5",
      "0",
      "0.5",
    ]);
  });

  test("keeps prices finite after extreme market movement", () => {
    const prices = getPrices(["1000000", "0"], "1000");

    expect(prices.every((price) => price.isFinite())).toBe(true);
    expect(Decimal.sum(...prices).toFixed(8)).toBe("1.00000000");
  });
});
