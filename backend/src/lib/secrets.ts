import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Secrets are fetched from SSM Parameter Store at runtime, not injected as
 * environment variables.
 *
 * The reason is Terraform state. Reading a SecureString through a `data` source
 * and passing it into a Lambda `environment` block writes the plaintext value
 * into terraform.tfstate — the same leak as putting it in a `resource`, one step
 * removed. Terraform only ever sees the parameter *path*; the value is resolved
 * here, once per container.
 */

const ssm = new SSMClient({});
const cache = new Map<string, Promise<string>>();

function fetchParameter(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) return cached;

  const pending = (async () => {
    const result = await ssm.send(
      new GetParameterCommand({ Name: path, WithDecryption: true }),
    );
    const value = result.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${path} is empty`);
    return value;
  })();

  // Cache the promise, not the value, so concurrent callers on a cold start
  // share one GetParameter call.
  cache.set(path, pending);
  pending.catch(() => cache.delete(path)); // don't cache a failure
  return pending;
}

/**
 * Local-dev escape hatch: if the secret is already in the environment, use it
 * and skip SSM entirely. This is how scripts/parse.ts runs off a .env file with
 * no AWS credentials. Lambda never sets these — only the `SSM_*` paths.
 */
function fromEnvOrSsm(directEnv: string, pathEnv: string): Promise<string> {
  const direct = process.env[directEnv];
  if (direct) return Promise.resolve(direct);

  const path = process.env[pathEnv];
  if (!path) throw new Error(`missing ${directEnv} and ${pathEnv}; one is required`);
  return fetchParameter(path);
}

export function botToken(): Promise<string> {
  return fromEnvOrSsm('BOT_TOKEN', 'SSM_BOT_TOKEN');
}

export function anthropicKey(): Promise<string> {
  return fromEnvOrSsm('ANTHROPIC_API_KEY', 'SSM_ANTHROPIC_KEY');
}

/** Shared secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token. */
export function webhookSecret(): Promise<string> {
  return fromEnvOrSsm('WEBHOOK_SECRET', 'SSM_WEBHOOK_SECRET');
}
