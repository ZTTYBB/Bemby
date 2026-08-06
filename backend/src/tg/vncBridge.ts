import net from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { claimManualTicket, touchManualSession } from "../jobs/manualBrowser";

/**
 * Carries the manual browser's screen to the panel: a raw RFB stream on one side, a
 * WebSocket the viewer speaks on the other, and nothing between them but a pipe.
 *
 * Written here rather than run as websockify, which would mean Python in the image for what
 * is a socket copied in both directions. x11vnc listens on the loopback only and has no
 * authentication of its own, so this bridge is the thing standing in front of it: no ticket,
 * no connection, and the port is unreachable from outside the container regardless.
 *
 * The ticket rides in the address rather than a first message, unlike the panel's own socket:
 * the viewer starts the RFB handshake the moment it connects and has nowhere to put an auth
 * frame. It is single-use and lives for a minute, so a copy of the address is worth nothing
 * by the time it could be read out of a log.
 */
export function createVncWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const session = claimManualTicket(url.searchParams.get("ticket") ?? undefined);
    if (!session) {
      ws.close(1008, "Unauthorised");
      return;
    }

    const socket = net.connect({ port: session.vncPort, host: "127.0.0.1" });
    let closed = false;
    const shutdown = (): void => {
      if (closed) return;
      closed = true;
      socket.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };

    socket.on("connect", () => {
      // The viewer only sees a blank canvas otherwise: RFB is binary end to end
      ws.binaryType = "nodebuffer";
    });
    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    socket.on("error", shutdown);
    socket.on("close", shutdown);

    ws.on("message", (data: Buffer) => {
      // Any traffic means somebody is watching, which is what holds the idle timer off
      touchManualSession(session.id);
      socket.write(data);
    });
    ws.on("error", shutdown);
    ws.on("close", shutdown);
  });

  return wss;
}
