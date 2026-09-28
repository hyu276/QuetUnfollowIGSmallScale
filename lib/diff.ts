import type { CrawlSnapshot, IgPerson, RelationshipDiff } from "./types";

function byIdOrUsername(users: IgPerson[]) {
  return new Map(users.map((user) => [user.id || user.username.toLowerCase(), user]));
}

function subtract(left: IgPerson[], right: IgPerson[]) {
  const rightMap = byIdOrUsername(right);
  return left.filter((user) => !rightMap.has(user.id || user.username.toLowerCase()));
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
    notFollowingBack: snapshot.following.filter((user) => !followers.has(user.id || user.username.toLowerCase())),
    youDoNotFollowBack: snapshot.followers.filter((user) => !following.has(user.id || user.username.toLowerCase())),
    mutuals: snapshot.following.filter((user) => followers.has(user.id || user.username.toLowerCase())),
  };
}
