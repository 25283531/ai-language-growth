-- 课程级 TTS 缓存：为媒体资产补上可见性作用域、归属与过期时间。
--
-- 三列均可空，且刻意不设 DB 默认值：迁移后现有数据全部保持 NULL，
-- 语义上按 PRIVATE 处理（fail-closed）—— 历史音频默认视为私有，只有被
-- 显式补写为 PUBLIC_CURRICULUM / PRONUNCIATION 的记录才对外共享，避免
-- 升级过程中把未知归属的旧资产误标成公共而被跨学习者读取。
--   scope          : NULL(旧数据=PRIVATE) | PUBLIC_CURRICULUM | PRIVATE_DYNAMIC | PRIVATE_UPLOAD | PRONUNCIATION
--   ownerLearnerId : PRIVATE_* 资产绑定的学习者；PUBLIC_* 资产为 NULL
--   expiresAt      : PRIVATE_* 资产的短 TTL；PUBLIC_* 资产为 NULL
ALTER TABLE "media_assets"
  ADD COLUMN "scope" TEXT,
  ADD COLUMN "ownerLearnerId" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);
