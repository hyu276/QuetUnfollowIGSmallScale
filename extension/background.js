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
          const contentType = response.headers.get("content-type") || "unknown";
          const error =
            response.status === 429
              ? new Error(
                  `Instagram đang rate-limit request (HTTP 429) tại ${path}. Không nên bấm crawl liên tục; hãy chờ một lúc rồi thử lại.`
                )
              : new Error(
                  `Instagram trả về HTML/non-JSON thay vì API JSON (HTTP ${response.status}, content-type: ${contentType}) tại ${path}.`
                );
          error.status = response.status;
          error.endpoint = path;
          throw error;
        }
        return { response, data };
      }

      async function fetchProfileHtml(username) {
        const path = `/${encodeURIComponent(username)}/`;
        const response = await fetch(path, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          cache: "no-store",
        });
        const text = await response.text();

        if (!response.ok) {
          const error = new Error(`Instagram profile HTML: HTTP ${response.status} tại ${path}.`);
          error.status = response.status;
          error.endpoint = path;
          throw error;
        }

        return text;
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

        const errors = [];

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
          // Continue with target-account resolvers.
        }

        const searchPath =
          `/web/search/topsearch/?query=${encodeURIComponent(clean)}&context=blended&count=10`;

        try {
          const data = await requestJson(searchPath);
          const match = (data?.users || [])
            .map((entry) => entry?.user || entry)
            .find((user) => String(user?.username || "").toLowerCase() === clean);

          const normalized = normalizeTarget(match, clean);
          if (normalized) return normalized;

          errors.push(new Error(`Top Search không tìm thấy kết quả chính xác cho @${clean}.`));
        } catch (error) {
          errors.push(error);
        }

        try {
          const html = await fetchProfileHtml(clean);
          const profileId =
            html.match(/"profile_id":"(\d+)"/)?.[1] ||
            html.match(/&quot;profile_id&quot;:&quot;(\d+)&quot;/)?.[1] ||
            "";

          if (profileId) {
            return {
              id: profileId,
              username: clean,
              fullName: "",
              isPrivate: false,
              followerCount: null,
              followingCount: null,
            };
          }

          errors.push(new Error(`Profile HTML của @${clean} không chứa profile_id.`));
        } catch (error) {
          errors.push(error);
        }

        const profilePath = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`;

        try {
          const { response, data } = await fetchJson(profilePath);
          if (response.status === 404) throw new Error(`Không tìm thấy @${clean}.`);

          if (response.ok && data?.data?.user) {
            const normalized = normalizeTarget(data.data.user, clean);
            if (normalized) return normalized;
          }

          const detail = data?.message || data?.error_type || `HTTP ${response.status}`;
          throw new Error(`Instagram web_profile_info: ${detail}`);
        } catch (error) {
          errors.push(error);
        }

        const messages = errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .filter(Boolean);

        const rateLimited = errors.some((error) => Number(error?.status) === 429);
        const suffix = rateLimited
          ? " Instagram đang áp rate limit cho ít nhất một resolver; không nên retry liên tục."
          : "";

        throw new Error(
          `Không resolve được @${clean}. ${messages.join("; ")}${suffix}`
        );
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
