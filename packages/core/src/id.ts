import { randomBytes } from "node:crypto";
/** Time-sortable unique id: 10 chars base36 time + 12 hex random. */
export function newId(): string {
  return Date.now().toString(36).padStart(10, "0") + randomBytes(6).toString("hex");
}
