// server-node's WebSocket client transport, without its root entry (which imports node:http and can't go in a
// browser bundle). server-node exports no `./transport` subpath, so the file is imported directly (request to
// hosts-plugins in the web-demo notes: a `./transport` export).
export { webSocketTransport } from "../../../packages/server-node/src/transport.ts";
