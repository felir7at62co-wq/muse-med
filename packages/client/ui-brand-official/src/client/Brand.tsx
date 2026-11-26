import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Brand.module.css'

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
  return <img src={useLogo(value => value)} width={size} height={size} className={[css.mark, className].filter(Boolean).join(' ')}
    alt="" aria-hidden="true" />
}
