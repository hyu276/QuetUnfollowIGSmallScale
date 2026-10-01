"use client";

import { useEffect, useMemo, useState } from "react";
import { currentRelationshipSets, diffSnapshots } from "@/lib/diff";
import { deleteSnapshotIds, deleteSnapshots, listSnapshots, saveSnapshot } from "@/lib/storage";
import type { BridgeResponse, CrawlResult, CrawlSnapshot, IgPerson, RelationshipDiff } from "@/lib/types";

declare global {
  interface WindowEventMap {
    "message": MessageEvent;
  }
}

type TabKey = "lostFollowers" | "gainedFollowers" | "lostFollowing" | "gainedFollowing" | "notFollowingBack" | "youDoNotFollowBack";

const labels: Record<TabKey, string> = {
  lostFollowers: "Đã unfollow bạn",
  gainedFollowers: "Follower mới",
  lostFollowing: "Bạn đã unfollow",
  gainedFollowing: "Bạn vừa follow",
  notFollowingBack: "Không follow lại bạn",
  youDoNotFollowBack: "Bạn không follow lại",
};

function sendBridge<T>(action: string, payload?: unknown, timeout = 180_000): Promise<BridgeResponse<T>> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "Hết thời gian chờ extension phản hồi." });
    }, timeout);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source !== "QUG_EXTENSION" || data?.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.response as BridgeResponse<T>);
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: "QUG_DASHBOARD", requestId, action, payload }, "*");
  });
}

function PersonList({ items }: { items: IgPerson[] }) {
  if (!items.length) return <div className="empty">Không có tài khoản nào trong nhóm này.</div>;
  return (
    <div className="list">
      {items.map((person) => (
        <div className="person" key={person.id || person.username}>
          <div className="meta">
            <div className="username">@{person.username}</div>
            <div className="name">{person.fullName || "—"}</div>
          </div>
          <span className="badge">{person.isPrivate ? "Private" : "Public"}</span>
        </div>
      ))}
    </div>
  );
}

const emptyDiff: RelationshipDiff = { lostFollowers: [], gainedFollowers: [], lostFollowing: [], gainedFollowing: [] };

export default function Dashboard() {
  const [username, setUsername] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Đang kiểm tra Chrome extension…");
  const [messageKind, setMessageKind] = useState<"normal" | "good" | "bad">("normal");
  const [current, setCurrent] = useState<CrawlSnapshot | null>(null);
  const [previousDiff, setPreviousDiff] = useState<RelationshipDiff>(emptyDiff);
  const [baselineDiff, setBaselineDiff] = useState<RelationshipDiff>(emptyDiff);
  const [compareMode, setCompareMode] = useState<"previous" | "baseline">("previous");
  const [tab, setTab] = useState<TabKey>("lostFollowers");

  useEffect(() => {
    sendBridge<{ version: string }>("PING", undefined, 2500).then((response) => {
      if (response.ok) {
        const version = response.data?.version || "0.0.0";
        if (version === "0.1.0" || version === "0.1.1") {
          setBridgeReady(false);
          setMessage(`Extension ${version} đã cũ. Bản 0.1.2 sửa lỗi crawl 0 followers / 0 following. Hãy cập nhật thư mục extension từ repo, bấm Reload trong chrome://extensions, rồi tải lại trang.`);
          setMessageKind("bad");
          return;
        }
        setBridgeReady(true);
        setMessage(`Extension ${version} đã kết nối. Hãy mở một tab instagram.com và đăng nhập.`);
        setMessageKind("good");
      } else {
        setBridgeReady(false);
        setMessage("Chưa phát hiện extension. Cài thư mục /extension ở chế độ Load unpacked rồi tải lại trang.");
        setMessageKind("bad");
      }
    });
  }, []);

  async function useCurrentAccount() {
    setBusy(true);
    setMessage("Đang đọc tài khoản Instagram hiện đăng nhập…");
    setMessageKind("normal");
    const response = await sendBridge<{ username: string }>("WHO_AM_I");
    setBusy(false);
    if (!response.ok || !response.data?.username) {
      setMessage(response.error || "Không xác định được tài khoản đang đăng nhập.");
      setMessageKind("bad");
      return;
    }
    setUsername(response.data.username);
    setMessage(`Đã nhận diện @${response.data.username}.`);
    setMessageKind("good");
    await hydrateHistory(response.data.username);
  }

  async function hydrateHistory(handle: string) {
    const snapshots = await listSnapshots(handle.toLowerCase());
    if (!snapshots.length) return;
    const latest = snapshots.at(-1)!;
    setCurrent(latest);
    setBaselineDiff(snapshots.length > 1 ? diffSnapshots(snapshots[0], latest) : emptyDiff);
    setPreviousDiff(snapshots.length > 1 ? diffSnapshots(snapshots.at(-2)!, latest) : emptyDiff);
  }

  async function crawl() {
    const handle = username.trim().replace(/^@/, "").toLowerCase();
    if (!handle) {
      setMessage("Nhập username cần crawl.");
      setMessageKind("bad");
      return;
    }
    setBusy(true);
    setMessage(`Đang crawl @${handle}. Với tài khoản lớn, quá trình có thể cần nhiều trang dữ liệu.`);
    setMessageKind("normal");

    let history = await listSnapshots(handle);
    const response = await sendBridge<CrawlResult>("CRAWL", { username: handle });
    if (!response.ok || !response.data) {
      setBusy(false);
      setMessage(response.error || "Crawl thất bại.");
      setMessageKind("bad");
      return;
    }

    const snapshot = response.data.snapshot;

    if (snapshot.followers.length > 0 || snapshot.following.length > 0) {
      const invalidEmptySnapshots = history.filter(
        (item) => item.followers.length === 0 && item.following.length === 0
      );
      if (invalidEmptySnapshots.length) {
        await deleteSnapshotIds(invalidEmptySnapshots.map((item) => item.id));
        history = history.filter(
          (item) => item.followers.length > 0 || item.following.length > 0
        );
      }
    }

    await saveSnapshot(snapshot);
    const updatedHistory = [...history, snapshot];
    setCurrent(snapshot);
    setPreviousDiff(history.length ? diffSnapshots(history.at(-1)!, snapshot) : emptyDiff);
    setBaselineDiff(history.length ? diffSnapshots(history[0], snapshot) : emptyDiff);
    setBusy(false);
    setMessage(
      history.length
        ? `Đã lưu snapshot mới: ${snapshot.followers.length} followers, ${snapshot.following.length} following.`
        : `Đã tạo baseline đầu tiên cho @${handle}. Lần crawl sau sẽ xuất hiện thay đổi.`
    );
    setMessageKind("good");

    if (updatedHistory.length === 1) setCompareMode("previous");
  }

  async function resetBaseline() {
    const handle = username.trim().replace(/^@/, "").toLowerCase();
    if (!handle) return;
    if (!window.confirm(`Xóa toàn bộ snapshot local của @${handle}?`)) return;
    await deleteSnapshots(handle);
    setCurrent(null);
    setPreviousDiff(emptyDiff);
    setBaselineDiff(emptyDiff);
    setMessage(`Đã xóa dữ liệu local của @${handle}.`);
    setMessageKind("good");
  }

  const relationSets = useMemo(() => (current ? currentRelationshipSets(current) : null), [current]);
  const diff = compareMode === "previous" ? previousDiff : baselineDiff;
  const tabItems: Record<TabKey, IgPerson[]> = {
    lostFollowers: diff.lostFollowers,
    gainedFollowers: diff.gainedFollowers,
    lostFollowing: diff.lostFollowing,
    gainedFollowing: diff.gainedFollowing,
    notFollowingBack: relationSets?.notFollowingBack || [],
    youDoNotFollowBack: relationSets?.youDoNotFollowBack || [],
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Quét Unfollow IG · Small Scale</p>
        <h1>Biết ai unfollow bạn, ngay trên máy của bạn.</h1>
        <p>
          Không Supabase, không Cloudflare, không upload follower list lên server. Dashboard chỉ lưu snapshot trong IndexedDB của trình duyệt; extension dùng chính tab Instagram đã đăng nhập để đọc dữ liệu mà phiên đó được phép xem.
        </p>
      </section>

      <section className="panel toolbar">
        <label>
          Instagram username
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="vd: your_username" />
        </label>
        <button className="secondary" disabled={!bridgeReady || busy} onClick={useCurrentAccount}>Dùng tài khoản đang đăng nhập</button>
        <button disabled={!bridgeReady || busy} onClick={crawl}>{busy ? "Đang crawl…" : "Run crawl"}</button>
      </section>

      <div className={`status ${messageKind === "good" ? "good" : messageKind === "bad" ? "bad" : ""}`}>{message}</div>

      {current && (
        <>
          <section className="grid four stats">
            <div className="panel stat"><span>Followers</span><strong>{current.followers.length.toLocaleString()}</strong></div>
            <div className="panel stat"><span>Following</span><strong>{current.following.length.toLocaleString()}</strong></div>
            <div className="panel stat"><span>Không follow lại bạn</span><strong>{relationSets?.notFollowingBack.length.toLocaleString()}</strong></div>
            <div className="panel stat"><span>Mutuals</span><strong>{relationSets?.mutuals.length.toLocaleString()}</strong></div>
          </section>

          <section className="section panel">
            <div className="grid two">
              <div>
                <h2>Thay đổi relationship</h2>
                <p className="section-copy">So sánh snapshot hiện tại với lần crawl ngay trước hoặc baseline đầu tiên.</p>
              </div>
              <label>
                Mốc so sánh
                <select value={compareMode} onChange={(e) => setCompareMode(e.target.value as "previous" | "baseline")}>
                  <option value="previous">Lần crawl trước</option>
                  <option value="baseline">Lần crawl đầu tiên</option>
                </select>
              </label>
            </div>
            <div className="tabs">
              {(Object.keys(labels) as TabKey[]).map((key) => (
                <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
                  {labels[key]} · {tabItems[key].length}
                </button>
              ))}
            </div>
            <PersonList items={tabItems[tab]} />
          </section>

          <section className="section panel">
            <h2>Local data</h2>
            <p className="section-copy">Snapshot gần nhất: {new Date(current.createdAt).toLocaleString("vi-VN")} · @{current.username}</p>
            <button className="secondary" onClick={resetBaseline}>Xóa snapshot của tài khoản này</button>
          </section>
        </>
      )}

      <p className="small section">Lưu ý: Instagram có thể thay đổi private web API hoặc áp rate limit. Tool không vượt quyền truy cập của tài khoản đang đăng nhập và không cố bypass tài khoản private.</p>
    </main>
  );
}
