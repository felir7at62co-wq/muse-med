'use client';
import * as React from 'react';
import { tokens } from '@/lib/tokens';

/**
 * 4 档断点 hook (PLAN §29.1)
 *   mobile  : <768
 *   tablet  : 768-1023
 *   desktop : 1024-1439
 *   wide    : ≥1440
 *
 * SSR 安全: 服务器端默认返回 'desktop' (避免水合不匹配后再 update)
 */
export type Breakpoint = 'mobile' | 'tablet' | 'desktop' | 'wide';

function pick(width: number): Breakpoint {
  if (width >= tokens.breakpoints.wide) return 'wide';
  if (width >= tokens.breakpoints.desktop) return 'desktop';
  if (width >= tokens.breakpoints.tablet) return 'tablet';
  return 'mobile';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = React.useState<Breakpoint>('desktop');

  React.useEffect(() => {
    const update = () => setBp(pick(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return bp;
}

export function useIsMobile(): boolean {
  return useBreakpoint() === 'mobile';
}

export function useIsTabletOrBelow(): boolean {
  const bp = useBreakpoint();
  return bp === 'mobile' || bp === 'tablet';
}
