import { describe, expect, it } from "vitest";
import { FakeArtifacts } from "../src/artifacts/fake";
import { resolveLogRef, type FakeRefs } from "../src/artifacts/fakeRefs";
import { FakeMainRepo } from "../src/artifacts/mainRefFake";

const C1 = "a".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const TAGGED = "4".repeat(40);
const MISSING = "6".repeat(40);

const REFS: FakeRefs = {
  head: C2,
  names: new Map([
    ["main", C2],
    ["v1", TAGGED],
  ]),
  holds: (id) => [C1, C2, TAGGED].includes(id),
};

describe("resolveLogRef", () => {
  it("resolves HEAD when omitted, a branch or tag by short name, and a held commit ID", () => {
    expect(resolveLogRef(undefined, REFS)).toBe(C2);
    expect(resolveLogRef("main", REFS)).toBe(C2);
    expect(resolveLogRef("v1", REFS)).toBe(TAGGED);
    expect(resolveLogRef(C1, REFS)).toBe(C1);
  });

  it("resolves no full ref name, not even one whose short name is a branch", () => {
    expect(resolveLogRef("refs/heads/main", REFS)).toBeNull();
    expect(resolveLogRef("refs/tags/v1", REFS)).toBeNull();
  });

  it("resolves no unknown name, explicit HEAD, missing commit or abbreviated ID", () => {
    expect(resolveLogRef("trunk", REFS)).toBeNull();
    expect(resolveLogRef("HEAD", REFS)).toBeNull();
    expect(resolveLogRef(MISSING, REFS)).toBeNull();
    expect(resolveLogRef(C1.slice(0, 12), REFS)).toBeNull();
    expect(resolveLogRef(C1.toUpperCase(), REFS)).toBeNull();
  });

  it("resolves an omitted ref to nothing while HEAD's branch has no commit", () => {
    expect(resolveLogRef(undefined, { ...REFS, head: undefined })).toBeNull();
  });
});

describe("the fakes' log", () => {
  it("FakeArtifacts reads main by short name or commit ID, never by its full ref name", async () => {
    const fake = new FakeArtifacts();
    fake.seed("repo", [C1, C2, C3]);
    using repo = await fake.get("repo");
    const hashes = async (ref?: string) =>
      (await repo.log(ref === undefined ? { limit: 10 } : { ref, limit: 10 })).map((c) => c.hash);
    expect(await hashes()).toEqual([C3, C2, C1]);
    expect(await hashes("main")).toEqual([C3, C2, C1]);
    expect(await hashes(C2)).toEqual([C2, C1]);
    expect(await hashes("refs/heads/main")).toEqual([]);
    expect(await hashes("trunk")).toEqual([]);
    expect(await hashes(MISSING)).toEqual([]);
  });

  it("FakeArtifacts answers an empty log for HEAD naming a branch without commits", async () => {
    const fake = new FakeArtifacts();
    fake.seed("repo", [C1]).headRef = "refs/heads/trunk";
    fake.seed("empty", []);
    using repo = await fake.get("repo");
    using empty = await fake.get("empty");
    expect(await repo.log()).toEqual([]);
    expect((await repo.log({ ref: "main" })).map((c) => c.hash)).toEqual([C1]);
    expect(await empty.log({ ref: "main" })).toEqual([]);
  });

  it("FakeMainRepo reads main by short name or commit ID, never by its full ref name", async () => {
    const fake = new FakeMainRepo("main-repo", [C1, C2]);
    fake.commit(C3, [C2]);
    using repo = await fake.get("main-repo");
    const hashes = async (ref?: string) =>
      (await repo.log(ref === undefined ? { limit: 10 } : { ref, limit: 10 })).map((c) => c.hash);
    expect(await hashes()).toEqual([C2, C1]);
    expect(await hashes("main")).toEqual([C2, C1]);
    expect(await hashes(C3)).toEqual([C3, C2, C1]);
    expect(await hashes("refs/heads/main")).toEqual([]);
    expect(await hashes("HEAD")).toEqual([]);
    expect(await hashes(MISSING)).toEqual([]);
  });
});
