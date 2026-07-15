import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorControl } from "./OperatorControl";

const initial = {
  event: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "KOTH",
    season: 2,
    week: 1,
    status: "draft",
  },
  contestants: [],
  arenas: [],
  markets: [],
  proposals: [],
};

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("OperatorControl contestant shortcuts", () => {
  test("offers the next event after the latest event is completed", async () => {
    const requests: RequestInit[] = [];
    const completed = {
      ...initial,
      event: { ...initial.event, status: "completed" },
    };
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") requests.push(init);
      return Promise.resolve(
        new Response(JSON.stringify(completed), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<OperatorControl initial={completed} />);

    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      command: {
        type: "create_event",
        name: "KOTH",
        season: 2,
        week: 1,
      },
    });
  });

  test("focuses with slash, submits with Enter, and clears with Escape", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(initial), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<OperatorControl initial={initial} />);
    const input = screen.getByRole("textbox", { name: "Character name" });

    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "Hydra" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "Another" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("value")).toBe("");
    expect(document.activeElement).not.toBe(input);
  });

  test("creates the contestant's next win threshold", async () => {
    const requests: RequestInit[] = [];
    const live = {
      ...initial,
      event: { ...initial.event, status: "live" },
      contestants: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          displayName: "Hydra",
          queuePosition: 1,
          wins: 3,
          status: "queued",
        },
      ],
    };
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) requests.push(init);
      return Promise.resolve(
        new Response(JSON.stringify(live), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<OperatorControl initial={live} />);

    fireEvent.click(screen.getByRole("button", { name: "Create next-win market for Hydra" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      command: {
        type: "create_threshold",
        contestantId: "00000000-0000-4000-8000-000000000002",
        threshold: 4,
      },
    });
  });

  test("removes a contestant while the event is still a draft", async () => {
    const requests: RequestInit[] = [];
    const draft = {
      ...initial,
      contestants: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          displayName: "Hydra",
          queuePosition: 1,
          wins: 0,
          status: "queued",
        },
      ],
    };
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) requests.push(init);
      return Promise.resolve(
        new Response(JSON.stringify(draft), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<OperatorControl initial={draft} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Hydra from queue" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      command: {
        type: "remove_contestant",
        contestantId: "00000000-0000-4000-8000-000000000002",
      },
    });
  });

  test("resumes paused vision automation from the control page", async () => {
    const requests: RequestInit[] = [];
    const paused = {
      ...initial,
      event: { ...initial.event, status: "live" },
      automation: {
        enabled: true,
        paused: true,
        workerId: "hydramist-mac",
        lastHeartbeatAt: new Date().toISOString(),
        pauseReason: "Ambiguous arena result",
        lastObservation: { winScore: 0.92, lossScore: 0.9 },
        evidenceImage: "data:image/jpeg;base64,AA==",
      },
    };
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) requests.push(init);
      return Promise.resolve(
        new Response(JSON.stringify(paused), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<OperatorControl initial={paused} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume CV" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      command: { type: "resume_automation", eventId: initial.event.id },
    });
    expect(screen.getByText("Ambiguous arena result")).toBeTruthy();
    expect(screen.getByAltText("Latest CV evidence")).toBeTruthy();
  });
});
