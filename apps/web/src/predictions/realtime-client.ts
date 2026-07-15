type RealtimeEnvelope<T> = {
  revision: string;
  payload: T;
};

export type RealtimeWatermarks = {
  epoch: string | null;
  sequence: number;
  eventsAtSequence: Set<string>;
};

export function createRealtimeWatermarks(): RealtimeWatermarks {
  return { epoch: null, sequence: -1, eventsAtSequence: new Set() };
}

export function realtimePayload<T>(
  eventName: string,
  event: MessageEvent<string>,
  watermarks: RealtimeWatermarks,
): T | null {
  try {
    const envelope = JSON.parse(event.data) as RealtimeEnvelope<T>;
    const separator = envelope.revision.lastIndexOf(":");
    const epoch = envelope.revision.slice(0, separator);
    const sequence = Number(envelope.revision.slice(separator + 1));
    if (!epoch || !Number.isSafeInteger(sequence) || sequence < 0) return null;
    if (watermarks.epoch !== epoch) {
      watermarks.epoch = epoch;
      watermarks.sequence = -1;
      watermarks.eventsAtSequence.clear();
    }
    if (sequence < watermarks.sequence) return null;
    if (sequence === watermarks.sequence) {
      if (watermarks.eventsAtSequence.has(eventName)) return null;
      watermarks.eventsAtSequence.add(eventName);
    } else {
      watermarks.sequence = sequence;
      watermarks.eventsAtSequence.clear();
      watermarks.eventsAtSequence.add(eventName);
    }
    return envelope.payload ?? null;
  } catch {
    return null;
  }
}
