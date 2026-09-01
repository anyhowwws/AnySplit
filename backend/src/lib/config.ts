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
  ttlSeconds: () => Number(optional('TTL_SECONDS', String(7 * 86400))),
} as const;

/** Max age of a Mini App initData payload before we reject it. */
export const INITDATA_MAX_AGE_SECONDS = 3 * 60 * 60;

/** Guardrails on people count, enforced on both ends. */
export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 12;
