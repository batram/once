/* eslint @typescript-eslint/no-require-imports: "off" */
const fs=require("node:fs/promises")
const path=require("node:path")
const express=require("express")
const PouchDB=require("pouchdb")
const {randomUUID}=require("node:crypto")
const esbuild=require("esbuild")
const couchServer=require("../../tests/helpers/couch-server")
async function main(){
  const bundle=await esbuild.build({entryPoints:[path.join(__dirname,"browser-batch-entry.js")],bundle:true,minify:true,format:"iife",globalName:"__onceBatchBenchmark",platform:"browser",write:false})
  await fs.writeFile(path.join(__dirname,"browser-batch-bundle.js"),bundle.outputFiles[0].text)
  const directory=await fs.mkdtemp(path.join(__dirname,"browser-fixture-"))
  const Db=PouchDB.defaults({prefix:directory+path.sep})
  const app=express(),metrics=new Map()
  app.get("/bundle.js",(_req,res)=>res.type("text/javascript").send(bundle.outputFiles[0].text))
  app.post("/prepare",express.json(),async(_req,res)=>{
    const name="benchmark_"+randomUUID().replaceAll("-","")
    const db=new Db(name);await db.info();await db.close()
    metrics.set(name,{requests:0,bulkWrites:0,maxRequestBytes:0})
    res.json({name})
  })
  app.post("/metrics",express.json(),(req,res)=>res.json(metrics.get(req.body.name)))
  app.post("/resume",express.json(),async(_req,res)=>{
    const previous=JSON.parse(await fs.readFile(path.join(__dirname,"browser-batch-results.json"),"utf8"))
    res.json({rows:previous.rows.filter(row=>row.profile==="small")})
  })
  app.post("/checkpoint",express.json({limit:"1mb"}),async(req,res)=>{
    await fs.writeFile(path.join(__dirname,"browser-batch-results.json"),JSON.stringify({measuredAt:new Date().toISOString(),method:"Actual running packaged Electron renderer; synthetic independent IndexedDB databases, pouchdb-browser 9; app IPC HTTP bridge to local express-pouchdb with 50ms per request; renderer heap includes the running app.",...req.body},null,2))
    console.log(JSON.stringify(req.body.rows.at(-1)||req.body));res.json({ok:true})
  })
  app.post("/done",express.json(),(_req,res)=>{res.json({ok:true,directory});setTimeout(()=>{server.closeAllConnections();server.close()},100)})
  app.use((req,_res,next)=>{
    const record=metrics.get(req.path.split("/")[1])
    if(!record)return next()
    record.requests++;record.maxRequestBytes=Math.max(record.maxRequestBytes,Number(req.headers["content-length"]||0))
    if(req.path.endsWith("/_bulk_docs"))record.bulkWrites++
    setTimeout(next,50)
  })
  app.use(couchServer(Db,{mode:"minimumForPouchDB",inMemoryConfig:true}))
  const server=app.listen(15986,"127.0.0.1",()=>console.log("Ready "+directory))
}
main().catch(error=>{console.error(error);process.exitCode=1})
