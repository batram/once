const test = require("node:test")
const assert = require("node:assert/strict")
const { pdfTextLines } = require("../../../packages/platform-web/dist/pdfTextLines")
const item = (str,x,y,width,hasEOL=false)=>({str,width,height:12,transform:[12,0,0,12,x,y],hasEOL})

test("positioned PDF runs become complete lines with spaces and geometry",()=>{
  const result=pdfTextLines([item("A",10,20,8),item("sentence",22,20,50),item("continues",76,20,60,true),item("next line.",10,40,60,true)],m=>m)
  assert.deepEqual(result.lines,["A sentence continues","next line."])
  assert.deepEqual(result.lineBounds,[{x:10,y:8,width:126,height:12},{x:10,y:28,width:60,height:12}])
})

test("adjacent glyph runs do not acquire spaces inside words",()=>{
  assert.deepEqual(pdfTextLines([item("Read",10,20,28),item("er",38,20,12,true)],m=>m).lines,["Reader"])
})

test("line changes and column jumps stay separate even without EOL flags",()=>{
  const result=pdfTextLines([item("Column one",10,20,60),item("Column two",300,20,60),item("Next line",10,40,60)],m=>m)
  assert.deepEqual(result.lines,["Column one","Column two","Next line"])
})

test("empty EOL markers flush lines and viewport transforms rotate/position text",()=>{
  const result=pdfTextLines([item("Text",10,20,30),item("",40,20,0,true),item("More",10,40,30)],m=>[m[0],m[1],m[2],m[3],m[4]+5,100-m[5]])
  assert.deepEqual(result.lines,["Text","More"])
  assert.equal(result.lineBounds[0].x,15)
  assert.equal(result.lineBounds[0].y,68)
})
