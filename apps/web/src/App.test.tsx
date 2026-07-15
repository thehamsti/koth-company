import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "./App";
import { defaultTournamentContent } from "./content";

describe("KOTH site", () => {
  test("shows tournament mechanics and sponsor destinations", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /king of the hill/i })).toBeTruthy();
    expect(screen.getByText(/Hydramon-Spineshatter/)).toBeTruthy();
    expect(screen.getByText(/Leaderboard updates when matches begin/)).toBeTruthy();
    expect(screen.getByText(/KOTH is sponsored by/).textContent).toContain("Hamsti");
    expect(screen.getByRole("link", { name: /RestedXP premium/ }).getAttribute("href")).toBe(
      "https://www.restedxp.com/ref/Hydramist/",
    );
    expect(screen.getByRole("link", { name: /HOLY starter/ }).getAttribute("href")).toBe(
      "https://uk.weareholy.com/hydra",
    );
    expect(screen.getAllByRole("link", { name: /donate/i })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: /donate/i })) {
      expect(link.getAttribute("href")).toBe("https://streamlabs.com/hydramist");
    }
  });

  test("renders CMS-managed event labels and leaderboard entries", () => {
    render(
      <App
        content={{
          ...defaultTournamentContent,
          expansion: "WotLK",
          season: 4,
          week: 7,
        }}
        leaderboardEntries={[{ name: "Hydra", wins: 6 }]}
      />,
    );

    expect(screen.getByText("WotLK Season 4 · Week 7")).toBeTruthy();
    expect(screen.getByText("Hydra")).toBeTruthy();
    expect(screen.getByText("6 wins")).toBeTruthy();
  });
});
