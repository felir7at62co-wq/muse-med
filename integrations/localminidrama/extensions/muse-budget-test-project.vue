<template>
  <section class="budget-test-project">
    <p>图片、视频和 TTS 的配置格式检查不生成；文本“测试连接”会真实请求供应商，须明确选择已授权预算的项目</p>
    <el-select :model-value="modelValue" clearable placeholder="选择文本测试费用归属项目" @update:model-value="value=>emit('update:modelValue',value)">
      <el-option v-for="row in projects" :key="row.id" :value="row.id" :label="row.title || '项目 '+row.id" />
    </el-select>
    <el-button :disabled="!modelValue" @click="visible=true">查看所选项目预算</el-button>
    <p v-if="notice" role="alert">{{ notice }}</p>
    <el-dialog v-model="visible" title="文本测试项目预算" width="min(1060px, 94vw)" append-to-body destroy-on-close :close-on-click-modal="false"><MuseBudgetPanel v-if="modelValue" :project-id="Number(modelValue)" /></el-dialog>
  </section>
</template>
<script setup>
import {onBeforeUnmount,onMounted,ref} from 'vue'
import {museStudioPath} from '@/utils/museStudioPath'
import MuseBudgetPanel from './MuseBudgetPanel.vue'
defineProps({modelValue:{type:Number,default:null}})
const emit=defineEmits(['update:modelValue']),projects=ref([]),notice=ref(''),visible=ref(false),controller=new AbortController();let closed=false
onMounted(async()=>{try{const response=await fetch(museStudioPath('/api/v1/dramas?page=1&page_size=1000'),{credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('projects_unavailable');const value=await response.json(),data=value.data??value;if(value.success===false)throw Error('projects_unavailable');if(!closed)projects.value=Array.isArray(data)?data:data.items||[]}catch(error){if(!closed)notice.value='无法读取本账户项目，请刷新后选择；未发起测试请求'}})
onBeforeUnmount(()=>{closed=true;controller.abort()})
</script>
<style scoped>
.budget-test-project{margin-block:var(--el-component-size-small);padding:var(--el-component-size-small);border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base)}
.budget-test-project :deep(.el-select){max-width:100%;margin-bottom:var(--el-font-size-small)}
.budget-test-project p{overflow-wrap:anywhere}
</style>
