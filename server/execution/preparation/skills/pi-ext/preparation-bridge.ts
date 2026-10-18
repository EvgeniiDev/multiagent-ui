/**
 * preparation-bridge.ts — Multiagent UI idea-preparation bridge extension for pi.
 *
 * Loaded with `pi --mode rpc -e <this file>` by scripts/preparation_binding_probe.mjs.
 * Three jobs, all configured by env (the probe is the policy owner):
 *
 *   1. `ask_user` — the host blocking-question tool upstream skills
 *      (ce-brainstorm / ce-plan / ce-doc-review / superpowers) look for by
 *      capability. In RPC mode ctx.ui.select/confirm/input become
 *      extension_ui_request frames on stdout and block until the client
 *      answers with a matching extension_ui_response — exactly the
 *      request-id-correlated dialog the preparation contract requires.
 *      The tool NEVER fabricates an answer: a cancelled/dismissed dialog
 *      returns an explicit "no answer" marker to the model.
 *
 *   2. tool_call containment — BEFORE any tool executes, file targets and
 *      bash path references are checked against the registered roots:
 *      ACP_PREP_WRITE_ROOTS (JSON array — the private document workspace +
 *      the skill's own /tmp/compound-engineering-<uid> scratch) and
 *      ACP_PREP_READ_ROOTS (additionally: skill dirs, read-only inputs).
 *      Escapes are blocked, not audited after the fact.
 *
 *   3. Audit log — every tool_call decision and every extension_ui dialog
 *      is appended as JSONL to ACP_PREP_AUDIT so the probe has a
 *      process-independent record alongside the RPC transcript.
 *
 * No third-party imports: parameters are a plain JSON-schema literal so the
 * extension resolves nothing beyond `import type` (erased at load).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { resolve, join, sep, isAbsolute, dirname, basename } from "node:path";

// Canonical filesystem view of a path — mirrors realpathNearest() in
// server/execution/preparation/skills/registry.mjs. Every existing component
// is followed through symlinks; a non-existent tail keeps its shape under the
// canonical nearest existing ancestor (where the kernel would create it). A
// dangling symlink still resolves through its link target. Throws on
// resolution errors — callers fail closed.
function realpathNearest(p: string, depth = 0): string {
	const abs = resolve(p);
	try {
		return realpathSync(abs);
	} catch (e: any) {
		if (e?.code !== "ENOENT" || depth > 40) throw e;
		let st: ReturnType<typeof lstatSync> | null = null;
		try { st = lstatSync(abs); } catch (e2: any) { if (e2?.code !== "ENOENT") throw e2; }
		if (st?.isSymbolicLink()) {
			return realpathNearest(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
		}
		const parent = dirname(abs);
		if (parent === abs) throw e;
		return join(realpathNearest(parent, depth + 1), basename(abs));
	}
}

const canonRoot = (p: string): string => { try { return realpathNearest(p); } catch { return resolve(p); } };
const WRITE_ROOTS: string[] = JSON.parse(process.env.ACP_PREP_WRITE_ROOTS ?? "[]").map(canonRoot);
const READ_ROOTS: string[] = [...WRITE_ROOTS, ...JSON.parse(process.env.ACP_PREP_READ_ROOTS ?? "[]").map(canonRoot)];
const AUDIT = process.env.ACP_PREP_AUDIT ?? "";
const BINDING = process.env.ACP_PREP_BINDING ?? "unknown";

function audit(kind: string, data: Record<string, unknown>): void {
	if (!AUDIT) return;
	try {
		appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), binding: BINDING, kind, ...data }) + "\n");
	} catch { /* audit loss must never crash the agent */ }
}

function underRoot(root: string, p: string): boolean {
	const r = resolve(root);
	const t = resolve(p);
	return t === r || t.startsWith(r + sep);
}

const inWrite = (p: string) => WRITE_ROOTS.some((r) => underRoot(r, p));
const inRead = (p: string) => READ_ROOTS.some((r) => underRoot(r, p));

const ABS_PATH_TOKEN = /(?:^|[\s'"`=;(])\/[A-Za-z0-9._~+@%=-][A-Za-z0-9._\/~+@%=-]*/g;
const GIT_MUTATING = /\bgit\b[^|;&]*\b(commit|add|push|pull|fetch|merge|rebase|reset|clean|checkout|switch|restore|tag|apply|am|mv|rm|init|worktree|config|remote|stash|cherry-pick|revert)\b/;
const BASH_DENY = /\b(sudo|doas|curl|wget|nc|ncat|socat|ssh|scp|rsync|ftp|telnet|docker|podman|systemctl|apt|apt-get|dpkg|snap|flatpak|pip|pip3|crontab|mount|umount|mkfs|chown|killall|pkill|eval)\b|npm\s+(install|publish|link)|pnpm\s+(install|publish)|yarn\s+(install|publish)|gem\s+install|cargo\s+install|chmod\s+777|dd\s+if=|git\s+(push|remote|config|worktree|submodule|bundle|gc)\b/;

// --- bash segment audit — same policy as auditBashCommand in registry.mjs --
// Segments split on shell separators; `cd` is tracked so relative operands
// resolve where they would run; every non-flag word is a candidate path
// canonicalized via realpathNearest — read floor for plain words, write
// floor for redirect targets and mutating-command operands. Program-text
// surfaces (interpreter -c/-e, watch/xargs strings, find -exec) fail closed.

const SEGMENT_SPLIT = /&&|\|\||[|;&()\n`]+/;
const WORD_RE = /"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HOME_TOK = /^~([A-Za-z0-9_-]*)(\/|$)/;
const HEREDOC_MARK = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const MUT_ALL = new Set(["ln", "link", "symlink", "mv", "rename", "rm", "rmdir", "unlink",
	"mkdir", "mkfifo", "mknod", "mktemp", "touch", "truncate", "shred", "chmod", "chattr",
	"chown", "chgrp", "tee"]);
const COPY_LIKE = new Set(["cp", "install"]);
const CP_LINK_FLAGS = /^-[a-zA-Z]*[sldPa]|^--(symbolic-link|link|no-dereference|preserve|archive|backup)/;
const DIRFLAG_CMDS = new Set(["tar", "bsdtar", "unzip", "7z", "7zz", "jar"]);
const CONSUME_WRITE = new Set(["-t", "--target-directory", "-C", "--directory", "-d", "-o", "--output", "--out"]);
const GIT_DIR_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path"]);
const WRITE_EQ_FLAG = /^-{1,2}(o|out|output|output-file|to|t|target-directory|directory|d|git-dir|work-tree|exec-path)$/;
const INPLACE = /^-[^-]*i|^--in-place/;
const INPLACE_CMDS = new Set(["sed", "gsed", "perl"]);

const ALWAYS_BLOCK = new Set(["awk", "gawk", "mawk", "nawk", "busybox", "tclsh", "expect", "jjs",
	"osascript", "screen", "tmux", "at", "batch", "systemd-run", "su", "newgrp", "sg", "chroot",
	"unshare", "nsenter", "gdb", "lldb", "strace", "ltrace", "npx", "bunx", "pnpx", "make", "rake",
	"mvn", "mvnw", "gradle", "gradlew", "ant", "just", "task"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "ksh", "csh", "tcsh", "fish", "pwsh", "powershell", "sash"]);
const INTERPRETERS = new Set([...SHELLS, "perl", "php", "lua", "luajit", "node", "nodejs", "deno",
	"bun", "ruby", "julia", "groovy", "elixir", "erl", "r", "rscript", "python", "python2", "python3"]);
const EVAL_FLAG = /^-[a-zA-Z]*[ecpmirs]|^--(?:eval|command|module)/;
const STDIN_ARG = new Set(["-", "-s", "-i", "--stdin", "--interactive"]);
const RUNNER_SUBS: Record<string, string[]> = {
	npm: ["run", "exec", "test", "start", "restart", "stop", "init", "create", "add", "i", "x", "explore"],
	pnpm: ["run", "exec", "test", "start", "dlx", "create", "add", "i", "x"],
	yarn: ["run", "dlx", "test", "start", "exec", "create", "add", "node"],
	bun: ["run", "x", "test", "create", "exec", "eval", "add"],
	deno: ["eval", "task", "test", "bench", "run", "compile"],
	cargo: ["run", "test", "bench", "install", "script", "build", "doc"],
	go: ["run", "test", "generate", "tool", "install", "build"],
};
const WRAPPERS = new Set(["env", "nice", "ionice", "taskset", "chrt", "numactl", "timeout", "watch",
	"stdbuf", "nohup", "setsid", "command", "builtin", "exec", "time", "xargs", "parallel"]);
const KNOWN_CMDS = new Set([...INTERPRETERS, ...ALWAYS_BLOCK, ...MUT_ALL, ...COPY_LIKE,
	...DIRFLAG_CMDS, ...WRAPPERS, ...Object.keys(RUNNER_SUBS),
	"cd", "pushd", "popd", "git", "find", "sed", "cat", "source", ".", "ls", "grep", "head", "tail"]);
const FIND_DANGER = /^-(exec|execdir|ok|okdir|delete|fprintf|fprint)$/;

const unquote = (w: string): string =>
	w.length >= 2 && ((w[0] === '"' && w.endsWith('"')) || (w[0] === "'" && w.endsWith("'")))
		? w.slice(1, -1) : w;

type Decision = Record<string, unknown> | undefined;
interface BashCtx { mutating: boolean; wsRoot: string }

function auditSegment(words: string[], state: { cwd: string }, ctx: BashCtx, depth = 0): Decision {
	const { mutating } = ctx;
	const fail = (reason: string): Decision => ({ block: true, reason });
	const checkPath = (word: string, write: boolean, label: string): Decision => {
		// /dev/null is a sink/source device, not a file.
		if (word === "/dev/null") return undefined;
		if (HOME_TOK.test(word)) return fail(`preparation containment: bash ${label} ${word} expands outside registered roots`);
		let real: string;
		try {
			real = realpathNearest(isAbsolute(word) ? word : resolve(state.cwd, word));
		} catch (e: any) {
			return fail(`preparation containment: cannot resolve bash ${label} ${word} (${e?.code ?? e?.message ?? e})`);
		}
		if (!(write ? inWrite(real) : inRead(real))) {
			return fail(`preparation containment: bash ${label} ${word} resolves outside allowed roots (${real})`);
		}
		return undefined;
	};

	let s = 0;
	while (s < words.length && ASSIGN_RE.test(words[s])) {
		const rhs = words[s].slice(words[s].indexOf("=") + 1);
		if (rhs.length) {
			const bad = checkPath(rhs, false, "env assignment"); if (bad) return bad;
		}
		s++;
	}
	if (s >= words.length) return undefined;
	const cmdName = basename(words[s]);
	const ops = words.slice(s + 1);

	for (let j = s; j < words.length; j++) {
		const w = words[j];
		for (const m of w.matchAll(/>>?(&\d+)?([^\s<>&]*)/g)) {
			if (m[1]) continue;
			const t = m[2] || words[j + 1];
			if (t === undefined || t === "/dev/null") continue;
			const bad = checkPath(t, true, "redirect target"); if (bad) return bad;
		}
		for (const m of w.matchAll(/<<<?(&\d+)?([^\s<>&]*)/g)) {
			if (m[1]) continue;
			if (m[0].startsWith("<<<")) continue;
			const t = m[2] || words[j + 1];
			if (t === undefined || t === "/dev/null") continue;
			if (m[0].startsWith("<<") && HEREDOC_MARK.test(t)) continue;
			const bad = checkPath(t, false, "redirect source"); if (bad) return bad;
		}
	}

	if (ALWAYS_BLOCK.has(cmdName)) return fail(`preparation containment: ${cmdName} is not auditable`);
	const subs = RUNNER_SUBS[cmdName];
	if (subs) {
		const first = ops.find((w) => !w.startsWith("-"));
		if (first && subs.includes(first)) return fail(`preparation containment: ${cmdName} ${first} executes workspace-defined commands`);
	}
	if (INTERPRETERS.has(cmdName)) {
		const evalFlag = ops.some((w) => EVAL_FLAG.test(w) || STDIN_ARG.has(w));
		const script = ops.find((w) => !w.startsWith("-"));
		if (evalFlag || !script) return fail(`preparation containment: ${cmdName} inline/stdin code is not auditable`);
	}
	if (cmdName === "find" && ops.some((w) => FIND_DANGER.test(w))) {
		return fail("preparation containment: find -exec/-delete is not auditable");
	}
	if (WRAPPERS.has(cmdName)) {
		if (depth > 8 || ops.some((w) => /\s/.test(w))) {
			return fail(`preparation containment: ${cmdName} program string is not auditable`);
		}
		const inner = ops.findIndex((w) => KNOWN_CMDS.has(basename(w)));
		if (inner >= 0) {
			const bad = auditSegment(ops.slice(inner), state, ctx, depth + 1);
			if (bad) return bad;
		}
	}

	const hasLinkFlag = COPY_LIKE.has(cmdName) && ops.some((w) => CP_LINK_FLAGS.test(w));
	const hasInPlace = INPLACE_CMDS.has(cmdName) && ops.some((w) => INPLACE.test(w));
	const plain = ops.filter((w) => !w.startsWith("-"));

	if (cmdName === "cd" || cmdName === "pushd") {
		const t = plain[0];
		if (t === undefined || t === "-" || HOME_TOK.test(t)) {
			return fail(`preparation containment: ${cmdName} target is outside registered roots`);
		}
		let real: string;
		try { real = realpathNearest(isAbsolute(t) ? t : resolve(state.cwd, t)); }
		catch (e: any) { return fail(`preparation containment: cannot resolve ${cmdName} target ${t} (${e?.code ?? e?.message ?? e})`); }
		if (!inRead(real)) return fail(`preparation containment: ${cmdName} ${t} resolves outside allowed roots (${real})`);
		state.cwd = real;
	} else if (cmdName === "popd") {
		return fail("preparation containment: popd target is not auditable");
	}

	let pendingWrite = false;
	for (let i = 0; i < ops.length; i++) {
		const w = ops[i];
		if (w.startsWith("-")) {
			if (GIT_DIR_FLAGS.has(w) && (mutating || cmdName !== "git") && CONSUME_WRITE.has(w)) pendingWrite = true;
			else if (CONSUME_WRITE.has(w) && (cmdName !== "git" || mutating)) pendingWrite = true;
			else if (DIRFLAG_CMDS.has(cmdName) && CONSUME_WRITE.has(w)) pendingWrite = true;
			const eq = w.indexOf("=");
			if (eq > 1) {
				const flag = w.slice(0, eq);
				const rhs = w.slice(eq + 1);
				const write = mutating || WRITE_EQ_FLAG.test(flag) || MUT_ALL.has(cmdName);
				const bad = checkPath(rhs, write, "flag value"); if (bad) return bad;
			}
			continue;
		}
		if (pendingWrite && ASSIGN_RE.test(w)) pendingWrite = false;
		const isAssign = ASSIGN_RE.test(w);
		const word = isAssign ? w.slice(w.indexOf("=") + 1) : w;
		if (isAssign && !word.length) continue;
		const needWrite = pendingWrite
			|| (mutating && cmdName === "git")
			|| MUT_ALL.has(cmdName)
			|| hasInPlace
			|| cmdName === "tee"
			|| (COPY_LIKE.has(cmdName) && (hasLinkFlag || w === plain[plain.length - 1]));
		pendingWrite = false;
		const bad = checkPath(word, needWrite, "path"); if (bad) return bad;
	}
	return undefined;
}

function auditBash(cmd: string, wsRoot: string): Decision {
	const mutating = GIT_MUTATING.test(cmd);
	const tokens = cmd.match(ABS_PATH_TOKEN) ?? [];
	for (const raw of tokens) {
		const tok = raw.replace(/^[\s'"`=;(]+/, "");
		if (!tok.startsWith("/") || tok === "/dev/null") continue;
		let real: string;
		try { real = realpathNearest(tok); }
		catch (e: any) { return { block: true, reason: `preparation containment: cannot resolve bash path ${tok} (${e?.code ?? e?.message ?? e})` }; }
		if (mutating ? !inWrite(real) : !inRead(real)) {
			return { block: true, reason: `preparation containment: bash ${mutating ? "mutating git target" : "path"} ${tok} resolves outside allowed roots (${real})` };
		}
	}
	const ctx: BashCtx = { mutating, wsRoot };
	const state = { cwd: wsRoot };
	for (const seg of cmd.split(SEGMENT_SPLIT)) {
		const words = (seg.match(WORD_RE) ?? []).map(unquote).filter((w) => w.length);
		const bad = auditSegment(words, state, ctx);
		if (bad) return bad;
	}
	return undefined;
}

const OTHER_OPTION = "✏️  Type a different answer";

export default function preparationBridge(pi: ExtensionAPI) {
	// --- blocking question tool ------------------------------------------
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user a blocking question and wait for their answer. This is the host's blocking question tool: use it for every decision the user must make — clarifying questions, option menus, yes/no confirmations, and approval gates. Pass options for a single-select menu (a free-text \"Other\" choice is added automatically), kind='confirm' for yes/no, or omit options for a free-text answer. Never narrate a user-decision question as plain text when this tool is available.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question to ask the user" },
				options: {
					type: "array",
					items: {
						anyOf: [
							{ type: "string" },
							{ type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
						],
					},
					description: "Single-select options (strings or {label, description}); omit for a free-text answer",
				},
				kind: {
					type: "string",
					enum: ["select", "input", "confirm"],
					description: "Question form; inferred from options when omitted",
				},
			},
			required: ["question"],
			additionalProperties: false,
		},
		executionMode: "sequential",
		async execute(_toolCallId: string, params: { question: string; options?: Array<string | { label?: string; description?: string }>; kind?: "select" | "input" | "confirm" }, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const question = String(params.question ?? "");
			const options = (Array.isArray(params.options) ? params.options : [])
				.map((o) => (typeof o === "string" ? o : typeof o?.label === "string" ? o.label : ""))
				.filter((o) => o.length);
			const kind = params.kind ?? (options.length ? "select" : "input");
			audit("ask_user", { question, options, kind });

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "NO_USER_ANSWER: interactive UI unavailable in this run mode" }],
					details: { question, answer: null, cancelled: true, unavailable: true },
				};
			}

			let answer: string | null = null;
			let confirmed: boolean | null = null;
			if (kind === "confirm") {
				const ok = await ctx.ui.confirm(question, "");
				confirmed = ok === true;
				answer = ok === true ? "yes" : ok === false ? "no" : null;
			} else if (kind === "select") {
				const choice = await ctx.ui.select(question, [...options, OTHER_OPTION]);
				if (choice === OTHER_OPTION) {
					const typed = await ctx.ui.input(question, "your answer");
					answer = typeof typed === "string" && typed.trim() ? typed.trim() : null;
				} else {
					answer = typeof choice === "string" ? choice : null;
				}
			} else {
				const typed = await ctx.ui.input(question, "");
				answer = typeof typed === "string" && typed.trim() ? typed.trim() : null;
			}

			audit("ask_user_answer", { question, answer, confirmed });
			if (answer === null) {
				return {
					content: [{ type: "text", text: "NO_USER_ANSWER: the user dismissed or did not answer this question" }],
					details: { question, answer: null, cancelled: true },
				};
			}
			return {
				content: [{ type: "text", text: `User answer: ${answer}` }],
				details: { question, answer, confirmed },
			};
		},
	});

	// --- containment guard ------------------------------------------------
	pi.on("tool_call", async (event: any, ctx: any) => {
		const name = String(event.toolName ?? "");
		const args = event.input ?? {};
		let decision: Record<string, unknown> | undefined;
		const wsRoot = canonRoot(String(ctx.cwd ?? process.cwd()));
		// Resolve a target the way the kernel will: absolute or cwd-relative,
		// then through every existing symlink — so an in-workspace link cannot
		// launder an out-of-scope target.
		const resolveTarget = (p: string) =>
			realpathNearest(isAbsolute(p) ? p : resolve(wsRoot, p));

		if (name === "write" || name === "edit") {
			const p = String(args.path ?? args.file ?? args.filePath ?? args.target_file ?? "");
			if (!p) {
				decision = { block: true, reason: `preparation containment: ${name} missing target path` };
			} else {
				let resolved: string;
				try {
					resolved = resolveTarget(p);
				} catch (e: any) {
					decision = { block: true, reason: `preparation containment: cannot resolve ${name} target ${p} (${e?.code ?? e?.message ?? e})` };
					resolved = "";
				}
				if (!decision && !inWrite(resolved)) {
					decision = { block: true, reason: `preparation containment: ${name} target ${p} resolves outside the document workspace (${resolved})` };
				}
			}
		} else if (name === "read") {
			const p = String(args.path ?? args.file ?? args.filePath ?? "");
			if (p) {
				let resolved: string;
				try {
					resolved = resolveTarget(p);
				} catch (e: any) {
					decision = { block: true, reason: `preparation containment: cannot resolve read target ${p} (${e?.code ?? e?.message ?? e})` };
					resolved = "";
				}
				if (!decision && !inRead(resolved)) {
					decision = { block: true, reason: `preparation containment: read target ${p} resolves outside registered roots (${resolved})` };
				}
			}
		} else if (name === "bash") {
			const cmd = String(args.command ?? "");
			const deny = cmd.match(BASH_DENY);
			if (deny) {
				decision = { block: true, reason: `preparation containment: denied operation "${deny[0]}"` };
			} else {
				decision = auditBash(cmd, wsRoot);
			}
		}

		audit("tool_call", { tool: name, blocked: !!decision?.block, reason: decision?.reason ?? null });
		return decision;
	});

	pi.on("session_start", async (_e: unknown, ctx: any) => {
		audit("session_start", { cwd: ctx.cwd ?? null, mode: ctx.mode });
	});
}
