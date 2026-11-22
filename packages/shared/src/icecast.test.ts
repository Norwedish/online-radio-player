import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseStationConfig } from "./config.js";
import { parseIcecastStatus, renderIcecastXml } from "./icecast.js";

const example = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../config/station.example.json", import.meta.url)),
    "utf8",
  ),
);
const parsed = parseStationConfig(example);
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const config = parsed.config;
const paths = { basedir: "/var/lib/ic", logdir: "/var/log/ic", webroot: "/w", adminroot: "/a" };

describe("Icecast config (M5.3 / M13.4)", () => {
  it("renders every mount, the live ingest mount, escaped secrets and fallbacks", () => {
    const xml = renderIcecastXml(
      { ...config, station: { ...config.station, name: 'Rock & "Roll" FM' } },
      { sourcePassword: "s<>&", adminPassword: "adm", livePassword: "live-pw" },
      paths,
      {
        clients: 750,
        corsOrigin: "https://radio.example.org",
        changeOwner: { user: "icecast2", group: "icecast" },
      },
    );
    for (const m of config.icecast.mounts)
      expect(xml).toContain(`<mount-name>/${m.name}</mount-name>`);
    expect(xml).toContain("<mount-name>/live</mount-name>");
    expect(xml).toContain("<source-password>s&lt;&gt;&amp;</source-password>");
    expect(xml).toContain("Rock &amp; &quot;Roll&quot; FM");
    expect(xml).toContain("<clients>750</clients>");
    expect(xml).toContain("<user>icecast2</user>");
    expect(xml).toContain("https://radio.example.org");
    expect(xml).toContain(`<bind-address>127.0.0.1</bind-address>`);
    // A secondary MP3 mount falls back to the primary MP3 mount.
    const primary = config.icecast.mounts.find((m) => m.primary)!;
    expect(xml).toContain(`<fallback-mount>/${primary.name}</fallback-mount>`);
    expect(xml.trim().endsWith("</icecast>")).toBe(true);
  });

  it("parses status-json with one or many sources", () => {
    const one = parseIcecastStatus({
      icestats: {
        source: {
          listenurl: "http://127.0.0.1:8000/hq.mp3",
          listeners: 3,
          server_type: "audio/mpeg",
          title: "A - B",
        },
      },
    });
    expect(one).toEqual([
      { mount: "hq.mp3", listeners: 3, contentType: "audio/mpeg", title: "A - B" },
    ]);
    const many = parseIcecastStatus({
      icestats: {
        source: [{ listenurl: "http://h/a.aac", listeners: "2" }, { listenurl: "http://h/b.ogg" }],
      },
    });
    expect(many.map((m) => [m.mount, m.listeners])).toEqual([
      ["a.aac", 2],
      ["b.ogg", 0],
    ]);
    expect(parseIcecastStatus({ icestats: {} })).toEqual([]);
    expect(parseIcecastStatus(null)).toEqual([]);
  });
});
