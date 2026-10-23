"""Apply two proposed lifecycle edits in memory for offline main-flow tests only."""
PATCHES=(
    ("            if kind=='target-enabled':state.hook_enabled.set()\n            if kind in {'script-error','observation-error'}:\n",
     "            if kind=='target-enabled':state.hook_enabled.set()\n            if kind=='disposed':\n                if hasattr(state,'ready'):state.ready=False\n                state.status='hook-disposed';state.done.set()\n            if kind in {'script-error','observation-error'}:\n"),
    ("                if state.done.is_set():break\n        except asyncio.CancelledError:raise\n",
     "                if state.done.is_set():break\n            if not state.stopping and not state.done.is_set():\n                if hasattr(state,'ready'):state.ready=False\n                state.status='peer-ended';state.done.set()\n        except asyncio.CancelledError:raise\n"),
)


def apply_suggestion(source):
    """Do not edit a controller file or alter its preflight/peer authorization."""
    for before,after in PATCHES:
        if source.count(after)==1:continue
        if source.count(before)!=1:raise RuntimeError('lifecycle-patch-anchor-changed')
        source=source.replace(before,after,1)
    return source
