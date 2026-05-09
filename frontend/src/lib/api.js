// Thin fetch wrappers. Each helper returns the parsed body on success
// and throws an Error with the server's `error` field (or status text)
// on a non-2xx response.

async function readError(res) {
  const fallback = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    return new Error(j.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw await readError(r);
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw await readError(r);
  return r.json().catch(() => ({}));
}

export async function postFormData(url, fd) {
  const r = await fetch(url, { method: 'POST', body: fd });
  if (!r.ok) throw await readError(r);
  return r.json().catch(() => ({}));
}

export async function delJSON(url) {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw await readError(r);
  return r.json().catch(() => ({}));
}

export async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw await readError(r);
  return r.text();
}
