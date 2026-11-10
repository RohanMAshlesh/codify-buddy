import pc from "picocolors";
import { loadConfig } from "../../config/config.js";
import { clearCredentials, maskKey, saveApiKey } from "../../config/credentials.js";
import { findProjectRoot } from "../../config/paths.js";
import { createClient, describeApiError } from "../../model/client.js";
import { askHidden } from "../prompt.js";

/** Prompt for an API key, verify it against the API, and store it. */
export async function runLogin(opts: { verify?: boolean } = {}): Promise<boolean> {
  process.stdout.write(
    pc.dim("Codify Buddy uses your own Anthropic API key. Create one at https://console.anthropic.com/settings/keys\n"),
  );
  const key = await askHidden("Paste your API key: ");
  if (!key) {
    process.stdout.write(pc.red("No key entered.\n"));
    return false;
  }
  if (opts.verify !== false) {
    try {
      const model = loadConfig(findProjectRoot()).model;
      await createClient({ apiKey: key, source: "file" }).models.retrieve(model);
    } catch (err) {
      process.stdout.write(pc.red(`✖ ${describeApiError(err)}\n`));
      return false;
    }
  }
  const file = saveApiKey(key);
  process.stdout.write(pc.green(`✔ Saved ${maskKey(key)} to ${file}\n`));
  return true;
}

export function runLogout(): void {
  process.stdout.write(clearCredentials() ? pc.green("✔ Removed stored credentials.\n") : pc.dim("No stored credentials.\n"));
}
