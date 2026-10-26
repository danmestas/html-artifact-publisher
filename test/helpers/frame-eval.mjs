// Evaluates JavaScript inside the viewer's sandboxed page, over the Chrome
// DevTools Protocol of an agent-browser session. agent-browser's own `frame`
// command cannot enter an opaque-origin blob: iframe, so the browser QA uses
// this to look at the pins the page draws.
//
//   const page = await frameEval(cdpUrl);  // the browser's DevTools WebSocket
//   await page.eval('document.title');
//   page.close();

export async function frameEval(cdpUrl) {
  const ws = new WebSocket(cdpUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot connect to ${cdpUrl}`)); });
  let n = 0;
  const pending = new Map(), contexts = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.executionContextCreated') contexts.push({ ...d.params.context, sessionId: d.sessionId });
    if (d.method === 'Runtime.executionContextDestroyed') {
      const i = contexts.findIndex(c => c.uniqueId === d.params.executionContextUniqueId);
      if (i >= 0) contexts.splice(i, 1);
    }
  };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, d => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function attach() {
    // A sandboxed frame may run in its own process (its own target) or in the viewer's.
    const { targetInfos } = await call('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'iframe' && t.url.startsWith('blob:'))
      ?? targetInfos.find(t => t.type === 'page' && t.url.includes('/v/'));
    if (!target) throw new Error('no viewer page');
    const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await call('Runtime.enable', {}, sessionId);
    const { frameTree } = await call('Page.getFrameTree', {}, sessionId);
    const blob = target.type === 'iframe' ? frameTree.frame : frameTree.childFrames?.find(f => f.frame.url.startsWith('blob:'))?.frame;
    if (!blob) throw new Error('no page frame');
    return { sessionId, frameId: blob.id };
  }

  return {
    async eval(expression) {
      for (let tries = 0; tries < 20; tries++) {
        const { sessionId, frameId } = await attach();
        const ctx = contexts.find(c => c.sessionId === sessionId && c.auxData?.frameId === frameId && c.auxData?.isDefault);
        if (ctx) {
          const r = await call('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true }, sessionId);
          await call('Target.detachFromTarget', { sessionId });
          if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value;
        }
        await call('Target.detachFromTarget', { sessionId });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('the page frame has no script context');
    },
    close() { ws.close(); },
  };
}
