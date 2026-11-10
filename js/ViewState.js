/**
 * ViewState: what this browser chooses to show, kept out of OBS.
 *
 * Items are keyed by uuid (sceneUuid / inputUuid), never by name, so a rename
 * in OBS cannot silently move a hidden item back into view or reshuffle a
 * hand-arranged list. Names are display-only and never stored here.
 *
 * One versioned blob under a single localStorage key. Every read tolerates a
 * broken blob: a parse failure or a missing key falls back to the defaults, so
 * a bad value can never blank the remote.
 */

const KEY        = 'wr_view';
const BROKEN_KEY = 'wr_view.broken';
const VERSION    = 1;
const KINDS      = ['scenes', 'audio'];

export const STORAGE_KEY = KEY;

function empty_blob () {
	return {
		v              : VERSION,
		scenes         : { hidden: [], order: [] },
		audio          : { hidden: [], order: [] },
		dashboards     : [],
		activeDashboard: null,
	};
}

// strings only, no blanks, no repeats
function clean_list (value) {
	if (!Array.isArray(value))
		return [];

	const seen = new Set();
	const out  = [];

	for (let i = 0; i < value.length; i++) {
		const item = value[i];

		if (typeof item !== 'string' || item === '' || seen.has(item))
			continue;

		seen.add(item);
		out.push(item);
	}

	return out;
}

// keep only what the shape promises, so a hand-edited blob cannot crash a render.
// `stats.dropped` counts what was thrown away, so a partial read can be reported
// instead of looking like a deliberate empty view.
function normalize (raw, stats) {
	const blob = empty_blob();
	const drop = () => { stats.dropped += 1; };

	if (!raw || typeof raw !== 'object') {
		if (raw)
			drop();

		return blob;
	}

	KINDS.forEach((kind) => {
		const entry = raw[kind];

		if (!entry || typeof entry !== 'object') {
			if (entry)
				drop();

			return;
		}

		const hidden = clean_list(entry.hidden);
		const order  = clean_list(entry.order);

		stats.dropped += (Array.isArray(entry.hidden) ? entry.hidden.length : 0) - hidden.length;
		stats.dropped += (Array.isArray(entry.order) ? entry.order.length : 0) - order.length;

		blob[kind].hidden = hidden;
		blob[kind].order  = order;
	});

	if (raw.dashboards !== undefined) {
		if (!Array.isArray(raw.dashboards)) {
			drop();
		} else {
			raw.dashboards.forEach((dash) => {
				if (!dash || typeof dash !== 'object' || typeof dash.id !== 'string' || dash.id === '') {
					drop();
					return;
				}

				const items = clean_list(dash.items);

				stats.dropped += (Array.isArray(dash.items) ? dash.items.length : 0) - items.length;

				blob.dashboards.push({
					id   : dash.id,
					name : typeof dash.name === 'string' && dash.name !== '' ? dash.name : 'Dashboard',
					items: items,
				});
			});
		}
	}

	if (typeof raw.activeDashboard === 'string' && blob.dashboards.some((d) => d.id === raw.activeDashboard))
		blob.activeDashboard = raw.activeDashboard;

	return blob;
}

export default class ViewState {
	constructor () {
		this._live       = {}; // last live uuid list per kind, from effective_order()
		this.save_failed = false;
		this.data        = empty_blob();
		this.load();
	}

	load () {
		let raw_text = null;
		let raw      = null;
		let error    = null;

		try {
			raw_text = window.localStorage.getItem(KEY);
			raw      = raw_text ? JSON.parse(raw_text) : null;
		} catch (e) {
			error = e;
			raw   = null;
		}

		// a store that never existed may take the one-time compatibility defaults;
		// a store that exists, however sparse, is the operator's and is left alone
		this.is_new = !raw_text;

		// a blob written by a newer version is read best effort through the v1
		// rules and never written back, so this tab cannot downgrade it
		this.future = !!(raw && typeof raw.v === 'number' && raw.v > VERSION);

		const stats = { dropped: 0 };

		this.data = normalize(raw, stats);

		if (error || stats.dropped) {
			// whatever was rejected is gone from memory, and an unreadable blob
			// was never in it: keep the raw value either way, or the next save
			// erases the only evidence of what the operator lost
			try {
				if (raw_text !== null)
					window.localStorage.setItem(BROKEN_KEY, raw_text);
			} catch (e) {
				// storage is refusing every write; save() reports that separately
			}

			if (error) {
				console.warn('ViewState: could not read the saved view' +
					(raw_text !== null ? '; the raw value is kept in ' + BROKEN_KEY : ''), error);
			} else {
				console.warn('ViewState: ignored ' + stats.dropped + ' malformed entries in the saved view' +
					(raw_text !== null ? '; the raw value is kept in ' + BROKEN_KEY : ''));
			}
		}

		// a newer format may key items differently; migrating it from v1 rules
		// would rewrite what this tab cannot read
		if (!this.future)
			this.migrate_legacy_keys();

		return this.data;
	}

	/**
	 * Keys written before the fallback named its kind ('name:Mic') cannot say
	 * which object they meant, and a scene and an input can share a name. A
	 * per-kind list only ever held its own kind, so those move in place; a
	 * dashboard holds both, so one ambiguous entry becomes both keys — an entry
	 * for an object that does not exist matches nothing and renders nothing.
	 * Runs once: no 'name:' key survives it.
	 */
	migrate_legacy_keys () {
		const legacy = (key) => typeof key === 'string' && key.startsWith('name:');
		let moved    = 0;

		KINDS.forEach((kind) => {
			const prefix = kind === 'scenes' ? 'scene-name:' : 'input-name:';
			const entry  = this.data[kind];

			['hidden', 'order'].forEach((field) => {
				const out = [];

				entry[field].forEach((key) => {
					if (!legacy(key)) {
						out.push(key);
						return;
					}

					moved += 1;
					out.push(prefix + key.slice(5));
				});

				entry[field] = clean_list(out);
			});
		});

		this.data.dashboards.forEach((dash) => {
			const out = [];

			dash.items.forEach((key) => {
				if (!legacy(key)) {
					out.push(key);
					return;
				}

				moved += 1;
				out.push('scene-name:' + key.slice(5), 'input-name:' + key.slice(5));
			});

			dash.items = clean_list(out);
		});

		if (!moved)
			return 0;

		console.warn('ViewState: moved ' + moved + ' saved entries written before keys named their kind');
		this.save();
		return moved;
	}

	/**
	 * True while a write can be trusted. A failure is reported once and cleared
	 * by the next write that works, so a store that recovers stops claiming it
	 * cannot save.
	 */
	can_save () {
		return !this.future && !this.save_failed;
	}

	save () {
		// a newer version owns the blob; this tab only renders from it
		if (this.future)
			return false;

		try {
			window.localStorage.setItem(KEY, JSON.stringify(this.data));
			this.save_failed = false;
			return true;
		} catch (e) {
			if (!this.save_failed) {
				this.save_failed = true;
				console.warn('ViewState: changes cannot be saved in this browser', e);
			}

			return false;
		}
	}

	entry (kind) {
		return KINDS.includes(kind) ? this.data[kind] : null;
	}

	// --- visibility ---------------------------------------------------------

	is_hidden (kind, uuid) {
		const entry = this.entry(kind);
		return !!entry && !!uuid && entry.hidden.includes(uuid);
	}

	active_dashboard () {
		if (!this.data.activeDashboard)
			return null;

		return this.data.dashboards.find((d) => d.id === this.data.activeDashboard) || null;
	}

	// "All" is the absence of a filter, never a stored dashboard
	visible (kind, uuid) {
		if (!uuid)
			return true;

		if (this.is_hidden(kind, uuid))
			return false;

		const dash = this.active_dashboard();

		if (dash)
			return dash.items.includes(uuid);

		return true;
	}

	// --- order --------------------------------------------------------------

	/**
	 * The sequence to render: stored order restricted to live uuids, then every
	 * live uuid the user has not arranged yet, in payload order. Passing the
	 * full live list (hidden included) lets move_to work later without another
	 * poll, so the list is remembered here.
	 */
	effective_order (kind, liveItems) {
		const live = clean_list(liveItems);
		const entry = this.entry(kind);

		this._live[kind] = live;

		if (!entry)
			return live;

		const liveSet = new Set(live);
		const out     = [];
		const seen    = new Set();

		entry.order.forEach((uuid) => {
			// a key stored twice would otherwise render two rows for one item
			if (liveSet.has(uuid) && !seen.has(uuid)) {
				seen.add(uuid);
				out.push(uuid);
			}
		});

		live.forEach((uuid) => {
			if (!seen.has(uuid)) {
				seen.add(uuid);
				out.push(uuid);
			}
		});

		return out;
	}

	// the live list last handed to effective_order, for callers that reorder
	// without polling again
	live_list (kind) {
		return (this._live[kind] || []).slice();
	}

	// one-shot write of a whole sequence: used by Sort and by a finished drag.
	// An empty sequence is never a caller's intent, and writing one would drop
	// the arranged order for a list that still has items.
	sort_to (kind, uuids) {
		const entry = this.entry(kind);

		if (!entry || !Array.isArray(uuids) || !uuids.length)
			return;

		entry.order = clean_list(uuids);
		this.save();
	}

	// move uuid before before_uuid (null = to the tail)
	move_to (kind, uuid, before_uuid) {
		const live = this._live[kind] || [];
		const entry = this.entry(kind);

		if (!entry || !uuid || !live.includes(uuid))
			return;

		const seq  = this.effective_order(kind, live);
		const from = seq.indexOf(uuid);

		if (from === -1)
			return;

		seq.splice(from, 1);

		const at = before_uuid ? seq.indexOf(before_uuid) : -1;

		seq.splice(at === -1 ? seq.length : at, 0, uuid);
		this.sort_to(kind, seq);
	}

	// --- hidden -------------------------------------------------------------

	set_hidden (kind, uuid, hidden) {
		const entry = this.entry(kind);

		if (!entry || !uuid)
			return;

		const was = entry.hidden.includes(uuid);

		if (hidden && !was)
			entry.hidden.push(uuid);
		else if (!hidden && was)
			entry.hidden = entry.hidden.filter((item) => item !== uuid);
		else
			return;

		this.save();
	}

	hidden_list (kind) {
		const entry = this.entry(kind);
		return entry ? entry.hidden.slice() : [];
	}

	/**
	 * A payload without uuids keys items by name, so a rename in OBS changes the
	 * key. Every stored list has to follow it: a hidden item left under the old
	 * key comes back into view, and the stale key can later hide whatever takes
	 * that name. Dashboards hold keys of both kinds, so they move too.
	 */
	rename_key (kind, old_key, new_key) {
		const entry = this.entry(kind);

		if (!entry || !old_key || !new_key || old_key === new_key)
			return;

		const swap = (key) => (key === old_key ? new_key : key);
		let changed = false;

		['hidden', 'order'].forEach((field) => {
			if (!entry[field].includes(old_key))
				return;

			// cleaned, not just swapped: a list holding both keys would otherwise
			// grow a duplicate the moment old and new name the same item
			entry[field] = clean_list(entry[field].map(swap));
			changed = true;
		});

		this.data.dashboards.forEach((dash) => {
			if (!dash.items.includes(old_key))
				return;

			dash.items = clean_list(dash.items.map(swap));
			changed = true;
		});

		if (changed)
			this.save();
	}

	// --- dashboards ---------------------------------------------------------

	dashboards () {
		return this.data.dashboards;
	}

	dashboard (id) {
		return this.data.dashboards.find((d) => d.id === id) || null;
	}

	create_dashboard (name) {
		const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

		this.data.dashboards.push({
			id   : id,
			name : (typeof name === 'string' && name.trim() !== '') ? name.trim() : 'Dashboard',
			items: [],
		});

		this.save();
		return id;
	}

	rename_dashboard (id, name) {
		const dash = this.dashboard(id);

		if (!dash || typeof name !== 'string' || name.trim() === '')
			return;

		dash.name = name.trim();
		this.save();
	}

	delete_dashboard (id) {
		this.data.dashboards = this.data.dashboards.filter((d) => d.id !== id);

		if (this.data.activeDashboard === id)
			this.data.activeDashboard = null;

		this.save();
	}

	add_dashboard_item (id, uuid) {
		const dash = this.dashboard(id);

		if (!dash || !uuid || dash.items.includes(uuid))
			return;

		dash.items.push(uuid);
		this.save();
	}

	remove_dashboard_item (id, uuid) {
		const dash = this.dashboard(id);

		if (!dash)
			return;

		dash.items = dash.items.filter((item) => item !== uuid);
		this.save();
	}

	set_active_dashboard (id) {
		this.data.activeDashboard = (id && this.dashboard(id)) ? id : null;
		this.save();
	}

	// --- startup cleanup ----------------------------------------------------

	/**
	 * Drop keys OBS no longer reports. Only `hidden` and `order` are touched, and
	 * only for a kind whose live key list is non-empty: "cannot identify items"
	 * must mean "do not prune", never "prune everything". Dashboard items are
	 * never pruned here — render already ignores keys that match nothing, and a
	 * dashboard entry deleted on a hunch cannot be recovered.
	 */
	prune (sceneKeys, inputKeys) {
		const liveScenes = new Set(clean_list(sceneKeys));
		const liveInputs = new Set(clean_list(inputKeys));
		const removed    = { scenes: 0, audio: 0 };

		KINDS.forEach((kind) => {
			const live = kind === 'scenes' ? liveScenes : liveInputs;

			if (!live.size)
				return;

			const entry  = this.data[kind];
			const hidden = entry.hidden.filter((key) => live.has(key));
			const order  = entry.order.filter((key) => live.has(key));

			removed[kind] += (entry.hidden.length - hidden.length) + (entry.order.length - order.length);
			entry.hidden = hidden;
			entry.order  = order;
		});

		if (removed.scenes || removed.audio)
			this.save();

		return removed;
	}
}
