import { rmSync } from "fs";

export default function globalSetup() {
  rmSync("./data/test.db", { force: true });
  rmSync("./data/test.db-wal", { force: true });
  rmSync("./data/test.db-shm", { force: true });
}
