-- 回滚 20261111120000_media_asset_scope_ownership：移除作用域/归属/TTL 三列。
ALTER TABLE "media_assets"
  DROP COLUMN "scope",
  DROP COLUMN "ownerLearnerId",
  DROP COLUMN "expiresAt";
