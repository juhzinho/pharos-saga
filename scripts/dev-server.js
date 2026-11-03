// Local stand-in for Vercel: serves public/ and routes /api/plan to the same handler.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import plan from "../api/plan.js";

execFileSync(process.execPath, [fileURLToPath(new URL("./build.js", import.meta.url))], { stdio: "inherit" });

const PORT = Number(process.env.PORT ?? 3070);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css" };

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/plan") return plan(req, res);
    const file = normalize(pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
    if (file.startsWith("..")) return res.writeHead(403).end();
    try {
      const body = await readFile(join(ROOT, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
