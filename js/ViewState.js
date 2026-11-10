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

const KEY       = 'wr_view';
const VERSION   = 1;
const KINDS     = ['scenes', 'audio'];

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

// keep only what the shape promises, so a hand-edited blob cannot crash a render
function normalize (raw) {
	const blob = empty_blob();

	if (!raw || typeof raw !== 'object')
		return blob;

	KINDS.forEach((kind) => {
		const entry = raw[kind];

		if (!entry || typeof entry !== 'object')
			return;

		blob[kind].hidden = clean_list(entry.hidden);
		blob[kind].order  = clean_list(entry.order);
	});

	if (Array.isArray(raw.dashboards)) {
		raw.dashboards.forEach((dash) => {
			if (!dash || typeof dash !== 'object' || typeof dash.id !== 'string' || dash.id === '')
				return;

			blob.dashboards.push({
				id   : dash.id,
				name : typeof dash.name === 'string' && dash.name !== '' ? dash.name : 'Dashboard',
				items: clean_list(dash.items),
			});
		});
	}

	if (typeof raw.activeDashboard === 'string' && blob.dashboards.some((d) => d.id === raw.activeDashboard))
		blob.activeDashboard = raw.activeDashboard;

	return blob;
}

export default class ViewState {
	constructor () {
		this._live = {}; // last live uuid list per kind, from effective_order()
		this.data  = empty_blob();
		this.load();
	}

	load () {
		let raw = null;

		try {
			raw = JSON.parse(window.localStorage.getItem(KEY));
		} catch (e) {
			raw = null;
		}

		this.data = normalize(raw);

		return this.data;
	}

	save () {
		try {
			window.localStorage.setItem(KEY, JSON.stringify(this.data));
		} catch (e) {
			// private mode or a full quota: the session keeps working, it just
			// will not remember, which is better than throwing into a render
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

		entry.order.forEach((uuid) => {
			if (liveSet.has(uuid))
				out.push(uuid);
		});

		const seen = new Set(out);

		live.forEach((uuid) => {
			if (!seen.has(uuid))
				out.push(uuid);
		});

		return out;
	}

	// the live list last handed to effective_order, for callers that reorder
	// without polling again
	live_list (kind) {
		return (this._live[kind] || []).slice();
	}

	// one-shot write of a whole sequence: used by Sort and by a finished drag
	sort_to (kind, uuids) {
		const entry = this.entry(kind);

		if (!entry)
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
	 * Drop uuids OBS no longer reports. Called once, after the first poll that
	 * actually returned scenes and inputs, so a slow connect cannot prune a
	 * good list.
	 */
	prune (sceneUuids, inputUuids) {
		const liveScenes = new Set(clean_list(sceneUuids));
		const liveInputs = new Set(clean_list(inputUuids));
		const liveAll    = new Set([...liveScenes, ...liveInputs]);

		KINDS.forEach((kind) => {
			const live  = kind === 'scenes' ? liveScenes : liveInputs;
			const entry = this.data[kind];

			entry.hidden = entry.hidden.filter((uuid) => live.has(uuid));
			entry.order  = entry.order.filter((uuid) => live.has(uuid));
		});

		this.data.dashboards.forEach((dash) => {
			dash.items = dash.items.filter((uuid) => liveAll.has(uuid));
		});

		this.save();
	}
}
