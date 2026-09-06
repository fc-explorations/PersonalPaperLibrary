import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { FileStorage } from "./services/storage.js";

const storage = new FileStorage();
storage.cleanupStaging();

serve({ fetch: createApp().fetch, hostname: "127.0.0.1", port: Number(process.env.PORT || 3000) }, (info) => {
  console.log(`Personal arXiv Paper Library running at http://${info.address}:${info.port}`);
});
