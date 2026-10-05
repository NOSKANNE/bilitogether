import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BiliTogether · B站视频一起看",
  description:
    "和朋友多端同步观看B站视频：房主控制播放内容与进度，支持PC/手机互通、画质调节、弹幕开关、实时聊天与连播列表。",
  keywords: ["B站一起看", "同步观影", "bilibili", "一起看视频", "watch together", "放映厅"],
  authors: [{ name: "BiliTogether" }],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "BiliTogether",
  },
  openGraph: {
    title: "BiliTogether · B站视频一起看",
    description: "房主控制播放，全员同步观看，PC/手机互通的B站放映厅。",
    siteName: "BiliTogether",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#17171a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* B站 CDN (bilivideo) 会拒绝带第三方 Referer 的视频请求，no-referrer 后可正常播放 */}
        <meta name="referrer" content="no-referrer" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/*
          全站深浅色主题（next-themes，class 策略）：
          - defaultTheme="light"：全站以清爽浅色为默认印象（首页 + 房间「白天模式」）；
          - enableSystem={false}：不跟随系统偏好，避免首帧不确定与闪变，用户通过切换按钮二选一；
          - disableTransitionOnChange：切换瞬间禁用全局 transition，防止颜色过渡闪烁；
          - 房间页通过双主题化影院 surface token 跟随全局主题：
            白天 = 清爽浅色影院，黑夜（html.dark）= 沉浸深色影院，右上角按钮全站真实生效。
        */}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          storageKey="bilitogether:theme"
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
