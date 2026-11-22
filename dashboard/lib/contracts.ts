import type { EventEnvelope } from "./generated";
export type * from "./generated";
export type { JsonValue as Json } from "./generated";

export function isEnvelope(value: unknown): value is EventEnvelope {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<EventEnvelope>;
  return (
    Number.isSafeInteger(frame.sequence) &&
    typeof frame.timestamp_ms === "number" &&
    typeof frame.session_id === "string" &&
    !!frame.event &&
    typeof frame.event.type === "string"
  );
}
