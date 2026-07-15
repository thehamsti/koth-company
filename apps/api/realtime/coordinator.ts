import type {
  AutomationState,
  OperatorState,
  PredictionPublicSnapshot,
  PublicMarketSnapshot,
  RealtimeEvent,
  ViewerAccountSnapshot,
} from "../../../packages/contracts/src";
import { getAutomationState } from "../../../packages/predictions/automation/service";
import { AUTOMATION_LEASE_TIMEOUT_MS } from "../../../packages/predictions/automation/state";
import { getOperatorState } from "../../../packages/predictions/services/operator";
import {
  getAffectedViewerAccountSnapshots,
  getPredictionPublicSnapshot,
  getViewerAccountSnapshot,
  type ViewerAccountUpdate,
} from "../../../packages/predictions/services/trading";
import { RealtimeBroker, type RealtimeTopic } from "./broker";

type TradeProjection = {
  market: PublicMarketSnapshot;
  account: ViewerAccountSnapshot;
};

type RealtimeCoordinatorOptions = {
  loadPublicSnapshot?: () => Promise<PredictionPublicSnapshot>;
  loadViewerAccount?: (userId: string) => Promise<ViewerAccountSnapshot>;
  loadAffectedAccounts?: (
    eventId: string,
    marketIds: readonly string[],
  ) => Promise<ViewerAccountUpdate[]>;
  loadOperatorState?: () => Promise<OperatorState>;
  loadAutomationState?: () => Promise<AutomationState>;
  marketBatchMs?: number;
  leaderboardBatchMs?: number;
  publicBatchMs?: number;
  automationLeaseTimeoutMs?: number;
};

type AutomationLease = {
  status?: unknown;
  lastHeartbeatAt?: unknown;
  leaseExpiresAt?: unknown;
};

type SnapshotPublication = "public" | "leaderboards";

function timestamp(value: unknown): number | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export class RealtimeCoordinator {
  readonly broker: RealtimeBroker;
  readonly #loadPublicSnapshot: () => Promise<PredictionPublicSnapshot>;
  readonly #loadViewerAccount: (userId: string) => Promise<ViewerAccountSnapshot>;
  readonly #loadAffectedAccounts: (
    eventId: string,
    marketIds: readonly string[],
  ) => Promise<ViewerAccountUpdate[]>;
  readonly #loadOperator: () => Promise<OperatorState>;
  readonly #loadAutomation: () => Promise<AutomationState>;
  readonly #marketBatchMs: number;
  readonly #leaderboardBatchMs: number;
  readonly #publicBatchMs: number;
  readonly #automationLeaseTimeoutMs: number;
  #publicSnapshot: PredictionPublicSnapshot | null = null;
  #snapshotLoad: Promise<PredictionPublicSnapshot> | null = null;
  #snapshotRefreshRunning = false;
  #pendingSnapshotPublications = new Set<SnapshotPublication>();
  #pendingMarkets = new Map<string, PublicMarketSnapshot>();
  #marketTimer: ReturnType<typeof setTimeout> | null = null;
  #leaderboardTimer: ReturnType<typeof setTimeout> | null = null;
  #publicTimer: ReturnType<typeof setTimeout> | null = null;
  #automationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(broker = new RealtimeBroker(), options: RealtimeCoordinatorOptions = {}) {
    this.broker = broker;
    this.#loadPublicSnapshot = options.loadPublicSnapshot ?? getPredictionPublicSnapshot;
    this.#loadViewerAccount = options.loadViewerAccount ?? getViewerAccountSnapshot;
    this.#loadAffectedAccounts = options.loadAffectedAccounts ?? getAffectedViewerAccountSnapshots;
    this.#loadOperator =
      options.loadOperatorState ?? (getOperatorState as () => Promise<OperatorState>);
    this.#loadAutomation =
      options.loadAutomationState ?? (getAutomationState as () => Promise<AutomationState>);
    this.#marketBatchMs = options.marketBatchMs ?? 250;
    this.#leaderboardBatchMs = options.leaderboardBatchMs ?? 1_000;
    this.#publicBatchMs = options.publicBatchMs ?? 250;
    this.#automationLeaseTimeoutMs =
      options.automationLeaseTimeoutMs ?? AUTOMATION_LEASE_TIMEOUT_MS;
  }

  async initialPrediction(userId?: string): Promise<{
    topics: RealtimeTopic[];
    events: RealtimeEvent[];
  }> {
    const checkpoint = this.broker.checkpoint();
    const topics: RealtimeTopic[] = ["public"];
    const events: RealtimeEvent[] = [
      this.broker.eventAt(checkpoint, "stream.ready", { epoch: this.broker.epoch }),
    ];
    if (userId) {
      const [publicSnapshot, account] = await Promise.all([
        this.getPublicSnapshot(),
        this.#loadViewerAccount(userId),
      ]);
      topics.push(`account:${userId}`);
      events.push(this.broker.eventAt(checkpoint, "public.snapshot", publicSnapshot));
      events.push(this.broker.eventAt(checkpoint, "account.updated", account));
      return { topics, events };
    }
    const publicSnapshot = await this.getPublicSnapshot();
    events.push(this.broker.eventAt(checkpoint, "public.snapshot", publicSnapshot));
    return { topics, events };
  }

  async initialOperator(): Promise<RealtimeEvent[]> {
    const checkpoint = this.broker.checkpoint();
    const state = await this.loadOperatorState();
    this.#scheduleAutomationExpiry(state.automation);
    return [
      this.broker.eventAt(checkpoint, "stream.ready", { epoch: this.broker.epoch }),
      this.broker.eventAt(checkpoint, "operator.state", state),
    ];
  }

  async initialAutomation(): Promise<RealtimeEvent[]> {
    const checkpoint = this.broker.checkpoint();
    const state = await this.loadAutomationState();
    this.#scheduleAutomationExpiry(state.automation);
    return [
      this.broker.eventAt(checkpoint, "stream.ready", { epoch: this.broker.epoch }),
      this.broker.eventAt(checkpoint, "automation.state", state),
    ];
  }

  async getPublicSnapshot(): Promise<PredictionPublicSnapshot> {
    if (this.#publicSnapshot) return this.#publicSnapshot;
    return this.#loadSnapshot();
  }

  publishTrade(userId: string, projection: TradeProjection): void {
    const pending = this.#pendingMarkets.get(projection.market.id);
    const cached = this.#publicSnapshot?.markets.find(
      (candidate) => candidate.id === projection.market.id,
    );
    const highestVersion = Math.max(pending?.version ?? -1, cached?.version ?? -1);
    if (projection.market.version >= highestVersion) {
      this.#replaceCachedMarket(projection.market);
      this.#pendingMarkets.set(projection.market.id, projection.market);
      this.#marketTimer ??= setTimeout(() => this.#flushMarkets(), this.#marketBatchMs);
    }
    this.broker.publish([`account:${userId}`], "account.updated", projection.account);
    this.#scheduleLeaderboards();
  }

  async publishChannelPointCredit(userId: string): Promise<void> {
    this.broker.publish(
      [`account:${userId}`],
      "account.updated",
      await this.#loadViewerAccount(userId),
    );
    this.#scheduleLeaderboards();
  }

  async publishAffectedAccounts(eventId: string, marketIds: readonly string[]): Promise<void> {
    if (marketIds.length === 0) return;
    try {
      const updates = await this.#loadAffectedAccounts(eventId, marketIds);
      for (const update of updates) {
        this.broker.publish([`account:${update.userId}`], "account.updated", update.account);
      }
    } catch (error) {
      console.error("Realtime account projection failed after settlement.", {
        eventId,
        marketIds,
        error,
      });
    }
  }

  publishPublicChange(): void {
    this.#publicTimer ??= setTimeout(() => void this.#flushPublic(), this.#publicBatchMs);
  }

  async publishOperatorState(state?: OperatorState): Promise<void> {
    const currentState = state ?? (await this.loadOperatorState());
    this.broker.publish(["operator"], "operator.state", currentState);
    this.#scheduleAutomationExpiry(currentState.automation);
  }

  async publishAutomationState(): Promise<void> {
    const state = await this.loadAutomationState();
    this.broker.publish(["automation"], "automation.state", state);
    this.#scheduleAutomationExpiry(state.automation);
  }

  publishAccountInvalidation(payload: { eventId: string | null; reason: "event_changed" }): void {
    this.broker.publish(["public"], "accounts.invalidated", payload);
  }

  async publishControlChange(operatorState?: OperatorState): Promise<void> {
    this.publishPublicChange();
    await Promise.all([this.publishOperatorState(operatorState), this.publishAutomationState()]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#marketTimer) clearTimeout(this.#marketTimer);
    if (this.#leaderboardTimer) clearTimeout(this.#leaderboardTimer);
    if (this.#publicTimer) clearTimeout(this.#publicTimer);
    if (this.#automationExpiryTimer) clearTimeout(this.#automationExpiryTimer);
    this.#marketTimer = null;
    this.#leaderboardTimer = null;
    this.#publicTimer = null;
    this.#automationExpiryTimer = null;
    this.#pendingSnapshotPublications.clear();
    this.#pendingMarkets.clear();
    this.broker.close();
  }

  #loadSnapshot(): Promise<PredictionPublicSnapshot> {
    if (this.#snapshotLoad) return this.#snapshotLoad;

    const load = this.#loadPublicSnapshot()
      .then((snapshot) => {
        const merged = this.#mergeSnapshot(snapshot);
        if (!this.#closed) this.#publicSnapshot = merged;
        return merged;
      })
      .finally(() => {
        if (this.#snapshotLoad === load) this.#snapshotLoad = null;
      });
    this.#snapshotLoad = load;
    return load;
  }

  #replaceCachedMarket(market: PublicMarketSnapshot): void {
    if (!this.#publicSnapshot) return;
    this.#publicSnapshot = {
      ...this.#publicSnapshot,
      markets: this.#publicSnapshot.markets.map((candidate) =>
        candidate.id === market.id && market.version >= candidate.version ? market : candidate,
      ),
    };
  }

  #mergeSnapshot(snapshot: PredictionPublicSnapshot): PredictionPublicSnapshot {
    if (!this.#publicSnapshot && this.#pendingMarkets.size === 0) return snapshot;
    const cached = new Map(
      this.#publicSnapshot?.markets.map((market) => [market.id, market] as const) ?? [],
    );
    return {
      ...snapshot,
      markets: snapshot.markets.map((market) => {
        const pending = this.#pendingMarkets.get(market.id);
        const cachedMarket = cached.get(market.id);
        const newest = [market, pending, cachedMarket].reduce<PublicMarketSnapshot>(
          (current, candidate) =>
            candidate && candidate.version > current.version ? candidate : current,
          market,
        );
        if (pending && newest.version > pending.version) {
          this.#pendingMarkets.delete(market.id);
        }
        return newest;
      }),
    };
  }

  #flushMarkets(): void {
    this.#marketTimer = null;
    for (const market of this.#pendingMarkets.values()) {
      const cached = this.#publicSnapshot?.markets.find((candidate) => candidate.id === market.id);
      if (cached && cached.version > market.version) continue;
      this.broker.publish(["public"], "market.updated", { market }, `market.updated:${market.id}`);
    }
    this.#pendingMarkets.clear();
  }

  #scheduleLeaderboards(): void {
    this.#leaderboardTimer ??= setTimeout(
      () => this.#flushLeaderboards(),
      this.#leaderboardBatchMs,
    );
  }

  #flushLeaderboards(): void {
    this.#leaderboardTimer = null;
    this.#requestSnapshotPublication("leaderboards");
  }

  #flushPublic(): void {
    this.#publicTimer = null;
    this.#requestSnapshotPublication("public");
  }

  #requestSnapshotPublication(publication: SnapshotPublication): void {
    if (this.#closed) return;
    this.#pendingSnapshotPublications.add(publication);
    if (this.#snapshotRefreshRunning) return;
    this.#snapshotRefreshRunning = true;
    void this.#drainSnapshotPublications();
  }

  async #drainSnapshotPublications(): Promise<void> {
    try {
      while (!this.#closed && this.#pendingSnapshotPublications.size > 0) {
        const publications = new Set(this.#pendingSnapshotPublications);
        this.#pendingSnapshotPublications.clear();

        const bootstrapLoad = this.#snapshotLoad;
        if (bootstrapLoad) {
          try {
            await bootstrapLoad;
          } catch {
            // The bootstrap caller owns reporting its failed request.
          }
          for (const publication of publications) {
            this.#pendingSnapshotPublications.add(publication);
          }
          continue;
        }

        try {
          await this.#loadSnapshot();
          if (this.#closed) return;
          const snapshot = this.#publicSnapshot;
          if (!snapshot) continue;
          if (publications.has("public")) {
            this.broker.publish(["public"], "public.snapshot", snapshot);
          }
          if (publications.has("leaderboards")) {
            this.broker.publish(["public"], "leaderboards.updated", {
              leaderboard: snapshot.leaderboard,
              seasonLeaderboard: snapshot.seasonLeaderboard,
            });
          }
        } catch (error) {
          console.error("Realtime snapshot refresh failed.", error);
        }
      }
    } finally {
      this.#snapshotRefreshRunning = false;
      if (!this.#closed && this.#pendingSnapshotPublications.size > 0) {
        this.#snapshotRefreshRunning = true;
        void this.#drainSnapshotPublications();
      }
    }
  }

  #scheduleAutomationExpiry(automation: AutomationLease | null | undefined): void {
    if (this.#closed) return;
    if (this.#automationExpiryTimer) clearTimeout(this.#automationExpiryTimer);
    this.#automationExpiryTimer = null;
    if (automation?.status !== "running") return;

    const explicitExpiry = timestamp(automation.leaseExpiresAt);
    const heartbeat = timestamp(automation.lastHeartbeatAt);
    const expiresAt =
      explicitExpiry ?? (heartbeat === null ? null : heartbeat + this.#automationLeaseTimeoutMs);
    if (expiresAt === null) return;
    const delay = Math.max(1, expiresAt - Date.now() + 1);
    this.#automationExpiryTimer = setTimeout(() => void this.#publishAutomationExpiry(), delay);
  }

  async #publishAutomationExpiry(): Promise<void> {
    this.#automationExpiryTimer = null;
    if (this.#closed) return;
    try {
      const [automation, operator] = await Promise.all([
        this.loadAutomationState(),
        this.loadOperatorState(),
      ]);
      if (this.#closed) return;
      this.broker.publish(["automation"], "automation.state", automation);
      this.broker.publish(["operator"], "operator.state", operator);
      this.#scheduleAutomationExpiry(automation.automation);
    } catch (error) {
      console.error("Realtime automation lease refresh failed.", error);
      if (!this.#closed) {
        this.#automationExpiryTimer = setTimeout(() => void this.#publishAutomationExpiry(), 1_000);
      }
    }
  }

  async loadOperatorState(): Promise<OperatorState> {
    return this.#loadOperator();
  }

  async loadAutomationState(): Promise<AutomationState> {
    return this.#loadAutomation();
  }
}
