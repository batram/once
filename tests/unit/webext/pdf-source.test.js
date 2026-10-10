const test = require("node:test")
const assert = require("node:assert/strict")
const { isPdfSource } = require("../../../packages/webext-shell/dist/pdfSource")

test("PDF probe uses MIME rather than suffix and does not inject into extensionless PDFs",async context=>{
  context.mock.method(globalThis,"fetch",async()=>new Response(null,{headers:{"content-type":"application/pdf; version=1.7"}}))
  assert.equal(await isPdfSource("https://example.test/download"),true)
})

test("HTML with a PDF suffix stays an ordinary page",async context=>{
  context.mock.method(globalThis,"fetch",async()=>new Response(null,{headers:{"content-type":"text/html"}}))
  assert.equal(await isPdfSource("https://example.test/looks-like.pdf"),false)
})

test("PDF probe falls back to GET when HEAD is unsupported and cancels the body",async context=>{
  let cancelled=false
  const calls=[]
  context.mock.method(globalThis,"fetch",async(_url,options)=>{
    calls.push(options.method||"GET")
    return options.method==="HEAD" ? new Response(null,{status:405}) : new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{"content-type":"application/pdf"}})
  })
  assert.equal(await isPdfSource("https://example.test/document"),true)
  assert.deepEqual(calls,["HEAD","GET"])
  assert.equal(cancelled,true)
})
