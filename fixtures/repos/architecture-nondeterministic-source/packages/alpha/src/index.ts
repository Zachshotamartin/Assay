export function uncontrolledSources(): void {
  Date.now();
  Math.random();
  crypto.randomUUID();
  setTimeout(() => undefined, 1);
}
