import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import { config } from './config.ts';
import { log } from './log.ts';

/**
 * The Anthropic client, authenticated without an API key.
 *
 * Lambda has no OIDC identity of its own — it has SigV4 credentials — so the
 * identity is minted on demand: `sts:GetWebIdentityToken` returns an AWS-signed
 * JWT asserting the caller's role ARN, which the SDK exchanges at
 * /v1/oauth/token for a short-lived Anthropic token. Nothing static is stored
 * anywhere. There is no key in SSM, no key in Terraform state, and nothing to
 * rotate when one leaks, because there is no one.
 *
 * The federation rule pins the JWT's `sub` to this function's exact role ARN,
 * so possession of the role is the credential. That is the same shape as the
 * GitHub Actions trust policy in infra/github_oidc.tf, one layer up.
 */

/** Audience the federation rule matches on. Must agree with the rule exactly. */
const AUDIENCE = 'https://api.anthropic.com';

/**
 * Ceiling on the minted JWT's life. The Anthropic token derived from it lives
 * for the lesser of the rule's lifetime and twice this, so a short value here
 * caps how long a leaked assertion is worth anything without forcing an
 * exchange on every request.
 *
 * STS refuses a duration that outlives the caller's own session — locally that
 * is a ~15 minute `login_session` and this fails; in Lambda the role session is
 * long and it does not.
 */
const TOKEN_SECONDS = 900;

let clientPromise: Promise<Anthropic> | null = null;

/**
 * One client per container, not one per parse.
 *
 * The SDK wraps the credential provider in a TokenCache that refreshes ahead of
 * expiry, and that cache lives on the client instance — so constructing a
 * client per call would throw the cache away and exchange a fresh token every
 * time, doubling the round trips on a path that already retries once.
 */
export function visionClient(): Promise<Anthropic> {
  if (!clientPromise) clientPromise = build();
  return clientPromise;
}

async function build(): Promise<Anthropic> {
  // Local escape hatch, and the only reason a key still exists anywhere: the
  // Phase 1 harness in scripts/parse.ts runs off a .env file with no AWS
  // credentials to federate with. Lambda never sets this.
  const key = process.env['ANTHROPIC_API_KEY'];
  if (key) {
    log.info('anthropic client built from api key');
    return new Anthropic({ apiKey: key });
  }

  const federation = config.federation();
  const sts = new STSClient({});

  const identityTokenProvider = async (): Promise<string> => {
    const out = await sts.send(
      new GetWebIdentityTokenCommand({
        Audience: [AUDIENCE],
        SigningAlgorithm: 'RS256',
        DurationSeconds: TOKEN_SECONDS,
      }),
    );
    if (!out.WebIdentityToken) throw new Error('STS returned no web identity token');
    return out.WebIdentityToken;
  };

  log.info('anthropic client built from workload identity', {
    federationRuleId: federation.ruleId,
  });

  return new Anthropic({
    // The client wraps this in its own TokenCache, so the exchange happens
    // once per container rather than once per request.
    credentials: oidcFederationProvider({
      identityTokenProvider,
      federationRuleId: federation.ruleId,
      organizationId: federation.organizationId,
      serviceAccountId: federation.serviceAccountId,
      workspaceId: federation.workspaceId,
      baseURL: AUDIENCE,
      // Same reason the Telegram client gets an explicit fetch: bundled shims
      // have failed silently in this runtime before.
      fetch: globalThis.fetch,
    }),
  });
}
