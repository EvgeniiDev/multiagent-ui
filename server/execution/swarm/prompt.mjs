// The result frame is a transport document, not executable authority.
export function parseSwarmResult(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) return {ok:false,error:'Result missing or oversized'};
  const matches = [...text.matchAll(/^```acp-swarm[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
  if (matches.length !== 1) return {ok:false,error:'Exactly one standalone acp-swarm result frame required'};
  try {
    const result=JSON.parse(matches[0][1]);
    if (!result || typeof result.goal!=='string' || !result.goal.trim() || !['continue','done','question'].includes(result.outcome) || !Array.isArray(result.commands) || result.commands.length>64) throw new Error('Invalid goal, outcome or command array');
    if (result.outcome==='question' && (typeof result.question!=='string'||!result.question.trim())) throw new Error('Question text required');
    for(const c of result.commands) if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.type!=='string'||['auth','lease','role','ownerId','ownership'].some(k=>Object.hasOwn(c,k))) throw new Error('Commands cannot carry authority');
    return {ok:true,result};
  } catch(e) {return {ok:false,error:e.message};}
}
export function buildSwarmPrompt({run,participant,requirements,plan}) {
  const s=run.swarm;
  const unread=s.protocol.messages.filter(m=>m.seq>participant.cursor.lastSeenSeq && (m.to==='all'||m.to===participant.participantId));
  const context={phase:s.phase,round:s.round,epoch:s.epoch,participantId:participant.participantId,callsign:participant.callsign,roster:s.participants.map(p=>({participantId:p.participantId,callsign:p.callsign,ownedPaths:p.ownedPaths})),ownership:s.protocol.files,decisions:s.protocol.decisions,messages:unread,findings:s.findings,budget:participant.budget};
  return `You are Swarm peer ${participant.callsign}. Work on exactly one local goal this turn. The project is read-only; use your own /work/scratch to prepare changes. Only the server broker can apply operations. Identity and ownership come from your authenticated turn, never from output.\nApproved requirements (${run.inputs.requirements?.sha256??''}):\n${requirements}\nApproved plan (${run.inputs.plan?.sha256??''}):\n${plan}\nDurable context:\n${JSON.stringify(context)}\nDuring coordination declare your files, contracts, approach and risks in declaration, claim existing exact files or reserve new exact paths, and propose a global allocation/interface decision. Acknowledge the exact latest rev and revHash only when you agree; never invent another peer's approval. Independent work may continue while an unrelated decision waits.\nAllowed commands: send_message, claim_file, reserve_path, declare_consumer, open_proposal, open_decision, amend_decision, ack_decision, request_transfer, consent_transfer (deferred until both peers end their turns); implementation also apply with ops. Every apply operation needs exact expected hash/type/mode (create uses absent:true), normalized paths and ownership/reservations. Operations are write/create/delete/rename/chmod; write/create carry bytes.\nReturn exactly one standalone fenced acp-swarm JSON object with {goal,declaration:{files,contracts,approach,risks},commands:[],outcome:"continue"|"done"|"question",question?,summary}. Done means your owned work is complete at the current epoch. Question waits for the user. Do not put authority fields in commands. Keep commands in execution order.\n`;
}
