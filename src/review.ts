/*
 * review.ts — PURE port of tools/hunking_obsidian.py's markdown renderer.
 *
 * No Obsidian imports: this module takes already-grouped File Recovery snapshots and
 * returns the LLM-ready weekly-review markdown. Keeping it Obsidian-free lets it run in
 * Node for parity tests against the Python "golden oracle" (see test/review.test.ts).
 *
 * Ported 1:1 from hunking_obsidian.py: sync_seconds, pair_volume, activity_table,
 * sync_summary, heading_aware_diff, render. Diffs use jsdiff (structuredPatch) instead of
 * Python difflib; hunk boundaries may differ slightly but +/- content is equivalent.
 */
import { structuredPatch } from 'diff';

/** One File Recovery snapshot. `ts` is epoch milliseconds. */
export interface Snapshot {
	ts: number;
	data: string;
}

export interface RenderOptions {
	/** "now" in epoch ms — drives the window cutoff and the generated stamp (injectable for tests). */
	now: number;
	/** Only the last N days (0 = all). */
	sinceDays: number;
	/** Context lines per hunk. */
	context?: number;
	/** One first→last diff per note (true) vs every consecutive pair (false). */
	net?: boolean;
	/** Notes whose newest version is under this many chars are shown in full instead of diffed. */
	fullBelow?: number;
	/** Distinct notes sharing one second ≥ this ⇒ treated as a bulk sync, excluded from metrics. */
	syncThreshold?: number;
	/** Include the per-day activity table + sync summary. */
	withMeta?: boolean;
	/** Paths that have snapshots but no longer exist in the vault — listed separately, not diffed. */
	deletedPaths?: Set<string>;
	/** Paths whose file was created within the window — genuinely new, so diffed against empty. */
	newPaths?: Set<string>;
}

/** path → snapshots sorted ascending by ts. */
export type SnapshotsByPath = Map<string, Snapshot[]>;

const HEADING = /^\s{0,3}#{1,6}\s/;
const DAY_MS = 86_400_000;

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Local-time "YYYY-MM-DD HH:MM:SS" (matches Python iso(); tests pin TZ for determinism). */
function iso(ms: number): string {
	const d = new Date(ms);
	return (
		`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
		`${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
	);
}

function dateKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Python str.splitlines(): split on line boundaries, drop a single trailing newline's empty tail. */
function splitlines(s: string): string[] {
	if (s === '') return [];
	const parts = s.split(/\r\n|\r|\n/);
	if (parts.length > 0 && parts[parts.length - 1] === '' && /[\r\n]$/.test(s)) parts.pop();
	return parts;
}

const rstrip = (s: string): string => s.replace(/\s+$/, '');

/**
 * Collapse the differences editors/sync introduce without real authoring — trailing whitespace
 * per line, trailing blank lines, line-ending style, and Unicode form — so a genuine edit can be
 * told apart from an opened/auto-saved/synced note. Used only for change detection, never for the
 * rendered diff. (Opening a note can rewrite trailing whitespace on every line, which otherwise
 * shows as a full delete-then-readd of identical-looking text.)
 */
export function normalizeForCompare(s: string): string {
	return s
		.normalize('NFC')
		.split(/\r\n|\r|\n/)
		.map((l) => l.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n+$/, '');
}

/**
 * Fill the prompt template's placeholders. Empty/whitespace templates render to '' so the caller can
 * skip prepending entirely. Unknown `{{…}}` tokens are left untouched.
 *
 *   {{time}}          → local wall-clock time      (e.g. "3:42 PM")
 *   {{date}}          → today, spelled out          (e.g. "Sunday, July 27, 2026")
 *   {{window}}        → the window's label           (e.g. "7 days")
 *   {{window_start}}  → the date the window opened   (now − window length), spelled out
 */
export function renderPromptTemplate(template: string, nowMs: number, windowMs: number, windowLabel: string): string {
	if (!template.trim()) return '';
	const now = new Date(nowMs);
	const start = new Date(nowMs - windowMs);
	const dateFmt: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
	const values: Record<string, string> = {
		time: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
		date: now.toLocaleDateString(undefined, dateFmt),
		window: windowLabel,
		window_start: start.toLocaleDateString(undefined, dateFmt),
	};
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (key in values ? values[key]! : match));
}

/** Seconds where ≥ threshold distinct notes were captured — bulk sync, not live authoring. */
function syncSeconds(byPath: SnapshotsByPath, threshold: number): Set<number> {
	const bySec = new Map<number, Set<string>>();
	for (const [path, versions] of byPath) {
		for (const s of versions) {
			const sec = Math.floor(s.ts / 1000);
			let set = bySec.get(sec);
			if (!set) bySec.set(sec, (set = new Set()));
			set.add(path);
		}
	}
	const out = new Set<number>();
	for (const [sec, paths] of bySec) if (paths.size >= threshold) out.add(sec);
	return out;
}

/** [added chars, removed chars] between two texts (line-based, matches pair_volume). */
function pairVolume(a: string, b: string): [number, number] {
	const patch = structuredPatch('a', 'b', a, b, '', '', { context: 0 });
	let add = 0;
	let rem = 0;
	for (const h of patch.hunks) {
		for (const ln of h.lines) {
			if (ln.startsWith('+')) add += ln.length - 1;
			else if (ln.startsWith('-')) rem += ln.length - 1;
		}
	}
	return [add, rem];
}

interface Day {
	notes: Set<string>;
	edits: number;
	add: number;
	rem: number;
	hours: number[];
}

function activityTable(byPath: SnapshotsByPath, cutoffMs: number, syncSecs: Set<number>): string {
	const days = new Map<string, Day>();
	for (const versions of byPath.values()) {
		versions.forEach((s, i) => {
			if (s.ts < cutoffMs || syncSecs.has(Math.floor(s.ts / 1000))) return;
			const key = dateKey(s.ts);
			let d = days.get(key);
			if (!d) days.set(key, (d = { notes: new Set(), edits: 0, add: 0, rem: 0, hours: [] }));
			d.edits += 1;
			d.hours.push(new Date(s.ts).getHours());
			// note path lives on the outer entry; add it below via the Map key loop instead.
			if (i > 0) {
				const prev = versions[i - 1]!;
				const [a, r] = pairVolume(prev.data, s.data);
				d.add += a;
				d.rem += r;
			}
		});
	}
	// notes-per-day needs the path; recompute the note set in a second pass keyed by path.
	for (const [path, versions] of byPath) {
		for (const s of versions) {
			if (s.ts < cutoffMs || syncSecs.has(Math.floor(s.ts / 1000))) continue;
			days.get(dateKey(s.ts))!.notes.add(path);
		}
	}
	if (days.size === 0) return '## Activity by day\n\n_no live (non-sync) edits in window._\n';
	const rows = [
		'| Date | Notes | Edits | +chars | −chars | Active hrs | Late-night |',
		'|------|------:|------:|-------:|-------:|------------|:----------:|',
	];
	for (const date of [...days.keys()].sort()) {
		const d = days.get(date)!;
		const hrs = [...d.hours].sort((x, y) => x - y);
		const span = `${p2(hrs[0]!)}:00–${p2(hrs[hrs.length - 1]!)}:59`;
		const late = hrs.some((h) => h >= 0 && h < 6) ? '⚠️' : '';
		rows.push(
			`| ${date} | ${d.notes.size} | ${d.edits} | ${d.add} | ${d.rem} | ${span} | ${late} |`,
		);
	}
	return (
		'## Activity by day\n\n_(live edits only; bulk syncs excluded — see below)_\n\n' +
		rows.join('\n') +
		'\n'
	);
}

function syncSummary(byPath: SnapshotsByPath, cutoffMs: number, syncSecs: Set<number>): string {
	const bursts = new Map<number, Set<string>>();
	for (const [path, versions] of byPath) {
		for (const s of versions) {
			const sec = Math.floor(s.ts / 1000);
			if (s.ts >= cutoffMs && syncSecs.has(sec)) {
				let set = bursts.get(sec);
				if (!set) bursts.set(sec, (set = new Set()));
				set.add(path);
			}
		}
	}
	if (bursts.size === 0) return '';
	const lines = [...bursts.keys()]
		.sort((a, b) => a - b)
		.map((sec) => `- ${iso(sec * 1000).slice(0, 16)} — ${bursts.get(sec)!.size} notes captured together`);
	return (
		'## Sync events (bulk captures — excluded from metrics)\n\n' +
		'_These notes changed elsewhere and synced in at one timestamp; their diffs ' +
		'still appear below but their timing is not real-time activity._\n\n' +
		lines.join('\n') +
		'\n'
	);
}

/** difflib-style range: omit count when 1; empty range begins one line earlier. */
function fmtRange(start: number, len: number): string {
	if (len === 1) return `${start}`;
	if (len === 0) return `${start - 1},0`;
	return `${start},${len}`;
}

/** Unified diff annotated with the nearest Markdown heading on each @@ line. '' if no change. */
function headingAwareDiff(
	textA: string,
	textB: string,
	context: number,
	fromLabel: string,
	toLabel: string,
): string {
	const patch = structuredPatch(fromLabel, toLabel, textA, textB, '', '', { context });
	if (patch.hunks.length === 0) return '';
	const linesB = splitlines(textB);
	const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
	for (const h of patch.hunks) {
		let header = `@@ -${fmtRange(h.oldStart, h.oldLines)} +${fmtRange(h.newStart, h.newLines)} @@`;
		const start = Math.max(h.newStart - 1, 0);
		let heading = '';
		for (let i = Math.min(start, linesB.length - 1); i >= 0; i--) {
			if (HEADING.test(linesB[i]!)) {
				heading = linesB[i]!.trim();
				break;
			}
		}
		if (heading) header += ` ${heading}`;
		out.push(header);
		for (const ln of h.lines) {
			if (ln.startsWith('\\')) continue; // "\ No newline at end of file"
			out.push(ln);
		}
	}
	return out.join('\n');
}

/** Render the full LLM-ready weekly review. Mirrors hunking_obsidian.py render() (md format). */
export function renderReview(byPath: SnapshotsByPath, opts: RenderOptions): string {
	const context = opts.context ?? 3;
	const net = opts.net ?? true;
	const fullBelow = opts.fullBelow ?? 4000;
	const syncThreshold = opts.syncThreshold ?? 4;
	const withMeta = opts.withMeta ?? true;
	const cutoffMs = opts.sinceDays ? opts.now - opts.sinceDays * DAY_MS : 0;
	const syncSecs = syncSeconds(byPath, syncThreshold);

	const parts: string[] = [];
	let total = 0;
	for (const v of byPath.values()) total += v.length;
	parts.push(
		`# Hunking Obsidian\n\n_generated ${iso(opts.now)} · ${total} snapshots across ${byPath.size} notes_\n`,
	);
	if (withMeta) {
		parts.push(activityTable(byPath, cutoffMs, syncSecs));
		parts.push(syncSummary(byPath, cutoffMs, syncSecs));
	}

	const ranked = [...byPath.entries()]
		.filter(([, v]) => v[v.length - 1]!.ts >= cutoffMs)
		.sort((a, b) => b[1][b[1].length - 1]!.ts - a[1][a[1].length - 1]!.ts);

	const deleted = opts.deletedPaths ?? new Set<string>();
	const newPaths = opts.newPaths ?? new Set<string>();
	const deletedInWindow: string[] = [];

	for (const [path, versions] of ranked) {
		if (deleted.has(path)) {
			deletedInWindow.push(path); // collect for the bottom section; don't diff a gone note
			continue;
		}
		const inWin = versions.filter((s) => s.ts >= cutoffMs);
		let pre: Snapshot | null = null;
		for (let i = versions.length - 1; i >= 0; i--) {
			if (versions[i]!.ts < cutoffMs) {
				pre = versions[i]!;
				break;
			}
		}
		const head = inWin[inWin.length - 1]!;
		const editN = inWin.length;
		// One-line title; per-diff timestamps live in the diff's --- / +++ header rows.
		const title = `\n## ${path} — ${editN} edit${editN === 1 ? '' : 's'} in window\n`;

		if (head.data.length < fullBelow) {
			parts.push(title);
			parts.push('_current content:_\n\n```markdown\n' + rstrip(head.data) + '\n```\n');
			continue;
		}

		// Baseline: the last pre-window snapshot if we have one; otherwise the earliest in-window
		// snapshot — UNLESS the file was created within the window (newPaths), in which case it is
		// genuinely new and we diff against empty so its whole body shows as additions. Opening,
		// auto-saving, or syncing an old note creates an in-window snapshot with no real change;
		// those resolve to an empty diff and are dropped below.
		const NEW = '(new file)';
		type Side = { label: string; data: string };
		const base: Side = pre
			? { label: iso(pre.ts), data: pre.data }
			: newPaths.has(path)
				? { label: NEW, data: '' }
				: { label: iso(inWin[0]!.ts), data: inWin[0]!.data };
		let spans: Array<[Side, Side]>;
		if (net) {
			spans = [[base, { label: iso(head.ts), data: head.data }]];
		} else {
			// walk consecutive snapshots, prefixed by the baseline (don't re-list the earliest
			// in-window snapshot when it already *is* the baseline).
			const tail = pre || newPaths.has(path) ? inWin : inWin.slice(1);
			const chain: Side[] = [base, ...tail.map((s) => ({ label: iso(s.ts), data: s.data }))];
			spans = chain.slice(0, -1).map((s, i) => [s, chain[i + 1]!]);
		}

		const body: string[] = [];
		let changed = false;
		for (const [from, to] of spans) {
			const diff = headingAwareDiff(from.data, to.data, context, from.label, to.label);
			// A change only counts if it survives whitespace/encoding normalization — a pure
			// whitespace rewrite (full delete + identical readd) is not a real edit.
			if (diff && normalizeForCompare(from.data) !== normalizeForCompare(to.data)) changed = true;
			body.push(`\`\`\`diff\n${diff || '(no textual change)'}\n\`\`\`\n`);
		}
		if (!changed) continue; // opened / auto-saved / synced but not actually edited → omit
		parts.push(title, ...body);
	}

	if (deletedInWindow.length > 0) {
		parts.push(
			'\n## Deleted notes\n\n_Edited in the window but no longer in the vault (deleted or renamed)._\n\n' +
				deletedInWindow.map((p) => `- ${p}`).join('\n') +
				'\n',
		);
	}

	return parts.join('\n');
}

/**
 * Fold each note's *current on-disk* content in as the newest version.
 *
 * File Recovery snapshots lag the live file — a freshly created note often has only an empty
 * snapshot captured at creation, so the newest snapshot can be 0 chars while the file is full.
 * The current content is what the user actually wants to review, so we append it (matching what
 * kometenstaub/obsidian-version-history-diff does). Only augments notes that already have snapshot
 * history; skips when the content equals the newest snapshot (no real change since it was taken).
 */
export function mergeCurrentContent(
	byPath: SnapshotsByPath,
	currents: Map<string, { mtime: number; data: string }>,
): SnapshotsByPath {
	for (const [path, cur] of currents) {
		const versions = byPath.get(path);
		if (!versions || versions.length === 0) continue;
		const newest = versions[versions.length - 1]!;
		if (newest.data !== cur.data) {
			// Guard against clock/iCloud mtime skew so the live content always sorts last.
			versions.push({ ts: Math.max(cur.mtime, newest.ts + 1), data: cur.data });
		}
	}
	return byPath;
}

/**
 * True if a note path is one of Microlite's own generated outputs, so we never fold our own
 * review notes back into future hunks. Matches anything inside the configured output folder, plus
 * the generated `microlite-hunks-*.md` filename anywhere (covers a root output folder or a
 * renamed folder).
 */
export function isOwnOutput(path: string, outputFolder: string): boolean {
	const folder = outputFolder.replace(/^\/+|\/+$/g, '');
	if (folder && (path === folder || path.startsWith(`${folder}/`))) return true;
	const base = path.split('/').pop() ?? path;
	return /^microlite-hunks-.*\.md$/.test(base);
}

/**
 * How similar a missing note's last snapshot must be to a live file before we call it the same
 * note under a new name. Git's default is 50%; we want far less room for a false positive here
 * (a template, or a note duplicated and then edited), so a rename has to be near-verbatim.
 */
export const RENAME_MIN_SIMILARITY = 0.98;

/**
 * The absolute half of the tolerance, in characters. A pure ratio has no slack left on a short
 * note — 2% of a 600-character note is twelve characters, so fixing one sentence after renaming it
 * would read as a different note — which is the usual reason a relative tolerance is paired with an
 * absolute one (`rel_tol` + `abs_tol` in Python's `math.isclose`, `rtol` + `atol` in NumPy). This is
 * the floor on how much drift a note of *any* size is allowed: roughly a line or two.
 */
export const RENAME_SLACK_CHARS = 120;

/**
 * ...and the clamp that keeps the absolute slack from swallowing a tiny note whole. On a
 * 200-character note the slack alone would permit a 60% rewrite, so no note, however short, is ever
 * matched below this score. (Still well above git's 50% default.)
 */
export const RENAME_MIN_SIMILARITY_FLOOR = 0.8;

/**
 * The score a pair of texts whose larger side is `size` characters must actually reach: the looser
 * of the relative and absolute tolerances, clamped at the floor. Constant at `minScore` for notes
 * big enough that 2% exceeds the slack (~6 KB and up), relaxing smoothly to the floor for short
 * ones, so a one-line edit costs a short note roughly what it costs a long one.
 */
export function renameThreshold(size: number, minScore: number = RENAME_MIN_SIMILARITY): number {
	if (size <= 0) return minScore;
	const allowedDrift = Math.max(RENAME_SLACK_CHARS, (1 - minScore) * size);
	return Math.max(RENAME_MIN_SIMILARITY_FLOOR, 1 - allowedDrift / size);
}

/**
 * Git's similarity score, in [0, 1]: the share of the *larger* text that both texts have in
 * common, counted over whole lines. Mirrors `estimate_similarity` in git's diffcore-rename.c —
 * `copied / max(src, dst)` — so identical texts score 1, and inserting n characters into an
 * m-character note scores m / (m + n). Lines are matched as a multiset, so moving a paragraph
 * costs nothing and duplicating one is only counted once.
 */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const max = Math.max(a.length, b.length);
	if (max === 0) return 1;
	const pool = new Map<string, number>();
	for (const line of splitlines(a)) pool.set(line, (pool.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of splitlines(b)) {
		const left = pool.get(line) ?? 0;
		if (left === 0) continue;
		pool.set(line, left - 1);
		common += line.length + 1; // the line, plus the newline that followed it
	}
	return Math.min(common, max) / max;
}

/**
 * Git's cheap pre-filter (same file): two texts whose lengths differ by more than the score allows
 * can never reach it, since the score is at most `min / max`. Lets the caller skip reading a file.
 */
export function couldBeRenameBySize(a: number, b: number, minScore: number = RENAME_MIN_SIMILARITY): boolean {
	const max = Math.max(a, b);
	return max === 0 ? true : Math.min(a, b) / max >= renameThreshold(max, minScore);
}

/** A live vault file offered as a possible rename target, with its current content. */
export interface RenameCandidate {
	path: string;
	data: string;
}

/**
 * Link snapshots whose original path no longer exists to the live file that now holds their
 * content — i.e. detect renames. File Recovery keys snapshots by path and does not migrate them on
 * rename, so a created-then-renamed note's history sits under the old path (often with quirks like
 * a doubled `.md.md` extension) while the current file has little or no history under its new name.
 *
 * Matching follows git's rename detection: an exact-content pass first, then a similarity pass that
 * pairs each still-missing path with its best-scoring candidate at or above `renameThreshold`.
 * Pairing is one-to-one — a live file can only be the new name of one missing note — and ties go to
 * the lexicographically first path so the output is deterministic. Content is compared after
 * `normalizeForCompare`, so a rename that only rewrote line endings still counts as exact.
 *
 * A candidate is compared on two texts: its live content, and its *earliest* snapshot under the new
 * name, if File Recovery captured one. The earliest new-name snapshot is usually taken moments after
 * the rename, so it still looks like the old path's last snapshot no matter how much was written
 * afterwards — which is what lets a note that was renamed and then heavily rewritten still be
 * recognized, since the live content alone would have drifted far out of range.
 *
 * Matched snapshots are re-keyed onto that path (merged with any it already has, sorted by ts) and
 * removed from `deletedPaths`; unmatched paths stay deleted.
 */
export function resolveRenames(
	byPath: SnapshotsByPath,
	deletedPaths: Set<string>,
	candidates: Iterable<RenameCandidate>,
	minScore: number = RENAME_MIN_SIMILARITY,
): void {
	const missing: Array<{ path: string; data: string }> = [];
	for (const oldPath of deletedPaths) {
		const versions = byPath.get(oldPath);
		if (!versions || versions.length === 0) continue;
		missing.push({ path: oldPath, data: normalizeForCompare(versions[versions.length - 1]!.data) });
	}
	if (missing.length === 0) return;

	// Each candidate's comparable faces: what it holds now, and what it held when it first appeared.
	const pool = [...candidates].map((c) => {
		const live = normalizeForCompare(c.data);
		const own = byPath.get(c.path);
		const first = own && own.length > 0 ? normalizeForCompare(own[0]!.data) : live;
		return { path: c.path, texts: first === live ? [live] : [live, first] };
	});

	const rekey = (oldPath: string, target: string): void => {
		const versions = byPath.get(oldPath)!;
		const existing = byPath.get(target) ?? [];
		byPath.set(target, [...existing, ...versions].sort((a, b) => a.ts - b.ts));
		byPath.delete(oldPath);
		deletedPaths.delete(oldPath);
	};
	const claimed = new Set<string>();

	// Pass 1: the note is unchanged since some snapshot of it — renamed and not written to since,
	// or renamed, snapshotted, and rewritten only after that.
	const unmatched: typeof missing = [];
	for (const src of missing) {
		const hit = pool.find((c) => !claimed.has(c.path) && c.path !== src.path && c.texts.includes(src.data));
		if (!hit) {
			unmatched.push(src);
			continue;
		}
		claimed.add(hit.path);
		rekey(src.path, hit.path);
	}

	// Pass 2: the note was renamed *and* edited, so only near-identical content gives it away.
	const score = (a: string, b: string): number => {
		const max = Math.max(a.length, b.length);
		if (!couldBeRenameBySize(a.length, b.length, minScore)) return 0;
		const s = similarity(a, b);
		return s >= renameThreshold(max, minScore) ? s : 0;
	};
	for (const src of unmatched) {
		let bestPath: string | null = null;
		let bestScore = 0;
		for (const c of pool) {
			if (claimed.has(c.path) || c.path === src.path) continue;
			const s = Math.max(...c.texts.map((t) => score(src.data, t)));
			if (s === 0) continue;
			if (s > bestScore || (s === bestScore && bestPath !== null && c.path < bestPath)) {
				bestScore = s;
				bestPath = c.path;
			}
		}
		if (!bestPath) continue;
		claimed.add(bestPath);
		rekey(src.path, bestPath);
	}
}

/** Group a flat list of File Recovery records into path → snapshots (asc by ts). */
export function groupByPath(records: Array<{ path: string; ts: number; data: string }>): SnapshotsByPath {
	const byPath: SnapshotsByPath = new Map();
	for (const r of records) {
		let arr = byPath.get(r.path);
		if (!arr) byPath.set(r.path, (arr = []));
		arr.push({ ts: r.ts, data: r.data });
	}
	for (const arr of byPath.values()) arr.sort((a, b) => a.ts - b.ts);
	return byPath;
}
