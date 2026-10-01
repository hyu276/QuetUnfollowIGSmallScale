import type { CrawlSnapshot, IgPerson, RelationshipDiff } from "./types";

function keyFor(user: IgPerson) {
  return user.id || user.username.toLowerCase();
}

function byIdOrUsername(users: IgPerson[]) {
  return new Map(users.map((user) => [keyFor(user), user]));
}

function subtract(left: IgPerson[], right: IgPerson[]) {
  const rightMap = byIdOrUsername(right);
  return left.filter((user) => !rightMap.has(keyFor(user)));
}

export function diffSnapshots(previous: CrawlSnapshot, current: CrawlSnapshot): RelationshipDiff {
  return {
    lostFollowers: subtract(previous.followers, current.followers),
    gainedFollowers: subtract(current.followers, previous.followers),
    lostFollowing: subtract(previous.following, current.following),
    gainedFollowing: subtract(current.following, previous.following),
  };
}

export function currentRelationshipSets(snapshot: CrawlSnapshot) {
  const followers = byIdOrUsername(snapshot.followers);
  const following = byIdOrUsername(snapshot.following);

  return {
    notFollowingBack: snapshot.following.filter((user) => !followers.has(keyFor(user))),
    youDoNotFollowBack: snapshot.followers.filter((user) => !following.has(keyFor(user))),
    mutuals: snapshot.following.filter((user) => followers.has(keyFor(user))),
  };
}

export function compareNotFollowingBack(previous: CrawlSnapshot, current: CrawlSnapshot) {
  const previousSet = currentRelationshipSets(previous).notFollowingBack;
  const currentSet = currentRelationshipSets(current).notFollowingBack;
  const addedToNotFollowingBack = subtract(currentSet, previousSet);
  const leftNotFollowingBack = subtract(previousSet, currentSet);
  const lostFollowers = byIdOrUsername(diffSnapshots(previous, current).lostFollowers);

  return {
    addedToNotFollowingBack,
    leftNotFollowingBack,
    inferredNewUnfollowers: addedToNotFollowingBack.filter((user) => lostFollowers.has(keyFor(user))),
  };
}
