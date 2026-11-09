import * as h from './helper.js';

// Short enough that the remote feels live, long enough that a sentence is one
// request instead of one request per keystroke.
const TEXT_DEBOUNCE_MS = 300;

// overlay:true replaces a nested object whole, so a font write must always send
// the complete object. These values fill the gaps when OBS reports no defaults.
const FONT_FALLBACK = { face: 'Arial', style: 'Regular', size: 64, flags: 0 };

const CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chevron-down"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const CHEVRON_UP   = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chevron-up"><polyline points="18 15 12 9 6 15"></polyline></svg>';

function has_number (value) {
	return typeof value === 'number' && !isNaN(value);
}

/**
 * One collapsible editor per opted-in input[data-wr-source] in index.html.
 *
 * The pane is seeded from OBS when it is opened: GetInputSettings carries only
 * the values the user set, so it is overlaid on GetInputDefaultSettings to fill
 * the rest of the form. Every write is SetInputSettings with overlay:true and
 * only the top-level keys that changed, except font, which always goes whole.
 */
export default class SourceText {
	constructor (inInputEl, inRemote) {
		this.input_el = inInputEl;
		this.remote   = inRemote;
		this.name     = inInputEl.getAttribute('name') || inInputEl.getAttribute('data-wr-source');
		this.id       = inInputEl.id || h.get_slug(this.name);
		this.slug     = h.get_slug(this.id);

		this.open       = false;
		this.seeded     = false;
		this.kind       = null;
		this.settings   = {};
		this.text_value = '';
		this.text_timer = null;

		this.el = h.NewElement('div', {
			'id'       : 'source_' + this.slug + '_text',
			'className': 'source-filter source-text'
		});

		this.title_el = h.NewElement('label', {
			'className': 'source-title'
		});
		this.el.appendChild(this.title_el);

		this.title_span = h.NewElement('span', {
			'title'    : this.name,
			'innerHTML': this.name,
			'events'   : {
				'click': this.toggle_open.bind(this)
			}
		});
		this.title_el.appendChild(this.title_span);

		this.btn_open = h.NewElement('span', {
			'title'    : 'Toggle text settings pane',
			'innerHTML': CHEVRON_DOWN + CHEVRON_UP,
			'className': 'button',
			'events'   : {
				'click': this.toggle_open.bind(this)
			}
		});
		this.title_el.appendChild(this.btn_open);

		this.settings_el = h.NewElement('div', {
			'className': 'filter-settings-section'
		});
		this.el.appendChild(this.settings_el);

		this.build_text_field();
		this.build_style_fields();
	}

	get_element () {
		return this.el;
	}

	// --- building ------------------------------------------------------------

	field (inLabel, inControl) {
		return h.NewElement('div', {
			'className': 'filter-setting-wrapper',
			'elements': [
				h.NewElement('label', {
					'className': 'filter-setting-label',
					'for'      : inControl.id,
					'innerHTML': '<span>' + inLabel + '</span>'
				}),
				inControl
			]
		});
	}

	build_text_field () {
		this.textarea = h.NewElement('textarea', {
			'id'         : this.el.id + '_text',
			'className'  : 'text-source-textarea',
			'rows'       : '4',
			'aria-label' : 'Text content',
			'events'     : {
				'input': this.on_text_input.bind(this),
				'blur' : this.flush_text.bind(this)
			}
		});

		this.settings_el.appendChild(this.field('Text', this.textarea));
	}

	build_style_fields () {
		this.style_el = h.NewElement('div', {
			'className': 'text-source-style',
			'elements': [
				this.build_font_rows(),
				this.build_color_rows(),
				this.build_outline_row(),
				this.build_align_row()
			]
		});
		this.settings_el.appendChild(this.style_el);
	}

	build_font_rows () {
		this.face_el = h.NewElement('input', {
			'id'          : this.el.id + '_face',
			'type'        : 'text',
			'autocomplete': 'off',
			'spellcheck'  : 'false',
			'events'      : {
				'change': (e) => {
					if (e.target.value.trim() !== '')
						this.update_font('face', e.target.value.trim());
					else
						this.seed_font(this.settings.font);
				}
			}
		});

		this.size_el = h.NewElement('input', {
			'id'     : this.el.id + '_size',
			'type'   : 'number',
			'min'    : '1',
			'step'   : '1',
			'events' : {
				'change': (e) => {
					let value = parseInt(e.target.value, 10);

					if (!isNaN(value) && value > 0)
						this.update_font('size', value);
					else
						this.seed_font(this.settings.font);
				}
			}
		});

		return h.NewElement('div', {
			'className': 'text-source-row',
			'elements': [
				this.field('Font', this.face_el),
				this.field('Size', this.size_el)
			]
		});
	}

	build_color_rows () {
		this.color_el = h.NewElement('input', {
			'id'     : this.el.id + '_color',
			'type'   : 'color',
			'events' : {
				'change': (e) => this.update_color('color', e.target.value)
			}
		});

		this.opacity_el = h.NewElement('input', {
			'id'     : this.el.id + '_opacity',
			'type'   : 'number',
			'min'    : '0',
			'max'    : '100',
			'step'   : '1',
			'events' : {
				'change': (e) => {
					let value = parseInt(e.target.value, 10);

					if (!isNaN(value)) {
						value = Math.min(100, Math.max(0, value));
						this.write_setting('opacity', value, (previous) => {
							this.opacity_el.value = has_number(previous) ? previous : 100;
						});
					} else {
						this.opacity_el.value = has_number(this.settings.opacity) ? this.settings.opacity : 100;
					}
				}
			}
		});

		return h.NewElement('div', {
			'className': 'text-source-row',
			'elements': [
				this.field('Colour', this.color_el),
				this.field('Opacity', this.opacity_el)
			]
		});
	}

	build_outline_row () {
		this.outline_el = h.NewElement('input', {
			'id'     : this.el.id + '_outline',
			'type'   : 'checkbox',
			'events' : {
				'change': (e) => {
					const on = e.target.checked;

					this.set_outline_enabled(on);
					this.write_setting('outline', on, (previous) => {
						this.outline_el.checked = !!previous;
						this.set_outline_enabled(!!previous);
					});
				}
			}
		});

		this.outline_size_el = h.NewElement('input', {
			'id'     : this.el.id + '_outline_size',
			'type'   : 'number',
			'min'    : '0',
			'step'   : '1',
			'events' : {
				'change': (e) => {
					let value = parseInt(e.target.value, 10);

					if (!isNaN(value) && value >= 0) {
						this.write_setting('outline_size', value, (previous) => {
							this.outline_size_el.value = has_number(previous) ? previous : 0;
						});
					} else {
						this.outline_size_el.value = has_number(this.settings.outline_size) ? this.settings.outline_size : 0;
					}
				}
			}
		});

		this.outline_color_el = h.NewElement('input', {
			'id'     : this.el.id + '_outline_color',
			'type'   : 'color',
			'events' : {
				'change': (e) => this.update_color('outline_color', e.target.value)
			}
		});

		return h.NewElement('div', {
			'className': 'text-source-row text-source-outline-row',
			'elements': [
				h.NewElement('label', {
					'className': 'text-source-check',
					'for'      : this.outline_el.id,
					'elements' : [
						this.outline_el,
						h.NewElement('span', {'innerHTML': 'Outline'})
					]
				}),
				this.field('Size', this.outline_size_el),
				this.field('Colour', this.outline_color_el)
			]
		});
	}

	build_align_row () {
		this.align_el  = this.build_select(this.el.id + '_align',
			['left', 'center', 'right'], ['Left', 'Centre', 'Right'],
			(value) => this.write_setting('align', value, (previous) => {
				this.align_el.value = previous || 'left';
			}));
		this.valign_el = this.build_select(this.el.id + '_valign',
			['top', 'center', 'bottom'], ['Top', 'Middle', 'Bottom'],
			(value) => this.write_setting('valign', value, (previous) => {
				this.valign_el.value = previous || 'top';
			}));

		return h.NewElement('div', {
			'className': 'text-source-row',
			'elements': [
				this.field('Align', this.align_el),
				this.field('Vertical', this.valign_el)
			]
		});
	}

	build_select (inId, inValues, inLabels, inWriter) {
		const select = h.NewElement('select', {'id': inId});

		inValues.forEach((value, i) => {
			select.appendChild(h.NewElement('option', {
				'value'    : value,
				'innerHTML': inLabels[i]
			}));
		});

		select.addEventListener('change', (e) => inWriter(e.target.value), false);

		return select;
	}

	// --- state ---------------------------------------------------------------

	toggle_open () {
		this.open = !this.open;
		this.el.classList.toggle('open', this.open);

		if (this.open)
			this.seed();
		else
			this.flush_text();
	}

	async seed () {
		const kinds = await this.remote.get_input_kinds();

		this.kind = (kinds && kinds.get(this.name)) || null;

		// FreeType and every non-text kind get the text box only. An input OBS
		// does not know about lands here too, which leaves it behaving as it did
		// before this pane existed rather than throwing.
		const is_text = !!(this.kind && this.kind.indexOf('text_gdiplus') === 0);
		this.el.classList.toggle('text-only', !is_text);

		const user_res = await wrc.safeCall('GetInputSettings', {'inputName': this.name});
		const user     = (user_res && user_res.inputSettings) || {};

		let defaults = {};
		if (is_text) {
			const def_res = await wrc.safeCall('GetInputDefaultSettings', {'inputKind': this.kind});
			defaults = (def_res && def_res.inputSettings) || {};
		}

		// GetInputSettings returns only the keys the user has set; the defaults
		// fill the rest. font is nested, so it merges key by key, not as a blob.
		const merged = Object.assign({}, defaults, user);
		merged.font  = Object.assign({}, FONT_FALLBACK, defaults.font, user.font);

		this.settings   = merged;
		this.text_value = (typeof merged.text === 'string') ? merged.text : '';
		this.textarea.value = this.text_value;
		this.seeded     = true;

		if (!is_text)
			return;

		this.seed_font(merged.font);

		this.color_el.value  = h.obsColorToRgb(has_number(merged.color) ? merged.color : 0xFFFFFFFF);
		this.opacity_el.value = has_number(merged.opacity) ? merged.opacity : 100;

		this.outline_el.checked = !!merged.outline;
		this.set_outline_enabled(!!merged.outline);
		this.outline_size_el.value  = has_number(merged.outline_size) ? merged.outline_size : 0;
		this.outline_color_el.value = h.obsColorToRgb(has_number(merged.outline_color) ? merged.outline_color : 0xFF000000);

		this.align_el.value  = merged.align || 'left';
		this.valign_el.value = merged.valign || 'top';
	}

	seed_font (inFont) {
		const font = Object.assign({}, FONT_FALLBACK, inFont);

		this.face_el.value = font.face;
		this.size_el.value = font.size;
	}

	set_outline_enabled (inEnabled) {
		this.outline_size_el.disabled  = !inEnabled;
		this.outline_color_el.disabled = !inEnabled;
	}

	// --- text ----------------------------------------------------------------

	on_text_input () {
		if (this.text_timer !== null)
			window.clearTimeout(this.text_timer);

		this.text_timer = window.setTimeout(this.flush_text.bind(this), TEXT_DEBOUNCE_MS);
	}

	async flush_text () {
		if (this.text_timer !== null) {
			window.clearTimeout(this.text_timer);
			this.text_timer = null;
		}

		if (!this.seeded)
			return;

		const value = this.textarea.value;

		if (value === this.text_value)
			return;

		const previous = this.text_value;
		this.text_value = value;

		const ok = await this.remote.set_text(this.name, value);

		// OBS rejected the write: put the last known value back so the pane does
		// not keep showing text the source never received
		if (!ok) {
			this.text_value = previous;
			this.textarea.value = previous;
		}
	}

	// called by WebRemote when some other control (the data-wr-selector fan-out)
	// wrote text to this pane's source
	set_remote_text (inSource, inText) {
		if (inSource !== this.name && inSource !== this.id)
			return;

		this.text_value = inText;

		if (this.textarea.value !== inText && document.activeElement !== this.textarea)
			this.textarea.value = inText;
	}

	// --- settings writes -----------------------------------------------------

	async update_font (inKey, inValue) {
		const previous = Object.assign({}, this.settings.font);
		const font     = Object.assign({}, FONT_FALLBACK, this.settings.font);

		font[inKey] = inValue;
		this.settings.font = font;

		// the whole object goes over the wire: a partial one would drop size,
		// face or flags, because overlay replaces a nested object whole
		const ok = await this.remote.set_input_settings(this.name, {'font': font});

		if (!ok) {
			this.settings.font = previous;
			this.seed_font(previous);
		}
	}

	update_color (inKey, inHex) {
		// GDI+ ignores the alpha byte and uses opacity instead, so 0 is correct
		return this.write_setting(inKey, h.rgbToObsColor(inHex), (previous) => {
			const input = (inKey === 'color') ? this.color_el : this.outline_color_el;

			input.value = h.obsColorToRgb(has_number(previous) ? previous : 0);
		});
	}

	async write_setting (inKey, inValue, inRestore) {
		const previous = this.settings[inKey];

		this.settings[inKey] = inValue;

		const ok = await this.remote.set_input_settings(this.name, {[inKey]: inValue});

		if (!ok) {
			this.settings[inKey] = previous;
			if (inRestore)
				inRestore(previous);
		}

		return ok;
	}
}
