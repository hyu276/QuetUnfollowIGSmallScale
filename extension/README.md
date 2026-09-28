# Chrome extension bridge

Extension MV3 này không chứa database và không đọc/xuất `sessionid`. Nó chỉ chạy request same-origin ngay trong MAIN world của tab `instagram.com` đang đăng nhập, sau đó gửi dữ liệu follower/following về dashboard để dashboard lưu trong IndexedDB của chính browser.

## Cài đặt

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới thư mục `extension/`.
4. Mở `https://www.instagram.com/` và đăng nhập.
5. Mở `https://hyu276.github.io/QuetUnfollowIGSmallScale/`.
6. Reload dashboard sau khi cài hoặc reload extension.

Development local tại `http://localhost:3000` và Vercel preview vẫn được allowlist.

## Quyền

- `https://www.instagram.com/*`: cần để thực thi request trong tab Instagram.
- `scripting`: chạy hàm crawl ở MAIN world để request dùng đúng browser session hiện có.
- `tabs`: tìm tab Instagram đã mở.

Không có quyền tới Supabase, Cloudflare, server API hoặc remote storage.
