// How the Artifacts binding's `log` resolves its `ref`, shared by the fakes so none is more
// permissive than the binding: a branch or tag by its short name, or a full commit ID the
// repository holds. A full ref name such as `refs/heads/main` resolves to nothing; #341's live seed
// found this, and the qualification probe's `refs.resolution` check measures it on every run.

const COMMIT_ID = /^[0-9a-f]{40}$/;

/** What a fake repository's refs point at. */
export interface FakeRefs {
  /** The commit `HEAD` names, or `undefined` while its branch has no commit. */
  readonly head: string | undefined;
  /** Commits by branch or tag short name. */
  readonly names: ReadonlyMap<string, string>;
  /** Whether the repository holds the commit `id`. */
  readonly holds: (id: string) => boolean;
}

/**
 * The commit `log({ ref })` starts from, or `null` when the binding answers an empty log. An
 * omitted `ref` reads from `HEAD`.
 */
export function resolveLogRef(ref: string | undefined, refs: FakeRefs): string | null {
  if (ref === undefined) return refs.head ?? null;
  if (ref.startsWith("refs/")) return null;
  const named = refs.names.get(ref);
  if (named !== undefined) return named;
  return COMMIT_ID.test(ref) && refs.holds(ref) ? ref : null;
}
