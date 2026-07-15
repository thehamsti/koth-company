import payload from "payload";
import configPromise from "./payload-migrate.config";

process.env.PAYLOAD_MIGRATING = "true";
await payload.init({ config: await configPromise, disableOnInit: true });
try {
  await payload.db.migrate();
} finally {
  await payload.destroy();
}
