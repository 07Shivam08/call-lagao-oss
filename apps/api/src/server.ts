import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { internalSecretProblem, readEnv } from "./env.js";
import { noopAnalyzer, openaiAnalyzer } from "./services/analysis.js";
import { livekitGateway } from "./services/voice.js";

const env = readEnv();
const secretProblem = internalSecretProblem(env.internalSecret);
if (secretProblem && (env.production || !env.internalSecret)) {
  console.error(secretProblem);
  process.exit(1);
}
if (secretProblem) console.warn(`WARNING: ${secretProblem} (fatal when NODE_ENV=production)`);

const db = await openDb(env.databaseUrl, env.dataDir);
const voice = livekitGateway(env);
const app = await buildApp(
  {
    db,
    env,
    voice,
    analyzer: env.openaiApiKey ? openaiAnalyzer(env.openaiApiKey) : noopAnalyzer,
    webhooks: { allowPrivateUrls: env.allowPrivateUrls },
    background: (p) => void p.catch((e) => app.log.error(e, "background task failed")),
  },
  { logger: true },
);

await app.listen({ port: env.port, host: "0.0.0.0" });
app.log.info(`Call Lagao API on :${env.port} · db=${db.kind} · livekit=${voice.configured ? "on" : "off"} · analysis=${env.openaiApiKey ? "on" : "off"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
