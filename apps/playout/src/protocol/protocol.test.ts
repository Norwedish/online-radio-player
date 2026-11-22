import { afterEach, describe, expect, it } from "vitest";
import { connect, type Socket } from "node:net";
import { ProtocolServer } from "./server.js";

let server: ProtocolServer | null = null;
let sock: Socket | null = null;

afterEach(async () => {
  sock?.destroy();
  await server?.close();
});

function client(
  port: number,
): Promise<{
  send: (o: unknown) => void;
  raw: (s: string) => void;
  next: (pred?: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    sock = s;
    const msgs: Record<string, unknown>[] = [];
    const waiters: {
      pred: (m: Record<string, unknown>) => boolean;
      resolve: (m: Record<string, unknown>) => void;
    }[] = [];
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        const w = waiters.findIndex((x) => x.pred(m));
        if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
        else msgs.push(m);
      }
    });
    s.on("connect", () =>
      resolve({
        send: (o) => s.write(`${JSON.stringify(o)}\n`),
        raw: (t) => s.write(t),
        next: (pred = () => true) =>
          new Promise((r) => {
            const idx = msgs.findIndex(pred);
            if (idx >= 0) r(msgs.splice(idx, 1)[0]!);
            else waiters.push({ pred, resolve: r });
          }),
      }),
    );
  });
}

describe("worker protocol (M4.7)", () => {
  it("round-trips commands, rejects malformed JSON and invalid payloads, broadcasts events", async () => {
    const calls: string[] = [];
    server = new ProtocolServer(
      (type, payload) => {
        calls.push(type);
        if (type === "seek") return { position: (payload as { position: number }).position };
        return { ok: true };
      },
      { heartbeatMs: 50 },
    );
    await server.listen({ port: 0 });
    const c = await client(server.port);
    expect((await c.next((m) => m.event === "hello")).type).toBe("event");
    c.send({ v: 1, id: "a", type: "skip" });
    expect(await c.next((m) => m.id === "a")).toMatchObject({ ok: true, payload: { ok: true } });
    c.send({ v: 1, id: "b", type: "seek", payload: { position: 12.5 } });
    expect(await c.next((m) => m.id === "b")).toMatchObject({
      ok: true,
      payload: { position: 12.5 },
    });
    c.raw("{not json}\n");
    expect(await c.next((m) => m.type === "error")).toMatchObject({ error: "malformed JSON" });
    c.send({ v: 1, id: "c", type: "seek", payload: { position: -1 } });
    expect(await c.next((m) => m.id === "c")).toMatchObject({ ok: false });
    c.send({ v: 1, id: "d", type: "self_destruct" });
    expect(await c.next((m) => m.id === "d")).toMatchObject({
      ok: false,
      error: "unknown command self_destruct",
    });
    c.send({ v: 2, id: "e", type: "skip" });
    expect((await c.next((m) => m.type === "error")).error).toMatch(/invalid envelope/);
    expect(await c.next((m) => m.event === "heartbeat")).toBeTruthy();
    server.broadcast("now_playing", { title: "x" });
    expect(await c.next((m) => m.event === "now_playing")).toMatchObject({
      payload: { title: "x" },
    });
    expect(calls).toEqual(["skip", "seek"]);
  });

  it("serializes commands so rapid skips never interleave", async () => {
    const order: string[] = [];
    server = new ProtocolServer(async (type) => {
      order.push(`start:${type}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${type}`);
    });
    await server.listen({ port: 0 });
    const c = await client(server.port);
    for (let i = 0; i < 5; i += 1) c.send({ v: 1, id: `s${i}`, type: "skip" });
    await c.next((m) => m.id === "s4");
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.startsWith("start")).toBe(true);
  });

  it("requires the token when configured", async () => {
    server = new ProtocolServer(() => ({}), { token: "secret" });
    await server.listen({ port: 0 });
    const c = await client(server.port);
    c.send({ v: 1, id: "x", type: "auth", payload: { token: "wrong" } });
    expect(await c.next((m) => m.id === "x")).toMatchObject({ ok: false, error: "unauthorized" });
    const c2 = await client(server.port);
    c2.send({ v: 1, id: "y", type: "auth", payload: { token: "secret" } });
    expect(await c2.next((m) => m.id === "y")).toMatchObject({ ok: true });
  });
});
