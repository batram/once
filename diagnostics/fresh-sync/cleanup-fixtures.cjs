/* eslint @typescript-eslint/no-require-imports: "off" */
const fs=require("node:fs/promises")
const path=require("node:path")
async function main(){
  for(const name of process.argv.slice(2)){
    const target=path.resolve(__dirname,name)
    if(path.dirname(target)!==__dirname||! /^(browser|batch)-fixture-[\w-]+$/.test(path.basename(target)))throw Error("Refusing unexpected fixture path")
    await fs.rm(target,{recursive:true,force:true})
    console.log("Removed completed fixture "+path.basename(target))
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
