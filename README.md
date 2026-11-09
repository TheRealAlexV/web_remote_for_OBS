# Web remote for OBS
Web remote UI for controlling [OBS Studio](https://obsproject.com/) through the obs-websocket server built into OBS.

[Português (Brasil)](README.pt-BR.md)

**[→ Live demo](https://dvangennip.github.io/web_remote_for_OBS/)** — you can look at the interface there, but an `https` page cannot open a `ws://` connection to OBS on your machine. To actually control OBS, serve the folder locally as described below.

## Screenshot
![preview of the UI with status bar up top, scene views in the middle, and audio controls below that.](documents/web-remote-screenshot-v3.png "Web remote for OBS main user interface.")

## Requirements
- OBS Studio 28 or newer. OBS 28 was the first release to ship obs-websocket 5, so the WebSocket server is already built in; there is no plugin to install.
- Tested with OBS Studio 33.0.1 and obs-websocket 5.7.6, rpcVersion 1.
- The WebSocket server enabled in OBS under **Tools → WebSocket Server Settings**. It is enabled by default on port `4455`; set a password there.
- A browser that supports ES modules (any current browser).

## How to use
1. Download or check out this repository.
2. Serve the repo root folder (where `index.html` is located) over HTTP.
    - For example: `python3 -m http.server 8000`
    - Then open [`http://localhost:8000`](http://localhost:8000)
3. In the connection dialog, enter the host and the password you set in OBS, then connect.
    - The host defaults to `localhost:4455`.
    - It accepts a bare host (`192.168.1.20`), a host and port (`192.168.1.20:4455`), or a full `ws://` or `wss://` URL.
4. Control OBS via the webpage.

> **Serve it over HTTP, not from a file.** ES modules and `ws://` both need a real origin, so opening `index.html` directly from disk (`file://`) will not work. An `https`-hosted copy, such as GitHub Pages, cannot open `ws://` to a local OBS either: browsers block that mixed content. If you must host the page over `https`, the WebSocket has to be fronted with TLS too (`wss://`).

## Features
- Enable/disable Studio Mode (hotkey: `S`)
- Switch between scenes
    - Transition hotkey: `T` (only when in Studio Mode)
    - Left click to switch to scene or (when in Studio Mode) set Preview scene
    - Use `0-9` to set numbered scene (only available for the first ten scenes)
- Control audio sources
    - Mute/unmute
    - Show/hide
    - Volume
    - Live per-source volume meters, fed by the `InputVolumeMeters` event from obs-websocket 5
    - Filter settings (not all filters are supported)
- Change scene item properties
    - Position
    - Scale
    - Rotation
    - Alignment
    - Bounding box
    - Crop
- Enable/disable sources
- Change source properties
    - Text
    - Media
- Change source filter properties
    - Color correction
    - Chroma key and color key (v1 and v2): key colour and type, similarity, smoothness, spill, opacity, contrast, brightness, gamma
- Take screenshot of current program
- Start/stop recording, streaming, and replay buffer
- Start/stop virtual camera
- Show statistics
- Hotkeys
    - Refresh (`R`)
    - Save Replay buffer (`P`)
- Add sources to scenes

## Notes and known issues
- An `https`-served copy cannot connect to a plain `ws://` server on your machine; run the app from a local `http://` server instead (see [How to use](#how-to-use)).
- Currently not optimised for use on mobile devices.
- Any scenes with `hidden` or `subscene` in their name are ignored and not shown in the scene list.
- Volume meters only update for inputs that are actively producing audio; that is what obs-websocket reports.
- For more, see [Issues](https://github.com/dvangennip/web_remote_for_OBS/issues)

## Editing text sources
The app never lists your sources. You opt in to the ones you want by adding an `<input>` with a `data-wr-source` attribute to the `#source_list` list in `index.html`. The input's `name` must be the OBS source name. After the app connects, each opted-in input is replaced by a collapsible pane seeded from OBS, so you edit the text the source already holds instead of overwriting it.

A complete block for two sources, plus a selector that writes one value to both:

```html
<ul id="source_list" class="source-list">
	<li>
		<input type="text" id="name_a" name="Name A" data-wr-source="Name A">
	</li>
	<li>
		<input type="text" id="name_b" name="Name B" data-wr-source="Name B">
	</li>
</ul>
<select data-wr-selector="name_a|name_b">
	<option value="Both|Both">Both</option>
	<option value="First|Second">First and second</option>
</select>
```

The pane opens on a click and reads the source when it opens. Each control writes its own setting to OBS on change:

- Text: a multi-line box. It writes 300 ms after you stop typing, and at once when the box loses focus or the pane collapses.
- Font and size: the `font` object. OBS resolves the face name and falls back when the name is unknown.
- Colour and opacity: `color` and `opacity`. Colour is a picker; opacity is 0 to 100.
- Outline: `outline`, with `outline_size` and `outline_color`. Size and colour are disabled while outline is off.
- Alignment: `align` and `valign`.

Only GDI+ text sources (any `text_gdiplus*` kind) get the styling controls. Any other input, including FreeType text sources, gets the text box only. An opted-in input is replaced by a pane, and when OBS does not know the name the pane shows a not-found state and writes nothing.

### Writing one value to several sources
The `data-wr-selector` attribute lists the `id`s of the inputs above, separated by `|`. Each option's value is the text for those sources, in the same order, also separated by `|`. A change updates the matching input and sends its text to OBS. The ids in the attribute are the input ids, not the source names.

The example above writes `Both` to `Name A` and `Name B`, or `First` to `Name A` and `Second` to `Name B`.

## License
- [Unlicense](https://unlicense.org/): This is free and unencumbered software released into the public domain.
- [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) 5.0.8 is vendored at `vendor/obs-ws.global.js` and loaded as a plain script, so the app needs no build step and nothing to install to run. `vendor/README.md` records where the bundle came from and its SHA-256; the MIT license is in `vendor/obs-websocket-js.LICENSE`.
- Icons: [Feather](https://feathericons.com/)
