/** Fixed-size buffer of the newest items, for the debug overlay's recent-events list. */
export declare class RingBuffer<T> {
    readonly capacity: number;
    private items;
    private start;
    constructor(capacity: number);
    push(item: T): void;
    /** Oldest first. */
    toArray(): T[];
}
