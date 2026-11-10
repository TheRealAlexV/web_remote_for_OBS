/**
 * Store-level checks for ViewState, no browser:
 *
 *	node test/viewstate.mjs
 *
 * ViewState reads and writes localStorage through `window`, so the harness
 * supplies a small one. Every check builds its own store, so a failure names
 * one behaviour rather than leaving the next check a different state.
 */

let writes = 0;
const store = new Map();

globalThis.window = {
	localStorage: {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { writes += 1; store.set(key, String(value)); },
	},
};

const { default: ViewState } = await import('../js/ViewState.js');

const KEY = 'wr_view';

function seed (blob) {
	store.set(KEY, JSON.stringify(blob));
	writes = 0;
	return new ViewState();
}

function base_blob (over = {}) {
	return {
		v: 1,
		scenes: { hidden: [], order: [] },
		audio: { hidden: [], order: [] },
		dashboards: [],
		activeDashboard: null,
		...over,
	};
}

let failures = 0;

function check (label, fn) {
	try {
		fn();
		console.log('PASS: ' + label);
	} catch (e) {
		failures += 1;
		console.error('FAIL: ' + label + ' — ' + e.message);
	}
}

function eq (actual, expected, what) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);

	if (a !== b)
		throw new Error(`${what}: expected ${b}, got ${a}`);
}

// --- rename_key -------------------------------------------------------------

check('a key in no list is a no-op that writes nothing', () => {
	const view = seed(base_blob({ scenes: { hidden: ['x'], order: ['x'] } }));

	view.rename_key('scenes', 'absent:1', 'absent:2');

	eq(view.data.scenes, { hidden: ['x'], order: ['x'] }, 'scenes');
	eq(writes, 0, 'writes');
});

check('a rename moves hidden, order and the dashboards together', () => {
	const view = seed(base_blob({
		scenes: { hidden: ['old'], order: ['a', 'old', 'b'] },
		dashboards: [{ id: 'd1', name: 'One', items: ['old', 'keep'] }],
	}));

	view.rename_key('scenes', 'old', 'new');

	eq(view.data.scenes.hidden, ['new'], 'hidden');
	eq(view.data.scenes.order, ['a', 'new', 'b'], 'order');
	eq(view.data.dashboards[0].items, ['new', 'keep'], 'dashboard items');
	if (writes !== 1)
		throw new Error(`expected one save, saw ${writes}`);
});

check('a scene Mic and an input Mic on one dashboard: renaming the scene leaves the input', () => {
	const view = seed(base_blob({
		scenes: { hidden: ['scene-name:Mic'], order: ['scene-name:Mic'] },
		audio: { hidden: ['input-name:Mic'], order: ['input-name:Mic'] },
		dashboards: [{ id: 'd1', name: 'One', items: ['scene-name:Mic', 'input-name:Mic'] }],
	}));

	view.rename_key('scenes', 'scene-name:Mic', 'scene-name:Studio Mic');

	eq(view.data.dashboards[0].items, ['scene-name:Studio Mic', 'input-name:Mic'], 'dashboard items');
	eq(view.data.audio.hidden, ['input-name:Mic'], 'audio hidden');
	eq(view.data.audio.order, ['input-name:Mic'], 'audio order');
	eq(view.data.scenes.hidden, ['scene-name:Studio Mic'], 'scenes hidden');
});

check('old and new both stored: neither list nor dashboard grows a duplicate', () => {
	const view = seed(base_blob({
		scenes: { hidden: ['old', 'new'], order: ['old', 'a', 'new'] },
		dashboards: [{ id: 'd1', name: 'One', items: ['old', 'new', 'keep'] }],
	}));

	view.rename_key('scenes', 'old', 'new');

	eq(view.data.scenes.hidden, ['new'], 'hidden');
	eq(view.data.scenes.order, ['new', 'a'], 'order');
	eq(view.data.dashboards[0].items, ['new', 'keep'], 'dashboard items');
	eq(view.effective_order('scenes', ['new', 'a']), ['new', 'a'], 'effective order');
});

check('a duplicated order key renders one row, not two', () => {
	const view = seed(base_blob({ scenes: { hidden: [], order: ['a', 'a', 'b'] } }));

	eq(view.effective_order('scenes', ['a', 'b']), ['a', 'b'], 'effective order');
});

// --- the legacy name: key ---------------------------------------------------

check('a legacy name: key moves into both kinds in the lists and in a dashboard', () => {
	const view = seed(base_blob({
		scenes: { hidden: ['name:Mic'], order: ['name:Mic'] },
		audio: { hidden: ['name:Mic'], order: ['name:Mic'] },
		dashboards: [{ id: 'd1', name: 'One', items: ['name:Mic'] }],
	}));

	eq(view.data.scenes.hidden, ['scene-name:Mic'], 'scenes hidden');
	eq(view.data.audio.hidden, ['input-name:Mic'], 'audio hidden');
	eq(view.data.dashboards[0].items, ['scene-name:Mic', 'input-name:Mic'], 'dashboard items');
});

check('a legacy key in both a list and a dashboard lands once per list', () => {
	const view = seed(base_blob({
		dashboards: [{ id: 'd1', name: 'One', items: ['scene-name:Mic', 'name:Mic'] }],
	}));

	eq(view.data.dashboards[0].items, ['scene-name:Mic', 'input-name:Mic'], 'dashboard items');
});

if (failures) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}

console.log('viewstate checks passed');
