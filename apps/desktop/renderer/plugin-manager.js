const api = window.dshDesktop

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.npmPackage
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins
  for (const [selector, key] of [
    ['#bundled-heading', 'bundledHeading'], ['#bundled-description', 'bundledDescription'],
    ['#catalog-heading', 'catalogHeading'], ['#catalog-description', 'catalogDescription'],
    ['#discover', 'discoverPlugins'], ['#catalog-search-label', 'catalogSearch'],
  ]) document.querySelector(selector).textContent = messages[key]

  document.querySelector('#recovery-description').textContent = messages.recoveryDescription
  document.querySelector('#retry').textContent = messages.retry
  document.querySelector('#disable-all').textContent = messages.disableAll

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')
  const search = document.querySelector('#catalog-search')
  let catalogPlugins = []
  let installed = []
  let canInstall = false

  function renderCatalog() {
    const query = search.value.toLocaleLowerCase().trim()
    const matches = catalogPlugins.filter(plugin => [plugin.name, plugin.npm ?? '', ...Object.values(plugin.description)]
      .some(value => value.toLocaleLowerCase().includes(query)))
    document.querySelector('#catalog-count').textContent = message('catalogCount', { shown: matches.length, total: catalogPlugins.length })
    document.querySelector('#catalog-plugins').replaceChildren(...matches.map(plugin => {
      const item = document.createElement('li')
      const detail = document.createElement('div')
      detail.className = 'catalog-detail'
      const title = document.createElement('strong')
      title.textContent = plugin.name
      const description = document.createElement('p')
      description.textContent = plugin.description[locale.id === 'zh-CN' ? 'zh' : 'en'] ?? plugin.description.en ?? plugin.description.zh ?? ''
      const repository = document.createElement('a')
      repository.href = plugin.repository
      repository.target = '_blank'
      repository.rel = 'noopener noreferrer'
      repository.textContent = messages.catalogRepository
      detail.append(title, description, repository)
      let action = document.createElement('span')
      if (plugin.bundled) action.textContent = messages.bundledBadge
      else if (installed.some(entry => plugin.npm === entry.name || plugin.npm?.startsWith(`${entry.name}@`))) action.textContent = messages.installed
      else if (plugin.npm === undefined) action.textContent = messages.catalogNpmOnly
      else if (!canInstall) action.textContent = messages.packagedChangesOnly
      else {
        action = document.createElement('button')
        action.type = 'button'
        action.textContent = messages.install
        action.addEventListener('click', () => {
          if (!window.confirm(message('catalogConfirm', { spec: plugin.npm }))) return
          void run(() => api.plugins.add(plugin.npm), message('installing', { spec: plugin.npm }))
        })
      }
      item.append(detail, action)
      return item
    }))
  }

  search.addEventListener('input', renderCatalog)
  document.querySelector('#discover').addEventListener('click', async () => {
    setBusy(true, messages.catalogLoading)
    try {
      const catalog = await api.plugins.catalog(true)
      catalogPlugins = catalog.plugins
      canInstall = catalog.canInstall
      renderCatalog()
      status.textContent = messages.catalogLoaded
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  })

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button, input')) control.disabled = busy || control.dataset.unavailable === 'true'
    status.textContent = statusMessage
  }

  async function render() {
    const backend = await api.backend.status()
    document.querySelector('#recovery').hidden = backend.phase !== 'error'
    document.querySelector('#startup-error').textContent = backend.phase === 'error' ? backend.message : ''
    const plugins = await api.plugins.list()
    installed = plugins
    const catalog = await api.plugins.catalog(false)
    canInstall = catalog.canInstall
    for (const control of form.querySelectorAll('button, input')) control.dataset.unavailable = String(!canInstall)
    document.querySelector('#bundled-plugins').replaceChildren(...catalog.bundled.map(plugin => {
      const item = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = `${plugin.name} · ${plugin.version}`
      const state = document.createElement('span')
      state.textContent = plugin.mounted ? messages.bundledMounted : messages.bundledDormant
      item.append(name, state)
      return item
    }))
    renderCatalog()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.enabled ? plugin.version : `${plugin.version} · ${messages.disabled}`
      identity.append(document.createTextNode(plugin.name), version)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.plugins.remove(plugin.name),
        message('removing', { name: plugin.name }),
      ))
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = messages.update
      update.addEventListener('click', () => {
        const next = window.prompt(message('targetVersion', { name: plugin.name }), plugin.version)?.trim()
        if (next === undefined || next === '' || next === plugin.version) return
        void run(() => api.plugins.update(plugin.name, next), message('updating', { name: plugin.name }))
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.textContent = plugin.enabled ? messages.disable : messages.enable
      toggle.addEventListener('click', () => void run(
        () => api.plugins.toggle(plugin.name, !plugin.enabled), messages.changingActivation,
      ))
      actions.append(toggle, update, remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function run(operation, statusMessage) {
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = messages.operationComplete
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  document.querySelector('#retry').addEventListener('click', () => void run(() => api.backend.retry(), messages.retry))
  document.querySelector('#disable-all').addEventListener('click', () => void run(() => api.plugins.disableAll(), messages.changingActivation))
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))

  await load(messages.loadingPlugins, '')
}

void main()
