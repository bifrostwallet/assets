/** `tokens/eip155-<chainId>/<address>/logo.webp` */
const TOKEN_LOGO_PATH = /^tokens\/eip155-\d+\/(0x[0-9a-f]{40})\/logo\.webp$/;

/**
 * Bucket key for the address WebP that older clients load as
 * `res/icons/<address>.webp`. Same bytes as `tokens/.../logo.webp`.
 * This key is bucket-root, not under `BUCKET_PREFIX`, because host `/res`
 * is not the catalog CDN prefix.
 */
export function legacyTokenIconDestination(relativePath: string): string | undefined {
  const match = TOKEN_LOGO_PATH.exec(relativePath);
  const address = match?.[1];
  if (!address) return undefined;
  return `res/icons/${address}.webp`;
}
