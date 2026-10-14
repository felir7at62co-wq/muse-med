/** Observes shipping account publication for browser-test readiness. */
window.__ModuleLoader__.load({
  id: '@fixture/onboarding-account',
  factory() {
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const observed = document.documentElement.dataset
          let current
          let unsubscribe
          const attach = () => {
            const entry = ctx.slots.entries('shell.overlay').find(row => row.options.id === 'desktop-onboarding')
            if (entry === current) return
            unsubscribe?.()
            unsubscribe = undefined
            current = entry
            delete observed.onboardingBalanceStatus
            if (entry === undefined) return
            const account = entry.inject().hooks.account
            const publish = () => { observed.onboardingBalanceStatus = account.getSnapshot().details?.balance?.status ?? 'loading' }
            unsubscribe = account.subscribe(publish)
            publish()
          }
          const release = ctx.slots.subscribe('shell.overlay', attach)
          attach()
          return () => {
            release()
            unsubscribe?.()
            delete observed.onboardingBalanceStatus
          }
        })
      },
    }
  },
})
