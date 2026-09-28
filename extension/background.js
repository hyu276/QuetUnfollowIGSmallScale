const APP_ID = "936619743392459";
const ASBD_ID = "129";
const HASH_FOLLOWING = "3dec7e2c57367ef3da3d987d89f9dbc8";
const HASH_FOLLOWERS = "c76146de99bb02f6415203be841dd25a";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(message) {
  if (message?.action === "PING") return { ok: true, data: { version: chrome.runtime.getManifest().version } };
  const tab = await getInstagramTab();
  if (!tab?.id) {
    return { ok: false, error: "Không tìm thấy tab instagram.com. Hãy mở Instagram, đăng nhập, rồi thử lại." };
  }
  if (message?.action === "WHO_AM_I") return executeInstagramTask(tab.id, "WHO_AM_I", {});
  if (message?.action === "CRAWL") return executeInstagramTask(tab.id, "CRAWL", message.payload || {});
  return { ok: false, error: "Lệnh không được hỗ trợ." };
}

async function getInstagramTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function executeInstagramTask(tabId, action, payload) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [action, payload, APP_ID, ASBD_ID, HASH_FOLLOWING, HASH_FOLLOWERS],
    func: async (task, input, appId, asbdId, hashFollowing, hashFollowers) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
      const BASE_HEADERS = {
        accept: "*/*",
        "x-ig-app-id": appId,
        "x-asbd-id": asbdId,
        "x-requested-with": "XMLHttpRequest",
      };

      async function fetchJson(path) {
        const response = await fetch(path, {
          method: "GET",
          credentials: "include",
          headers: BASE_HEADERS,
          cache: "no-store",
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          const error = new Error(`Instagram trả về dữ liệu không phải JSON (HTTP ${response.status}) tại ${path}.`);
          error.status = response.status;
          throw error;
        }
        return { response, data };
      }

      async function requestJson(path) {
        const { response, data } = await fetchJson(path);
        if (!response.ok || data?.status === "fail") {
          const detail = data?.message || data?.error_type || `HTTP ${response.status}`;
          const error = new Error(`Instagram API: ${detail}`);
          error.status = response.status;
          error.endpoint = path;
          throw error;
        }
        return data;
      }

      function cookie(name) {
        const prefix = `${name}=`;
        const part = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
        return part ? decodeURIComponent(part.slice(prefix.length)) : "";
      }

      function normalizeUser(user, fallbackUsername = "") {
        if (!user) return null;
        const id = user.pk ?? user.pk_id ?? user.id;
        const username = user.username || fallbackUsername;
        if (!id || !username) return null;
        return {
          id: String(id),
          username: String(username),
          fullName: user.full_name || user.fullName || "",
          profilePicUrl: user.profile_pic_url || user.profile_pic_url_hd || "",
          isPrivate: Boolean(user.is_private),
          isVerified: Boolean(user.is_verified),
        };
      }

      async function getCurrentAccount() {
        const viewerId = cookie("ds_user_id");
        const candidates = [
          "/api/v1/accounts/edit/web_form_data/",
          "/api/v1/accounts/current_user/?edit=true",
        ];
        let lastError = null;
        for (const path of candidates) {
          try {
            const data = await requestJson(path);
            const raw = data?.form_data || data?.user || data?.data?.user || data;
            if (raw?.username) {
              return {
                id: raw.pk ? String(raw.pk) : raw.id ? String(raw.id) : viewerId,
                username: String(raw.username),
                fullName: raw.full_name || raw.first_name || "",
                isPrivate: Boolean(raw.is_private),
              };
            }
          } catch (error) {
            lastError = error;
          }
        }
        if (viewerId) {
          return { id: viewerId, username: "", fullName: "", isPrivate: false };
        }
        throw lastError || new Error("Không xác định được tài khoản Instagram đang đăng nhập.");
      }

      async function resolveUser(username) {
        const clean = String(username || "").trim().replace(/^@/, "").toLowerCase();
        if (!clean) throw new Error("Username trống.");

        try {
          const current = await getCurrentAccount();
          if (current.username && current.username.toLowerCase() === clean && current.id) {
            return current;
          }
        } catch {
          // Continue with web resolvers below.
        }

        let profileInfoError = null;
        const profilePath = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`;
        try {
          const { response, data } = await fetchJson(profilePath);
          if (response.status === 404) throw new Error(`Không tìm thấy @${clean}.`);
          if (response.ok && data?.data?.user) {
            const normalized = normalizeUser(data.data.user, clean);
            if (normalized) return normalized;
          } else if (response.status !== 400) {
            const detail = data?.message || data?.error_type || `HTTP ${response.status}`;
            throw new Error(`Instagram web profile: ${detail}`);
          }
        } catch (error) {
          profileInfoError = error;
        }

        const feedPath = `/api/v1/feed/user/${encodeURIComponent(clean)}/username/?count=1`;
        try {
          const data = await requestJson(feedPath);
          const raw = data?.user || data?.items?.[0]?.user;
          const normalized = normalizeUser(raw, clean);
          if (normalized) return normalized;
        } catch (feedError) {
          const profileMessage = profileInfoError instanceof Error ? profileInfoError.message : "";
          const feedMessage = feedError instanceof Error ? feedError.message : String(feedError);
          throw new Error(`Không resolve được @${clean}. ${profileMessage ? `${profileMessage}; ` : ""}${feedMessage}`);
        }

        throw new Error(`Không resolve được @${clean}.`);
      }

      async function fetchRelationshipGraphQL(userId, kind) {
        const all = new Map();
        const hash = kind === "following" ? hashFollowing : hashFollowers;
        const edgeKey = kind === "following" ? "edge_follow" : "edge_followed_by";
        let cursor = "";
        let page = 0;
        const maxPages = 500;

        do {
          const variables = {
            id: String(userId),
            include_reel: false,
            fetch_mutual: false,
            first: 24,
          };
          if (cursor) variables.after = cursor;

          const path = `/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
          const data = await requestJson(path);
          const edge = data?.data?.user?.[edgeKey];
          if (!edge || !Array.isArray(edge.edges)) {
            throw new Error(`GraphQL không trả về ${edgeKey}.`);
          }

          for (const item of edge.edges) {
            const user = normalizeUser(item?.node);
            if (user) all.set(user.id || user.username.toLowerCase(), user);
          }

          cursor = edge.page_info?.has_next_page ? String(edge.page_info?.end_cursor || "") : "";
          page += 1;
          if (cursor) await sleep(jitter(800, 1600));
        } while (cursor && page < maxPages);

        if (cursor) throw new Error(`Đã dừng GraphQL sau ${maxPages} trang để tránh crawl quá mức.`);
        return [...all.values()];
      }

      async function fetchRelationshipRest(userId, kind) {
        const all = new Map();
        let maxId = "";
        let page = 0;
        const maxPages = 500;

        do {
          const params = new URLSearchParams({ count: "50" });
          if (maxId) params.set("max_id", maxId);
          const data = await requestJson(`/api/v1/friendships/${encodeURIComponent(userId)}/${kind}/?${params}`);
          if (!Array.isArray(data?.users)) {
            throw new Error(`REST không trả về danh sách ${kind}.`);
          }
          for (const raw of data.users) {
            const user = normalizeUser(raw);
            if (user) all.set(user.id || user.username.toLowerCase(), user);
          }
          maxId = data.next_max_id ? String(data.next_max_id) : "";
          page += 1;
          if (maxId) await sleep(jitter(800, 1600));
        } while (maxId && page < maxPages);

        if (maxId) throw new Error(`Đã dừng REST sau ${maxPages} trang để tránh crawl quá mức.`);
        return [...all.values()];
      }

      async function fetchRelationship(userId, kind) {
        let graphqlError = null;
        try {
          return await fetchRelationshipGraphQL(userId, kind);
        } catch (error) {
          graphqlError = error;
          console.warn(`[QuetUnfollowIG] GraphQL ${kind} thất bại, chuyển sang REST fallback`, error);
        }

        try {
          return await fetchRelationshipRest(userId, kind);
        } catch (restError) {
          const gqlMessage = graphqlError instanceof Error ? graphqlError.message : String(graphqlError || "");
          const restMessage = restError instanceof Error ? restError.message : String(restError);
          throw new Error(`Không thể tải ${kind}. GraphQL: ${gqlMessage}. REST fallback: ${restMessage}.`);
        }
      }

      try {
        if (task === "WHO_AM_I") {
          const account = await getCurrentAccount();
          if (!account.username) {
            throw new Error("Đã đọc được session nhưng chưa đọc được username. Hãy reload tab Instagram rồi thử lại.");
          }
          return { ok: true, data: account };
        }

        if (task === "CRAWL") {
          const requestedUsername = String(input?.username || "").trim().replace(/^@/, "").toLowerCase();
          const target = await resolveUser(requestedUsername);

          const following = await fetchRelationship(target.id, "following");
          await sleep(jitter(1000, 1800));
          const followers = await fetchRelationship(target.id, "followers");

          const createdAt = new Date().toISOString();
          return {
            ok: true,
            data: {
              target,
              snapshot: {
                id: `${target.username.toLowerCase()}:${createdAt}:${crypto.randomUUID()}`,
                username: target.username.toLowerCase(),
                userId: target.id,
                createdAt,
                followers,
                following,
              },
            },
          };
        }
        return { ok: false, error: "Unknown task." };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  return results?.[0]?.result || { ok: false, error: "Không nhận được kết quả từ tab Instagram." };
}
