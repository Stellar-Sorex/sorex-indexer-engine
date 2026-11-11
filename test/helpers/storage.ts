import { createStorage, type KyselyStorage } from "../../src/storage/index.js";

export async function createTestStorage(): Promise<KyselyStorage> {
  const storage = createStorage({ driver: "sqlite", url: "sqlite::memory:" });
  await storage.migrate();
  return storage;
}
