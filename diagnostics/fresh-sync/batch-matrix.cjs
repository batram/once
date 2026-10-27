/* eslint @typescript-eslint/no-require-imports: "off" */
const fs=require("node:fs/promises")
const path=require("node:path")
const {spawn}=require("node:child_process")
const output=path.join(__dirname,"batch-matrix.json")
const configs=[]
for(let repeat=0;repeat<3;repeat++){
  const order=repeat===0?[500,1000,2000,3000,5000,10000]:repeat===1?[10000,5000,3000,2000,1000,500]:[3000,500,10000,1000,5000,2000]
  for(const profile of ["small","rich","attachments"])for(const batch of order)configs.push({profile,batch,latencyMs:50,repeat})
  for(const latencyMs of [0,150])for(const batch of [1000,3000,5000])configs.push({profile:"small",batch,latencyMs,repeat})
}
async function main(){
  const result={startedAt:new Date().toISOString(),method:"Isolated Node processes; LevelDB client and express-pouchdb server co-located; seeded synthetic documents; latency is added per request, no bandwidth throttle; memory includes client and server; 3 repetitions with varied batch order. Attachment payloads are 64KiB on 5% of documents. Rich profile updates 25% of documents once.",rows:[]}
  for(const config of configs){
    const row=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,["--expose-gc",path.join(__dirname,"batch-worker.cjs"),JSON.stringify(config)],{windowsHide:true,stdio:["ignore","pipe","pipe"]})
      let out="",err="";child.stdout.on("data",chunk=>out+=chunk);child.stderr.on("data",chunk=>err+=chunk)
      child.on("error",reject);child.on("exit",code=>code?reject(Error(err||out||"Worker failed")):resolve(JSON.parse(out.trim())))
    })
    result.rows.push(row)
    await fs.writeFile(output,JSON.stringify(result,null,2))
    const relative=path.relative(__dirname,row.directory)
    if(!/^batch-fixture-[\w-]+$/.test(relative))throw Error("Unexpected fixture cleanup path")
    await fs.rm(path.resolve(row.directory),{recursive:true,force:true})
    console.log(`${result.rows.length}/${configs.length} ${JSON.stringify(row)}`)
  }
  result.completedAt=new Date().toISOString();await fs.writeFile(output,JSON.stringify(result,null,2))
}
main().catch(error=>{console.error(error);process.exitCode=1})
