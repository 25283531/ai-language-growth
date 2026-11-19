-- 教材映射补记 textbookId：出版社写法不统一（映射写「人教版」、目录写「人民教育出版社」），
-- 只靠 publisher+grade 无法可靠定位教材，导致选定教材后开课拿不到该单元的课文。
ALTER TABLE "textbook_mappings" ADD COLUMN "textbookId" TEXT;
