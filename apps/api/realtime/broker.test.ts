import { describe, expect, test } from "bun:test";
import { RealtimeBroker, RealtimeCapacityError } from "./broker";

describe("RealtimeBroker", () => {
  test("delivers events only to matching topics", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const publicSubscription = broker.subscribe(["public"]);
    const accountSubscription = broker.subscribe(["account:user-1"]);

    broker.publish(["account:user-1"], "account.updated", {
      eventId: null,
      portfolio: null,
      sharesByOutcome: {},
    });

    const accountEvent = await accountSubscription.next();
    expect(accountEvent.done).toBe(false);
    expect(accountEvent.value?.name).toBe("account.updated");
    expect(broker.subscriberCount).toBe(2);
    publicSubscription.close();
    accountSubscription.close();
  });

  test("coalesces queued events by key", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const subscription = broker.subscribe(["public"]);
    broker.publish(["public"], "stream.ready", { epoch: "old" }, "ready");
    broker.publish(["public"], "stream.ready", { epoch: "new" }, "ready");

    const event = await subscription.next();
    expect(event.value?.payload).toEqual({ epoch: "new" });
    subscription.close();
  });

  test("disconnects a subscriber whose bounded queue overflows", async () => {
    const broker = new RealtimeBroker({ epoch: "test", maxQueuedEvents: 2 });
    const subscription = broker.subscribe(["public"]);
    broker.publish(["public"], "stream.ready", { epoch: "1" }, "one");
    broker.publish(["public"], "stream.ready", { epoch: "2" }, "two");
    broker.publish(["public"], "stream.ready", { epoch: "3" }, "three");

    expect((await subscription.next()).done).toBe(true);
    expect(broker.subscriberCount).toBe(0);
  });

  test("indexes subscriptions by topic and removes every index entry", () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const first = broker.subscribe(["public", "account:user-1"]);
    const second = broker.subscribe(["account:user-2"]);

    expect(broker.subscriberCountForTopic("public")).toBe(1);
    expect(broker.subscriberCountForTopic("account:user-1")).toBe(1);
    expect(broker.subscriberCountForTopic("account:user-2")).toBe(1);

    first.close();
    expect(broker.subscriberCountForTopic("public")).toBe(0);
    expect(broker.subscriberCountForTopic("account:user-1")).toBe(0);
    expect(broker.subscriberCountForTopic("account:user-2")).toBe(1);
    second.close();
  });

  test("rejects subscriptions above the configured global capacity", () => {
    const broker = new RealtimeBroker({ epoch: "test", maxSubscribers: 1 });
    broker.subscribe(["public"]);

    expect(() => broker.subscribe(["operator"])).toThrow(RealtimeCapacityError);
    try {
      broker.subscribe(["operator"]);
    } catch (error) {
      expect(error).toBeInstanceOf(RealtimeCapacityError);
      expect((error as RealtimeCapacityError).code).toBe("REALTIME_CAPACITY_EXCEEDED");
      expect((error as RealtimeCapacityError).status).toBe(503);
      expect((error as RealtimeCapacityError).maxSubscribers).toBe(1);
    }
    broker.close();
  });

  test("close releases all subscribers and pending reads", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const publicSubscription = broker.subscribe(["public"]);
    const operatorSubscription = broker.subscribe(["operator"]);
    const pendingRead = publicSubscription.next();

    broker.close();

    expect((await pendingRead).done).toBe(true);
    expect((await operatorSubscription.next()).done).toBe(true);
    expect(broker.subscriberCount).toBe(0);
    expect(() => broker.subscribe(["public"])).toThrow(
      "Realtime subscriptions are unavailable while the service is shutting down.",
    );
  });
});
