export class TokenBucket {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private minIntervalMs: number) {}

  take(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
    });
    return this.chain;
  }
}
