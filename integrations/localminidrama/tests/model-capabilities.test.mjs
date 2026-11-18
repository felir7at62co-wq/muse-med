import test from 'node:test'
import assert from 'node:assert/strict'
import {capabilitiesForConfig} from '../extensions/muse-model-capabilities.cjs'

const config={base_url:'https://ark.cn-beijing.volces.com/api/v3',api_protocol:'volcengine_omni',model:['doubao-seedance-2.5-260628']}
test('official profiles expose bounded public limits without inferring an opaque deployment model',()=>{
 const [known]=capabilitiesForConfig({...config,api_key:'private-not-metadata'})
 assert.equal(known.max_duration_seconds,30);assert.equal(known.default_resolution,'720p');assert.equal(known.min_duration_seconds,4)
 assert.doesNotMatch(JSON.stringify(known),/private-not-metadata/)
 assert.equal(capabilitiesForConfig({...config,model:['ep-opaque']})[0].max_duration_seconds,null)
 assert.equal(capabilitiesForConfig({...config,model:['fake-seedance-2.5-foo']})[0].max_duration_seconds,null)
 assert.equal(capabilitiesForConfig({...config,base_url:'https://other.example'})[0].max_duration_seconds,null)
 assert.equal(capabilitiesForConfig({...config,api_protocol:'openai'})[0].max_duration_seconds,null)
})
test('explicit deployment profiles and limits remain distinct from supplier-confirmed capabilities',()=>{
 const [profile]=capabilitiesForConfig({...config,model:['ep-opaque'],settings:JSON.stringify({muse_model_capabilities:{'ep-opaque':{profile:'seedance-2.5'}}})})
 assert.equal(profile.max_duration_seconds,30);assert.equal(profile.source,'configured')
 const [custom]=capabilitiesForConfig({model:['custom'],settings:{muse_model_capabilities:{custom:{max_duration_seconds:12,default_resolution:'1080p'}}}})
 assert.equal(custom.max_duration_seconds,12);assert.equal(custom.source,'configured')
 const [invalid]=capabilitiesForConfig({model:['custom'],settings:{muse_model_capabilities:{custom:{max_duration_seconds:Infinity,default_resolution:'secret\nvalue'}}}})
 assert.equal(invalid.max_duration_seconds,null)
})
