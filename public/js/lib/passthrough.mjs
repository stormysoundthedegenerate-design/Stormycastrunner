// Requests for the pass-through routes: /nhc/, /dmwl/, /nomads/, /s3/, /msc/, /dwd/, /opera/ and /yt/live.
//
// In a browser these go to server.mjs like any other request. In the Android app they
// go to a native plugin instead (see platform.mjs), which fetches on threads of its own;
// a model worker has no plugins, so it hands its requests to the page (model-worker.mjs).
// Callers just use `passFetch` and get a Response either way.

let impl = null;

/** Route pass-through requests somewhere other than `fetch`. */
export function setPassthrough(fn) { impl = fn; }

export function passFetch(url, init = {}) {
  return impl ? impl(url, init) : fetch(url, init);
}

/** The Range header out of fetch-style init, whatever shape its headers come in. */
export function rangeOf(init) {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get('range');
  return h.Range || h.range || null;
}

/** The priority a model worker gives its request (X-Nexradar-Priority), or null. */
export function priorityOf(init) {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get('x-nexradar-priority');
  return h['X-Nexradar-Priority'] || h['x-nexradar-priority'] || null;
}

/** Rebuild a Response from the plain parts a plugin or a worker message carries. */
export function responseFrom({ status, headers = {}, type, body }) {
  const h = new Headers(headers);
  if (type) h.set('content-type', type);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers: h });
}
