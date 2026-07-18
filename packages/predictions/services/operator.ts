import Decimal from "decimal.js";
import { and, asc, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { AUTOMATION_LEASE_TIMEOUT_MS, automationStatus } from "../automation/state";
import { contestantIdentityFingerprint } from "../contestant-identity";
import { predictionDb } from "../db";
import {
  arenas,
  automationSessions,
  contestants,
  domainEvents,
  events,
  ingestionProposals,
  ledgerEntries,
  marketOutcomes,
  markets,
  portfolios,
  positions,
} from "../db/schema";
import { PredictionError } from "../types";
import {
  validateOperatorTransition,
  type OperatorCommand,
  type OperatorTransitionState,
} from "./operator-state";

export type { OperatorCommand } from "./operator-state";

async function settleMarket(
  tx: Parameters<Parameters<typeof predictionDb.transaction>[0]>[0],
  marketId: string,
  winningOutcomeIds: readonly string[],
): Promise<void> {
  const [market] = await tx
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .for("update")
    .limit(1);
  if (!market || market.status === "settled") return;
  const outcomes = await tx
    .select()
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketId));
  const winnerValue = new Decimal(1).div(winningOutcomeIds.length);
  for (const outcome of outcomes) {
    const value = winningOutcomeIds.includes(outcome.id) ? winnerValue : new Decimal(0);
    await tx
      .update(marketOutcomes)
      .set({ settlementValue: value.toFixed(8), updatedAt: new Date() })
      .where(eq(marketOutcomes.id, outcome.id));
  }
  const holdings = await tx
    .select({
      portfolioId: positions.portfolioId,
      shares: positions.shares,
      outcomeId: positions.outcomeId,
    })
    .from(positions)
    .where(
      inArray(
        positions.outcomeId,
        outcomes.map((outcome) => outcome.id),
      ),
    );
  for (const holding of holdings) {
    const value = winningOutcomeIds.includes(holding.outcomeId) ? winnerValue : new Decimal(0);
    const payout = new Decimal(holding.shares).mul(value);
    if (payout.isZero()) continue;
    await tx
      .update(portfolios)
      .set({
        availableCrowns: sql`${portfolios.availableCrowns} + greatest(${payout.toFixed(8)}::numeric - ${portfolios.settlementDebt}, 0)`,
        settlementDebt: sql`greatest(${portfolios.settlementDebt} - ${payout.toFixed(8)}::numeric, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, holding.portfolioId));
    await tx.insert(ledgerEntries).values({
      portfolioId: holding.portfolioId,
      marketId,
      kind: "settlement",
      amount: payout.toFixed(8),
      metadata: { outcomeId: holding.outcomeId },
    });
  }
  await tx
    .update(markets)
    .set({
      status: "settled",
      settledAt: new Date(),
      version: sql`${markets.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(markets.id, marketId));
}

async function reverseSettlement(
  tx: Parameters<Parameters<typeof predictionDb.transaction>[0]>[0],
  marketId: string,
): Promise<void> {
  const entries = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.marketId, marketId),
        eq(ledgerEntries.kind, "settlement"),
        isNull(ledgerEntries.reversedAt),
      ),
    );
  for (const entry of entries) {
    await tx
      .update(portfolios)
      .set({
        availableCrowns: sql`greatest(${portfolios.availableCrowns} - ${entry.amount}::numeric, 0)`,
        settlementDebt: sql`${portfolios.settlementDebt} + greatest(${entry.amount}::numeric - ${portfolios.availableCrowns}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, entry.portfolioId));
    await tx.insert(ledgerEntries).values({
      portfolioId: entry.portfolioId,
      marketId,
      kind: "settlement_reversal",
      amount: new Decimal(entry.amount).neg().toFixed(8),
      metadata: { reverses: entry.id },
    });
    await tx
      .update(ledgerEntries)
      .set({ reversedAt: new Date() })
      .where(eq(ledgerEntries.id, entry.id));
  }
  await tx
    .update(marketOutcomes)
    .set({ settlementValue: null, updatedAt: new Date() })
    .where(eq(marketOutcomes.marketId, marketId));
  await tx
    .update(markets)
    .set({
      status: "locked",
      settledAt: null,
      version: sql`${markets.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(markets.id, marketId));
}

async function settleArenaResult(
  tx: Parameters<Parameters<typeof predictionDb.transaction>[0]>[0],
  arenaId: string,
  contestantWon: boolean,
): Promise<void> {
  const [arena] = await tx.select().from(arenas).where(eq(arenas.id, arenaId)).limit(1);
  if (!arena) throw new PredictionError("INVALID_COMMAND", "Arena not found.", 404);
  const [liveMarket] = await tx.select().from(markets).where(eq(markets.arenaId, arenaId)).limit(1);
  if (!liveMarket) throw new PredictionError("INVALID_COMMAND", "Arena market not found.");
  const outcomes = await tx
    .select()
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, liveMarket.id));
  const winner = outcomes.find((outcome) => outcome.label === (contestantWon ? "Wins" : "Loses"));
  if (!winner) throw new PredictionError("INVALID_COMMAND", "Arena outcomes are incomplete.");
  await tx
    .update(arenas)
    .set({ status: "settled", contestantWon, settledAt: new Date(), updatedAt: new Date() })
    .where(eq(arenas.id, arenaId));
  await settleMarket(tx, liveMarket.id, [winner.id]);

  const [{ wins }] = await tx
    .select({ wins: count() })
    .from(arenas)
    .where(and(eq(arenas.contestantId, arena.contestantId), eq(arenas.contestantWon, true)));
  await tx
    .update(contestants)
    .set({
      wins,
      bestStreak: wins,
      status: contestantWon ? "active" : "eliminated",
      updatedAt: new Date(),
    })
    .where(eq(contestants.id, arena.contestantId));

  const thresholds = await tx
    .select()
    .from(markets)
    .where(and(eq(markets.contestantId, arena.contestantId), eq(markets.kind, "win_threshold")));
  for (const threshold of thresholds) {
    if (threshold.status === "settled" || threshold.threshold === null) continue;
    const thresholdReached = wins >= threshold.threshold;
    if (thresholdReached || !contestantWon) {
      const thresholdOutcomes = await tx
        .select()
        .from(marketOutcomes)
        .where(eq(marketOutcomes.marketId, threshold.id));
      const thresholdWinner = thresholdOutcomes.find(
        (outcome) => outcome.label === (thresholdReached ? "Yes" : "No"),
      );
      if (thresholdWinner) await settleMarket(tx, threshold.id, [thresholdWinner.id]);
    }
  }
}

export async function runOperatorCommand(
  actorUserId: string | null,
  command: OperatorCommand,
  idempotencyKey: string,
  source = "operator",
): Promise<{ id: string }> {
  return predictionDb.transaction(async (tx) => {
    let eventId: string;
    if (command.type === "create_event") {
      // The lifecycle invariant spans rows, so creation needs a transaction-wide mutex.
      await tx.execute(sql`select pg_advisory_xact_lock(180117001)`);
      const [duplicate] = await tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, "create_event"),
            eq(domainEvents.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (duplicate) return { id: duplicate.id };
      const [activeEvent] = await tx
        .select({ id: events.id })
        .from(events)
        .where(inArray(events.status, ["draft", "live"]))
        .for("update")
        .limit(1);
      if (activeEvent) {
        throw new PredictionError(
          "INVALID_COMMAND",
          "Finish the current draft or live event before creating another.",
        );
      }
      eventId = crypto.randomUUID();
    } else {
      eventId = command.eventId;
      const [duplicate] = await tx
        .select({ id: domainEvents.id })
        .from(domainEvents)
        .where(
          and(eq(domainEvents.eventId, eventId), eq(domainEvents.idempotencyKey, idempotencyKey)),
        )
        .limit(1);
      if (duplicate) return { id: duplicate.id };
    }

    const transitionState: OperatorTransitionState = {
      event: null,
      contestant: null,
      arena: null,
      activeArena: null,
      automation: null,
    };
    if (command.type !== "create_event") {
      const [event] = await tx
        .select({ id: events.id, status: events.status })
        .from(events)
        .where(eq(events.id, eventId))
        .for("update")
        .limit(1);
      transitionState.event = event ?? null;

      if ("contestantId" in command) {
        const [contestant] = await tx
          .select({
            id: contestants.id,
            eventId: contestants.eventId,
            displayName: contestants.displayName,
            status: contestants.status,
            wins: contestants.wins,
          })
          .from(contestants)
          .where(eq(contestants.id, command.contestantId))
          .limit(1);
        transitionState.contestant = contestant ?? null;
      }

      if ("arenaId" in command) {
        const [arena] = await tx
          .select({
            id: arenas.id,
            eventId: arenas.eventId,
            contestantId: arenas.contestantId,
            ordinal: arenas.ordinal,
            status: arenas.status,
          })
          .from(arenas)
          .where(eq(arenas.id, command.arenaId))
          .limit(1);
        transitionState.arena = arena ?? null;
      }

      if (
        command.type === "open_arena" ||
        command.type === "start_arena" ||
        command.type === "record_result" ||
        command.type === "correct_result" ||
        command.type === "complete_event"
      ) {
        const [activeArena] = await tx
          .select({
            id: arenas.id,
            eventId: arenas.eventId,
            contestantId: arenas.contestantId,
            ordinal: arenas.ordinal,
            status: arenas.status,
          })
          .from(arenas)
          .where(and(eq(arenas.eventId, eventId), inArray(arenas.status, ["open", "locked"])))
          .orderBy(desc(arenas.ordinal))
          .limit(1);
        transitionState.activeArena = activeArena ?? null;
      }

      if (
        command.type === "set_automation" ||
        command.type === "pause_automation" ||
        command.type === "resume_automation"
      ) {
        const [automation] = await tx
          .select({ enabled: automationSessions.enabled, paused: automationSessions.paused })
          .from(automationSessions)
          .where(eq(automationSessions.eventId, eventId))
          .limit(1);
        transitionState.automation = automation ?? null;
      }

      validateOperatorTransition(command, transitionState);
    }

    if (command.type === "create_event") {
      await tx.insert(events).values({
        id: eventId,
        name: command.name,
        season: command.season,
        week: command.week,
      });
    } else if (command.type === "add_contestant") {
      const roster = await tx.select().from(contestants).where(eq(contestants.eventId, eventId));
      const fingerprint = contestantIdentityFingerprint(command.displayName);
      const existing = roster.find(
        (contestant) => contestantIdentityFingerprint(contestant.displayName) === fingerprint,
      );
      if (existing) return { id: existing.id };
      await tx.insert(contestants).values({
        eventId,
        displayName: command.displayName,
        queuePosition: command.queuePosition,
      });
    } else if (command.type === "remove_contestant") {
      await tx.delete(contestants).where(eq(contestants.id, command.contestantId));
    } else if (command.type === "create_threshold") {
      const contestant = transitionState.contestant!;
      const [existingThreshold] = await tx
        .select({ id: markets.id })
        .from(markets)
        .where(
          and(
            eq(markets.eventId, eventId),
            eq(markets.contestantId, contestant.id),
            eq(markets.kind, "win_threshold"),
            eq(markets.threshold, command.threshold),
          ),
        )
        .limit(1);
      if (existingThreshold) {
        throw new PredictionError("INVALID_COMMAND", "That threshold market already exists.");
      }
      const [market] = await tx
        .insert(markets)
        .values({
          eventId,
          contestantId: contestant.id,
          kind: "win_threshold",
          status: "open",
          threshold: command.threshold,
          title: `${contestant.displayName} reaches ${command.threshold} wins`,
        })
        .returning();
      if (market) {
        await tx.insert(marketOutcomes).values([
          { marketId: market.id, label: "Yes" },
          { marketId: market.id, label: "No" },
        ]);
      }
    } else if (command.type === "activate_event") {
      const roster = await tx.select().from(contestants).where(eq(contestants.eventId, eventId));
      if (roster.length < 2)
        throw new PredictionError("INVALID_COMMAND", "Add at least two contestants first.");
      await tx
        .update(events)
        .set({ status: "live", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(events.id, eventId));
      const [market] = await tx
        .insert(markets)
        .values({
          eventId,
          kind: "event_winner",
          status: "open",
          title: "Highest streak this KOTH",
        })
        .returning();
      if (market) {
        await tx.insert(marketOutcomes).values(
          roster.map((contestant) => ({
            marketId: market.id,
            contestantId: contestant.id,
            label: contestant.displayName,
          })),
        );
      }
    } else if (command.type === "sync_queue") {
      if (new Set(command.contestantIds).size !== command.contestantIds.length) {
        throw new PredictionError("INVALID_COMMAND", "Queue contestants must be unique.");
      }
      const roster = await tx
        .select()
        .from(contestants)
        .where(eq(contestants.eventId, eventId))
        .orderBy(asc(contestants.queuePosition));
      const byId = new Map(roster.map((contestant) => [contestant.id, contestant]));
      const requested = command.contestantIds.map((contestantId) => byId.get(contestantId));
      if (requested.some((contestant) => !contestant)) {
        throw new PredictionError(
          "INVALID_COMMAND",
          "Queue contains a contestant from another event.",
        );
      }
      const requestedIds = new Set(command.contestantIds);
      const ordered = [
        ...requested.filter((contestant) => contestant !== undefined),
        ...roster.filter((contestant) => !requestedIds.has(contestant.id)),
      ];
      for (const [index, contestant] of ordered.entries()) {
        const rezzed = requestedIds.has(contestant.id) && contestant.status === "eliminated";
        await tx
          .update(contestants)
          .set({
            queuePosition: index + 1,
            ...(rezzed ? { status: "queued" as const } : {}),
            updatedAt: new Date(),
          })
          .where(eq(contestants.id, contestant.id));
      }
    } else if (command.type === "open_arena") {
      const contestant = transitionState.contestant!;
      if (command.baselineWins !== undefined && command.baselineWins > contestant.wins) {
        await tx
          .update(contestants)
          .set({
            wins: command.baselineWins,
            bestStreak: sql`greatest(${contestants.bestStreak}, ${command.baselineWins})`,
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(contestants.id, contestant.id));
      }
      const [{ total }] = await tx
        .select({ total: count() })
        .from(arenas)
        .where(eq(arenas.eventId, eventId));
      const [arena] = await tx
        .insert(arenas)
        .values({ eventId, contestantId: contestant.id, ordinal: total + 1 })
        .returning();
      if (!arena) throw new Error("Arena creation failed.");
      const [market] = await tx
        .insert(markets)
        .values({
          eventId,
          arenaId: arena.id,
          contestantId: contestant.id,
          kind: "live_arena",
          status: "open",
          title: `${contestant.displayName} wins the next arena`,
        })
        .returning();
      if (market) {
        await tx.insert(marketOutcomes).values([
          { marketId: market.id, contestantId: contestant.id, label: "Wins" },
          { marketId: market.id, contestantId: contestant.id, label: "Loses" },
        ]);
      }
    } else if (command.type === "start_arena") {
      await tx
        .update(arenas)
        .set({ status: "locked", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(arenas.id, command.arenaId));
      await tx
        .update(markets)
        .set({
          status: "locked",
          locksAt: new Date(),
          version: sql`${markets.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(markets.arenaId, command.arenaId));
    } else if (command.type === "record_result") {
      await settleArenaResult(tx, command.arenaId, command.contestantWon);
    } else if (command.type === "correct_result") {
      const arena = transitionState.arena!;
      const [later] = await tx
        .select({ id: arenas.id })
        .from(arenas)
        .where(
          and(
            eq(arenas.eventId, eventId),
            gt(arenas.ordinal, arena.ordinal),
            eq(arenas.status, "settled"),
          ),
        )
        .limit(1);
      if (later) throw new PredictionError("INVALID_COMMAND", "Correct later arenas first.");
      const [liveMarket] = await tx
        .select()
        .from(markets)
        .where(eq(markets.arenaId, command.arenaId))
        .limit(1);
      if (!liveMarket) throw new PredictionError("INVALID_COMMAND", "Arena market not found.");
      await reverseSettlement(tx, liveMarket.id);
      const thresholdMarkets = await tx
        .select()
        .from(markets)
        .where(
          and(
            eq(markets.contestantId, arena.contestantId),
            eq(markets.kind, "win_threshold"),
            eq(markets.status, "settled"),
          ),
        );
      for (const thresholdMarket of thresholdMarkets) {
        await reverseSettlement(tx, thresholdMarket.id);
      }
      await settleArenaResult(tx, command.arenaId, command.contestantWon);
    } else if (command.type === "review_proposal") {
      const [proposal] = await tx
        .select()
        .from(ingestionProposals)
        .where(
          and(
            eq(ingestionProposals.id, command.proposalId),
            eq(ingestionProposals.eventId, eventId),
            eq(ingestionProposals.status, "pending"),
          ),
        )
        .limit(1);
      if (!proposal)
        throw new PredictionError("INVALID_COMMAND", "Pending proposal not found.", 404);
      if (command.decision === "accepted" && proposal.kind === "arena_result") {
        const arenaId = proposal.payload.arenaId;
        const contestantWon = proposal.payload.contestantWon;
        if (typeof arenaId !== "string" || typeof contestantWon !== "boolean") {
          throw new PredictionError("INVALID_COMMAND", "The result proposal is malformed.");
        }
        const [arena] = await tx
          .select({
            id: arenas.id,
            eventId: arenas.eventId,
            contestantId: arenas.contestantId,
            ordinal: arenas.ordinal,
            status: arenas.status,
          })
          .from(arenas)
          .where(eq(arenas.id, arenaId))
          .limit(1);
        const [activeArena] = await tx
          .select({
            id: arenas.id,
            eventId: arenas.eventId,
            contestantId: arenas.contestantId,
            ordinal: arenas.ordinal,
            status: arenas.status,
          })
          .from(arenas)
          .where(and(eq(arenas.eventId, eventId), inArray(arenas.status, ["open", "locked"])))
          .orderBy(desc(arenas.ordinal))
          .limit(1);
        validateOperatorTransition(
          { type: "record_result", eventId, arenaId, contestantWon },
          {
            ...transitionState,
            arena: arena ?? null,
            activeArena: activeArena ?? null,
          },
        );
        await settleArenaResult(tx, arenaId, contestantWon);
      }
      await tx
        .update(ingestionProposals)
        .set({
          status: command.decision,
          reviewedBy: actorUserId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(ingestionProposals.id, proposal.id));
    } else if (command.type === "complete_event") {
      const roster = await tx.select().from(contestants).where(eq(contestants.eventId, eventId));
      const high = Math.max(...roster.map((contestant) => contestant.bestStreak));
      const winners = roster.filter((contestant) => contestant.bestStreak === high);
      const [winnerMarket] = await tx
        .select()
        .from(markets)
        .where(and(eq(markets.eventId, eventId), eq(markets.kind, "event_winner")))
        .limit(1);
      if (winnerMarket) {
        const outcomes = await tx
          .select()
          .from(marketOutcomes)
          .where(eq(marketOutcomes.marketId, winnerMarket.id));
        await settleMarket(
          tx,
          winnerMarket.id,
          outcomes
            .filter((outcome) => winners.some((winner) => winner.id === outcome.contestantId))
            .map((outcome) => outcome.id),
        );
      }
      const unresolvedThresholds = await tx
        .select()
        .from(markets)
        .where(
          and(
            eq(markets.eventId, eventId),
            eq(markets.kind, "win_threshold"),
            inArray(markets.status, ["open", "locked"]),
          ),
        );
      for (const threshold of unresolvedThresholds) {
        const outcomes = await tx
          .select()
          .from(marketOutcomes)
          .where(eq(marketOutcomes.marketId, threshold.id));
        const noOutcome = outcomes.find((outcome) => outcome.label === "No");
        if (!noOutcome) {
          throw new PredictionError("INVALID_COMMAND", "Threshold market outcomes are incomplete.");
        }
        await settleMarket(tx, threshold.id, [noOutcome.id]);
      }
      await tx
        .update(contestants)
        .set({ status: "winner", updatedAt: new Date() })
        .where(
          inArray(
            contestants.id,
            winners.map((winner) => winner.id),
          ),
        );
      await tx
        .update(events)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(events.id, eventId));
    } else if (command.type === "set_automation") {
      await tx
        .insert(automationSessions)
        .values({ eventId, enabled: command.enabled, paused: false, pauseReason: null })
        .onConflictDoUpdate({
          target: automationSessions.eventId,
          set: {
            enabled: command.enabled,
            paused: false,
            pauseReason: null,
            updatedAt: new Date(),
          },
        });
    } else if (command.type === "pause_automation") {
      await tx
        .insert(automationSessions)
        .values({
          eventId,
          enabled: true,
          paused: true,
          pauseReason: command.reason ?? "Paused by operator",
        })
        .onConflictDoUpdate({
          target: automationSessions.eventId,
          set: {
            paused: true,
            pauseReason: command.reason ?? "Paused by operator",
            updatedAt: new Date(),
          },
        });
    } else if (command.type === "resume_automation") {
      await tx
        .insert(automationSessions)
        .values({ eventId, enabled: true, paused: false, pauseReason: null })
        .onConflictDoUpdate({
          target: automationSessions.eventId,
          set: { enabled: true, paused: false, pauseReason: null, updatedAt: new Date() },
        });
    }

    const [domainEvent] = await tx
      .insert(domainEvents)
      .values({
        eventId,
        actorUserId,
        type: command.type,
        source,
        idempotencyKey,
        payload: command,
      })
      .returning();
    if (!domainEvent) throw new Error("Domain event creation failed.");
    return { id: domainEvent.id };
  });
}

export async function getOperatorState() {
  const [event] = await predictionDb.select().from(events).orderBy(desc(events.createdAt)).limit(1);
  if (!event) return { event: null, contestants: [], arenas: [], markets: [], proposals: [] };
  const [automation] = await predictionDb
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.eventId, event.id))
    .limit(1);
  return {
    event,
    automation: automation
      ? {
          ...automation,
          status: automationStatus(automation),
          leaseExpiresAt: automation.lastHeartbeatAt
            ? new Date(
                automation.lastHeartbeatAt.getTime() + AUTOMATION_LEASE_TIMEOUT_MS,
              ).toISOString()
            : null,
        }
      : null,
    contestants: await predictionDb
      .select()
      .from(contestants)
      .where(eq(contestants.eventId, event.id))
      .orderBy(asc(contestants.queuePosition)),
    arenas: await predictionDb
      .select()
      .from(arenas)
      .where(eq(arenas.eventId, event.id))
      .orderBy(desc(arenas.ordinal)),
    markets: await predictionDb
      .select()
      .from(markets)
      .where(eq(markets.eventId, event.id))
      .orderBy(desc(markets.createdAt)),
    proposals: await predictionDb
      .select()
      .from(ingestionProposals)
      .where(
        and(eq(ingestionProposals.eventId, event.id), eq(ingestionProposals.status, "pending")),
      )
      .orderBy(desc(ingestionProposals.createdAt)),
  };
}
