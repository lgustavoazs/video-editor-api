import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, close } = await buildApp(cfg);

if (!cfg.adminKey) app.log.warn("ADMIN_KEY não definida (mínimo 16 caracteres): rotas de administração desativadas");

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "encerrando");
    // A Railway espera alguns segundos; um render em andamento vira "server_restarted" no próximo início.
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    close()
      .catch((err: unknown) => app.log.error({ err }, "erro ao encerrar"))
      .finally(() => process.exit(0));
  });
}

await app.listen({ port: cfg.port, host: cfg.host });
