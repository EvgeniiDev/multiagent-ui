// A capability probe must be a fresh completed run with a matching real tool
// call/result pair. A responseId or an error containing a URL proves nothing.
export function searchProbeEvidence(text, terminal) {
  const calls = new Set();
  let invoked = false;
  const results = [];
  let error = null;
  for (const line of String(text ?? '').split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const message = row.message ?? row;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'toolCall' && block.name === 'web_search' && block.id) {
        calls.add(block.id); invoked = true;
      }
    }
    if (message.role !== 'toolResult' || message.toolName !== 'web_search'
      || !calls.has(message.toolCallId)) continue;
    const content = Array.isArray(message.content)
      ? message.content.map(b => b.text ?? '').join('\n') : String(message.content ?? '');
    if (message.isError || /(?:^|\n)\s*Error:|returned no HTTP status|no parseable results/i.test(content)) {
      error = content.slice(0, 180); continue;
    }
    const urls = [...content.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map(m => m[0]);
    if (urls.length && /title|url|\[[^\]]+\]\(https?:|Source:|(?:^|\n)\s*\d+\.\s+[^\n]+\n\s*https?:\/\//i.test(content)) {
      results.push({urls, content});
    }
  }
  const completed = terminal?.status === 'completed' && terminal?.exit_code === 0;
  return {invoked, capable:completed && invoked && results.length > 0 && !error, results, error};
}
