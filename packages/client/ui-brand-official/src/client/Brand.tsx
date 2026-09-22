import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Artwork URL derived from the resolved application color scheme. */
export interface BrandInjected {
  readonly hooks: { readonly logo: HostObservable<string> }
}

/**
 * Render the supplied muse-med artwork for the active application theme.
 * @param props - Host-supplied mark size, placement, and reactive artwork URL.
 * @returns a decorative image; the host provides the accessible action label.
 */
export function OfficialBrandMark({ size, className, useLogo }: HeroBrandMarkOwnerProps & InjectFace<BrandInjected>) {
  return <img src={useLogo(value => value)} width={size} height={size} className={className} alt="" aria-hidden="true" />
}
