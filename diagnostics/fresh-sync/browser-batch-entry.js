import PouchDB from "pouchdb-browser"
import { protectRemoteAttachments } from "../../packages/persistence/src/remoteAttachments"

const root="http://127.0.0.1:15986"
export const state={running:false,rows:[],error:null}
let traffic=null
async function transport(input,init={}){
  const request=new Request(input,init)
  const result=await window.onceElectron.fetch({url:request.url,method:request.method,headers:Array.from(request.headers),...(!["GET","HEAD"].includes(request.method)?{body:await request.arrayBuffer()}:{})})
  if(traffic){traffic.requests++;traffic.responseBytes+=result.body.byteLength}
  return new Response(result.body,{status:result.status,headers:result.headers})
}
async function post(endpoint,value){
  const response=await transport(root+endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)})
  if(!response.ok)throw Error("Benchmark control failed: "+response.status)
  return response.json()
}
export async function start(profiles=["small","attachments"]){
  if(state.running)throw Error("Already running")
  state.running=true
  try{
    if(profiles.length===1)state.rows=(await post("/resume",{})).rows
    for(const profile of profiles){
      const count=profile==="small"?34000:6000
      const local=new PouchDB("once_benchmark_"+crypto.randomUUID(),{auto_compaction:true,revs_limit:1000})
      try{
        for(let start=0;start<count;start+=500){
          const docs=Array.from({length:Math.min(500,count-start)},(_,offset)=>{
            const i=start+offset
            const text=("Synthetic saved story "+i+" ").repeat(25)
            const doc={_id:`sto_https://example.invalid/${i}`,title:`Story ${i}`,timestamp:1700000000000+i,type:"rss",read_state:"unread",summary:text}
            if(profile==="attachments"&&i%20===0)doc._attachments={content:{content_type:"text/html",data:btoa(text.repeat(Math.ceil(65536/text.length)).slice(0,65536))}}
            return doc
          })
          await local.bulkDocs(docs)
        }
        for(let repeat=0;repeat<3;repeat++)for(const batch of (repeat===0?[1000,3000,5000]:repeat===1?[5000,3000,1000]:[3000,1000,5000])){
          const {name}=await post("/prepare",{})
          const remote=protectRemoteAttachments(new PouchDB(root+"/"+name,{fetch:transport}))
          let firstBatchMs=null,peakHeap=performance.memory?.usedJSHeapSize||0,maxTimerDelayMs=0,last=performance.now()
          const timer=setInterval(()=>{const now=performance.now();maxTimerDelayMs=Math.max(maxTimerDelayMs,now-last-20);last=now;peakHeap=Math.max(peakHeap,performance.memory?.usedJSHeapSize||0)},20)
          const started=performance.now()
          try{
            traffic={requests:0,responseBytes:0}
            const result=await local.replicate.to(remote,{batch_size:batch,batches_limit:2,checkpoint:"target",selector:{_id:{$nin:["once_sync_compat","once_sync_epoch","_design/once-epoch-freeze"]}}}).on("change",()=>{firstBatchMs??=Math.round(performance.now()-started)})
            const elapsedMs=Math.round(performance.now()-started)
            const pushTraffic=traffic;traffic=null
            if(result.docs_written!==count||(await remote.info()).doc_count!==count)throw Error("Document count mismatch")
            const metrics=await post("/metrics",{name})
            state.rows.push({direction:"push",profile,count,repeat,batch,latencyMs:50,elapsedMs,firstBatchMs,peakRendererHeapMiB:Math.round(peakHeap/1048576),maxTimerDelayMs:Math.round(maxTimerDelayMs),...metrics,...pushTraffic,verified:true})
            await post("/checkpoint",{rows:state.rows})
            const pulled=new PouchDB("once_benchmark_"+crypto.randomUUID(),{auto_compaction:true,revs_limit:1000})
            try{
              firstBatchMs=null;peakHeap=performance.memory?.usedJSHeapSize||0;maxTimerDelayMs=0;last=performance.now()
              const pullStarted=performance.now()
              traffic={requests:0,responseBytes:0}
              const pullResult=await pulled.replicate.from(remote,{batch_size:batch,batches_limit:2,checkpoint:"target",selector:{_id:{$nin:["once_sync_compat","once_sync_epoch","_design/once-epoch-freeze"]}}}).on("change",()=>{firstBatchMs??=Math.round(performance.now()-pullStarted)})
              const pullElapsed=Math.round(performance.now()-pullStarted)
              const pullTraffic=traffic;traffic=null
              const pulledInfo=await pulled.info()
              // PouchDB 9's browser attachment path undercounts doc_count;
              // enumerate actual rows instead of treating cached totals as truth.
              const storedRows=(await pulled.allDocs()).rows.length
              if(pullResult.docs_written!==count||storedRows!==count)throw Error("Pull content count mismatch: "+JSON.stringify({expected:count,storedRows,result:pullResult}))
              if(profile==="attachments"){
                const id="sto_https://example.invalid/0"
                if(await (await local.getAttachment(id,"content")).text()!==await (await pulled.getAttachment(id,"content")).text())throw Error("Pulled attachment mismatch")
              }
              state.rows.push({direction:"pull",profile,count,repeat,batch,latencyMs:50,elapsedMs:pullElapsed,firstBatchMs,peakRendererHeapMiB:Math.round(peakHeap/1048576),maxTimerDelayMs:Math.round(maxTimerDelayMs),...pullTraffic,storedRows,reportedDocCount:pulledInfo.doc_count,...(pulledInfo.doc_count!==count?{warning:"Browser adapter cached doc_count excludes attachment-bearing documents; actual rows and sample attachment verified"}:{}),verified:true})
              await post("/checkpoint",{rows:state.rows})
            }finally{await pulled.destroy()}
          }finally{clearInterval(timer);await remote.destroy()}
        }
      }finally{await local.destroy()}
    }
  }catch(error){state.error=String(error);await post("/checkpoint",{rows:state.rows,error:state.error})}
  finally{state.running=false;await post("/done",{})}
}
