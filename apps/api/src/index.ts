import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";

const server = createApp();

server.listen(port, host, () => {
  console.log(`radio-api listening on http://${host}:${port}`);
});

function shutdown(signal: string): void {
  console.log(`radio-api received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error("radio-api shutdown error", error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
