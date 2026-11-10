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
const { scene_key, input_key } = await import('../js/keys.js');

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

// --- keys --------------------------------------------------------------------
//
// Driven through the real functions, never a literal the test wrote itself: a
// scene "Mic" and an input "Mic" must not share a key, or one rename rewrites
// the other's membership in every list and dashboard.

check('a scene Mic and an input Mic are different keys', () => {
	const scene = scene_key({ sceneName: 'Mic' });
	const input = input_key({ inputName: 'Mic' });

	eq(scene, 'scene-name:Mic', 'scene key');
	eq(input, 'input-name:Mic', 'input key');

	if (scene === input)
		throw new Error(`a scene and an input share the key ${JSON.stringify(scene)}`);
});

check('a uuid-bearing object keys by its uuid, for both kinds', () => {
	eq(scene_key({ sceneUuid: 'scene-1', sceneName: 'Mic' }), 'scene-1', 'scene key');
	eq(input_key({ inputUuid: 'input-1', inputName: 'Mic' }), 'input-1', 'input key');
});

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
	// built by the real functions: the fixtures are whatever the app would key
	const scene   = scene_key({ sceneName: 'Mic' });
	const input   = input_key({ inputName: 'Mic' });
	const renamed = scene_key({ sceneName: 'Studio Mic' });

	const view = seed(base_blob({
		scenes: { hidden: [scene], order: [scene] },
		audio: { hidden: [input], order: [input] },
		dashboards: [{ id: 'd1', name: 'One', items: [scene, input] }],
	}));

	view.rename_key('scenes', scene, renamed);

	eq(view.data.dashboards[0].items, [renamed, input], 'dashboard items');
	eq(view.data.audio.hidden, [input], 'audio hidden');
	eq(view.data.audio.order, [input], 'audio order');
	eq(view.data.scenes.hidden, [renamed], 'scenes hidden');
});

check('an audio rename moves the audio key in hidden, order and the dashboards; the scenes stay', () => {
	const key     = input_key({ inputName: 'Mic' });
	const renamed = input_key({ inputName: 'Studio Mic' });
	const scene   = scene_key({ sceneName: 'Mic' });

	const view = seed(base_blob({
		scenes: { hidden: [scene], order: [scene] },
		audio: { hidden: [key], order: ['a', key, 'b'] },
		dashboards: [{ id: 'd1', name: 'One', items: [key, scene] }],
	}));

	view.rename_key('audio', key, renamed);

	eq(view.data.audio.hidden, [renamed], 'audio hidden');
	eq(view.data.audio.order, ['a', renamed, 'b'], 'audio order');
	eq(view.data.dashboards[0].items, [renamed, scene], 'dashboard items');
	eq(view.data.scenes, { hidden: [scene], order: [scene] }, 'scenes untouched');
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

check('a key stored twice in the live list still renders one row', () => {
	// pushed after load: normalize() would have deduped it, so only
	// effective_order's !seen.has(uuid) guard can keep the row count at one
	const view = seed(base_blob({ scenes: { hidden: [], order: ['a', 'b'] } }));

	view.data.scenes.order.push('a');

	eq(view.data.scenes.order, ['a', 'b', 'a'], 'stored order');
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
