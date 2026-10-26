import assert from 'node:assert/strict';
import http from 'node:http';
const feed = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:smoke@example.test\r\nDTSTART:20261026T120000Z\r\nDTEND:20261026T130000Z\r\nSUMMARY:Local smoke\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const upstream = http.createServer((_req, res) => { res.setHeader('content-type', 'text/calendar'); res.end(feed); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const { unstable_dev } = await import('wrangler');
const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join, resolve } = await import('node:path');
const dir = await mkdtemp(join(tmpdir(), 'worker-security-smoke-'));
// A fixture entry seeds local KV, then invokes the real application handler.
const entry = join(dir, 'entry.ts');
await writeFile(entry, `import app from ${JSON.stringify(resolve('src/index.ts'))};
export default { async fetch(request, env, ctx) {
 await env.SETTINGS.put('config:feeds', JSON.stringify([{id:'fixture',name:'Fixture'}]));
 await env.SETTINGS.put('config:views', JSON.stringify({full:{feeds:['fixture'],calendarName:'Smoke Calendar'}}));
 return app.fetch(request,env,ctx);
}};`);
const config = join(dir, 'wrangler.json');
await writeFile(config, JSON.stringify({ name:'local-security-smoke',main:entry,compatibility_date:'2024-12-01',kv_namespaces:[{binding:'SETTINGS',id:'local-test'}] }));
let worker;
try {
 worker = await unstable_dev(entry, {config,local:true,ip:'127.0.0.1',port:0,persist:false,logLevel:'error', vars:{
  FEED_URLS: JSON.stringify({fixture: `http://127.0.0.1:${upstream.address().port}/feed.ics`}),
  VIEW_TOKENS: JSON.stringify({full:'local-test-only'}), CACHE_TTL_SECONDS:'0',
 },experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false}});
 const url = `http://${worker.address}:${worker.port}`;
  const health = await fetch(new URL('/health', url));
  assert.equal(health.status,200); assert.equal(await health.text(),'ok');
  const denied = await fetch(new URL('/calendar.ics?token=invalid', url));
  assert.equal(denied.status,401); await denied.text();
  const calendar = await fetch(new URL('/calendar.ics?token=local-test-only',url));
  assert.equal(calendar.status,200); const body=await calendar.text();
  assert.match(body,/UID:smoke@example.test/); assert.match(body,/SUMMARY:Local smoke/);
  assert.match(calendar.headers.get('content-type'),/text\/calendar/);
  console.log('Miniflare HTTP smoke passed: health, auth rejection, KV configuration, upstream HTTP fetch, calendar response');
} finally { await worker?.stop(); await rm(dir,{recursive:true,force:true}); await new Promise(resolve=>upstream.close(resolve)); }
