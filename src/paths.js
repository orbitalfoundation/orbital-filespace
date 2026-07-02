// paths — slug/namespace helpers. A slug is an absolute, '/'-separated path
// like '/anselm/playground'. The root is '/'. The first segment is the "root
// area" — the unit handed out first-come to an owner. These helpers are pure;
// they never touch a store.

export function normalizeSlug(slug) {
  if (slug == null || slug === '/' || slug === '') return '/';
  let s = String(slug).trim();
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+/g, '/').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

export function segments(slug) {
  const s = normalizeSlug(slug);
  return s === '/' ? [] : s.slice(1).split('/');
}

// A segment must start with a letter/digit — which also forbids '.', '..' and
// dotfiles — and stay within a filesystem/URL-safe charset. Slugs map to
// directories under a manifest root, so this is a security boundary, not taste.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSlug(slug) {
  const s = normalizeSlug(slug);
  return s === '/' || segments(s).every((seg) => SEGMENT.test(seg));
}

export function parentSlug(slug) {
  const segs = segments(slug);
  if (segs.length <= 1) return '/';
  return '/' + segs.slice(0, -1).join('/');
}

// The root area a slug belongs to: '/anselm/playground' -> '/anselm'.
export function rootSlug(slug) {
  const segs = segments(slug);
  return segs.length ? '/' + segs[0] : '/';
}

// A root area is a single-segment slug ('/anselm'). Roots are claimed; deeper
// nodes are created inside an existing parent.
export function isRoot(slug) {
  return segments(slug).length === 1;
}

export function basename(slug) {
  const segs = segments(slug);
  return segs.length ? segs[segs.length - 1] : '';
}

export function isChildOf(child, parent) {
  return parentSlug(child) === normalizeSlug(parent);
}

export function isDescendantOf(node, ancestor) {
  const a = normalizeSlug(ancestor);
  const n = normalizeSlug(node);
  if (n === a) return false;
  if (a === '/') return n !== '/';
  return n.startsWith(a + '/');
}
