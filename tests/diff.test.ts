import assert from "node:assert/strict";
import test from "node:test";
import { compareNotFollowingBack, currentRelationshipSets, diffSnapshots } from "../lib/diff";
import type { CrawlSnapshot, IgPerson } from "../lib/types";

const p = (id: string, username = id): IgPerson => ({ id, username });
const snap = (followers: IgPerson[], following: IgPerson[]): CrawlSnapshot => ({
  id: crypto.randomUUID(),
  username: "owner",
  userId: "1",
  createdAt: new Date().toISOString(),
  followers,
  following,
});

test("detects lost and gained followers/following", () => {
  const previous = snap([p("a"), p("b")], [p("a"), p("c")]);
  const current = snap([p("b"), p("d")], [p("a"), p("e")]);
  const diff = diffSnapshots(previous, current);
  assert.deepEqual(diff.lostFollowers.map((x) => x.id), ["a"]);
  assert.deepEqual(diff.gainedFollowers.map((x) => x.id), ["d"]);
  assert.deepEqual(diff.lostFollowing.map((x) => x.id), ["c"]);
  assert.deepEqual(diff.gainedFollowing.map((x) => x.id), ["e"]);
});

test("computes mutual and one-way relationships", () => {
  const sets = currentRelationshipSets(snap([p("a"), p("b")], [p("b"), p("c")]));
  assert.deepEqual(sets.mutuals.map((x) => x.id), ["b"]);
  assert.deepEqual(sets.notFollowingBack.map((x) => x.id), ["c"]);
  assert.deepEqual(sets.youDoNotFollowBack.map((x) => x.id), ["a"]);
});

test("infers new unfollowers without mislabeling newly followed accounts", () => {
  const previous = snap(
    [p("a"), p("b")],
    [p("a"), p("b"), p("x")]
  );
  const current = snap(
    [p("a")],
    [p("a"), p("b"), p("x"), p("y")]
  );

  const change = compareNotFollowingBack(previous, current);

  assert.deepEqual(change.addedToNotFollowingBack.map((x) => x.id), ["b", "y"]);
  assert.deepEqual(change.inferredNewUnfollowers.map((x) => x.id), ["b"]);
  assert.deepEqual(change.leftNotFollowingBack.map((x) => x.id), []);
});
