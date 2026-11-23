// Loopback stand-in for the Zoom Scribe Live endpoint. The real `ws` client dials
// it with the same protocols and headers the production socket factory uses.
const http = require("node:http");
const WebSocket = require("ws");

// Calls `run({ url, seen })` against a fresh server. `seen` records the upgrade
// headers, the negotiated protocol, every binary frame, and every JSON message.
// `onSession(ws, message, seen)` answers JSON messages. Setting `seen.reject` makes
// the next upgrade fail with that HTTP status and body.
async function withLiveServer(onSession, run) {
  const server = http.createServer((_req, res) => res.end());
  const wss = new WebSocket.Server({ noServer: true });
  const seen = { headers: null, protocol: null, frames: [], texts: [] };
  server.on("upgrade", (request, socket, head) => {
    if (seen.reject) {
      const body = seen.reject.body;
      socket.end(
        `HTTP/1.1 ${seen.reject.status} Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      );
      return;
    }
    seen.headers = request.headers;
    wss.handleUpgrade(request, socket, head, (ws) => {
      seen.protocol = ws.protocol;
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          seen.frames.push(Buffer.from(data));
          return;
        }
        const message = JSON.parse(data.toString());
        seen.texts.push(message);
        onSession(ws, message, seen);
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  try {
    await run({ url, seen });
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const createSocketFor = (url) => (_liveUrl, protocols, options) =>
  new WebSocket(url, protocols, options);

module.exports = { withLiveServer, createSocketFor };
