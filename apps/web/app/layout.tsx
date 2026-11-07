import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'M1 教学实验台 · 成长型 AI 儿童英语',
  description:
    '教 / 听 / 评估 / 调整 / 记录 五动作闭环验证台；教学决策 100% 由后端返回，Web 只负责渲染与采集作答。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
