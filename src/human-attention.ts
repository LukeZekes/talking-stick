import type { RoomEvent } from "./types.js";

/** Console sessions share explicit acknowledgements for the same local human. */
export function humanAttentionIdentity(id: string): string {
  return id.replace(/:chat:[a-f0-9]{8}$/i, "");
}

export function isHumanDirected(event: RoomEvent, viewer?: string): boolean {
  if (event.event_type !== "message_sent") return false;
  const payload = event.payload as { recipients?: unknown; sent_to?: unknown } | null;
  const listed = payload?.recipients;
  const targets = event.to_agent_id ? [event.to_agent_id] : Array.isArray(listed) ? listed : [];
  return targets.some(target => typeof target === "string" && target.startsWith("human:") &&
    (!viewer || humanAttentionIdentity(target) === humanAttentionIdentity(viewer)));
}


export function isHumanAttentionMessage(event: RoomEvent, viewer: string): boolean {
  return isHumanDirected(event, viewer) &&
    humanAttentionIdentity(event.from_agent_id ?? "") !== humanAttentionIdentity(viewer);
}
