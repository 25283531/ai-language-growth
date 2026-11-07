import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'AI Language Growth · 模型接入设置',
  description: '管理 AI 模型服务商和接入配置',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
