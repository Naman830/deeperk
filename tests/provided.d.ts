import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** Socket-server bootId captured at suite start; specs compare against it. */
    bootId: string;
  }
}
