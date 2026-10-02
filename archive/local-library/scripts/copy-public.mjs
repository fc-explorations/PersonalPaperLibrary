import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve("dist");
mkdirSync(output, { recursive: true });
cpSync("public", resolve(output, "public"), { recursive: true });
cpSync("migrations", resolve(output, "migrations"), { recursive: true });
cpSync("config", resolve(output, "config"), { recursive: true });
