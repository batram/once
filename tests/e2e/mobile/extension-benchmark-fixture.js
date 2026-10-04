// Shared deterministic CPU/DOM fixture. No third-party requests or ad savings.
function fixture() {
  const css = Array.from({ length: 400 }, (_, i) => `.c${i}{color:rgb(${i % 200},${(i * 7) % 200},${(i * 13) % 200});padding:${i % 5}px;background:rgb(240,241,242)}`).join("\n")
  const body = Array.from({ length: 1500 }, (_, i) => `<p class="c${i % 400}">Article paragraph ${i} with enough text to exercise style and layout.</p>`).join("")
  return `<!doctype html><meta name="viewport" content="width=device-width"><style>body{background:white;color:black;margin:16px}${css}</style><main>${body}</main><script>
window.benchmark = async () => {
  const nodes = [...document.querySelectorAll('p')];
  const frames = [], work = [];
  let previous;
  for (let step = 0; step < 90; step++) {
    const time = await new Promise(requestAnimationFrame);
    if (previous !== undefined) frames.push(time - previous);
    previous = time;
    const start = performance.now();
    for (let n = 0; n < 50; n++) {
      const el = nodes[(step * 50 + n) % nodes.length];
      el.className = 'c' + ((step + n) % 400);
      el.textContent = 'Changed paragraph ' + step + ':' + n;
    }
    document.body.offsetHeight;
    work.push(performance.now() - start);
  }
  const summary = values => { const sorted = [...values].sort((a,b)=>a-b); return {median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}; };
  return {framesMs:summary(frames), synchronousWorkMs:summary(work), totalFrameMs:frames.reduce((a,b)=>a+b,0), framesOver25ms:frames.filter(x=>x>25).length, darkStyles:document.querySelectorAll('.darkreader').length, background:getComputedStyle(document.body).backgroundColor, elements:document.querySelectorAll('*').length};
};
</script>`
}
module.exports = { fixture }
