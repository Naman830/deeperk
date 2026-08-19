import "../../src/env";
import { cleanupAll } from "../../src/cleanup";

export default async function globalTeardown(): Promise<void> {
  await cleanupAll();
}
