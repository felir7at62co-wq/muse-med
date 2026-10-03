// Input: single-line text input atom (search boxes, inline forms). Composer
// textareas are NOT this atom — they live with the conversation package.

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import clsx from 'clsx'
import css from './Input.module.css'

/**
 * Render a text input with an optional leading icon.
 * @param props.icon - optional 16px leading icon node.
 * @param props.className - extra class for layout placement.
 * @param ref - the native input, cleared when it unmounts.
 * @returns wrapper span containing the native input; input attributes pass through.
 */
export const Input = forwardRef<HTMLInputElement, {
  icon?: ReactNode
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
} & InputHTMLAttributes<HTMLInputElement>>(function Input({ icon, className, ...rest }, ref) {
  return (
    <span className={clsx(css.wrap, className)}>
      {icon != null && <span className={css.icon}>{icon}</span>}
      <input ref={ref} className={css.input} {...rest} />
    </span>
  )
})
