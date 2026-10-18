import readline from 'node:readline';
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 let frame; try { frame = JSON.parse(line); } catch { return; }
 if (frame.id == null) return;
 if (frame.method === 'session/prompt') {
  setTimeout(() => send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }), 500);
 } else {
  if (frame.method === 'session/load') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: frame.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed transcript' } } } });
  send({ jsonrpc: '2.0', id: frame.id, result: {} });
 }
});
