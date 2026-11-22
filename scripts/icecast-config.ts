/**
 * `pnpm icecast:config [--out /etc/radio/icecast.xml]` — renders icecast.xml
 * from station.json + secrets (PLAN M5.3 / M13.4). Without --out it prints.
 */
import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { loadRuntimeConfig, renderIcecastXml, secret } from "../packages/shared/src/index.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const config = loadRuntimeConfig();
const source = secret(config.icecast.sourcePasswordEnv);
const admin = secret(config.icecast.adminPasswordEnv);
if (!source || !admin) {
  console.error(
    `${config.icecast.sourcePasswordEnv} and ${config.icecast.adminPasswordEnv} must be set (e.g. in /etc/radio/secrets.env)`,
  );
  process.exit(1);
}
const share = existsSync("/usr/share/icecast2") ? "/usr/share/icecast2" : "/usr/share/icecast";
const xml = renderIcecastXml(
  config,
  {
    sourcePassword: source,
    adminPassword: admin,
    livePassword: secret(config.icecast.livePasswordEnv),
  },
  {
    basedir: arg("basedir") ?? "/var/lib/radio-icecast",
    logdir: arg("logdir") ?? "/var/log/radio-icecast",
    webroot: `${share}/web`,
    adminroot: `${share}/admin`,
  },
  { hostname: config.station.domain, corsOrigin: process.env.PUBLIC_BASE_URL ?? "*" },
);
const out = arg("out");
if (out) {
  writeFileSync(out, xml);
  chmodSync(out, 0o640);
  console.log(
    `wrote ${out} (${config.icecast.mounts.length} mounts + ${config.icecast.liveMount})`,
  );
} else process.stdout.write(xml);
