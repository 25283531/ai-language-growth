-- scenarios 是 learning_evidence.scenario / assessment_records.scenario 的外键目标。
-- 生产与 staging 只执行 migrate deploy，不执行 seed；如果场景只存在于 seed，
-- 完形通过证据写 story_scene 时会在 learning_evidence_scenario_fkey 上失败。
-- 这里幂等补齐共享契约 EVIDENCE_SCENARIOS 的 8 条基础记录，已有记录不覆盖。

INSERT INTO "scenarios" ("id", "code", "name", "description", "countsForTransfer")
VALUES
    ('sc-greeting', 'greeting_scene', '问候情景', '打招呼与道别的情景交互', true),
    ('sc-self-intro', 'self_intro_scene', '自我介绍情景', '介绍自己名字与年龄的情景', true),
    ('sc-object-pic', 'object_pic_scene', '图片识别情景', '看图说词的情景', true),
    ('sc-object-shop', 'object_shop_scene', '新情境用词', '在购物等新情境中使用已学词', true),
    ('sc-free-chat', 'free_chat_scene', '自由交流情景', '孩子自由表达的情景', true),
    ('sc-story', 'story_scene', '故事语境情景', '小故事语境中的理解与表达', true),
    ('sc-review', 'review_scene', '复习场次', '间隔重复的复习场次，不计入无提示回忆', false),
    ('sc-assessment', 'assessment_scene', '评估场次', '正式能力评估场次，不计入无提示回忆', false)
ON CONFLICT DO NOTHING;
