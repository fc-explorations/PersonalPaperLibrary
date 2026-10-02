# Archived local application source

This directory preserves the retired Node.js, SQLite, and filesystem-backed application as a source archive. It is not included in the root build, tests, or release workflow and is not maintained as a runnable application.

The local runtime database and PDF files were not moved or copied. They remain in the ignored `data/` directory, if present.

Some types and utilities used by both runtimes remain in the active Cloudflare project. The archived source therefore reflects the historical local implementation but is not guaranteed to resolve imports or build independently.
