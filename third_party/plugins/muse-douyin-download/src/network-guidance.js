/** Add troubleshooting guidance without changing a blocked media result. */
export function withNetworkGuidance(result) {
  if (result?.status !== 'blocked' || result.code !== 'PRIVATE_MEDIA_ADDRESS') return result;
  return { ...result, message: 'The media address is private or reserved and was blocked. If your proxy uses fake IP addresses, try enabling system DNS compatibility in Settings > General and restart Muse. If the download still fails, check the network configuration.' };
}
