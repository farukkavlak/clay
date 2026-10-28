/** First in, first out. Taking the next item moves none of the rest, as `Array.shift` does on a long array. */
export class Queue<T> {
  private items: T[];
  private head = 0;

  constructor(items: T[] = []) {
    this.items = [...items];
  }

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head === this.items.length) return undefined;

    const item = this.items[this.head];
    this.head += 1;
    // Drops the taken half, so a queue that never empties does not keep every item it ever held.
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
}
