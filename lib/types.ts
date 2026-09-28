export type IgPerson = {
  id: string;
  username: string;
  fullName?: string;
  profilePicUrl?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
};

export type CrawlSnapshot = {
  id: string;
  username: string;
  userId: string;
  createdAt: string;
  followers: IgPerson[];
  following: IgPerson[];
};

export type RelationshipDiff = {
  lostFollowers: IgPerson[];
  gainedFollowers: IgPerson[];
  lostFollowing: IgPerson[];
  gainedFollowing: IgPerson[];
};

export type CrawlResult = {
  snapshot: CrawlSnapshot;
  target: {
    id: string;
    username: string;
    fullName?: string;
    isPrivate?: boolean;
  };
};

export type BridgeResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};
