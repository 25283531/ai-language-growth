-- 教材单元录入保留课文原文，供重新切句、编辑与生成追溯。
ALTER TABLE "textbook_units" ADD COLUMN "passageSource" TEXT;
