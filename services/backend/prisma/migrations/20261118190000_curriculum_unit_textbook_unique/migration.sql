-- 一个教材单元只能对应一个课程单元，防止并发 generate 创建重复 active 课程。
CREATE UNIQUE INDEX "curriculum_units_textbookUnitId_key" ON "curriculum_units"("textbookUnitId");
