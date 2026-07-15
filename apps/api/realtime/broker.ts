import type {
  RealtimeEvent,
  RealtimeEventName,
  RealtimePayloads,
} from "../../../packages/contracts/src";

export type RealtimeTopic = "public" | "operator" | "automation" | `account:${string}`;

type QueuedEvent = {
  bytes: number;
  coalesceKey: string;
  event: RealtimeEvent;
};

type PendingRead = (value: IteratorResult<RealtimeEvent>) => void;

export type RealtimeCheckpoint = {
  epoch: string;
  revision: string;
  emittedAt: string;
};

export type RealtimeBrokerOptions = {
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
  maxSubscribers?: number;
  epoch?: string;
};

export class RealtimeCapacityError extends Error {
  readonly code = "REALTIME_CAPACITY_EXCEEDED";
  readonly status = 503;

  constructor(readonly maxSubscribers: number) {
    super(
      `Realtime subscriber capacity (${maxSubscribers}) has been reached. Retry shortly or increase REALTIME_MAX_SUBSCRIBERS.`,
    );
    this.name = "RealtimeCapacityError";
  }
}

export class RealtimeBrokerClosedError extends Error {
  readonly code = "REALTIME_BROKER_CLOSED";
  readonly status = 503;

  constructor() {
    super("Realtime subscriptions are unavailable while the service is shutting down.");
    this.name = "RealtimeBrokerClosedError";
  }
}

function configuredMaxSubscribers(): number {
  const configured = process.env.REALTIME_MAX_SUBSCRIBERS;
  if (configured === undefined) return 5_000;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("REALTIME_MAX_SUBSCRIBERS must be a positive integer.");
  }
  return parsed;
}

export class RealtimeSubscription {
  readonly #broker: RealtimeBroker;
  readonly #topics: ReadonlySet<RealtimeTopic>;
  #queue: QueuedEvent[] = [];
  #queuedBytes = 0;
  #pendingRead: PendingRead | null = null;
  #closed = false;

  constructor(broker: RealtimeBroker, topics: Iterable<RealtimeTopic>) {
    this.#broker = broker;
    this.#topics = new Set(topics);
  }

  get topics(): ReadonlySet<RealtimeTopic> {
    return this.#topics;
  }

  enqueue(entry: QueuedEvent, limits: { events: number; bytes: number }): void {
    if (this.#closed) return;
    if (this.#pendingRead) {
      const resolve = this.#pendingRead;
      this.#pendingRead = null;
      resolve({ done: false, value: entry.event });
      return;
    }

    const existingIndex = this.#queue.findIndex(
      (queued) => queued.coalesceKey === entry.coalesceKey,
    );
    if (existingIndex >= 0) {
      this.#queuedBytes -= this.#queue[existingIndex]?.bytes ?? 0;
      this.#queue.splice(existingIndex, 1);
    }
    this.#queue.push(entry);
    this.#queuedBytes += entry.bytes;
    if (this.#queue.length > limits.events || this.#queuedBytes > limits.bytes) this.close();
  }

  async next(): Promise<IteratorResult<RealtimeEvent>> {
    if (this.#closed) return { done: true, value: undefined };
    const entry = this.#queue.shift();
    if (entry) {
      this.#queuedBytes -= entry.bytes;
      return { done: false, value: entry.event };
    }
    return new Promise((resolve) => {
      this.#pendingRead = resolve;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#broker.remove(this);
    this.#pendingRead?.({ done: true, value: undefined });
    this.#pendingRead = null;
  }
}

export class RealtimeBroker {
  readonly epoch: string;
  readonly #maxQueuedEvents: number;
  readonly #maxQueuedBytes: number;
  readonly #maxSubscribers: number;
  readonly #subscriptions = new Set<RealtimeSubscription>();
  readonly #subscriptionsByTopic = new Map<RealtimeTopic, Set<RealtimeSubscription>>();
  #sequence = 0;
  #closed = false;

  constructor(options: RealtimeBrokerOptions = {}) {
    this.epoch = options.epoch ?? crypto.randomUUID();
    this.#maxQueuedEvents = options.maxQueuedEvents ?? 64;
    this.#maxQueuedBytes = options.maxQueuedBytes ?? 256 * 1024;
    this.#maxSubscribers = options.maxSubscribers ?? configuredMaxSubscribers();
  }

  get subscriberCount(): number {
    return this.#subscriptions.size;
  }

  subscriberCountForTopic(topic: RealtimeTopic): number {
    return this.#subscriptionsByTopic.get(topic)?.size ?? 0;
  }

  subscribe(topics: Iterable<RealtimeTopic>): RealtimeSubscription {
    if (this.#closed) throw new RealtimeBrokerClosedError();
    if (this.#subscriptions.size >= this.#maxSubscribers) {
      throw new RealtimeCapacityError(this.#maxSubscribers);
    }

    const subscription = new RealtimeSubscription(this, topics);
    this.#subscriptions.add(subscription);
    for (const topic of subscription.topics) {
      const subscriptions = this.#subscriptionsByTopic.get(topic) ?? new Set();
      subscriptions.add(subscription);
      this.#subscriptionsByTopic.set(topic, subscriptions);
    }
    return subscription;
  }

  checkpoint(): RealtimeCheckpoint {
    this.#sequence += 1;
    return {
      epoch: this.epoch,
      revision: `${this.epoch}:${this.#sequence}`,
      emittedAt: new Date().toISOString(),
    };
  }

  eventAt<Name extends RealtimeEventName>(
    checkpoint: RealtimeCheckpoint,
    name: Name,
    payload: RealtimePayloads[Name],
  ): RealtimeEvent<Name> {
    if (checkpoint.epoch !== this.epoch) {
      throw new Error("Realtime checkpoint belongs to another broker epoch.");
    }
    return {
      name,
      revision: checkpoint.revision,
      emittedAt: checkpoint.emittedAt,
      payload,
    };
  }

  event<Name extends RealtimeEventName>(
    name: Name,
    payload: RealtimePayloads[Name],
  ): RealtimeEvent<Name> {
    return this.eventAt(this.checkpoint(), name, payload);
  }

  publish<Name extends RealtimeEventName>(
    topics: readonly RealtimeTopic[],
    name: Name,
    payload: RealtimePayloads[Name],
    coalesceKey: string = name,
  ): RealtimeEvent<Name> {
    const event = this.event(name, payload);
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    const entry = { bytes, coalesceKey, event };
    const recipients = new Set<RealtimeSubscription>();
    for (const topic of topics) {
      for (const subscription of this.#subscriptionsByTopic.get(topic) ?? []) {
        recipients.add(subscription);
      }
    }
    for (const subscription of recipients) {
      subscription.enqueue(entry, {
        events: this.#maxQueuedEvents,
        bytes: this.#maxQueuedBytes,
      });
    }
    return event;
  }

  remove(subscription: RealtimeSubscription): void {
    if (!this.#subscriptions.delete(subscription)) return;
    for (const topic of subscription.topics) {
      const subscriptions = this.#subscriptionsByTopic.get(topic);
      subscriptions?.delete(subscription);
      if (subscriptions?.size === 0) this.#subscriptionsByTopic.delete(topic);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions) subscription.close();
    this.#subscriptionsByTopic.clear();
  }
}
