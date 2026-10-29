// Minimal stand-in for the app's control server: listens where the patched app would, logs requests.
const fs = require("fs"), path = require("path"), net = require("net");
const [mainJs, dir] = process.argv.slice(2);
const src = fs.readFileSync(mainJs, "utf8");
eval(src.slice(src.indexOf("\n") + 1, src.indexOf("var cxe=")) + ";globalThis.__s=__cbSock;");
const sockPath = path.join(dir, "cardboard.sock");
fs.writeFileSync(path.join(dir, "cardboard.sock.token"), "testtoken\n");
const srv = net.createServer((c) => {
  c.setEncoding("utf8");
  c.on("data", (d) => {
    for (const line of d.split("\n").filter(Boolean)) {
      const m = JSON.parse(line);
      console.log("server got:", m.method, JSON.stringify(m.params).slice(0, 80));
      c.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "fake server: " + m.method } }) + "\n");
    }
  });
}).listen(globalThis.__s(sockPath), () => console.log("listening", globalThis.__s(sockPath)));
setTimeout(() => { srv.close(); process.exit(0); }, 8000);
