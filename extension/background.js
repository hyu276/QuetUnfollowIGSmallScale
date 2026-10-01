const APP_ID = "936619743392459";

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
    args: [action, payload, APP_ID],
    func: async (task, input, appId) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
      const BASE_HEADERS = {
        accept: "*/*",
        "x-ig-app-id": appId,
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
        const part = document.cookie
          .split(";")
          .map((item) => item.trim())
          .find((item) => item.startsWith(prefix));
        return part ? decodeURIComponent(part.slice(prefix.length)) : "";
      }

      function asCount(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
      }

      function normalizeTarget(user, fallbackUsername = "") {
        if (!user) return null;
        const id = user.pk ?? user.pk_id ?? user.id;
        const username = user.username || fallbackUsername;
        if (!id || !username) return null;

        return {
          id: String(id),
          username: String(username),
          fullName: user.full_name || user.fullName || "",
          isPrivate: Boolean(user.is_private),
          followerCount: asCount(
            user.edge_followed_by?.count ??
              user.follower_count ??
              user.followers_count
          ),
          followingCount: asCount(
            user.edge_follow?.count ??
              user.following_count ??
              user.followings_count
          ),
        };
      }

      function normalizeUser(user) {
        if (!user) return null;
        const id = user.pk ?? user.pk_id ?? user.id;
        const username = user.username;
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

        let profileInfoError = null;
        const profilePath = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`;

        try {
          const { response, data } = await fetchJson(profilePath);
          if (response.status === 404) throw new Error(`Không tìm thấy @${clean}.`);

          if (response.ok && data?.data?.user) {
            const normalized = normalizeTarget(data.data.user, clean);
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
          const normalized = normalizeTarget(raw, clean);
          if (normalized) return normalized;
        } catch (feedError) {
          try {
            const current = await getCurrentAccount();
            if (current.username?.toLowerCase() === clean && current.id) {
              return {
                ...current,
                followerCount: null,
                followingCount: null,
              };
            }
          } catch {
            // Preserve the resolver errors below.
          }

          const profileMessage = profileInfoError instanceof Error ? profileInfoError.message : "";
          const feedMessage = feedError instanceof Error ? feedError.message : String(feedError);
          throw new Error(
            `Không resolve được @${clean}. ${profileMessage ? `${profileMessage}; ` : ""}${feedMessage}`
          );
        }

        throw new Error(`Không resolve được @${clean}.`);
      }

      function validateCoverage(kind, expectedCount, actualCount) {
        if (!Number.isFinite(expectedCount)) return;

        if (expectedCount > 0 && actualCount === 0) {
          throw new Error(
            `Instagram trả danh sách ${kind} rỗng nhưng profile báo ${expectedCount}. Snapshot bị từ chối để tránh lưu dữ liệu sai.`
          );
        }

        const tolerance = Math.max(5, Math.ceil(expectedCount * 0.02));
        if (expectedCount > tolerance && actualCount < expectedCount - tolerance) {
          throw new Error(
            `Danh sách ${kind} có vẻ chưa đầy đủ: lấy được ${actualCount}/${expectedCount}. Snapshot bị từ chối; hãy thử lại sau.`
          );
        }
      }

      async function fetchRelationship(userId, kind, expectedCount) {
        const all = new Map();
        const seenCursors = new Set();
        let maxId = "";
        let page = 0;
        const maxPages = 500;

        while (page < maxPages) {
          const params = new URLSearchParams({ count: "50" });
          if (maxId) params.set("max_id", maxId);

          const data = await requestJson(
            `/api/v1/friendships/${encodeURIComponent(userId)}/${kind}/?${params.toString()}`
          );

          if (!Array.isArray(data?.users)) {
            throw new Error(`Instagram không trả về mảng users hợp lệ cho ${kind}.`);
          }

          const sizeBefore = all.size;
          for (const raw of data.users) {
            const user = normalizeUser(raw);
            if (user) all.set(user.id || user.username.toLowerCase(), user);
          }

          const nextCursor = data.next_max_id == null ? "" : String(data.next_max_id);
          const hasMore = typeof data.has_more === "boolean" ? data.has_more : Boolean(nextCursor);

          page += 1;

          if (!hasMore || data.users.length === 0) break;
          if (!nextCursor) {
            throw new Error(`Instagram báo còn trang ${kind} nhưng không trả pagination cursor.`);
          }
          if (seenCursors.has(nextCursor)) {
            throw new Error(`Instagram lặp pagination cursor khi tải ${kind}; crawl bị dừng để tránh snapshot thiếu.`);
          }
          if (all.size === sizeBefore) {
            throw new Error(`Trang ${kind} mới không bổ sung tài khoản nào; crawl bị dừng để tránh snapshot thiếu.`);
          }

          seenCursors.add(nextCursor);
          maxId = nextCursor;
          await sleep(jitter(550, 950));
        }

        if (page >= maxPages && maxId) {
          throw new Error(`Đã dừng sau ${maxPages} trang ${kind} để tránh crawl quá mức.`);
        }

        const users = [...all.values()];
        validateCoverage(kind, expectedCount, users.length);
        return users;
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

          const following = await fetchRelationship(target.id, "following", target.followingCount);
          await sleep(jitter(900, 1500));
          const followers = await fetchRelationship(target.id, "followers", target.followerCount);

          if (
            following.length === 0 &&
            followers.length === 0 &&
            ((target.followingCount ?? 0) > 0 || (target.followerCount ?? 0) > 0)
          ) {
            throw new Error(
              "Instagram trả về snapshot 0/0 trái với số liệu profile. Snapshot bị từ chối và không được lưu."
            );
          }

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
