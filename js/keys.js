/**
 * Stable keys for scenes and inputs, shared by the browser app and the Node
 * store tests. No imports of its own: both runtimes load it by itself.
 *
 * OBS 28's obs-websocket predates sceneUuid and inputUuid, so the name is the
 * fallback: a rename then breaks the link, but an item is never silently
 * dropped from every list. The prefix carries the kind, so a scene "Mic" and an
 * input "Mic" never share a key. Null means unkeyable, which callers treat as
 * "visible, and leave the order alone".
 */
export function scene_key (scene) {
	if (!scene)
		return null;

	return scene.sceneUuid || (scene.sceneName ? 'scene-name:' + scene.sceneName : null);
}

export function input_key (input) {
	if (!input)
		return null;

	return input.inputUuid || (input.inputName ? 'input-name:' + input.inputName : null);
}
