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

      async function requestJson(path) {
        const response = await fetch(path, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "*/*",
            "x-ig-app-id": appId,
          },
          cache: "no-store",
        });
        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new Error(`Instagram trả về dữ liệu không phải JSON (HTTP ${response.status}).`);
        }
        if (!response.ok || data?.status === "fail") {
          const detail = data?.message || data?.error_type || `HTTP ${response.status}`;
          const error = new Error(`Instagram API: ${detail}`);
          error.status = response.status;
          throw error;
        }
        return data;
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
                id: raw.pk ? String(raw.pk) : raw.id ? String(raw.id) : "",
                username: String(raw.username),
                fullName: raw.full_name || raw.first_name || "",
                isPrivate: Boolean(raw.is_private),
              };
            }
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error("Không xác định được tài khoản Instagram đang đăng nhập.");
      }

      async function resolveUser(username) {
        const clean = String(username || "").trim().replace(/^@/, "").toLowerCase();
        if (!clean) throw new Error("Username trống.");

        const resolvers = [
          async () => {
            const data = await requestJson(`/api/v1/users/${encodeURIComponent(clean)}/usernameinfo/`);
            return data?.user;
          },
          async () => {
            const data = await requestJson(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(clean)}`);
            return data?.data?.user;
          },
          async () => {
            const data = await requestJson(`/api/v1/users/search/?q=${encodeURIComponent(clean)}&count=30`);
            return data?.users?.find((user) => String(user.username).toLowerCase() === clean);
          },
        ];

        let lastError = null;
        for (const resolver of resolvers) {
          try {
            const raw = await resolver();
            const normalized = normalizeUser(raw);
            if (normalized) return normalized;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error(`Không resolve được @${clean}.`);
      }

      async function fetchRelationship(userId, kind) {
        const all = new Map();
        let maxId = "";
        let page = 0;
        const maxPages = 500;

        do {
          const params = new URLSearchParams({ count: "50", search_surface: "follow_list_page", order: "default" });
          if (maxId) params.set("max_id", maxId);
          const data = await requestJson(`/api/v1/friendships/${encodeURIComponent(userId)}/${kind}/?${params}`);
          if (!Array.isArray(data?.users)) {
            throw new Error(`Instagram không trả về danh sách ${kind}. Tài khoản có thể không khả dụng cho phiên hiện tại.`);
          }
          for (const raw of data.users) {
            const user = normalizeUser(raw);
            if (user) all.set(user.id || user.username.toLowerCase(), user);
          }
          maxId = data.next_max_id ? String(data.next_max_id) : "";
          page += 1;
          if (maxId) await sleep(300 + Math.floor(Math.random() * 250));
        } while (maxId && page < maxPages);

        if (maxId) throw new Error(`Đã dừng sau ${maxPages} trang để tránh crawl quá mức.`);
        return [...all.values()];
      }

      try {
        if (task === "WHO_AM_I") {
          const account = await getCurrentAccount();
          return { ok: true, data: account };
        }

        if (task === "CRAWL") {
          const requestedUsername = String(input?.username || "").trim().replace(/^@/, "").toLowerCase();
          const target = await resolveUser(requestedUsername);
          const [followers, following] = await Promise.all([
            fetchRelationship(target.id, "followers"),
            fetchRelationship(target.id, "following"),
          ]);
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
