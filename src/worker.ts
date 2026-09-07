import { Hono } from "hono";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface CloudflareBindings {
  ASSETS: AssetFetcher;
  DB: unknown;
  PAPER_PDFS: unknown;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PersonalPaperLibrary Cloudflare scaffold</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main class="shell">
      <section class="empty-state">
        <h1>PersonalPaperLibrary</h1>
        <p>The Cloudflare Worker scaffold is running.</p>
        <p><a class="button" href="/api/health">Check Worker health</a></p>
      </section>
    </main>
  </body>
</html>`));

app.get("/api/health", (c) => c.json({
  ok: true,
  app: "PersonalPaperLibrary",
  runtime: "cloudflare-worker",
  bindings: {
    d1: Boolean(c.env.DB),
    r2: Boolean(c.env.PAPER_PDFS),
    assets: Boolean(c.env.ASSETS),
  },
}));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
