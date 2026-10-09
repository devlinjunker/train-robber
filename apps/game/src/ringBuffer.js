/** Fixed-size buffer of the newest items, for the debug overlay's recent-events list. */
export class RingBuffer {
    capacity;
    items = [];
    start = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    push(item) {
        if (this.items.length < this.capacity)
            this.items.push(item);
        else {
            this.items[this.start] = item;
            this.start = (this.start + 1) % this.capacity;
        }
    }
    /** Oldest first. */
    toArray() {
        return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
    }
}
