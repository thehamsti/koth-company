import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OperatorControl } from "./OperatorControl";
import { FakeEventSource } from "../fake-event-source.test-support";

const initial = {
  event: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "KOTH",
    season: 2,
    week: 1,
    status: "draft",
    startingCrowns: "10000.00000000",
  },
  contestants: [],
  arenas: [],
  markets: [],
  proposals: [],
};

afterEach(() => {
  cleanup();
  mock.restore();
  FakeEventSource.reset();
  delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
});

describe("OperatorControl contestant shortcuts", () => {
  test("shows the detected current player and leaderboard wins", () => {
    render(
      <OperatorControl
        initial={{
          ...initial,
          event: { ...initial.event, status: "live" },
          automation: {
            enabled: true,
            paused: false,
            status: "running",
            workerId: "vision-worker",
            lastHeartbeatAt: "2026-07-18T20:00:00.000Z",
            leaseExpiresAt: null,
            pauseReason: null,
            evidenceImage: null,
            lastObservation: {
              activeName: "Carry",
              currentWins: 5,
              leaderboard: [
                { name: "Neepzén", wins: 10 },
                { name: "Myrtilles", wins: 7 },
              ],
            },
          },
        }}
      />,
    );

    expect(screen.getByText("Current player")).toBeTruthy();
    expect(screen.getByText("Carry")).toBeTruthy();
    expect(screen.getByText("5 wins")).toBeTruthy();
    expect(screen.getByText("Neepzén")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
  });

  test("applies streamed operator state without polling", () => {
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(<OperatorControl initial={initial} />);

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/predictions/operator/events");
    act(() => {
      source?.emit("operator.state", {
        ...initial,
        contestants: [
          {
            id: "contestant",
            displayName: "Hydra",
            queuePosition: 1,
            wins: 0,
            status: "queued",
          },
        ],
      });
    });

    expect(screen.getByText("Hydra")).toBeTruthy();
  });

  test("applies the command response even while the stream reconnects", async () => {
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    const updated = {
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
    globalThis.fetch = mock(() =>
      Promise.resolve(Response.json({ id: "command-1", state: updated })),
    ) as unknown as typeof fetch;
    render(<OperatorControl initial={initial} />);
    const source = FakeEventSource.instances[0];
    act(() => source?.dispatchEvent(new Event("error")));

    fireEvent.change(screen.getByRole("textbox", { name: "Character name" }), {
      target: { value: "Hydra" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText("Hydra")).toBeTruthy());
    expect(screen.getByText("Control stream reconnecting…")).toBeTruthy();
  });

  test("shows structured API errors from Twitch setup", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "TWITCH_UNAVAILABLE", message: "Reconnect the broadcaster." } },
          { status: 503 },
        ),
      ),
    ) as unknown as typeof fetch;
    render(<OperatorControl initial={initial} />);

    fireEvent.click(screen.getByRole("button", { name: "Sync rewards" }));

    await waitFor(() => expect(screen.getByText("Reconnect the broadcaster.")).toBeTruthy());
  });

  test("shows a post-commit Twitch synchronization warning", async () => {
    const completed = {
      ...initial,
      event: { ...initial.event, status: "completed" },
    };
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "command-1",
          state: completed,
          warnings: [{ message: "Run Sync rewards again." }],
        }),
      ),
    ) as unknown as typeof fetch;
    render(<OperatorControl initial={completed} />);

    fireEvent.click(screen.getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(screen.getByText("Run Sync rewards again.")).toBeTruthy());
  });

  test("submits the next event from the setup form", async () => {
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

    fireEvent.submit(screen.getByRole("form", { name: "Prepare the next KOTH" }));

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
        status: "paused" as const,
        workerId: "hydramist-mac",
        lastHeartbeatAt: new Date().toISOString(),
        leaseExpiresAt: null,
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
