import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "./server.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
    server = undefined;
  });
});

async function listen(): Promise<string> {
  server = createApp();
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("api scaffold", () => {
  it("returns health", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; name: string };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("online-radio-player");
  });

  it("returns 404 for unknown routes", async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/nope`);
    expect(response.status).toBe(404);
  });
});
