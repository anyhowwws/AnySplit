/**
 * Non-secret configuration, from plain environment variables.
 *
 * Secrets do NOT live here — see secrets.ts, which resolves them from SSM at
 * runtime so they never reach Terraform state.
 *
 * Every accessor is a function rather than a resolved constant: a missing env
 * var should fail the request that needs it, not the module import, which in
 * Lambda would fail the whole container with a less useful stack.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  tableName: () => required('BILLS_TABLE'),
  parseQueueUrl: () => required('PARSE_QUEUE_URL'),
  /** CloudFront origin serving the Mini App. No trailing slash. */
  miniAppUrl: () => required('MINIAPP_URL'),

  /**
   * Vision model. SPEC.md started on Haiku 4.5 for cost, but the Phase 1 run
   * over 9 real receipts came in well under the 9/10 bar:
   *
   *                       original   cropped
   *   claude-haiku-4-5      3/9        5/9
   *   claude-sonnet-5       6/9        8/9
   *
   * Cropping to the receipt and the model upgrade are independent wins that
   * compound; neither alone clears the bar. Set VISION_MODEL to override.
   */
  visionModel: () => optional('VISION_MODEL', 'claude-sonnet-5'),

  /**
   * Telegram user ID allowed to run /test. Empty string disables the command,
   * so an unconfigured deployment fails closed.
   */
  testUserId: () => optional('TEST_USER_ID', ''),

  /** Bill retention. The honest promise /help makes to recipients. */
  ttlSeconds: () => Number(optional('TTL_SECONDS', String(86400))),

  /**
   * Identifiers for the workload identity exchange. Not secrets — none of them
   * grants anything without a JWT from the registered issuer whose `sub`
   * matches the rule — but they are account identifiers, so they come from
   * Terraform rather than being committed.
   *
   * Required rather than optional: a deployment missing them cannot
   * authenticate at all, and failing on the first parse with a named missing
   * variable beats a 401 from the exchange endpoint.
   */
  federation: () => ({
    ruleId: required('ANTHROPIC_FEDERATION_RULE_ID'),
    organizationId: required('ANTHROPIC_ORGANIZATION_ID'),
    serviceAccountId: process.env['ANTHROPIC_SERVICE_ACCOUNT_ID'] || undefined,
    // Only needed when the rule spans more than one workspace.
    workspaceId: process.env['ANTHROPIC_WORKSPACE_ID'] || undefined,
  }),

  /**
   * Ceilings on receipts accepted for parsing, per fixed window.
   *
   * Every photo is a paid vision call, and anyone who can find the bot can send
   * one, so without these a single script is an unbounded bill. They are env
   * vars rather than constants so a limit can be raised from Terraform in the
   * middle of an incident without a code deploy.
   *
   * Zero disables a tier. That is an escape hatch, not a default — the
   * deployment ships with all three set.
   */
  perUserHourly: () => Number(optional('RATE_USER_HOUR', '10')),
  perUserDaily: () => Number(optional('RATE_USER_DAY', '30')),
  /**
   * The one that actually bounds the bill. Per-user limits are fairness; they
   * do nothing against twenty throwaway accounts. This is the number that says
   * what a bad day can cost.
   */
  globalDaily: () => Number(optional('RATE_GLOBAL_DAY', '200')),
} as const;

/** Max age of a Mini App initData payload before we reject it. */
export const INITDATA_MAX_AGE_SECONDS = 3 * 60 * 60;

/** Guardrails on people count, enforced on both ends. */
export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 12;
