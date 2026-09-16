import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	couldBeRenameBySize,
	groupByPath,
	renameThreshold,
	isOwnOutput,
	mergeCurrentContent,
	renderPromptTemplate,
	renderReview,
	resolveRenames,
	similarity,
} from '../src/review';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

interface Fixture {
	records: Array<{ path: string; ts: number; data: string }>;
}
const fx = JSON.parse(readFileSync(join(fixtures, 'synthetic.json'), 'utf8')) as Fixture;

// Same knobs the Python oracle used to produce synthetic.expected.md.
const OPTS = {
	now: 1768478400000, // 2026-01-15T12:00:00Z
	sinceDays: 7,
	context: 3,
	net: true,
	fullBelow: 200,
	syncThreshold: 4,
	withMeta: true,
	newPaths: new Set(['lorem-ipsum.md']), // the one fixture note created within the window
};

/** Collapse the two intentionally-non-deterministic bits so difflib and jsdiff can be compared:
 *  the generated wall-clock stamp, and the numeric ranges in @@ headers (hunk boundaries may
 *  differ between diff engines; the heading annotation after @@ is preserved). */
function normalize(md: string): string {
	return md
		.replace(/_generated [^·]*· /, '_generated · ')
		.replace(/^@@ -\S+ \+\S+ @@/gm, '@@');
}

describe('renderReview', () => {
	const output = renderReview(groupByPath(fx.records), OPTS);

	it('matches the Python golden-oracle output (semantic, range-normalized)', () => {
		const expected = readFileSync(join(fixtures, 'synthetic.expected.md'), 'utf8');
		expect(normalize(output)).toBe(normalize(expected));
	});

	it('reports the right corpus size in the header', () => {
		expect(output).toContain('_generated');
		expect(output).toMatch(/9 snapshots across 7 notes/);
	});

	it('excludes the bulk-sync second from the activity table but lists it under sync events', () => {
		// 2026-01-13 03:00 is a 4-note sync burst: no activity row, no late-night flag, but a sync entry.
		expect(output).not.toMatch(/\| 2026-01-13 \|/);
		expect(output).not.toContain('⚠️');
		expect(output).toContain('2026-01-13 03:00 — 4 notes captured together');
	});

	it('records live-edit metrics for the authored day', () => {
		expect(output).toMatch(/\| 2026-01-15 \| 2 \| 3 \| 185 \| 69 \| 09:00–11:59 \|/);
	});

	it('renders a brand-new note (no pre-window baseline) as an all-additions diff', () => {
		const idx = output.indexOf('## lorem-ipsum.md');
		expect(idx).toBeGreaterThan(-1);
		const section = output.slice(idx, output.indexOf('## quotes.md'));
		expect(section).toContain('## lorem-ipsum.md — 1 edit in window');
		expect(section).toContain('--- (new file)');
		expect(section).toContain('+++ 2026-01-15 09:00:00');
		expect(section).toContain('@@ -0,0 +1,5 @@ # Lorem ipsum');
		expect(section).toContain('+# Lorem ipsum');
		expect(section).not.toContain('single snapshot in window; no diff');
	});

	it('diffs the large note with a heading-annotated hunk, newest-first', () => {
		const journalIdx = output.indexOf('## journal.md');
		const quotesIdx = output.indexOf('## quotes.md');
		expect(journalIdx).toBeGreaterThan(-1);
		expect(journalIdx).toBeLessThan(quotesIdx); // journal edited most recently → ranked first
		expect(output).toContain('```diff');
		expect(output).toMatch(/@@ .*@@ # Journal/);
		expect(output).toContain('+Started the year strong, reading more and writing more than I expected.');
	});

	it('shows short notes as full content when fullBelow is set', () => {
		expect(output).toContain('_current content:_\n\n```markdown\n# Quotes');
	});
});

describe('mergeCurrentContent', () => {
	const NO_META = {
		now: 1768100000000,
		sinceDays: 0,
		context: 3,
		net: true,
		fullBelow: 0,
		syncThreshold: 4,
		withMeta: false,
	};

	it('surfaces a note whose only snapshot is empty as an all-additions diff (fixes 0-char notes)', () => {
		const byPath = groupByPath([{ path: 'new.md', ts: 1768000000000, data: '' }]);
		mergeCurrentContent(byPath, new Map([['new.md', { mtime: 1768000600000, data: '# New\n\nHello world.\n' }]]));
		expect(byPath.get('new.md')!.length).toBe(2);
		const md = renderReview(byPath, NO_META);
		expect(md).toContain('```diff');
		expect(md).toContain('+# New');
		expect(md).toContain('+Hello world.');
		expect(md).not.toContain('_current content:_');
	});

	it('does not add a duplicate version when current content equals the newest snapshot', () => {
		const byPath = groupByPath([{ path: 'same.md', ts: 1, data: 'x' }]);
		mergeCurrentContent(byPath, new Map([['same.md', { mtime: 2, data: 'x' }]]));
		expect(byPath.get('same.md')!.length).toBe(1);
	});

	it('ignores current content for notes without snapshot history', () => {
		const byPath = groupByPath([{ path: 'a.md', ts: 1, data: 'a' }]);
		mergeCurrentContent(byPath, new Map([['b.md', { mtime: 2, data: 'b' }]]));
		expect(byPath.has('b.md')).toBe(false);
	});
});

describe('deleted notes', () => {
	it('lists gone notes in a bottom section instead of diffing them', () => {
		const byPath = groupByPath([
			{ path: 'kept.md', ts: 1768000000000, data: '# Kept\n\none\ntwo\n' },
			{ path: 'kept.md', ts: 1768000600000, data: '# Kept\n\none\ntwo\nthree\n' },
			{ path: 'gone.md', ts: 1768000300000, data: 'orphaned snapshot' },
		]);
		const md = renderReview(byPath, {
			now: 1768100000000,
			sinceDays: 0,
			context: 3,
			net: true,
			fullBelow: 0,
			syncThreshold: 4,
			withMeta: false,
			deletedPaths: new Set(['gone.md']),
		});
		expect(md).toContain('## Deleted notes');
		expect(md).toContain('- gone.md');
		// the deleted note is not rendered as its own diff section
		expect(md).not.toContain('## gone.md');
		expect(md).not.toContain('orphaned snapshot');
		// kept note still diffs normally
		expect(md).toContain('## kept.md');
		expect(md).toContain('+three');
	});

	it('omits the section when nothing is deleted', () => {
		const byPath = groupByPath([{ path: 'a.md', ts: 1768000000000, data: 'x' }]);
		const md = renderReview(byPath, {
			now: 1768100000000,
			sinceDays: 0,
			context: 3,
			net: true,
			fullBelow: 0,
			syncThreshold: 4,
			withMeta: false,
		});
		expect(md).not.toContain('## Deleted notes');
	});
});

describe('isOwnOutput', () => {
	it('excludes notes inside the configured output folder', () => {
		expect(isOwnOutput('microlite/microlite-hunks-2026-07-06.md', 'microlite')).toBe(true);
		expect(isOwnOutput('microlite/anything.md', 'microlite')).toBe(true);
		expect(isOwnOutput('microlite', 'microlite')).toBe(true);
	});

	it('excludes generated notes at the vault root (empty output folder)', () => {
		expect(isOwnOutput('microlite-hunks-2026-07-06.md', '')).toBe(true);
	});

	it('does not exclude ordinary notes or prefix look-alikes', () => {
		expect(isOwnOutput('notes/journal.md', 'microlite')).toBe(false);
		expect(isOwnOutput('microlite-stuff/note.md', 'microlite')).toBe(false);
		expect(isOwnOutput('journal.md', '')).toBe(false);
	});
});

describe('resolveRenames', () => {
	it('re-keys a renamed note\'s old-path snapshots onto its current name (by content)', () => {
		// Snapshots live under a stale `.md.md` path; the live file is `relationship-notes_.md`.
		const byPath = groupByPath([
			{ path: 'relationship-notes_.md.md', ts: 1, data: '# R\n\nbody\n' },
			{ path: 'relationship-notes_.md.md', ts: 2, data: '# R\n\nbody edited\n' },
		]);
		const deleted = new Set(['relationship-notes_.md.md']);
		resolveRenames(byPath, deleted, [{ path: 'relationship-notes_.md', data: '# R\n\nbody edited\n' }]);
		expect(deleted.has('relationship-notes_.md.md')).toBe(false);
		expect(byPath.has('relationship-notes_.md.md')).toBe(false);
		expect(byPath.get('relationship-notes_.md')!.map((s) => s.ts)).toEqual([1, 2]);
	});

	it('merges old-path snapshots with the target\'s existing ones, sorted by ts', () => {
		const byPath = groupByPath([
			{ path: 'old.md', ts: 1, data: 'a' },
			{ path: 'new.md', ts: 3, data: 'c' },
		]);
		const deleted = new Set(['old.md']);
		resolveRenames(byPath, deleted, [{ path: 'new.md', data: 'a' }]);
		expect(byPath.get('new.md')!.map((s) => s.ts)).toEqual([1, 3]);
		expect(byPath.has('old.md')).toBe(false);
	});

	it('leaves genuinely-deleted notes when no live file matches', () => {
		const byPath = groupByPath([{ path: 'gone.md', ts: 1, data: 'x' }]);
		const deleted = new Set(['gone.md']);
		resolveRenames(byPath, deleted, [{ path: 'other.md', data: 'totally different' }]);
		expect(deleted.has('gone.md')).toBe(true);
		expect(byPath.has('gone.md')).toBe(true);
	});

	it('matches a note renamed *and* lightly edited since its last snapshot', () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
		const byPath = groupByPath([{ path: 'old name.md', ts: 1, data: `# Note\n\n${body}\n` }]);
		const deleted = new Set(['old name.md']);
		// One line appended after the rename: ~99.5% similar, well inside the 98% bar.
		resolveRenames(byPath, deleted, [{ path: 'new name.md', data: `# Note\n\n${body}\nline 200\n` }]);
		expect(deleted.size).toBe(0);
		expect(byPath.get('new name.md')!.map((s) => s.ts)).toEqual([1]);
	});

	it('gives a short note real slack: a one-line edit is still the same note', () => {
		// ~1 KB. A flat 98% bar allows 20 characters of drift here; the absolute slack allows ~120.
		const body = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
		const byPath = groupByPath([{ path: 'old.md', ts: 1, data: `# Project\n\n${body}\n` }]);
		const deleted = new Set(['old.md']);
		resolveRenames(byPath, deleted, [{ path: 'new.md', data: `# Project\n\n${body}\n\n## Next steps\n\nship it\n` }]);
		expect(deleted.size).toBe(0);
		expect(byPath.get('new.md')!.map((s) => s.ts)).toEqual([1]);
	});

	it('still refuses a tiny note that the slack alone would have swallowed', () => {
		// Two short notes sharing only their heading: the slack would cover the whole rewrite, the
		// floor does not.
		const byPath = groupByPath([{ path: 'gone.md', ts: 1, data: '# Meeting\n\nalpha\nbeta\ngamma\n' }]);
		const deleted = new Set(['gone.md']);
		resolveRenames(byPath, deleted, [{ path: 'other.md', data: '# Meeting\n\ndelta\nepsilon\nzeta\n' }]);
		expect(deleted.has('gone.md')).toBe(true);
	});

	it('matches via the new name\'s earliest snapshot when the live file has since been rewritten', () => {
		const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
		const byPath = groupByPath([
			{ path: 'old.md', ts: 1, data: `${body}\n` },
			// File Recovery caught the file just after the rename, then it was rewritten wholesale.
			{ path: 'new.md', ts: 2, data: `${body}\n` },
		]);
		const deleted = new Set(['old.md']);
		resolveRenames(byPath, deleted, [{ path: 'new.md', data: 'a completely different note now\n' }]);
		expect(deleted.size).toBe(0);
		expect(byPath.get('new.md')!.map((s) => s.ts)).toEqual([1, 2]);
	});

	it('does not match a live note that merely looks similar', () => {
		const byPath = groupByPath([{ path: 'gone.md', ts: 1, data: '# Meeting\n\nalpha\nbeta\ngamma\n' }]);
		const deleted = new Set(['gone.md']);
		resolveRenames(byPath, deleted, [{ path: 'template.md', data: '# Meeting\n\ndelta\nepsilon\nzeta\n' }]);
		expect(deleted.has('gone.md')).toBe(true);
		expect(byPath.has('template.md')).toBe(false);
	});

	it('pairs each live file with at most one missing note, best match first', () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
		const byPath = groupByPath([
			{ path: 'a.md', ts: 1, data: `${body}\n` },
			{ path: 'b.md', ts: 2, data: `${body}\nextra\n` },
		]);
		const deleted = new Set(['a.md', 'b.md']);
		// a.md is the exact content of live.md, so it wins it; b.md has nowhere else to go.
		resolveRenames(byPath, deleted, [{ path: 'live.md', data: `${body}\n` }]);
		expect(byPath.get('live.md')!.map((s) => s.ts)).toEqual([1]);
		expect(deleted.has('b.md')).toBe(true);
	});
});

describe('similarity', () => {
	it('scores identical text 1 and disjoint text 0', () => {
		expect(similarity('a\nb\n', 'a\nb\n')).toBe(1);
		expect(similarity('a\nb\n', 'c\nd\n')).toBe(0);
	});

	it('scores an insertion by the share of the larger text that is shared', () => {
		// 100 identical lines, then one more added: the score is ~100/101 of the larger side.
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const a = `${lines.join('\n')}\n`;
		const b = `${a}line 100\n`;
		expect(similarity(a, b)).toBeGreaterThan(0.98);
		expect(similarity(a, b)).toBeLessThan(1);
		expect(similarity(a, b)).toBe(similarity(b, a));
	});

	it('ignores line order, so a moved paragraph is not a new note', () => {
		expect(similarity('a\nb\nc\n', 'c\nb\na\n')).toBe(1);
	});
});

describe('renameThreshold', () => {
	it('holds at the relative bar for notes big enough for it to bite', () => {
		expect(renameThreshold(50_000)).toBeCloseTo(0.98, 10);
		expect(renameThreshold(6000)).toBeCloseTo(0.98, 10);
	});

	it('relaxes for short notes, but never past the floor', () => {
		expect(renameThreshold(1000)).toBeCloseTo(0.88, 10); // 120 chars of slack, not 20
		expect(renameThreshold(200)).toBe(0.8);
		expect(renameThreshold(10)).toBe(0.8);
		expect(renameThreshold(0)).toBe(0.98);
	});

	it('never gets stricter as a note grows', () => {
		let previous = 0;
		for (const size of [10, 100, 500, 1000, 5000, 20_000, 100_000]) {
			const t = renameThreshold(size);
			expect(t).toBeGreaterThanOrEqual(previous);
			previous = t;
		}
	});
});

describe('couldBeRenameBySize', () => {
	it('keeps only sizes that could still clear the bar', () => {
		expect(couldBeRenameBySize(50_000, 50_000)).toBe(true);
		expect(couldBeRenameBySize(50_000, 49_500)).toBe(true);
		expect(couldBeRenameBySize(50_000, 45_000)).toBe(false);
		expect(couldBeRenameBySize(1000, 900)).toBe(true); // within the short-note slack
		expect(couldBeRenameBySize(1000, 700)).toBe(false);
		expect(couldBeRenameBySize(0, 0)).toBe(true);
	});
});

describe('opened-but-unchanged vs genuinely new', () => {
	const base = {
		now: 1768100000000,
		sinceDays: 0,
		context: 3,
		net: true,
		fullBelow: 0,
		syncThreshold: 4,
		withMeta: false,
	};

	it('omits an old note that was opened/synced but not edited (no pre, not new, no change)', () => {
		// One in-window snapshot, no pre-window baseline, not flagged new → baseline is that same
		// snapshot → empty diff → dropped. This is the therapy-file / opened-note case.
		const byPath = groupByPath([{ path: 'opened.md', ts: 1768000000000, data: '# Old\n\nunchanged\n' }]);
		const md = renderReview(byPath, base);
		expect(md).not.toContain('## opened.md');
	});

	it('diffs an old note against its earliest in-window snapshot when it really changed', () => {
		const byPath = groupByPath([
			{ path: 'edited.md', ts: 1768000000000, data: '# Old\n\none\n' },
			{ path: 'edited.md', ts: 1768000600000, data: '# Old\n\none\ntwo\n' },
		]);
		const md = renderReview(byPath, base);
		expect(md).toContain('## edited.md');
		expect(md).toContain('+two');
		expect(md).not.toContain('(new file)'); // old file → baseline is the earliest snapshot, not empty
	});

	it('omits a note whose only change is whitespace (opened/auto-saved rewrite)', () => {
		// Every line differs by trailing whitespace → a diff exists, but it is not a real edit.
		const byPath = groupByPath([
			{ path: 'ws.md', ts: 1768000000000, data: '# Note\n\nalpha  \nbeta\t\ngamma \n' },
			{ path: 'ws.md', ts: 1768000600000, data: '# Note\n\nalpha\nbeta\ngamma\n' },
		]);
		const md = renderReview(byPath, base);
		expect(md).not.toContain('## ws.md');
	});

	it('shows a genuinely new note (flagged in newPaths) as all-additions', () => {
		const byPath = groupByPath([{ path: 'fresh.md', ts: 1768000000000, data: '# Fresh\n\nbrand new\n' }]);
		const md = renderReview(byPath, { ...base, newPaths: new Set(['fresh.md']) });
		expect(md).toContain('## fresh.md — 1 edit in window');
		expect(md).toContain('--- (new file)');
		expect(md).toContain('+# Fresh');
	});
});

describe('renderPromptTemplate', () => {
	const DAY = 86_400_000;
	// 2026-01-15T12:00:00Z; assertions use UTC-independent substrings to stay timezone-agnostic.
	const now = 1768478400000;

	it('returns empty for a blank or whitespace-only template', () => {
		expect(renderPromptTemplate('', now, 7 * DAY, '7 days')).toBe('');
		expect(renderPromptTemplate('   \n\t', now, 7 * DAY, '7 days')).toBe('');
	});

	it('substitutes {{window}} with the window label', () => {
		expect(renderPromptTemplate('last {{window}} of edits', now, 7 * DAY, '7 days')).toBe('last 7 days of edits');
	});

	it('spells out {{date}} and {{window_start}} a window apart', () => {
		const out = renderPromptTemplate('now {{date}} · since {{window_start}}', now, 7 * DAY, '7 days');
		expect(out).toContain('2026'); // spelled-out year present
		expect(out).not.toContain('{{'); // no unresolved known tokens
		// window_start is exactly 7 days earlier, so the two rendered dates must differ.
		const [d1, d2] = out.replace('now ', '').split(' · since ');
		expect(d1).not.toBe(d2);
	});

	it('tolerates inner whitespace and leaves unknown tokens untouched', () => {
		expect(renderPromptTemplate('{{ window }} then {{mystery}}', now, DAY, '24 hours')).toBe(
			'24 hours then {{mystery}}',
		);
	});
});
