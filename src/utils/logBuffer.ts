export class LogBuffer<T extends { payload: string }> {
  private rows: Array<{ value: T; bytes: number } | undefined>;
  private head = 0;
  private size = 0;
  bytes = 0;
  evicted = 0;
  truncated = 0;
  private encoder = new TextEncoder();
  constructor(readonly capacity = 2000, readonly byteLimit = 2 * 1024 * 1024, readonly lineLimit = 32 * 1024) {
    this.rows = new Array(capacity);
  }
  append(value: T): T {
    let encoded = this.encoder.encode(value.payload);
    if (encoded.length > this.lineLimit) {
      const suffix = "…[超长日志已截断]";
      value = { ...value, payload: new TextDecoder().decode(encoded.subarray(0, this.lineLimit - this.encoder.encode(suffix).length - 3)) + suffix };
      encoded = this.encoder.encode(value.payload);
      this.truncated++;
    }
    while (this.size && (this.size === this.capacity || this.bytes + encoded.length > this.byteLimit)) {
      this.bytes -= this.rows[this.head]!.bytes;
      this.rows[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size--;
      this.evicted++;
    }
    this.rows[(this.head + this.size) % this.capacity] = { value, bytes: encoded.length };
    this.size++;
    this.bytes += encoded.length;
    return value;
  }
  snapshot(): T[] {
    return Array.from({ length: this.size }, (_, index) => this.rows[(this.head + index) % this.capacity]!.value);
  }
  clear() {
    this.rows = new Array(this.capacity);
    this.head = this.size = this.bytes = this.evicted = this.truncated = 0;
  }
}
