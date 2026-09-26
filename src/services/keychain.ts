import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const OPENAI_KEY_SERVICE = "PersonalPaperLibrary OpenAI API Key";
export const OPENROUTER_KEY_SERVICE = "PersonalPaperLibrary OpenRouter API Key";

export interface KeychainCredentialConfig {
  service: string;
  environmentVariable: string;
  keyLabel: string;
}

export const OPENAI_CREDENTIAL: KeychainCredentialConfig = {
  service: OPENAI_KEY_SERVICE,
  environmentVariable: "OPENAI_API_KEY",
  keyLabel: "OPENAI",
};

export const OPENROUTER_CREDENTIAL: KeychainCredentialConfig = {
  service: OPENROUTER_KEY_SERVICE,
  environmentVariable: "OPENROUTER_API_KEY",
  keyLabel: "OPENROUTER",
};

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

  constructor(private readonly credential = OPENAI_CREDENTIAL) {
    const environmentKey = process.env[this.credential.environmentVariable]?.trim();
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
    if (this.source === "environment") return process.env[this.credential.environmentVariable]?.trim() || undefined;
    if (this.source !== "keychain") return undefined;
    try {
      const result = await execFileAsync("security", ["find-generic-password", "-s", this.credential.service, "-a", this.account, "-w"]);
      return result.stdout.trim() || undefined;
    } catch {
      const environmentKey = process.env[this.credential.environmentVariable]?.trim();
      if (environmentKey) {
        this.source = "environment";
        this.writable = false;
        return environmentKey;
      }
      return undefined;
    }
  }

  async set(value: string): Promise<void> {
    if (!this.writable) throw new Error(`${this.credential.keyLabel}_KEY_NOT_EDITABLE`);
    const clean = value.trim();
    if (!clean) throw new Error(`${this.credential.keyLabel}_KEY_REQUIRED`);
    await execFileAsync("security", ["add-generic-password", "-U", "-s", this.credential.service, "-a", this.account, "-w", clean]);
  }

  async clear(): Promise<void> {
    if (!this.writable) throw new Error(`${this.credential.keyLabel}_KEY_NOT_EDITABLE`);
    try {
      await execFileAsync("security", ["delete-generic-password", "-s", this.credential.service, "-a", this.account]);
    } catch {
      // Deleting a key that is not present is already the desired state.
    }
  }
}

export function createKeychainAdapter(): KeychainAdapter {
  return new MacKeychainAdapter(OPENAI_CREDENTIAL);
}

export function createOpenRouterKeychainAdapter(): KeychainAdapter {
  return new MacKeychainAdapter(OPENROUTER_CREDENTIAL);
}
