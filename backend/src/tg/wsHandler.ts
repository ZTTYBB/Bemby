import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../middleware/auth";
import {
  getLiveClient,
  subscribeToMessages,
  subscribeToDialogs,
  syncMessagesInBackground,
} from "./liveClient";

// How often (ms) to poll for new messages in the active chat as a GramJS event fallback
const SYNC_INTERVAL_MS = 4_000;

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const token = url.searchParams.get("token") ?? "";
    const accountId = Number(url.searchParams.get("accountId") ?? "0");
    try {
      jwt.verify(token, getJwtSecret());
    } catch {
      ws.close(1008, "Unauthorised");
      return;
    }

    if (!accountId) {
      ws.close(1008, "Missing accountId");
      return;
    }

    try {
      await getLiveClient(accountId);
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "error", error: err.message }));
      ws.close();
      return;
    }

    const unsubscribeMsgs = subscribeToMessages(accountId, (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "message", ...msg }));
      }
    });

    const unsubscribeDialogs = subscribeToDialogs(accountId, (dialogs) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dialogs", dialogs }));
      }
    });

    // Track which chat the frontend currently has open
    let activeChatId: string | null = null;

    // Periodic sync -- fallback for when GramJS NewMessage events don't fire
    const syncInterval = setInterval(() => {
      if (activeChatId && ws.readyState === WebSocket.OPEN) {
        syncMessagesInBackground(accountId, activeChatId).catch(() => {});
      }
    }, SYNC_INTERVAL_MS);

    ws.on("message", (rawData: Buffer) => {
      try {
        const data = JSON.parse(rawData.toString()) as {
          type: string;
          chatId?: string;
        };
        if (data.type === "activateChat" && typeof data.chatId === "string") {
          activeChatId = data.chatId;
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    // Native ping/pong keepalive -- terminate if the client stops responding
    let isAlive = true;
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, 25_000);

    ws.on("pong", () => {
      isAlive = true;
    });

    const cleanup = () => {
      clearInterval(pingInterval);
      clearInterval(syncInterval);
      unsubscribeMsgs();
      unsubscribeDialogs();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
