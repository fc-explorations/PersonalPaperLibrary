import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const OPENAI_KEY_SERVICE = "PersonalPaperLibrary OpenAI API Key";

export interface KeychainAdapter {
  readonly source: "keychain" | "environment" | "none";
  readonly writable: boolean;
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export class MacKeychainAdapter implements KeychainAdapter {
  source: "keychain" | "environment" | "none";
  writable: boolean;
  private readonly account = process.env.USER || "personal-paper-library";

  constructor() {
    const environmentKey = process.env.OPENAI_API_KEY?.trim();
    if (environmentKey) {
      this.source = "environment";
      this.writable = false;
    } else if (process.platform === "darwin") {
      this.source = "keychain";
      this.writable = true;
    } else {
      this.source = "none";
      this.writable = false;
    }
  }

  async get(): Promise<string | undefined> {
    if (this.source === "environment") return process.env.OPENAI_API_KEY?.trim() || undefined;
    if (this.source !== "keychain") return undefined;
    try {
      const result = await execFileAsync("security", ["find-generic-password", "-s", OPENAI_KEY_SERVICE, "-a", this.account, "-w"]);
      return result.stdout.trim() || undefined;
    } catch {
      const environmentKey = process.env.OPENAI_API_KEY?.trim();
      if (environmentKey) {
        this.source = "environment";
        this.writable = false;
        return environmentKey;
      }
      return undefined;
    }
  }

  async set(value: string): Promise<void> {
    if (!this.writable) throw new Error("OPENAI_KEY_NOT_EDITABLE");
    const clean = value.trim();
    if (!clean) throw new Error("OPENAI_KEY_REQUIRED");
    await execFileAsync("security", ["add-generic-password", "-U", "-s", OPENAI_KEY_SERVICE, "-a", this.account, "-w", clean]);
  }

  async clear(): Promise<void> {
    if (!this.writable) throw new Error("OPENAI_KEY_NOT_EDITABLE");
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", OPENAI_KEY_SERVICE, "-a", this.account]);
    } catch {
      // Deleting a key that is not present is already the desired state.
    }
  }
}

export function createKeychainAdapter(): KeychainAdapter {
  return new MacKeychainAdapter();
}
