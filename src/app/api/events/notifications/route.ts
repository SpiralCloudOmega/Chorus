// src/app/api/events/notifications/route.ts
// User-scoped SSE endpoint for real-time notification delivery
// Auth via cookie (EventSource automatically sends cookies)

import { getAuthContext } from "@/lib/auth";
import { eventBus } from "@/lib/event-bus";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await getAuthContext(request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userKey = `${auth.type}:${auth.actorUuid}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
        }
      };

      // Send initial connection confirmation
      send(": connected\n\n");

      // Subscribe to notification events for this user
      const handler = (event: Record<string, unknown>) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      eventBus.on(`notification:${userKey}`, handler);

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        send(": heartbeat\n\n");
      }, 30_000);

      // Cleanup on abort (client disconnect)
      request.signal.addEventListener("abort", () => {
        eventBus.off(`notification:${userKey}`, handler);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
