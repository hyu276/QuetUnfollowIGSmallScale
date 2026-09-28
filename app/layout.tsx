import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quét Unfollow IG — Local",
  description: "Theo dõi thay đổi followers/following Instagram chỉ bằng dữ liệu lưu cục bộ.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
