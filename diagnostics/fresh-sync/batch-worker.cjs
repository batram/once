/* eslint @typescript-eslint/no-require-imports: "off" */
const fs = require("node:fs/promises")
const path = require("node:path")
const { monitorEventLoopDelay } = require("node:perf_hooks")
const { createHash } = require("node:crypto")
const PouchDB = require("pouchdb")
const express = require("express")
const couchServer = require("../../tests/helpers/couch-server")
const { SYNC_COMPAT_ID, SYNC_EPOCH_ID, SYNC_EPOCH_FENCE_ID } = require("@once/core")

async function run(config) {
  const count = config.profile === "small" ? 34000 : config.profile === "rich" ? 12000 : 6000
  const directory = await fs.mkdtemp(path.join(__dirname, "batch-fixture-"))
  const Db = PouchDB.defaults({prefix:directory+path.sep})
  const local = new Db("source"), target = new Db("target")
  let server, remote, timer
  try {
    for(let start=0;start<count;start+=500){
      const docs=Array.from({length:Math.min(500,count-start)},(_,offset)=>{
        const i=start+offset
        const token=createHash("sha256").update(String(i)).digest("hex")
        const doc={_id:`sto_https://example.invalid/story/${i}`,href:`https://example.invalid/story/${i}`,title:`Synthetic story ${i} ${token.slice(0,16)}`,timestamp:1700000000000+i,type:"rss",read_state:"unread",stared:false,filter:"",tags:[{name:"synthetic"}],summary:token.repeat(config.profile==="rich"?55:5)}
        if(config.profile==="attachments"&&i%20===0)doc._attachments={content:{content_type:"text/html",data:Buffer.from((token+"\n").repeat(1008)).toString("base64")}}
        return doc
      })
      const saved=await local.bulkDocs(docs)
      if(config.profile==="rich"){
        const changed=docs.filter((_,i)=>i%4===0).map(doc=>({...doc,_rev:saved[docs.indexOf(doc)].rev,read_state:"read"}))
        await local.bulkDocs(changed)
      }
    }
    await target.info()
    const app=express()
    let bulkWrites=0, totalRequests=0, maxRequestBytes=0, totalRequestBytes=0, firstBatchMs=null
    app.use((req,res,next)=>{
      totalRequests++
      const bytes=Number(req.headers["content-length"]||0)
      totalRequestBytes+=bytes;maxRequestBytes=Math.max(maxRequestBytes,bytes)
      if(req.path.endsWith("/_bulk_docs"))bulkWrites++
      if(config.latencyMs)setTimeout(next,config.latencyMs);else next()
    })
    app.use(couchServer(Db,{mode:"minimumForPouchDB",inMemoryConfig:true}))
    server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))})
    remote=new PouchDB(`http://127.0.0.1:${server.address().port}/target`)
    await remote.info()
    bulkWrites=0;totalRequests=0;maxRequestBytes=0;totalRequestBytes=0
    global.gc?.()
    const baseline=process.memoryUsage()
    let peakRss=baseline.rss,peakHeap=baseline.heapUsed
    const lag=monitorEventLoopDelay({resolution:10});lag.enable()
    timer=setInterval(()=>{const mem=process.memoryUsage();peakRss=Math.max(peakRss,mem.rss);peakHeap=Math.max(peakHeap,mem.heapUsed)},20)
    const started=performance.now()
    const replicated=await local.replicate.to(remote,{batch_size:config.batch,batches_limit:2,checkpoint:"target",selector:{_id:{$nin:[SYNC_COMPAT_ID,SYNC_EPOCH_ID,SYNC_EPOCH_FENCE_ID]}}}).on("change",()=>{firstBatchMs??=Math.round(performance.now()-started)})
    const elapsedMs=Math.round(performance.now()-started)
    clearInterval(timer);timer=null;lag.disable()
    const remoteInfo=await target.info()
    if(replicated.docs_written!==count||remoteInfo.doc_count!==count)throw Error("Replication count mismatch")
    // Verify attachment bytes, not only document counts.
    if(config.profile==="attachments"){
      const id="sto_https://example.invalid/story/0"
      if(!(await target.getAttachment(id,"content")).equals(await local.getAttachment(id,"content")))throw Error("Attachment mismatch")
    }
    return {...config,directory,count,elapsedMs,firstBatchMs,bulkWrites,totalRequests,maxRequestBytes,totalRequestBytes,peakRssMiB:Math.round(peakRss/1048576),peakHeapMiB:Math.round(peakHeap/1048576),rssGrowthMiB:Math.round((peakRss-baseline.rss)/1048576),eventLoopP99Ms:Math.round(lag.percentile(99)/1e6),verified:true}
  }finally{
    if(timer)clearInterval(timer)
    await remote?.close()
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    await local.destroy();await target.destroy()
    // express-pouchdb holds its registry database until process exit. The
    // parent removes this fixture after that handle has closed.
  }
}
run(JSON.parse(process.argv[2])).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1})
