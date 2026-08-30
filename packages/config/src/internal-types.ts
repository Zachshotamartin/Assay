import type { AssayConfig } from "./types.js";

export type MutableAssayConfig = {
  -readonly [Key in keyof AssayConfig]: AssayConfig[Key] extends object
    ? { -readonly [Nested in keyof AssayConfig[Key]]: AssayConfig[Key][Nested] }
    : AssayConfig[Key];
};
