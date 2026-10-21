/**
 * Test-only stand-in for the module Worker, shared by the suites that drive a
 * worker connection (render client, PNG export, the connection itself). It
 * records every posted message and exposes the handlers a connection installs,
 * so a test can play the worker's side synchronously: no real Worker, WASM,
 * global patching or module resets. Hand it in through a `workerFactory`.
 */
export class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: unknown[] = []
  terminated = false

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a worker → main-thread message. */
  send(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  /** Fire `onerror`, as a top-level throw in the worker would. */
  fail(message: string): { defaultPrevented: boolean } {
    const event = {
      message,
      defaultPrevented: false,
      preventDefault(): void {
        event.defaultPrevented = true
      },
    }
    this.onerror?.(event as unknown as ErrorEvent)
    return event
  }

  /** This fake as the `Worker` a `workerFactory` returns. */
  asWorker(): Worker {
    return this as unknown as Worker
  }
}
