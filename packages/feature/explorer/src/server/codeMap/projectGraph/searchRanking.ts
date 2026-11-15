/** Keep only the best K candidates while scanning the complete index.
 * compare(a, b) < 0 means a ranks ahead of b; the heap root is the worst retained item. */
export class SearchTopK<T> {
  private readonly heap: T[] = [];

  constructor(private readonly limit: number, private readonly compare: (a: T, b: T) => number) {}

  add(value: T): void {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(value);
      let child = this.heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >>> 1;
        if (this.compare(this.heap[child], this.heap[parent]) <= 0) break;
        [this.heap[child], this.heap[parent]] = [this.heap[parent], this.heap[child]];
        child = parent;
      }
      return;
    }
    if (this.compare(value, this.heap[0]) >= 0) return;
    this.heap[0] = value;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const worse = right < this.heap.length && this.compare(this.heap[right], this.heap[left]) > 0 ? right : left;
      if (this.compare(this.heap[worse], this.heap[parent]) <= 0) break;
      [this.heap[parent], this.heap[worse]] = [this.heap[worse], this.heap[parent]];
      parent = worse;
    }
  }

  sorted(): T[] { return this.heap.slice().sort(this.compare); }
}
