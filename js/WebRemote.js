import * as h from './helper.js';
import SourceScene from './SourceScene.js';
import SourceAudio from './SourceAudio.js';
import SourceText, {source_name as source_name_of} from './SourceText.js';
import ViewState, {STORAGE_KEY} from './ViewState.js';
import {scene_key as scene_key_of, input_key as input_key_of} from './keys.js';

// the one definition of "this input is a text source"
function is_text_kind (kind) {
	return typeof kind === 'string' && kind.indexOf('text_') === 0;
}

export default class WebRemote {
	constructor () {
		this.studio_mode        = false;
		this.scene_list         = [];
		this.scenes             = {};
		this.scene_program      = '';
		this.scene_preview      = '';
		this.audio_list         = [];
		this.text_panes         = [];
		this.input_kinds        = null;
		this.input_kinds_generation = 0;
		this.tick               = 0;

		// curation: what this browser shows, keyed by OBS uuid. Names live in
		// the maps below for display only; nothing here resolves an item by name.
		this.view               = new ViewState();
		this.raw_scenes         = [];      // payload, OBS order
		this.scene_names        = new Map(); // uuid -> name
		this.input_uuids        = new Map(); // name -> uuid
		this.input_names        = new Map(); // key -> name
		this.audio_keys         = [];      // audio-capable, payload order
		this.view_pruned        = false;
		this.prune_signature    = null;
		this.audio_refresh_pending = false;
		this.drag               = null;
		this.drag_click_pointer = null;   // pointer id whose trailing click is swallowed
		this.drag_move_bound    = this.on_row_drag_move.bind(this);
		this.drag_end_bound     = this.on_row_drag_end.bind(this);

		this.video_width        = 1920;
		this.video_height       = 1080;
		this.aspect_ratio       = '16/9';
		this.video_fps          = 30;

		this.clock              = document.getElementById('status_clock');
		this.clock_text         = document.getElementById('status_clock_time');

		this.streaming          = false;
		this.stream_starting    = false;
		this.stream_stopping    = false;
		this.recording          = false;
		this.recording_starting = false;
		this.recording_stopping = false;
		this.recording_paused   = false;
		this.virtualcam_active  = false;
		this.outputs            = [];

		// keyboard shortcuts: bind once and register for the page lifetime, so a
		// reconnect cannot stack a second listener on the old, still-live one
		this.handle_key_event_bound = this.handle_key_event.bind(this);
		window.addEventListener('keydown', this.handle_key_event_bound, false);

		// bumped on every disconnect so an in-flight poll tick can tell whether
		// the connection it started under is still the current one
		this.connection_generation = 0;

		// set event listeners
		this.button_transition = document.getElementById('btn_transition');
		this.button_transition.addEventListener('click', this.transition.bind(this), false);

		this.button_toggle_mode = document.getElementById('btn_toggle_mode');
		this.button_toggle_mode.addEventListener('click', this.toggle_studio_mode.bind(this), false);

		this.button_fullscreen = document.getElementById('btn_toggle_fullscreen');
		// if fullscreen functionallity is available, set it up, otherwise hide button
		if (this.button_fullscreen.requestFullscreen) {
			this.button_fullscreen.addEventListener('click', this.toggle_fullscreen.bind(this), false);
			window.addEventListener('fullscreenchange', this.handle_fullscreen_event.bind(this), false);
		} else {
			this.button_fullscreen.className = 'hidden';
		}

		// status stream / recording
		document.getElementById('status_stream').addEventListener('click', (e) => {
			document.getElementById('outputs_edit_list').classList.toggle('hidden');
		});
		document.getElementById('status_recording').addEventListener('click', (e) => {
			document.getElementById('outputs_edit_list').classList.toggle('hidden');
		});
		document.getElementById('status_virtualcam').addEventListener('click', (e) => {
			document.getElementById('outputs_edit_list').classList.toggle('hidden');
		});
		document.getElementById('status_outputs').addEventListener('click', (e) => {
			document.getElementById('outputs_edit_list').classList.toggle('hidden');
		});

		// stream and recording buttons
		this.stream_button    = document.getElementById('stream_button');
		this.recording_button = document.getElementById('recording_button');
		this.rec_pause_button = document.getElementById('rec_pause_button');

		this.stream_button.addEventListener(   'click', this.toggle_streaming.bind(this));
		this.recording_button.addEventListener('click', this.toggle_recording.bind(this));
		this.rec_pause_button.addEventListener('click', this.toggle_rec_pause.bind(this));

		// virtual camera button
		this.virtualcam_button = document.getElementById('virtualcam_button');
		this.virtualcam_button.addEventListener('click', this.toggle_virtualcam.bind(this));

		// status checklist setup
		this.setup_checklist();

		// start interval updates
		window.setInterval(this.update_status_clock.bind(this),1000);

		// this is more of a setup function than updater
		this.update_source_list();

		// the dashboard header: switcher, hidden items, sort and the editor
		this.setup_view_bar();

		// setup obs event handlers (v5 names; payloads carry the state directly)
		wrc.on('StudioModeStateChanged',     this.on_studio_mode_switched.bind(this));
		wrc.on('CurrentProgramSceneChanged', this.on_scene_changed.bind(this));
		wrc.on('CurrentPreviewSceneChanged', this.on_preview_changed.bind(this));

		wrc.on('SceneListChanged',           this.on_scenes_changed.bind(this));
		wrc.on('SceneNameChanged',           this.on_scene_renamed.bind(this));
		wrc.on('InputCreated',               this.on_source_created.bind(this));
		wrc.on('InputRemoved',               this.on_source_destroyed.bind(this));
		wrc.on('InputNameChanged',           this.on_source_renamed.bind(this));

		wrc.on('StreamStateChanged',         this.on_stream_state.bind(this));
		wrc.on('RecordStateChanged',         this.on_record_state.bind(this));
		wrc.on('VirtualcamStateChanged',     this.on_virtualcam_state.bind(this));
		wrc.on('ReplayBufferStateChanged',   this.on_replay_buffer_state.bind(this));
	}

	on_connected () {
		// the socket was down for a while: inputs may have come and gone, so the
		// kind map from before the reconnect cannot be trusted
		this.clear_input_kinds();

		// a reconnect re-earns the prune: two polls that agreed before the drop
		// say nothing about the collection now
		this.view_pruned     = false;
		this.prune_signature = null;

		// one batch for the first paint; events keep it current afterwards
		this.initial_poll().catch(this.log_async_error);

		// setup interval for refreshing data
		this.interval_timer = window.setTimeout(this.update_on_interval.bind(this), 3000);
	}

	async initial_poll () {
		let results = null;

		try {
			results = await wrc.batch([
				{ requestType: 'GetVideoSettings' },
				{ requestType: 'GetSceneList' },
				{ requestType: 'GetStudioModeEnabled' },
				{ requestType: 'GetVirtualCamStatus' },
			]);
		} catch (e) {
			results = null;
		}

		if (!results)
			return;

		this.apply_video_settings(results[0]);
		this.apply_scene_list(results[1]);

		if (results[2].ok) {
			this.studio_mode = results[2].data.studioModeEnabled;
			this.update_studio_mode();
			this.update_scenes();
		}

		if (results[3].ok) {
			this.virtualcam_active = results[3].data.outputActive;
			this.update_virtualcam_status();
		}

		this.update_audio_list().catch(this.log_async_error);
	}

	on_disconnected () {
		// invalidate any poll tick still awaiting its batch, so it cannot re-arm
		this.connection_generation++;

		this.pause_update_on_interval();

		for (var name in this.scenes) {
			this.scenes[name].pause_update();
		}

		// TODO loop over audio sources as well
	}

	is_connection_open () {
		// TODO return true if connected but false if in the midst of scenecollection or profile change
		return wrc.isConnected;
	}

	log_async_error (e) {
		// fire-and-forget paths must not lose their failures silently
		console.error('WebRemote: async task failed', e);
	}

	apply_video_settings (result) {
		if (!result || !result.ok)
			return;

		this.apply_video_data(result.data);
	}

	apply_video_data (data) {
		this.video_width  = data.baseWidth;
		this.video_height = data.baseHeight;

		this.aspect_ratio = `${this.video_width}/${this.video_height}`;

		const denominator = data.fpsDenominator || 1;
		this.video_fps    = data.fpsNumerator / denominator;
	}

	async update_on_interval () {
		this.pause_update_on_interval();

		// the tick that started under this generation may re-arm; a tick whose
		// batch spans a disconnect must not, or polling would resume behind the
		// reconnect and run a second chain alongside the one on_connected starts
		const generation = this.connection_generation;

		let results = null;

		try {
			results = await wrc.batch([
				{ requestType: 'GetStreamStatus' },
				{ requestType: 'GetRecordStatus' },
				{ requestType: 'GetVirtualCamStatus' },
				{ requestType: 'GetReplayBufferStatus' },
				{ requestType: 'GetStats' },
				{ requestType: 'GetVideoSettings' },
				{ requestType: 'GetOutputList' },
			]);
		} catch (e) {
			results = null;
		}

		if (results) {
			// a throw in either must not cost the tick its re-arm below, or
			// polling stops for good with the page still looking alive
			try {
				this.update_status_list(results);
				this.update_outputs(results[6]);
			} catch (e) {
				this.log_async_error(e);
			}
		}

		// a view change that could not re-read the inputs leaves the audio DOM
		// disagreeing with the store; retry here rather than on the next event
		if (this.audio_refresh_pending && generation === this.connection_generation) {
			try {
				await this.update_audio_list();
			} catch (e) {
				// a rejected refresh must not cost the tick its re-arm
				this.log_async_error(e);
			}
		}

		// reset interval timeout, but only while this tick still belongs to the
		// current connection
		if (generation === this.connection_generation)
			this.interval_timer = window.setTimeout(this.update_on_interval.bind(this), 3000);
	}

	pause_update_on_interval () {
		// clear timeout
		window.clearTimeout(this.interval_timer);
	}

	toggle_fullscreen () {
		if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
			document.documentElement.requestFullscreen();
		} else if (document.exitFullscreen) {
			document.exitFullscreen();
		}
	}

	handle_fullscreen_event () {
		this.button_fullscreen.className = document.fullscreenElement ? 'top-button small-button fullscreen' : 'top-button small-button';
	}

	async get_studio_mode () {
		const data = await wrc.safeCall('GetStudioModeEnabled');

		if (!data)
			return;

		this.studio_mode = data.studioModeEnabled;

		this.update_studio_mode();
		this.update_scenes();
	}

	on_studio_mode_switched (e) {
		this.studio_mode = e.studioModeEnabled;
		this.update_studio_mode();
	}

	update_studio_mode () {
		// update stuff
		if (!this.studio_mode) {
			if (this.scenes[ this.scene_preview ]) {
				this.scenes[ this.scene_preview ].is_preview = false;
				this.scenes[ this.scene_preview ].update();
			}
			this.scene_preview = '';
		}
		this.button_transition.className  = (this.studio_mode) ? '' : 'hidden';
	}

	async toggle_studio_mode () {
		// v5 has no toggle request: read the current state, then set the opposite
		const data = await wrc.safeCall('GetStudioModeEnabled');

		if (!data)
			return;

		await wrc.safeCall('SetStudioModeEnabled', { studioModeEnabled: !data.studioModeEnabled });
	}

	async get_scene_list () {
		const data = await wrc.safeCall('GetSceneList');

		if (data)
			this.apply_scene_list({ ok: true, data: data });
	}

	/**
	 * A stable key for any item, defined once in keys.js so the Node store tests
	 * can import it. Call sites keep their current names.
	 */
	scene_key (scene) {
		return scene_key_of(scene);
	}

	input_key (input) {
		return input_key_of(input);
	}

	apply_scene_list (result) {
		if (!result || !result.ok)
			return;

		const data = result.data;

		// Raw payload in OBS order (sceneIndex), which is what "Sort: OBS order"
		// means. What gets rendered is a filtered, hand-ordered view of this.
		this.raw_scenes = (data.scenes || []).slice()
			.sort((a, b) => a.sceneIndex - b.sceneIndex);

		this.scene_names = new Map();
		this.raw_scenes.forEach((scene) => {
			const key = this.scene_key(scene);

			if (key)
				this.scene_names.set(key, scene.sceneName || '');
		});

		this.seed_legacy_hidden();
		this.prune_view_once();
		this.apply_scene_curation();

		// program and preview state after a scene list change
		this.on_scene_changed({ sceneName: data.currentProgramSceneName });
		this.on_preview_changed({ sceneName: data.currentPreviewSceneName });
	}

	// the live sequence the store arranges, filtered down to what is visible
	apply_scene_curation () {
		const keyed = this.raw_scenes.map((scene) => ({ scene: scene, key: this.scene_key(scene) }));

		// one unkeyable scene means the list cannot be arranged at all: keep OBS
		// order instead of handing the store a short or empty sequence
		const order = keyed.every((entry) => entry.key)
			? this.view.effective_order('scenes', keyed.map((entry) => entry.key))
			: keyed.map((entry) => entry.key).filter(Boolean);

		const by_key = new Map();

		keyed.forEach((entry) => {
			if (entry.key)
				by_key.set(entry.key, entry.scene);
		});

		this.scene_list = order
			.map((key) => by_key.get(key))
			.filter((scene) => scene && this.view.visible('scenes', this.scene_key(scene)));

		this.update_scene_list();
		this.render_view_bar();
	}

	update_scene_list () {
		this.tick += 1;

		// catch some odd error
		if (!this.scene_list) {
			return;
		}

		for (let i = 0; i < this.scene_list.length; i++) {
			let name = this.scene_list[i].sceneName;
			let key  = this.scene_key(this.scene_list[i]);

			if (this.scenes[name]) {
				// the printed number is the on-screen position, not sceneIndex:
				// it follows the curated order on purpose, so a reorder renumbers
				// the hotkey hints with the tiles
				this.scenes[name].change_index(i);
				this.scenes[name].update(this.tick);
			} else {
				// if not found, create element
				let scene = new SourceScene(i, name, key);

				this.scenes[name] = scene;
				this.scenes[name].update(this.tick);
				document.getElementById('scene_list').appendChild(scene.el);
			}
		}

		// the sequence is the DOM's: move rows into their view order rather than
		// leaning on a CSS order, so the sorter and the render agree
		h.place_rows(document.getElementById('scene_list'),
			this.scene_list.map((scene) => this.scenes[scene.sceneName])
				.filter(Boolean)
				.map((scene) => scene.el));

		// remove scenes that are no longer current
		for (let sname in this.scenes) {
			if (this.scenes[sname].last_update != this.tick) {
				this.scenes[sname].pause_update();

				// a rebuild can drop the row a drag is using: its listeners and
				// the armed click would otherwise outlive the element
				if (this.drag && this.drag.el === this.scenes[sname].el)
					this.release_row_drag(this.drag);

				document.getElementById('scene_list').removeChild( this.scenes[sname].el );
				delete this.scenes[sname];
			}
		}
	}

	async update_scenes () {
		await this.get_scene_list();
	}

	on_preview_changed (e) {
		const scene_name = e.sceneName || '';

		// first, update old preview scene
		if (this.scenes[ this.scene_preview ]) {
			this.scenes[ this.scene_preview ].unset_preview();
		}

		this.scene_preview = scene_name;

		// update new preview scene
		if (this.scenes[ scene_name ]) {
			this.scenes[ scene_name ].set_preview();
		}
	}

	on_scene_changed (e) {
		const scene_name = e.sceneName || '';

		// first, update old program scene
		if (this.scenes[ this.scene_program ]) {
			this.scenes[ this.scene_program ].unset_program();
		}

		this.scene_program = scene_name;

		// update new program scene
		if (this.scenes[ scene_name ]) {
			this.scenes[ scene_name ].set_program();
		}

		// the audio rows resolve their scene item against the program scene, so
		// they must re-resolve it here or their visible/in-scene state freezes
		for (let i = 0; i < this.audio_list.length; i++) {
			this.audio_list[i].on_scene_changed(scene_name);
		}
	}

	on_scene_renamed (e) {
		const old_name = e.oldSceneName || '';
		const new_name = e.sceneName || '';
		const scene    = this.scenes[old_name];

		if (scene) {
			scene.change_name(new_name);

			// uuid-keyed scenes keep their key through a rename; a name-keyed
			// one (OBS 28) follows the name so the hidden list stops lying
			const old_key = 'scene-name:' + old_name;
			const new_key = 'scene-name:' + new_name;

			if (this.scene_names.has(old_key)) {
				this.scene_names.delete(old_key);
				this.scene_names.set(new_key, new_name);

				// the stored lists follow the key too, or a hidden scene
				// reappears and the stale key hides its successor
				this.view.rename_key('scenes', old_key, new_key);

				if (scene.el && scene.el.dataset.wrKey === old_key) {
					scene.key = new_key;
					scene.el.dataset.wrKey = new_key;
				}
			}

			// this.scenes is keyed by name, so move the entry with the tile
			delete this.scenes[old_name];
			this.scenes[new_name] = scene;
		}

		if (this.scene_program === old_name) {
			this.scene_program = new_name;

			for (let i = 0; i < this.audio_list.length; i++) {
				this.audio_list[i].on_scene_changed(new_name);
			}
		}

		if (this.scene_preview === old_name)
			this.scene_preview = new_name;
	}

	on_scenes_changed (e) {
		// v5 payload carries no uuids and no program/preview summary, so re-read.
		// A collection switch re-earns the prune: agreement from the last one
		// says nothing about this one.
		this.view_pruned     = false;
		this.prune_signature = null;
		this.get_scene_list().catch(this.log_async_error);
	}

	on_source_created (e) {
		// a new input may be an audio-capable one, and it changes the kind map
		this.clear_input_kinds();
		this.update_audio_list().catch(this.log_async_error);
	}

	on_source_destroyed (e) {
		// a removed input leaves a stale kind behind, which decides whether an
		// opted-in source gets the styling controls at all
		this.clear_input_kinds();
		this.update_audio_list().catch(this.log_async_error);
	}

	on_source_renamed (e) {
		// names changed, so the audio list labels and the kind map are stale
		this.clear_input_kinds();
		this.update_audio_list().catch(this.log_async_error);

		// a pane bound to the old name can no longer write to that source: say
		// so rather than letting it reject every write in silence
		const old_name = e && e.oldInputName;
		const new_name = e && e.inputName;

		if (old_name)
			this.text_panes.forEach((pane) => pane.on_source_renamed(old_name));

		// inputs without uuids are keyed by name, so the stored keys follow the
		// rename here as well, or a hidden input comes back under its new name
		if (old_name && new_name && old_name !== new_name)
			this.view.rename_key('audio', 'input-name:' + old_name, 'input-name:' + new_name);
	}

	async transition () {
		if (this.studio_mode) {
			await wrc.safeCall('TriggerStudioModeTransition');
		}
	}

	async update_audio_list () {
		const list = await wrc.safeCall('GetInputList');

		if (!list) {
			// the store may already say a row is hidden while the DOM still shows
			// it: say so once and let the interval tick retry
			this.audio_refresh_pending = true;
			console.warn('WebRemote: audio list not refreshed; the view is stale until the next poll');
			return;
		}

		this.audio_refresh_pending = false;

		const inputs = list.inputs || [];

		// Identity for every input, audio or not: the text panes need the key to
		// know whether their source is hidden or off-dashboard.
		this.input_uuids = new Map();
		this.input_names = new Map();

		inputs.forEach((input) => {
			const key = this.input_key(input);

			if (!key)
				return;

			this.input_uuids.set(input.inputName, key);
			this.input_names.set(key, input.inputName || '');
		});

		this.prune_view_once();

		// second, get special inputs (sceneless ones)
		let special_sources = [];

		const special = await wrc.safeCall('GetSpecialInputs');

		if (special) {
			// v5 returns names; unused slots are null
			for (let key in special) {
				if (special[key])
					special_sources.push(special[key]);
			}
		}

		// v5 has no source-type capability list: an input answers
		// GetInputAudioTracks only when it actually has audio.
		let results = [];

		if (inputs.length) {
			const request_tracks = function () {
				return wrc.batch(inputs.map(function (input) {
					return {
						requestType: 'GetInputAudioTracks',
						requestData: { inputName: input.inputName },
					};
				}));
			};

			try {
				results = await request_tracks();
			} catch (e) {
				// one retry: a dropped batch is usually transport, not a refusal.
				// If it fails again every input is kept on the audio path, which
				// over-lists non-audio sources rather than losing an audio one.
				console.warn('WebRemote: GetInputAudioTracks batch failed, retrying once', e);

				try {
					results = await request_tracks();
				} catch (e2) {
					console.warn('WebRemote: GetInputAudioTracks batch failed twice; every input is treated as audio', e2);
					results = [];
				}
			}
		}

		let current_audio_names = [];

		// every audio-capable key in payload order, hidden ones included: the
		// store needs the whole list so hiding an item cannot cost it its slot
		const live_audio_keys = [];

		this.audio_keys = [];

		for (let i = 0; i < inputs.length; i++) {
			const result = results[i];

			// only 604 means "this input has no audio tracks"; any other failure
			// (dropped batch entry, timeout) keeps the row on the audio path, so
			// a transient fault cannot silently hide an audio input
			if (result && !result.ok && result.error && result.error.code === 604)
				continue;

			if (!result || !result.ok) {
				console.warn('WebRemote: GetInputAudioTracks failed for "' +
					inputs[i].inputName + '", keeping as audio',
					result ? result.error : 'no response');
			}

			const s = {
				name:   inputs[i].inputName,
				type:   'input',
				typeId: inputs[i].inputKind,
				key:    this.input_key(inputs[i]),
			};

			live_audio_keys.push(s.key);
			this.audio_keys.push(s.key);

			// hidden or off the active dashboard: no row at all, not a hidden one
			if (!this.view.visible('audio', s.key))
				continue;

			// first, check if it already exists. If so, skip
			let source_exists = false;
			for (let j = 0; j < this.audio_list.length; j++) {
				if (this.audio_list[j].name == s.name) {
					source_exists = true;
					current_audio_names.push(s.name);
					break;
				}
			}

			// create new SourceAudio when it's a new input
			if (!source_exists) {
				let sa = new SourceAudio(s, special_sources.includes(s.name));
				this.audio_list.push(sa);
				current_audio_names.push(s.name);
				document.getElementById('audio_list').appendChild( sa.get_element() );
			}
		}

		// handle situation where audio items still exist but have since been removed from OBS
		for (let k = this.audio_list.length - 1; k >= 0; k--) {
			let a = this.audio_list[k];

			if (!current_audio_names.includes(a.name)) {
				// remove and destroy element
				a.on_source_destroyed();

				// a rebuild can drop the row a drag is using: its listeners and
				// the armed click would otherwise outlive the element
				if (this.drag && this.drag.el === a.get_element())
					this.release_row_drag(this.drag);

				document.getElementById('audio_list').removeChild( a.get_element() );

				// remove from audio list
				let ix = this.audio_list.indexOf(a);
				this.audio_list.splice(ix,1);
			}
		}

		this.apply_audio_order(live_audio_keys);
		this.render_view_bar();
	}

	// hand-arranged order first, unseen inputs at the tail in payload order
	apply_audio_order (live_keys) {
		// one unkeyable input means the list cannot be arranged at all: leave the
		// rows in payload order rather than dropping it from the sequence
		if (live_keys.some((key) => !key)) {
			h.place_rows(document.getElementById('audio_list'), this.audio_list.map((row) => row.get_element()));
			return;
		}

		const order   = this.view.effective_order('audio', live_keys);
		const by_key  = new Map();

		this.audio_list.forEach((row) => {
			if (row.key)
				by_key.set(row.key, row);
		});

		h.place_rows(document.getElementById('audio_list'),
			order.map((key) => by_key.get(key))
				.filter(Boolean)
				.map((row) => row.get_element()));
	}

	update_source_list () {
		/*
		 * Flexible parsing of inputs that can be used to adjust OBS source items.
		 * 
		 * Currently supported:
		 * - Text inputs
		 * - Select inputs (can feed into multiple text sources)
		 */

		let input_list  = [];
		let select_list = [];

		// get all potential inputs
		let all_inputs = document.getElementsByTagName('input');

		for (var i = 0; i < all_inputs.length; i++) {
			let ix = all_inputs[i].getAttribute('data-wr-source');

			if (ix != null)
				input_list.push(all_inputs[i]);
		}

		// get all potential select elements
		let all_select_els = document.getElementsByTagName('select');

		for (var j = 0; j < all_select_els.length; j++) {
			let sx = all_select_els[j].getAttribute('data-wr-selector');

			if (sx != null)
				select_list.push(all_select_els[j]);
		}

		// set up source items
		input_list.forEach((item) => {
			item.addEventListener('change', function (e) {
				this.set_text(e.target.name, e.target.value);
				e.preventDefault()
			}.bind(this), false);

			this.attach_text_pane(item);
		});

		// set up select elements
		select_list.forEach((item) => {
			let sources = item.getAttribute('data-wr-selector').split('|');

			item.addEventListener('change', function (e) {
				var values = e.target.value.split('|');

				// assumption that length of values matches sources
				for (var k = 0; k < sources.length; k++) {
					// the list holds element ids; the pane reads the same name rule
					let source_el = document.getElementById(sources[k]);
					let target    = source_name_of(source_el) || sources[k];

					// set value in UI (if it exists)
					if (source_el)
						source_el.value = values[k];

					// send value to OBS
					this.set_text(target, values[k]);
				}

				e.preventDefault()
			}.bind(this), false);
		});

		// the list may have painted before the kind map arrived, so a text source
		// written in markup and one OBS only knows about are handled the same way
		this.refresh_text_panes();
	}

	/**
	 * Attach a pane to an input, whether the operator wrote the input in markup or
	 * sync_text_panes created it for an OBS text source. The input stays in the DOM
	 * (hidden) so name/id and the selector fan-out above keep working exactly as
	 * before. Idempotent: an input that already has a pane keeps that one.
	 */
	attach_text_pane (inItem) {
		if (!inItem)
			return null;

		const uuid = this.input_uuids.get(source_name_of(inItem));

		// a hidden or off-dashboard input gets no pane and no auto-source stamp
		if (uuid && !this.view.visible('audio', uuid)) {
			this.set_source_row_visible(inItem, false);

			if (inItem.wr_text_pane) {
				inItem.wr_text_pane.destroy();
				inItem.wr_text_pane.get_element().remove();
				this.text_panes = this.text_panes.filter((pane) => pane !== inItem.wr_text_pane);
				delete inItem.wr_text_pane;
				inItem.classList.remove('wr-text-input-replaced');
			}

			return null;
		}

		this.set_source_row_visible(inItem, true);

		if (!inItem.wr_text_pane) {
			inItem.wr_text_pane = new SourceText(inItem, this);
			inItem.classList.add('wr-text-input-replaced');
			inItem.parentNode.insertBefore(inItem.wr_text_pane.get_element(), inItem.nextSibling);
			this.text_panes.push(inItem.wr_text_pane);
		}

		return inItem.wr_text_pane;
	}

	// a markup row is never deleted by a view filter, only hidden, so the
	// operator's own index.html survives hiding and unhiding
	set_source_row_visible (inEl, visible) {
		const row = inEl && inEl.closest ? inEl.closest('li') : null;

		if (row)
			row.classList.toggle('wr-view-hidden', !visible);
	}

	/**
	 * A pane per text source, decided by the kind map rather than by markup, so
	 * no attribute is needed. Runs whenever the map arrives, which may be before
	 * or after the list renders, and again after every invalidation.
	 */
	async sync_text_panes () {
		const kinds = await this.get_input_kinds();

		// a read that failed leaves the panes alone: the next event retries
		if (!kinds)
			return;

		// a source that is gone, no longer text, or filtered out of the view
		// keeps no pane. An auto-created row is dropped whole; an opted-in row
		// stays (hidden) and reports the loss when it is opened.
		for (let i = this.text_panes.length - 1; i >= 0; i--) {
			const pane = this.text_panes[i];
			const el   = pane.input_el;
			const kind = el ? (kinds.get(pane.name) || '') : '';
			const uuid = el ? this.input_uuids.get(pane.name) : null;
			const gone = !el ||
				!is_text_kind(kind) ||
				(uuid && !this.view.visible('audio', uuid));

			if (!gone)
				continue;

			if (el && !el.wr_auto_source) {
				pane.destroy();
				pane.get_element().remove();
				el.classList.remove('wr-text-input-replaced');
				this.set_source_row_visible(el, false);
				this.text_panes.splice(i, 1);
				delete el.wr_text_pane;
				continue;
			}

			pane.destroy();
			pane.get_element().remove();

			if (el && el.parentNode)
				el.parentNode.remove();

			this.text_panes.splice(i, 1);

			if (el) {
				delete el.wr_text_pane;
				delete el.wr_auto_source;
			}
		}

		kinds.forEach((kind, name) => {
			if (!is_text_kind(kind))
				return;

			const uuid     = this.input_uuids.get(name);
			const existing = this.find_source_input(name);

			if (uuid && !this.view.visible('audio', uuid)) {
				if (existing)
					this.set_source_row_visible(existing, false);

				return;
			}

			const input = existing || this.create_source_input(name);

			if (!input)
				return;

			this.set_source_row_visible(input, true);
			this.attach_text_pane(input);
		});
	}

	// the kind map decides which panes exist, so a cleared map re-syncs them
	refresh_text_panes () {
		this.sync_text_panes().catch(this.log_async_error);
	}

	// --- view curation ------------------------------------------------------
	//
	// Three features, one store: hiding, a hand-arranged order, and dashboards
	// that filter all three lists by uuid. Everything below is additive to the
	// existing render paths; the lists themselves keep their old behaviour.

	// dangling keys are dropped once, and only after two consecutive polls agree:
	// a successful GetSceneList during a scene-collection switch is not proof the
	// collection is complete, so one partial list must not erase the arrangement
	prune_view_once () {
		if (this.view_pruned)
			return;

		// each kind is judged on its own live set: a rig with no inputs must not
		// keep stale scene keys for ever, and a failed GetInputList must never
		// license a prune of the audio list
		const scene_keys = this.raw_scenes.length
			? this.raw_scenes.map((scene) => this.scene_key(scene)).filter(Boolean)
			: null;
		const input_keys = this.input_names.size ? [...this.input_names.keys()] : null;

		if (!scene_keys && !input_keys)
			return;

		const signature = (scene_keys || []).slice().sort().join('|') +
			'#' + (input_keys || []).slice().sort().join('|');

		if (signature !== this.prune_signature) {
			this.prune_signature = signature;
			return;
		}

		// an empty list here means "not known", which prune() already treats as
		// "leave that kind alone"
		const removed = this.view.prune(scene_keys || [], input_keys || []);

		if (removed.scenes || removed.audio)
			console.log('WebRemote: pruned ' + removed.scenes + ' stale scene keys and ' +
				removed.audio + ' stale input keys from the saved view');

		this.view_pruned = true;
	}

	/**
	 * The old name-substring auto-hide, kept as a one-time default for a browser
	 * that has never curated anything. Zero matches on this rig; it exists so
	 * existing users do not suddenly see their helper scenes.
	 */
	seed_legacy_hidden () {
		if (!this.view.is_new || this.view_seeded)
			return;

		this.view_seeded = true;

		this.raw_scenes.forEach((scene) => {
			if (!/subscene|hidden/i.test(scene.sceneName || ''))
				return;

			const key = this.scene_key(scene);

			if (key)
				this.view.set_hidden('scenes', key, true);
		});
	}

	// the document guard consumes the one click a grip press leaves behind; this
	// keeps a row handler that somehow saw the same click from acting on it too
	consume_row_click_suppress (e) {
		if (this.drag_click_pointer === null)
			return false;

		// a click carries the pointer that produced it; a synthetic one may not,
		// and then this press is the only thing it can belong to
		if (e && e.pointerId !== undefined && e.pointerId !== this.drag_click_pointer)
			return false;

		this.drag_click_pointer = null;
		return true;
	}

	// anything that changes the view re-renders the lists it governs
	refresh_curation () {
		this.render_view_bar();

		if (this.raw_scenes.length)
			this.apply_scene_curation();

		this.update_audio_list().catch(this.log_async_error);
		this.refresh_text_panes();
	}

	set_hidden (kind, key, hidden) {
		if (!key)
			return;

		// hiding pulls the focused row out of the DOM: remember its neighbours so
		// the eye control that replaces it can take focus back
		const rows     = [...document.querySelectorAll(this.row_selector(kind))];
		const at       = rows.findIndex((el) => el.dataset.wrKey === key);
		const next_key = at >= 0 && rows[at + 1] ? rows[at + 1].dataset.wrKey : null;
		const prev_key = at > 0 ? rows[at - 1].dataset.wrKey : null;
		const in_panel = !!(document.activeElement && document.activeElement.closest('.wr-panel'));

		this.view.set_hidden(kind, key, hidden);
		this.refresh_curation();

		// a button inside the hidden panel restores its own focus after the
		// rebuild; do not yank it back out to a row
		if (!in_panel)
			this.restore_row_focus(kind, next_key, prev_key);
	}

	// focus the eye of the row now in the removed row's place, else the previous
	// row's, else the header control that can bring the item back
	restore_row_focus (kind, next_key, prev_key) {
		const rows = [...document.querySelectorAll(this.row_selector(kind))];
		const row  = rows.find((el) => el.dataset.wrKey === next_key) ||
			rows.slice().reverse().find((el) => el.dataset.wrKey === prev_key) ||
			rows[0];
		const btn  = row ? row.querySelector('.wr-hide') : null;
		const fallback = this.viewbar && this.viewbar.hidden_btn;

		if (btn)
			btn.focus();
		else if (fallback)
			fallback.focus();
	}

	// everything currently on screen, which is what a dashboard edits
	visible_keys () {
		const out = [];

		this.scene_list.forEach((scene) => {
			const key = this.scene_key(scene);

			if (key)
				out.push(key);
		});

		this.audio_list.forEach((row) => {
			if (row.key)
				out.push(row.key);
		});

		// panes are inputs too: a dashboard that cannot hold a text key blacks
		// every pane out, so the ones actually on screen count as visible
		this.text_panes.forEach((pane) => {
			const key = this.input_uuids.get(pane.name);
			const row = pane.input_el && pane.input_el.closest('li');

			if (key && !(row && row.classList.contains('wr-view-hidden')))
				out.push(key);
		});

		return out;
	}

	// the text sources the app already derives panes from, for the dashboard editor
	text_sources () {
		const out = [];

		if (!this.input_kinds)
			return out;

		this.input_kinds.forEach((kind, name) => {
			if (!is_text_kind(kind))
				return;

			const key = this.input_uuids.get(name);

			if (key)
				out.push({ key: key, name: name });
		});

		return out;
	}

	sort_view (mode) {
		const scenes = this.raw_scenes.map((scene) => ({ key: this.scene_key(scene), name: scene.sceneName || '' }));
		const audio  = this.audio_keys.map((key) => ({ key: key, name: this.input_names.get(key) || '' }));

		[['scenes', scenes], ['audio', audio]].forEach(([kind, items]) => {
			const seq = items
				.filter((item) => item.key)
				.sort((a, b) => mode === 'az' ? a.name.localeCompare(b.name) : 0)
				.map((item) => item.key);

			// one-shot: OBS order is the payload order, A-Z is by display name.
			// An empty sequence is a read that saw nothing, never a sort request
			if (seq.length)
				this.view.sort_to(kind, seq);
		});

		this.refresh_curation();
	}

	// --- row order: pointer sorter plus the keyboard and button equivalents --

	row_selector (kind) {
		return kind === 'scenes' ? '#scene_list > .scene' : '#audio_list > .audio-item';
	}

	move_row (kind, key, delta) {
		if (!key)
			return;

		const rows = [...document.querySelectorAll(this.row_selector(kind))]
			.filter((el) => el.dataset.wrKey);
		const el = rows.find((row) => row.dataset.wrKey === key);

		if (!el)
			return;

		const target = rows[rows.indexOf(el) + delta];

		if (!target)
			return;

		el.parentNode.insertBefore(el, delta < 0 ? target : target.nextSibling);
		this.commit_row_order(kind);

		if (el.focus)
			el.focus();
	}

	// read the sequence off the DOM, but keep hidden items in the slots they
	// held, so arranging the visible ones cannot evict a hidden one for good
	commit_row_order (kind) {
		const dom_seq = [...document.querySelectorAll(this.row_selector(kind))]
			.map((el) => el.dataset.wrKey)
			.filter(Boolean);
		const live = this.view.live_list(kind);

		if (!live.length || !dom_seq.length)
			return;

		const full = this.view.effective_order(kind, live);
		let j = 0;

		const merged = full.map((key) => dom_seq.includes(key) ? dom_seq[j++] : key);

		this.view.sort_to(kind, merged);

		if (kind === 'scenes')
			this.apply_scene_curation();
	}

	// one code path for mouse, touch and pen: no HTML5 drag events
	begin_row_drag (e, el, kind, key) {
		if (!el || !key)
			return;

		if (e.pointerType === 'mouse' && e.button !== 0)
			return;

		e.preventDefault();
		e.stopPropagation();

		// a second grip pressed before the first pointer ends would take this.drag
		// away from it, leaving that row stuck mid-drag with its listeners on
		if (this.drag)
			this.release_row_drag(this.drag);

		el.setPointerCapture(e.pointerId);

		// a press that never moves still ends in a click, so arm the one-shot
		// suppression now: that click, and only that one, is discarded
		this.drag_click_pointer = e.pointerId;

		this.drag = {
			el        : el,
			kind      : kind,
			key       : key,
			pointer_id: e.pointerId,
			x         : e.clientX,
			y         : e.clientY,
			moved     : false
		};

		el.classList.add('wr-row-dragging');
		el.addEventListener('pointermove', this.drag_move_bound, false);
		el.addEventListener('pointerup', this.drag_end_bound, false);
		el.addEventListener('pointercancel', this.drag_end_bound, false);
	}

	on_row_drag_move (e) {
		const drag = this.drag;

		if (!drag || e.pointerId !== drag.pointer_id)
			return;

		if (!drag.moved) {
			if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) <= 4)
				return;

			drag.moved = true;
		}

		e.preventDefault();

		// the dragged row is pointer-events:none while it travels, so this hit
		// test lands on the row underneath rather than on the row itself
		const under  = document.elementFromPoint(e.clientX, e.clientY);
		const target = under && under.closest ? under.closest(this.row_selector(drag.kind)) : null;

		if (!target || target === drag.el || target.parentNode !== drag.el.parentNode)
			return;

		const rect   = target.getBoundingClientRect();
		const before = e.clientY < rect.top + rect.height / 2 ||
			(e.clientY < rect.bottom && e.clientX < rect.left + rect.width / 2);
		const ref    = before ? target : target.nextSibling;

		// comparing against the two no-op cases keeps a stationary pointer from
		// thrashing the DOM on every move event
		if (ref !== drag.el && ref !== drag.el.nextSibling)
			drag.el.parentNode.insertBefore(drag.el, ref);
	}

	on_row_drag_end (e) {
		const drag = this.drag;

		if (!drag || e.pointerId !== drag.pointer_id)
			return;

		this.release_row_drag(drag);

		// a cancelled gesture leaves no click behind; a release does, and the
		// capture-phase guard discards exactly that one
		if (e.type === 'pointercancel')
			this.drag_click_pointer = null;

		if (!drag.moved)
			return;

		this.commit_row_order(drag.kind);
	}

	// drop the listeners and the styling of a drag through the element that
	// carries them, not through whatever this.drag points at now
	release_row_drag (drag) {
		if (!drag)
			return;

		drag.el.removeEventListener('pointermove', this.drag_move_bound, false);
		drag.el.removeEventListener('pointerup', this.drag_end_bound, false);
		drag.el.removeEventListener('pointercancel', this.drag_end_bound, false);
		drag.el.classList.remove('wr-row-dragging');

		if (drag.el.hasPointerCapture && drag.el.hasPointerCapture(drag.pointer_id))
			drag.el.releasePointerCapture(drag.pointer_id);

		if (this.drag === drag)
			this.drag = null;
	}

	// --- the dashboard header ----------------------------------------------

	setup_view_bar () {
		const select       = document.getElementById('wr_dashboard');
		const hidden_btn   = document.getElementById('wr_hidden_btn');
		const hidden_panel = document.getElementById('wr_hidden_panel');
		const sort         = document.getElementById('wr_sort');
		const dash_btn     = document.getElementById('wr_dash_btn');
		const dash_panel   = document.getElementById('wr_dash_panel');

		if (!select || !hidden_btn || !hidden_panel || !sort || !dash_btn || !dash_panel)
			return;

		this.viewbar = {
			select: select,
			hidden_btn: hidden_btn,
			hidden_panel: hidden_panel,
			sort: sort,
			dash_btn: dash_btn,
			dash_panel: dash_panel,
			save_warning: document.getElementById('wr_save_warning')
		};

		this.viewbar_sig = '';

		// A grip press leaves exactly one click behind, and that click is not a
		// scene switch. Swallow that one, keyed to the pointer that pressed: a
		// document-wide time window also ate unrelated clicks and let a click
		// that arrived late through. A new press means the old click never
		// arrived, so disarm before it can cost a real one; a cancel leaves no
		// click at all.
		document.addEventListener('click', (e) => {
			if (this.consume_row_click_suppress(e))
				e.stopPropagation();
		}, true);

		document.addEventListener('pointerdown', () => {
			this.drag_click_pointer = null;
		}, true);

		document.addEventListener('pointercancel', () => {
			this.drag_click_pointer = null;
		}, true);

		// another tab (a phone next to a desktop) wrote the view: adopt it
		// rather than overwriting it with this tab's stale copy
		window.addEventListener('storage', (e) => {
			if (e.key !== null && e.key !== STORAGE_KEY)
				return;

			this.view.load();
			this.view_pruned    = false;
			this.prune_signature = null;
			this.refresh_curation();
		}, false);

		select.addEventListener('change', () => {
			this.view.set_active_dashboard(select.value || null);
			this.refresh_curation();
		}, false);

		sort.addEventListener('change', () => {
			const mode = sort.value;
			sort.value = '';

			if (mode)
				this.sort_view(mode);
		}, false);

		hidden_btn.addEventListener('click', () => {
			this.toggle_view_panel('hidden');
		}, false);

		dash_btn.addEventListener('click', () => {
			this.toggle_view_panel('dash');
		}, false);

		this.render_view_bar();
	}

	toggle_view_panel (which) {
		const bar = this.viewbar;

		if (!bar)
			return;

		const open_hidden = which === 'hidden' && bar.hidden_panel.hidden;
		const open_dash   = which === 'dash' && bar.dash_panel.hidden;

		bar.hidden_panel.hidden = !open_hidden;
		bar.dash_panel.hidden   = !open_dash;

		bar.hidden_btn.setAttribute('aria-expanded', open_hidden ? 'true' : 'false');
		bar.dash_btn.setAttribute('aria-expanded', open_dash ? 'true' : 'false');

		if (open_hidden)
			this.render_hidden_panel();

		if (open_dash)
			this.render_dash_panel();
	}

	hidden_items () {
		const out = [];

		this.view.hidden_list('scenes').forEach((key) => {
			if (this.scene_names.has(key))
				out.push({ key: key, kind: 'scenes', name: this.scene_names.get(key) });
		});

		this.view.hidden_list('audio').forEach((key) => {
			if (this.input_names.has(key))
				out.push({ key: key, kind: 'audio', name: this.input_names.get(key) });
		});

		return out;
	}

	render_view_bar () {
		const bar = this.viewbar;

		if (!bar)
			return;

		const dashboards = this.view.dashboards();
		const active     = this.view.data.activeDashboard || '';
		const sig        = dashboards.map((d) => d.id + ':' + d.name).join('|') + '#' + active;

		// rebuilding the options on every render would drop focus mid-keyboard
		if (sig !== this.viewbar_sig) {
			this.viewbar_sig = sig;

			bar.select.textContent = '';
			bar.select.appendChild(new Option('All', ''));

			dashboards.forEach((dash) => {
				bar.select.appendChild(new Option(dash.name, dash.id));
			});

			bar.select.value = active;
		}

		const hidden_count = this.hidden_items().length;

		bar.hidden_btn.textContent = 'Hidden (' + hidden_count + ')';

		// a write that failed leaves the screen lying about what was kept, while
		// a newer version disables saving on purpose: that is not a failure
		if (bar.save_warning) {
			bar.save_warning.textContent = this.view.future
				? 'This view was saved by a newer version'
				: 'Changes cannot be saved in this browser';
			bar.save_warning.hidden = this.view.can_save();
		}

		if (!bar.hidden_panel.hidden)
			this.render_hidden_panel();

		// an audio event must not wipe a name half-typed in the editor
		if (!bar.dash_panel.hidden && !bar.dash_panel.contains(document.activeElement))
			this.render_dash_panel();
	}

	render_hidden_panel (force) {
		const panel = this.viewbar && this.viewbar.hidden_panel;

		if (!panel)
			return;

		const items = this.hidden_items();
		const sig   = items.map((item) => item.kind + ':' + item.key).join('|');

		// an OBS event must not rebuild an open panel and drop keyboard focus
		if (!force && sig === this.hidden_panel_sig && panel.firstChild)
			return;

		this.hidden_panel_sig = sig;
		panel.textContent = '';

		if (!items.length) {
			panel.appendChild(h.NewElement('p', {
				'className': 'wr-panel-empty',
				'innerHTML': 'Nothing is hidden.'
			}));
			return;
		}

		items.forEach((item) => {
			const row  = h.NewElement('div', {'className': 'wr-panel-row'});
			const name = h.NewElement('span', {'className': 'wr-panel-name'});
			const show = h.NewElement('button', {
				'type'     : 'button',
				'className': 'wr-panel-button',
				'innerHTML': 'Show'
			});

			name.textContent = item.name + (item.kind === 'audio' ? ' (audio)' : '');

			show.setAttribute('aria-label', 'Show ' + item.name);

			show.addEventListener('click', () => {
				// the panel is rebuilt by this call: keep focus on the same
				// position, or on the header control when nothing is left
				const buttons = [...panel.querySelectorAll('.wr-panel-button')];
				const at      = buttons.indexOf(show);

				this.set_hidden(item.kind, item.key, false);

				const left = [...panel.querySelectorAll('.wr-panel-button')];
				const next = left[Math.min(at, left.length - 1)] ||
					(this.viewbar && this.viewbar.hidden_btn);

				if (next)
					next.focus();
			}, false);

			row.appendChild(name);
			row.appendChild(show);
			panel.appendChild(row);
		});
	}

	render_dash_panel () {
		const panel = this.viewbar && this.viewbar.dash_panel;

		if (!panel)
			return;

		panel.textContent = '';

		// create
		const create_row = h.NewElement('div', {'className': 'wr-panel-row wr-panel-create'});
		const name_input = h.NewElement('input', {
			'type'       : 'text',
			'className'  : 'wr-input',
			'placeholder': 'New dashboard name',
			'aria-label' : 'New dashboard name'
		});

		const create_btn = h.NewElement('button', {
			'type'     : 'button',
			'className': 'wr-panel-button',
			'innerHTML': 'Create'
		});

		create_btn.addEventListener('click', () => {
			if (name_input.value.trim() === '')
				return;

			this.view.create_dashboard(name_input.value);
			name_input.value = '';
			this.refresh_curation();
		}, false);

		name_input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				create_btn.click();
			}
		}, false);

		create_row.appendChild(name_input);
		create_row.appendChild(create_btn);
		panel.appendChild(create_row);

		// existing dashboards, each editable in place
		this.view.dashboards().forEach((dash) => {
			const row = h.NewElement('div', {'className': 'wr-panel-row wr-dash-row'});
			const name = h.NewElement('input', {
				'type'     : 'text',
				'className': 'wr-input',
				'value'    : dash.name,
				'aria-label': 'Name of dashboard ' + dash.name
			});

			name.addEventListener('change', () => {
				this.view.rename_dashboard(dash.id, name.value);
				this.refresh_curation();
			}, false);

			const add_btn = h.NewElement('button', {
				'type'     : 'button',
				'className': 'wr-panel-button',
				'innerHTML': 'Add visible',
				'title'    : 'Add every item currently shown to this dashboard'
			});

			add_btn.addEventListener('click', () => {
				this.visible_keys().forEach((key) => this.view.add_dashboard_item(dash.id, key));
				this.refresh_curation();
			}, false);

			const remove_btn = h.NewElement('button', {
				'type'     : 'button',
				'className': 'wr-panel-button',
				'innerHTML': 'Remove visible',
				'title'    : 'Remove every item currently shown from this dashboard'
			});

			remove_btn.addEventListener('click', () => {
				this.visible_keys().forEach((key) => this.view.remove_dashboard_item(dash.id, key));
				this.refresh_curation();
			}, false);

			const del_btn = h.NewElement('button', {
				'type'     : 'button',
				'className': 'wr-panel-button wr-panel-danger',
				'innerHTML': 'Delete',
				'aria-label': 'Delete dashboard ' + dash.name
			});

			del_btn.addEventListener('click', () => {
				if (!window.confirm('Delete dashboard "' + dash.name + '"? Items return to All.'))
					return;

				this.view.delete_dashboard(dash.id);
				this.refresh_curation();
			}, false);

			row.appendChild(name);
			row.appendChild(add_btn);
			row.appendChild(remove_btn);
			row.appendChild(del_btn);
			panel.appendChild(row);

			// Text sources are inputs, so a dashboard that holds no text key
			// blacks every pane out. List them per dashboard, with membership
			// visible, so one can be added without switching back to All.
			const group = h.NewElement('div', {'className': 'wr-panel-group'});

			group.appendChild(h.NewElement('p', {
				'className': 'wr-panel-group-title',
				'innerHTML': 'Text sources'
			}));

			const sources = this.text_sources();

			if (!sources.length) {
				group.appendChild(h.NewElement('p', {
					'className': 'wr-panel-empty',
					'innerHTML': 'No text sources in OBS.'
				}));
			} else {
				sources.forEach((source) => {
					const label = h.NewElement('label', {'className': 'wr-panel-check'});
					const box   = h.NewElement('input', {'type': 'checkbox', 'className': 'wr-checkbox'});
					const text  = h.NewElement('span', {'className': 'wr-panel-name'});

					text.textContent = source.name;
					box.checked = dash.items.includes(source.key);

					box.addEventListener('change', () => {
						if (box.checked)
							this.view.add_dashboard_item(dash.id, source.key);
						else
							this.view.remove_dashboard_item(dash.id, source.key);

						this.refresh_curation();
					}, false);

					label.appendChild(box);
					label.appendChild(text);
					group.appendChild(label);
				});
			}

			panel.appendChild(group);
		});

		if (!this.view.dashboards().length) {
			panel.appendChild(h.NewElement('p', {
				'className': 'wr-panel-empty',
				'innerHTML': 'No dashboards yet. Create one, then add what is on screen.'
			}));
		}
	}

	// the input an operator already wrote for this source, if any: the panes and
	// the fan-out share one name rule, so they cannot disagree
	find_source_input (inName) {
		const list = document.getElementById('source_list');

		if (!list)
			return null;

		const inputs = list.getElementsByTagName('input');

		for (let i = 0; i < inputs.length; i++) {
			if (source_name_of(inputs[i]) === inName)
				return inputs[i];
		}

		return null;
	}

	// a row for a text source nobody wrote markup for, so it gets a pane the same
	// way an opted-in one does
	create_source_input (inName) {
		const list = document.getElementById('source_list');

		if (!list)
			return null;

		const row = h.NewElement('li', {'className': 'source-item'});

		const input = h.NewElement('input', {
			'type': 'text',
			'name': inName
		});

		input.wr_auto_source = inName;

		input.addEventListener('change', (e) => {
			this.set_text(e.target.name, e.target.value);
			e.preventDefault();
		}, false);

		row.appendChild(input);
		list.appendChild(row);

		return input;
	}

	async set_text (inSource, inText) {
		// v5 has no per-source-kind text request; the settings key is 'text'
		const ok = await this.set_input_settings(inSource, { text: inText });

		// keep a pane bound to this source in step with the write, e.g. after the
		// data-wr-selector fan-out sets several sources at once
		if (ok)
			this.text_panes.forEach((pane) => pane.set_remote_text(inSource, inText));

		return ok;
	}

	async set_input_settings (inSource, inSettings) {
		// overlay is shallow: omitted top-level keys survive, but a nested object
		// (font) is replaced whole, so callers must send that one complete
		const response = await wrc.safeCall('SetInputSettings', {
			inputName: inSource,
			inputSettings: inSettings,
			overlay: true,
		});

		return response !== null;
	}

	// drop the cached kind map; bumping the generation makes any read still in
	// flight discard its result instead of repopulating a map we just dropped
	clear_input_kinds () {
		this.input_kinds = null;
		this.input_kinds_generation++;

		// every call invalidates what the panes were built from, so re-read and
		// re-sync: the panes must survive a reconnect and follow a changed list
		this.refresh_text_panes();
	}

	async get_input_kinds () {
		// before the socket opens a read can only fail and log: let on_connected
		// clear the map and re-sync instead of calling into a closed connection
		if (!this.is_connection_open())
			return null;

		// one read per session, cached. The kind map decides which text sources get
		// a pane and whether that pane also gets the GDI+ styling controls.
		if (this.input_kinds)
			return this.input_kinds;

		const generation = this.input_kinds_generation;
		const response   = await wrc.safeCall('GetInputList');

		if (!response || !Array.isArray(response.inputs))
			return null;

		// something changed while this read was in flight, so the list may
		// predate it: read again rather than cache a stale map
		if (generation !== this.input_kinds_generation)
			return this.get_input_kinds();

		const kinds = new Map();

		response.inputs.forEach((input) => {
			if (input && input.inputName) {
				kinds.set(input.inputName, input.inputKind || '');

				// the panes consult the view before they exist, so identity has
				// to travel with the kind read and not wait for the audio poll
				if (input.inputUuid) {
					this.input_uuids.set(input.inputName, input.inputUuid);
					this.input_names.set(input.inputUuid, input.inputName);
				}
			}
		});

		this.input_kinds = kinds;

		return kinds;
	}

	update_status_list (results) {
		const stream = results[0];
		const record = results[1];
		const vcam   = results[2];
		const replay = results[3];
		const stats  = results[4];
		const video  = results[5];

		if (stream.ok) {
			const data = stream.data;

			this.streaming = data.outputActive;

			document.getElementById('status_stream').classList.toggle('good',   data.outputActive);
			document.getElementById('status_stream').classList.toggle('alert', !data.outputActive);

			document.getElementById('status_stream_text').innerHTML =
				(data.outputActive) ? 'LIVE: ' + data.outputTimecode.replace(/\.\d+/,'') : 'Not streaming';
		}

		if (record.ok) {
			const data = record.data;

			this.recording        = data.outputActive;
			this.recording_paused = data.outputPaused;

			if (data.outputActive) {
				document.getElementById('status_recording').classList.remove('alert');
				document.getElementById('status_recording').classList.toggle('warning',  data.outputPaused);
				document.getElementById('status_recording').classList.toggle('good',    !data.outputPaused);

				document.getElementById('status_recording_text').innerHTML =
					(data.outputPaused ? 'Paused ' : 'REC ') + data.outputTimecode.replace(/\.\d+/,'');
			} else {
				document.getElementById('status_recording').classList.remove('warning');
				document.getElementById('status_recording').classList.remove('good');
				document.getElementById('status_recording').classList.add('alert');
				document.getElementById('status_recording_text').innerHTML = 'Not recording';
			}
		}

		if (vcam.ok) {
			this.virtualcam_active = vcam.data.outputActive;
			this.update_virtualcam_status();
		}

		if (replay.ok)
			this.replay_active = replay.data.outputActive;

		if (video && video.ok)
			this.apply_video_data(video.data);

		if (stats.ok) {
			const data = stats.data;

			document.getElementById('status_cpu').className =
				(data.cpuUsage > 50) ? 'status-item warning' : 'status-item';
			document.getElementById('status_cpu_text').innerHTML =
				Math.ceil(data.cpuUsage) + '%';

			let pct_time_per_frame = 0;

			if (this.video_fps) {
				const fps_time_per_frame = 1000 / this.video_fps;
				const avg_time_per_frame = data.averageFrameRenderTime; // millis
				pct_time_per_frame = h.round(100.0 * avg_time_per_frame / fps_time_per_frame);
			}

			let is_alert_state = (data.outputTotalFrames > 0 && data.outputSkippedFrames / data.outputTotalFrames > 0.05);
			if (!is_alert_state) {
				is_alert_state = (data.activeFps < this.video_fps);
			}
			if (!is_alert_state) {
				is_alert_state = (pct_time_per_frame > 50);
			}
			document.getElementById('status_frames').className = (is_alert_state) ? 'status-item alert' : 'status-item';
			document.getElementById('status_frames_text').innerHTML =
				Math.round(data.activeFps) + ' fps, ' + pct_time_per_frame + '%, ' + data.outputSkippedFrames + ' skipped';
		}

		this.update_stream_rec_status();
	}

	update_status_clock () {
		this.clock_text.innerHTML = (new Date()).toLocaleTimeString('nl-NL');  // 24 hour format
		this.clock.classList.toggle('alert', !wrc.isConnected);
	}

	setup_checklist () {
		// prepare list
		let check_list  = document.getElementById('status_ordered_checklist');
		let check_items = check_list.children;

		for (var i = 0; i < check_items.length; i++) {
			let el      = check_items[i];
			let el_text = check_items[i].innerHTML;

			let input_el = h.NewElement('input', {
				'type'     : 'checkbox',
				'id'       : 'check' + (i+1),
				'name'     : 'check' + (i+1),
				'class'    : 'checklist-item',
				'events'   : {
					'change': this.update_checklist.bind(this)
				}
			});
			let label_el = h.NewElement('label', {
				'for'      : 'check' + (i+1),
				'innerHTML': el_text
			});

			el.innerHTML = '';
			el.appendChild(input_el);
			el.appendChild(label_el);
		}

		// trigger update once for initiation
		this.update_checklist();

		// set up status bar toggle event
		document.getElementById('status_checklist').addEventListener('click', (e) => {
			document.getElementById('status_checklist_list').classList.toggle('hidden');
		});
	}

	update_checklist () {
		let check_items   = document.getElementsByClassName('checklist-item'),
			count_checked = 0;

		for (var i = 0; i < check_items.length; i++) {
			if (check_items[i].checked) {
				count_checked++;
			}
		}

		document.getElementById('status_checklist_text').innerHTML = count_checked + '/' + check_items.length;

		document.getElementById('status_checklist').classList.toggle('good', count_checked == check_items.length);
	}

	toggle_streaming () {
		if (this.streaming)
			this.stop_streaming();
		else
			this.start_streaming();
	}

	async start_streaming () {
		if (!this.streaming)
			await wrc.safeCall('StartStream');
	}

	async stop_streaming () {
		if (this.streaming)
			await wrc.safeCall('StopStream');
	}

	on_stream_state (e) {
		this.streaming       = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED';
		this.stream_starting = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING';
		this.stream_stopping = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING';

		this.update_stream_rec_status();
	}

	toggle_recording () {
		if (this.recording)
			this.stop_recording();
		else
			this.start_recording();
	}

	toggle_rec_pause () {
		if (this.recording_paused)
			this.resume_recording();
		else
			this.pause_recording();
	}

	async start_recording () {
		if (!this.recording)
			await wrc.safeCall('StartRecord');
	}

	async pause_recording () {
		if (this.recording && !this.recording_paused)
			await wrc.safeCall('PauseRecord');
	}

	async resume_recording () {
		if (this.recording && this.recording_paused)
			await wrc.safeCall('ResumeRecord');
	}

	async stop_recording () {
		if (this.recording)
			await wrc.safeCall('StopRecord');
	}

	on_record_state (e) {
		this.recording          = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED';
		this.recording_starting = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTING';
		this.recording_stopping = e.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPING';
		this.recording_paused   = e.outputPaused === true;

		this.update_stream_rec_status();
	}

	update_stream_rec_status () {
		// stream button
		this.stream_button.classList.toggle('active',   this.streaming);
		this.stream_button.classList.toggle('starting', this.stream_starting);
		this.stream_button.classList.toggle('stopping', this.stream_stopping);
		
		let stream_button_text = this.streaming ? 'Stop streaming' : 'Start streaming';
		if (this.stream_starting)
			stream_button_text = 'Starting stream...';
		else if (this.stream_stopping)
			stream_button_text = 'Stopping stream...';
		document.getElementById('stream_button_text').innerHTML = stream_button_text;
		
		// recording button
		this.recording_button.classList.toggle('active',   this.recording);
		this.recording_button.classList.toggle('starting', this.recording_starting);
		this.recording_button.classList.toggle('stopping', this.recording_stopping);

		let recording_button_text = this.recording ? 'Stop recording' : 'Start recording';
		if (this.recording_starting)
			recording_button_text = 'Starting recording...';
		else if (this.recording_stopping)
			recording_button_text = 'Stopping recording...';
		document.getElementById('recording_button_text').innerHTML = recording_button_text;

		// recording pause button
		if (this.recording)
			this.rec_pause_button.removeAttribute('disabled');
		else
			this.rec_pause_button.setAttribute('disabled', 'disabled');
		this.rec_pause_button.classList.toggle('active', this.recording_paused);
		document.getElementById('rec_pause_button_text').innerHTML = this.recording_paused ? 'Resume recording' : 'Pause recording';
	}

	async get_virtualcam_status () {
		const data = await wrc.safeCall('GetVirtualCamStatus');

		if (data)
			this.virtualcam_active = data.outputActive;

		this.update_virtualcam_status();
	}

	toggle_virtualcam () {
		if (this.virtualcam_active)
			this.stop_virtualcam();
		else
			this.start_virtualcam();
	}

	async start_virtualcam () {
		await wrc.safeCall('StartVirtualCam');
	}

	async stop_virtualcam () {
		await wrc.safeCall('StopVirtualCam');
	}

	on_virtualcam_state (e) {
		this.virtualcam_active = e.outputActive;
		this.update_virtualcam_status();
	}

	on_replay_buffer_state (e) {
		this.replay_active = e.outputActive;
	}

	update_virtualcam_status() {
		// status bar
		document.getElementById('status_virtualcam').classList.toggle('good', this.virtualcam_active);
		document.getElementById('status_virtualcam_text').innerHTML = (this.virtualcam_active) ? 'On' : 'Off';

		// edit pane
		this.virtualcam_button.classList.toggle('active', this.virtualcam_active);
		document.getElementById('virtualcam_button_text').innerHTML = (this.virtualcam_active) ? 'Stop virtual cam' : 'Start virtual cam';
	}

	update_outputs (result) {
		let active_outputs = 0;
		this.outputs       = [];

		if (result && result.ok) {
			for (let i = 0; i < result.data.outputs.length; i++) {
				let o = result.data.outputs[i];

				// skip over output types handled elsewhere
				if (o.outputName != 'adv_stream' && o.outputName != 'adv_file_output' && o.outputName != 'virtualcam_output') {
					this.outputs.push(o);

					if (o.outputActive)
						active_outputs++;
				}
			}
		}

		// update status bar
		document.getElementById('status_outputs').classList.toggle('good', active_outputs > 0);
		document.getElementById('status_outputs_text').innerHTML = `${active_outputs}/${this.outputs.length}`;

		// update edit pane
		let ul = document.getElementById('other_outputs_info');

		for (let j = 0; j < this.outputs.length; j++) {
			let o     = this.outputs[j];

			let id    = h.get_slug('output_item_' + o.outputName);
			let li_el = document.getElementById(id);

			if (!li_el) {
				li_el = h.NewElement('li', {
					'id'       : id,
					'className': 'output-info-item'
				});

				ul.appendChild(li_el);
			}

			let flags     = o.outputFlags || {};
			let has_audio = flags.OBS_OUTPUT_AUDIO === true || flags.OBS_OUTPUT_AV === true || flags.OBS_OUTPUT_ENCODED === true;
			let has_video = flags.OBS_OUTPUT_VIDEO === true || flags.OBS_OUTPUT_AV === true || flags.OBS_OUTPUT_ENCODED === true;

			li_el.classList.toggle('good',      o.outputActive);
			li_el.classList.toggle('has-audio', has_audio);
			li_el.classList.toggle('has-video', has_video);
			li_el.innerHTML = `${o.outputName} (${o.outputKind})`;
		}

		// remove outputs no longer found in list but still in page ul
		let current_output_ids = this.outputs.map(x => h.get_slug('output_item_' + x.outputName));
		for (let k = ul.children.length - 1; k >= 0; k--) {
			let c = ul.children[k];

			if (!current_output_ids.includes(c.id)) {
				ul.removeChild(c);
			}
		}
	}

	handle_key_event (inEvent) {
		// avoid 'silencing' input fields
		if (inEvent.target && inEvent.target.nodeName.toLowerCase() === 'input') {
			return;
		} else if (inEvent && inEvent.preventDefault) {
			inEvent.preventDefault();
		}

		switch (inEvent.keyCode) {
			case 84: // t
				this.transition();
				break;
			case 83: // s
				this.toggle_studio_mode();
				break;
			case 70: // f
				this.toggle_fullscreen();
				break;
			case 48: // 0
			case 49: // 1
			case 50: // 2
			case 51:
			case 52:
			case 53:
			case 54:
			case 55:
			case 56: // 8
			case 57: // 9
				// 0 is handled as 10th scene (with index - 1 = 9)
				var i = (inEvent.keyCode == 48) ? 9 : inEvent.keyCode - 49;
				
				if (this.scene_list[i] && this.scenes[this.scene_list[i].sceneName]) {
					this.scenes[ this.scene_list[i].sceneName ].set_scene( inEvent.shiftKey );
				}
				break;
			default:
				break;
		}

		return false;
	}
}