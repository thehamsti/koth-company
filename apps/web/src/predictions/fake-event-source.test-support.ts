export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  emit(name: string, payload: unknown, revision = "test:1"): void {
    this.dispatchEvent(
      new MessageEvent(name, {
        data: JSON.stringify({
          revision,
          emittedAt: "2026-07-14T12:00:00.000Z",
          payload,
        }),
      }),
    );
  }

  close(): void {
    this.closed = true;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}
