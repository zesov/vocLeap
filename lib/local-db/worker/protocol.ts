import type { SqlStep } from "../executor";

export type EnginePreference = "auto" | "opfs" | "idb";
export type LocalDbMode = "opfs" | "idb" | "online";

export interface InitRequest {
  engine: EnginePreference;
  userId: number;
  fileName: string;
}

export type WorkerRequest =
  | { type: "init"; id: number; request: InitRequest }
  | { type: "all"; id: number; sql: string; params?: unknown[] }
  | { type: "run"; id: number; sql: string; params?: unknown[] }
  | { type: "exec"; id: number; sql: string }
  | { type: "batch"; id: number; statements: SqlStep[] }
  | { type: "close"; id: number };

export type WorkerEvent =
  | { type: "ready"; id: number; mode: Exclude<LocalDbMode, "online">; engine: string }
  | { type: "db-busy"; id: number; message: string }
  | { type: "init-error"; id: number; message: string }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStep(value: unknown): value is SqlStep {
  return (
    isRecord(value) &&
    typeof value.sql === "string" &&
    (value.params === undefined || Array.isArray(value.params))
  );
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "number" || !Number.isInteger(value.id)) return false;

  switch (value.type) {
    case "init": {
      const request = value.request;
      return (
        isRecord(request) &&
        (request.engine === "auto" ||
          request.engine === "opfs" ||
          request.engine === "idb") &&
        typeof request.userId === "number" &&
        typeof request.fileName === "string"
      );
    }
    case "all":
    case "run":
      return (
        typeof value.sql === "string" &&
        (value.params === undefined || Array.isArray(value.params))
      );
    case "exec":
      return typeof value.sql === "string";
    case "batch":
      return Array.isArray(value.statements) && value.statements.every(isStep);
    case "close":
      return true;
    default:
      return false;
  }
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A request without its id (the client assigns one). */
export type WorkerCallMessage = DistributiveOmit<WorkerRequest, "id">;
