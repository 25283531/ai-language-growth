import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TextbookUnitContent } from '@alg/shared-contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  contentHash,
  registerContentImages,
  syncLearningItems,
  upsertVocabularyItems,
  type PublishableActivity,
  type PublishableLesson,
} from './curriculum-publish';
import { derivedTextbookActivities } from './textbook-item-plan';
import {
  validateTextbookUnitContent,
  type TextbookUnitQcIssue,
  type TextbookUnitQcResult,
} from './textbook-unit-qc';

/**
 * 自动校验通过后的“直接启用”事务。
 *
 * 写入顺序固定：unit → version → learning_items → vocabulary_items → draft/audit。
 * 任何一个动作失败都回滚，避免出现“单元 active 但活动没下发”的半成品。
 * 失败时只写 qcReport（不创建 active 单元），由接口把 issues 原样返回给管理端。
 */

export type TextbookUnitActivation = {
  activated: boolean;
  unitId?: string;
  topicId?: string;
  version?: number;
  contentVersion?: string;
  draftId?: string;
  enabledAt?: string;
  validation: TextbookUnitQcResult;
};

export type TextbookUnitMutation = {
  updated: boolean;
  rolledBack?: boolean;
  unitId?: string;
  textbookUnitId?: string;
  topicId?: string;
  version?: number;
  sourceVersion?: number;
  contentVersion?: string;
  availability?: string;
  draftId?: string;
  validation: TextbookUnitQcResult;
  qcReport?: Record<string, unknown>;
};

const STAGE_LEVELS = ['pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

type UnitRecord = {
  id: string;
  textbookId: string;
  unitCode: string;
  title: string;
  order: number;
  metadata: unknown;
  textbook: { publisher: string; grade: string; title: string | null; edition: string | null } | null;
};

@Injectable()
export class TextbookUnitPublisherService {
  private readonly logger = new Logger(TextbookUnitPublisherService.name);

  constructor(private readonly prisma: PrismaService) {}

  async activate(
    unitId: string,
    content: TextbookUnitContent,
    qcReport: Record<string, unknown>,
  ): Promise<TextbookUnitActivation> {
    const unit = await this.prisma.textbook_units.findUnique({
      where: { id: unitId },
      include: { textbook: true },
    }) as unknown as UnitRecord | null;
    if (!unit) throw new NotFoundException('教材单元不存在');

    const metadata = asRecord(unit.metadata);
    const authoredActivities: PublishableActivity[] = [
      ...(content.activities as PublishableActivity[]),
      ...((content.schoolTrack?.activities ?? []) as PublishableActivity[]),
    ];
    // P0-2/P0-4：逐句跟读与重点词条目排在前面，人工活动在后。
    const allActivities: PublishableActivity[] = [
      ...derivedTextbookActivities(content, authoredActivities),
      ...authoredActivities,
    ];
    const skillIds = [...new Set(allActivities.flatMap((activity) => activity.skillNodeIds))];

    const [skills, phonemes, existingUnit, existingDraft] = await Promise.all([
      this.prisma.skill_nodes.findMany({
        where: { OR: [{ id: { in: skillIds } }, { code: { in: skillIds } }] },
        select: { id: true, code: true },
      }),
      this.prisma.phoneme_items.findMany({ select: { phoneme: true } }),
      this.prisma.curriculum_units.findFirst({
        where: { textbookUnitId: unit.id },
        orderBy: { publishedAt: 'desc' },
      }),
      this.prisma.curriculum_drafts.findFirst({
        where: { textbookUnitId: unit.id },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const knownSkillCodes = new Set(skills.flatMap((skill) => [skill.id, skill.code]));
    const skillIdByCode = new Map(skills.flatMap((skill) => [[skill.id, skill.id], [skill.code, skill.id]]));
    const validation = validateTextbookUnitContent(content, {
      grammarFocus: toStringArray(metadata.grammarFocus),
      knownSkillCodes,
      phonemeSymbols: new Set(phonemes.map((item) => item.phoneme).filter(Boolean)),
      generationIssues: arrayOfRecords(qcReport.issues),
      unitCode: unit.unitCode,
    });

    if (content.unit.code !== unit.unitCode) {
      addExternalIssue(validation, 'unit_code_mismatch', 'unit.code', `资源包单元编码 ${content.unit.code} 与录入单元 ${unit.unitCode} 不一致。`);
    }
    const topicId = existingUnit?.topicId
      || existingDraft?.topicId
      || `topic-textbook-${unit.id}`;
    const conflict = await this.prisma.curriculum_units.findFirst({
      where: {
        topicId,
        ...(existingUnit ? { id: { not: existingUnit.id } } : {}),
      },
      select: { id: true, textbookUnitId: true },
    });
    if (conflict) {
      addExternalIssue(
        validation,
        'topic_conflict',
        'topicId',
        `主题 ${topicId} 已被另一个课程单元占用，不能自动启用。`,
      );
    }

    const finalReport = buildQcReport(qcReport, validation, null);
    if (!validation.ok) {
      await this.persistReport(unit, content, finalReport);
      return { activated: false, validation };
    }

    const hash = textbookContentHash(content);
    const publishable: PublishableLesson = {
      title: content.unit.title,
      level: levelForContent(content, unit.textbook?.grade),
      objectives: content.objectives,
      vocabulary: content.vocabulary.map((item) => ({
        word: item.word,
        phonetic: item.phonetic,
        meaningZh: item.meaningZh,
        syllables: item.syllables,
        difficultPhonemes: item.difficultPhonemes,
        phrases: item.phrases,
        exampleSentences: item.exampleSentences,
        ...(item.imageAsset ? { image: item.imageAsset } : {}),
      })),
      activities: allActivities as PublishableActivity[],
      images: [],
    };
    const now = new Date();

    try {
      const activation = await this.prisma.$transaction(async (tx) => {
        // 事务内重新读取，降低两个并发 generate 同时创建 unit 的概率；
        // 数据库唯一索引是最终防线（textbookUnitId 唯一）。
        const current = await tx.curriculum_units.findFirst({
          where: { textbookUnitId: unit.id },
          orderBy: { publishedAt: 'desc' },
        });
        const nextTopicId = current?.topicId || topicId;
        const nextLevel = publishable.level;
        const nextStage = stageForContent(content, nextLevel);
        let targetUnitId: string;
        let version: number;
        let changed = true;

        if (!current) {
          const created = await tx.curriculum_units.create({
            data: {
              topicId: nextTopicId,
              stage: nextStage,
              level: nextLevel,
              title: publishable.title,
              description: content.objectives.join('；') || null,
              order: content.unit.order,
              textbookUnitId: unit.id,
              reviewStatus: 'published',
              publishedAt: now,
              content: content as unknown as Prisma.InputJsonValue,
              contentVersion: hash,
              currentVersion: 1,
              availability: 'active',
              stageHint: content.stageHint ?? null,
            },
          });
          targetUnitId = created.id;
          version = 1;
          await tx.curriculum_unit_versions.create({
            data: {
              unitId: created.id,
              version: 1,
              content: content as unknown as Prisma.InputJsonValue,
              contentHash: hash,
              createdBy: 'auto-qc',
              note: '自动校验通过，首次直接启用',
            },
          });
        } else {
          targetUnitId = current.id;
          changed = current.contentVersion !== hash;
          version = changed ? current.currentVersion + 1 : current.currentVersion;
          if (changed) {
            // 迁移前发布/首次自动启用的 unit 可能没有当前版本快照；先补录，
            // 否则回滚不到自动启用前的内容。
            const currentSnapshot = await tx.curriculum_unit_versions.findUnique({
              where: { unitId_version: { unitId: current.id, version: current.currentVersion } },
              select: { id: true },
            });
            if (!currentSnapshot && current.content) {
              await tx.curriculum_unit_versions.create({
                data: {
                  unitId: current.id,
                  version: current.currentVersion,
                  content: current.content as Prisma.InputJsonValue,
                  contentHash: current.contentVersion || contentHash(current.content),
                  createdBy: 'auto-qc',
                  note: '补录自动启用前版本',
                },
              });
            }
            await tx.curriculum_unit_versions.create({
              data: {
                unitId: current.id,
                version,
                content: content as unknown as Prisma.InputJsonValue,
                contentHash: hash,
                createdBy: 'auto-qc',
                note: '自动校验通过，重新生成并启用',
              },
            });
          }
          await tx.curriculum_units.update({
            where: { id: current.id },
            data: {
              topicId: nextTopicId,
              stage: nextStage,
              level: nextLevel,
              title: publishable.title,
              description: content.objectives.join('；') || null,
              order: content.unit.order,
              textbookUnitId: unit.id,
              reviewStatus: 'published',
              publishedAt: now,
              content: content as unknown as Prisma.InputJsonValue,
              contentVersion: hash,
              currentVersion: version,
              availability: 'active',
              stageHint: content.stageHint ?? null,
            },
          });
        }

        const imageByWord = await registerContentImages(tx, publishable);
        await syncLearningItems(
          tx,
          targetUnitId,
          nextTopicId,
          publishable,
          skillIdByCode,
          imageByWord,
          true,
          'published',
        );
        await upsertVocabularyItems(tx, nextTopicId, publishable, skillIdByCode, 'published', true);

        const draft = existingDraft
          ? await tx.curriculum_drafts.update({
            where: { id: existingDraft.id },
            data: {
              title: publishable.title,
              level: nextLevel,
              topicId: nextTopicId,
              textbookId: unit.textbookId,
              textbookUnitId: unit.id,
              wordList: content.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
              generatedContent: content as unknown as Prisma.InputJsonValue,
              status: 'published',
              reviewedBy: 'auto-qc',
              reviewNote: validation.warnings.length
                ? `自动校验通过，直接启用；有 ${validation.warnings.length} 条警告`
                : '自动校验通过，直接启用',
              generatedAt: now,
              publishedAt: now,
              ...(changed ? { version: { increment: 1 } } : {}),
            },
          })
          : await tx.curriculum_drafts.create({
            data: {
              title: publishable.title,
              level: nextLevel,
              topicId: nextTopicId,
              textbookId: unit.textbookId,
              textbookUnitId: unit.id,
              wordList: content.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
              generatedContent: content as unknown as Prisma.InputJsonValue,
              status: 'published',
              createdBy: 'auto-qc',
              reviewedBy: 'auto-qc',
              reviewNote: validation.warnings.length
                ? `自动校验通过，直接启用；有 ${validation.warnings.length} 条警告`
                : '自动校验通过，直接启用',
              generatedAt: now,
              publishedAt: now,
              version: 1,
            },
          });

        await tx.curriculum_review_records.create({
          data: {
            draftId: draft.id,
            action: 'published',
            reviewer: 'auto-qc',
            note: validation.warnings.length
              ? `自动校验通过，直接启用；警告 ${validation.warnings.length} 条`
              : '自动校验通过，直接启用',
            snapshot: {
              ...content,
              unitId: targetUnitId,
              topicId: nextTopicId,
              version,
              contentVersion: hash,
              qcReport: {
                ok: validation.ok,
                errors: validation.errors.length,
                warnings: validation.warnings.length,
              },
            } as Prisma.InputJsonValue,
          },
        });

        const activation: TextbookUnitActivation = {
          activated: true,
          unitId: targetUnitId,
          topicId: nextTopicId,
          version,
          contentVersion: hash,
          draftId: draft.id,
          enabledAt: now.toISOString(),
          validation,
        };
        const report = buildQcReport(qcReport, validation, activation);
        await tx.textbook_units.update({
          where: { id: unit.id },
          data: {
            metadata: {
              ...metadata,
              content,
              qcReport: report,
              needsReview: validation.warnings.length > 0,
              activation,
            } as Prisma.InputJsonValue,
          },
        });
        return activation;
      });

      this.logger.log(
        `教材单元 ${unit.unitCode} 自动校验通过并启用：unit=${activation.unitId} version=${activation.version} warnings=${validation.warnings.length}`,
      );
      return activation;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该教材单元正在被另一次生成启用，请刷新后重试');
      }
      this.logger.error(`教材单元 ${unit.unitCode} 自动启用失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 已上线教材单元编辑。
   *
   * 与首次自动启用共用同一套 QC 和落库动作，但不改变 availability：
   * 下架状态的单元编辑后仍保持下架，管理员再次 enable 才会重新下发。
   * 校验失败只返回可定位 issues，不覆盖当前线上内容。
   */
  async updateTextbookUnit(
    textbookUnitId: string,
    content: TextbookUnitContent,
    expectedVersion: number,
    reviewer: string,
    reason?: string,
  ): Promise<TextbookUnitMutation> {
    const unit = await this.loadTextbookUnit(textbookUnitId);
    const current = await this.prisma.curriculum_units.findFirst({
      where: { textbookUnitId: unit.id },
      orderBy: { publishedAt: 'desc' },
    });
    if (!current) throw new NotFoundException('该教材单元尚未启用，不能编辑已上线内容');
    if (current.currentVersion !== expectedVersion) {
      throw new ConflictException('课程已被其他操作修改，请刷新后重试');
    }

    const { validation, skillIdByCode } = await this.validateUnitContent(unit, content);
    const report = validationReport(validation);
    if (!validation.ok) {
      return {
        updated: false,
        textbookUnitId: unit.id,
        unitId: current.id,
        validation,
        qcReport: report,
      };
    }

    const storedContent = withQcReport(content, report);
    const hash = textbookContentHash(storedContent);
    const publishable = publishableForContent(storedContent, unit.textbook?.grade);
    const level = publishable.level;
    const stage = stageForContent(storedContent, level);
    const existingDraft = await this.prisma.curriculum_drafts.findFirst({
      where: { textbookUnitId: unit.id },
      orderBy: { updatedAt: 'desc' },
    });
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.curriculum_units.findUnique({ where: { id: current.id } });
      if (!fresh) throw new NotFoundException('课程单元不存在');
      if (fresh.currentVersion !== expectedVersion) {
        throw new ConflictException('课程已被其他操作修改，请刷新后重试');
      }
      const nextVersion = expectedVersion + 1;

      // 迁移前发布的单元可能没有版本行；编辑前补录当前版本，保证仍可回滚。
      const currentSnapshot = await tx.curriculum_unit_versions.findUnique({
        where: { unitId_version: { unitId: fresh.id, version: fresh.currentVersion } },
        select: { id: true },
      });
      if (!currentSnapshot && fresh.content) {
        await tx.curriculum_unit_versions.create({
          data: {
            unitId: fresh.id,
            version: fresh.currentVersion,
            content: fresh.content as Prisma.InputJsonValue,
            contentHash: fresh.contentVersion || contentHash(fresh.content),
            createdBy: reviewer,
            note: '补录编辑前当前版本',
          },
        });
      }

      await tx.curriculum_unit_versions.create({
        data: {
          unitId: fresh.id,
          version: nextVersion,
          content: storedContent as unknown as Prisma.InputJsonValue,
          contentHash: hash,
          createdBy: reviewer,
          note: `已上线内容编辑${reason ? `：${reason}` : ''}`,
        },
      });

      const claimed = await tx.curriculum_units.updateMany({
        where: {
          id: fresh.id,
          currentVersion: expectedVersion,
          reviewStatus: 'published',
        },
        data: {
          title: publishable.title,
          level,
          stage,
          description: storedContent.objectives.join('；') || null,
          content: storedContent as unknown as Prisma.InputJsonValue,
          contentVersion: hash,
          currentVersion: nextVersion,
          stageHint: storedContent.stageHint ?? null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('课程单元已被其他操作修改，请刷新后重试');

      const itemStatus = fresh.availability === 'active' ? 'published' : 'disabled';
      const imageByWord = await registerContentImages(tx, publishable);
      await syncLearningItems(tx, fresh.id, fresh.topicId, publishable, skillIdByCode, imageByWord, true, itemStatus);
      await upsertVocabularyItems(tx, fresh.topicId, publishable, skillIdByCode, itemStatus, true);

      const draft = existingDraft
        ? await tx.curriculum_drafts.update({
          where: { id: existingDraft.id },
          data: {
            title: publishable.title,
            level,
            topicId: fresh.topicId,
            textbookId: unit.textbookId,
            textbookUnitId: unit.id,
            wordList: storedContent.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
            generatedContent: storedContent as unknown as Prisma.InputJsonValue,
            status: 'published',
            reviewedBy: reviewer,
            reviewNote: validation.warnings.length
              ? `管理员编辑已上线内容；自动校验通过，警告 ${validation.warnings.length} 条`
              : '管理员编辑已上线内容；自动校验通过',
            version: { increment: 1 },
          },
        })
        : await tx.curriculum_drafts.create({
          data: {
            title: publishable.title,
            level,
            topicId: fresh.topicId,
            textbookId: unit.textbookId,
            textbookUnitId: unit.id,
            wordList: storedContent.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
            generatedContent: storedContent as unknown as Prisma.InputJsonValue,
            status: 'published',
            createdBy: reviewer,
            reviewedBy: reviewer,
            reviewNote: '管理员编辑已上线内容；自动校验通过',
            publishedAt: now,
            version: 1,
          },
        });

      await tx.curriculum_review_records.create({
        data: {
          draftId: draft.id,
          action: 'edited',
          reviewer,
          note: `管理员编辑已上线内容；直接生效，可回滚${reason ? `：${reason}` : ''}`,
          snapshot: {
            ...storedContent,
            unitId: fresh.id,
            version: nextVersion,
            contentVersion: hash,
            sourceVersion: expectedVersion,
          } as Prisma.InputJsonValue,
        },
      });

      const previousActivation = asRecord(metadataForUnit(unit).activation);
      const activation = Object.keys(previousActivation).length
        ? {
          ...previousActivation,
          unitId: fresh.id,
          topicId: fresh.topicId,
          version: nextVersion,
          contentVersion: hash,
        }
        : null;
      await tx.textbook_units.update({
        where: { id: unit.id },
        data: {
          metadata: {
            ...metadataForUnit(unit),
            content: storedContent,
            qcReport: report,
            needsReview: validation.warnings.length > 0,
            activation,
            lastEditedAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      return {
        updated: true,
        textbookUnitId: unit.id,
        unitId: fresh.id,
        topicId: fresh.topicId,
        version: nextVersion,
        contentVersion: hash,
        availability: fresh.availability,
        validation,
        qcReport: report,
        draftId: draft.id,
      };
    });

    this.logger.log(
      `教材单元 ${unit.unitCode} 编辑生效：unit=${result.unitId} version=${result.version} warnings=${validation.warnings.length}`,
    );
    return result;
  }

  /**
   * 教材单元回滚：复制历史快照为新版本，保留当前 availability，并重新同步学习项。
   * 目标版本必须仍能通过自动校验；不能把一份损坏的历史内容重新下发。
   */
  async rollbackTextbookUnit(
    unitId: string,
    version: number,
    reason: string | undefined,
    reviewer: string,
  ): Promise<TextbookUnitMutation> {
    const unit = await this.prisma.curriculum_units.findUnique({ where: { id: unitId } });
    if (!unit) throw new NotFoundException('课程单元不存在');
    if (!unit.textbookUnitId) throw new NotFoundException('该课程单元不是教材单元');
    if (unit.reviewStatus !== 'published') throw new NotFoundException('课程单元未上线，不能回滚');

    const target = await this.prisma.curriculum_unit_versions.findUnique({
      where: { unitId_version: { unitId, version } },
    });
    if (!target) throw new NotFoundException('指定版本不存在');

    const textbookUnit = await this.loadTextbookUnit(unit.textbookUnitId);
    const targetContent = target.content as unknown as TextbookUnitContent;
    const { validation, skillIdByCode } = await this.validateUnitContent(textbookUnit, targetContent);
    const report = validationReport(validation);
    if (!validation.ok) {
      return {
        updated: false,
        rolledBack: false,
        textbookUnitId: textbookUnit.id,
        unitId,
        sourceVersion: version,
        validation,
        qcReport: report,
      };
    }

    const storedContent = withQcReport(targetContent, report);
    const hash = textbookContentHash(storedContent);
    const publishable = publishableForContent(storedContent, textbookUnit.textbook?.grade);
    const level = publishable.level;
    const stage = stageForContent(storedContent, level);
    const existingDraft = await this.prisma.curriculum_drafts.findFirst({
      where: { textbookUnitId: textbookUnit.id },
      orderBy: { updatedAt: 'desc' },
    });
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.curriculum_units.findUnique({ where: { id: unitId } });
      if (!fresh) throw new NotFoundException('课程单元不存在');
      if (fresh.currentVersion !== unit.currentVersion) {
        throw new ConflictException('课程已被其他操作修改，请刷新后重试');
      }
      const nextVersion = unit.currentVersion + 1;

      await tx.curriculum_unit_versions.create({
        data: {
          unitId,
          version: nextVersion,
          content: storedContent as unknown as Prisma.InputJsonValue,
          contentHash: hash,
          createdBy: reviewer,
          note: `回滚到版本 ${version}${reason ? `：${reason}` : ''}`,
        },
      });

      const claimed = await tx.curriculum_units.updateMany({
        where: {
          id: unitId,
          currentVersion: unit.currentVersion,
          reviewStatus: 'published',
        },
        data: {
          title: publishable.title,
          level,
          stage,
          description: storedContent.objectives.join('；') || null,
          content: storedContent as unknown as Prisma.InputJsonValue,
          contentVersion: hash,
          currentVersion: nextVersion,
          stageHint: storedContent.stageHint ?? null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('课程已被其他操作修改，请刷新后重试');

      const itemStatus = fresh.availability === 'active' ? 'published' : 'disabled';
      const imageByWord = await registerContentImages(tx, publishable);
      await syncLearningItems(tx, fresh.id, fresh.topicId, publishable, skillIdByCode, imageByWord, true, itemStatus);
      await upsertVocabularyItems(tx, fresh.topicId, publishable, skillIdByCode, itemStatus, true);

      const draft = existingDraft
        ? await tx.curriculum_drafts.update({
          where: { id: existingDraft.id },
          data: {
            title: publishable.title,
            level,
            topicId: fresh.topicId,
            textbookId: textbookUnit.textbookId,
            textbookUnitId: textbookUnit.id,
            wordList: storedContent.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
            generatedContent: storedContent as unknown as Prisma.InputJsonValue,
            status: 'published',
            reviewedBy: reviewer,
            reviewNote: `回滚到版本 ${version}${reason ? `：${reason}` : ''}`,
            version: { increment: 1 },
          },
        })
        : await tx.curriculum_drafts.create({
          data: {
            title: publishable.title,
            level,
            topicId: fresh.topicId,
            textbookId: textbookUnit.textbookId,
            textbookUnitId: textbookUnit.id,
            wordList: storedContent.vocabulary.map((item) => item.word) as Prisma.InputJsonValue,
            generatedContent: storedContent as unknown as Prisma.InputJsonValue,
            status: 'published',
            createdBy: reviewer,
            reviewedBy: reviewer,
            reviewNote: `回滚到版本 ${version}${reason ? `：${reason}` : ''}`,
            publishedAt: now,
            version: 1,
          },
        });

      await tx.curriculum_review_records.create({
        data: {
          draftId: draft.id,
          action: 'rolled_back',
          reviewer,
          note: `回滚到版本 ${version}${reason ? `：${reason}` : ''}`,
          snapshot: {
            ...storedContent,
            unitId,
            version: nextVersion,
            contentVersion: hash,
            sourceVersion: version,
          } as Prisma.InputJsonValue,
        },
      });

      const previousActivation = asRecord(metadataForUnit(textbookUnit).activation);
      const activation = Object.keys(previousActivation).length
        ? {
          ...previousActivation,
          unitId,
          topicId: fresh.topicId,
          version: nextVersion,
          contentVersion: hash,
        }
        : null;
      await tx.textbook_units.update({
        where: { id: textbookUnit.id },
        data: {
          metadata: {
            ...metadataForUnit(textbookUnit),
            content: storedContent,
            qcReport: report,
            needsReview: validation.warnings.length > 0,
            activation,
            lastRolledBackAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      return {
        updated: true,
        rolledBack: true,
        textbookUnitId: textbookUnit.id,
        unitId,
        topicId: fresh.topicId,
        version: nextVersion,
        sourceVersion: version,
        contentVersion: hash,
        availability: fresh.availability,
        validation,
        qcReport: report,
        draftId: draft.id,
      };
    });

    this.logger.log(
      `教材单元 ${textbookUnit.unitCode} 回滚生效：unit=${unitId} source=${version} version=${result.version}`,
    );
    return result;
  }

  private async loadTextbookUnit(textbookUnitId: string): Promise<UnitRecord> {
    const unit = await this.prisma.textbook_units.findUnique({
      where: { id: textbookUnitId },
      include: { textbook: true },
    }) as unknown as UnitRecord | null;
    if (!unit) throw new NotFoundException('教材单元不存在');
    return unit;
  }

  private async validateUnitContent(
    unit: UnitRecord,
    content: TextbookUnitContent,
  ): Promise<{ validation: TextbookUnitQcResult; skillIdByCode: Map<string, string> }> {
    const metadata = metadataForUnit(unit);
    const allActivities = [...content.activities, ...(content.schoolTrack?.activities ?? [])];
    const skillIds = [...new Set(allActivities.flatMap((activity) => activity.skillNodeIds))];
    const [skills, phonemes] = await Promise.all([
      this.prisma.skill_nodes.findMany({
        where: { OR: [{ id: { in: skillIds } }, { code: { in: skillIds } }] },
        select: { id: true, code: true },
      }),
      this.prisma.phoneme_items.findMany({ select: { phoneme: true } }),
    ]);
    const knownSkillCodes = new Set(skills.flatMap((skill) => [skill.id, skill.code]));
    const skillIdByCode = new Map(skills.flatMap((skill) => [[skill.id, skill.id], [skill.code, skill.id]]));
    const validation = validateTextbookUnitContent(content, {
      grammarFocus: toStringArray(metadata.grammarFocus),
      knownSkillCodes,
      phonemeSymbols: new Set(phonemes.map((item) => item.phoneme).filter(Boolean)),
      generationIssues: [],
      unitCode: unit.unitCode,
    });
    if (content.unit.code !== unit.unitCode) {
      addExternalIssue(
        validation,
        'unit_code_mismatch',
        'unit.code',
        `资源包单元编码 ${content.unit.code} 与录入单元 ${unit.unitCode} 不一致。`,
      );
    }
    return { validation, skillIdByCode };
  }

  private async persistReport(
    unit: UnitRecord,
    content: TextbookUnitContent,
    report: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.textbook_units.update({
      where: { id: unit.id },
      data: {
        metadata: {
          ...asRecord(unit.metadata),
          content,
          qcReport: report,
          needsReview: true,
          activation: null,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

function validationReport(validation: TextbookUnitQcResult): Record<string, unknown> {
  return {
    checkedAt: validation.checkedAt,
    needsReview: validation.warnings.length > 0,
    validation,
  };
}

function withQcReport(
  content: TextbookUnitContent,
  report: Record<string, unknown>,
): TextbookUnitContent {
  return { ...content, qcReport: report };
}

function metadataForUnit(unit: UnitRecord): Record<string, unknown> {
  return asRecord(unit.metadata);
}
function publishableForContent(content: TextbookUnitContent, grade?: string | null): PublishableLesson {
  const authoredActivities: PublishableActivity[] = [
    ...(content.activities as PublishableActivity[]),
    ...((content.schoolTrack?.activities ?? []) as PublishableActivity[]),
  ];
  const allActivities: PublishableActivity[] = [
    ...derivedTextbookActivities(content, authoredActivities),
    ...authoredActivities,
  ];
  return {
    title: content.unit.title,
    level: levelForContent(content, grade),
    objectives: content.objectives,
    vocabulary: content.vocabulary.map((item) => ({
      word: item.word,
      phonetic: item.phonetic,
      meaningZh: item.meaningZh,
      syllables: item.syllables,
      difficultPhonemes: item.difficultPhonemes,
      phrases: item.phrases,
      exampleSentences: item.exampleSentences,
      ...(item.imageAsset ? { image: item.imageAsset } : {}),
    })),
    activities: allActivities as PublishableActivity[],
    images: [],
  };
}

function buildQcReport(
  previous: Record<string, unknown>,
  validation: TextbookUnitQcResult,
  activation: TextbookUnitActivation | null,
): Record<string, unknown> {
  return {
    ...previous,
    checkedAt: validation.checkedAt,
    needsReview: !activation
      ? true
      : validation.warnings.length > 0,
    validation,
    activation,
  };
}

function addExternalIssue(
  validation: TextbookUnitQcResult,
  code: string,
  path: string,
  message: string,
): void {
  const issue: TextbookUnitQcIssue = { code, path, message, severity: 'error', source: 'content' };
  validation.errors.push(issue);
  validation.issues.push(issue);
  validation.ok = false;
}

function textbookContentHash(content: TextbookUnitContent): string {
  const { qcReport: _qcReport, ...stable } = content;
  return contentHash(stable);
}

/** 年级决定教材单元的最低 CEFR；AI stageHint 只能在此基础上上调。 */
export function minimumLevelForGrade(grade?: string | null): string | null {
  const text = grade ?? '';
  if (/一|二|1|2/.test(text)) return 'pre-A1';
  if (/三|四|3|4/.test(text)) return 'A1';
  if (/五|六|5|6/.test(text)) return 'A2';
  return null;
}

/** 发布阶段必须和校准后的 level 一致，不能继续沿用偏低的 AI stageHint。 */
function stageForContent(_content: TextbookUnitContent, level: string): number {
  const index = STAGE_LEVELS.indexOf(level as typeof STAGE_LEVELS[number]);
  return index >= 0 ? index : 1;
}

export function levelForContent(content: TextbookUnitContent, grade?: string | null): string {
  const floor = minimumLevelForGrade(grade);
  const floorIndex = floor ? STAGE_LEVELS.indexOf(floor as typeof STAGE_LEVELS[number]) : -1;
  const aiIndex = typeof content.stageHint === 'number' && content.stageHint >= 0 && content.stageHint <= 6
    ? content.stageHint
    : -1;
  const resolved = Math.max(aiIndex, floorIndex);
  if (resolved >= 0) return STAGE_LEVELS[resolved] ?? floor ?? 'A1';
  return floor ?? 'A1';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []);
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item)
    ? [item as Record<string, unknown>]
    : []);
}
