<template>
  <div v-if="editable" ref="editor" class="muse-wb-prompt muse-wb-prompt-editor" role="textbox"
    :aria-label="label" aria-multiline="true" :aria-readonly="disabled" :contenteditable="!disabled"
    @input="onInput" @paste="onPaste" @keydown.enter.prevent="insertText('\n')" />
  <div v-else class="muse-wb-prompt" :aria-label="label">
    <template v-for="(part, index) in parts" :key="index"><span v-if="part.kind === 'text'">{{ part.text }}</span><button
      v-else-if="part.kind === 'asset'" type="button" class="muse-wb-chip" @click="emit('preview', part.binding)">
      <img v-if="part.binding.mediaUrl" :src="museMediaUrl(part.binding.mediaUrl)" alt="" />
      <span>{{ part.binding.displayName }}</span>
    </button><span v-else class="muse-wb-chip" data-missing="true">引用待核对</span></template>
    <span v-if="!text" class="muse-wb-help">未保存当次提示词</span>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { museMediaUrl } from '@/utils/museStudioPath'
import { studioPromptParts } from '@/utils/museStudioWorkbench'

const props = defineProps({ text: { type: String, default: '' }, bindings: { type: Array, default: () => [] },
  editable: Boolean, disabled: Boolean, label: { type: String, required: true } })
const emit = defineEmits(['update:text', 'preview'])
const editor = ref(null)
const parts = computed(() => studioPromptParts(props.text, props.bindings))
let emitted = null, renderedBindings = ''

function read(node) {
  if (node.nodeType === 3) return node.nodeValue || ''
  if (node.nodeType !== 1) return ''
  const token = node.dataset?.museReference
  if (token && props.bindings.some(binding => binding.referenceToken === token)) return token
  if (node.tagName === 'BR') return '\n'
  const text = [...node.childNodes].map(read).join('')
  return ['DIV', 'P'].includes(node.tagName) && node !== editor.value ? '\n' + text : text
}
function onInput() {
  emitted = read(editor.value)
  emit('update:text', emitted)
}
function insertText(text) {
  if (props.disabled || !editor.value) return
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const node = document.createTextNode(text)
  if (range && editor.value.contains(range.commonAncestorContainer)) {
    range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true)
    selection.removeAllRanges(); selection.addRange(range)
  } else editor.value.append(node)
  onInput()
}
function onPaste(event) {
  event.preventDefault()
  insertText(event.clipboardData?.getData('text/plain') || '')
}
function render() {
  if (!props.editable || !editor.value) return
  const signature = JSON.stringify(props.bindings)
  if (props.text === emitted && signature === renderedBindings) return
  renderedBindings = signature
  const focused = editor.value === document.activeElement || editor.value.contains(document.activeElement)
  const nodes = parts.value.map(part => {
    if (part.kind !== 'asset') return document.createTextNode(part.text)
    const chip = document.createElement('button')
    chip.type = 'button'; chip.className = 'muse-wb-chip'; chip.contentEditable = 'false'; chip.tabIndex = -1
    chip.dataset.museReference = part.text
    chip.setAttribute('aria-label', '查看参考图：' + part.binding.displayName)
    if (part.binding.mediaUrl) {
      const image = document.createElement('img'); image.src = museMediaUrl(part.binding.mediaUrl); image.alt = ''; chip.append(image)
    }
    const name = document.createElement('span'); name.textContent = part.binding.displayName; chip.append(name)
    chip.addEventListener('click', () => emit('preview', part.binding))
    return chip
  })
  editor.value.replaceChildren(...nodes)
  if (focused) {
    const range = document.createRange(); range.selectNodeContents(editor.value); range.collapse(false)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
  }
}
watch(() => [props.text, props.bindings, props.editable], render, { deep: true, flush: 'post' })
onMounted(render)
</script>
