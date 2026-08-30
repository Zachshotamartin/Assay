export interface Clock {
  readonly wallTime: () => string;
  readonly monotonicMilliseconds: () => number;
}

export interface IdSource<T extends string = string> {
  readonly next: () => T;
}

export interface SeedSource {
  readonly derive: (label: string) => string;
}
