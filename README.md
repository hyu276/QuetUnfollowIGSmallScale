# QuetUnfollowIGSmallScale

Local-first tracker cho followers/following Instagram. Production dashboard được host bằng GitHub Pages; dữ liệu người dùng vẫn chỉ nằm trong browser.

## Live website

Sau khi workflow `Deploy GitHub Pages` chạy thành công trên `main`, website nằm tại:

`https://hyu276.github.io/QuetUnfollowIGSmallScale/`

Website không cần Supabase, Cloudflare hay backend database. Snapshot được lưu trong IndexedDB của origin GitHub Pages trên browser/device đang sử dụng.

## Kiến trúc

- **Next.js dashboard**: static export, chạy trên GitHub Pages.
- **Chrome MV3 extension**: bridge giữa live dashboard và tab `instagram.com` đang đăng nhập.
- **IndexedDB**: lưu baseline và các snapshot tiếp theo hoàn toàn cục bộ.
- **Không chuyển cookie Instagram lên website**: extension chạy request ngay trong MAIN world của tab Instagram.

## Cài extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `extension/` của repository.
5. Mở `https://www.instagram.com/` và đăng nhập.
6. Mở live dashboard tại `https://hyu276.github.io/QuetUnfollowIGSmallScale/`.
7. Reload dashboard sau khi cài/reload extension.

Extension chỉ bridge cho live URL của repo, localhost trong development, và Vercel preview nếu cần.

## Cách dùng

- Chọn **Dùng tài khoản đang đăng nhập** để lấy username hiện tại, hoặc nhập username khác.
- Bấm **Run crawl**.
- Lần đầu tạo baseline.
- Những lần sau hiển thị thay đổi so với lần crawl trước hoặc baseline đầu tiên.
- Các nhóm chính: đã unfollow bạn, follower mới, bạn đã unfollow, bạn vừa follow, không follow lại bạn, bạn không follow lại.

Có thể crawl tài khoản khác nếu session Instagram hiện tại thực sự có quyền xem follower/following list của tài khoản đó. Không có logic bypass private account hoặc access control.

## GitHub Pages

Repository cần cấu hình:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

Workflow `.github/workflows/pages.yml` sẽ tự động lint, test, build static export vào `out/`, sau đó deploy Pages mỗi khi `main` có commit mới.

## Development local

```bash
npm install
npm run dev
```

Mở `http://localhost:3000` và reload extension nếu vừa sửa `manifest.json`.

## Kiểm tra trước merge

```bash
npm run lint
npm test
npm run build
```

## Data model local

IndexedDB database: `quet-unfollow-ig-local`, object store: `snapshots`.

Mỗi snapshot chứa target username/user ID, timestamp, followers và following tại thời điểm crawl. Baseline không bị ghi đè; snapshot mới được append. Dashboard dùng snapshot đầu tiên làm baseline và snapshot liền trước để tính thay đổi gần nhất.

Dữ liệu của `localhost` và GitHub Pages là hai origin khác nhau nên không tự chia sẻ IndexedDB với nhau.

## Giới hạn kỹ thuật

Instagram không cung cấp public API chính thức cho use-case này. Extension dùng private web endpoints mà chính website Instagram sử dụng. Endpoint, header hoặc pagination có thể thay đổi hoặc bị rate-limit. Khi request lỗi, tool trả lỗi và không ghi snapshot rỗng để tránh false-positive kiểu “mọi người đều unfollow”.
