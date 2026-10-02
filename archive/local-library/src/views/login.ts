import { escapeHtml } from "../views.js";

export function renderLoginPage(error = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · PersonalPaperLibrary</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell login-page"><div class="panel login-panel"><h1>PersonalPaperLibrary</h1><p class="muted">Sign in to access your paper library.</p>${error ? `<p class="status-error" role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/login"><label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label><button class="button" type="submit">Sign in</button></form></div></main></body></html>`;
}
