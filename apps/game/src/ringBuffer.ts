/** Fixed-size buffer of the newest items, for the debug overlay's recent-events list. */
export class RingBuffer<T> {
  private items: T[] = [];
  private start = 0;
  constructor(readonly capacity: number) {}

  push(item: T): void {
    if (this.items.length < this.capacity) this.items.push(item);
    else { this.items[this.start] = item; this.start = (this.start + 1) % this.capacity; }
  }

  /** Oldest first. */
  toArray(): T[] {
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }
}
