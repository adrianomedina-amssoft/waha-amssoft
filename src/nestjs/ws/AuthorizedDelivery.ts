/** Serialized, bounded event delivery with current authorization. */
export class AuthorizedDelivery {
  private queue: string[] = [];
  private bytes = 0;
  private busy = false;
  private stopped = false;
  private interval: ReturnType<typeof setInterval>;
  constructor(
    private readonly authorize: () => Promise<boolean>,
    private readonly send: (data: string) => void,
    private readonly close: (reason: string) => void,
  ) {
    this.interval = setInterval(() => { void this.checkIdle(); }, 5_000);
    this.interval.unref?.();
  }
  enqueue(data: string) {
    if (this.stopped) return;
    const size = Buffer.byteLength(data);
    if (size > 1024 * 1024 || this.queue.length >= 16 || this.bytes + size > 4 * 1024 * 1024) {
      this.fail('Reconnect required');
      return;
    }
    this.queue.push(data);
    this.bytes += size;
    void this.drain();
  }
  dispose() {
    this.stopped = true;
    clearInterval(this.interval);
    this.queue = [];
    this.bytes = 0;
  }
  private fail(reason: string) {
    if (this.stopped) return;
    this.dispose();
    this.close(reason);
  }
  private async permitted(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        this.authorize(),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  private async checkIdle() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      if (!(await this.permitted())) this.fail('Authorization expired');
    } finally {
      this.busy = false;
      if (!this.stopped) void this.drain();
    }
  }
  private async drain() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopped) {
        const data = this.queue.shift();
        this.bytes -= Buffer.byteLength(data);
        if (!(await this.permitted())) {
          this.fail('Authorization expired');
          break;
        }
        if (!this.stopped) this.send(data);
      }
    } catch {
      this.fail('Delivery failed');
    } finally {
      this.busy = false;
    }
  }
}
